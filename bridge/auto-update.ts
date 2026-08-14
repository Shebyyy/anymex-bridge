import { getAllRepos, refreshRepo } from './repos.js'
import { updateExtensions } from './extensions.js'

// Configurable interval (default: 6 hours)
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

export function startAutoUpdate(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return // already running

  console.log(`[auto-update] Enabled — checking every ${intervalMs / 3600000}h`)

  // First run after 30s (let server stabilize)
  setTimeout(() => runUpdateCycle(), 30_000)

  // Then on interval
  _timer = setInterval(() => runUpdateCycle(), intervalMs)
}

export function stopAutoUpdate() {
  if (_timer) { clearInterval(_timer); _timer = null }
}

async function runUpdateCycle() {
  if (_running) {
    console.log('[auto-update] Already running, skipping')
    return
  }
  _running = true

  const startTime = Date.now()
  let totalUpdated = 0
  let totalFailed = 0
  const allChangedIds: number[] = []

  try {
    const repos = getAllRepos()
    console.log(`[auto-update] Cycle start — ${repos.length} repos to check`)

    for (const repo of repos) {
      try {
        const result = await refreshRepo(repo.url, repo.type, repo.id)
        if (result.ok && result.updated?.length) {
          allChangedIds.push(...result.updated)
        }
      } catch (e: any) {
        console.error(`[auto-update] Repo error ${repo.url}: ${e.message}`)
      }

      // Small delay between repos to not hammer them
      await sleep(1000)
    }

    // Batch re-download all changed extensions
    if (allChangedIds.length > 0) {
      console.log(`[auto-update] ${allChangedIds.length} extensions have new versions, re-downloading...`)
      const result = await updateExtensions(allChangedIds)
      totalUpdated = result.updated
      totalFailed = result.failed
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[auto-update] Cycle done in ${elapsed}s — ${repos.length} repos checked, ${totalUpdated} extensions updated, ${totalFailed} failed`)

  } catch (e: any) {
    console.error(`[auto-update] Cycle error: ${e.message}`)
  }

  _running = false
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// Export for manual trigger (e.g. via SSH method)
export { runUpdateCycle as runUpdateNow }
