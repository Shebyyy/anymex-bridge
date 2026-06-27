# AnymeX Bridge — Remote Extension Runtime Server

A **shared server** that runs the [AnymeXRuntimeBridge](https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge) JAR and executes Aniyomi / CloudStream / Kotatsu extensions on behalf of iOS clients that can't run a JVM locally.

iOS connects over SSH, sends line-delimited JSON requests, and gets JSON back. The server only **runs extensions and returns results** — it knows nothing about tracking, tokens, watch history, or anime data. Those stay on iOS.

---

## Why does this exist?

iOS prohibits JIT compilation, so a real JVM cannot run on iOS. The original `AnymeXExtensionRuntimeBridge` therefore has **no iOS support** for Aniyomi / CloudStream / Kotatsu extensions (which all need a JVM).

This server moves the JVM to a remote host. The wire protocol is intentionally identical to the local `SidecarBridge.dart` stdin/stdout protocol — only the transport changes (local pipe → SSH exec channel).

**One server, many iOS users.** Every user connects to the same shared server with their own SSH key. The server maintains per-user enabled-extension lists, but the actual extension binaries (.apk / .cs3 / .jar) are shared and deduplicated across all users.

---

## What it does

| Capability | Supported |
|---|---|
| **Aniyomi** extensions (anime + manga) | ✅ `.apk` → dex2jar → JAR |
| **CloudStream** extensions (anime) | ✅ `.cs3` + `.jar` repackage |
| **Kotatsu** extensions (manga) | ✅ multi-source `.jar` |
| Per-user repo subscriptions | ✅ |
| Per-user installed-extension lists | ✅ |
| Shared, content-addressed extension pool | ✅ (deduped by URL hash) |
| JAR auto-update from GitHub Releases | ✅ (hourly poll, hot-swap) |
| SSH public-key auth (BYO key) | ✅ |
| anime / manga / novel type filtering | ✅ (`itemType` int + `type` string) |

**Runtime categorization** (mirrors the Dart `ExtensionManager`):

| Runtime | `managerId` | Anime | Manga | Novel | How type is detected |
|---|---|---|---|---|---|
| Aniyomi | `aniyomi` | ✅ | ✅ | ✗ | Name prefix: `Aniyomi:` → anime, `Tachiyomi:` → manga |
| CloudStream | `cloudstream` | ✅ | ✗ | ✗ | Hardcoded anime (runtime declares `supportsManga=false`) |
| Kotatsu | `kotatsu` | ✗ | ✅ | ✗ | Hardcoded manga (runtime declares `supportsAnime=false`) |

