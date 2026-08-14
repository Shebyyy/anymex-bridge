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

  // Test 1: convertApk (APK -> JAR for aniyomi)
  console.log('\n=== Test 1: convertApk ===')
  try {
    const r = await invokeJar('convertApk', {
      apkPath: '/home/z/my-project/bridge/extensions/eu.kanade.tachiyomi.animeextension.all.animeonsen.apk',
      outJarPath: '/home/z/my-project/bridge/extensions/eu.kanade.tachiyomi.animeextension.all.animeonsen.jar',
    }, 120000)
    console.log('OK:', JSON.stringify(r))
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 2: loadExtensions
  console.log('\n=== Test 2: loadExtensions ===')
  let sourceId = '8542735178285060053'
  try {
    const r = await invokeJar('loadExtensions', {
      folderPath: '/home/z/my-project/bridge/extensions',
    }, 60000)
    if (Array.isArray(r)) {
      console.log('Loaded', r.length, 'extensions:')
      for (const ext of r) {
        console.log('  [' + (ext.type||'?') + '] ' + (ext.name||'?') + ' id=' + (ext.id||'?') + ' lang=' + (ext.lang||'?'))
        if (ext.id === sourceId || ext.name?.includes('AnimeOnsen')) {
          sourceId = ext.id || sourceId
          console.log('  ^^^ using this sourceId')
        }
      }
    } else {
      console.log('Unexpected:', typeof r, JSON.stringify(r)?.substring(0, 500))
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 3: search
  console.log('\n=== Test 3: search (gundam) ===')
  try {
    const r = await invokeJar('search', {
      sourceId: sourceId,
      isAnime: true,
      query: 'gundam',
      page: 1,
      filters: [],
    }, 60000)
    console.log('Type:', typeof r, Array.isArray(r) ? 'Array[' + r.length + ']' : '')
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const list = r.list || r.results || r.episodes || []
      console.log('Items:', list.length)
      for (const item of (list as any[]).slice(0, 3)) {
        console.log('  -', item.title || item.name, '|', item.url)
      }
    } else if (Array.isArray(r)) {
      console.log('Items:', r.length)
      for (const item of r.slice(0, 3)) {
        console.log('  -', item.title || item.name, '|', item.url)
      }
    } else {
      console.log(JSON.stringify(r)?.substring(0, 1500))
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 4: getPopular
  console.log('\n=== Test 4: getPopular ===')
  try {
    const r = await invokeJar('getPopular', {
      sourceId: sourceId,
      isAnime: true,
      page: 1,
    }, 60000)
    if (r && typeof r === 'object') {
      const list = r.list || r.results || []
      console.log('Items:', list.length)
      for (const item of (list as any[]).slice(0, 3)) {
        console.log('  -', item.title || item.name, '|', item.url)
      }
    } else {
      console.log(JSON.stringify(r)?.substring(0, 1500))
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 5: getDetail
  console.log('\n=== Test 5: getDetail ===')
  try {
    const pop = await invokeJar('getPopular', { sourceId, isAnime: true, page: 1 }, 60000)
    const first = pop?.list?.[0] || pop?.results?.[0]
    if (!first) { console.log('No item to detail') }
    else {
      console.log('Detail for:', first.title || first.name, first.url)
      const r = await invokeJar('getDetail', {
        sourceId, isAnime: true,
        media: { title: first.title || first.name, url: first.url },
      }, 60000)
      if (r && typeof r === 'object') {
        console.log('Title:', r.title || r.name)
        const eps = r.episodes || r.chapterList || []
        console.log('Episodes:', eps.length)
        for (const ep of (eps as any[]).slice(0, 3)) {
          console.log('  ep:', ep.name || ep.episodeNumber, '|', ep.url)
        }
      } else {
        console.log(JSON.stringify(r)?.substring(0, 1500))
      }
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 6: getFilterList
  console.log('\n=== Test 6: getFilterList ===')
  try {
    const r = await invokeJar('getFilterList', { sourceId, isAnime: true }, 30000)
    if (Array.isArray(r)) {
      console.log('Filters:', r.length)
      for (const f of r.slice(0, 5)) {
        console.log('  [' + (f.type||'?') + ']', f.name)
      }
    } else {
      console.log(JSON.stringify(r)?.substring(0, 500))
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  // Test 7: getVideoList
  console.log('\n=== Test 7: getVideoList ===')
  try {
    const pop = await invokeJar('getPopular', { sourceId, isAnime: true, page: 1 }, 60000)
    const first = pop?.list?.[0] || pop?.results?.[0]
    if (!first) { console.log('No item') }
    else {
      const det = await invokeJar('getDetail', {
        sourceId, isAnime: true,
        media: { title: first.title || first.name, url: first.url },
      }, 60000)
      const ep = (det?.episodes || det?.chapterList || [])[0]
      if (!ep) { console.log('No episode') }
      else {
        console.log('Video for ep:', ep.name || ep.episodeNumber)
        const r = await invokeJar('getVideoList', {
          sourceId, isAnime: true,
          episode: { name: ep.name, url: ep.url, date_upload: ep.dateUpload, description: ep.description, episode_number: ep.episodeNumber, scanlator: ep.scanlator },
        }, 60000)
        if (Array.isArray(r)) {
          console.log('Videos:', r.length)
          for (const v of r.slice(0, 3)) {
            console.log('  -', v.quality || v.qualityLabel, v.url?.substring(0, 80))
          }
        } else {
          console.log(JSON.stringify(r)?.substring(0, 1500))
        }
      }
    }
  } catch(e: any) { console.error('FAILED:', e.message) }

  console.log('\n=== Done ===')
  stopSidecar()
}

main().catch(e => { console.error('Fatal:', e); stopSidecar(); process.exit(1) })
