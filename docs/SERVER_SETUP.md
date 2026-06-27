# Server Setup

How to deploy and run the AnymeX Bridge server on a Linux host.

---

## 1. Prerequisites

| Requirement | Version | Check |
|---|---|---|
| **Bun** | ≥ 1.0 | `bun --version` |
| **Java JDK** | 17+ | `java -version` |
| **curl** | any | `curl --version` |
| **unzip** | any | `unzip -v` |
| **bash** | any (for dex2jar scripts) | `bash --version` |

### Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

### Install Java 17

```bash
# Ubuntu / Debian
sudo apt install -y openjdk-17-jre-headless

# Or use SDKMAN for version management
curl -s "https://get.sdkman.io" | bash
sdk install java 17.0.10-tem
```

### Verify

```bash
java -version    # must show 17 or higher
bun --version    # must show 1.0 or higher
```

---

## 2. Get the code

```bash
git clone https://github.com/<your-username>/anymex-bridge.git
cd anymex-bridge
bun install
```

This installs the only runtime dependency: `ssh2`.

---

## 3. First run

```bash
bun run dev
```

You should see:

```text
============================================================
  AnymeX Extension Runtime Bridge — Remote Server
============================================================
  Port:       3022
  JAR path:   /home/z/anymex-bridge/data/bridge.jar
  JAR present: false
============================================================

[ssh] AnymeX Bridge listening on 0.0.0.0:3022
[ssh] host key: /home/z/anymex-bridge/data/host-keys/ed25519
[updater] polling GitHub releases...
[updater] downloading anymex_desktop_runtime.jar (23563465 bytes) from ...
[updater] downloaded data/bridge.jar.new (23563465 bytes)
[jar-runner] hot-swapping bridge.jar.new → bridge.jar
[updater] hot-swapped to v1.8.2
```

The server:
1. Generates an ed25519 SSH host key (`data/host-keys/ed25519`) — first run only.
2. Listens on **port 3022**.
3. Downloads `anymex_desktop_runtime.jar` (~23MB) from the latest GitHub release of `RyanYuuki/AnymeXExtensionRuntimeBridge`.
4. The JAR is started lazily on the first `invoke` request (not at boot).

---

## 4. Configuration

The server has **no config file** — all settings are constants in `index.ts` and `src/`. To change them, edit the file and restart.

### Port

```typescript
// index.ts
const PORT = 3022;
```

### JAR source

```typescript
// src/auto-updater.ts
const GITHUB_REPO = 'RyanYuuki/AnymeXExtensionRuntimeBridge';
const POLL_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const JAR_ASSET_NAME = 'anymex_desktop_runtime.jar';
```

### Java binary

If `java` isn't on PATH, set the env var:

```bash
export JAVA_BIN=/usr/lib/jvm/java-17-openjdk-amd64/bin/java
bun run dev
```

### JVM heap size (IMPORTANT for small / shared VPS)

The bridge launches a single shared JVM that runs the AnymeX runtime JAR.
By default the JVM is capped at **`-Xmx384m`** so it can't OOM a small or
shared box (e.g. a 1.9 GB VPS already running Supabase + Next.js + nginx).

To override on hosts with more free RAM:

```bash
# 512 MB heap (for ~3 GB+ hosts with light other load)
export ANYMEX_JVM_HEAP=512m
# 1 GB heap (recommended for dedicated 4 GB+ hosts)
export ANYMEX_JVM_HEAP=1g
# 2 GB heap (only on dedicated 8 GB+ hosts with heavy concurrent use)
export ANYMEX_JVM_HEAP=2g
bun run dev
```

Rule of thumb: leave at least **1 GB free** for Bun + the OS + dex2jar
spikes. Don't set `ANYMEX_JVM_HEAP` higher than ~50% of total RAM.

### Repo cache TTL

```typescript
// src/repo-indexer.ts
const REPO_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours
```

---

## 5. Running in production

### Option A: systemd service (recommended)

