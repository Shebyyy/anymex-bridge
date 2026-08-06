# AnymeX Bridge Server — Worklog

---
Task ID: 1
Agent: main
Task: Rebuild bridge mini-service from scratch (lost from previous session)

Work Log:
- Created `/home/z/my-project/bridge/` with 6 files: package.json, db.ts, jar.ts, repos.ts, extensions.ts, ssh.ts, index.ts
- Read SidecarBridge.dart source to understand exact protocol
- JAR downloads from `https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest/download/anymex_desktop_runtime.jar` (41.9MB)
- Implemented persistent Sidecar process (matches Dart SidecarBridge.dart): single JAR process, stdin/stdout JSON lines, startup signal detection
- Added one-shot fallback (invokeJarOnce) for when sidecar isn't running
- SSH server on port 3022 with RSA 2048 host key, username/password auth, SidecarBridge JSON protocol over exec channels
- HTTP server on port 8081 with /health, /register, /addRepo, /installExtension, /data endpoints
- User-based repos (user_repos join table) and extensions (user_extensions join table)
- Added yuzono/anime-repo (255 extensions) and keiyoushi/extensions (auto-resolved .pb → .min.json, 2 extensions)
- Fixed bridge-db.ts DB path from mini-services/data to bridge/data

Stage Summary:
- Bridge running on ports 3022 (SSH) + 8081 (HTTP)
- JAR downloaded and sidecar process started successfully
- 1 user, 2 repos, 257 extensions in database
- Dashboard reads from bridge/data/bridge.db via better-sqlite3
