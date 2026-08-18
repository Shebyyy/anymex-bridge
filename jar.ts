import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync, readFileSync } from 'node:fs'
import { spawn, ChildProcess } from 'node:child_process'

const JAR_DIR = join(import.meta.dir, 'jar-cache')
mkdirSync(JAR_DIR, { recursive: true })

const JAR_PATH = join(JAR_DIR, 'anymex_desktop_runtime.jar')
const META_PATH = join(JAR_DIR, 'jar-meta.json')
const JAR_URL = 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest/download/anymex_desktop_runtime.jar'

let jarReady = false
let _process: ChildProcess | null = null
const _completers = new Map<string, { resolve: (v: any) => void; reject: (v: any) => void; timer: ReturnType<typeof setTimeout> }>()
let _reqId = 0

// ── JAR Metadata (version, timestamps) ─────────────────────

interface JarMeta {
  version: string
  downloadUrl: string
  fileSize: number
  updatedAt: string
  previousVersion?: string
}

function loadMeta(): JarMeta {
  try {
    if (existsSync(META_PATH)) return JSON.parse(readFileSync(META_PATH, 'utf-8'))
  } catch {}
  return { version: 'unknown', downloadUrl: '', fileSize: 0, updatedAt: '' }
}

function saveMeta(meta: JarMeta) {
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2))
}

/** Extract version tag from URL, e.g. "/download/v2.5.1/" → "v2.5.1" */
function extractVersion(url: string): string {
  const match = url.match(/\/releases\/download\/([^/]+)\//i)
  return match ? match[1] : 'unknown'
}

/** Follow GitHub redirects and capture the version from intermediate URL.
 * Returns { version, downloadUrl (the github.com release URL) } */
async function resolveReleaseInfo(): Promise<{ version: string; releaseUrl: string }> {
  let version = 'unknown'
  let releaseUrl = JAR_URL
  try {
    let current = await fetch(JAR_URL, { redirect: 'manual' })
    let url = JAR_URL
    for (let i = 0; i < 10; i++) {
      if (current.status < 300 || current.status >= 400) break
      const loc = current.headers.get('location')!
      url = new URL(loc, url).href
      // Check THIS redirect URL for the version tag (it's in the github.com redirect, not the CDN)
      const v = extractVersion(url)
      if (v !== 'unknown') {
        version = v
        releaseUrl = url // store the clean github.com URL, not the CDN blob
      }
      current = await fetch(url, { redirect: 'manual' })
    }
  } catch (e: any) {
    console.log(`[jar] Redirect resolution failed: ${e.message}`)
  }
  return { version, releaseUrl }
}

export function isJarReady() { return jarReady && _process !== null && !_process.killed }
export function getJarPath() { return JAR_PATH }
export function getJarMeta() { return loadMeta() }
export { resolveReleaseInfo }

// ─── Download ──────────────────────────────────────────────

export async function checkOrDownloadJar(): Promise<{ ok: boolean; error?: string; path?: string; version?: string }> {
  if (existsSync(JAR_PATH) && statSync(JAR_PATH).size > 10000) {
    jarReady = true
    // If we already have meta, just return it
    const existing = loadMeta()
    if (existing.version !== 'unknown') return { ok: true, path: JAR_PATH, version: existing.version }
  }

  console.log('[jar] Downloading:', JAR_URL)
  try {
    // Resolve version from redirect chain FIRST (before actual download)
    const release = await resolveReleaseInfo()

    // Download with automatic redirects
    const downloadRes = await fetch(JAR_URL, { redirect: 'follow' })
    if (!downloadRes.ok) return { ok: false, error: `HTTP ${downloadRes.status}` }

    const buf = await downloadRes.arrayBuffer()
    if (buf.byteLength < 10000) return { ok: false, error: `Too small: ${buf.byteLength}B` }

    const tmpPath = JAR_PATH + '.tmp'
    writeFileSync(tmpPath, new Uint8Array(buf))
    if (existsSync(JAR_PATH)) unlinkSync(JAR_PATH)
    renameSync(tmpPath, JAR_PATH)

    // Save metadata with clean release URL
    const oldMeta = loadMeta()
    const meta: JarMeta = {
      version: release.version,
      downloadUrl: release.releaseUrl,
      fileSize: buf.byteLength,
      updatedAt: new Date().toISOString(),
      previousVersion: oldMeta.version !== 'unknown' ? oldMeta.version : undefined,
    }
    saveMeta(meta)

    jarReady = true
    console.log(`[jar] Downloaded: ${release.version} (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB)`)
    return { ok: true, path: JAR_PATH, version: release.version }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ─── Persistent Sidecar Process ────────────────────────────
// Matches the Dart SidecarBridge.dart protocol exactly:
//   stdin:  {"method":"...","args":{...},"id":"..."}\n
//   stderr: JSON responses + log lines (JAR redirects stdout to stderr)
//   stdout: (unused - JAR says it redirects to stderr for IPC safety)

export async function startSidecar(): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(JAR_PATH)) {
    return { ok: false, error: 'JAR file not found, download first' }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('java', [
      '-Dfile.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8',
      '-Xms128m',
      '-Xmx512m',
      '-noverify',
      '-jar', JAR_PATH,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let started = false
    const startupTimer = setTimeout(() => {
      if (!started) {
        console.log('[jar] Startup signal not received, continuing anyway')
        started = true
        _process = proc
        jarReady = true
        resolve({ ok: true })
      }
    }, 10000)

    // Line buffers to handle chunked TCP output
    let stderrBuf = ''
    let stdoutBuf = ''

    function tryHandleJson(line: string): boolean {
      if (!line.trim()) return false
      try {
        const resp = JSON.parse(line)
        const id = resp.id?.toString()
        const data = resp.data
        if (id && _completers.has(id)) {
          const c = _completers.get(id)!
          clearTimeout(c.timer)
          _completers.delete(id)
          c.resolve(data)
          return true
        }
        return false
      } catch {
        return false
      }
    }

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop() || '' // keep incomplete last line
      for (const line of lines) {
        if (tryHandleJson(line)) continue
        // Not a matched response — it's a log line
        console.log('[sidecar]', line.trimEnd())
        if (line.includes('AnymeX Sidecar Process Started') && !started) {
          started = true
          clearTimeout(startupTimer)
          _process = proc
          jarReady = true
          console.log('[sidecar] Process started')
          resolve({ ok: true })
        }
      }
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() || ''
      for (const line of lines) {
        tryHandleJson(line)
      }
    })

    proc.on('close', (code) => {
      console.log(`[sidecar] Process exited with code ${code}`)
      jarReady = false
      _process = null
      for (const [id, c] of _completers) {
        clearTimeout(c.timer)
        c.reject(new Error(`Sidecar process exited (code ${code})`))
      }
      _completers.clear()
    })

    proc.on('error', (err) => {
      console.error('[sidecar] Spawn error:', err.message)
      clearTimeout(startupTimer)
      if (!started) {
        reject(new Error(`Failed to start JAR: ${err.message}`))
      }
    })

    _process = proc
  })
}