Create `/etc/systemd/system/anymex-bridge.service`:

```ini
[Unit]
Description=AnymeX Extension Runtime Bridge
After=network.target

[Service]
Type=simple
User=anymex
WorkingDirectory=/home/anymex/anymex-bridge
ExecStart=/home/anymex/.bun/bin/bun run start
Restart=on-failure
RestartSec=5
Environment=JAVA_BIN=/usr/lib/jvm/java-17-openjdk-amd64/bin/java
Environment=ANYMEX_JVM_HEAP=384m

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable anymex-bridge
sudo systemctl start anymex-bridge
sudo systemctl status anymex-bridge
```

View logs:

```bash
sudo journalctl -u anymex-bridge -f
```

### Option B: pm2

```bash
npm install -g pm2
pm2 start "bun run start" --name anymex-bridge
pm2 save
pm2 startup
```

### Option C: nohup (quick test)

```bash
nohup bun run start > server.log 2>&1 &
disown
tail -f server.log
```

---

## 6. Firewall

Open port 3022 (SSH):

```bash
# UFW (Ubuntu)
sudo ufw allow 3022/tcp
sudo ufw reload

# Or restrict to specific IPs
sudo ufw allow from 203.0.113.0/24 to any port 3022
```

**Do NOT expose port 3022 to the entire internet** without an SSH-key allow-list (see Security below).

---

## 7. JAR auto-update

The auto-updater polls GitHub Releases every 1 hour. When a new version is found:

1. Downloads the new JAR to `data/bridge.jar.new`
2. Atomically renames `bridge.jar.new` → `bridge.jar`
3. Kills the old JVM subprocess
4. Spawns a new JVM with the new JAR
5. The new JVM re-reads `data/exts-jar*/` on the next `loadExtensions` call

In-flight requests during the hot-swap get an error — the iOS client should retry.

To force an update check:

```bash
rm data/bridge.jar data/updater-state.json
bun run dev
# updater will re-download on next poll
```

To pin a specific JAR version (skip auto-update), comment out `startUpdater()` in `index.ts`.

---

## 8. Data directory

Everything the server creates lives under `data/`:

```text
data/
├── bridge.jar                 # the runtime JAR (auto-downloaded, ~23MB)
├── users.sqlite               # per-user config DB
├── host-keys/
│   └── ed25519                # SSH host key (generate once, keep secret)
├── exts/                      # downloaded .apk / .cs3 files (content-addressed)
├── exts-jar/                  # converted Aniyomi .jar files
├── exts-jar-cs/               # CloudStream .jar files (repackaged)
├── exts-jar-kotatsu/
│   └── plugin.jar             # the single Kotatsu multi-source jar
├── repos/                     # cached repo index.json files (6h TTL)
├── tools/
│   └── dex-tools-v2.4/       # dex2jar (downloaded once, ~20MB)
├── tmp/                       # temp download scratch
└── updater-state.json         # last-known JAR version + last poll time
```

### Backup

Only these need backing up:
- `data/users.sqlite` — user configs (small, ~KB)
- `data/host-keys/ed25519` — SSH host key (keep secret!)

The rest (`bridge.jar`, `exts/`, `tools/`) can be re-downloaded automatically.

### Disk usage

| Component | Size |
|---|---|
| `bridge.jar` | ~23 MB |
| `dex-tools` | ~20 MB (one-time) |
| Per Aniyomi extension (.apk + .jar) | ~200-400 KB |
| Per CloudStream extension (.jar) | ~50-200 KB |
| Kotatsu jar | ~1.5 MB |
| Repo cache | ~1 MB per 1000 extensions |

Budget ~50 MB per 100 installed extensions.

---

## 9. Logs

The server logs to stdout. With systemd, logs go to journald:

```bash
# Live tail
sudo journalctl -u anymex-bridge -f

# Last 100 lines
sudo journalctl -u anymex-bridge -n 100

# Since 1 hour ago
sudo journalctl -u anymex-bridge --since "1 hour ago"
```

