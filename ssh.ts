import { createServer as createHttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { authenticateUser, createUser, getAllUsers, db, getUserInstalled, addUserInstalled, removeUserInstalled, getUserInstalledPkgs, countOtherUsersWithPkg } from './db.js'
import { isJarReady, invokeJar, invokeJarOnce, getJarPath, startSidecar } from './jar.js'
import { runUpdateNow } from './auto-update.js'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'

const ADMIN_KEY = process.env.ADMIN_KEY || 'anymex-admin-2024'
let adminTokens = new Set<string>()
const EXT_DIR = join(import.meta.dir, 'extensions')

const SSH_PORT = 3022
const HTTP_PORT = 8082

// ─── HTTP Server (registration + admin) ──────────────────

function checkAdmin(req: any): boolean {
  const auth = req.headers['authorization'] || ''
  const token = auth.replace('Bearer ', '')
  return adminTokens.has(token)
}

export function startHttpServer() {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`)

    try {
      // ── Serve admin panel ──
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(readFileSync(join(import.meta.dir, 'admin.html'), 'utf-8'))
        return
      }

      res.setHeader('Content-Type', 'application/json')

      // ── Admin login ──
      if (url.pathname === '/admin/login' && req.method === 'POST') {
        const body = await readBody(req)
        const { key } = JSON.parse(body)
        if (key === ADMIN_KEY) {
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

        if (url.pathname === '/admin/stats' && req.method === 'GET') {
          const users = getAllUsers()
          const userDetails = users.map(u => ({
            id: u.id, username: u.username,
            extensions: (db.query('SELECT COUNT(*) as c FROM user_installed WHERE user_id = ?').get(u.id) as any)?.c ?? 0
          }))
          res.end(JSON.stringify({ users: userDetails, totalUsers: users.length }))
          return
        }

        if (url.pathname === '/admin/users' && req.method === 'GET') {
          res.end(JSON.stringify(getAllUsers()))
          return
        }

        if (url.pathname === '/admin/createUser' && req.method === 'POST') {
          const body = await readBody(req)
          const { username, password } = JSON.parse(body)
          res.end(JSON.stringify(createUser(username, password)))
          return
        }

        // ── GET: user detail ──
        const userDetail = url.pathname.match(/^\/admin\/user\/([\w-]+)$/)
        if (userDetail && req.method === 'GET') {
          const uid = userDetail[1]
          const user = db.query('SELECT id, username, created FROM users WHERE id = ?').get(uid) as any
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

        // ── POST: force JAR update ──
        if (url.pathname === '/admin/forceUpdate' && req.method === 'POST') {
          const t0 = Date.now()
          await runUpdateNow()
          res.end(JSON.stringify({ ok: true, elapsed: Date.now() - t0 }))
          return
        }

        // ── GET: JAR status ──
        if (url.pathname === '/admin/jarStatus' && req.method === 'GET') {
          const { statSync } = await import('node:fs')
          let fileSize = 0
          try { fileSize = statSync(getJarPath()).size } catch {}
          res.end(JSON.stringify({
            jarReady: isJarReady(),
            jarPath: getJarPath(),
            fileSize,
            fileSizeMB: (fileSize / 1024 / 1024).toFixed(2)
          }))
          return
        }

        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      // ── Public: register ──
      if (url.pathname === '/register' && req.method === 'POST') {
        const body = await readBody(req)
        const { username, password } = JSON.parse(body)
        if (!username || !password || username.length < 3 || password.length < 4) {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: 'username min 3 chars, password min 4 chars' }))
          return
        }
        res.end(JSON.stringify(createUser(username, password)))
        return
      }

      // ── Public: login (used by SSH proxy) ──
      if (url.pathname === '/login' && req.method === 'POST') {
        const body = await readBody(req)
        const { username, password } = JSON.parse(body)
        const user = authenticateUser(username, password)
        if (!user) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'invalid credentials' })); return }
        res.end(JSON.stringify({ ok: true, user }))
        return
      }

      // ── Public: RPC (used by SSH proxy) ──
      if (url.pathname === '/rpc' && req.method === 'POST') {
        const body = await readBody(req)
        const { username, password, method, args, id } = JSON.parse(body)
        const user = authenticateUser(username, password)
        if (!user) {
          res.end(JSON.stringify({ id: id || '0', status: 'error', error: 'invalid credentials' }))
          return
        }
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

const DATA_DIR = join(import.meta.dir, 'data')
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

      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          const user = authenticateUser(ctx.username, ctx.password)
          if (user) {
            sshUser = user.username
            sshUserId = user.id
            client.on('ready', () => console.log(`[ssh] User '${sshUser}' connected`))
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

          // ssh2 v1.17.0: (acceptExec, rejectExec, info)
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
