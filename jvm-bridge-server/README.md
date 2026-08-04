# AnymeX JVM Bridge Server

A headless JVM application that allows iOS devices to execute Aniyomi, CloudStream, and Kotatsu extensions remotely via HTTP API. Since iOS cannot use Android's `DexClassLoader` natively, this server bridges the gap by loading extensions on a JVM runtime and exposing their functionality as REST endpoints.

## Architecture

```
┌──────────────┐         HTTP/JSON          ┌─────────────────────────┐
│  iOS Client  │ ◄────────────────────────► │   JVM Bridge Server    │
│  (AnymeX)    │   REST API Endpoints       │                         │
│              │                            │  ┌───────────────────┐  │
│  Flutter App │   POST /api/aniyomi/*      │  │ AniyomiLoader     │  │
│              │   POST /api/cloudstream/*   │  │ (DEX → JAR)       │  │
│              │   POST /api/kotatsu/*      │  └───────────────────┘  │
│              │   GET  /api/proxy/image     │  ┌───────────────────┐  │
│              │   GET  /api/health          │  │ CloudStreamLoader │  │
└──────────────┘                            │  │ (.cs3 → JAR)      │  │
                                           │  └───────────────────┘  │
                                           │  ┌───────────────────┐  │
                                           │  │ KotatsuLoader     │  │
                                           │  │ (.jar → URLClass) │  │
                                           │  └───────────────────┘  │
                                           │  ┌───────────────────┐  │
                                           │  │ ExtensionCache   │  │
                                           │  │ (Disk Storage)    │  │
                                           │  └───────────────────┘  │
                                           └─────────────────────────┘
```

## Extension Loading Strategy

| Extension Type | File Format | Loading Method |
|---|---|---|
| **Aniyomi** | `.apk` | Extract DEX via dexlib2 → Convert to JAR → URLClassLoader |
| **CloudStream** | `.cs3` | Direct URLClassLoader (cs3 files are JARs) |
| **Kotatsu** | `.jar` | Direct URLClassLoader (standard JAR files) |

## API Endpoints

### Health
- `GET /api/health` — Server status, JVM info, loaded extension count

### Aniyomi
- `POST /api/aniyomi/install` — Download & cache an extension APK
- `POST /api/aniyomi/uninstall` — Remove a cached extension
- `GET /api/aniyomi/extensions` — List installed extensions with metadata
- `POST /api/aniyomi/search` — Search media via a source
- `POST /api/aniyomi/popular` — Get popular/trending media
- `POST /api/aniyomi/latest` — Get latest updates
- `POST /api/aniyomi/detail` — Get media details
- `POST /api/aniyomi/video-list` — Get video URLs for an episode
- `POST /api/aniyomi/page-list` — Get page URLs for a chapter
- `POST /api/aniyomi/filter-list` — Get available filters
- `POST /api/aniyomi/preference` — Get source preferences
- `POST /api/aniyomi/save-preference` — Save a preference value

### CloudStream
- `POST /api/cloudstream/install` — Download & cache a .cs3 plugin
- `POST /api/cloudstream/uninstall` — Remove a cached plugin
- `GET /api/cloudstream/providers` — List installed providers
- `POST /api/cloudstream/search` — Search content via a provider
- `POST /api/cloudstream/detail` — Get content details
- `POST /api/cloudstream/video-list` — Get video sources

### Kotatsu
- `POST /api/kotatsu/install` — Download & cache a .jar extension
- `POST /api/kotatsu/uninstall` — Remove a cached extension
- `GET /api/kotatsu/extensions` — List installed extensions
- `POST /api/kotatsu/search` — Search manga via a source
- `POST /api/kotatsu/popular` — Get popular manga
- `POST /api/kotatsu/latest` — Get latest manga updates
- `POST /api/kotatsu/detail` — Get manga details
- `POST /api/kotatsu/page-list` — Get page URLs for a chapter

### Image Proxy
- `GET /api/proxy/image?sourceId=xxx&imageUrl=xxx&pageUrl=xxx&pageNumber=1`

## Response Format

All responses follow a consistent envelope:

```json
{
  "success": true,
  "data": { ... },
  "error": null
}
```

## Quick Start

### Docker (Recommended)

```bash
# Build
docker build -t anymex-bridge-server .

# Run
docker run -p 8080:8080 anymex-bridge-server

# With custom configuration
docker run -p 9090:9090 \
  -e BRIDGE_PORT=9090 \
  -e BRIDGE_CACHE_DIR=/data/extensions \
  -e BRIDGE_LOG_LEVEL=DEBUG \
  -v bridge-data:/data/extensions \
  anymex-bridge-server
```

