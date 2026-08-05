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

---

## Task ID: REPO-ANALYSIS-1
Agent: repo-analyst
Task: Comprehensive analysis of AnymeX extension & repository management system

## 1. Extension Repos

### 1.1 Repo JSON Format

There is **no single universal repo format**. Each extension type (Aniyomi, CloudStream, Kotatsu, Sora, Mangayomi) defines its own repo index format:

**Aniyomi** (protobuf or JSON):
- Protobuf binary (`.pb` / `.pb.gz`) OR JSON (`.min.json`)
- File: `lib/Services/Aniyomi/AniyomiExtensions.dart` lines 207-312
- Fields per entry: `name`, `pkg`, `apk`, `lang`, `version`, `isNsfw`, `sources[{id}]`
- Anime vs manga detected by: name prefix (`"Aniyomi: "` → anime, `"Tachiyomi: "` → manga) OR pkg name contains `.anime.` or `.manga.`
- Icons at: `{baseRepoUrl}/icon/{pkg}.png`
- APK download at: `{baseRepoUrl}/apk/{apkName}`
- Example URL pattern: `https://raw.githubusercontent.com/.../index.min.json` or `index.pb.gz`

**CloudStream** (JSON):
- File: `lib/Services/CloudStream/CloudStreamExtensions.dart` lines 117-193
- Direct JSON array of plugin objects
- Fields: `name`, `url` (download URL), `internalName`, `iconUrl`, `language`, `version`, `isNsfw`, `hasSettings`
- Supports **meta-repos**: JSON object with `pluginLists` array of sub-repo URLs
- Each entry is a `.cs3` plugin file

**Kotatsu** (single JAR URL):
- File: `lib/Services/Kotatsu/KotatsuExtensions.dart` lines 52-95
- The repo URL points directly to a JAR file (the entire repo is one JAR containing all parsers)
- The JAR is downloaded and loaded via MethodChannel `loadExtensions`

**Sora** (JSON):
- File: `lib/Services/Sora/SoraExtensions.dart` lines 200-255
- JSON array OR JSON object (map of extensions)
- Fields: `sourceName`, `type` (e.g. "animes", "mangas", "novels"), `language`, `version`, `iconUrl`/`iconURL`, `baseUrl`, `scriptUrl`/`scriptURL`
- Type detection: `type.contains('anime')`, `type.contains('mangas')`, `type.contains('novels')`

**Mangayomi** (JSON):
- File: `lib/Services/Mangayomi/MangayomiExtensions.dart` lines 261-280
- JSON array of extension objects
- Fields: same as base `Source` model + `sourceCodeUrl`, `sourceCodeLanguage` (dart/js/lnreader)
- Extension source code is downloaded and stored in-memory (Dart code executed locally)

### 1.2 Repo Data Model (Dart)

File: `lib/Extensions/Extensions.dart` lines 141-174

```dart
class Repo {
  final String url;          // The index URL
  final String? name;        // Display name (Sora uses this from author.name)
  final String? iconUrl;     // Icon URL (Sora uses this from author.icon)
  final String? extensions;  // Extension count string (Sora)
  final String? managerId;   // Which extension manager owns this repo
}
```

### 1.3 How Repos are Stored

All repos are stored in **Isar KvStore** as `List<String>` of JSON-encoded `Repo` objects. Key pattern: `{managerId}{itemTypeName}Repos`

| Manager ID | Key | Notes |
|---|---|---|
| `aniyomi` | `aniyomiAnimeRepos` | Shared with `aniyomi-desktop` |
| `aniyomi` | `aniyomiMangaRepos` | Shared with `aniyomi-desktop` |
| `cloudstream` | `cloudstreamAnimeRepos` | |
| `kotatsu` | `kotatsuMangaRepos` | |
| `mangayomi` | `mangayomiAnimeRepos` | |
| `mangayomi` | `mangayomiMangaRepos` | |
| `mangayomi` | `mangayomiNovelRepos` | |
| `sora` | `soraAnimeRepos` | |
| `sora` | `soraMangaRepos` | |
| `sora` | `soraNovelRepos` | |

**No default repos are pre-populated.** Users add repos manually via the `GitHubRepoDialog` widget.

