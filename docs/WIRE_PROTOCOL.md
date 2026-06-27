# Wire Protocol

The bridge server speaks **line-delimited JSON over an SSH exec channel**. One JSON object per line, in both directions.

This is intentionally identical to the local `SidecarBridge.dart` stdin/stdout protocol — only the transport changes (local pipe → SSH exec channel). This means the iOS client's `RemoteSidecarBridge` is a near-drop-in replacement for `SidecarBridge`.

---

## 1. Transport

| Layer | Detail |
|---|---|
| TCP | Server listens on **port 3022** |
| SSH | ssh2 server, public-key auth only (password rejected) |
| Channel | One exec channel per client, command = `anymex-bridge` (ignored, any command works) |
| Framing | Newline-delimited (`\n`), UTF-8 JSON |
| Direction | Full-duplex — client may send multiple requests, server responds out-of-order by `id` |

### SSH auth

- **Username**: ignored by the server (use anything, e.g. `anymex`)
- **Private key**: any ed25519/RSA keypair (BYO-key model)
- **Identity**: the server computes `sha256:<fingerprint>` of the public key → that's your `userId`. First connection auto-creates the user row.
- **Host key**: server generates an ed25519 host key on first run (`data/host-keys/ed25519`). iOS should pin this after first connect (or use `hostVerifier: () => true` for development).

---

## 2. Envelopes

### iOS → server

```jsonc
{
  "id": "req-123",                  // correlation id (any string), matches response.id
  "action": "hello",                // see action table below
  "payload": { /* action-specific */ }
}
```

### server → iOS

```jsonc
{
  "id": "req-123",                  // matches the request id
  "status": "ok",                   // ok | error | partial | completed | log
  "data": { /* action-specific */ },
  "error": "human-readable message" // only when status=error
}
```

### Status values

| Status | Meaning |
|---|---|
| `ok` | Request succeeded, this is the final response |
| `error` | Request failed, `error` field has the message |
| `partial` | Streaming response — more data coming (for `invokeStream`) |
| `completed` | Streaming response finished |
| `log` | Log line from the JAR (informational, can be ignored) |

**Important:** The JAR's final response often has **no `status` field** (just `{id, data}`). The server treats any response with a matching `id` whose status is not `partial`/`log` as final — mirroring the Dart `SidecarBridge._handleResponse` logic.

---

## 3. Authenticated user identity

The server stamps `userId` onto every request based on the SSH public key fingerprint. **iOS does not send `userId`** — it's implicit.

```typescript
// In ssh-server.ts (simplified)
const fingerprint = crypto.createHash('sha256').update(ctx.key.data).digest('base64');
const user = getOrCreateUser(`sha256:${fingerprint}`);
req.userId = user.id;
```

---

## 4. Actions

### `hello`

Handshake / ping. No payload.

**Request:**
```json
{ "id": "r0", "action": "hello" }
```

**Response:**
```json
{ "id": "r0", "status": "ok", "data": { "server": "anymex-bridge", "version": "0.1.0" } }
```

---

### `addRepo`

Subscribe the current user to a repo URL. Idempotent.

**Request:**
```json
{
  "id": "r1",
  "action": "addRepo",
  "payload": { "repoUrl": "https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json" }
}
```

**Response:**
```json
{
  "id": "r1",
  "status": "ok",
  "data": {
    "repoUrl": "https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json",
    "extensionCount": 259,
    "runtime": "aniyomi"
  }
}
```

For Kotatsu `.jar` repos, the response includes `runtime: "kotatsu"` and the extension count is the number of sources discovered inside the jar.

---

### `removeRepo`

Unsubscribe from a repo. Does NOT uninstall extensions that came from this repo.

**Request:**
```json
{ "id": "r2", "action": "removeRepo", "payload": { "repoUrl": "https://..." } }
```

**Response:**
```json
{ "id": "r2", "status": "ok", "data": { "repoUrl": "https://..." } }
```

---

### `listRepos`

List the user's subscribed repos.

**Request:**
```json
{ "id": "r3", "action": "listRepos" }
```

**Response:**
```json
{
  "id": "r3",
  "status": "ok",
  "data": {
    "repos": [
      { "repoUrl": "https://...", "addedAt": 1782537487824 },
      { "repoUrl": "https://...", "addedAt": 1782537489000 }
    ]
  }
}
```

---

### `listAvailable`

List all extensions available across the user's subscribed repos. Optionally filter by type.

**Request:**
```json
{
  "id": "r4",
  "action": "listAvailable",
  "payload": { "type": "anime" }     // optional: "anime" | "manga" | "novel"
}
```

