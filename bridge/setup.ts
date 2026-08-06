// One-shot setup: creates user, adds repos, installs extensions
// Run: bun run setup.ts

import { initSchema, createUser, getStats, getAllExtensions } from './db.js'
import { addRepo } from './repos.js'
import { installExtension } from './extensions.js'

const REPOS = [
  'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json',
  'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb',
]

async function main() {
  console.log('=== Bridge Setup ===')
  initSchema()

  // Register user
  const user = createUser('testuser', 'test1234')
  if (user.ok) {
    console.log(`[setup] Created user: ${user.user!.username} (${user.user!.id})`)
  } else {
    console.log(`[setup] User exists or error: ${user.error}`)
    // Still need a user id, look it up
  }
  const uid = user.user?.id || 'testuser'

  // Add repos
  for (const repoUrl of REPOS) {
    console.log(`\n[setup] Adding repo: ${repoUrl}`)
    try {
      const result = await addRepo(uid, repoUrl)
      if (result.ok) {
        console.log(`  ✓ Repo added, ${result.extensions || 0} extensions cataloged`)
      } else {
        console.log(`  ✗ Failed: ${result.error}`)
      }
    } catch (e: any) {
      console.log(`  ✗ Error: ${e.message}`)
    }
  }

  // Show stats
  const stats = getStats()
  console.log(`\n=== Done ===`)
  console.log(`Users: ${stats.users} | Repos: ${stats.repos} | Extensions: ${stats.extensions} | Installs: ${stats.installs}`)

  // Install a few popular extensions
  const exts = getAllExtensions()
  if (exts.length > 0) {
    console.log(`\n[setup] Installing first 5 extensions for testuser...`)
    for (const ext of exts.slice(0, 5)) {
      console.log(`  Installing: ${ext.name} (${ext.type})`)
      try {
        const result = await installExtension(uid, ext.id)
        console.log(`    ${result.ok ? '✓' : '✗ ' + result.error}`)
      } catch (e: any) {
        console.log(`    ✗ ${e.message}`)
      }
    }
  }

  const finalStats = getStats()
  console.log(`\nFinal: ${finalStats.extensions} extensions, ${finalStats.installs} installed`)
}

main().catch(e => { console.error(e); process.exit(1) })
