# iOS Client Usage Guide

How an iOS user connects to the AnymeX Bridge server and uses extensions.

This guide assumes you've already deployed the bridge server (see [SERVER_SETUP.md](./SERVER_SETUP.md)) and have the `RemoteSidecarBridge.dart` file (see [FLUTTER_PATCH.md](./FLUTTER_PATCH.md)).

---

## 1. The mental model

```
┌─────────────────────────────────────────────────────┐
│ iOS App (your AnymeX fork)                          │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ RemoteSidecarBridge                          │  │
│  │ (replaces local SidecarBridge)               │  │
│  │                                              │  │
│  │ - SSH connection to bridge server            │  │
│  │ - wraps JAR invoke requests in SSH envelope  │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │                             │
│  ┌────────────────────▼──────────────────────────┐  │
│  │ Your app's existing UI + tracking logic       │  │
│  │ - AniList/MAL tracking (UNCHANGED)            │  │
│  │ - Watch history (UNCHANGED, stays on device)  │  │
│  │ - Library (UNCHANGED)                         │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                      │
                      │ SSH (port 3022)
                      ▼
            ┌─────────────────────┐
            │ Bridge Server       │
            │ (runs the JVM +     │
            │  extension methods) │
            └─────────────────────┘
```

**Key principle:** The server only runs extensions. Your tracking tokens, watch history, library — all stay on iOS, exactly as before. You're just swapping the local JVM for a remote one.

---

## 2. Setup (one-time)

### Step 1: Add the dependency

In your `pubspec.yaml`:

```yaml
dependencies:
  dartssh2: ^2.9.6
```

Then `flutter pub get`.

### Step 2: Drop in the patch

Copy `flutter-patch/RemoteSidecarBridge.dart` into your project, next to your existing `SidecarBridge.dart`:

```
lib/Runtime/Bridge/
├── SidecarBridge.dart            # the old local bridge (keep as fallback)
├── RemoteSidecarBridge.dart      # the new remote bridge (from this repo)
├── BridgeDispatcher.dart
└── JniBridge.dart
```

### Step 3: Generate an SSH keypair for the user

Each iOS user needs their own SSH keypair. Store the private key in the iOS Keychain.

```dart
import 'package:dartssh2/dartssh2.dart';

// Generate a new ed25519 keypair (do this once per user, on first launch)
final keyPair = SSHKeyPair.ed25519();

// Store in Keychain:
final privateKeyPem = keyPair.toOpenSSHString();
await KeychainStorage.save('anymex_ssh_private_key', privateKeyPem);

// The public key is the user's identity on the server:
final publicKeyString = keyPair.publicKey.toOpenSSHString();
// (You don't need to register it anywhere — the server auto-creates
//  a user row on first connect based on the fingerprint.)
```

### Step 4: Configure the bridge at app startup

```dart
import 'package:dartssh2/dartssh2.dart';
import 'package:your_app/Runtime/Bridge/RemoteSidecarBridge.dart';

Future<void> initBridge() async {
  final privateKeyPem = await KeychainStorage.read('anymex_ssh_private_key');
  final keyPair = SSHKeyPair.fromPem(privateKeyPem);

  await RemoteSidecarBridge().configure(
    RemoteBridgeConfig(
      host: 'bridge.example.com',    // your bridge server hostname
      port: 3022,
      username: 'anymex',            // ignored by server, required by SSH
      keyPair: keyPair,
      // hostVerifier: (key) => true, // uncomment to skip host-key pinning (dev only)
    ),
  );
  
  // Now use RemoteSidecarBridge() exactly like the old SidecarBridge()
}
```

### Step 5: Replace SidecarBridge with RemoteSidecarBridge

In your `BridgeDispatcher` or wherever you instantiate the bridge:

```dart
// Before (local JVM):
// final bridge = SidecarBridge();

// After (remote JVM):
final bridge = RemoteSidecarBridge();
```

The API surface is identical — `invokeMethod`, `invokeStreamMethod`, `cancelRequest` all work the same.

---

## 3. The 4-step usage flow

### Step 1: Add a repo

Subscribe to an extension repo. This tells the server "fetch and cache this repo's index for me."

```dart
// Aniyomi anime repo (yuzono)
await bridge.addRepo(
  'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json',
);

// CloudStream repo (phisher98)
await bridge.addRepo(
  'https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/repo/repo.json',
);

// Kotatsu manga repo (dragonx943 — direct .jar URL)
await bridge.addRepo(
  'https://github.com/dragonx943/manga-repo/releases/download/c54deeb/vn.jar',
);
```

The server auto-detects the repo format (see [REPO_FORMATS.md](./REPO_FORMATS.md)). You can add all three types — they coexist.

### Step 2: List available extensions

Fetch the list of extensions the user can install. Filter by type if you only want anime or manga.