### 1.4 Key Repo Source Files

- `AnymeXExtensionRuntimeBridge/lib/Extensions/Extensions.dart` — `Extension` abstract class, `Repo` model
- `AnymeXExtensionRuntimeBridge/lib/ExtensionManager.dart` — Central manager with `addRepo/removeRepo/getAllRepos`
- `AnymeXExtensionRuntimeBridge/lib/Services/Aniyomi/AniyomiExtensions.dart` — Aniyomi repo loading/parsing
- `AnymeXExtensionRuntimeBridge/lib/Services/CloudStream/CloudStreamExtensions.dart` — CloudStream repos (with meta-repo support)
- `AnymeXExtensionRuntimeBridge/lib/Services/Kotatsu/KotatsuExtensions.dart` — Kotatsu repo (single JAR)
- `AnymeXExtensionRuntimeBridge/lib/Services/Sora/SoraExtensions.dart` — Sora repos
- `AnymeXExtensionRuntimeBridge/lib/Services/Mangayomi/MangayomiExtensions.dart` — Mangayomi repos
- `AnymeX/lib/screens/settings/sub_settings/widgets/repo_dialog.dart` — UI for adding repos

---

## 2. Extension Download Flow

### 2.1 Download Flow by Extension Type

**Aniyomi (Android):**
1. APK downloaded from `{repoBase}/apk/{apkName}` to temp directory
2. Optional: save to custom path (`use_internal_anime_extension_loading` / `use_internal_manga_extension_loading` settings)
3. Install via `InstallPlugin.installApk()` (system package manager) OR `platform.invokeMethod('installSourceInternal')` (private/internal install)
4. Installed extensions discovered by `platform.invokeMethod('getInstalledAnimeExtensions')` which scans installed APKs
5. Temp file cleaned up after install (unless custom path)

**Aniyomi (Desktop):**
1. APK downloaded to `{runtimeDir}/Extensions/Aniyomi/`
2. APK converted to JAR via `BridgeDispatcher().invokeMethod('convertApk')` (sidecar uses `de.femtopedia.dex2jar`)
3. JAR stays on disk at `{extensionsDir}/Aniyomi/{pkgName}.jar`
4. Icon URL and version saved to KvStore as `desktop_ext_icon_{pkgName}` and `desktop_ext_version_{pkgName}`
5. `BridgeDispatcher().invokeMethod('loadExtensions', {folderPath})` scans the folder

**CloudStream (Android):**
1. `.cs3` file downloaded from `pluginUrl` to `{documentsDir}/AnymeX/cloudstream_plugins/{internalName}.cs3`
2. Written via temp file (`.tmp`) then renamed
3. Loaded via `platform.invokeMethod('loadPlugin', {path})`
4. Metadata saved to KvStore as `cs_meta_{normalizedInternalName}` (JSON with iconUrl, language, version, pluginUrl, repo)

**CloudStream (Desktop):**
1. Same `.cs3` download to `{documentsDir}/AnymeX/cloudstream_plugins/`
2. Loaded via `BridgeDispatcher().invokeMethod('loadPlugin')` or `BridgeDispatcher().invokeMethod('loadExtensions')`

**Kotatsu (Android):**
1. JAR downloaded from repo URL to `{documentsDir}/AnymeX/kotatsu_plugins/plugin.jar`
2. Loaded via `platform.invokeMethod('loadExtensions', {folderPath})`
3. Active sources tracked in KvStore as `kotatsu_active_sources` (List<String> of source IDs)
4. Install/uninstall just adds/removes IDs from the active list (no file changes)

**Kotatsu (Desktop):**
1. Same JAR download to `{documentsDir}/AnymeX/kotatsu_plugins/plugin.jar`
2. Loaded via `BridgeDispatcher().invokeMethod('loadExtensions')`

**Sora:**
1. Source code (JS/Dart) downloaded from `sourceCodeUrl`/`scriptUrl`
2. Stored **in-memory** as `sourceCode` field on `SSource`
3. Entire installed list persisted as JSON-encoded list in KvStore: `sora-Installed-{type.name}`

