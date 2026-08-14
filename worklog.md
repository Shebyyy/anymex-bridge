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

---
Task ID: 2
Agent: Main Agent
Task: Re-implement server bridge client with ONE file approach (after repo reset)

Work Log:
- Read ALL Dart files in the project thoroughly (BridgeDispatcher, SidecarBridge, JniBridge, ExtensionManager, DesktopExtensionBase, RuntimeController, RuntimePaths, RuntimeDownloader, RuntimeTools, AnymeXBridge, ExtensionBridge, KvStore, Logger, all Extensions/SourceMethods/Models files, all Service implementations, Native bindings, Sora, Aniyomi, CloudStream, Kotatsu, Mangayomi)
- Understood complete architecture: BridgeDispatcher routes to JniBridge/SidecarBridge, all SourceMethods call BridgeDispatcher().invokeMethod(), Extension subclasses handle list/install/repos
- Key insight: Server forwards unknown methods to its local JAR, so ALL existing SourceMethods work automatically via SSH - ZERO new SourceMethods needed
- Created ONE file: lib/Runtime/Bridge/ServerBridge.dart containing:
  - ServerBridge: SSH transport (singleton, dartssh2, same pattern as SidecarBridge)
  - ServerAuth: HTTP register/health endpoints
  - ServerBridgeExtensions: Extension subclass for server-side extension management (list, install, repos via SSH)
- Modified BridgeDispatcher.dart: Added server to BridgeType enum, all methods handle server mode
- Modified ExtensionManager.dart: Added initServerBridge()/disconnectServerBridge(), fixed getSourceManager() to check managerId first
- Modified anymex_extension_runtime_bridge.dart: Added ServerBridge export
- Modified pubspec.yaml: Added dartssh2: ^2.11.0 dependency

Stage Summary:
- ONE new file: ServerBridge.dart (SSH transport + auth + ServerBridgeExtensions)
- 4 modified files: BridgeDispatcher, ExtensionManager, exports, pubspec
- No new SourceMethods files needed - existing ones work via BridgeDispatcher
- Usage: ExtensionManager().initServerBridge(host: "...", username: "...", password: "...")

---
Task ID: 3
Agent: Main Agent
Task: Fix ServerBridge - missing Kotatsu support, broken type mapping, wrong source detection

Work Log:
- Found 5 bugs in ServerBridge.dart:
  1. `createSourceMethods` only handled CloudStreamSource and Aniyomi — KotatsuSource completely missing
  2. `_mapServerType` only matched 'anime'/'manga'/'novel' but server stores 'aniyomi-anime', 'aniyomi-manga', 'cloudstream', 'kotatsu' — everything fell to fallback
  3. `_parseInstalledList` checked for `is_cloudstream` field and `source_id.startsWith('cs_')` — server never returns those, it returns `type: 'cloudstream'`
  4. `_parseAvailableList` only created ASource, never KotatsuSource or CloudStreamSource
  5. Server's `getExtensions` used exact `type = ?` match, but client sent 'anime' while server stored 'aniyomi-anime' → zero results
- Fixed server ssh.ts: Changed `WHERE type = ?` to `WHERE type LIKE ?` with `%type%` pattern
- Rewrote ServerBridge.dart:
  - Added KotatsuSource + DesktopKotatsuSourceMethods imports
  - Replaced `_mapServerType` with `_serverTypeToItemType` handling all server types (aniyomi-anime→anime, aniyomi-manga→manga, cloudstream→anime, kotatsu→manga)
  - Added `_serverTypeToKind` helper (returns 'aniyomi'/'cloudstream'/'kotatsu')
  - Added `_mapToSource` dispatcher that creates correct Source subclass based on server type
  - Added `_mapToKotatsuSource` that parses extra JSON for jarName/pkgName
  - Fixed `_parseInstalledList` and `_parseAvailableList` to use server `type` field
  - Fixed `createSourceMethods` to handle KotatsuSource → DesktopKotatsuSourceMethods
  - Fixed `_getServerExtId` to also check KotatsuSource.pkgName
  - Fixed `invokeStreamMethod` to do a single invokeMethod call instead of returning empty stream

Stage Summary:
- Server bridge now supports ALL 3 extension types: Aniyomi, CloudStream, AND Kotatsu
- Type mapping fixed: server types (aniyomi-anime, aniyomi-manga, cloudstream, kotatsu) correctly mapped to Source subclasses
- Server query fixed: LIKE matching allows client 'anime'/'manga' filters to match 'aniyomi-anime'/'aniyomi-manga'
- Stream method fallback: instead of returning empty stream, now does a single invoke and emits result
- Files changed: ServerBridge.dart (rewritten), ssh.ts (1 line fix)---
Task ID: 1
Agent: main
Task: Fix iOS gray screen + Admin panel method dropdown & extension selector

Work Log:
- Verified iOS gray screen fix already pushed in commit 4297339c (nullable KV reads)
- Added /admin/loadExtensions, /admin/sources, /admin/downloadedExtensions endpoints to ssh.ts
- Rewrote admin.html Terminal section with method dropdown, source selector, auto-fill args
- Committed and pushed to beta branch

Stage Summary:
- iOS gray screen: already fixed, needs app rebuild
- Admin panel: now has method dropdown (loadExtensions, search, getPopular, getLatest, getDetail, getFilterList, getVideoList, convertApk), source/extension selector, auto-fill args, source count badge

