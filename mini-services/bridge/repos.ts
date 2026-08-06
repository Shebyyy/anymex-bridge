import { addUserRepo, getUserRepos, upsertExtension } from './db.js'

export interface ExtMeta {
  id: string
  name: string
  type: string       // 'aniyomi-anime' | 'aniyomi-manga' | 'cloudstream' | 'kotatsu'
  version?: string
  iconUrl?: string
  lang?: string
  isNsfw?: boolean
  downloadUrl?: string
  extra?: any        // type-specific fields
}

/**
 * Add a repo for a user, fetch its index, store extensions globally (deduped).
 */
export async function addAndFetchRepo(repoUrl: string, userId: string, type?: string): Promise<{ repoUrl: string; type: string; extensions: ExtMeta[] }> {
  // Detect type if not provided
  const detectedType = type || (await detectRepoType(repoUrl)).type

  // Store repo for this user
  addUserRepo(userId, repoUrl, detectedType)

  // Parse extensions from the index
  const extensions = await parseRepoIndex(repoUrl, detectedType)

  // Upsert each extension (global, deduped by id)
  for (const ext of extensions) {
    upsertExtension({
      id: ext.id,
      name: ext.name,
      type: ext.type,
      version: ext.version,
      icon_url: ext.iconUrl,
      lang: ext.lang,
      is_nsfw: ext.isNsfw,
      extra: ext.extra,
    })
  }

  return { repoUrl, type: detectedType, extensions }
}

/**
 * Get extensions available to a user (from their repos only).
 * We re-fetch their repo indexes and return extensions.
 */
export async function getAvailableForUser(userId: string): Promise<ExtMeta[]> {
  const userRepos = getUserRepos(userId)
  const allExts: ExtMeta[] = []

  for (const repo of userRepos) {
    try {
      const exts = await parseRepoIndex(repo.url, repo.type)
      allExts.push(...exts)
    } catch (e: any) {
      console.error(`[repos] failed to fetch ${repo.url}: ${e.message}`)
    }
  }

  // Dedup by id
  const seen = new Set<string>()
  return allExts.filter(e => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
}

// ── Detection ──────────────────────────────────────────

async function detectRepoType(url: string): Promise<{ type: string }> {
  const u = url.toLowerCase()
  if (u.includes('cloudstream') || u.includes('cloudstream-extensions')) {
    return { type: 'cloudstream' }
  }
  if (u.includes('kotatsu')) {
    return { type: 'kotatsu' }
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('octet-stream') || url.endsWith('.jar')) {
      return { type: 'kotatsu' }
    }
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      if (Array.isArray(json)) {
        if (json[0]?.url || json[0]?.internalName) return { type: 'cloudstream' }
        if (json[0]?.apk || json[0]?.pkg) return { type: 'aniyomi-anime' }
      }
      if (json.pluginLists) return { type: 'cloudstream' }
    } catch {}
    return { type: 'aniyomi-anime' }
  } catch {
    return { type: 'aniyomi-anime' }
  }
}

// ── Parsing ────────────────────────────────────────────

async function parseRepoIndex(url: string, type: string): Promise<ExtMeta[]> {
  try {
    switch (type) {
      case 'cloudstream':
        return parseCloudStreamRepo(url)
      case 'kotatsu':
        return parseKotatsuRepo(url)
      case 'aniyomi-anime':
      case 'aniyomi-manga':
        return parseAniyomiRepo(url, type)
      default:
        return []
    }
  } catch (e: any) {
    console.error(`[repos] failed to parse ${url}: ${e.message}`)
    return []
  }
}

async function parseCloudStreamRepo(url: string): Promise<ExtMeta[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  const json = JSON.parse(text)

  if (json.pluginLists && Array.isArray(json.pluginLists)) {
    const all: ExtMeta[] = []
    for (const subUrl of json.pluginLists) {
      try { all.push(...await parseCloudStreamRepo(subUrl)) } catch {}
    }
    return all
  }

  if (!Array.isArray(json)) return []
  const baseRepo = url.substring(0, url.lastIndexOf('/') + 1)

  return json
    .filter((p: any) => p.internalName)
    .map((p: any) => ({
      id: p.internalName,
      name: p.name || p.internalName,
      type: 'cloudstream' as const,
      version: p.version,
      iconUrl: p.iconUrl,
      lang: p.language,
      isNsfw: p.isNsfw || false,
      downloadUrl: p.url || `${baseRepo}${p.internalName}.cs3`,
      extra: { internalName: p.internalName, hasSettings: p.hasSettings },
    }))
}

function parseKotatsuRepo(url: string): ExtMeta[] {
  return [{
    id: 'kotatsu-' + hashUrl(url),
    name: 'Kotatsu Plugins',
    type: 'kotatsu',
    downloadUrl: url,
    extra: { jarUrl: url },
  }]
}

async function parseAniyomiRepo(url: string, type: string): Promise<ExtMeta[]> {
  let jsonUrl = url
  if (!url.endsWith('.json') && !url.endsWith('.min.json')) {
    const base = url.endsWith('/') ? url : url + '/'
    jsonUrl = base + 'index.min.json'
  }

  try {
    const res = await fetch(jsonUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (!Array.isArray(json)) return []

    const baseRepo = jsonUrl.substring(0, jsonUrl.lastIndexOf('/') + 1)

    return json
      .filter((e: any) => e.pkg)
      .map((e: any) => {
        const nameStr = (e.name || '').toLowerCase()
        const pkgStr = (e.pkg || '').toLowerCase()
        const isAnime = nameStr.startsWith('aniyomi:') || pkgStr.includes('.anime.') ||
                       !nameStr.startsWith('tachiyomi:') && !pkgStr.includes('.manga.')
        const extType = type === 'aniyomi-manga' ? 'aniyomi-manga' :
                       (isAnime ? 'aniyomi-anime' : 'aniyomi-manga')

        return {
          id: e.pkg,
          name: e.name || e.pkg,
          type: extType,
          version: e.version,
          iconUrl: `${baseRepo}icon/${e.pkg}.png`,
          lang: e.lang,
          isNsfw: e.isNsfw || false,
          downloadUrl: `${baseRepo}apk/${e.apk}`,
          extra: { apkName: e.apk, sources: e.sources || [] },
        } as ExtMeta
      })
  } catch (e: any) {
    console.error(`[repos] aniyomi JSON parse failed (${jsonUrl}): ${e.message}`)
    return []
  }
}

function hashUrl(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