**Mangayomi:**
1. Source code (Dart/JS) downloaded from `sourceCodeUrl`
2. Stored **in-memory** as `sourceCode` field on `MSource`
3. Headers captured via `getExtensionService(target).getHeaders()`
4. Entire installed list persisted as JSON-encoded list in KvStore: `mangayomi-Installed-{type.name}`

### 2.2 File Formats Summary

| Type | Format | Storage |
|---|---|---|
| Aniyomi (Android) | `.apk` (Android package) | System package manager OR internal APK dir |
| Aniyomi (Desktop) | `.jar` (converted from APK) | `{runtimeDir}/Extensions/Aniyomi/` |
| CloudStream | `.cs3` (JAR with metadata) | `{documentsDir}/AnymeX/cloudstream_plugins/` |
| Kotatsu | `.jar` (Kotlin JAR) | `{documentsDir}/AnymeX/kotatsu_plugins/` |
| Sora | JS/Dart source code | In-memory + KvStore JSON |
| Mangayomi | Dart/JS source code | In-memory + KvStore JSON |

### 2.3 No Central Manifest File

There is **no single installed-extensions manifest file**. Each extension type manages its own install tracking:
- **Aniyomi/CloudStream/Kotatsu**: Discovered dynamically from the runtime bridge (Android) or sidecar (desktop) by scanning files/loaded classes
- **Sora/Mangayomi**: Persisted as JSON-encoded lists in KvStore

---

## 3. Extension Storage (Database/Schema)

### 3.1 Database: Isar (isar_community)

File: `AnymeX/lib/database/database.dart` lines 20-36

The app uses a **single shared Isar instance** named `'AnymeX'` containing both app and bridge schemas:

```dart
Isar.openSync(
  schemas: [
    ...AnymeXExtensionBridge.isarSchema,  // [KvEntrySchema]
    KeyValueSchema,                        // App-level KV
    OfflineMediaSchema,
    CustomListSchema
  ],
  directory: dir.path,
  name: 'AnymeX',
  inspector: true,
)
```

### 3.2 Isar Collections

**KvEntry** (from bridge plugin): `lib/Settings/KvStore.dart` lines 11-18
```dart
@collection
class KvEntry {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  late String key;
  late String value;  // JSON-encoded with type wrapper: {t: "string", v: "..."}
}
```

**KeyValue** (from main app): `lib/database/isar_models/key_value.dart`
```dart
@collection
class KeyValue {
  Id id = Isar.autoIncrement;
  @Index(unique: true, replace: true)
  late String key;
  String? value;  // JSON-encoded: {"val": <any>}
}
```

### 3.3 Fields Stored Per Extension

**Base Source** (`lib/Models/Source.dart`):
`id`, `name`, `baseUrl`, `lang`, `isNsfw`, `iconUrl`, `version`, `versionLast`, `itemType` (enum index), `repo`, `managerId`, `hasUpdate`, `isPrivate`, `supportsLatest`, `supportsPopular`

**ASource** (Aniyomi - `lib/Services/Aniyomi/Models/Source.dart`):
+ `pkgName`, `apkName`, `langs` (List<ASource> for multi-language grouping)

**MSource** (Mangayomi - `lib/Services/Mangayomi/Models/Source.dart`):
+ `sourceCode` (full Dart/JS source), `sourceCodeUrl`, `headers`, `sourceCodeLanguage` (dart/javascript/lnreader)

**SSource** (Sora - `lib/Services/Sora/Models/Source.dart`):
+ `sourceCode`, `sourceCodeUrl`

**CloudStreamSource** (`lib/Services/CloudStream/Models/CloudStreamSource.dart`):
+ `internalName`, `pluginUrl`, `jarUrl`, `hasSettings`

**KotatsuSource** (`lib/Services/Kotatsu/Models/Source.dart`):
+ `jarName`, `pkgName`

### 3.4 Extension Preferences

Per-source preferences are **not stored locally** — they are retrieved from the extension itself at runtime via `SourceMethods.getPreference()`. For Aniyomi/CloudStream/Kotatsu, preferences come from the Android/bridge runtime. For Sora/Mangayomi, they are defined in the extension source code.