**Response:**
```json
{
  "id": "r4",
  "status": "ok",
  "data": {
    "type": "anime",                  // echoed back (null if no filter)
    "extensions": [
      {
        "id": "8542735178285060053",
        "name": "AnimeOnsen",
        "fullName": "Aniyomi: AnimeOnsen",
        "pkg": "eu.kanade.tachiyomi.animeextension.all.animeonsen",
        "file": "aniyomi-all.animeonsen-v14.10.apk",
        "version": "14.10",
        "type": "anime",
        "itemType": 1,                // 0=manga, 1=anime, 2=novel (runtime enum)
        "managerId": "aniyomi",       // for getSourceManager() dispatch
        "runtime": "aniyomi",
        "lang": "all",
        "isNsfw": false,
        "baseUrl": "https://www.animeonsen.xyz",
        "fileUrl": "https://.../aniyomi-all.animeonsen-v14.10.apk",
        "iconUrl": "https://.../icon/eu.kanade.tachiyomi.animeextension.all.animeonsen.png",
        "repoUrl": "https://...",
        "installed": false
      }
    ]
  }
}
```

**Field reference:**

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable source ID (from repo's `sources[0].id`) |
| `name` | string | Display name (prefix-stripped) |
| `fullName` | string | Full name as published (e.g. `"Aniyomi: AnimeOnsen"`) |
| `pkg` | string | Android package name (Aniyomi only) |
| `internalName` | string | CloudStream internal name (CloudStream only) |
| `file` | string | Filename on the repo |
| `version` | string | Version string |
| `type` | string | `"anime"` / `"manga"` / `"novel"` |
| `itemType` | int | 0=manga, 1=anime, 2=novel — wire-compat with runtime's `Source.fromJson` |
| `managerId` | string | `"aniyomi"` / `"cloudstream"` / `"kotatsu"` — for `getSourceManager()` |
| `runtime` | string | Same as managerId (kept for backwards compat) |
| `lang` | string | Language code |
| `isNsfw` | bool | NSFW flag |
| `baseUrl` | string | Source website URL |
| `fileUrl` | string | Direct .apk/.cs3 download URL |
| `jarUrl` | string | Pre-converted .jar URL (CloudStream only) |
| `iconUrl` | string | Icon URL |
| `tvTypes` | string[] | CloudStream TV types (e.g. `["Movie","Anime"]`) |
| `authors` | string[] | CloudStream authors |
| `repoUrl` | string | Repo this ext came from |
| `installed` | bool | Whether this user has installed it |

---

### `listInstalled`

List extensions the user has installed. Same optional `type` filter.

**Request:**
```json
{
  "id": "r5",
  "action": "listInstalled",
  "payload": { "type": "manga" }     // optional
}
```

**Response:**
```json
{
  "id": "r5",
  "status": "ok",
  "data": {
    "type": "manga",
    "extensions": [
      {
        "userId": "u_3065357769ee4a53",
        "extId": "kotatsu_misskon",
        "repoUrl": "https://.../vn.jar",
        "installedAt": 1782537487824,
        "meta": { "id": "kotatsu_misskon", "name": "MissKon", "type": "manga", "itemType": 0, "managerId": "kotatsu", "runtime": "kotatsu", "baseUrl": "misskon.com" },
        "runtime": "kotatsu",
        "managerId": "kotatsu",
        "itemType": 0,
        "apkCached": false,
        "jarCached": true
      }
    ]
  }
}
```

---

### `install`

Install an extension for the current user. Branches by runtime.

**Request:**
```json
{
  "id": "r6",
  "action": "install",
  "payload": { "extId": "8542735178285060053", "repoUrl": "https://..." }
}
```

**Response (Aniyomi):**
```json
{
  "id": "r6",
  "status": "ok",
  "data": {
    "extId": "8542735178285060053",
    "repoUrl": "https://...",
    "runtime": "aniyomi",
    "managerId": "aniyomi",
    "type": "anime",
    "itemType": 1,
    "pkg": "eu.kanade.tachiyomi.animeextension.all.animeonsen",
    "version": "14.10",
    "sourceId": "8542735178285060053",
    "apkPath": "data/exts/<hash>.apk",
    "jarPath": "<pkg>.jar",
    "loaded": true,
    "baseUrl": "https://www.animeonsen.xyz"
  }
}
```

**Response (CloudStream):**
```json
{
  "id": "r6",
  "status": "ok",
  "data": {
    "extId": "cs_anichi",
    "repoUrl": "https://...",
    "runtime": "cloudstream",
    "managerId": "cloudstream",
    "type": "anime",
    "itemType": 1,
    "internalName": "Anichi",
    "version": "20",
    "jarPath": "Anichi.jar",
    "loaded": true,
    "sourceId": "cs_anichi",
    "baseUrl": "https://..."
  }
}
```

**Response (Kotatsu):**
```json
{
  "id": "r6",
  "status": "ok",
  "data": {
    "extId": "kotatsu_misskon",
    "repoUrl": "https://.../vn.jar",
    "runtime": "kotatsu",
    "managerId": "kotatsu",
    "type": "manga",
    "itemType": 0,
    "sourceId": "kotatsu_misskon",
    "name": "MissKon",
    "baseUrl": "misskon.com",
    "lang": "all",
    "loaded": true
  }
}
```

---

### `uninstall`

Uninstall an extension. Does NOT delete the .apk (another user may reference it).

**Request:**
```json
{ "id": "r7", "action": "uninstall", "payload": { "extId": "8542735178285060053" } }
```

**Response:**
```json
{ "id": "r7", "status": "ok", "data": { "extId": "8542735178285060053" } }
```

---

### `loadExtensions` / `csLoadExtensions` / `kotatsuLoadExtensions`

Force the JAR to rescan the corresponding exts folder. Returns the loaded source list. Usually called automatically by `install`, but exposed for debugging.

**Request:**
```json
{ "id": "r8", "action": "loadExtensions" }
```

**Response:**
```json
{
  "id": "r8",
  "status": "ok",
  "data": { "count": 2, "sources": [ { "id": "...", "name": "...", "baseUrl": "..." } ] }
}
```

---

### `invoke`

Run a method on an installed extension. **Install-gated** — returns error if the user hasn't installed the ext.

**Request:**
```json
{
  "id": "r9",
  "action": "invoke",
  "payload": {
    "extId": "8542735178285060053",
    "method": "search",
    "args": { "query": "naruto", "page": 1 }
  }
}
```

The server translates the method name based on runtime:

| Client method | Aniyomi JAR method | CloudStream JAR method | Kotatsu JAR method |
|---|---|---|---|
| `getPopular` | `getPopular` | `csSearch({query:''})` | `kotatsuGetPopular` |
| `search` | `search` | `csSearch({query})` | `kotatsuSearch` |
| `getDetail` | `getDetail` | `csGetDetail({url})` | `kotatsuGetDetail` |
| `getVideoList` | `getVideoList` | `csGetVideoList({url})` | — |
| `getPageList` | — | — | `kotatsuGetPageList` |

**Response:**
```json
{
  "id": "r9",
  "status": "ok",
  "data": {
    "list": [
      { "title": "Naruto", "url": "/naruto-ep1", "thumbnailUrl": "https://..." },
      ...
    ],
    "hasNextPage": false
  }
}
```

The `data` shape is whatever the extension method returns — the server passes it through unchanged. See the Aniyomi/CloudStream/Kotatsu source method Dart files for the exact response models.

---

### `invokeStream`

Like `invoke`, but the response comes as multiple `partial` lines followed by a `completed` line. Used for methods that emit progress (e.g. `getVideoList` with multiple extractors).

**Request:**
```json
{
  "id": "r10",
  "action": "invokeStream",
  "payload": { "extId": "...", "method": "getVideoList", "args": { "episode": { "url": "..." } } }
}
```

**Response (multiple lines):**
```json
{ "id": "r10", "status": "partial", "data": { "video": { "url": "https://...", "quality": "1080p" } } }
{ "id": "r10", "status": "partial", "data": { "video": { "url": "https://...", "quality": "720p" } } }
{ "id": "r10", "status": "completed", "data": { "count": 2 } }
```

---

### `cancel`

Cancel an in-flight `invoke` / `invokeStream` request.

**Request:**
```json
{ "id": "r11", "action": "cancel", "payload": { "innerId": "r9" } }
```

**Response:**
```json
{ "id": "r11", "status": "ok", "data": { "cancelled": true } }
```

---

## 5. Error handling

Errors are returned as `status: "error"` with a human-readable message:

```json
{ "id": "r9", "status": "error", "error": "Extension 8542735178285060053 not installed" }
```

Common errors:
- `Extension <id> not installed` — install-gate rejected the invoke
- `Extension <id> not found in repo <url>` — extId not in the repo index
- `Kotatsu jar install failed: ...` — download or dex2jar failure
- `dex2jar conversion failed for <id>: ...` — .apk → .jar conversion error
- `Failed to fetch repo <url>: HTTP <code>` — repo index fetch failed
- `Unrecognised repo index format at <url>` — repo JSON shape unknown

Timeouts: if the JAR doesn't respond within 60s, the server returns an error. The iOS client should retry with backoff.