export function stopSidecar() {
  if (_process && !_process.killed) {
    _process.stdin?.write(JSON.stringify({ method: 'shutdown', args: {} }) + '\n')
    setTimeout(() => { try { _process?.kill() } catch {} }, 2000)
  }
  _process = null
  jarReady = false
}

// ─── Invoke Method (persistent process) ────────────────────

export function invokeJar(method: string, args: Record<string, any>, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!isJarReady() || !_process) {
      return reject(new Error('Sidecar process not running'))
    }

    const id = String(++_reqId)
    const timer = setTimeout(() => {
      _completers.delete(id)
      try {
        _process?.stdin?.write(JSON.stringify({ method: 'cancel', args: { id } }) + '\n')
      } catch {}
      reject(new Error(`Request "${method}" (id: ${id}) timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    _completers.set(id, { resolve, reject, timer })

    const request = JSON.stringify({ method, args, id })
    _process.stdin!.write(request + '\n')
  })
}

// ─── Fallback: spawn per-request (if sidecar not started) ─

export function invokeJarOnce(method: string, args: Record<string, any>, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!existsSync(JAR_PATH)) {
      return reject(new Error('JAR not available'))
    }

    const id = String(++_reqId)
    const request = JSON.stringify({ method, args, id }) + '\n'

    const proc = spawn('java', [
      '-Dfile.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8',
      '-Xms128m', '-Xmx512m', '-noverify',
      '-jar', JAR_PATH,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`One-shot JAR timeout (${timeoutMs}ms) for: ${method}`))
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          if (resp.id === id) {
            clearTimeout(timer)
            proc.kill()
            resolve(resp.data)
            return
          }
        } catch {}
      }
    })

    proc.stderr.on('data', (c: Buffer) => console.error('[jar stderr]', c.toString()))

    proc.on('close', () => {
      clearTimeout(timer)
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          if (resp.id === id) { resolve(resp.data); return }
        } catch {}
      }
      reject(new Error(`JAR exited, no response for ${method}`))
    })

    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.stdin.write(request)
    proc.stdin.end()
  })
}
