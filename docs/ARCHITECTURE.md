# Architecture

This document explains the internal architecture of the AnymeX Bridge server: the shared-server model, the 3-runtime dispatch, the JAR lifecycle, and the data flow.

---

## 1. The shared-server model

There is **one server, many iOS users**. Every user connects to the same host with their own SSH keypair. The server identifies each user by the SHA-256 fingerprint of their public key — there is no signup, no password, no token.

```
                    ┌──────────────────────────────────────┐
                    │       Bridge Server (port 3022)      │
                    │                                      │
   iOS user A ──────┤  SSH key fingerprint "u_a1b2..."     │
   (Aniyomi anime)  │  → per-user enabled-exts list A      │
                    │                                      │
   iOS user B ──────┤  SSH key fingerprint "u_c3d4..."     │
   (Kotatsu manga)  │  → per-user enabled-exts list B      │
                    │                                      │
   iOS user C ──────┤  SSH key fingerprint "u_e5f6..."     │
   (CloudStream)    │  → per-user enabled-exts list C      │
                    │                                      │
                    │  ┌────────────────────────────────┐  │
                    │  │ 1× shared JVM                  │  │
                    │  │ java -jar data/bridge.jar      │  │
                    │  │ (all users share this process) │  │
                    │  └────────────────────────────────┘  │
                    │                                      │
                    │  ┌────────────────────────────────┐  │
                    │  │ Shared extension pool          │  │
                    │  │ data/exts/*.apk                │  │
                    │  │ data/exts-jar/*.jar            │  │
                    │  │ data/exts-jar-cs/*.jar         │  │
                    │  │ data/exts-jar-kotatsu/*.jar    │  │
                    │  │ (content-addressed, deduped)   │  │
                    │  └────────────────────────────────┘  │
                    └──────────────────────────────────────┘
```

**What's per-user:**
- Subscribed repo URLs (`user_repos` table)
- Installed extension IDs (`user_exts` table)

**What's shared:**
- The JVM process (one `java -jar bridge.jar` for everyone)
- The downloaded extension binaries (deduped by URL hash — if user A and user B both install Animetsu, the .apk is downloaded once)
- The cached repo index.json files
- The dex-tools install

This keeps disk + memory usage flat as users grow — you only pay once per unique extension, not once per user.

---

## 2. The 3 runtimes

The bridge server supports three extension runtimes simultaneously. Each has its own JAR method family, its own folder, and its own installer. The runtime is **auto-detected from the repo format** — the iOS client doesn't need to specify it.

| Runtime | JAR methods | Folder | Installer | Type |
|---|---|---|---|---|
| **Aniyomi** | `loadExtensions`, `getPopular`, `search`, `getDetail`, `getVideoList`, ... | `data/exts-jar/` | `dex2jar.ts` (.apk → .jar) | anime + manga |
| **CloudStream** | `csLoadExtensions`, `csSearch`, `csGetDetail`, `csGetVideoList` | `data/exts-jar-cs/` | `cs-installer.ts` (.cs3 + .jar repackage) | anime |
| **Kotatsu** | `kotatsuLoadExtensions`, `kotatsuGetPopular`, `kotatsuSearch`, `kotatsuGetDetail`, `kotatsuGetPageList` | `data/exts-jar-kotatsu/plugin.jar` | `kotatsu-installer.ts` (multi-source .jar) | manga |

### Auto-detection logic (`repo-indexer.ts`)

```
fetch repo URL
   │
   ├── content-type is java-archive OR URL ends in .jar
   │   → Kotatsu runtime (synthesize sources after jar download + load)
   │
   ├── response is JSON object with `pluginLists: [...]`
   │   → CloudStream meta-repo (follow each pluginList URL, merge)
   │
   ├── response is JSON object with `plugins: [...]`
   │   → CloudStream wrapped format
   │
   ├── response is JSON object with `extensions: [...]`
   │   → Aniyomi / Mangayomi wrapped format
   │
   └── response is a bare JSON array
       ├── each item has `tvTypes` / `internalName` / `jarUrl` / `.cs3` URL
       │   → CloudStream bare array (phisher98-style)
       └── otherwise
           → Aniyomi bare array (yuzono-style)
```

