import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { createInterface } from 'node:readline'

import { authenticateUser, createUser, listRepos, listExtensions, listInstalledForUser, isInstalledForUser, removeRepo, listUsers as dbListUsers, getExtUserCount, db } from './db.js'
import { addAndFetchRepo } from './repos.js'
import { installExtension, uninstallExtension } from './extensions.js'
import { jar } from './jar.js'

const { Server: SSHServer } = ssh2

const DATA_DIR = join(import.meta.dir, '..', 'data')
const HOST_KEYS_DIR = join(DATA_DIR, 'host-keys')
mkdirSync(HOST_KEYS_DIR, { recursive: true })

const HOST_KEY_PATH = join(HOST_KEYS_DIR, 'ed25519')
const SSH_PORT = parseInt(process.env.SSH_PORT || '3022')
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8081')

// ── Methods that go to the JAR (forwarded as-is) ───────
const JAR_METHODS = new Set([
  'loadExtensions', 'convertApk', 'loadPlugin',
  'getPopular', 'getLatestUpdates', 'search',
  'getDetail', 'getVideoList', 'getPageList',
  'getFilterList', 'getPreference', 'setPreference',
  'cancel', 'stopHttpServer',
  'getCookie', 'setCookie', 'getUserAgent', 'setUserAgent',
])

// ── SSH Host Key ──────────────────────────────────────

let cachedHostKey: string | null = null

async function getHostKey(): Promise<string> {
  if (cachedHostKey) return cachedHostKey
  const KEY_PATH = join(HOST_KEYS_DIR, 'host_key')
  if (existsSync(KEY_PATH)) {
    cachedHostKey = readFileSync(KEY_PATH, 'utf8')
    return cachedHostKey!
  }
  console.log('[ssh] generating host key (RSA)...')
  // Use RSA — widely supported by ssh2 server
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  writeFileSync(KEY_PATH, pem, { mode: 0o600 })
  cachedHostKey = pem
  return cachedHostKey
}

// ── HTTP (register only, lightweight) ─────────────────

function startHttp() {
  const server = Bun.serve({
    port: HTTP_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/health') {
        const users = (db.query('SELECT COUNT(*) as c FROM users').get() as any).c
        const repos = (db.query('SELECT COUNT(*) as c FROM repos').get() as any).c
        const exts = (db.query('SELECT COUNT(*) as c FROM extensions').get() as any).c
        const installs = (db.query('SELECT COUNT(*) as c FROM user_extensions').get() as any).c
        return Response.json({
          ok: true,
          jar: jar.isPresent(),
          jarReady: jar.isReady(),
          ssh: SSH_PORT,
          http: HTTP_PORT,
          users, repos, extensions: exts, installs,
        })
      }

      if (url.pathname === '/data/users') {
        const users = dbListUsers().map((u: any) => ({
          ...u,
          repo_count: (db.query('SELECT COUNT(*) as c FROM repos WHERE added_by = ?', [u.id]).get() as any).c,
        }))
        return Response.json(users)
      }

      if (url.pathname === '/data/repos') {
        return Response.json(listRepos())
      }

      if (url.pathname === '/data/extensions') {
        const type = url.searchParams.get('type')
        const exts = listExtensions(type || undefined).map((e: any) => ({
          ...e,
          extra: e.extra ? (typeof e.extra === 'string' ? JSON.parse(e.extra) : e.extra) : null,
          install_count: getExtUserCount(e.id),
          repo_url: (db.query('SELECT url FROM repos WHERE id = ?', [e.repo_id]).get() as any)?.url || null,
        }))
        return Response.json(exts)
      }

      if (url.pathname === '/data/installs') {
        const installs = db.query(`
          SELECT ue.user_id, ue.ext_id, u.username, e.name as ext_name, e.type
          FROM user_extensions ue
          JOIN users u ON ue.user_id = u.id
          JOIN extensions e ON ue.ext_id = e.id
          ORDER BY u.username, e.name
        `).all()
        return Response.json(installs)
      }

      if (req.method === 'POST' && url.pathname === '/register') {
        return req.json().then((body: any) => {
          try {
            const user = createUser(body.username, body.password)
            return Response.json({ ok: true, id: user.id, username: user.username })
          } catch (e: any) {
            return Response.json({ error: e.message }, { status: e.message === 'username taken' ? 409 : 400 })
          }
        })
      }

      return new Response('not found', { status: 404 })
    },
  })
  console.log(`[http] listening on :${HTTP_PORT} (/register, /health)`)
}

// ── SSH ───────────────────────────────────────────────

async function startSsh() {
  const hostKey = await getHostKey()

  const server = new SSHServer({ hostKeys: [hostKey] }, (client) => {
    let userId: string | null = null
    let username: string | null = null

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const ctxAny = ctx as any
        const user = authenticateUser(ctxAny.username, ctxAny.password)
        if (user) {
          userId = user.id
          username = user.username
          ctx.accept()
          return
        }
      }
      if (ctx.method === 'none') {
        return ctx.reject(['password'])
      }
      ctx.reject(['password'])
    })

    client.on('ready', () => {
      console.log(`[ssh] user=${username} connected`)
    })

    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (accept) => {
        const channel = accept()
        handleChannel(channel, userId!, username!)
      })
    })

    client.on('end', () => console.log(`[ssh] user=${username} disconnected`))
    client.on('error', (err) => console.error(`[ssh] error: ${err.message}`))
  })

  server.listen(SSH_PORT, '0.0.0.0', () => {
    console.log(`[ssh] listening on 0.0.0.0:${SSH_PORT}`)
  })

  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref() }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// ── Channel: the JSON pipe ────────────────────────────