When preferences are saved, they go through `SourceMethods.setPreference()` which calls the runtime bridge (Android: MethodChannel, Desktop: Sidecar/JNI bridge).

### 3.5 No Migration Files

Isar handles schema migrations automatically. No manual migration files exist.

---

## 4. Extension Loading (Desktop/Non-Android)

### 4.1 Architecture Overview

```
Desktop Flutter App
  └─ BridgeDispatcher
       ├─ JniBridge (JNI direct call via jnigen) [mode: jni]
       └─ SidecarBridge (subprocess JVM via stdin/stdout JSON) [mode: sidecar, DEFAULT]
            │
            ▼ Process.start()
      java -jar anymex_desktop_runtime.jar
```

### 4.2 BridgeDispatcher
File: `lib/Runtime/Bridge/BridgeDispatcher.dart`

Two modes:
- **`BridgeType.jni`**: Uses `JniBridge` for direct JNI calls (requires JVM lib loaded in-process)
- **`BridgeType.sidecar`** (default): Spawns a Java subprocess and communicates via stdin/stdout JSON

The mode is stored in `ExtensionManager.bridgeType` (GetX observable).

### 4.3 SidecarBridge Protocol
File: `lib/Runtime/Bridge/SidecarBridge.dart`

**Request format** (JSON on stdin, newline-delimited):
```json
{"method": "loadExtensions", "args": {"folderPath": "/path/to/ext"}, "id": "123"}
```

**Response format** (JSON on stdout, newline-delimited):
```json
{"id": "123", "status": "ok", "data": [...]}
```

- Requests are matched by `id` (falls back to auto-increment)
- Stream responses use `status: "ok"` (data chunks), `status: "completed"`, `status: "error"`
- Default timeout: 60 seconds
- Cancellation: `{"method": "cancel", "args": {"id": "123"}}`

### 4.4 Sidecar Process Startup
```bash
java -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 \
     -Dsun.stderr.encoding=UTF-8 -Xms128m -Xmx512m -noverify \
     -jar /path/to/anymex_desktop_runtime.jar
```

Startup detected by: stderr line containing `"AnymeX Sidecar Process Started"`

### 4.5 Desktop Extension Install Flow

1. APK downloaded from repo
2. `BridgeDispatcher().invokeMethod('convertApk', {apkPath, outJarPath})` → sidecar converts APK to JAR using embedded dex2jar
3. JAR saved to `{runtimeDir}/Extensions/Aniyomi/{pkgName}.jar`
4. `BridgeDispatcher().invokeMethod('loadExtensions', {folderPath})` → sidecar scans directory and loads all JARs

### 4.6 Desktop vs Android Differences

| Aspect | Android | Desktop |
|---|---|---|
| Runtime bridge | APK loaded via `DexClassLoader` (`MethodChannel('anymeXBridge')`) | JAR launched as subprocess (`SidecarBridge`) or JNI (`JniBridge`) |
| MethodChannel | `aniyomiExtensionBridge`, `cloudstreamExtensionBridge`, `kotatsuExtensionBridge` | `BridgeDispatcher` (sidecar stdin/stdout or JNI) |
| Aniyomi install | System package manager OR internal APK dir | APK→JAR conversion, stored in Extensions dir |
| CloudStream plugins | `.cs3` loaded from app data dir | Same `.cs3` loading via sidecar |
| Kotatsu plugins | `plugin.jar` loaded via MethodChannel | Same JAR loading via sidecar |
| Cookie/UA handling | `MethodChannel('anymeXBridge')` | `BridgeDispatcher` |

### 4.7 Key Files

- `lib/Runtime/Bridge/BridgeDispatcher.dart` — Bridge mode selector
- `lib/Runtime/Bridge/SidecarBridge.dart` — Subprocess JVM communication
- `lib/Runtime/Bridge/JniBridge.dart` — JNI direct calls
- `lib/Runtime/RuntimePaths.dart` — Paths: `{docsDir}/AnymeX/Tools/` (Windows) or `Runtime/` (others)
- `lib/Runtime/RuntimeDownloader.dart` — Downloads `anymex_desktop_runtime.jar` + JRE 17 + dex2jar
- `lib/Runtime/DesktopExtensionBase.dart` — Base class for desktop extensions
- `proxy-method/RuntimeBridge.kt` — Android-side Kotlin bridge (894 lines)