See [REPO_FORMATS.md](./REPO_FORMATS.md) for concrete examples of each format.

### Per-runtime install flow

**Aniyomi** (`.apk` → `.jar`):
```
listAvailable → user picks ext → install(extId, repoUrl)
   1. download .apk from repo → data/exts/<hash>.apk
   2. dex2jar: extract classes.dex → run d2j-dex2jar.sh → data/exts-jar/<pkg>.jar
   3. JAR loadExtensions({folderPath: data/exts-jar}) → registers source
   4. record (userId, extId, repoUrl) in user_exts table
```

**CloudStream** (`.cs3` + `.jar` repackage):
```
listAvailable → user picks ext → install(extId, repoUrl)
   1. download .cs3 from repo (ZIP containing classes.dex + manifest.json)
   2. extract pluginClassName from manifest.json
   3. download pre-converted .jar from repo
   4. repackage .jar: strip its manifest, inject bridge-format manifest.json
      {pluginClassName, name, version, authors, requires:1}
   5. save to data/exts-jar-cs/<internalName>.jar
   6. JAR csLoadExtensions({folderPath: data/exts-jar-cs}) → registers source
   7. record (userId, extId, repoUrl) in user_exts table
```

**Kotatsu** (multi-source `.jar`):
```
addRepo(kotatsuJarUrl)
   1. download .jar (it's an APK with classes.dex)
   2. dex2jar → data/exts-jar-kotatsu/plugin.jar (MUST be named plugin.jar)
   3. delete JAR's kotatsu_extensions_cache.json (force rescan)
   4. JAR kotatsuLoadExtensions → returns ~57 sources
   5. synthesize RepoIndex from loaded sources

listAvailable → user picks source → install(sourceId, repoUrl)
   1. NO download (the jar is already loaded)
   2. just record (userId, sourceId, repoUrl) in user_exts table
   3. mark source as "active" for this user
```

---

## 3. JAR lifecycle

The bridge JAR (`anymex_desktop_runtime.jar`) is a single long-running subprocess. It's started lazily on the first `invoke` request and kept alive for all subsequent requests.

```
server boot
   │
   ├── start SSH server (immediate)
   ├── start auto-updater (polls GitHub Releases every 1h)
   │
   └── (JAR NOT started yet — lazy)
       │
       first invoke request arrives
          │
          ├── jarRunner.start() spawns: java -jar data/bridge.jar
          ├── waits for "AnymeX Sidecar Process Started" on stderr (10s timeout)
          ├── marks ready=true
          └── forwards the invoke request to the JAR via stdin
              │
              JAR stays alive, handles all future invokes
              │
              ─── hourly: auto-updater checks GitHub ───
                  │
                  new version found?
                  │   ├── download to data/bridge.jar.new
                  │   ├── hot-swap: rename bridge.jar.new → bridge.jar
                  │   ├── kill old JVM, spawn new one
                  │   └── JAR re-reads data/exts-jar*/ on next loadExtensions
                  │
                  no new version → no-op
```

### Hot-swap safety

The hot-swap renames `bridge.jar.new` → `bridge.jar` atomically, then restarts the JVM. In-flight requests get an error and the iOS client retries. The downloaded .jar files in `data/exts-jar*/` are NOT affected — they're re-loaded by the new JVM's first `loadExtensions` call.

---

## 4. Request flow

Here's the full path of a single `invoke` request from iOS to extension result:

