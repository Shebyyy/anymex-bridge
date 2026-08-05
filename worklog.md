# AnymeX JVM Bridge Server — Worklog

## Task 1: JVM Bridge Server — Complete Project Implementation

**Date**: 2025
**Status**: Completed
**Location**: `/home/z/my-project/jvm-bridge-server/`

### Summary
Created a comprehensive, production-ready JVM Bridge Server for the AnymeX Extension Runtime Bridge project. The server enables iOS devices to execute Aniyomi, CloudStream, and Kotatsu extensions remotely via HTTP API, bypassing the need for Android's DexClassLoader on iOS.

### Files Created (19 files)

#### Build & Configuration (4 files)
1. **`build.gradle.kts`** — Gradle Kotlin DSL build script with Ktor, OkHttp, Gson, dexlib2, coroutines, and Shadow JAR plugin
2. **`settings.gradle.kts`** — Project settings
3. **`gradle.properties`** — JVM args, parallel builds, incremental compilation
4. **`gradle/libs.versions.toml`** — Centralized version catalog for all dependencies

#### Server Core (2 files)
5. **`src/.../Application.kt`** — Ktor server entry point with CORS, content negotiation (Gson), call logging, status pages, and all route registration
6. **`src/.../ServerConfig.kt`** — Configurable via environment variables: port, host, cache dir, temp dir, memory limits, CORS origins, log level

#### Data Models (2 files)
7. **`src/.../models/Requests.kt`** — 18 request data classes covering all Aniyomi (install, uninstall, search, popular, latest, detail, video-list, page-list, filter-list, preference, save-preference), CloudStream (install, uninstall, search, detail, video-list), and Kotatsu (install, uninstall, search, popular, latest, detail, page-list) endpoints
8. **`src/.../models/Responses.kt`** — Response envelope (`ApiResponse<T>` with success/data/error), extension metadata types, search results, media details, episode info, video sources, page items, filter entries, preference entries, health status, JVM info

#### Utility (1 file)
9. **`src/.../util/HttpUtil.kt`** — OkHttp-based HTTP client with connection pooling, redirect following, logging interceptor, file download with progress callback, GET/POST helpers, URL filename extraction, and graceful shutdown

#### Extension System (4 files)
10. **`src/.../extension/ExtensionCache.kt`** — Disk-based extension cache manager: downloads files to organized subdirectories, JSON manifest persistence per extension type, in-memory registries with ConcurrentHashMap, install/uninstall lifecycle
11. **`src/.../extension/AniyomiExtensionLoader.kt`** — Aniyomi APK loader: extracts DEX from APK via dexlib2, converts DEX→JAR, creates isolated URLClassLoader per extension, reflection-based method invocation, in-memory preference store replacing SharedPreferences
12. **`src/.../extension/CloudStreamPluginLoader.kt`** — CloudStream .cs3 loader: direct URLClassLoader loading (cs3 files are JARs), provider discovery, reflection-based method invocation
13. **`src/.../extension/KotatsuExtensionLoader.kt`** — Kotatsu .jar loader: direct URLClassLoader, JAR scanning for parser classes, reflection-based method invocation

#### REST API Routes (5 files)
14. **`src/.../routes/HealthRoutes.kt`** — `GET /api/health` with JVM runtime info, uptime, extension counts
15. **`src/.../routes/AniyomiRoutes.kt`** — 12 Aniyomi endpoints (install, uninstall, extensions, search, popular, latest, detail, video-list, page-list, filter-list, preference, save-preference)
16. **`src/.../routes/CloudStreamRoutes.kt`** — 6 CloudStream endpoints (install, uninstall, providers, search, detail, video-list)
17. **`src/.../routes/KotatsuRoutes.kt`** — 8 Kotatsu endpoints (install, uninstall, extensions, search, popular, latest, detail, page-list)
18. **`src/.../routes/ImageProxyRoutes.kt`** — `GET /api/proxy/image` with Referer header spoofing, content-type detection, streaming response