---

## 5. Extension Types & Formats

### 5.1 Extension Manager Registration

File: `lib/ExtensionManager.dart` lines 48-103

```
_initDefaultManagers() →  [SoraExtensions, MangayomiExtensions]  (always, no plugin needed)

onRuntimeBridgeInitialization() → (if bridge loaded)
  Android: [AniyomiExtensions, CloudStreamExtensions, KotatsuExtensions]
  Desktop: [DesktopAniyomiExtensions, DesktopCloudStreamExtensions, DesktopKotatsuExtensions]
  iOS: [RemoteAniyomiExtensions, RemoteCloudStreamExtensions, RemoteKotatsuExtensions] (if server URL configured)
```

### 5.2 Extension Type Matrix

| Manager | ID | Anime | Manga | Novel | Requires Plugin | File Format | Runtime |
|---|---|---|---|---|---|---|
| Aniyomi | `aniyomi` | ✓ | ✓ | ✗ | Yes (Android) | `.apk` | Android DexClassLoader / Desktop Sidecar |
| Aniyomi Desktop | `aniyomi-desktop` | ✓ | ✓ | ✗ | Yes | `.jar` (converted APK) | Sidecar/JNI |
| CloudStream | `cloudstream` | ✓ | ✗ | ✗ | Yes | `.cs3` | Android MethodChannel / Desktop Sidecar |
| CloudStream Desktop | `cloudstream-desktop` | ✓ | ✗ | ✗ | Yes | `.cs3` | Sidecar |
| Kotatsu | `kotatsu` | ✗ | ✓ | ✗ | Yes | `.jar` | Android MethodChannel / Desktop Sidecar |
| Kotatsu Desktop | `kotatsu-desktop` | ✗ | ✓ | ✗ | Yes | `.jar` | Sidecar |
| Sora | `sora` | ✓ | ✓ | ✓ | No | JS/Dart source | In-app JS/Dart engine |
| Mangayomi | `mangayomi` | ✓ | ✓ | ✓ | No | Dart/JS source | In-app Dart eval engine |
| Aniyomi Remote | `aniyomi-remote` | ✓ | ✓ | ✗ | No | N/A (server) | HTTP to JVM Bridge Server |
| CloudStream Remote | `cloudstream-remote` | ✓ | ✗ | ✗ | No | N/A (server) | HTTP to JVM Bridge Server |
| Kotatsu Remote | `kotatsu-remote` | ✗ | ✓ | ✗ | No | N/A (server) | HTTP to JVM Bridge Server |

### 5.3 Source Resolution

File: `lib/ExtensionManager.dart` lines 379-401

`getSourceManager(source)` resolves which manager handles a source via `is` type checks:
- `ASource` → `aniyomi` || `aniyomi-desktop` || `aniyomi-remote`
- `MSource` → `mangayomi`
- `SSource` → `sora`
- `CloudStreamSource` → `cloudstream` || `cloudstream-desktop` || `cloudstream-remote`
- `KotatsuSource` → `kotatsu` || `kotatsu-desktop` || `kotatsu-remote`

### 5.4 SourceMethods Interface

File: `lib/Extensions/SourceMethods.dart`

All source methods implementations must implement:
- `getPopular(int page)`, `getLatestUpdates(int page)`, `search(query, page, filters)`, `getDetail(media)`, `getPageList(episode)`, `getVideoList(episode)`
- `getFilterList()`, `getPreference()`, `setPreference(pref, value)`, `cancelRequest(token)`
- Optional: `getVideoListStream()`, `getNovelContent()`, `stopHttpServer()`

---

## 6. User Data

### 6.1 Extension-Related User Data Storage

All stored in Isar `KvEntry` or `KeyValue` collections:

**Repos** (per manager per type):
- `aniyomiAnimeRepos`, `aniyomiMangaRepos` → `List<String>` of JSON `Repo`
- `cloudstreamAnimeRepos` → `List<String>` of JSON `Repo`
- `kotatsuMangaRepos` → `List<String>` of JSON `Repo`
- `mangayomi{Anime|Manga|Novel}Repos` → `List<String>` of JSON `Repo`
- `sora{Anime|Manga|Novel}Repos` → `List<String>` of JSON `Repo`