function handleChannel(channel: any, userId: string, username: string) {
  const send = (resp: any) => {
    try { channel.write(JSON.stringify(resp) + '\n') } catch {}
  }

  const rl = createInterface({ input: channel })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let req: any
    try { req = JSON.parse(line) } catch {
      return send({ id: '?', status: 'error', error: 'bad json' })
    }

    try {
      await routeMethod(req, userId, send)
    } catch (e: any) {
      send({ id: req.id ?? '?', status: 'error', error: e?.message ?? String(e) })
    }
  })

  channel.on('close', () => {
    rl.close()
    console.log(`[ssh] channel closed user=${username}`)
  })

  // Send startup marker (same as JAR's "AnymeX Sidecar Process Started")
  channel.stderr.write(`AnymeX Bridge v2. user=${username}\n`)
}

// ── Method Router ─────────────────────────────────────

async function routeMethod(req: any, userId: string, send: (r: any) => void) {
  const { method, args = {}, id } = req

  // ── Forward to JAR (transparent proxy) ──
  if (JAR_METHODS.has(method)) {
    if (!jar.isPresent()) {
      return send({ id, status: 'error', error: 'runtime JAR not present on server' })
    }
    // Permission check: for extension methods, verify the user has the extension installed
    const extMethods = ['getPopular', 'getLatestUpdates', 'search', 'getDetail', 'getVideoList', 'getPageList', 'getFilterList', 'getPreference', 'setPreference']
    if (extMethods.includes(method) && args.pkgName) {
      if (!isInstalledForUser(userId, args.pkgName)) {
        return send({ id, status: 'error', error: `not installed: ${args.pkgName}` })
      }
    }

    // Stream methods (getVideoList can stream)
    const streamMethods = ['getVideoList']

    if (streamMethods.includes(method)) {
      const unsub = jar.onAnyLine((line: string) => {
        try {
          const resp = JSON.parse(line)
          if (resp.id === id) {
            send(resp)
            if (resp.status === 'completed' || resp.status === 'error') unsub()
          }
        } catch {}
      })
      jar.send({ method, args, id })
      return
    }

    // Normal request-response
    try {
      const resp = await jar.invoke(method, args, id)
      send(resp)
    } catch (e: any) {
      send({ id, status: 'error', error: e.message })
    }
    return
  }

  // ── Server-side management methods ──
  switch (method) {
    case 'ping':
      return send({ id, status: 'ok', data: { server: 'anymex-bridge', version: '2.0.0', jar: jar.isReady() } })

    case 'addRepo': {
      const { repoUrl, type } = args
      if (!repoUrl) return send({ id, status: 'error', error: 'repoUrl required' })
      const result = await addAndFetchRepo(repoUrl, userId)
      return send({ id, status: 'ok', data: { repo: result.repo, extensionCount: result.extensions.length } })
    }

    case 'removeRepo': {
      const { repoUrl } = args
      if (!repoUrl) return send({ id, status: 'error', error: 'repoUrl required' })
      removeRepo(repoUrl)
      return send({ id, status: 'ok', data: { removed: repoUrl } })
    }

    case 'listRepos': {
      const repos = listRepos()
      return send({ id, status: 'ok', data: repos })
    }

    case 'listAvailable': {
      const { type } = args
      let exts = listExtensions(type)
      // Mark which are installed for this user
      const installed = new Set(listInstalledForUser(userId).map((e: any) => e.id))
      exts = exts.map((e: any) => ({
        ...e,
        extra: typeof e.extra === 'string' ? JSON.parse(e.extra) : e.extra,
        installed: installed.has(e.id),
      }))
      return send({ id, status: 'ok', data: exts })
    }

    case 'listInstalled': {
      const { type } = args
      let exts = listInstalledForUser(userId, type)
      exts = exts.map((e: any) => ({
        ...e,
        extra: typeof e.extra === 'string' ? JSON.parse(e.extra) : e.extra,
      }))
      return send({ id, status: 'ok', data: exts })
    }

    case 'install': {
      const { extId } = args
      if (!extId) return send({ id, status: 'error', error: 'extId required' })
      if (!isInstalledForUser(userId, extId)) {
        const result = await installExtension(extId, userId)
        return send({ id, status: 'ok', data: result })
      }
      return send({ id, status: 'ok', data: { extId, alreadyInstalled: true } })
    }

    case 'uninstall': {
      const { extId } = args
      if (!extId) return send({ id, status: 'error', error: 'extId required' })
      await uninstallExtension(extId, userId)
      return send({ id, status: 'ok', data: { extId } })
    }

    default:
      send({ id, status: 'error', error: `unknown method: ${method}` })
  }
}

export { startSsh, startHttp }