#### Deployment (2 files)
19. **`Dockerfile`** — Multi-stage build (JDK 17 build → JRE 17 runtime), non-root user, health checks, configurable env vars
20. **`README.md`** — Architecture diagram, API docs, configuration table, example curl commands, project structure, technology stack

### Design Decisions
- **Headless JVM**: No Android Context, no UI code — pure JVM server
- **DEX→JAR conversion**: Uses dexlib2 to parse APK DEX files and convert to loadable JAR
- **Isolated ClassLoaders**: Each extension gets its own URLClassLoader to prevent class conflicts
- **In-memory preferences**: Replaces Android SharedPreferences with ConcurrentHashMap
- **Standardized response envelope**: All endpoints return `{ success, data, error }` matching the Flutter MethodChannel pattern
- **CORS enabled**: Cross-origin support for iOS app web requests
- **Image proxy**: Handles Referer-based anti-hotlinking on manga sources
- **Reflection-based invocation**: Extension methods invoked via reflection since we can't compile against extension interfaces

---

## Task 6: iOS Remote Proxy Extension Classes — Flutter Client Implementation

**Date**: 2025
**Status**: Completed
**Location**: `/home/z/my-project/AnymeXExtensionRuntimeBridge/lib/`

### Summary
Created iOS-compatible remote proxy classes for the AnymeX Extension Runtime Bridge Flutter project. These classes replace the native Android MethodChannel-based source methods with HTTP calls to the remote JVM Bridge Server (Task 1), enabling full Aniyomi, CloudStream, and Kotatsu support on iOS.

### Architecture
```
iOS Flutter App
  └─ ExtensionManager
       ├─ SoraExtensions (JS-based, works natively)
       ├─ MangayomiExtensions (JS-based, works natively)
       └─ Remote Extensions (NEW — HTTP proxy to JVM Bridge Server)
            ├─ RemoteAniyomiExtensions → RemoteAniyomiSourceMethods
            ├─ RemoteCloudStreamExtensions → RemoteCloudStreamSourceMethods
            └─ RemoteKotatsuExtensions → RemoteKotatsuSourceMethods
                  │
                  ▼ HTTP (JSON)
            JVM Bridge Server (Task 1)
```

### Files Created (7 new files + 1 modified)

#### Runtime Layer (1 file)
1. **`lib/Runtime/RemoteBridgeClient.dart`** — Singleton HTTP client with:
   - Configurable base URL, persisted via KvStore
   - POST/GET methods with standard `{ success, data, error }` envelope parsing
   - 30-second timeout, 1 automatic retry on network errors
   - Retry on `SocketException`, `TimeoutException`, `http.ClientException`
   - No retry on HTTP 4xx/5xx (application errors)

#### Remote Extension Proxies (6 files)

2. **`lib/Services/Remote/RemoteAniyomiExtensions.dart`** — Remote Aniyomi extension manager:
   - `id = 'aniyomi-remote'`, `supportsAnime = true`, `supportsManga = true`
   - `requiresPlugin = false` (server handles plugin loading)
   - Repo browsing stays client-side (protobuf + JSON index parsing via `PbDecoder`)
   - Shares repo KvStore keys with native AniyomiExtensions (no re-add needed)
   - `fetchInstalledAnimeExtensions/MangaExtensions` — calls `GET /api/aniyomi/extensions`
   - `installSource` — calls `POST /api/aniyomi/install` with download URL
   - `uninstallSource` — calls `POST /api/aniyomi/uninstall`

3. **`lib/Services/Remote/RemoteAniyomiSourceMethods.dart`** — Remote Aniyomi source execution:
   - `getPopular`, `getLatestUpdates`, `search`, `getDetail`, `getVideoList`, `getPageList`
   - `getFilterList`, `getPreference`, `setPreference`
   - Full filter mapping (Header, Separator, CheckBox, TriState, Select, Sort, Text, Group)
   - Response parsing via `compute()` for off-main-thread work
   - Reuses `mapToSourcePreference` from native `AniyomiSourceMethods`

