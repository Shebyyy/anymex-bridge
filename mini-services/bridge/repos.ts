import { getRepoByUrl, addRepo, upsertExtension } from './db.js'

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
 * Fetch a repo URL, detect its type, parse extensions, store in DB.
 * Returns the list of parsed extensions.
 */
export async function addAndFetchRepo(repoUrl: string, userId: string): Promise<{ repo: any; extensions: ExtMeta[] }> {
  // Try to detect type from URL or content
  const detected = await detectRepoType(repoUrl)
  const type = detected.type

  // Store repo globally
  const repo = addRepo(repoUrl, type, userId)

  // Parse extensions from the index
  const extensions = await parseRepoIndex(repoUrl, type)

  // Upsert each extension
  for (const ext of extensions) {
    upsertExtension({
      id: ext.id,
      name: ext.name,
      type,
      repo_id: repo.id,
      version: ext.version,
      icon_url: ext.iconUrl,
      lang: ext.lang,
      is_nsfw: ext.isNsfw,
      extra: ext.extra,
    })
  }

  return { repo, extensions }
}

// ── Detection ──────────────────────────────────────────

async function detectRepoType(url: string): Promise<{ type: string }> {
  // If URL contains known keywords
  const u = url.toLowerCase()
  if (u.includes('aniyomi')) {
    // Could be anime or manga — check by fetching
    const repo = getRepoByUrl(url)
    if (repo) return { type: repo.type }
    // Default: try fetching and see what we get
  }
  if (u.includes('cloudstream') || u.includes('cloudstream-extensions')) {
    return { type: 'cloudstream' }
  }
  if (u.includes('kotatsu')) {
    return { type: 'kotatsu' }
  }

  // Try to fetch and detect from content
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('octet-stream') || url.endsWith('.jar')) {
      return { type: 'kotatsu' }
    }
    const text = await res.text()
    // CloudStream: JSON array of plugins or meta-repo
    try {
      const json = JSON.parse(text)
      if (Array.isArray(json)) {
        if (json[0]?.url || json[0]?.internalName) return { type: 'cloudstream' }
        if (json[0]?.apk || json[0]?.pkg) return { type: 'aniyomi-anime' } // will refine below
        if (json[0]?.sourceCodeUrl) return { type: 'aniyomi-anime' } // could be sora/mangayomi
      }
      if (json.pluginLists) return { type: 'cloudstream' }
    } catch {}

    // Default to aniyomi-anime (most common)
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

/**
 * CloudStream repos are JSON arrays of plugins.
 * Supports meta-repos (object with pluginLists).
 */
async function parseCloudStreamRepo(url: string): Promise<ExtMeta[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  const json = JSON.parse(text)

  // Meta-repo: expand sub-repos
  if (json.pluginLists && Array.isArray(json.pluginLists)) {
    const all: ExtMeta[] = []
    for (const subUrl of json.pluginLists) {
      try {
        const sub = await parseCloudStreamRepo(subUrl)
        all.push(...sub)
      } catch {}
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

/**
 * Kotatsu repos are a single JAR URL. We represent it as one "extension" entry.
 */
function parseKotatsuRepo(url: string): ExtMeta[] {
  return [{
    id: 'kotatsu-' + hashUrl(url),
    name: 'Kotatsu Plugins',
    type: 'kotatsu',
    downloadUrl: url,
    extra: { jarUrl: url },
  }]
}

/**
 * Aniyomi repos are either protobuf (.pb/.pb.gz) or JSON (.min.json).
 * We try JSON first, fall back to raw URL for manual install.
 */
async function parseAniyomiRepo(url: string, type: string): Promise<ExtMeta[]> {
  // Try JSON format first
  let jsonUrl = url
  if (!url.endsWith('.json') && !url.endsWith('.min.json')) {
    // Try common JSON index paths
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
        // Detect anime vs manga from name prefix or pkg
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
          extra: {
            apkName: e.apk,
            sources: e.sources || [],
          },
        } as ExtMeta
      })
  } catch (e: any) {
    console.error(`[repos] aniyomi JSON parse failed (${jsonUrl}): ${e.message}`)
    // If JSON fails, it might be protobuf — we can't parse protobuf easily
    // Return empty and let user install manually
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
