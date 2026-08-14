import { db, addRepoForUser, markRepoFetched, upsertExtension } from './db.js'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const EXT_DIR = join(import.meta.dir, 'extensions')
mkdirSync(EXT_DIR, { recursive: true })

// ─── Types ──────────────────────────────────────────────────

export type RepoType = 'aniyomi' | 'cloudstream' | 'kotatsu'

export function detectRepoType(url: string): RepoType {
  if (url.endsWith('.jar')) return 'kotatsu'
  if (url.includes('index.pb') || url.includes('index.min.json') || url.includes('index.json')) return 'aniyomi'
  return 'cloudstream'
}

// Strip the index filename to get base URL (matches runtime exactly)
function getBaseUrl(repoUrl: string): string {
  return repoUrl
    .replace(/\/index\.min\.json$/, '')
    .replace(/\/index\.json$/, '')
    .replace(/\/index\.pb\.gz$/, '')
    .replace(/\/index\.pb$/, '')
}

// ─── Aniyomi ───────────────────────────────────────────────

interface AniyomiExt {
  name: string; pkg?: string; apk?: string; lang?: string;
  code?: number; version?: string; isNsfw?: boolean;
  sources?: { name: string; lang: string; id?: string | number; baseUrl?: string }[]
}

function getAniyomiType(ext: AniyomiExt): string {
  const pkg = ext.pkg || ''
  if (pkg.includes('.anime.')) return 'aniyomi-anime'
  if (pkg.includes('.manga.')) return 'aniyomi-manga'
  if (ext.name?.startsWith('Aniyomi: ')) return 'aniyomi-anime'
  if (ext.name?.startsWith('Tachiyomi: ')) return 'aniyomi-manga'
  return 'aniyomi-anime'
}

async function fetchAniyomiJson(url: string): Promise<AniyomiExt[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let data = bytes
  if (data.length >= 2 && data[0] === 0x1F && data[1] === 0x8B) {
    const decompressed = await decompressGzip(data)
    if (decompressed) data = decompressed
  }
  const isJson = data.length > 0 && (data[0] === 0x7B || data[0] === 0x5B)
  if (!isJson) throw new Error('Not JSON format')
  return JSON.parse(new TextDecoder().decode(data))
}

async function decompressGzip(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { DecompressionStream } = await import('node:stream/web')
    const ds = new DecompressionStream('gzip')
    const writer = ds.writable.getWriter()
    writer.write(data)
    writer.close()
    const reader = ds.readable.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { result.set(c, offset); offset += c.length }
    return result
  } catch { return null }
}

// Port of Dart PbDecoder — matches the runtime's custom protobuf format exactly
async function fetchAniyomiPb(url: string): Promise<AniyomiExt[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  let bytes = new Uint8Array(await res.arrayBuffer())

  if (bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
    const decompressed = await decompressGzip(bytes)
    if (decompressed) bytes = decompressed
  }

  const isJson = bytes.length > 0 && (bytes[0] === 0x7B || bytes[0] === 0x5B)
  if (isJson) {
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  return decodePbIndex(bytes)
}

// ─── Protobuf decoder (ported from Dart PbDecoder) ─────────

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0, shift = 0, pos = offset
  while (pos < bytes.length) {
    const b = bytes[pos++]
    result |= (b & 0x7F) << shift
    if ((b & 0x80) === 0) return [result, pos - offset]
    shift += 7
  }
  return [result, pos - offset]
}

function parseMessage(bytes: Uint8Array, start: number, end: number): Map<number, any[]> {
  const map = new Map<number, any[]>()
  let pos = start
  try {
    while (pos < end) {
      const [key, keyLen] = readVarint(bytes, pos)
      pos += keyLen
      const wireType = key & 0x7
      const fieldNum = key >> 3

      if (wireType === 0) {
        const [val, len] = readVarint(bytes, pos)
        pos += len
        if (!map.has(fieldNum)) map.set(fieldNum, [])
        map.get(fieldNum)!.push(val)
      } else if (wireType === 1) {
        pos += 8
      } else if (wireType === 2) {
        const [len, lenLen] = readVarint(bytes, pos)
        pos += lenLen
        const val = bytes.slice(pos, pos + len)
        pos += len
        if (!map.has(fieldNum)) map.set(fieldNum, [])
        map.get(fieldNum)!.push(val)
      } else if (wireType === 5) {
        pos += 4
      } else {
        break
      }
    }
  } catch {}
  return map
}