```dart
// Get all extensions (anime + manga + novel)
final all = await bridge.listAvailable();

// Get only anime extensions (Aniyomi + CloudStream)
final anime = await bridge.listAvailable(type: 'anime');

// Get only manga extensions (Aniyomi Tachiyomi + Kotatsu)
final manga = await bridge.listAvailable(type: 'manga');

// Each ext has:
//   ext.id           → stable source ID (use for install/invoke)
//   ext.name         → display name
//   ext.type         → 'anime' | 'manga' | 'novel'
//   ext.itemType     → 0=manga, 1=anime, 2=novel (runtime enum int)
//   ext.managerId    → 'aniyomi' | 'cloudstream' | 'kotatsu'
//   ext.runtime      → same as managerId
//   ext.isNsfw       → bool
//   ext.baseUrl      → the source website
//   ext.iconUrl      → icon
//   ext.installed    → whether this user has installed it
```

**Why filter by type?** The runtime's `ExtensionManager` keeps three separate aggregated lists: `availableAnimeExtensions`, `availableMangaExtensions`, `availableNovelExtensions`. Calling `listAvailable(type: 'anime')` populates the anime list directly — no client-side filtering needed.

### Step 3: Install an extension

```dart
// Install by extId + repoUrl (both from listAvailable)
await bridge.install(
  extId: '8542735178285060053',     // AnimeOnsen's sourceId
  repoUrl: 'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json',
);

// The response tells you if it loaded successfully:
//   { loaded: true, sourceId: '...', baseUrl: '...', itemType: 1, managerId: 'aniyomi' }
```

What happens server-side:
1. Downloads the .apk (or .cs3, or .jar for Kotatsu) — **deduplicated** across users
2. Converts to .jar if needed (dex2jar for Aniyomi/Kotatsu, repackage for CloudStream)
3. Tells the JAR to `loadExtensions` — registers the source
4. Records `(userId, extId, repoUrl)` in the user's installed list

### Step 4: Invoke extension methods

Now you can call extension methods. This is identical to the local SidecarBridge API.

```dart
// Get popular anime
final popular = await bridge.invokeMethod('getPopular', {
  'extId': '8542735178285060053',
  'args': { 'page': 1 },
});

// Search
final results = await bridge.invokeMethod('search', {
  'extId': '8542735178285060053',
  'args': { 'query': 'naruto', 'page': 1 },
});

// Get detail (episodes list)
final detail = await bridge.invokeMethod('getDetail', {
  'extId': '8542735178285060053',
  'args': { 'media': { 'title': 'Naruto', 'url': '/naruto-ep1' } },
});

// Get video streams (streaming response)
final videos = await bridge.invokeStreamMethod('getVideoList', {
  'extId': '8542735178285060053',
  'args': { 'episode': { 'url': 'https://...' } },
});

// Cancel an in-flight request
await bridge.cancelRequest(requestId);
```

**The server translates method names automatically** based on the extension's runtime:

| Your call | Aniyomi JAR method | CloudStream JAR method | Kotatsu JAR method |
|---|---|---|---|
| `getPopular` | `getPopular` | `csSearch({query:''})` | `kotatsuGetPopular` |
| `search` | `search` | `csSearch({query})` | `kotatsuSearch` |
| `getDetail` | `getDetail` | `csGetDetail({url})` | `kotatsuGetDetail` |
| `getVideoList` | `getVideoList` | `csGetVideoList({url})` | — |
| `getPageList` | — | — | `kotatsuGetPageList` |

You always call `search`, never `csSearch` or `kotatsuSearch` — the server handles the translation.

---

## 4. Per-type fetching (matching the runtime)

The AnymeX runtime's `ExtensionManager` calls `fetchAnimeExtensions()`, `fetchMangaExtensions()`, and `fetchNovelExtensions()` separately. Mirror this on iOS:

```dart
class YourExtensionManager {
  final bridge = RemoteSidecarBridge();
  
  Future<void> refreshAll() async {
    await Future.wait([
      refreshAnime(),
      refreshManga(),
      refreshNovel(),
    ]);
  }
  
  Future<void> refreshAnime() async {
    final resp = await bridge.listAvailable(type: 'anime');
    availableAnimeExtensions.value = resp['extensions'];
  }
  
  Future<void> refreshManga() async {
    final resp = await bridge.listAvailable(type: 'manga');
    availableMangaExtensions.value = resp['extensions'];
  }
  
  Future<void> refreshNovel() async {
    final resp = await bridge.listAvailable(type: 'novel');
    availableNovelExtensions.value = resp['extensions'];
  }
}
```

This is exactly how the runtime's `_updateAggregatedLists(type)` works — three separate Rx lists.

---

## 5. Full example: browsing anime

Here's a complete flow from app launch to watching a video:

