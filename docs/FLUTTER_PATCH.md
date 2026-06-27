# Flutter Patch — RemoteSidecarBridge.dart

This doc explains how to install and use the `RemoteSidecarBridge.dart` drop-in patch that replaces the local `SidecarBridge` with an SSH-transport variant.

---

## 1. What is it?

`RemoteSidecarBridge.dart` is a near-drop-in replacement for `SidecarBridge.dart` from the [AnymeXExtensionRuntimeBridge](https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge) project.

| | SidecarBridge (local) | RemoteSidecarBridge (this patch) |
|---|---|---|
| Transport | stdin/stdout pipe to local JVM | SSH exec channel to remote JVM |
| JVM runs on | The user's Mac/PC/Android | A shared server |
| iOS support | ✗ (no JVM on iOS) | ✅ |
| API surface | `invokeMethod`, `invokeStreamMethod`, `cancelRequest` | Same + new management methods |
| Tracking | Stays on device | Stays on device (unchanged) |

The wire protocol is intentionally identical — `RemoteSidecarBridge` wraps each local invoke request in an SSH envelope and sends it to the bridge server, which forwards it to the JAR.

---

## 2. Installation

### Step 1: Add dartssh2 dependency

In your AnymeX fork's `pubspec.yaml`:

```yaml
dependencies:
  dartssh2: ^2.9.6
```

Then:

```bash
flutter pub get
```

### Step 2: Copy the patch file

Copy `flutter-patch/RemoteSidecarBridge.dart` from this repo into your AnymeX fork:

```
cloned-repos/AnymeXExtensionRuntimeBridge/lib/Runtime/Bridge/
├── SidecarBridge.dart            # original (keep as fallback)
├── RemoteSidecarBridge.dart      # ← copy this in
├── BridgeDispatcher.dart
└── JniBridge.dart
```

### Step 3: Import it

In your `BridgeDispatcher.dart` (or wherever you instantiate the bridge):

```dart
// Before:
// import 'Bridge/SidecarBridge.dart';
// final bridge = SidecarBridge();

// After:
import 'Bridge/RemoteSidecarBridge.dart';
final bridge = RemoteSidecarBridge();
```

### Step 4: Configure at startup

```dart
import 'package:dartssh2/dartssh2.dart';

Future<void> initBridge() async {
  // Load or generate the user's SSH keypair (store in Keychain)
  final keyPair = await loadOrCreateKeyPair();
  
  await RemoteSidecarBridge().configure(
    RemoteBridgeConfig(
      host: 'bridge.example.com',
      port: 3022,
      username: 'anymex',
      keyPair: keyPair,
    ),
  );
}
```

That's it. Everything else (tracking, library, UI) stays unchanged.

---

## 3. API reference

### `RemoteBridgeConfig`

Configuration object passed to `configure()`.

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `String` | yes | Bridge server hostname |
| `port` | `int` | yes | Bridge server port (default 3022) |
| `username` | `String` | yes | Ignored by server (use anything) |
| `keyPair` | `SSHKeyPair` | yes | dartssh2 keypair (ed25519 recommended) |
| `hostVerifier` | `bool Function(SSHHostKey)` | no | Return `true` to accept any host key (dev only — pin in production!) |

### Core methods (same as SidecarBridge)

#### `invokeMethod(String method, Map args) → Future<Map>`

Run a single request/response method on an extension.

```dart
final resp = await bridge.invokeMethod('search', {
  'extId': '8542735178285060053',
  'args': { 'query': 'naruto', 'page': 1 },
});
// resp = { 'status': 'ok', 'data': { 'list': [...], 'hasNextPage': false } }
```

#### `invokeStreamMethod(String method, Map args) → Stream<Map>`

Run a streaming method. Yields `partial` events, then a `completed` event.

```dart
await for (final event in bridge.invokeStreamMethod('getVideoList', {
  'extId': '8542735178285060053',
  'args': { 'episode': { 'url': 'https://...' } },
})) {
  if (event['status'] == 'partial') {
    final video = event['data']['video'];
    print('Got video: ${video['url']}');
  } else if (event['status'] == 'completed') {
    print('Done, got ${event['data']['count']} videos total');
  }
}
```

#### `cancelRequest(String requestId) → Future<void>`

Cancel an in-flight invoke/stream request.

