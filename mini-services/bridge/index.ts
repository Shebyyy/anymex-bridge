import { startSsh, startHttp } from './ssh.js'
import { jar, checkJarUpdate } from './jar.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(import.meta.dir, '..', 'data')
mkdirSync(DATA_DIR, { recursive: true })

async function main() {
  console.log('═══ AnymeX Bridge Server v2 ═══')
  console.log(`[data] ${DATA_DIR}`)
  console.log(`[jar]  ${jar.isPresent() ? 'found' : 'NOT FOUND — will try to download'}`)

  // Auto-update JAR on startup (non-blocking, don't fail if can't download)
  if (!jar.isPresent()) {
    console.log('[jar] anymex_desktop_runtime.jar not found — extension methods will fail')
    console.log('[jar] Place it manually or start with --update-jar when GitHub is reachable')
    if (process.argv.includes('--update-jar')) {
      console.log('[jar] attempting download from GitHub releases...')
      await checkJarUpdate()
      if (jar.isPresent()) console.log('[jar] downloaded successfully')
    }
  } else if (process.argv.includes('--update-jar')) {
    console.log('[jar] checking for JAR update...')
    await checkJarUpdate()
  }

  // Start services regardless of JAR presence
  startHttp()
  startSsh()

  // Periodic JAR update check (every 6 hours)
  setInterval(async () => {
    console.log('[jar] periodic update check...')
    try {
      const updated = await checkJarUpdate()
      if (updated) {
        console.log('[jar] updated! Will use new version on next invoke.')
      }
    } catch (e: any) {
      console.error(`[jar] update check failed: ${e.message}`)
    }
  }, 6 * 60 * 60 * 1000)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