function getString(list: any[] | undefined): string {
  if (!list || list.length === 0) return ''
  try { return new TextDecoder().decode(list[0]) } catch { return '' }
}

function getInt(list: any[] | undefined): number {
  if (!list || list.length === 0) return 0
  return list[0] as number
}

function decodePbIndex(bytes: Uint8Array): AniyomiExt[] {
  const rootMap = parseMessage(bytes, 0, bytes.length)

  const extListBytes = rootMap.get(101)?.[0] as Uint8Array | undefined
  if (extListBytes) {
    const extListMap = parseMessage(extListBytes, 0, extListBytes.length)
    const extensions = extListMap.get(1) ?? []
    return parsePbExtensions(extensions)
  }

  const extensions = rootMap.get(1)
  if (extensions && extensions.length > 0 && extensions[0] instanceof Uint8Array) {
    const firstExtMap = parseMessage(extensions[0] as Uint8Array, 0, (extensions[0] as Uint8Array).length)
    if (firstExtMap.has(2)) {
      return parsePbExtensions(extensions)
    }
  }

  return []
}

function parsePbExtensions(extensionList: any[]): AniyomiExt[] {
  const results: AniyomiExt[] = []
  for (const extObj of extensionList) {
    const extBytes = extObj as Uint8Array
    const extMap = parseMessage(extBytes, 0, extBytes.length)

    const name = getString(extMap.get(1))
    const pkg = getString(extMap.get(2))

    const resBytes = extMap.get(3)?.[0] as Uint8Array | undefined
    let apkName = ''
    if (resBytes) {
      const resMap = parseMessage(resBytes, 0, resBytes.length)
      const apkUrl = getString(resMap.get(1))
      apkName = apkUrl.includes('/') ? apkUrl.split('/').pop()! : apkUrl
    }

    const versionCode = getInt(extMap.get(5))
    const versionName = getString(extMap.get(6))
    const contentWarning = getInt(extMap.get(7))

    const sourcesList: AniyomiExt['sources'] = []
    const sources = extMap.get(8) ?? []
    for (const srcObj of sources) {
      const srcBytes = srcObj as Uint8Array
      const srcMap = parseMessage(srcBytes, 0, srcBytes.length)
      sourcesList.push({
        id: String(getInt(srcMap.get(1))),
        name: getString(srcMap.get(2)),
        lang: getString(srcMap.get(3)),
        baseUrl: getString(srcMap.get(4)),
      })
    }

    results.push({
      name, pkg: pkg || undefined, apk: apkName || undefined,
      lang: sourcesList.length > 0 ? sourcesList[0].lang : 'en',
      code: versionCode || undefined, version: versionName || undefined,
      isNsfw: contentWarning >= 2, sources: sourcesList,
    })
  }
  return results
}

// ─── CloudStream ───────────────────────────────────────────

interface CSPlugin {
  name: string; internalName?: string; url?: string;
  iconUrl?: string; language?: string; version?: string;
  pluginUrl?: string; plugin?: string; jarUrl?: string; jar?: string;
  isNsfw?: boolean; hasSettings?: boolean;
  supportsLatest?: boolean; supportsPopular?: boolean;
}

async function fetchCloudStreamRepo(url: string): Promise<{ plugins: CSPlugin[]; subRepos?: string[] }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  const data = await res.json()

  if (data.pluginLists && Array.isArray(data.pluginLists)) {
    return { plugins: [], subRepos: data.pluginLists }
  }

  if (Array.isArray(data)) {
    return { plugins: data }
  }

  if (data.plugins && Array.isArray(data.plugins)) {
    return { plugins: data.plugins }
  }

  throw new Error('Unknown CloudStream repo format')
}

// ─── Fetch repo extensions (reusable for both add & refresh) ─

interface RepoFetchResult {
  ok: boolean
  error?: string
  extensions?: number
  updated?: number[]  // ext IDs that had version changes
  removed?: number[]  // ext IDs that no longer exist in repo
  subRepos?: string[]
}