```dart
final reqId = 'my-req-123';
// ... started an invoke with this id ...
await bridge.cancelRequest(reqId);
```

### Management methods (new — not in SidecarBridge)

These are new to `RemoteSidecarBridge`. The local `SidecarBridge` didn't need them because repo management was done via the runtime's Dart code directly.

#### `addRepo(String repoUrl) → Future<Map>`

Subscribe to an extension repo. Auto-detects format (Aniyomi / CloudStream / Kotatsu).

```dart
await bridge.addRepo('https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json');
```

#### `removeRepo(String repoUrl) → Future<Map>`

Unsubscribe from a repo. Does NOT uninstall extensions that came from it.

```dart
await bridge.removeRepo('https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json');
```

#### `listRepos() → Future<Map>`

List the user's subscribed repos.

```dart
final resp = await bridge.listRepos();
// resp = { 'repos': [ { 'repoUrl': '...', 'addedAt': 1782537487824 } ] }
```

#### `listAvailable({String? type}) → Future<Map>`

List available extensions across all subscribed repos. Optional `type` filter.

```dart
final all = await bridge.listAvailable();
final anime = await bridge.listAvailable(type: 'anime');
final manga = await bridge.listAvailable(type: 'manga');
final novel = await bridge.listAvailable(type: 'novel');
```

#### `listInstalled({String? type}) → Future<Map>`

List installed extensions. Optional `type` filter.

```dart
final installed = await bridge.listInstalled(type: 'anime');
```

#### `install(String extId, String repoUrl) → Future<Map>`

Install an extension.

```dart
await bridge.install(
  extId: '8542735178285060053',
  repoUrl: 'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json',
);
```

#### `uninstall(String extId) → Future<Map>`

Uninstall an extension.

```dart
await bridge.uninstall(extId: '8542735178285060053');
```

---

## 4. How it wraps requests

The local `SidecarBridge` sends invoke requests over stdin:
```json
{ "method": "search", "args": { "sourceId": "...", "query": "naruto" }, "id": "req-1" }
```

The `RemoteSidecarBridge` wraps this inside an SSH envelope:
```json
{
  "id": "envelope-1",
  "action": "invoke",
  "payload": {
    "extId": "8542735178285060053",
    "method": "search",
    "args": { "sourceId": "...", "query": "naruto" },
    "innerId": "req-1"
  }
}
```

The bridge server:
1. Receives the envelope over SSH
2. Validates `userId` has `extId` installed (install-gate)
3. Looks up the ext's runtime (aniyomi / cloudstream / kotatsu)
4. Translates the method name if needed (e.g. `search` → `csSearch` for CloudStream)
5. Forwards the inner `{method, args, id}` to the JAR via stdin
6. Receives the JAR's response
7. Wraps it in `{id, status, data}` and sends back over SSH

The iOS client sees the same response shape either way.

---

## 5. SSH keypair management

Each iOS user needs an SSH keypair. The **public key** is the user's identity on the server (fingerprint = userId). The **private key** must be stored securely.

### Generating a keypair

```dart
import 'package:dartssh2/dartssh2.dart';

final keyPair = SSHKeyPair.ed25519();  // generate once

// Store the private key in Keychain:
final privatePem = keyPair.toOpenSSHString();
await FlutterKeychainStorage.put(key: 'anymex_ssh_private_key', value: privatePem);

// The public key (for reference — server doesn't need it pre-registered):
final publicOpenSSH = keyPair.publicKey.toOpenSSHString();
print('User identity: $publicOpenSSH');
```

### Loading an existing keypair

```dart
final privatePem = await FlutterKeychainStorage.get('anymex_ssh_private_key');
final keyPair = SSHKeyPair.fromPem(privatePem);
```

### Key rotation

To rotate a user's key:
1. Generate a new keypair
2. Update Keychain
3. Call `RemoteSidecarBridge().configure(...)` with the new key
4. The server creates a **new** user row (different fingerprint = different userId)
5. The old user's subscribed repos / installed exts are NOT migrated

If you need key migration, you'd have to add a "merge users" endpoint to the server — currently not implemented.

---

## 6. Connection lifecycle

