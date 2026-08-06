import { createServer as createHttpServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { Server as SshServer } from 'ssh2'
import { authenticateUser, createUser, getAllUsers } from './db.js'
import { isJarReady, invokeJar, invokeJarOnce } from './jar.js'

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

// ─── HTTP Server (user registration only) ──────────────────

export function startHttpServer() {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${HTTP_PORT}`)
    res.setHeader('Content-Type', 'application/json')

    try {
      // Health check
      if (url.pathname === '/health') {
        res.end(JSON.stringify({
          status: 'ok',
          jarReady: isJarReady(),
          users: getAllUsers().length,
        }))
        return
      }

      // Register user
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
    let username: string | null = null

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const user = authenticateUser(ctx.username, ctx.password as string)
        if (user) {
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

          // Parse SidecarBridge JSON protocol — forward directly to JAR
          try {
            const msg = JSON.parse(raw)
            forwardToJar(msg).then(data => {
              channel.write(JSON.stringify({ id: msg.id || '0', status: 'ok', data }) + '\n')
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

// ─── Forward everything to JAR runtime ─────────────────────

async function forwardToJar(msg: any): Promise<any> {
  const { method, args } = msg

  // Only health is handled server-side
  if (method === 'health') {
    return { status: 'ok', jarReady: isJarReady() }
  }

  // Everything else → JAR sidecar (persistent) or one-shot fallback
  try {
    if (isJarReady()) return await invokeJar(method, args || {})
    return await invokeJarOnce(method, args || {})
  } catch (e: any) {
    throw new Error(`JAR error [${method}]: ${e.message}`)
  }
}