```dart
// 1. Init bridge (once at startup)
await RemoteSidecarBridge().configure(RemoteBridgeConfig(
  host: 'bridge.example.com',
  port: 3022,
  username: 'anymex',
  keyPair: userKeyPair,
));

// 2. Add the yuzono anime repo (once, or skip if already added)
await RemoteSidecarBridge().addRepo(
  'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json',
);

// 3. List available anime
final avail = await RemoteSidecarBridge().listAvailable(type: 'anime');
final animeExts = avail['extensions'] as List;
print('Found ${animeExts.length} anime extensions');

// 4. Install Animetsu (example)
final animetsu = animeExts.firstWhere((e) => e['name'] == 'Animetsu');
await RemoteSidecarBridge().install(
  extId: animetsu['id'],
  repoUrl: animetsu['repoUrl'],
);

// 5. Search for "naruto"
final searchResp = await RemoteSidecarBridge().invokeMethod('search', {
  'extId': animetsu['id'],
  'args': { 'query': 'naruto', 'page': 1 },
});
final results = searchResp['data']['list'] as List;
print('Found ${results.length} results');
print('First: ${results[0]['title']}');

// 6. Get episodes for the first result
final detailResp = await RemoteSidecarBridge().invokeMethod('getDetail', {
  'extId': animetsu['id'],
  'args': { 'media': results[0] },
});
final episodes = detailResp['data']['episodes'] as List;
print('Found ${episodes.length} episodes');

// 7. Get video streams for the first episode
final videoResp = await RemoteSidecarBridge().invokeStreamMethod('getVideoList', {
  'extId': animetsu['id'],
  'args': { 'episode': episodes[0] },
});
// videoResp is a List of video objects: { url, quality, headers, ... }
final firstVideo = videoResp.first;
print('Video: ${firstVideo['url']} (${firstVideo['quality']})');

// 8. Hand off to your video player
await videoPlayer.play(firstVideo['url'], headers: firstVideo['headers']);
```

---

## 6. Managing installed extensions

```dart
// List what you've installed
final installed = await bridge.listInstalled();

// Filter by type
final installedAnime = await bridge.listInstalled(type: 'anime');
final installedManga = await bridge.listInstalled(type: 'manga');

// Uninstall
await bridge.uninstall(extId: '8542735178285060053');

// List your subscribed repos
final repos = await bridge.listRepos();

// Unsubscribe from a repo (does NOT uninstall extensions from it)
await bridge.removeRepo(repoUrl: 'https://...');
```

---

## 7. Error handling

```dart
try {
  final resp = await bridge.invokeMethod('search', { 'extId': extId, 'args': {...} });
  if (resp['status'] == 'error') {
    print('Extension error: ${resp['error']}');
  } else {
    // use resp['data']
  }
} on SshTimeoutException {
  print('Server didn\'t respond in time');
} on SshDisconnectedException {
  print('Lost connection — bridge.reconnect() will be called automatically');
}
```

Common errors:
- `"Extension <id> not installed"` — you forgot to call `install()` first
- `"Extension <id> not found in repo <url>"` — wrong extId or repoUrl
- `"Failed to fetch repo"` — repo URL is down or returns non-200

The `RemoteSidecarBridge` auto-reconnects on SSH disconnect. In-flight requests get an error and should be retried.

---

## 8. Multi-user considerations

Each iOS install has its own SSH keypair → its own `userId` on the server. Users don't share:
- Subscribed repos
- Installed extension lists
- Search/watch history (the server doesn't even see watch history)

Users DO share (transparently):
- The JVM process
- Downloaded .apk / .jar files (deduped by URL hash)
- Repo index caches

So if user A installs Animetsu, and user B also installs Animetsu, the .apk is only downloaded once. User B's `install()` returns almost instantly.

---

## 9. NSFW handling

Each extension has an `isNsfw` boolean. The server returns this in `listAvailable` — filter on the client side:

```dart
final avail = await bridge.listAvailable(type: 'anime');
final safe = avail['extensions'].where((e) => e['isNsfw'] != true).toList();
```

The server does NOT filter NSFW — that's a UI/policy decision for the iOS app.

---

## 10. Latency expectations

| Operation | Typical latency |
|---|---|
| `hello` / `listRepos` | <50ms (no JAR call) |
| `addRepo` (new repo) | 1-3s (fetch + parse index) |
| `listAvailable` (cached) | <100ms |
| `listAvailable` (first time for a repo) | 1-3s |
| `install` (Aniyomi, .apk not cached) | 3-8s (download + dex2jar) |
| `install` (Aniyomi, .apk cached) | 1-2s (dex2jar only) |
| `install` (CloudStream) | 2-5s |
| `install` (Kotatsu source) | <100ms (no download) |
| `invoke search` / `getPopular` | 1-5s (depends on the anime site) |
| `invoke getVideoList` | 3-15s (multiple extractors) |

The JVM stays warm between requests, so cold-start latency only hits the first invoke after a JAR restart.