- **Persistent connection:** `RemoteSidecarBridge` opens ONE SSH exec channel at `configure()` time and keeps it open for the app's lifetime.
- **Auto-reconnect:** If the SSH connection drops, the next `invokeMethod` call triggers a reconnect.
- **In-flight requests:** Lost on disconnect → caller gets an error → should retry.
- **Multiple concurrent requests:** Supported — requests are multiplexed by `id` over the single channel.

---

## 7. Migration from SidecarBridge

If you're migrating an existing AnymeX fork:

### Before (local JVM):
```dart
// lib/anymex_bridge.dart
import 'Runtime/Bridge/SidecarBridge.dart';

class AnymeXBridge {
  final _bridge = SidecarBridge();
  
  Future<List<SearchResult>> search(String extId, String query) async {
    final resp = await _bridge.invokeMethod('search', {
      'extId': extId,
      'args': { 'query': query },
    });
    return (resp['data']['list'] as List).map(SearchResult.fromJson).toList();
  }
}
```

### After (remote JVM):
```dart
// lib/anymeex_bridge.dart
import 'Runtime/Bridge/RemoteSidecarBridge.dart';

class AnymeXBridge {
  final _bridge = RemoteSidecarBridge();
  
  Future<void> init() async {
    await _bridge.configure(RemoteBridgeConfig(
      host: 'bridge.example.com',
      port: 3022,
      username: 'anymex',
      keyPair: await loadKeyPair(),
    ));
  }
  
  Future<List<SearchResult>> search(String extId, String query) async {
    final resp = await _bridge.invokeMethod('search', {
      'extId': extId,
      'args': { 'query': query },
    });
    return (resp['data']['list'] as List).map(SearchResult.fromJson).toList();
  }
}
```

The only changes:
1. Import `RemoteSidecarBridge` instead of `SidecarBridge`
2. Add `init()` that calls `configure()`
3. Repo management now goes through `bridge.addRepo()` / `bridge.install()` instead of the runtime's Dart repo management

---

## 8. Fallback strategy

You can keep BOTH bridges and switch at runtime:

```dart
import 'Runtime/Bridge/SidecarBridge.dart';
import 'Runtime/Bridge/RemoteSidecarBridge.dart';

enum BridgeMode { local, remote }

class BridgeFactory {
  static dynamic create(BridgeMode mode) {
    switch (mode) {
      case BridgeMode.local:
        return SidecarBridge();      // works on Mac/PC/Android
      case BridgeMode.remote:
        return RemoteSidecarBridge(); // works everywhere (incl. iOS)
    }
  }
}
```

This lets you ship one binary that uses the local JVM on supported platforms and the remote JVM on iOS.

---

## 9. Testing the connection

After `configure()`, call `hello` to verify:

```dart
await bridge.configure(...);

// Simple ping
final resp = await bridge.invokeMethod('hello', {});
if (resp['status'] == 'ok') {
  print('Connected to bridge server: ${resp['data']}');
} else {
  print('Connection failed: ${resp['error']}');
}
```

Or use the raw management API:

```dart
final repos = await bridge.listRepos();
print('Subscribed to ${repos['repos'].length} repos');
```

---

## 10. Troubleshooting

### "All configured authentication methods failed"

The SSH keypair is invalid or the server rejected it. Check:
- The keypair is ed25519 or RSA
- The private key PEM is correctly loaded
- The server is running (`nc -zv bridge.example.com 3022`)

### "Host key verification failed"

The server's host key changed (or it's your first connect). For development:

```dart
await bridge.configure(RemoteBridgeConfig(
  ...
  hostVerifier: (key) => true,  // accept any host key (DEV ONLY)
));
```

For production, pin the host key on first connect and store it.

### Connection keeps dropping

The bridge server may have restarted (JAR hot-swap). `RemoteSidecarBridge` auto-reconnects, but in-flight requests fail. Add retry logic:

```dart
Future<Map> invokeWithRetry(String method, Map args, {int maxRetries = 2}) async {
  for (int i = 0; i <= maxRetries; i++) {
    try {
      return await bridge.invokeMethod(method, args);
    } catch (e) {
      if (i == maxRetries) rethrow;
      await Future.delayed(Duration(seconds: 1 << i));
    }
  }
  throw StateError('unreachable');
}
```

### "Extension not installed"

You forgot to call `install()` before `invokeMethod()`. The server install-gates every invoke.
