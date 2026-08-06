import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'

const JAR_DIR = join(import.meta.dir, 'jar-cache')
mkdirSync(JAR_DIR, { recursive: true })

const JAR_PATH = join(JAR_DIR, 'anymex_desktop_runtime.jar')
const GITHUB_REPO = 'RyanYuuki/AnymeXExtensionRuntimeBridge'

// Direct download URLs to try (no API needed, avoids rate limits)
const ASSET_CANDIDATES = [
  'anymex_desktop_runtime.jar',
  'runtime.jar',
  'AnymeXExtensionRuntimeBridge.jar',
  'desktop-runtime.jar',
]

let jarReady = false

export function isJarReady() { return jarReady }
export function getJarPath() { return JAR_PATH }

export async function checkOrDownloadJar(): Promise<{ ok: boolean; error?: string; path?: string }> {
  if (existsSync(JAR_PATH)) {
    jarReady = true
    return { ok: true, path: JAR_PATH }
  }

  console.log('[jar] Downloading latest runtime JAR from', GITHUB_REPO)

  // Strategy 1: Try direct download URLs (no API rate limit)
  for (const asset of ASSET_CANDIDATES) {
    const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/${asset}`
    try {
      console.log(`[jar] Trying: ${url}`)
      const res = await fetch(url, { redirect: 'follow' })
      if (res.ok && res.url.includes('github.com') || res.url.includes('objects.githubusercontent.com')) {
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('json') || ct.includes('html')) {
          console.log(`[jar] Not a binary file, skipping`)
          continue
        }
        const buf = await res.arrayBuffer()
        if (buf.byteLength < 1000) {
          console.log(`[jar] Too small (${buf.byteLength}B), not a JAR`)
          continue
        }
        const tmpPath = JAR_PATH + '.tmp'
        writeFileSync(tmpPath, new Uint8Array(buf))
        renameSync(tmpPath, JAR_PATH)
        jarReady = true
        console.log(`[jar] Downloaded: ${asset} (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB)`)
        return { ok: true, path: JAR_PATH }
      }
    } catch (e: any) {
      console.log(`[jar] Failed ${asset}: ${e.message}`)
    }
  }

  // Strategy 2: GitHub API (may hit rate limit)
  try {
    console.log('[jar] Trying GitHub API...')
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'anymex-bridge/2.0', 'Accept': 'application/vnd.github.v3+json' }
    })
    if (res.ok) {
      const release = await res.json() as any
      const assets: any[] = release.assets || []
      const jarAsset = assets.find((a: any) => a.name.endsWith('.jar'))
      if (jarAsset) {
        console.log(`[jar] API found: ${jarAsset.name} in ${release.tag_name}`)
        const dlRes = await fetch(jarAsset.browser_download_url)
        if (dlRes.ok) {
          const buf = await dlRes.arrayBuffer()
          const tmpPath = JAR_PATH + '.tmp'
          writeFileSync(tmpPath, new Uint8Array(buf))
          renameSync(tmpPath, JAR_PATH)
          jarReady = true
          return { ok: true, path: JAR_PATH }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[jar] API failed: ${e.message}`)
  }

  return { ok: false, error: 'Could not download JAR from any source' }
}

// Invoke JAR with SidecarBridge JSON protocol
export function invokeJar(method: string, args: Record<string, any>, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!jarReady || !existsSync(JAR_PATH)) {
      return reject(new Error('JAR not available'))
    }

    const id = crypto.randomUUID()
    const request = JSON.stringify({ method, args, id }) + '\n'

    const proc = spawn('java', ['-jar', JAR_PATH], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`JAR timeout (${timeoutMs}ms) for method: ${method}`))
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
            if (resp.status === 'ok') resolve(resp.data)
            else reject(new Error(resp.error || 'JAR method failed'))
            return
          }
        } catch {}
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      console.error('[jar stderr]', chunk.toString())
    })

    proc.on('close', (code: number) => {
      clearTimeout(timer)
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          if (resp.id === id) {
            if (resp.status === 'ok') resolve(resp.data)
            else reject(new Error(resp.error || 'JAR method failed'))
            return
          }
        } catch {}
      }
      reject(new Error(`JAR exited with code ${code}, no response for id ${id}`))
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(new Error(`JAR spawn error: ${err.message}`))
    })

    proc.stdin.write(request)
    proc.stdin.end()
  })
}
