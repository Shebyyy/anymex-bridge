import { checkOrDownloadJar, isJarReady, stopSidecar, startSidecar, getJarMeta } from './jar.js'
import { existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Configurable interval (default: 6 hours)
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
let _timer: ReturnType<typeof setInterval> | null = null
let _running = false
let _nextCheckAt: number = 0

const JAR_PATH = join(import.meta.dir, 'jar-cache', 'anymex_desktop_runtime.jar')
const JAR_URL = 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/latest/download/anymex_desktop_runtime.jar'

/** Get the timestamp of the next scheduled check */
export function getNextCheckAt() { return _nextCheckAt }

/** Get the update interval in ms */
export function getIntervalMs() { return DEFAULT_INTERVAL_MS }

export function startAutoUpdate(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return

  console.log(`[auto-update] JAR auto-update enabled — checking every ${intervalMs / 3600000}h`)

  // First run after 2 min (let server stabilize)
  setTimeout(() => updateJar(), 120_000)

  _nextCheckAt = Date.now() + 120_000

  _timer = setInterval(() => {
    updateJar()
    _nextCheckAt = Date.now() + intervalMs
  }, intervalMs)
}

export function stopAutoUpdate() {
  if (_timer) { clearInterval(_timer); _timer = null }
}

/** Extract version tag from redirect URL */
function extractVersion(url: string): string {
  const match = url.match(/\/releases\/download\/([^/]+)\//i)
  return match ? match[1] : 'unknown'
}

/** Check what version the latest release is (without downloading) */
async function getLatestVersion(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch(JAR_URL, { redirect: 'manual' })
    let finalUrl = JAR_URL
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let current = res
      for (let i = 0; i < 10; i++) {
        const loc = current.headers.get('location')!
        finalUrl = new URL(loc, finalUrl).href
        current = await fetch(finalUrl, { redirect: 'manual' })
        if (current.status < 300 || current.status >= 400) break
      }
    }
    return { version: extractVersion(finalUrl), url: finalUrl }
  } catch {
    return null
  }
}

async function updateJar() {
  if (_running) {
    console.log('[auto-update] Already running, skipping')
    return
  }
  _running = true

  try {
    console.log('[auto-update] Checking for JAR update...')

    // Version-based check: compare current version with latest release
    const meta = getJarMeta()
    const latest = await getLatestVersion()

    if (latest && meta.version !== 'unknown' && meta.version === latest.version) {
      console.log(`[auto-update] JAR already up to date (v${meta.version})`)
      return
    }

    if (latest) {
      console.log(`[auto-update] New version available: v${latest.version} (current: v${meta.version})`)
    } else {
      console.log(`[auto-update] Could not determine latest version, checking by download...`)
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

    console.log(`[auto-update] JAR updated successfully to v${result.version || 'unknown'}`)

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
