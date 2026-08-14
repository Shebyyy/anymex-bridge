import { createServer as createHttpServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { Server as SshServer } from 'ssh2'
import { authenticateUser, createUser, getUserExtensions, getUserAvailableExtensions, uninstallExtensionForUser, removeRepoForUser, getRepoByUrl, db, getAllUsers, getStats, getUserRepos, addRepoForUser, getExtension } from './db.js'
import { isJarReady, invokeJar, invokeJarOnce, getJarPath, startSidecar } from './jar.js'
import { addRepo, refreshRepo, getAllRepos } from './repos.js'
import { installExtension, downloadExtension } from './extensions.js'
import { runUpdateNow } from './auto-update.js'

const ADMIN_KEY = process.env.ADMIN_KEY || 'anymex-admin-2024'
let adminTokens = new Set<string>()
let _loadedSources: any[] = []
const EXT_DIR = join(import.meta.dir, 'extensions')

const SSH_PORT = 3022
const HTTP_PORT = 8082

const HOST_KEY_DIR = join(import.meta.dir, 'data')
const HOST_KEY_PATH = join(HOST_KEY_DIR, 'host_key')

function getHostKey(): Buffer {
  try { return readFileSync(HOST_KEY_PATH) } catch {}
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  writeFileSync(HOST_KEY_PATH, key.privateKey)
  console.log('[ssh] Generated new RSA 2048 host key')
  return Buffer.from(key.privateKey)
}

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
          const { statSync, existsSync } = await import('node:fs')
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

      // ── Public endpoints ──
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

// ─── SSH Server ────────────────────────────────────────────

export function startSshServer() {
  const hostKey = getHostKey()
  const sshServer = new SshServer({
    hostKeys: [hostKey],
    algorithms: { kex: ['ecdh-sha2-nistp256'], serverHostKey: ['rsa-sha2-256', 'ssh-rsa'] }
  })

  sshServer.on('connection', (client) => {
    let userId: string | null = null
    let username: string | null = null

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const user = authenticateUser(ctx.username, ctx.password as string)
        if (user) { userId = user.id; username = user.username; ctx.accept() }
        else ctx.reject()
      } else ctx.reject()
    })

    client.on('ready', () => {
      console.log(`[ssh] User '${username}' connected`)

      client.on('session', (accept) => {
        const session = accept()

        session.on('exec', (accept, info) => {
          const channel = accept()
          const raw = (info.command || '').trim()

          if (!raw) {
            channel.write(JSON.stringify({ id: '0', status: 'error', error: 'empty command' }) + '\n')
            channel.close(); return
          }

          try {
            const msg = JSON.parse(raw)
            handleMethod(userId!, username!, msg).then(result => {
              channel.write(JSON.stringify({ id: msg.id || '0', status: 'ok', data: result }) + '\n')
              channel.close()
            }).catch(e => {
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

    client.on('close', () => console.log(`[ssh] User '${username}' disconnected`))
  })

  sshServer.listen(SSH_PORT, '0.0.0.0', () => console.log(`[ssh] Listening on port ${SSH_PORT}`))
}

// ─── Method Router ─────────────────────────────────────────

async function handleMethod(userId: string, username: string, msg: any): Promise<any> {
  const { method, args } = msg

  switch (method) {
    case 'addRepo': {
      const { url, type } = args || {}
      if (!url) throw new Error('url required')
      return addRepo(userId, url, type)
    }
    case 'installExtension': {
      const { extId } = args || {}
      if (!extId) throw new Error('extId required')
      return installExtension(userId, Number(extId))
    }
    case 'uninstallExtension': {
      const { extId } = args || {}
      if (!extId) throw new Error('extId required')
      const ok = uninstallExtensionForUser(userId, Number(extId))
      return { ok }
    }
    case 'removeRepo': {
      const { url } = args || {}
      if (!url) throw new Error('url required')
      const repo = getRepoByUrl(url)
      if (!repo) throw new Error('repo not found')
      const ok = removeRepoForUser(userId, repo.id)
      return { ok }
    }
    case 'listExtensions':
      return getUserExtensions(userId)
    case 'downloadExtension': {
      const { extId } = args || {}
      if (!extId) throw new Error('extId required')
      return downloadExtension(Number(extId))
    }
    case 'forceUpdate': {
      // Manual trigger — re-fetch all repos & re-download changed plugins
      console.log(`[ssh] User '${username}' triggered force update`)
      await runUpdateNow()
      return { ok: true, message: 'Update cycle complete' }
    }
    case 'getExtensions': {
      const { type, query } = args || {}
      return getUserAvailableExtensions(userId, type, query)
    }
    case 'getRepos':
      return db.query(`SELECT r.id, r.url, r.type, r.name, r.last_fetched FROM repos r JOIN user_repos ur ON r.id = ur.repo_id WHERE ur.user_id = ?`).all(userId)
    case 'health':
      return { status: 'ok', user: username, jarReady: isJarReady() }
    default:
      // Forward to JAR sidecar or one-shot fallback
      try {
        if (isJarReady()) return await invokeJar(method, args || {})
        return await invokeJarOnce(method, args || {})
      } catch (e: any) {
        throw new Error(`${method}: ${e.message}`)
      }
  }
}