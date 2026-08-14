import { createServer as createHttpServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { Server as SshServer } from 'ssh2'
import { authenticateUser, db } from './db.js'
import { isJarReady, invokeJar, invokeJarOnce, cancelJarRequest } from './jar.js'
import { runUpdateNow } from './auto-update.js'

const SSH_PORT = 3022
const HTTP_PORT = 8082

const HOST_KEY_DIR = join(import.meta.dir, 'data')
const HOST_KEY_PATH = join(HOST_KEY_DIR, 'host_key')

// Server-side extension directories
const EXT_ANIYOMI_DIR = join(import.meta.dir, 'extensions', 'Aniyomi')
const EXT_CS_DIR = join(import.meta.dir, 'extensions', 'CloudStream')
const EXT_KOTATSU_DIR = join(import.meta.dir, 'extensions', 'Kotatsu')

function getHostKey(): Buffer {
  try { return readFileSync(HOST_KEY_PATH) } catch {}
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  writeFileSync(HOST_KEY_PATH, key.privateKey)
  console.log('[ssh] Generated new RSA 2048 host key')
  return Buffer.from(key.privateKey)
}

// ─── HTTP Server (admin-only: health + user management) ──────
// The AnymeX app NEVER uses HTTP. It only speaks the SSH bridge protocol.

export function startHttpServer() {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`)
    res.setHeader('Content-Type', 'application/json')

    try {
      if (url.pathname === '/health' && req.method === 'GET') {
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
        const existing = db.query('SELECT id FROM users WHERE username = ?').get(username)
        if (existing) {
          res.end(JSON.stringify({ ok: false, error: 'username already exists' }))
          return
        }
        const id = crypto.randomUUID()
        db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [id, username, password])
        res.end(JSON.stringify({ ok: true, user: { id, username } }))
        return
      }

      if (url.pathname === '/forceUpdate' && req.method === 'POST') {
        console.log('[http] Force update triggered')
        await runUpdateNow()
        res.end(JSON.stringify({ ok: true }))
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (e: any) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(HTTP_PORT, () => console.log(`[http] Admin on ${HTTP_PORT}`))
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c: Buffer) => data += c)
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ─── SSH Server ─────────────────────────────────────────────
// Transparent proxy to the JAR sidecar.
//
// Protocol — matches SidecarBridge.dart EXACTLY:
//
//   App sends via SSH exec:
//     {"method":"getPopular","args":{"sourceId":"...","isAnime":true,"page":1},"id":"42"}
//
//   Server responds:
//     Success: {"id":"42","data":{...}}
//     Error:   {"id":"42","status":"error","data":"some error"}
//
//   Note: NO "status":"ok" on success. The Dart SidecarBridge only
//   checks for status === 'partial' | 'completed' | 'error'.
//   Absent status means normal completion (completer resolves with data).

export function startSshServer() {
  const hostKey = getHostKey()
  const sshServer = new SshServer({
    hostKeys: [hostKey],
    algorithms: { kex: ['ecdh-sha2-nistp256'], serverHostKey: ['rsa-sha2-256', 'ssh-rsa'] }
  })

  sshServer.on('connection', (client) => {
    let username: string | null = null

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const user = authenticateUser(ctx.username, ctx.password as string)
        if (user) { username = user.username; ctx.accept() }
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
            channel.write(JSON.stringify({ id: '0', status: 'error', data: 'empty command' }) + '\n')
            channel.close(); return
          }

          let msg: any
          try {
            msg = JSON.parse(raw)
          } catch {
            channel.write(JSON.stringify({ id: '0', status: 'error', data: 'invalid JSON' }) + '\n')
            channel.close(); return
          }

          const id = msg.id?.toString() || '0'
          const method = msg.method
          const args = msg.args || {}

          if (!method) {
            channel.write(JSON.stringify({ id, status: 'error', data: 'method required' }) + '\n')
            channel.close(); return
          }

          // Handle cancel — forward to JAR and respond
          if (method === 'cancel') {
            const cancelId = args.id || id
            cancelJarRequest(cancelId)
            channel.write(JSON.stringify({ id: cancelId, data: true }) + '\n')
            channel.close()
            return
          }

          // Patch args with server-side paths
          const patchedArgs = patchArgs(method, args)

          // Forward ALL methods to JAR sidecar (transparent proxy)
          callJar(method, patchedArgs, id).then(data => {
            // Success: { id, data } — NO status field
            channel.write(JSON.stringify({ id, data }) + '\n')
            channel.close()
          }).catch(e => {
            // Error: { id, status: "error", data: errorMsg }
            channel.write(JSON.stringify({ id, status: 'error', data: e.message || String(e) }) + '\n')
            channel.close()
          })
        })
      })
    })

    client.on('close', () => console.log(`[ssh] User '${username}' disconnected`))
  })

  sshServer.listen(SSH_PORT, '0.0.0.0', () => console.log(`[ssh] Listening on port ${SSH_PORT}`))
}

// ─── Call JAR (passes client's ID through for cancel support) ──

async function callJar(method: string, args: Record<string, any>, clientRequestId: string): Promise<any> {
  if (isJarReady()) {
    return await invokeJar(method, args, { clientRequestId })
  }
  return await invokeJarOnce(method, args)
}

// ─── Path Patching ───────────────────────────────────────────
// The app sends folder paths that point to the iOS device filesystem.
// On the server, redirect to the SERVER's extension directories.

function patchArgs(method: string, args: Record<string, any>): Record<string, any> {
  const patched = { ...args }

  if (method === 'loadExtensions') {
    patched.folderPath = EXT_ANIYOMI_DIR
  }

  if (method === 'csLoadExtensions') {
    patched.folderPath = EXT_CS_DIR
  }

  if (method === 'kotatsuLoadExtensions') {
    patched.folderPath = EXT_KOTATSU_DIR
  }

  if (method === 'convertApk' && patched.apkPath) {
    patched.outJarPath = patched.outJarPath ||
      join(dirname(patched.apkPath), basename(patched.apkPath).replace(/\.apk$/i, '.jar'))
  }

  return patched
}