4. **`lib/Services/Remote/RemoteCloudStreamExtensions.dart`** — Remote CloudStream extension manager:
   - `id = 'cloudstream-remote'`, `supportsAnime = true`, `supportsManga = false`
   - Repo browsing stays client-side (JSON format with meta-repo support)
   - `fetchInstalledAnimeExtensions` — calls `GET /api/cloudstream/providers`
   - `installSource` — calls `POST /api/cloudstream/install`
   - `uninstallSource` — calls `POST /api/cloudstream/uninstall`

5. **`lib/Services/Remote/RemoteCloudStreamSourceMethods.dart`** — Remote CloudStream source execution:
   - `search`, `getDetail`, `getVideoList` (via `POST /api/cloudstream/*`)
   - `getPopular`, `getLatestUpdates` return empty (same as native)
   - `getVideoList` uses `Video.fromCs` parser for CloudStream video format
   - No video stream support over HTTP (stream = null)

6. **`lib/Services/Remote/RemoteKotatsuExtensions.dart`** — Remote Kotatsu extension manager:
   - `id = 'kotatsu-remote'`, `supportsAnime = false`, `supportsManga = true`
   - `fetchMangaExtensions/InstalledMangaExtensions` — calls `GET /api/kotatsu/extensions`
   - Install/uninstall uses active-sources list persisted in KvStore
   - Shares repo KvStore keys with native KotatsuExtensions

7. **`lib/Services/Remote/RemoteKotatsuSourceMethods.dart`** — Remote Kotatsu source execution:
   - `getPopular`, `getLatestUpdates`, `search`, `getDetail`, `getPageList`
   - Episodes reversed after detail fetch (Kotatsu convention)
   - `getVideoList` returns empty (Kotatsu is manga-only)

#### Modified Files (1 file)

8. **`lib/ExtensionManager.dart`** — Updated with:
   - New imports for `RemoteBridgeClient` and all three remote extensions
   - iOS branch in `onRuntimeBridgeInitialization()`: reads `remote_bridge_server_url` from KvStore, configures `RemoteBridgeClient`, registers remote extensions
   - `getSourceManager()` extension updated with fallback chain: native → desktop → remote for ASource, CloudStreamSource, KotatsuSource

### Key Design Decisions
- **Same request/response format as MethodChannel**: The remote proxy classes send the exact same JSON payloads that `platform.invokeMethod` sends, ensuring the server can handle them identically
- **Client-side repo browsing**: Repo index fetching/parsing stays on the client (pure HTTP to GitHub). Only source execution needs the server
- **Shared KvStore keys**: Remote extensions use the same repo KvStore keys as their native counterparts, so users don't need to re-add repos
- **`requiresPlugin = false`**: Remote extensions don't need local plugin loading since the server handles it
- **Graceful degradation**: If the server is not configured or not reachable, remote extensions simply won't be registered (no crash)
- **No `dart:async` imports in source methods**: Cleaned up unused imports since cancelRequest is a no-op for remote
Task ID: 8-9
Agent: main
Task: Build Next.js management dashboard for the bridge server

Work Log:
- Created Prisma schema with BridgeServerConfig model
- Built API proxy route at /api/bridge/[...path]/route.ts
- Built config management API at /api/bridge-config/route.ts
- Created Zustand store for bridge state
- Built comprehensive dashboard page with health stats, extensions tabs, and quick search
- Verified dashboard renders correctly via agent-browser

Stage Summary:
- Dashboard is fully functional with connection management, extension display, and search testing
- All 28 server API endpoints are proxied through the Next.js API route
- Dashboard shows skeleton loading, error toasts, and responsive layout
