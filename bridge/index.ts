import { initSchema } from './db.js'
import { checkOrDownloadJar, isJarReady, startSidecar, stopSidecar } from './jar.js'
import { startSshServer, startHttpServer } from './ssh.js'

const AUTO_UPDATE_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours

async function main() {
  console.log('=== AnymeX Bridge Server v2.0 ===')
  console.log('SSH: port 3022 | HTTP: port 8081')

  // Init DB
  initSchema()
  console.log('[db] Schema initialized')

  // Start servers first (so management methods work immediately)
  startHttpServer()
  startSshServer()

  // Download JAR
  const jarResult = await checkOrDownloadJar()
  if (jarResult.ok) {
    console.log(`[jar] Downloaded: ${jarResult.path}`)

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

  // Auto-update JAR every 6h
  setInterval(async () => {
    console.log('[jar] Auto-update check...')
    const result = await checkOrDownloadJar()
    if (result.ok && !isJarReady()) {
      await startSidecar()
    }
  }, AUTO_UPDATE_INTERVAL)

  // Graceful shutdown
  process.on('SIGINT', () => { stopSidecar(); process.exit(0) })
  process.on('SIGTERM', () => { stopSidecar(); process.exit(0) })

  console.log('=== Bridge running ===')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
