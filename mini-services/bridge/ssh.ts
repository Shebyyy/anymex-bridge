import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { createInterface } from 'node:readline'

import {
  authenticateUser, createUser, getUserRepos, removeUserRepo as dbRemoveUserRepo,
  listExtensions, listInstalledForUser, isInstalledForUser,
  listUsers as dbListUsers, getExtUserCount, db
} from './db.js'
import { addAndFetchRepo, getAvailableForUser } from './repos.js'
import { installExtension, uninstallExtension } from './extensions.js'
import { jar } from './jar.js'

const { Server: SSHServer } = ssh2

const DATA_DIR = join(import.meta.dir, '..', 'data')
const HOST_KEYS_DIR = join(DATA_DIR, 'host-keys')
mkdirSync(HOST_KEYS_DIR, { recursive: true })

const SSH_PORT = parseInt(process.env.SSH_PORT || '3022')
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8081')

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
  if (existsSync(KEY_PATH)) { cachedHostKey = readFileSync(KEY_PATH, 'utf8'); return cachedHostKey! }
  console.log('[ssh] generating host key (RSA)...')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  writeFileSync(KEY_PATH, pem, { mode: 0o600 })
  cachedHostKey = pem
  return cachedHostKey
}

// ── HTTP ──────────────────────────────────────────────

function startHttp() {
  const server = Bun.serve({
    port: HTTP_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/health') {
        const users = (db.query('SELECT COUNT(*) as c FROM users').get() as any).c
        const repos = (db.query('SELECT COUNT(*) as c FROM user_repos').get() as any).c
        const exts = (db.query('SELECT COUNT(*) as c FROM extensions').get() as any).c
        const installs = (db.query('SELECT COUNT(*) as c FROM user_extensions').get() as any).c
        return Response.json({ ok: true, jar: jar.isPresent(), jarReady: jar.isReady(), ssh: SSH_PORT, http: HTTP_PORT, users, repos, extensions: exts, installs })
      }

      if (url.pathname === '/data/users') {
        return Response.json(dbListUsers())
      }

      if (url.pathname === '/data/repos') {
        return Response.json(db.query('SELECT ur.user_id, ur.url, ur.type, ur.added, u.username FROM user_repos ur JOIN users u ON ur.user_id = u.id ORDER BY ur.added DESC').all())
      }

      if (url.pathname === '/data/extensions') {
        const type = url.searchParams.get('type')
        const exts = listExtensions(type || undefined).map((e: any) => ({
          ...e, extra: e.extra ? (typeof e.extra === 'string' ? JSON.parse(e.extra) : e.extra) : null,
          install_count: getExtUserCount(e.id),
        }))
        return Response.json(exts)
      }

      if (url.pathname === '/data/installs') {
        const installs = db.query(`
          SELECT ue.user_id, ue.ext_id, u.username, e.name as ext_name, e.type
          FROM user_extensions ue JOIN users u ON ue.user_id = u.id JOIN extensions e ON ue.ext_id = e.id
          ORDER BY u.username, e.name
        `).all()
        return Response.json(installs)
      }

      if (req.method === 'POST' && url.pathname === '/register') {
        return req.json().then((body: any) => {
          try { const user = createUser(body.username, body.password); return Response.json({ ok: true, id: user.id, username: user.username }) }
          catch (e: any) { return Response.json({ error: e.message }, { status: e.message === 'username taken' ? 409 : 400 }) }
        })
      }

      return new Response('not found', { status: 404 })
    },
  })
  console.log(`[http] listening on :${HTTP_PORT}`)
}

// ── SSH ───────────────────────────────────────────────

async function startSsh() {
  const hostKey = await getHostKey()
  const server = new SSHServer({ hostKeys: [hostKey] }, (client) => {
    let userId: string | null = null
    let username: string | null = null

    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        const u = authenticateUser((ctx as any).username, (ctx as any).password)
        if (u) { userId = u.id; username = u.username; ctx.accept(); return }
      }
      ctx.method === 'none' ? ctx.reject(['password']) : ctx.reject(['password'])
    })

    client.on('ready', () => console.log(`[ssh] user=${username} connected`))
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (accept) => { const ch = accept(); handleChannel(ch, userId!, username!) })
    })
    client.on('end', () => console.log(`[ssh] user=${username} disconnected`))
    client.on('error', (err) => console.error(`[ssh] error: ${err.message}`))
  })

  server.listen(SSH_PORT, '0.0.0.0', () => console.log(`[ssh] listening on 0.0.0.0:${SSH_PORT}`))
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref() }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// ── Channel: the JSON pipe ────────────────────────────

