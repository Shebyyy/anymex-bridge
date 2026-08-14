import { createServer as createHttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { authenticateUser, createUser, getUserExtensions, getUserAvailableExtensions, uninstallExtensionForUser, removeRepoForUser, getRepoByUrl, db, getAllUsers, getStats, getUserRepos, addRepoForUser, getExtension, addUserInstalled, removeUserInstalled, getUserInstalledPkgs, countOtherUsersWithPkg } from './db.js'
import { isJarReady, invokeJar, invokeJarOnce, getJarPath, startSidecar } from './jar.js'
import { addRepo, refreshRepo, getAllRepos } from './repos.js'
import { installExtension, downloadExtension, convertAllApks, listExtensionFiles } from './extensions.js'
import { runUpdateNow } from './auto-update.js'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'

const ADMIN_KEY = process.env.ADMIN_KEY || 'anymex-admin-2024'
let adminTokens = new Set<string>()
let _loadedSources: any[] = []
const EXT_DIR = join(import.meta.dir, 'extensions')

const SSH_PORT = 3022
const HTTP_PORT = 8082

// ─── HTTP Server (registration + data endpoints) ──────────

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
          const stats = getStats()
          const users = getAllUsers()
          const userDetails = users.map(u => ({
            id: u.id, username: u.username,
            repos: (db.query('SELECT COUNT(*) as c FROM user_repos WHERE user_id = ?').get(u.id) as any)?.c ?? 0,
            extensions: (db.query('SELECT COUNT(*) as c FROM user_extensions WHERE user_id = ?').get(u.id) as any)?.c ?? 0
          }))
          res.end(JSON.stringify({ ...stats, userDetails }))
          return
        }

        if (url.pathname === '/admin/users' && req.method === 'GET') {
          res.end(JSON.stringify(getAllUsers()))
          return
        }

        if (url.pathname === '/admin/repos' && req.method === 'GET') {
          const repos = db.query(`
            SELECT r.*, (SELECT COUNT(*) FROM user_repos ur WHERE ur.repo_id = r.id) as userCount,
            (SELECT COUNT(*) FROM extensions e WHERE e.repo_id = r.id) as extCount
            FROM repos r ORDER BY r.added DESC
          `).all() as any[]
          res.end(JSON.stringify(repos))
          return
        }

        if (url.pathname === '/admin/extensions' && req.method === 'GET') {
          const exts = db.query(`
            SELECT e.*, (SELECT COUNT(*) FROM user_extensions ue WHERE ue.ext_id = e.id) as installCount
            FROM extensions e ORDER BY e.name
          `).all() as any[]
          res.end(JSON.stringify(exts))
          return
        }

        // ── POST: create user ──
        if (url.pathname === '/admin/createUser' && req.method === 'POST') {
          const body = await readBody(req)
          const { username, password } = JSON.parse(body)
          const result = createUser(username, password)
          res.end(JSON.stringify(result))
          return
        }

        // ── POST: add repo for user ──
        if (url.pathname === '/admin/addRepo' && req.method === 'POST') {
          const body = await readBody(req)
          const { userId, url: repoUrl, type } = JSON.parse(body)
          if (!userId || !repoUrl) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'userId and url required' })); return }
          const result = await addRepo(userId, repoUrl, type)
          res.end(JSON.stringify(result))
          return
        }

        // ── POST: install extension for user ──
        if (url.pathname === '/admin/installExtension' && req.method === 'POST') {
          const body = await readBody(req)
          const { userId, extId } = JSON.parse(body)
          if (!userId || !extId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'userId and extId required' })); return }
          const result = await installExtension(userId, Number(extId))
          res.end(JSON.stringify(result))
          return
        }

        // ── POST: uninstall extension for user ──
        if (url.pathname === '/admin/uninstallExtension' && req.method === 'POST') {
          const body = await readBody(req)
          const { userId, extId } = JSON.parse(body)
          if (!userId || !extId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'userId and extId required' })); return }
          const ok = uninstallExtensionForUser(userId, Number(extId))
          res.end(JSON.stringify({ ok }))
          return
        }

        // ── POST: force update ──
        if (url.pathname === '/admin/forceUpdate' && req.method === 'POST') {
          const t0 = Date.now()
          await runUpdateNow()
          res.end(JSON.stringify({ ok: true, elapsed: Date.now() - t0 }))
          return
        }

        // ── POST: load extensions into JAR and get source list ──
        if (url.pathname === '/admin/loadExtensions' && req.method === 'POST') {
          try {
            // Ensure sidecar is running
            if (!isJarReady()) {
              const started = await startSidecar()
              if (!started.ok) {
                res.end(JSON.stringify({ ok: false, error: started.error }))
                return
              }
            }
            const result = await invokeJar('loadExtensions', { folderPath: EXT_DIR }, 120000)
            if (Array.isArray(result)) {
              _loadedSources = result.map((s: any) => ({
                id: s.id,
                name: s.name,
                type: s.type || (s.pkg?.includes('manga') ? 'aniyomi-manga' : 'aniyomi-anime'),
                lang: s.lang || '',
                pkg: s.pkg || '',
              }))
              console.log(`[admin] Loaded ${_loadedSources.length} sources`)
            } else {
              _loadedSources = []
              console.log('[admin] loadExtensions returned non-array:', typeof result)
            }
            res.end(JSON.stringify({ ok: true, sources: _loadedSources, total: _loadedSources.length }))
          } catch (e: any) {
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
          return
        }

        // ── GET: cached sources ──
        if (url.pathname === '/admin/sources' && req.method === 'GET') {
          res.end(JSON.stringify({ sources: _loadedSources, total: _loadedSources.length }))
          return
        }

        // ── GET: downloaded extensions (have file_path) ──
        if (url.pathname === '/admin/downloadedExtensions' && req.method === 'GET') {
          const exts = db.query(`SELECT id, name, type, version, pkg, file_path FROM extensions WHERE file_path IS NOT NULL AND file_path != '' ORDER BY name`).all() as any[]
          res.end(JSON.stringify(exts))
          return
        }

        // ── GET: list actual files in extensions directory ──
        if (url.pathname === '/admin/extFiles' && req.method === 'GET') {
          res.end(JSON.stringify(listExtensionFiles()))
          return
        }

        // ── POST: convert all APKs in extensions dir to JAR ──
        if (url.pathname === '/admin/convertAllApks' && req.method === 'POST') {
          const t0 = Date.now()
          const result = await convertAllApks()
          res.end(JSON.stringify({ ok: true, ...result, elapsed: Date.now() - t0 }))
          return
        }

        // ── POST: download all extensions that don't have files yet ──
        if (url.pathname === '/admin/downloadAll' && req.method === 'POST') {
          const t0 = Date.now()
          const exts = db.query(`SELECT id, name FROM extensions WHERE file_path IS NULL OR file_path = ''`).all() as any[]
          let downloaded = 0, failed = 0
          const errors: string[] = []
          for (const ext of exts) {
            const r = await downloadExtension(ext.id)
            if (r.ok) downloaded++
            else { failed++; errors.push(`${ext.name}: ${r.error}`) }
          }
          res.end(JSON.stringify({ ok: true, total: exts.length, downloaded, failed, errors, elapsed: Date.now() - t0 }))
          return
        }

        // ── POST: invoke JAR method (test) ──
        if (url.pathname === '/admin/invoke' && req.method === 'POST') {
          const body = await readBody(req)
          const { method, args, timeout } = JSON.parse(body)
          if (!method) { res.writeHead(400); res.end(JSON.stringify({ error: 'method required' })); return }
          try {
            const t0 = Date.now()
            let result: any
            if (isJarReady()) {
              result = await invokeJar(method, args || {}, timeout || 30000)
            } else {
              result = await invokeJarOnce(method, args || {}, timeout || 30000)
            }
            res.end(JSON.stringify({ ok: true, data: result, elapsed: Date.now() - t0 }))
          } catch (e: any) {
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
          return
        }

        // ── GET: user detail (repos + extensions) ──
        const userDetail = url.pathname.match(/^\/admin\/user\/([\w-]+)$/)
        if (userDetail && req.method === 'GET') {
          const uid = userDetail[1]
          const user = db.query('SELECT id, username, created FROM users WHERE id = ?').get(uid) as any
          if (!user) { res.writeHead(404); res.end(JSON.stringify({ error: 'user not found' })); return }
          const repos = getUserRepos(uid)
          const extensions = getUserExtensions(uid)
          const available = getUserAvailableExtensions(uid)
          res.end(JSON.stringify({ ...user, repos, installedExtensions: extensions, availableExtensions: available }))
          return
        }

        // ── GET: user repos ──
        const userRepos = url.pathname.match(/^\/admin\/user\/([\w-]+)\/repos$/)
        if (userRepos && req.method === 'GET') {
          res.end(JSON.stringify(getUserRepos(userRepos[1])))
          return
        }

        // ── GET: user extensions ──
        const userExts = url.pathname.match(/^\/admin\/user\/([\w-]+)\/extensions$/)
        if (userExts && req.method === 'GET') {
          res.end(JSON.stringify(getUserExtensions(userExts[1])))
          return
        }

        // ── GET: user available extensions ──
        const userAvail = url.pathname.match(/^\/admin\/user\/([\w-]+)\/available$/)
        if (userAvail && req.method === 'GET') {
          const type = url.searchParams.get('type') || undefined
          const query = url.searchParams.get('query') || undefined
          res.end(JSON.stringify(getUserAvailableExtensions(userAvail[1], type, query)))
          return
        }

        // ── POST: download/refresh a single extension ──
        if (url.pathname === '/admin/downloadExtension' && req.method === 'POST') {
          const body = await readBody(req)
          const { extId, force } = JSON.parse(body)
          if (!extId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'extId required' })); return }
          const result = await downloadExtension(Number(extId), force)
          res.end(JSON.stringify(result))
          return
        }

        // ── POST: refresh single repo ──
        if (url.pathname === '/admin/refreshRepo' && req.method === 'POST') {
          const body = await readBody(req)
          const { repoId } = JSON.parse(body)
          if (!repoId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'repoId required' })); return }
          const repo = db.query('SELECT id, url, type FROM repos WHERE id = ?').get(Number(repoId)) as any
          if (!repo) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'repo not found' })); return }
          const result = await refreshRepo(repo.url, repo.type, repo.id)
          res.end(JSON.stringify(result))
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

        // ── DELETE user ──
        const delUser = url.pathname.match(/^\/admin\/user\/([\w-]+)$/)
        if (delUser && req.method === 'DELETE') {
          const uid = delUser[1]
          db.run('DELETE FROM user_extensions WHERE user_id = ?', [uid])
          db.run('DELETE FROM user_repos WHERE user_id = ?', [uid])
          db.run('DELETE FROM users WHERE id = ?', [uid])
          console.log(`[admin] Deleted user ${uid}`)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── DELETE repo ──
        const delRepo = url.pathname.match(/^\/admin\/repo\/(\d+)$/)
        if (delRepo && req.method === 'DELETE') {
          const rid = Number(delRepo[1])
          db.run('DELETE FROM extensions WHERE repo_id = ?', [rid])
          db.run('DELETE FROM user_repos WHERE repo_id = ?', [rid])
          db.run('DELETE FROM repos WHERE id = ?', [rid])
          console.log(`[admin] Deleted repo ${rid}`)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        // ── DELETE extension ──
        const delExt = url.pathname.match(/^\/admin\/extension\/(\d+)$/)
        if (delExt && req.method === 'DELETE') {
          const eid = Number(delExt[1])
          db.run('DELETE FROM user_extensions WHERE ext_id = ?', [eid])
          db.run('DELETE FROM extensions WHERE id = ?', [eid])
          console.log(`[admin] Deleted extension ${eid}`)
          res.end(JSON.stringify({ ok: true }))
          return
        }

        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
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
        const stats = db.query(`SELECT (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM extensions) as extensions, (SELECT COUNT(*) FROM user_extensions) as installs`).get() as any
        res.end(JSON.stringify({ ...stats, jarReady: isJarReady() }))
        return
      }

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

      if (url.pathname === '/addRepo' && req.method === 'POST') {
        const body = await readBody(req)
        const { username, password, url: repoUrl, type } = JSON.parse(body)
        const user = authenticateUser(username, password)
        if (!user) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'invalid credentials' })); return }
        if (!repoUrl) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'url required' })); return }
        res.end(JSON.stringify(await addRepo(user.id, repoUrl, type)))
        return
      }

      if (url.pathname === '/installExtension' && req.method === 'POST') {
        const body = await readBody(req)
        const { username, password, extId } = JSON.parse(body)
        const user = authenticateUser(username, password)
        if (!user) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'invalid credentials' })); return }
        if (!extId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'extId required' })); return }
        res.end(JSON.stringify(await installExtension(user.id, Number(extId))))
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

