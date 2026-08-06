import { db, addRepoForUser, markRepoFetched, upsertExtension } from './db.js'
import { join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { hashFile } from './extensions.js'

const EXT_DIR = join(import.meta.dir, 'extensions')
mkdirSync(EXT_DIR, { recursive: true })

// Detect repo type from URL
export function detectRepoType(url: string): 'aniyomi' | 'cloudstream' | 'kotatsu' | 'unknown' {
  if (url.includes('index.min.json') || url.includes('index.json')) {
    // Could be aniyomi or cloudstream — fetch and inspect
    return 'aniyomi' // default, will be refined after fetch
  }
  if (url.includes('index.pb')) {
    return 'aniyomi' // protobuf aniyomi format
  }
  if (url.endsWith('.json')) {
    return 'cloudstream'
  }
  return 'unknown'
}

// Parse Aniyomi index.min.json (minified JSON array)
interface AniyomiExt {
  name: string
  pkg?: string
  apk?: string
  icon?: string
  sources?: { name: string; lang: string; id?: number; baseUrl?: string }[]
  lang?: string
  hasReadme?: boolean
  hasChangelog?: boolean
  version?: string
  nsfw?: boolean
}

// Get base URL from index URL
function getBaseUrl(indexUrl: string): string {
  const idx = indexUrl.lastIndexOf('/')
  return indexUrl.substring(0, idx)
}

// Determine if it's anime or manga from sources/pkg
function getAniyomiType(ext: AniyomiExt): string {
  const pkg = ext.pkg || ''
  if (pkg.includes('anime')) return 'aniyomi-anime'
  if (pkg.includes('manga')) return 'aniyomi-manga'
  // Check sources
  const src = ext.sources?.[0]
  if (src?.name?.toLowerCase().includes('anime')) return 'aniyomi-anime'
  // Default: check repo name hint
  return 'aniyomi-anime'
}

async function fetchAniyomiJson(url: string): Promise<AniyomiExt[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.json()
}

// Protobuf decoder for Aniyomi index.pb
async function fetchAniyomiPb(url: string): Promise<AniyomiExt[]> {
  // Try JSON alternative first
  const jsonUrl = url.replace(/index\.pb$/, 'index.min.json')
  try {
    const res = await fetch(jsonUrl)
    if (res.ok) {
      console.log(`[repos] PB url auto-resolved to JSON: ${jsonUrl}`)
      return res.json()
    }
  } catch {}

  // Parse protobuf with protobufjs
  const protobuf = await import('protobufjs/minimal')

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  // Aniyomi extension index proto schema
  const root = new protobuf.Root()
  const Source = new protobuf.Type('Source')
    .add(new protobuf.Field('name', 1, 'string'))
    .add(new protobuf.Field('lang', 2, 'string'))
    .add(new protobuf.Field('id', 3, 'int64'))
    .add(new protobuf.Field('baseUrl', 4, 'string'))

  const Extension = new protobuf.Type('Extension')
    .add(new protobuf.Field('name', 1, 'string'))
    .add(new protobuf.Field('pkg', 2, 'string'))
    .add(new protobuf.Field('apk', 3, 'string'))
    .add(new protobuf.Field('icon', 4, 'string'))
    .add(new protobuf.Field('sources', 5, 'Source', 'repeated'))
    .add(new protobuf.Field('lang', 6, 'string'))
    .add(new protobuf.Field('hasReadme', 7, 'bool'))
    .add(new protobuf.Field('hasChangelog', 8, 'bool'))
    .add(new protobuf.Field('version', 9, 'string'))
    .add(new protobuf.Field('nsfw', 10, 'bool'))

  root.add(Source).add(Extension)

  // The pb file is a length-delimited stream of Extension messages
  const extensions: AniyomiExt[] = []
  let offset = 0
  while (offset < buf.length) {
    try {
      const decoded = Extension.decodeDelimited(buf, offset)
      const ext = Extension.toObject(decoded) as unknown as AniyomiExt
      extensions.push(ext)
      offset = Extension.decodeDelimited.bytesRead
    } catch {
      break
    }
  }

  if (extensions.length === 0) throw new Error('No extensions parsed from protobuf')
  return extensions
}

// Parse CloudStream repo JSON
interface CSRepo {
  name: string
  shortName?: string
  website?: string
  extensions: CSExt[]
}
interface CSExt {
  name: string
  id?: string
  url?: string
  apiVersion?: number
  version?: string
  language?: string
  status?: string
  description?: string
  files?: { name: string; type: string; url?: string; pluginUrl?: string }[]
}

async function fetchCloudStreamRepo(url: string): Promise<CSRepo> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.json()
}

export async function addRepo(userId: string, url: string, forceType?: string): Promise<{ ok: boolean; error?: string; repo?: any; extensions?: number }> {
  // Detect type
  let type = forceType || detectRepoType(url)
  if (type === 'unknown') {
    // Try fetching as JSON to auto-detect
    try {
      const res = await fetch(url)
      const text = await res.text()
      const data = JSON.parse(text)
      if (Array.isArray(data)) type = 'aniyomi'
      else if (data.extensions) type = 'cloudstream'
      else type = 'aniyomi'
    } catch {
      return { ok: false, error: 'Could not detect repo type from URL' }
    }
  }

  const repoResult = addRepoForUser(userId, url, type)
  if (!repoResult.ok) return repoResult

  // Now fetch the repo index and parse extensions
  const base = getBaseUrl(url)
  let count = 0

  try {
    if (type === 'aniyomi') {
      let exts: AniyomiExt[]
      if (url.endsWith('.pb')) {
        exts = await fetchAniyomiPb(url)
      } else {
        exts = await fetchAniyomiJson(url)
      }

      console.log(`[repos] Parsed ${exts.length} extensions from Aniyomi repo`)

      for (const ext of exts) {
        const extType = getAniyomiType(ext)
        const iconUrl = ext.icon ? `${base}/${ext.icon}` : null
        const downloadUrl = ext.apk ? `${base}/${ext.apk}` : null

        const extId = upsertExtension(
          ext.name,
          ext.pkg || null,
          extType,
          ext.version || null,
          iconUrl,
          ext.lang || null,
          ext.nsfw || false,
          null, // no file downloaded yet — just cataloged
          null,
          { downloadUrl, sources: ext.sources }
        )
        count++
      }
    } else if (type === 'cloudstream') {
      const repo = await fetchCloudStreamRepo(url)
      console.log(`[repos] Parsed ${repo.extensions?.length || 0} extensions from CloudStream repo`)

      for (const ext of repo.extensions || []) {
        const file = ext.files?.[0] // .cs3 file
        const downloadUrl = file?.url || file?.pluginUrl || null
        const iconUrl = repo.website ? `${repo.website}/icon.png` : null

        const extId = upsertExtension(
          ext.name,
          ext.id || null,
          'cloudstream',
          ext.version || null,
          iconUrl,
          ext.language || null,
          ext.status === 'NSFW',
          null,
          null,
          { downloadUrl, description: ext.description }
        )
        count++
      }
    }
  } catch (e: any) {
    console.error(`[repos] Error fetching/parsing repo: ${e.message}`)
    return { ok: true, repo: repoResult.repo, error: `Repo added but fetch failed: ${e.message}` }
  }

  if (repoResult.repo) markRepoFetched(repoResult.repo.id)
  console.log(`[repos] Repo added: ${url} (${count} extensions)`)
  return { ok: true, repo: repoResult.repo, extensions: count }
}