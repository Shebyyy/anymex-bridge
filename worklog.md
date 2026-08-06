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
