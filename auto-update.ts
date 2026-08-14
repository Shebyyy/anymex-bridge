import { checkOrDownloadJar, isJarReady, stopSidecar, startSidecar } from './jar.js'
import { existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Configurable interval (default: 6 hours)
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

const JAR_PATH = join(import.meta.dir, 'jar-cache', 'anymex_desktop_runtime.jar')
const JAR_URL = 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest/download/anymex_desktop_runtime.jar'

export function startAutoUpdate(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return

  console.log(`[auto-update] JAR auto-update enabled — checking every ${intervalMs / 3600000}h`)

  // First run after 2 min (let server stabilize)
  setTimeout(() => updateJar(), 120_000)

  _timer = setInterval(() => updateJar(), intervalMs)
}

export function stopAutoUpdate() {
  if (_timer) { clearInterval(_timer); _timer = null }
}

async function updateJar() {
  if (_running) {
    console.log('[auto-update] Already running, skipping')
    return
  }
  _running = true

  try {
    console.log('[auto-update] Checking for JAR update...')

    // Check current file size
    const currentSize = existsSync(JAR_PATH) ? statSync(JAR_PATH).size : 0

    // Fetch latest release info (just headers to get size without downloading)
    try {
      const headRes = await fetch(JAR_URL, { method: 'HEAD', redirect: 'follow' })
      if (!headRes.ok) {
        console.log(`[auto-update] Failed to check: HTTP ${headRes.status}`)
        return
      }

      const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10)
      if (contentLength > 0 && contentLength === currentSize) {
        console.log(`[auto-update] JAR already up to date (${(currentSize / 1024 / 1024).toFixed(1)}MB)`)
        return
      }

      console.log(`[auto-update] New JAR available (${contentLength} bytes vs current ${currentSize})`)
    } catch (e: any) {
      console.log(`[auto-update] Size check failed, downloading anyway: ${e.message}`)
    }

    // Stop sidecar, download new JAR, restart
    const wasReady = isJarReady()
    if (wasReady) {
      console.log('[auto-update] Stopping sidecar for update...')
      stopSidecar()
      // Wait for process to fully stop
      await new Promise(r => setTimeout(r, 3000))
    }

    const result = await checkOrDownloadJar()
    if (!result.ok) {
      console.log(`[auto-update] Download failed: ${result.error}`)
      return
    }

    console.log(`[auto-update] JAR updated successfully`)

    // Restart sidecar if it was running before
    if (wasReady) {
      console.log('[auto-update] Restarting sidecar...')
      const started = await startSidecar()
      if (started.ok) {
        console.log('[auto-update] Sidecar restarted with new JAR')
      } else {
        console.error(`[auto-update] Failed to restart sidecar: ${started.error}`)
      }
    }
  } catch (e: any) {
    console.error(`[auto-update] Error: ${e.message}`)
  }

  _running = false
}

// Export for manual trigger
export { updateJar as runUpdateNow }