### Local Build

```bash
# Prerequisites: JDK 17+

# Build the fat JAR
./gradlew shadowJar

# Run
java -jar build/libs/jvm-bridge-server-1.0.0.jar

# With custom port
BRIDGE_PORT=9090 java -jar build/libs/jvm-bridge-server-1.0.0.jar
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `BRIDGE_PORT` | `8080` | HTTP server port |
| `BRIDGE_HOST` | `0.0.0.0` | Bind address |
| `BRIDGE_CACHE_DIR` | `./extensions-cache` | Extension cache directory |
| `BRIDGE_TEMP_DIR` | `./tmp` | Temporary files directory |
| `BRIDGE_MAX_MEMORY_MB` | `512` | Max memory for extension loading |
| `BRIDGE_LOG_LEVEL` | `INFO` | Log verbosity (TRACE/DEBUG/INFO/WARN/ERROR) |
| `BRIDGE_CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |

## Example Requests

### Install an Aniyomi Extension
```bash
curl -X POST http://localhost:8080/api/aniyomi/install \
  -H "Content-Type: application/json" \
  -d '{
    "downloadUrl": "https://github.com/user/aniyomi-extensions/releases/download/v1.0/extension.apk",
    "pkgName": "com.example.animeprovider",
    "repoUrl": "https://github.com/user/repo"
  }'
```

### Search for Anime
```bash
curl -X POST http://localhost:8080/api/aniyomi/search \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "com.example.animeprovider",
    "isAnime": true,
    "query": "Naruto",
    "page": 1
  }'
```

### Proxy a Manga Page Image
```bash
curl "http://localhost:8080/api/proxy/image?sourceId=com.example.mangasource&imageUrl=https://cdn.example.com/page1.jpg&pageUrl=https://manga.example.com/chapter/1"
```

## Project Structure

```
jvm-bridge-server/
├── build.gradle.kts                          # Gradle build configuration
├── settings.gradle.kts                        # Project settings
├── gradle.properties                          # Gradle properties
├── gradle/
│   ├── libs.versions.toml                    # Dependency version catalog
│   └── wrapper/gradle-wrapper.properties      # Gradle wrapper config
├── Dockerfile                                 # Multi-stage Docker build
├── README.md                                  # This file
└── src/main/kotlin/com/anymex/bridge/
    ├── Application.kt                        # Ktor server entry point
    ├── ServerConfig.kt                        # Server configuration
    ├── routes/
    │   ├── AniyomiRoutes.kt                   # Aniyomi REST endpoints
    │   ├── CloudStreamRoutes.kt              # CloudStream REST endpoints
    │   ├── KotatsuRoutes.kt                   # Kotatsu REST endpoints
    │   ├── HealthRoutes.kt                    # Health & status endpoints
    │   └── ImageProxyRoutes.kt               # Image proxy endpoint
    ├── extension/
    │   ├── ExtensionCache.kt                 # Download & cache management
    │   ├── AniyomiExtensionLoader.kt          # APK/DEX loading via dexlib2
    │   ├── CloudStreamPluginLoader.kt          # .cs3 plugin loading
    │   └── KotatsuExtensionLoader.kt          # .jar extension loading
    ├── models/
    │   ├── Requests.kt                        # API request data classes
    │   └── Responses.kt                       # API response data classes
    └── util/
        └── HttpUtil.kt                        # HTTP client utility (OkHttp)
```

## Technology Stack

- **Kotlin 1.9** — Primary language
- **Ktor 2.3** — HTTP server framework (Netty engine)
- **OkHttp 4.12** — HTTP client for outbound requests
- **Gson 2.11** — JSON serialization
- **dexlib2 2.5** — DEX file parsing (Android APK support)
- **SLF4J** — Logging facade
- **Kotlin Coroutines** — Async programming support

## Limitations & Notes

1. **Android API Stubs**: Extensions that depend on Android framework classes (Context, SharedPreferences, Resources) need stub implementations. The server provides basic stubs for common Android APIs.

2. **DEX Conversion**: DEX→JAR conversion is a complex process. For production use, consider pre-converting extensions using a tool like `dex2jar` or `enjarify`.

3. **Memory**: Loading many extensions simultaneously can consume significant JVM heap memory. The `BRIDGE_MAX_MEMORY_MB` setting helps control this.

4. **Thread Safety**: Each extension is loaded in an isolated `URLClassLoader` to prevent class conflicts.

## License

This project is part of the AnymeX Extension Runtime Bridge.
