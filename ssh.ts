import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { authenticateUser, createUser, getAllUsers, getUserById, db, getUserInstalled, addUserInstalled, removeUserInstalled, getUserInstalledPkgs, countOtherUsersWithPkg, banUser, changePassword, editUsername, deleteAllUsers, deleteUserExtensions, deleteExtensionGlobally, getAllInstalledExtensions, getPkgUsers, clearDatabase, recordUserIP, isIPBanned, banAllUserIPs, unbanAllUserIPs, banIP, unbanIP, getAllBannedIPs, getBannedIPCount, getUserIPs, getUsersByIP } from './db.js'
import { isJarReady, invokeJar, invokeJarOnce, getJarPath, startSidecar, stopSidecar, getJarMeta } from './jar.js'
import { runUpdateNow, getNextCheckAt, getIntervalMs } from './auto-update.js'
import { registerLimiter, loginLimiter, adminLoginLimiter, rpcLimiter, globalLimiter } from './rate-limit.js'

const ADMIN_KEY = process.env.ADMIN_KEY || 'anymex-admin-2024'
let adminTokens = new Set<string>()
const EXT_DIR = join(import.meta.dir, 'extensions')
const JAR_CACHE_DIR = join(import.meta.dir, 'jar-cache')
const DATA_DIR = join(import.meta.dir, 'data')
const LOG_FILE = join(DATA_DIR, 'bridge.log')

const SSH_PORT = 3022
const HTTP_PORT = 8082

// ─── HTTP Server (registration + admin) ──────────────────

function checkAdmin(req: any): boolean {
  const auth = req.headers['authorization'] || ''
  const token = auth.replace('Bearer ', '')
  return adminTokens.has(token)
}

/** Extract client IP from request, respecting X-Forwarded-For (reverse proxy) */
function getClientIP(req: any): string {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    return (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',')[0].trim()
  }
  const realIP = req.headers['x-real-ip']
  if (realIP) return realIP
  return req.socket?.remoteAddress || ''
}

