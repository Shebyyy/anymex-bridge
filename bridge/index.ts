import { initSchema } from './db.js'
import { checkOrDownloadJar, isJarReady } from './jar.js'
import { startSshServer, startHttpServer } from './ssh.js'

const AUTO_UPDATE_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours

async function main() {
  console.log('=== AnymeX Bridge Server v2.0 ===')
  console.log('SSH: port 3022 | HTTP: port 8081')

  // Init DB
  initSchema()
  console.log('[db] Schema initialized')

  // Start servers
  startHttpServer()
  startSshServer()

  // Download JAR
  const jarResult = await checkOrDownloadJar()
  if (jarResult.ok) {
    console.log(`[jar] Ready: ${jarResult.path}`)
  } else {
    console.warn(`[jar] Not available: ${jarResult.error}`)
    console.warn('[jar] Management methods work fine. Extension methods require JAR.')
  }

  // Auto-update JAR every 6h
  setInterval(async () => {
    console.log('[jar] Auto-update check...')
    await checkOrDownloadJar()
  }, AUTO_UPDATE_INTERVAL)

  console.log('=== Bridge running ===')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
