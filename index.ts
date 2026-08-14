import { initSchema } from './db.js'
import { checkOrDownloadJar, isJarReady, startSidecar, stopSidecar } from './jar.js'
import { startSshServer, startHttpServer } from './ssh.js'
import { startAutoUpdate, stopAutoUpdate } from './auto-update.js'

const JAR_UPDATE_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const EXT_UPDATE_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours

// ── Crash protection ────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason)
})

// Ignore SIGHUP so the process stays alive after parent shell exits
process.on('SIGHUP', () => {})

// Keep event loop alive even after main() resolves
process.stdin.resume()

async function main() {
  console.log('=== AnymeX Bridge Server v2.1 ===')
  console.log('SSH: port 3022 | HTTP: port 8082')

  // Init DB
  initSchema()
  console.log('[db] Schema initialized')

  // Start servers first (so management methods work immediately)
  startHttpServer()
  startSshServer()

  // Download JAR
  const jarResult = await checkOrDownloadJar()
  if (jarResult.ok) {
    console.log(`[jar] Ready: ${jarResult.path}`)

    // Start persistent sidecar process
    const sidecarResult = await startSidecar()
    if (sidecarResult.ok) {
      console.log('[jar] Sidecar process running')
    } else {
      console.warn(`[jar] Sidecar failed: ${sidecarResult.error} (will use one-shot fallback)`)
    }
  } else {
    console.warn(`[jar] Not available: ${jarResult.error}`)
    console.warn('[jar] Management methods work. Extension methods require JAR.')
  }

  // Auto-update extension plugins every 6h
  startAutoUpdate(EXT_UPDATE_INTERVAL)

  // Auto-update JAR every 6h
  setInterval(async () => {
    try {
      console.log('[jar] Auto-update check...')
      const result = await checkOrDownloadJar()
      if (result.ok && !isJarReady()) {
        await startSidecar()
      }
    } catch (e: any) {
      console.error('[jar] Auto-update error:', e.message)
    }
  }, JAR_UPDATE_INTERVAL)

  // Graceful shutdown
  process.on('SIGINT', () => { console.log('[shutdown] SIGINT'); stopSidecar(); stopAutoUpdate(); process.exit(0) })
  process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); stopSidecar(); stopAutoUpdate(); process.exit(0) })

  console.log('=== Bridge running ===')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
