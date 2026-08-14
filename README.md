# AnymeX Bridge Server v2

Server-side bridge for [AnymeX](https://github.com/Syairex/AnymeX) desktop extension runtime.
Handles authentication, extension install/uninstall, and JAR sidecar management.

## Architecture

```
Dart Client (KvStore repos)  →  SSH/HTTP  →  Bridge Server  →  Java JAR Sidecar
                                      │
                                  SQLite DB
                                  (users + installs)
```

- **Client side**: Repos, extension lists, and source selection live in the Dart app's KvStore
- **Server side**: Auth, APK→JAR conversion, install tracking, and JAR sidecar proxy
- **v2 change**: No more server-side repos/extensions tables — the server only tracks what each user has installed

## Requirements

- [Bun](https://bun.sh/) runtime
- Java 8+ (for JAR sidecar)

## Setup

```bash
bun install
bun run start          # foreground
bun run start:daemon   # background (nohup)
bun run dev           # dev with --hot reload
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_KEY` | `anymex-admin-2024` | Key to access the admin panel |

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| `3022` | SSH | Client ↔ Server RPC (primary) |
| `8082` | HTTP | Registration, login, admin panel |

## Database Schema (SQLite)

### `users`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `username` | TEXT UNIQUE | Login username |
| `password` | TEXT | Plaintext password |
| `created` | TEXT | ISO timestamp |

### `user_installed`
| Column | Type | Description |
|--------|------|-------------|
| `user_id` | TEXT FK | References `users.id` |
| `pkg_name` | TEXT | Extension package name |
| `type` | TEXT | `aniyomi` / `cloudstream` / `kotatsu` |
| `name` | TEXT | Display name |
| `icon_url` | TEXT | Extension icon |
| `version` | TEXT | Extension version |
| PK | `(user_id, pkg_name)` | |

## API Endpoints

### Public

#### `POST /register`
Create a new user account.

```json
// Request
{ "username": "myuser", "password": "mypass" }

// Response
{ "ok": true, "user": { "id": "uuid", "username": "myuser" } }
```

#### `POST /login`
Authenticate and get user info.

```json
// Request
{ "username": "myuser", "password": "mypass" }

// Response
{ "ok": true, "user": { "id": "uuid", "username": "myuser" } }
```

#### `POST /rpc`
JSON-RPC endpoint (alternative to SSH). All methods from the SSH RPC below are supported.

```json
// Request
{
  "username": "myuser",
  "password": "mypass",
  "method": "loadExtensions",
  "args": {},
  "id": "1"
}

// Response
{ "id": "1", "status": "ok", "data": [...] }
```

#### `GET /health`
Server health check.

```json
{ "users": 5, "installs": 23, "jarReady": true }
```

### Admin (Bearer token required)

#### `POST /admin/login`
```json
// Request
{ "key": "anymex-admin-2024" }

// Response
{ "ok": true, "token": "uuid" }
```

#### `GET /admin/stats`
User list with install counts.

#### `GET /admin/users`
All registered users.

#### `POST /admin/createUser`
```json
{ "username": "newuser", "password": "pass123" }
```

#### `GET /admin/user/:id`
User detail with installed extensions.

#### `DELETE /admin/user/:id`
Delete a user and their install records.

#### `GET /admin/jarStatus`
JAR sidecar status and file size.

#### `POST /admin/forceUpdate`
Trigger an immediate JAR update check (stop sidecar → download → restart).

#### `GET /admin`
Serves the admin HTML panel.

## SSH RPC Methods

Clients send JSON over SSH exec channel:

```json
{ "method": "methodName", "args": { ... }, "id": "1" }
```

### Extension Methods

| Method | Args | Description |
|--------|------|-------------|
| `installExtension` | `{ url, pkgName, type?, name?, iconUrl?, version? }` | Download APK/CS3/JAR, convert if needed, track in DB. Shared storage — only downloads once. |
| `uninstallExtension` | `{ pkgName, type? }` | Remove user's install record. Deletes JAR file only if no other user has it. |
| `loadExtensions` | `{}` | Load all Aniyomi extensions from JAR sidecar, filtered to user's installed packages. |
| `csLoadExtensions` | `{}` | Same but for CloudStream extensions. |
| `kotatsuLoadExtensions` | `{}` | Load Kotatsu extensions. |
| `ensureKotatsuJar` | `{ url }` | Download Kotatsu plugin.jar (only if not already present). |

### Utility Methods

| Method | Args | Description |
|--------|------|-------------|
| `health` | `{}` | Returns `{ status, user, jarReady }`. |
| `forceUpdate` | `{}` | Trigger JAR update from client. |
| `*` | `{ ... }` | Any other method is forwarded directly to the JAR sidecar (source-specific methods like `getSources`, `getSourcesList`, etc.). |

## File Structure

```
bridge/
├── index.ts          # Entry point — starts servers, JAR, auto-update
├── ssh.ts            # SSH + HTTP server, RPC method router, install/uninstall logic
├── jar.ts            # JAR download, persistent sidecar process, method invocation
├── db.ts             # SQLite schema + user/install queries
├── auto-update.ts    # Periodic JAR auto-update (size check, sidecar restart)
├── admin.html        # Web admin panel
├── start.sh          # Production start script
├── package.json
└── jar-cache/        # Downloaded JAR file (gitignored)
└── data/             # SQLite DB + SSH host key (gitignored)
```

## JAR Auto-Update

The server periodically checks for JAR updates every 6 hours:

1. **HEAD request** to GitHub releases to get `content-length`
2. Compare with local file size — skip if identical
3. If different: stop sidecar → download new JAR → restart sidecar

First check runs 2 minutes after startup (lets server stabilize). Admin can also trigger via `POST /admin/forceUpdate` or client via `forceUpdate` RPC method.

## Deployment

See `.github/workflows/deploy.yml` for the CI/CD pipeline.