---

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│           iOS App           │         │       Bridge Server          │
│                             │         │       (this project)         │
│  RemoteSidecarBridge.dart   │         │                              │
│  (drop-in for SidecarBridge)│  SSH    │  ┌────────────────────────┐  │
│                             │◄───────►│  │ ssh2 server (port 3022)│  │
│  - invokeMethod             │         │  └───────────┬────────────┘  │
│  - invokeStreamMethod       │         │              │               │
│  - addRepo / install / ...  │         │              ▼               │
│                             │         │  ┌────────────────────────┐  │
│  Tracking (AniList/MAL/...) │         │  │ Request Router         │  │
│  — UNCHANGED, stays on iOS  │         │  │ - install-gating       │  │
└─────────────────────────────┘         │  │ - per-user config DB   │  │
                                        │  │ - 3-runtime dispatch   │  │
                                        │  └───────────┬────────────┘  │
                                        │              │ stdin/stdout  │
                                        │              ▼               │
                                        │  ┌────────────────────────┐  │
                                        │  │ 1× JVM (auto-updated)  │  │
                                        │  │ java -jar bridge.jar   │  │
                                        │  └────────────────────────┘  │
                                        │                              │
                                        │  ┌────────────────────────┐  │
                                        │  │ Shared Extension Store │  │
                                        │  │ data/exts/*.apk        │  │
                                        │  │ data/exts-jar/*.jar    │  │
                                        │  │ data/exts-jar-cs/*.jar │  │
                                        │  │ data/exts-jar-kotatsu/ │  │
                                        │  │ data/repos/*.json      │  │
                                        │  └────────────────────────┘  │
                                        └──────────────────────────────┘
```

**The server knows nothing about tracking.** It only runs extensions.

---

## Quickstart

### Server (this repo)

```bash
# Prerequisites: Bun ≥ 1.0, Java 17+
bun install
bun run dev        # hot-reload
# or
bun run start      # production
```

The server will:
1. Generate an ed25519 host key on first run (`data/host-keys/ed25519`).
2. Listen on **port 3022**.
3. Download `anymex_desktop_runtime.jar` from the latest GitHub release.
4. Start the JAR lazily on first `invoke`.

### iOS client

Drop `flutter-patch/RemoteSidecarBridge.dart` into your AnymeX fork, add `dartssh2: ^2.9.6` to `pubspec.yaml`, then:

```dart
await RemoteSidecarBridge().configure(
  RemoteBridgeConfig(
    host: 'bridge.example.com',
    port: 3022,
    username: 'anymex',
    keyPair: myKeyPair,          // dartssh2 SSHKeyPair
  ),
);

// Use it exactly like the old local SidecarBridge:
await bridge.addRepo('https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json');
final available = await bridge.listAvailable(type: 'anime');
await bridge.install(extId, repoUrl);
final results = await bridge.invokeMethod('search', { 'extId': extId, 'query': 'naruto' });
```

See **[docs/IOS_CLIENT_USAGE.md](docs/IOS_CLIENT_USAGE.md)** for the full guide.

---

## Project structure

```
anymex-bridge/
├── README.md
├── index.ts                     # entry point
├── package.json
├── tsconfig.json
├── src/
│   ├── ssh-server.ts            # SSH2 server, BYO-key auth
│   ├── request-router.ts        # action dispatcher, install-gating
│   ├── db.ts                    # SQLite (users, user_repos, user_exts)
│   ├── extension-store.ts       # shared .apk/.cs3 pool (content-addressed)
│   ├── repo-indexer.ts          # fetches + caches repo indexes (3 formats)
│   ├── jar-runner.ts            # single JVM subprocess, hot-swap
│   ├── auto-updater.ts          # hourly GitHub Releases poll
│   ├── dex2jar.ts               # .apk → .jar converter (Aniyomi)
│   ├── cs-installer.ts          # .cs3 + .jar repackage (CloudStream)
│   ├── kotatsu-installer.ts     # multi-source .jar (Kotatsu)
│   ├── ext-loader.ts            # JAR loadExtensions caches (3 runtimes)
│   ├── item-type.ts             # ItemType int ↔ string converter
│   └── types.ts                 # shared TypeScript types
├── docs/
│   ├── ARCHITECTURE.md          # shared-server model, data flow
│   ├── WIRE_PROTOCOL.md         # every action, payload, response
│   ├── SERVER_SETUP.md          # deploy, ports, JAR auto-update, systemd
│   ├── IOS_CLIENT_USAGE.md      # how iOS users connect + use
│   ├── REPO_FORMATS.md          # Aniyomi/CloudStream/Kotatsu repo shapes
│   └── FLUTTER_PATCH.md         # RemoteSidecarBridge.dart install guide
├── flutter-patch/
│   └── RemoteSidecarBridge.dart # drop-in iOS client
├── tests/                       # end-to-end SSH tests
│   ├── test-categorization.ts   # wire-shape + type filter verification
│   ├── test-yuzono.ts           # Aniyomi (anime)
│   ├── test-cloudstream.ts      # CloudStream (anime)
│   ├── test-kotatsu.ts          # Kotatsu (manga)
│   └── ...                      # probes + smoke tests
└── data/                        # created at runtime (gitignored)
    ├── bridge.jar               # auto-downloaded
    ├── users.sqlite             # per-user config
    ├── host-keys/ed25519        # SSH host key
    ├── exts/                    # shared .apk / .cs3
    ├── exts-jar/                # converted Aniyomi .jar
    ├── exts-jar-cs/             # CloudStream .jar
    ├── exts-jar-kotatsu/        # Kotatsu plugin.jar
    ├── repos/                   # cached repo index.json
    └── tools/                   # dex-tools (downloaded once)
```

---

## Documentation

| Doc | What it covers |
|---|---|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Shared-server model, 3-runtime dispatch, JAR lifecycle, data flow diagrams |
| **[docs/WIRE_PROTOCOL.md](docs/WIRE_PROTOCOL.md)** | SSH transport, JSON envelopes, every action's payload + response shape |
| **[docs/SERVER_SETUP.md](docs/SERVER_SETUP.md)** | Prerequisites, deploy, port config, JAR auto-update, systemd service, logs |
| **[docs/IOS_CLIENT_USAGE.md](docs/IOS_CLIENT_USAGE.md)** | How an iOS user connects, the 4-step flow, per-type fetching, Dart examples |
| **[docs/REPO_FORMATS.md](docs/REPO_FORMATS.md)** | Aniyomi / CloudStream / Kotatsu repo shapes + auto-detection logic |
| **[docs/FLUTTER_PATCH.md](docs/FLUTTER_PATCH.md)** | RemoteSidecarBridge.dart drop-in instructions, API surface, migration |

---

## Sizing

Single shared JVM, shared extension binaries, per-user config rows.

| Users | CPU | RAM | Disk | Monthly cost |
|---|---|---|---|---|
| ≤ 50 | 2 vCPU | 4 GB | 20 GB | $10-15 |
| 50-500 | 4 vCPU | 8 GB | 40 GB | $25-40 |
| 500-5000 | 8 vCPU | 16 GB | 80 GB | $60-90 |

**Sweet spot:** Hetzner CPX31 (~$18/mo) handles ~200 concurrent users.

---

## Security

- **SSH public-key auth only** (password auth rejected).
- Any key is accepted (BYO-key model). Identity = fingerprint.
- The server **never** sees AniList/MAL tokens — those stay on iOS.
- For production: add a registered-key allow-list in `request-router.ts` → `authenticateUser`.
- Consider `ForceCommand` + key restrictions in `~/.ssh/authorized_keys` if you want OS-level sshd to handle auth instead.

---

## Status

- ✅ SSH server boots, accepts public-key auth
- ✅ Auto-updater fetches JAR from GitHub Releases (hourly, hot-swap)
- ✅ JAR subprocess management with hot-swap
- ✅ Per-user SQLite config (users, user_repos, user_exts)
- ✅ Repo indexer — Aniyomi / CloudStream / Kotatsu formats auto-detected
- ✅ Shared extension store with content-addressed dedup
- ✅ **3 runtimes**: Aniyomi (anime+manga), CloudStream (anime), Kotatsu (manga)
- ✅ `itemType` int + `managerId` on every extension (wire-compat with runtime's `Source.fromJson`)
- ✅ `type` filter on `listAvailable` / `listInstalled` (anime/manga/novel)
- ✅ RemoteSidecarBridge.dart drop-in Flutter patch
- ⚠️ Production hardening needed (rate limiting, key allow-list, GC for unreferenced .apk files, metrics)

---

## License

Same license as the upstream [AnymeXExtensionRuntimeBridge](https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge) project.
