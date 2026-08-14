# AnymeX SSH Bridge - Work Log

---
Task ID: 1
Agent: main
Task: Build SSH bridge server for iOS AnymeX users

Work Log:
- Confirmed JAR filename: `anymex_desktop_runtime.jar` from `RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest/download/`
- Verified SidecarBridge protocol matches desktop exactly (newline-delimited JSON, stderr IPC)
- Fixed JAR stderr response parsing (JAR redirects stdout to stderr for IPC safety)
- Ported Dart PbDecoder to TypeScript for keiyoushi protobuf parsing (gzip + custom nested protobuf, NOT standard length-delimited)
- Fixed Aniyomi download URLs: `{baseUrl}/apk/{apkName}` and icons `{baseUrl}/icon/{pkg}.png` (matching runtime's ASource.apkUrl getter)
- Added CloudStream support: JSON array repos, pluginUrl/plugin/url field priority, meta-repo with pluginLists
- Added Kotatsu support: repo URL = JAR file itself
- Added both repos: yuzono/anime-repo (255 exts, JSON) + keiyoushi/extensions (1369 exts, gzip protobuf) = 1624 total
- Verified APK downloads work (AnimeOnsen from yuzono, MangaDex from keiyoushi)
- Bridge running: SSH :3022, HTTP :8081, JAR sidecar active

Stage Summary:
- Bridge at `/home/z/my-project/bridge/` - fully operational
- 1624 extensions cataloged, 2 installed and downloaded
- Protocol verified against desktop AnymeXExtensionRuntimeBridge source
- User `testuser` / `test1234` registered
---
Task ID: 1
Agent: main
Task: Protocol analysis and fix - make SSH bridge match SidecarBridge.dart exactly

Work Log:
- Cloned AnymeXExtensionRuntimeBridge to /home/z/my-project/anymex-runtime
- Read ALL bridge files: SidecarBridge.dart, IosFfiBridge.dart, BridgeDispatcher.dart, IosExtensionBase.dart
- Read ALL extension files: IosAniyomiExtensions.dart, IosCloudStreamExtensions.dart, IosKotatsuExtensions.dart
- Read ALL source method files: DesktopAniyomiSourceMethods.dart, DesktopCloudStreamSourceMethods.dart, DesktopKotatsuSourceMethods.dart
- Read ALL our bridge files: ssh.ts, jar.ts, db.ts, extensions.ts, repos.ts, auto-update.ts, index.ts
- Identified critical protocol differences:
  - Our response had status:"ok" (real app has NO status on success)
  - Our SSH had custom methods the app never calls (addRepo, installExtension, getExtensions, etc.)
  - Real app: ALL methods go to JAR, bridge is transparent proxy
  - Real response: {id, data} for success, {id, status:"error", data} for error
- Rewrote ssh.ts as transparent JAR proxy
- Updated jar.ts with clientRequestId passthrough and cancelJarRequest
- Cleaned up db.ts (removed unused functions)
- Cleaned up extensions.ts (removed installExtension that used removed DB functions)
- Updated index.ts (HTTP admin-only, version bump to v2.2)
- Committed and pushed to beta branch

Stage Summary:
- SSH bridge now speaks exact SidecarBridge.dart protocol
- All bridge methods (loadExtensions, convertApk, getPopular, search, etc.) are forwarded to JAR
- Client request IDs pass through for cancel support
- Server-side path patching for loadExtensions methods
- HTTP is admin-only (health, register, forceUpdate)