```
iOS app
  │
  │  RemoteSidecarBridge.invokeMethod('search', {extId, query})
  │  wraps in: {id, action:'invoke', payload:{extId, method:'search', args:{...}}}
  │
  ▼  SSH exec channel (one JSON line)
Bridge Server
  │
  │  ssh-server.ts:
  │    - authenticate via SSH public key → userId = sha256(fp)
  │    - stamp userId onto request
  │    - forward to request-router
  │
  ▼
request-router.ts
  │
  │  case 'invoke':
  │    1. check isExtInstalled(userId, extId) → install-gate
  │    2. look up ext meta from repo cache → determine runtime
  │    3. ensure .jar is downloaded + converted + loaded
  │    4. translate method name:
  │       - Aniyomi: 'search' → JAR method 'search'
  │       - CloudStream: 'search' → JAR method 'csSearch'
  │       - Kotatsu: 'search' → JAR method 'kotatsuSearch'
  │    5. forward to JAR via stdin:
  │       {id, method:'csSearch', args:{sourceId, query, page}, innerId}
  │
  ▼  stdin (one JSON line)
JAR subprocess (java -jar bridge.jar)
  │
  │  - loads the extension .jar via DexClassLoader
  │  - calls the extension's search() method
  │  - extension fetches from the anime website
  │  - returns List<SearchResponse> as JSON
  │
  ▼  stdout (one JSON line)
request-router.ts
  │
  │  - reads JAR response {id, data}
  │  - wraps in {id, status:'ok', data}
  │
  ▼  SSH exec channel (one JSON line)
iOS app
  │
  │  RemoteSidecarBridge receives response, resolves Future
  │
  ▼
UI renders search results
```

---

## 5. Install-gating

Every `invoke` / `invokeStream` request is checked against the `user_exts` table before being forwarded to the JAR. If the user hasn't installed the requested extension, the server returns an error immediately — no JAR call is made.

```typescript
// request-router.ts (simplified)
if (!isExtInstalled(userId, extId)) {
  send({ id, status: 'error', error: `Extension ${extId} not installed` });
  return;
}
```

This prevents users from invoking extensions they haven't explicitly enabled, which is important for NSFW filtering and user expectation management.

---

## 6. Data flow diagram

```
                    ┌─────────────┐
                    │  iOS client │
                    └──────┬──────┘
                           │ SSH (port 3022)
                           ▼
                    ┌─────────────┐
                    │ ssh-server  │ ← auth by SSH key fingerprint
                    └──────┬──────┘
                           │ ClientRequest {id, action, payload}
                           ▼
                    ┌─────────────┐
                    │   router    │ ← install-gate, type filter, runtime dispatch
                    └──┬──┬──┬────┘
                       │  │  │
            ┌──────────┘  │  └──────────┐
            ▼             ▼             ▼
       ┌─────────┐   ┌─────────┐   ┌─────────┐
       │   db    │   │  store  │   │  JAR    │
       │ (SQLite)│   │ (.apk)  │   │ (stdin/ │
       │         │   │ (.jar)  │   │  stdout)│
       └─────────┘   └─────────┘   └─────────┘
                          │             │
                          ▼             ▼
                    ┌─────────────┐  ┌──────────────┐
                    │ repo-indexer│  │ ext-loader   │
                    │ (HTTP fetch │  │ (loadExt...) │
                    │  + cache)   │  │              │
                    └─────────────┘  └──────────────┘
```

- **db**: per-user config (subscribed repos, installed exts)
- **store**: shared binary pool (content-addressed by URL hash)
- **JAR**: the single JVM subprocess that actually runs extensions
- **repo-indexer**: fetches and caches repo `index.json` files (6h TTL)
- **ext-loader**: caches the JAR's `loadExtensions` / `csLoadExtensions` / `kotatsuLoadExtensions` results so we don't rescan on every invoke

---

## 7. Why a shared server (not per-user VMs)?

| Approach | Cost | Latency | Complexity |
|---|---|---|---|
| Per-user VM | $10-20 × N users | Low (dedicated) | High (provisioning, updates) |
| **Shared server (this)** | $18 flat, all users | Low (JVM warm) | Low (one process to manage) |
| Serverless (Lambda) | Per-invocation | High (cold start) | High (JVM cold start ~10s) |

The shared JVM is the key insight: extension methods are I/O-bound (HTTP to anime websites), not CPU-bound, so one JVM can comfortably serve ~200 concurrent users. The only state that needs to be per-user is "which extensions did this user install?" — and that's 2 SQLite tables.