Log levels (all currently go to stdout):
- `[ssh]` — SSH server events (connect, disconnect, auth)
- `[router]` — request routing (install, invoke, errors)
- `[repo-indexer]` — repo fetch + cache events
- `[jar-runner]` — JVM lifecycle (start, hot-swap, crash)
- `[updater]` — GitHub release polling
- `[ext-loader]` — JAR loadExtensions results
- `[health]` — periodic health check (every 5 min)

---

## 10. Security hardening (production)

### SSH key allow-list

By default, **any** SSH key is accepted (BYO-key model). To restrict to known keys, edit `src/ssh-server.ts`:

```typescript
const ALLOWED_FINGERPRINTS = new Set([
  'sha256:AAAAB3NzaC1...',  // user A's key fingerprint
  'sha256:BBBBA2NzaC1...',  // user B's key fingerprint
]);

// In the authenticate handler:
if (!ALLOWED_FINGERPRINTS.has(fingerprint)) {
  return ctx.reject();
}
```

### Reverse proxy + TLS termination

If you want TLS, put Caddy/nginx in front:

```caddyfile
# Caddyfile
bridge.example.com {
  reverse_proxy localhost:3022
}
```

But note: the iOS client uses raw SSH, not HTTPS. For SSH-over-HTTPS tunneling, you'd need `sslh` or similar — out of scope for this doc.

### Rate limiting

Not implemented. For production, add per-user rate limits in `request-router.ts` (e.g. max 10 invokes/minute).

### Resource limits

With systemd:

```ini
[Service]
MemoryMax=2G
CPUQuota=200%
TasksMax=100
```

---

## 11. Upgrading the server code

```bash
cd /home/anymex/anymex-bridge
git pull
bun install
sudo systemctl restart anymex-bridge
```

The `data/` directory is preserved across upgrades. The JAR will hot-swap if a newer GitHub release exists.

---

## 12. Troubleshooting

### Server won't start

```bash
# Check if port 3022 is already in use
sudo lsof -i :3022

# Check Java
java -version

# Check Bun
bun --version
```

### JAR won't download (GitHub rate limit)

```text
[updater] GitHub releases HTTP 403 (rate-limited?)
```

GitHub allows 60 unauthenticated requests/hour per IP. The updater retries next hour. To fix immediately, download the JAR manually:

```bash
# Get the latest release URL from:
# https://api.github.com/repos/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest
curl -L -o data/bridge.jar <download_url>
bun run dev
```

### dex2jar fails

```text
[router] dex2jar conversion failed for <extId>: ...
```

Usually a corrupted .apk download. Delete and retry:

```bash
rm -rf data/exts/<hash>* data/exts-jar/<pkg>.jar
# Re-install via the iOS client
```

### Extension returns empty results

Usually a site issue (geo-blocked, Cloudflare, down) — **not** a bridge bug. Check the extension's baseUrl in a browser.

### Kotatsu returns 0 sources

The Kotatsu jar must be named exactly `plugin.jar`:

```bash
ls -la data/exts-jar-kotatsu/
# Must show: plugin.jar
```

If it has a different name, delete it and re-add the repo:

```bash
rm data/exts-jar-kotatsu/*.jar
rm data/exts-jar-kotatsu/kotatsu_extensions_cache.json
# Re-add via the iOS client
```

---

## 13. Sizing reference

| Users | CPU | RAM | Disk | Monthly cost |
|---|---|---|---|---|
| ≤ 50 | 2 vCPU | 4 GB | 20 GB | $10-15 |
| 50-500 | 4 vCPU | 8 GB | 40 GB | $25-40 |
| 500-5000 | 8 vCPU | 16 GB | 80 GB | $60-90 |

**Sweet spot:** Hetzner CPX31 (~$18/mo, 4 vCPU / 8GB RAM) handles ~200 concurrent users comfortably. The JVM is the main memory consumer (~1-2GB resident); each SSH connection adds ~5MB.
