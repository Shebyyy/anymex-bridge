import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { spawn, ChildProcess } from 'node:child_process'

const JAR_DIR = join(import.meta.dir, 'jar-cache')
mkdirSync(JAR_DIR, { recursive: true })

const JAR_PATH = join(JAR_DIR, 'anymex_desktop_runtime.jar')
const JAR_URL = 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest/download/anymex_desktop_runtime.jar'

let jarReady = false
let _process: ChildProcess | null = null
const _completers = new Map<string, { resolve: (v: any) => void; reject: (v: any) => void; timer: ReturnType<typeof setTimeout> }>()
let _reqId = 0

export function isJarReady() { return jarReady && _process !== null && !_process.killed }
export function getJarPath() { return JAR_PATH }

// ─── Download ──────────────────────────────────────────────

export async function checkOrDownloadJar(): Promise<{ ok: boolean; error?: string; path?: string }> {
  if (existsSync(JAR_PATH) && statSync(JAR_PATH).size > 10000) {
    jarReady = true
    return { ok: true, path: JAR_PATH }
  }

  console.log('[jar] Downloading:', JAR_URL)
  try {
    const res = await fetch(JAR_URL, { redirect: 'follow' })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

    const buf = await res.arrayBuffer()
    if (buf.byteLength < 10000) return { ok: false, error: `Too small: ${buf.byteLength}B` }

    const tmpPath = JAR_PATH + '.tmp'
    writeFileSync(tmpPath, new Uint8Array(buf))
    if (existsSync(JAR_PATH)) unlinkSync(JAR_PATH)
    renameSync(tmpPath, JAR_PATH)

    jarReady = true
    console.log(`[jar] Downloaded: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`)
    return { ok: true, path: JAR_PATH }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// ─── Persistent Sidecar Process ────────────────────────────
// Matches the Dart SidecarBridge.dart protocol exactly:
//   stdin:  {"method":"...","args":{...},"id":"..."}\n
//   stderr: JSON responses + log lines
//   stdout: JSON responses

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
          // Check for error status
          if (resp.status === 'error') {
            c.reject(new Error(typeof data === 'string' ? data : JSON.stringify(data)))
          } else {
            c.resolve(data)
          }
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
      stderrBuf = lines.pop() || ''
      for (const line of lines) {
        if (tryHandleJson(line)) continue
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
      for (const [, c] of _completers) {
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
// If clientRequestId is provided, it's used as the JAR request ID
// so that cancel requests from the client can match.

export function invokeJar(method: string, args: Record<string, any>, options?: {
  timeoutMs?: number
  clientRequestId?: string
}): Promise<any> {
  const timeoutMs = options?.timeoutMs || 60000
  const id = options?.clientRequestId || String(++_reqId)

  return new Promise((resolve, reject) => {
    if (!isJarReady() || !_process) {
      return reject(new Error('Sidecar process not running'))
    }

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

// ─── Cancel a pending request on the sidecar ──────────────

export function cancelJarRequest(id: string): boolean {
  const c = _completers.get(id)
  if (c) {
    clearTimeout(c.timer)
    _completers.delete(id)
    c.reject(new Error('Request cancelled'))
  }
  if (_process && !_process.killed) {
    _process.stdin?.write(JSON.stringify({ method: 'cancel', args: { id } }) + '\n')
    return true
  }
  return false
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
    let stderr = ''
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
            if (resp.status === 'error') {
              reject(new Error(typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)))
            } else {
              resolve(resp.data)
            }
            return
          }
        } catch {}
      }
    })

    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
      // Also try parsing stderr for responses (JAR may redirect)
      for (const line of stderr.split('\n')) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          if (resp.id === id && resp.data !== undefined) {
            clearTimeout(timer)
            proc.kill()
            if (resp.status === 'error') {
              reject(new Error(typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)))
            } else {
              resolve(resp.data)
            }
            return
          }
        } catch {}
      }
    })

    proc.on('close', () => {
      clearTimeout(timer)
      // Final scan of all output
      for (const line of (stdout + '\n' + stderr).split('\n')) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          if (resp.id === id) {
            if (resp.status === 'error') {
              reject(new Error(typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)))
            } else {
              resolve(resp.data)
            }
            return
          }
        } catch {}
      }
      reject(new Error(`JAR exited, no response for ${method}`))
    })

    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.stdin.write(request)
    proc.stdin.end()
  })
}
