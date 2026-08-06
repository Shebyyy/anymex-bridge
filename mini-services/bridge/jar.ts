import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const DATA_DIR = join(import.meta.dir, '..', 'data')
mkdirSync(DATA_DIR, { recursive: true })
const JAR_PATH = join(DATA_DIR, 'anymex_desktop_runtime.jar')

// ── JAR auto-download from GitHub ───────────────────────
const GITHUB_REPO = 'keiyoushi/extensions-sources'

async function getLatestJarUrl(): Promise<{ url: string; tag: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
    if (!res.ok) return null
    const release = await res.json() as any
    const asset = release.assets?.find((a: any) => a.name === 'anymex_desktop_runtime.jar')
    if (!asset) return null
    return { url: asset.browser_download_url, tag: release.tag_name }
  } catch {
    return null
  }
}

async function downloadJar(url: string): Promise<boolean> {
  console.log(`[jar] downloading from ${url}...`)
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    writeFileSync(JAR_PATH + '.tmp', Buffer.from(buf))
    // Verify it's a valid JAR (starts with PK)
    const header = Buffer.from(buf, 0, 2)
    if (header[0] !== 0x50 || header[1] !== 0x4B) {
      console.error('[jar] downloaded file is not a valid JAR/ZIP')
      return false
    }
    // Atomic rename
    const { renameSync } = await import('node:fs')
    renameSync(JAR_PATH + '.tmp', JAR_PATH)
    const mb = (Buffer.byteLength(buf) / 1024 / 1024).toFixed(1)
    console.log(`[jar] downloaded ${mb}MB`)
    return true
  } catch (e: any) {
    console.error(`[jar] download failed: ${e.message}`)
    return false
  }
}

export async function checkJarUpdate(): Promise<boolean> {
  const release = await getLatestJarUrl()
  if (!release) {
    console.log('[jar] could not check for updates')
    return false
  }
  // Store current version
  const versionFile = join(DATA_DIR, 'jar-version.txt')
  const currentVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : ''
  if (currentVersion === release.tag) {
    console.log(`[jar] already up to date: ${release.tag}`)
    return false
  }
  const ok = await downloadJar(release.url)
  if (ok) {
    writeFileSync(versionFile, release.tag)
    console.log(`[jar] updated to ${release.tag}`)
  }
  return ok
}

// ── JAR Process Manager ─────────────────────────────────

type LineHandler = (line: string) => void

class JarRunner {
  private proc: ChildProcess | null = null
  private ready = false
  private lineHandlers: Map<string, LineHandler> = new Map()
  private globalHandlers: Set<LineHandler> = new Set()
  private pendingResolve: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: any }> = new Map()
  private startPromise: Promise<void> | null = null

  isPresent() { return existsSync(JAR_PATH) }

  isReady() { return this.ready }

  /**
   * Start the JAR subprocess. Safe to call multiple times.
   */
  async ensureReady(): Promise<void> {
    if (this.ready && this.proc?.exitCode === null) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.start()
    return this.startPromise
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isPresent()) {
        reject(new Error('JAR not found. Run with --update-jar first.'))
        return
      }

      console.log('[jar] starting subprocess...')
      this.proc = spawn('java', [
        '-Dfile.encoding=UTF-8',
        '-Dsun.stdout.encoding=UTF-8',
        '-Dsun.stderr.encoding=UTF-8',
        '-Xms128m', '-Xmx512m',
        '-noverify',
        '-jar', JAR_PATH,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const proc = this.proc!
      let stderrBuf = ''

      // Read stdout line by line
      const onData = (chunk: Buffer) => {
        const str = chunk.toString('utf8')
        for (const line of str.split('\n')) {
          if (line.trim()) this.handleLine(line)
        }
      }
      proc.stdout?.on('data', onData)

      // Detect startup from stderr
      proc.stderr?.on('data', (chunk: Buffer) => {
        const str = chunk.toString('utf8')
        stderrBuf += str
        if (str.includes('AnymeX Sidecar Process Started') || str.includes('Started')) {
          console.log('[jar] sidecar ready')
          this.ready = true
          resolve()
        }
        // Log stderr for debugging
        process.stdout.write(`[jar:stderr] ${str}`)
      })

      proc.on('exit', (code) => {
        console.log(`[jar] process exited with code ${code}`)
        this.ready = false
        this.proc = null
        this.startPromise = null
        // Reject all pending
        for (const [id, p] of this.pendingResolve) {
          clearTimeout(p.timer)
          p.reject(new Error('JAR process died'))
        }
        this.pendingResolve.clear()
      })

      proc.on('error', (err) => {
        console.error(`[jar] process error: ${err.message}`)
        this.ready = false
        this.startPromise = null
        reject(err)
      })

      // Timeout: if not ready in 30s, resolve anyway (some JAR versions may not print the startup message)
      setTimeout(() => {
        if (!this.ready) {
          console.log('[jar] startup timeout (30s), assuming ready')
          this.ready = true
          resolve()
        }
      }, 30_000)
    })
  }

  /**
   * Send a JSON request and wait for the response with matching id.
   * Returns the parsed response data.
   */
  async invoke(method: string, args: Record<string, any>, id: string, timeoutMs = 60_000): Promise<any> {
    await this.ensureReady()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolve.delete(id)
        reject(new Error(`invoke timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pendingResolve.set(id, { resolve, reject, timer })
      this.sendRaw({ method, args, id })
    })
  }

  /**
   * Send a JSON request and stream responses back via callback.
   * The callback is called for each line with matching id.
   * Returns an unsubscribe function.
   */
  invokeStream(method: string, args: Record<string, any>, id: string, onChunk: (resp: any) => void): () => void {
    this.ensureReady() // fire and forget
    const handler = (line: string) => {
      try {
        const resp = JSON.parse(line)
        if (resp.id === id) {
          onChunk(resp)
          if (resp.status === 'completed' || resp.status === 'error') {
            unsub()
          }
        }
      } catch {}
    }
    this.lineHandlers.set(id, handler)
    this.sendRaw({ method, args, id })
    const unsub = () => this.lineHandlers.delete(id)
    return unsub
  }

  /**
   * Send raw JSON to JAR stdin.
   */
  send(data: any) {
    this.sendRaw(data)
  }

  private sendRaw(data: any) {
    if (!this.proc?.stdin?.writable) {
      console.error('[jar] cannot send: process not running')
      return
    }
    this.proc.stdin.write(JSON.stringify(data) + '\n')
  }

  private handleLine(line: string) {
    // Check pending promises first
    try {
      const resp = JSON.parse(line)
      const pending = this.pendingResolve.get(resp.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingResolve.delete(resp.id)
        if (resp.status === 'error') {
          pending.reject(new Error(resp.error || 'JAR error'))
        } else {
          pending.resolve(resp)
        }
        return
      }
      // Check stream handlers
      const handler = this.lineHandlers.get(resp.id)
      if (handler) {
        handler(line)
        return
      }
    } catch {}

    // Global handlers
    for (const h of this.globalHandlers) h(line)
  }

  /**
   * Register a global line handler (called for every stdout line not matched by id).
   */
  onAnyLine(handler: LineHandler): () => void {
    this.globalHandlers.add(handler)
    return () => this.globalHandlers.delete(handler)
  }

  getJarPath() { return JAR_PATH }
  getDataDir() { return DATA_DIR }
}

export const jar = new JarRunner()