function handleChannel(channel: any, userId: string, username: string) {
  const send = (r: any) => { try { channel.write(JSON.stringify(r) + '\n') } catch {} }
  const rl = createInterface({ input: channel })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let req: any
    try { req = JSON.parse(line) } catch { return send({ id: '?', status: 'error', error: 'bad json' }) }
    try { await routeMethod(req, userId, send) } catch (e: any) { send({ id: req.id ?? '?', status: 'error', error: e?.message ?? String(e) }) }
  })
  channel.on('close', () => { rl.close() })
  channel.stderr.write(`AnymeX Bridge v2. user=${username}\n`)
}

// ── Method Router ─────────────────────────────────────

async function routeMethod(req: any, userId: string, send: (r: any) => void) {
  const { method, args = {}, id } = req

  // Forward to JAR
  if (JAR_METHODS.has(method)) {
    if (!jar.isPresent()) return send({ id, status: 'error', error: 'runtime JAR not present on server' })
    const extMethods = ['getPopular','getLatestUpdates','search','getDetail','getVideoList','getPageList','getFilterList','getPreference','setPreference']
    if (extMethods.includes(method) && args.pkgName && !isInstalledForUser(userId, args.pkgName)) {
      return send({ id, status: 'error', error: `not installed: ${args.pkgName}` })
    }
    if (method === 'getVideoList') {
      const unsub = jar.onAnyLine((line: string) => {
        try { const r = JSON.parse(line); if (r.id === id) { send(r); if (r.status === 'completed' || r.status === 'error') unsub() } } catch {}
      })
      jar.send({ method, args, id }); return
    }
    try { send(await jar.invoke(method, args, id)) } catch (e: any) { send({ id, status: 'error', error: e.message }) }
    return
  }

  // Server-side methods
  switch (method) {
    case 'ping': return send({ id, status: 'ok', data: { server: 'anymex-bridge', version: '2.0.0', jar: jar.isReady() } })

    case 'addRepo': {
      const { repoUrl, type } = args
      if (!repoUrl) return send({ id, status: 'error', error: 'repoUrl required' })
      const result = await addAndFetchRepo(repoUrl, userId, type)
      return send({ id, status: 'ok', data: { repoUrl: result.repoUrl, type: result.type, extensionCount: result.extensions.length } })
    }

    case 'removeRepo': {
      const { repoUrl } = args
      if (!repoUrl) return send({ id, status: 'error', error: 'repoUrl required' })
      dbRemoveUserRepo(userId, repoUrl)
      return send({ id, status: 'ok', data: { removed: repoUrl } })
    }

    case 'listRepos': {
      return send({ id, status: 'ok', data: getUserRepos(userId) })
    }

    case 'listAvailable': {
      const { type } = args
      const exts = await getAvailableForUser(userId)
      const filtered = type ? exts.filter(e => e.type === type) : exts
      const installed = new Set(listInstalledForUser(userId).map((e: any) => e.id))
      return send({ id, status: 'ok', data: filtered.map(e => ({ ...e, installed: installed.has(e.id) })) })
    }

    case 'listInstalled': {
      const { type } = args
      const exts = listInstalledForUser(userId, type)
      return send({ id, status: 'ok', data: exts.map((e: any) => ({ ...e, extra: typeof e.extra === 'string' ? JSON.parse(e.extra) : e.extra })) })
    }

    case 'install': {
      const { extId } = args
      if (!extId) return send({ id, status: 'error', error: 'extId required' })
      if (!isInstalledForUser(userId, extId)) { const r = await installExtension(extId, userId); return send({ id, status: 'ok', data: r }) }
      return send({ id, status: 'ok', data: { extId, alreadyInstalled: true } })
    }

    case 'uninstall': {
      const { extId } = args
      if (!extId) return send({ id, status: 'error', error: 'extId required' })
      await uninstallExtension(extId, userId)
      return send({ id, status: 'ok', data: { extId } })
    }

    default: send({ id, status: 'error', error: `unknown method: ${method}` })
  }
}

export { startSsh, startHttp }