**Installed Extensions** (only Sora/Mangayomi persist full lists):
- `sora-Installed-{type}` → `List<String>` of JSON `SSource` (includes `sourceCode`!)
- `mangayomi-Installed-{type}` → `List<String>` of JSON `MSource` (includes `sourceCode`!)

**CloudStream Metadata** (per plugin):
- `cs_meta_{normalizedInternalName}` → JSON `{iconUrl, language, version, versionLast, pluginUrl, repo}`

**Kotatsu Active Sources**:
- `kotatsu_active_sources` → `List<String>` of source IDs

**Desktop Aniyomi** (per package):
- `desktop_ext_icon_{pkgName}` → icon URL string
- `desktop_ext_version_{pkgName}` → version string

**Runtime Bridge**:
- `runtime_host_path` → APK/JAR path
- `runtime_host_installed_version` → version string
- `runtime_host_installed_release_title` → release title
- `remote_bridge_server_url` → server URL (iOS only)

**Aniyomi Manager Settings**:
- `use_internal_anime_extension_loading` → bool
- `use_internal_manga_extension_loading` → bool
- `custom_anime_apk_path` → string
- `custom_manga_apk_path` → string

### 6.2 App-Level User Data (AnymeX Main App)

File: `lib/database/data_keys/keys.dart`

Key enums for settings:
- `SourceKeys`: `activeAnimeRepo`, `activeMangaRepo`, `activeNovelRepo`, `extensionsServiceAllowed`, `activeSourceId`, `animeExtensionOrder`, etc.
- `AuthKeys`: `authToken` (AniList), `malAuthToken`, `simklAuthToken`, etc.
- `PluginKeys`: `runtimeHostInstalledVersion`, `bridgeMode`, `useInternalExtensionLoading`
- `General`, `ThemeKeys`, `PlayerKeys`, `ReaderKeys`, `DownloadKeys`, etc.

### 6.3 User Authentication

No custom auth system. The app delegates to external services:
- **AniList** (OAuth) — `AuthKeys.authToken`
- **MyAnimeList** — `AuthKeys.malAuthToken`, `AuthKeys.malRefreshToken`
- **Simkl** — `AuthKeys.simklAuthToken`
- **Discord** (RPC only, no login) — `discord_rpcEnabled`
- **Gist Sync** (GitHub Gist) — `SyncKeys.gistGithubToken`, `SyncKeys.gistGithubUsername`

### 6.4 Per-Source Preferences

Per-source preferences are NOT stored in the local database. They are:
1. Retrieved from the extension at runtime via `getPreference()`
2. Saved back via `setPreference()` which calls the native bridge (Android: SharedPreferences via MethodChannel, Desktop: sidecar/JNI, Remote: HTTP to server)
3. On the server side (Task 1 JVM Bridge Server), preferences are stored in-memory `ConcurrentHashMap`

### 6.5 Backup/Restore

File: `lib/controllers/services/backup_restore/backup_restore_service.dart`

The app has a backup/restore system (via `lib/screens/settings/sub_settings/settings_backup.dart`). Extension-related data (installed Mangayomi/Sora source code, repo lists) would be backed up as part of the Isar database export.

### 6.6 Directory Structure on Disk

```
{documentsDir}/AnymeX/
├── AnymeX.isar                  # Main Isar database
├── isar/                        # Bridge plugin Isar database (KvEntry)
├── cloudstream_plugins/         # .cs3 plugin files
├── kotatsu_plugins/              # plugin.jar
├── Tools/  (Windows)
│   ├── anymex_desktop_runtime.jar
│   ├── jre/                       # Adoptium JRE 17
│   └── dex-tools-v2.4/
├── Runtime/  (macOS/Linux)
│   ├── anymex_runtime_host.apk    # (Android path on non-Android is unused)
│   ├── anymex_desktop_runtime.jar
│   ├── jre/
│   └── Extensions/
│       └── Aniyomi/               # Converted .jar files
└── webview/                      # WebView user data (Windows)
```