/** Format ms to human readable, e.g. "4h 23m" or "12m" or "45s" */
function formatDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function startHttpServer() {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`)

    // ── Global rate limit (all HTTP requests per IP) ──
    const globalIP = getClientIP(req)
    if (globalIP && !globalLimiter.check(globalIP)) {
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'too many requests' }))
      return
    }

    try {
      // ── Serve admin panel ──
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(readFileSync(join(import.meta.dir, 'admin.html'), 'utf-8'))
        return
      }

      res.setHeader('Content-Type', 'application/json')

      // ── Admin login (rate limited) ──
      if (url.pathname === '/admin/login' && req.method === 'POST') {
        const ip = getClientIP(req)
        if (ip && !adminLoginLimiter.check(ip)) {
          res.writeHead(429)
          res.end(JSON.stringify({ ok: false, error: 'too many attempts' }))
          console.log(`[http] Admin login rate-limited: ${ip}`)
          return
        }
        const body = await readBody(req)
        const { key } = JSON.parse(body)
        if (key === ADMIN_KEY) {
          adminLoginLimiter.reset(ip)
          const token = crypto.randomUUID()
          adminTokens.add(token)
          res.end(JSON.stringify({ ok: true, token }))
        } else {
          res.writeHead(401)
          res.end(JSON.stringify({ ok: false, error: 'invalid key' }))
        }
        return
      }

      // ── Admin API (bearer token required) ──
      if (url.pathname.startsWith('/admin/')) {
        if (!checkAdmin(req)) { res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return }

        // ── Stats ──
        if (url.pathname === '/admin/stats' && req.method === 'GET') {
          const users = getAllUsers()
          const userDetails = users.map(u => ({
            id: u.id, username: u.username, banned: !!u.banned,
            extensions: (db.query('SELECT COUNT(*) as c FROM user_installed WHERE user_id = ?').get(u.id) as any)?.c ?? 0
          }))
          const totalInstalls = (db.query('SELECT COUNT(*) as c FROM user_installed').get() as any)?.c ?? 0
          const bannedCount = users.filter(u => u.banned).length
          res.end(JSON.stringify({ users: userDetails, totalUsers: users.length, installs: totalInstalls, jarReady: isJarReady(), bannedCount, bannedIPCount: getBannedIPCount() }))
          return
        }

        // ── List users ──
        if (url.pathname === '/admin/users' && req.method === 'GET') {
          res.end(JSON.stringify(getAllUsers()))
          return
        }

        // ── Create user ──
        if (url.pathname === '/admin/createUser' && req.method === 'POST') {
          const body = await readBody(req)
          const { username, password } = JSON.parse(body)
          res.end(JSON.stringify(createUser(username, password)))
          return
        }

        // ── Ban / unban user (auto-ban/unban all their IPs) ──
        if (url.pathname === '/admin/banUser' && req.method === 'POST') {
          const body = await readBody(req)
          const { userId, banned } = JSON.parse(body)
          banUser(userId, !!banned)
          if (banned) {
            const ips = banAllUserIPs(userId)
            console.log(`[admin] Banned user ${userId} + ${ips.length} IP(s): ${ips.join(', ')}`)
          } else {
            const ips = unbanAllUserIPs(userId)
            console.log(`[admin] Unbanned user ${userId} + ${ips.length} IP(s): ${ips.join(', ')}`)
          }
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Change password ──
        if (url.pathname === '/admin/changePassword' && req.method === 'POST') {
          const body = await readBody(req)
          const { userId, password } = JSON.parse(body)
          if (!password || password.length < 4) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'password min 4 chars' })); return }
          changePassword(userId, password)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Edit username ──
        if (url.pathname === '/admin/editUsername' && req.method === 'POST') {
          const body = await readBody(req)
          const { userId, username } = JSON.parse(body)
          if (!username || username.length < 3) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'username min 3 chars' })); return }
          const result = editUsername(userId, username)
          res.end(JSON.stringify(result))
          return
        }

        // ── GET: user detail ──
        const userDetail = url.pathname.match(/^\/admin\/user\/([\w-]+)$/)
        if (userDetail && req.method === 'GET') {
          const uid = userDetail[1]
          const user = getUserById(uid)
          if (!user) { res.writeHead(404); res.end(JSON.stringify({ error: 'user not found' })); return }
          const installed = getUserInstalled(uid)
          res.end(JSON.stringify({ ...user, installedExtensions: installed }))
          return
        }

        // ── DELETE user ──
        const delUser = url.pathname.match(/^\/admin\/user\/([\w-]+)$/)
        if (delUser && req.method === 'DELETE') {
          const uid = delUser[1]
          db.run('DELETE FROM user_installed WHERE user_id = ?', [uid])
          db.run('DELETE FROM users WHERE id = ?', [uid])
          console.log(`[admin] Deleted user ${uid}`)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Delete all extensions for a user ──
        if (url.pathname === '/admin/userExtensions' && req.method === 'DELETE') {
          const body = await readBody(req)
          const { userId } = JSON.parse(body)
          // Get their packages first to check if JARs should be deleted
          const pkgs = getUserInstalled(userId)
          deleteUserExtensions(userId)
          // Delete JAR files that no other user has
          for (const p of pkgs) {
            if (countOtherUsersWithPkg(userId, p.pkg_name) === 0) {
              const typeFolder = p.type === 'cloudstream' ? 'CloudStream' : p.type === 'kotatsu' ? 'Kotatsu' : 'Aniyomi'
              try { unlinkSync(join(EXT_DIR, typeFolder, `${p.pkg_name}.jar`)) } catch {}
            }
          }
          res.end(JSON.stringify({ ok: true, deleted: pkgs.length }))
          return
        }

        // ── Delete extension globally ──
        const delExt = url.pathname.match(/^\/admin\/extension\/(.+)$/)
        if (delExt && req.method === 'DELETE') {
          const pkgName = decodeURIComponent(delExt[1])
          deleteExtensionGlobally(pkgName)
          // Delete JAR from all type folders
          for (const folder of ['Aniyomi', 'CloudStream', 'Kotatsu']) {
            try { unlinkSync(join(EXT_DIR, folder, `${pkgName}.jar`)) } catch {}
          }
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── View all extensions ──
        if (url.pathname === '/admin/allExtensions' && req.method === 'GET') {
          const extensions = getAllInstalledExtensions()
          // Also list JAR files on disk
          const diskFiles: any[] = []
          for (const folder of ['Aniyomi', 'CloudStream', 'Kotatsu']) {
            const dir = join(EXT_DIR, folder)
            if (!existsSync(dir)) continue
            for (const f of readdirSync(dir)) {
              if (!f.endsWith('.jar')) continue
              const pkgName = f.replace('.jar', '')
              const stat = statSync(join(dir, f))
              diskFiles.push({ pkgName, type: folder.toLowerCase(), folder, size: stat.size, sizeMB: (stat.size / 1024 / 1024).toFixed(2) })
            }
          }
          res.end(JSON.stringify({ extensions, diskFiles }))
          return
        }

        // ── Purge orphaned JARs ──
        if (url.pathname === '/admin/purgeOrphans' && req.method === 'POST') {
          // Get all installed pkg names
          const installed = db.query('SELECT DISTINCT pkg_name FROM user_installed').all() as any[]
          const installedSet = new Set(installed.map(r => r.pkg_name))
          let purged = 0
          for (const folder of ['Aniyomi', 'CloudStream', 'Kotatsu']) {
            const dir = join(EXT_DIR, folder)
            if (!existsSync(dir)) continue
            for (const f of readdirSync(dir)) {
              if (!f.endsWith('.jar')) continue
              const pkgName = f.replace('.jar', '')
              if (!installedSet.has(pkgName)) {
                try { unlinkSync(join(dir, f)); purged++ } catch {}
              }
            }
          }
          res.end(JSON.stringify({ ok: true, purged }))
          return
        }

        // ── Get extension users ──
        const extUsers = url.pathname.match(/^\/admin\/extensionUsers\/(.+)$/)
        if (extUsers && req.method === 'GET') {
          const pkgName = decodeURIComponent(extUsers[1])
          res.end(JSON.stringify(getPkgUsers(pkgName)))
          return
        }

        // ── Delete all users ──
        if (url.pathname === '/admin/allUsers' && req.method === 'DELETE') {
          deleteAllUsers()
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Force JAR update ──
        if (url.pathname === '/admin/forceUpdate' && req.method === 'POST') {
          const t0 = Date.now()
          await runUpdateNow()
          res.end(JSON.stringify({ ok: true, elapsed: Date.now() - t0 }))
          return
        }

        // ── JAR status ──
        if (url.pathname === '/admin/jarStatus' && req.method === 'GET') {
          let fileSize = 0
          try { fileSize = statSync(getJarPath()).size } catch {}
          const meta = getJarMeta()
          const nextCheckAt = getNextCheckAt()
          const intervalMs = getIntervalMs()
          const now = Date.now()
          const nextCheckIn = nextCheckAt > now ? nextCheckAt - now : 0
          res.end(JSON.stringify({
            jarReady: isJarReady(),
            jarPath: getJarPath(),
            fileSize,
            fileSizeMB: (fileSize / 1024 / 1024).toFixed(2),
            version: meta.version,
            previousVersion: meta.previousVersion || null,
            downloadUrl: meta.downloadUrl,
            updatedAt: meta.updatedAt,
            nextCheckAt: new Date(nextCheckAt).toISOString(),
            nextCheckInMs: nextCheckIn,
            nextCheckInHuman: formatDuration(nextCheckIn),
            updateIntervalMs: intervalMs,
            updateIntervalHuman: `${intervalMs / 3600000}h`,
          }))
          return
        }

        // ── View logs ──
        if (url.pathname === '/admin/logs' && req.method === 'GET') {
          const lines = parseInt(url.searchParams.get('lines') || '100')
          let log = ''
          try {
            if (existsSync(LOG_FILE)) {
              const content = readFileSync(LOG_FILE, 'utf-8')
              log = content.split('\n').slice(-lines).join('\n')
            }
          } catch {}
          res.end(JSON.stringify({ log }))
          return
        }

        // ── Restart server ──
        if (url.pathname === '/admin/restart' && req.method === 'POST') {
          res.end(JSON.stringify({ ok: true, message: 'restarting' }))
          setTimeout(() => process.exit(0), 500)
          return
        }

        // ── Clear database ──
        if (url.pathname === '/admin/database' && req.method === 'DELETE') {
          clearDatabase()
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Shutdown server ──
        if (url.pathname === '/admin/shutdown' && req.method === 'POST') {
          res.end(JSON.stringify({ ok: true, message: 'shutting down' }))
          setTimeout(() => process.exit(0), 500)
          return
        }

        // ── Factory reset ──
        if (url.pathname === '/admin/factoryReset' && req.method === 'POST') {
          clearDatabase()
          try { rmSync(EXT_DIR, { recursive: true, force: true }) } catch {}
          try { rmSync(JAR_CACHE_DIR, { recursive: true, force: true }) } catch {}
          res.end(JSON.stringify({ ok: true, message: 'factory reset done, server will restart' }))
          setTimeout(() => process.exit(0), 500)
          return
        }

        // ── List banned IPs ──
        if (url.pathname === '/admin/bannedIPs' && req.method === 'GET') {
          const ips = getAllBannedIPs()
          res.end(JSON.stringify({ ips, count: ips.length }))
          return
        }

        // ── Get user's IPs ──
        const userIPs = url.pathname.match(/^\/admin\/userIPs\/([\w-]+)$/)
        if (userIPs && req.method === 'GET') {
          const uid = userIPs[1]
          const ips = getUserIPs(uid)
          const usersByIP: Record<string, any[]> = {}
          for (const ip of ips) {
            usersByIP[ip] = getUsersByIP(ip)
          }
          res.end(JSON.stringify({ userId: uid, ips, usersByIP }))
          return
        }

        // ── Manually ban an IP ──
        if (url.pathname === '/admin/banIP' && req.method === 'POST') {
          const body = await readBody(req)
          const { ip, reason } = JSON.parse(body)
          if (!ip) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'ip required' })); return }
          banIP(ip, 'admin-manual', reason || '')
          console.log(`[admin] Manually banned IP: ${ip}`)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Manually unban an IP ──
        if (url.pathname === '/admin/unbanIP' && req.method === 'POST') {
          const body = await readBody(req)
          const { ip } = JSON.parse(body)
          if (!ip) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'ip required' })); return }
          unbanIP(ip)
          console.log(`[admin] Manually unbanned IP: ${ip}`)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── Get users by IP ──
        const ipUsers = url.pathname.match(/^\/admin\/ipUsers\/(.+)$/)
        if (ipUsers && req.method === 'GET') {
          const ip = decodeURIComponent(ipUsers[1])
          const users = getUsersByIP(ip)
          res.end(JSON.stringify({ ip, users }))
          return
        }

        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      // ── Public: register (rate limited) ──
      if (url.pathname === '/register' && req.method === 'POST') {
        const ip = getClientIP(req)
        if (ip && !registerLimiter.check(ip)) {
          res.writeHead(429)
          res.end(JSON.stringify({ ok: false, error: 'registration not available' }))
          console.log(`[http] Registration rate-limited: ${ip}`)
          return
        }
        if (isIPBanned(ip)) {
          res.writeHead(403)
          res.end(JSON.stringify({ ok: false, error: 'registration not available' }))
          console.log(`[http] Blocked registration from banned IP: ${ip}`)
          return
        }
        const body = await readBody(req)
        const { username, password } = JSON.parse(body)
        if (!username || !password || username.length < 3 || password.length < 4) {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: 'username min 3 chars, password min 4 chars' }))
          return
        }
        const result = createUser(username, password)
        if (result.ok && result.user) {
          recordUserIP(result.user.id, ip)
          console.log(`[http] Registered '${username}' from ${ip}`)
        }
        res.end(JSON.stringify(result))
        return
      }

      // ── Public: login (rate limited) ──
      if (url.pathname === '/login' && req.method === 'POST') {
        const ip = getClientIP(req)
        if (ip && !loginLimiter.check(ip)) {
          res.writeHead(429)
          res.end(JSON.stringify({ ok: false, error: 'invalid credentials' }))
          console.log(`[http] Login rate-limited: ${ip}`)
          return
        }
        if (isIPBanned(ip)) {
          res.writeHead(403)
          res.end(JSON.stringify({ ok: false, error: 'invalid credentials' }))
          console.log(`[http] Blocked login from banned IP: ${ip}`)
          return
        }
        const body = await readBody(req)
        const { username, password } = JSON.parse(body)
        const user = authenticateUser(username, password)
        if (!user) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'invalid credentials' })); return }
        if (user.banned) { res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'account banned' })); return }
        loginLimiter.reset(ip) // reset on successful login
        recordUserIP(user.id, ip)
        res.end(JSON.stringify({ ok: true, user }))
        return
      }

      // ── Public: RPC (rate limited per user) ──
      if (url.pathname === '/rpc' && req.method === 'POST') {
        const ip = getClientIP(req)
        if (isIPBanned(ip)) {
          const body = await readBody(req)
          const { id } = JSON.parse(body)
          res.end(JSON.stringify({ id: id || '0', status: 'error', error: 'invalid credentials' }))
          console.log(`[http] Blocked RPC from banned IP: ${ip}`)
          return
        }
        const body = await readBody(req)
        const { username, password, method, args, id } = JSON.parse(body)
        const user = authenticateUser(username, password)
        if (!user) {
          res.end(JSON.stringify({ id: id || '0', status: 'error', error: 'invalid credentials' }))
          return
        }
        if (user.banned) {
          res.end(JSON.stringify({ id: id || '0', status: 'error', error: 'account banned' }))
          return
        }
        if (!rpcLimiter.check(user.id)) {
          res.end(JSON.stringify({ id: id || '0', status: 'error', error: 'too many requests' }))
          console.log(`[http] RPC rate-limited for user '${user.username}' (${user.id})`)
          return
        }
        recordUserIP(user.id, ip)
        try {
          const result = await handleMethod(user.id, user.username, { method, args })
          res.end(JSON.stringify({ id: id || '0', status: 'ok', data: result }))
        } catch (e: any) {
          res.end(JSON.stringify({ id: id || '0', status: 'error', error: e.message }))
        }
        return
      }

      // ── Public: health ──
      if (url.pathname === '/health') {
        const stats = db.query(`SELECT (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM user_installed) as installs`).get() as any
        res.end(JSON.stringify({ ...stats, jarReady: isJarReady() }))
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (e: any) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(HTTP_PORT, () => console.log(`[http] Listening on ${HTTP_PORT}`))
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c: Buffer) => data += c)
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ─── SSH Server ──────────────────────────────────────────────

import { Server } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'

const HOST_KEY_PATH = join(DATA_DIR, 'host_key')
let sshServer: InstanceType<typeof Server> | null = null

function getHostKey(): Buffer {
  if (existsSync(HOST_KEY_PATH)) return readFileSync(HOST_KEY_PATH)
  mkdirSync(DATA_DIR, { recursive: true })
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(HOST_KEY_PATH, key.privateKey)
  console.log('[ssh] Generated new RSA 2048 host key')
  return key.privateKey
}

export function startSshServer() {
  try {
    sshServer = new Server({
      hostKeys: [getHostKey()],
      algorithms: { kex: ['ecdh-sha2-nistp256'], serverHostKey: ['rsa-sha2-256', 'ssh-rsa'] },
    })

    sshServer.on('connection', (client) => {
      let sshUser: string | null = null
      let sshUserId: string | null = null
      const clientIP = (client as any)._sock?.remoteAddress || (client as any).sock?.remoteAddress || ''

      // Block banned IPs at SSH level
      if (clientIP && isIPBanned(clientIP)) {
        console.log(`[ssh] Rejected connection from banned IP: ${clientIP}`)
        client.end()
        return
      }

      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          const user = authenticateUser(ctx.username, ctx.password)
          if (user && !user.banned) {
            sshUser = user.username
            sshUserId = user.id
            // Track IP for this SSH user
            if (clientIP) recordUserIP(user.id, clientIP)
            client.on('ready', () => console.log(`[ssh] User '${sshUser}' connected from ${clientIP}`))
            ctx.accept()
          } else {
            ctx.reject()
          }
        } else {
          ctx.reject()
        }
      })

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()

          session.on('exec', (...args: any[]) => {
            const acceptExec = args[0]
            const execInfo = args.length === 3 ? args[2] : args[1]
            const raw = execInfo?.command?.trim() || ''

            const channel = acceptExec()

            if (!raw) {
              channel.stderr.write('Error: empty command\n')
              channel.close()
              return
            }

            try {
              const msg = JSON.parse(raw)
              console.log(`[ssh] ${sshUser} -> ${msg.method}`)

              handleMethod(sshUserId!, sshUser!, { method: msg.method, args: msg.args })
                .then((data) => {
                  channel.write(JSON.stringify({ id: msg.id || '0', status: 'ok', data }) + '\n')
                  channel.close()
                })
                .catch((e: any) => {
                  channel.write(JSON.stringify({ id: msg.id || '0', status: 'error', error: e.message }) + '\n')
                  channel.close()
                })
            } catch {
              channel.write(JSON.stringify({ id: '0', status: 'error', error: 'invalid JSON' }) + '\n')
              channel.close()
            }
          })
        })
      })

      client.on('close', () => console.log(`[ssh] User '${sshUser}' disconnected`))
    })

    sshServer.listen(SSH_PORT, '0.0.0.0', () => console.log(`[ssh] Listening on port ${SSH_PORT}`))
  } catch (e: any) {
    console.error(`[ssh] Failed to start: ${e.message}`)
  }
}

export function stopSshServer() {
  if (sshServer) { sshServer.close(); sshServer = null }
}

// ─── Method Router ─────────────────────────────────────────

async function handleMethod(userId: string, username: string, msg: any): Promise<any> {
  const { method, args } = msg

  switch (method) {
    case 'installExtension': {
      const { url, pkgName, type, name, iconUrl, version } = args || {}
      if (!url || !pkgName) throw new Error('url and pkgName required')
      return installForUser(userId, { url, pkgName, type: type || 'aniyomi', name, iconUrl, version })
    }

    case 'uninstallExtension': {
      const { pkgName, type } = args || {}
      if (!pkgName) throw new Error('pkgName required')
      return uninstallForUser(userId, pkgName, type)
    }

    case 'loadExtensions': {
      const folderPath = join(EXT_DIR, 'Aniyomi')
      const all = await invokeJar('loadExtensions', { folderPath }, 30000)
      return filterUserSources(userId, all, 'aniyomi')
    }

    case 'csLoadExtensions': {
      const folderPath = join(EXT_DIR, 'CloudStream')
      const all = await invokeJar('csLoadExtensions', { folderPath }, 30000)
      return filterUserSources(userId, all, 'cloudstream')
    }

    case 'kotatsuLoadExtensions': {
      const folderPath = join(EXT_DIR, 'Kotatsu')
      return invokeJar('kotatsuLoadExtensions', { folderPath }, 30000)
    }

    case 'ensureKotatsuJar': {
      const { url } = args || {}
      if (!url) throw new Error('url required')
      const dir = join(EXT_DIR, 'Kotatsu')
      mkdirSync(dir, { recursive: true })
      const jarFile = join(dir, 'plugin.jar')
      if (!existsSync(jarFile)) {
        console.log(`[ssh] Downloading Kotatsu plugin.jar from ${url}`)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Download failed: ${res.status}`)
        writeFileSync(jarFile, Buffer.from(await res.arrayBuffer()))
      }
      return { ok: true }
    }

    case 'health':
      return { status: 'ok', user: username, jarReady: isJarReady() }

    case 'forceUpdate': {
      console.log(`[ssh] User '${username}' triggered JAR update`)
      await runUpdateNow()
      return { ok: true }
    }

    // ── Default: forward to JAR sidecar (source methods) ──
    default:
      try {
        if (isJarReady()) return await invokeJar(method, args || {})
        return await invokeJarOnce(method, args || {})
      } catch (e: any) {
        throw new Error(`${method}: ${e.message}`)
      }
  }
}