async function fetchAndStoreRepo(url: string, type: RepoType): Promise<RepoFetchResult> {
  const updated: number[] = []
  let count = 0
  const seenPkgs = new Set<string>()

  try {
    if (type === 'aniyomi') {
      const base = getBaseUrl(url)
      let exts: AniyomiExt[]

      if (url.endsWith('.pb') || url.endsWith('.pb.gz')) {
        exts = await fetchAniyomiPb(url)
      } else {
        exts = await fetchAniyomiJson(url)
      }

      console.log(`[repos] Parsed ${exts.length} extensions from Aniyomi repo`)

      for (const ext of exts) {
        const extType = getAniyomiType(ext)
        const iconUrl = ext.pkg ? `${base}/icon/${ext.pkg}.png` : null
        const downloadUrl = ext.apk ? `${base}/apk/${ext.apk}` : null
        const newVersion = ext.version || null

        // Check if version changed
        const existing = ext.pkg
          ? db.query('SELECT id, version, file_path FROM extensions WHERE pkg = ?').get(ext.pkg) as any
          : null

        const extId = upsertExtension(
          ext.name, ext.pkg || null, extType, newVersion, iconUrl,
          ext.lang || null, ext.isNsfw || false, null, null,
          { downloadUrl, sources: ext.sources }
        )

        if (ext.pkg) seenPkgs.add(ext.pkg)
        count++

        // Detect version change on already-downloaded extension
        if (existing && existing.file_path && newVersion && existing.version !== newVersion) {
          updated.push(extId)
        }
      }

    } else if (type === 'cloudstream') {
      const result = await fetchCloudStreamRepo(url)

      if (result.subRepos) {
        return { ok: true, subRepos: result.subRepos }
      }

      for (const plugin of result.plugins) {
        const downloadUrl = plugin.pluginUrl || plugin.plugin || plugin.url || null
        const iconUrl = plugin.iconUrl || null
        const newVersion = plugin.version || null

        const existing = plugin.internalName
          ? db.query('SELECT id, version, file_path FROM extensions WHERE pkg = ?').get(plugin.internalName) as any
          : null

        const extId = upsertExtension(
          plugin.name, plugin.internalName || null, 'cloudstream', newVersion,
          iconUrl, plugin.language || 'ALL', plugin.isNsfw || false, null, null,
          { downloadUrl, jarUrl: plugin.jarUrl || plugin.jar || null }
        )

        if (plugin.internalName) seenPkgs.add(plugin.internalName)
        count++

        if (existing && existing.file_path && newVersion && existing.version !== newVersion) {
          updated.push(extId)
        }
      }

    } else if (type === 'kotatsu') {
      const jarName = url.split('/').pop() || 'plugin.jar'
      upsertExtension(
        `Kotatsu: ${jarName}`, jarName, 'kotatsu',
        null, null, null, false, null, null,
        { downloadUrl: url, isJar: true }
      )
      count = 1
    }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }

  return { ok: true, extensions: count, updated }
}

// ─── Add Repo (first time) ──────────────────────────────────

export async function addRepo(userId: string, url: string, forceType?: string): Promise<{ ok: boolean; error?: string; repo?: any; extensions?: number; subRepos?: string[] }> {
  let type: RepoType = (forceType as RepoType) || detectRepoType(url)

  const repoResult = addRepoForUser(userId, url, type)
  if (!repoResult.ok) return repoResult

  const result = await fetchAndStoreRepo(url, type)

  if (result.ok) {
    if (repoResult.repo) markRepoFetched(repoResult.repo.id)
    console.log(`[repos] Added ${url} (${result.extensions} extensions)`)
    return { ok: true, repo: repoResult.repo, extensions: result.extensions, subRepos: result.subRepos }
  }

  return { ok: true, repo: repoResult.repo, error: `Repo added but fetch failed: ${result.error}`, subRepos: result.subRepos }
}

// ─── Refresh Repo (re-fetch, detect changes) ───────────────

export async function refreshRepo(repoUrl: string, repoType: string): Promise<{ ok: boolean; updated?: number[]; error?: string }> {
  console.log(`[auto-update] Refreshing repo: ${repoUrl}`)
  const result = await fetchAndStoreRepo(repoUrl, repoType as RepoType)
  if (!result.ok) {
    console.error(`[auto-update] Failed to refresh ${repoUrl}: ${result.error}`)
    return { ok: false, error: result.error }
  }
  console.log(`[auto-update] ${repoUrl}: ${result.extensions} extensions, ${result.updated?.length || 0} need re-download`)
  return { ok: true, updated: result.updated }
}

// ─── Get all unique repos from DB (for auto-update) ────────

export function getAllRepos() {
  return db.query('SELECT DISTINCT url, type FROM repos').all() as { url: string; type: string }[]
}