// ─── SSH Server (direct, runs in Bun) ──────────────────
// ssh2 v1.17.0 changed exec event from (accept, info) to (accept, reject, info).
// The old 2-arg signature made `info` point to the `reject` function instead of
// the actual info object — causing info.command to always be undefined/empty.

import { Server } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

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
      let sshPass: string | null = null

      client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
          const user = authenticateUser(ctx.username, ctx.password)
          if (user) {
            sshUser = user.username
            sshUserId = user.id
            sshPass = ctx.password
            console.log(`[ssh] User '${sshUser}' authenticated`)
            ctx.accept()
          } else {
            ctx.reject()
          }
        } else {
          ctx.reject()
        }
      })

      client.on('ready', () => {
        console.log(`[ssh] User '${sshUser}' connected`)

        client.on('session', (accept) => {
          const session = accept()

          // ssh2 v1.17.0: (acceptExec, rejectExec, info)
          // ssh2 <1.17:  (acceptExec, info)
          session.on('exec', (...args: any[]) => {
            const acceptExec = args[0]
            // In v1.17+, info is args[2]. In older versions, info is args[1].
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

    sshServer.listen(SSH_PORT, '0.0.0.0', () => {
      console.log(`[ssh] Listening on port ${SSH_PORT}`)
    })
  } catch (e: any) {
    console.error(`[ssh] Failed to start: ${e.message}`)
  }
}

export function stopSshServer() {
  if (sshServer) {
    sshServer.close()
    sshServer = null
  }
}

// ─── Method Router ─────────────────────────────────────────

async function handleMethod(userId: string, username: string, msg: any): Promise<any> {
  const { method, args } = msg

  switch (method) {
    // ── v2: Client-side repo management, server handles install/load only ──

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

    // Intercept load* to filter to user's installed extensions only
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
      // Kotatsu: don't filter — install/uninstall is client-side toggle
      const folderPath = join(EXT_DIR, 'Kotatsu')
      return invokeJar('kotatsuLoadExtensions', { folderPath }, 30000)
    }

    // Ensure Kotatsu plugin.jar exists on server
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

    // ── Legacy admin methods (kept for admin panel) ──
    case 'addRepo': {
      const { url, type } = args || {}
      if (!url) throw new Error('url required')
      return addRepo(userId, url, type)
    }
    case 'listExtensions':
      return getUserExtensions(userId)
    case 'getExtensions': {
      const { type, query } = args || {}
      return getUserAvailableExtensions(userId, type, query)
    }
    case 'getRepos':
      return db.query(`SELECT r.id, r.url, r.type, r.name, r.last_fetched FROM repos r JOIN user_repos ur ON r.id = ur.repo_id WHERE ur.user_id = ?`).all(userId)
    case 'removeRepo': {
      const { url } = args || {}
      if (!url) throw new Error('url required')
      const repo = getRepoByUrl(url)
      if (!repo) throw new Error('repo not found')
      const ok = removeRepoForUser(userId, repo.id)
      return { ok }
    }
    case 'downloadExtension': {
      const { extId } = args || {}
      if (!extId) throw new Error('extId required')
      return downloadExtension(Number(extId))
    }
    case 'forceUpdate': {
      console.log(`[ssh] User '${username}' triggered force update`)
      await runUpdateNow()
      return { ok: true, message: 'Update cycle complete' }
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
