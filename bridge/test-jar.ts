import { startSidecar, stopSidecar, invokeJar, checkOrDownloadJar } from './jar.js'
import { initSchema } from './db.js'

async function main() {
  initSchema()

  const jarResult = await checkOrDownloadJar()
  if (!jarResult.ok) { console.error('JAR not available:', jarResult.error); process.exit(1) }

  console.log('=== Starting sidecar ===')
  const sidecar = await startSidecar()
  if (!sidecar.ok) { console.error('Sidecar failed:', sidecar.error); process.exit(1) }
  console.log('Sidecar started!')

  // Test 1: convertApk
  console.log('\n=== Test 1: convertApk (AnimeOnsen APK -> JAR) ===')
  try {
    const r = await invokeJar('convertApk', {
      apkPath: '/home/z/my-project/bridge/extensions/eu.kanade.tachiyomi.animeextension.all.animeonsen.apk',
      outJarPath: '/home/z/my-project/bridge/extensions/eu.kanade.tachiyomi.animeextension.all.animeonsen.jar',
    }, 120000)
    console.log('Result:', JSON.stringify(r))
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 2: loadExtensions
  console.log('\n=== Test 2: loadExtensions ===')
  try {
    const r = await invokeJar('loadExtensions', {
      folderPath: '/home/z/my-project/bridge/extensions',
    }, 60000)
    console.log('Loaded', Array.isArray(r) ? r.length + ' extensions' : typeof r)
    if (Array.isArray(r)) {
      for (const ext of r) {
        console.log('  - [' + ext.type + '] ' + ext.name + ' (id: ' + ext.id + ', lang: ' + ext.lang + ')')
      }
    } else {
      console.log('  Raw:', JSON.stringify(r).substring(0, 500))
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 3: search
  console.log('\n=== Test 3: search (AnimeOnsen - gundam) ===')
  try {
    const r = await invokeJar('search', {
      sourceId: '8542735178285060053',
      isAnime: true,
      query: 'gundam',
      page: 1,
      filters: [],
    }, 60000)
    console.log('Result type:', typeof r, Array.isArray(r) ? 'array[' + r.length + ']' : '')
    console.log(JSON.stringify(r, null, 2)?.substring(0, 2000))
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 4: getPopular
  console.log('\n=== Test 4: getPopular (AnimeOnsen) ===')
  try {
    const r = await invokeJar('getPopular', {
      sourceId: '8542735178285060053',
      isAnime: true,
      page: 1,
    }, 60000)
    console.log('Result type:', typeof r)
    if (r && typeof r === 'object') {
      const list = r.list || r.results || []
      console.log('List length:', list.length)
      for (const item of list.slice(0, 3)) {
        console.log('  - ' + (item.name || item.title) + ' | ' + item.url)
      }
    } else {
      console.log(JSON.stringify(r)?.substring(0, 1000))
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 5: getDetail
  console.log('\n=== Test 5: getDetail ===')
  try {
    const popular = await invokeJar('getPopular', {
      sourceId: '8542735178285060053',
      isAnime: true,
      page: 1,
    }, 60000)
    const firstItem = popular?.list?.[0] || popular?.results?.[0]
    if (!firstItem) {
      console.log('No items to get detail for')
    } else {
      console.log('Getting detail for:', firstItem.name || firstItem.title)
      const r = await invokeJar('getDetail', {
        sourceId: '8542735178285060053',
        isAnime: true,
        media: {
          title: firstItem.title || firstItem.name,
          url: firstItem.url,
        },
      }, 60000)
      console.log('Detail type:', typeof r)
      if (r && typeof r === 'object') {
        console.log('Title:', r.title || r.name)
        console.log('Status:', r.status)
        const eps = r.episodes || r.chapterList || []
        console.log('Episodes:', eps.length)
        for (const ep of eps.slice(0, 3)) {
          console.log('  Ep: ' + (ep.name || ep.episodeNumber) + ' | ' + ep.url)
        }
      } else {
        console.log(JSON.stringify(r)?.substring(0, 1000))
      }
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 6: getFilterList
  console.log('\n=== Test 6: getFilterList ===')
  try {
    const r = await invokeJar('getFilterList', {
      sourceId: '8542735178285060053',
      isAnime: true,
    }, 30000)
    console.log('Filters:', Array.isArray(r) ? r.length + ' items' : typeof r)
    if (Array.isArray(r)) {
      for (const f of r.slice(0, 5)) {
        console.log('  - [' + f.type + '] ' + f.name)
      }
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  console.log('\n=== All tests complete ===')
  stopSidecar()
}

main().catch(e => { console.error('Fatal:', e); stopSidecar(); process.exit(1) })
