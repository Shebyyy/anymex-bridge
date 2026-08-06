import { createServer as createHttpServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { Server as SshServer } from 'ssh2'
import { authenticateUser, createUser, getStats, getUserExtensions } from './db.js'
import { checkOrDownloadJar, isJarReady, invokeJar } from './jar.js'
import { addRepo } from './repos.js'
import { installExtension, downloadExtension } from './extensions.js'
import { db } from './db.js'

const SSH_PORT = 3022
const HTTP_PORT = 8081

// Generate or load RSA host key
const HOST_KEY_DIR = join(import.meta.dir, 'data')
const HOST_KEY_PATH = join(HOST_KEY_DIR, 'host_key')

function getHostKey(): Buffer {
  try { return readFileSync(HOST_KEY_PATH) } catch {}
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  writeFileSync(HOST_KEY_PATH, key.privateKey)
  console.log('[ssh] Generated new RSA 2048 host key')
  return Buffer.from(key.privateKey)
}

// ─── HTTP Server (for dashboard proxy) ─────────────────────

export function startHttpServer() {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`)
    res.setHeader('Content-Type', 'application/json')

    try {
      if (url.pathname === '/health') {
        const stats = getStats()
        res.end(JSON.stringify({ ...stats, dbPresent: true }))
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
        const result = createUser(username, password)
        res.end(JSON.stringify(result))
        return
      }

      if (url.pathname === '/data' && req.method === 'GET') {
        const section = url.searchParams.get('section') || 'health'
        const type = url.searchParams.get('type') || undefined
        const data = queryData(section, type)
        res.end(JSON.stringify(data))
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

function queryData(section: string, type?: string) {
  switch (section) {
    case 'health': {
      const r = getStats()
      return { users: r?.users || 0, repos: r?.repos || 0, extensions: r?.extensions || 0, installs: r?.installs || 0, dbPresent: true }
    }
    case 'users': {
      return db.query(`
        SELECT u.id, u.username,
          (SELECT COUNT(*) FROM user_repos WHERE user_id = u.id) as repo_count,
          (SELECT COUNT(*) FROM user_extensions WHERE user_id = u.id) as ext_count
        FROM users u ORDER BY u.username
      `).all()
    }
    case 'repos': {
      return db.query(`
        SELECT ur.user_id, ur.url, r.type, r.added, u.username
        FROM user_repos ur JOIN repos r ON ur.repo_id = r.id JOIN users u ON ur.user_id = u.id
        ORDER BY r.added DESC
      `).all()
    }
    case 'extensions': {
      let sql = 'SELECT e.id, e.name, e.type, e.version, e.icon_url, e.lang, e.is_nsfw, e.extra, (SELECT COUNT(*) FROM user_extensions WHERE ext_id = e.id) as install_count FROM extensions e'
      if (type) sql += ' WHERE e.type = ?'
      sql += ' ORDER BY e.name'
      const stmt = db.prepare(sql)
      const rows = type ? stmt.all(type) : stmt.all()
      return rows
    }
    case 'installs': {
      return db.query(`
        SELECT ue.user_id, ue.ext_id, u.username, e.name as ext_name, e.type
        FROM user_extensions ue
        JOIN users u ON ue.user_id = u.id
        JOIN extensions e ON ue.ext_id = e.id
        ORDER BY u.username, e.name
      `).all()
    }
    default: return null
  }
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
        if (user) {
          userId = user.id
          username = user.username
          ctx.accept()
        } else {
          ctx.reject()
        }
      } else {
        ctx.reject()
      }
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
            channel.close()
            return
          }

          // Parse SidecarBridge JSON protocol
          try {
            const msg = JSON.parse(raw)
            handleMethod(userId!, username!, msg).then(result => {
              const resp = JSON.stringify({ id: msg.id || '0', status: 'ok', data: result }) + '\n'
              channel.write(resp)
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

    client.on('close', () => {
      console.log(`[ssh] User '${username}' disconnected`)
    })
  })

  sshServer.listen(SSH_PORT, '0.0.0.0', () => {
    console.log(`[ssh] Listening on port ${SSH_PORT}`)
  })
}

// ─── Method Router ─────────────────────────────────────────

async function handleMethod(userId: string, username: string, msg: any): Promise<any> {
  const { method, args } = msg

  // Management methods (handled server-side)
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

    case 'listExtensions': {
      return getUserExtensions(userId)
    }

    case 'downloadExtension': {
      const { extId } = args || {}
      if (!extId) throw new Error('extId required')
      return downloadExtension(Number(extId))
    }

    case 'getExtensions': {
      const { type, query } = args || {}
      let sql = 'SELECT id, name, pkg, type, version, icon_url, lang, is_nsfw, extra FROM extensions'
      const params: any[] = []
      if (type) { sql += ' WHERE type = ?'; params.push(type) }
      if (query) { sql += (params.length ? ' AND' : ' WHERE') + ' name LIKE ?'; params.push(`%${query}%`) }
      sql += ' ORDER BY name'
      return db.prepare(sql).all(...params)
    }

    case 'getRepos': {
      return db.query(`
        SELECT r.id, r.url, r.type, r.name, r.last_fetched
        FROM repos r JOIN user_repos ur ON r.id = ur.repo_id
        WHERE ur.user_id = ?
      `).all(userId)
    }

    case 'health': {
      return { status: 'ok', user: username, jarReady: isJarReady() }
    }

    default:
      // Forward to JAR
      if (isJarReady()) {
        return invokeJar(method, args || {})
      }
      throw new Error(`Unknown method: ${method} (and JAR not available)`)
  }
}