// ── v2 install/uninstall helpers ──

function filterUserSources(userId: string, sources: any[], type: string): any[] {
  const userPkgs = getUserInstalledPkgs(userId, type)
  if (userPkgs.size === 0) return []
  return (sources || []).filter((s: any) =>
    userPkgs.has(s.pkgName) || userPkgs.has(s.pkg) || userPkgs.has(s.className)
  )
}

async function installForUser(userId: string, opts: { url: string; pkgName: string; type: string; name?: string; iconUrl?: string; version?: string }) {
  const { url, pkgName, type, name, iconUrl, version } = opts
  const typeFolder = type === 'cloudstream' ? 'CloudStream' : type === 'kotatsu' ? 'Kotatsu' : 'Aniyomi'
  const dir = join(EXT_DIR, typeFolder)
  mkdirSync(dir, { recursive: true })
  const targetFile = join(dir, `${pkgName}.jar`)

  if (!existsSync(targetFile)) {
    const isApk = url.toLowerCase().endsWith('.apk')
    const isCs3 = url.toLowerCase().endsWith('.cs3')
    const downloadPath = isApk ? join(dir, `${pkgName}.apk`) :
                         isCs3 ? join(dir, `${pkgName}.cs3`) : targetFile

    console.log(`[ssh] Downloading ${type} extension: ${pkgName} from ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(downloadPath, buf)

    if (isApk || isCs3) {
      if (!isJarReady()) {
        const started = await startSidecar()
        if (!started.ok) throw new Error('JAR not ready: ' + started.error)
      }
      console.log(`[ssh] Converting ${isApk ? 'APK' : 'CS3'} to JAR: ${pkgName}`)
      await invokeJar('convertApk', { apkPath: downloadPath, outJarPath: targetFile }, 120000)
      try { unlinkSync(downloadPath) } catch {}
    }
  } else {
    console.log(`[ssh] Extension already exists: ${pkgName}`)
  }

  addUserInstalled(userId, pkgName, type, name, iconUrl, version)
  return { ok: true }
}

function uninstallForUser(userId: string, pkgName: string, type?: string) {
  removeUserInstalled(userId, pkgName)

  if (countOtherUsersWithPkg(userId, pkgName) === 0) {
    const typeFolder = type === 'cloudstream' ? 'CloudStream' : type === 'kotatsu' ? 'Kotatsu' : 'Aniyomi'
    const filePath = join(EXT_DIR, typeFolder, `${pkgName}.jar`)
    try {
      unlinkSync(filePath)
      console.log(`[ssh] Deleted unused JAR: ${pkgName}`)
    } catch {}
  }

  return { ok: true }
}
