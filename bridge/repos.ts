import { db, addRepoForUser, markRepoFetched, upsertExtension } from './db.js'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const EXT_DIR = join(import.meta.dir, 'extensions')
mkdirSync(EXT_DIR, { recursive: true })

// Detect repo type from URL
export function detectRepoType(url: string): 'aniyomi' | 'cloudstream' | 'kotatsu' | 'unknown' {
  if (url.includes('index.min.json') || url.includes('index.json')) return 'aniyomi'
  if (url.includes('index.pb')) return 'aniyomi'
  if (url.endsWith('.json')) return 'cloudstream'
  return 'unknown'
}

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

function getBaseUrl(indexUrl: string): string {
  const idx = indexUrl.lastIndexOf('/')
  return indexUrl.substring(0, idx)
}

function getAniyomiType(ext: AniyomiExt): string {
  const pkg = ext.pkg || ''
  if (pkg.includes('anime')) return 'aniyomi-anime'
  if (pkg.includes('manga')) return 'aniyomi-manga'
  const src = ext.sources?.[0]
  if (src?.name?.toLowerCase().includes('anime')) return 'aniyomi-anime'
  return 'aniyomi-anime'
}

async function fetchAniyomiJson(url: string): Promise<AniyomiExt[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.json()
}

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
  let type = forceType || detectRepoType(url)
  if (type === 'unknown') {
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

        upsertExtension(
          ext.name,
          ext.pkg || null,
          extType,
          ext.version || null,
          iconUrl,
          ext.lang || null,
          ext.nsfw || false,
          null,
          null,
          { downloadUrl, sources: ext.sources }
        )
        count++
      }
    } else if (type === 'cloudstream') {
      const repo = await fetchCloudStreamRepo(url)
      console.log(`[repos] Parsed ${repo.extensions?.length || 0} extensions from CloudStream repo`)

      for (const ext of repo.extensions || []) {
        const file = ext.files?.[0]
        const downloadUrl = file?.url || file?.pluginUrl || null
        const iconUrl = repo.website ? `${repo.website}/icon.png` : null

        upsertExtension(
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
