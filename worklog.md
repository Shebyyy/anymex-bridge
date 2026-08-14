---
Task ID: 1
Agent: Main Agent
Task: Integrate SSH server bridge client into AnymeXExtensionRuntimeBridge (main branch)

Work Log:
- Read and analyzed BridgeDispatcher.dart, SidecarBridge.dart, JniBridge.dart, ExtensionManager.dart, DesktopAniyomiExtensions.dart, DesktopAniyomiSourceMethods.dart, Extensions.dart, Source.dart models, AnymeXBridge.dart, pubspec.yaml
- Read server-side SSH protocol (bridge/ssh.ts) to understand method routing (register, login, addRepo, installExtension, listExtensions, getExtensions, getRepos, forceUpdate, health, JAR forward)
- Added `dartssh2: ^2.11.0` dependency to pubspec.yaml for SSH client
- Created `lib/Runtime/Bridge/ServerBridge.dart` — Singleton SSH bridge client that:
  - Connects to server via SSH with username/password auth
  - Sends JSON `{method, args, id}` via exec, receives `{id, status, data/error}`
  - Static `register()` and `healthCheck()` via HTTP (no auth needed)
  - Server-specific methods: addRepo, installExtension, listExtensions, getExtensions, getRepos, forceUpdate
  - Auto-reconnect on failed requests
  - Keep-alive pings every 2 minutes
  - Configuration persisted in KvStore (host, ports, username, password)
  - Same interface pattern as SidecarBridge (invokeMethod, invokeStreamMethod, cancelRequest, dispose)
- Updated `lib/Runtime/Bridge/BridgeDispatcher.dart`:
  - Added `server` to `BridgeType` enum (was: jni, sidecar — now: jni, sidecar, server)
  - Added `isServerBridge` getter
  - All methods (initialize, invokeMethod, invokeStreamMethod, cancelRequest, dispose) now route to ServerBridge when in server mode
- Created `lib/Services/ServerBridge/ServerBridgeExtensions.dart` — Extension manager that:
  - Uses `ServerBridge()` for all extension lifecycle (repos, install, uninstall, update)
  - Fetches installed extensions via `listExtensions` SSH method
  - Fetches available extensions via `getExtensions` SSH method
  - Manages repos via `addRepo`/`getRepos` SSH methods
  - Installs extensions by server-side ID via `installExtension` SSH method
  - Maps server extension data (id, name, pkg, type, version, icon_url, lang, is_nsfw, extra) to ASource model
- Created `lib/Services/ServerBridge/ServerBridgeSourceMethods.dart` — Source methods that:
  - Forward all calls (getPopular, getLatestUpdates, search, getDetail, getVideoList, getPageList, getFilterList, getPreference, setPreference) through BridgeDispatcher to the server
  - Server forwards these to its local JAR sidecar
  - Same API as DesktopAniyomiSourceMethods but via SSH tunnel
- Updated `lib/ExtensionManager.dart`:
  - Added `initServerBridge()` method to register ServerBridgeExtensions
  - Added `disconnectServerBridge()` method to clean up
  - Updated `getSourceManager()` to route ASource with managerId='server-bridge' to the server bridge manager
- Updated `lib/Models/Source.dart`: Added `int? serverExtId` field for server-side extension database ID
- Updated `lib/anymex_extension_runtime_bridge.dart`: Added exports for ServerBridge.dart, ServerBridgeExtensions.dart, ServerBridgeSourceMethods.dart
- Deleted duplicate `/home/z/my-project/anymex-runtime/` directory

Stage Summary:
- Server bridge integration is complete in the Dart library
- New files: ServerBridge.dart, ServerBridgeExtensions.dart, ServerBridgeSourceMethods.dart
- Modified files: BridgeDispatcher.dart, ExtensionManager.dart, Source.dart, pubspec.yaml, barrel export
- The app can now use `BridgeType.server` on iOS (or any platform)
- Flow: iOS user → registers via HTTP → connects via SSH → manages repos/extensions on server → all JAR method calls (getPopular, search, etc.) forwarded through SSH to server's JAR
