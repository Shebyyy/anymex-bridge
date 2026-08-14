import { db, installExtensionForUser, getExtension } from './db.js'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isJarReady, invokeJar } from './jar.js'

const EXT_DIR = join(import.meta.dir, 'extensions')
mkdirSync(EXT_DIR, { recursive: true })

export function hashFile(path: string): string {
  const data = readFileSync(path)
  return createHash('sha256').update(data).digest('hex')
}

// Download extension file (skip if already exists with same hash)
export async function downloadExtension(extId: number, force = false): Promise<{ ok: boolean; error?: string; filePath?: string; updated?: boolean }> {
  const ext = getExtension(extId)
  if (!ext) return { ok: false, error: 'Extension not found' }

  // Already downloaded and not forced → skip
  if (!force && ext.file_path && existsSync(ext.file_path)) {
    return { ok: true, filePath: ext.file_path, updated: false }
  }

  let extra: any = {}
  try { extra = typeof ext.extra === 'string' ? JSON.parse(ext.extra) : (ext.extra || {}) } catch {}
  const downloadUrl = extra.downloadUrl
  if (!downloadUrl) return { ok: false, error: 'No download URL for this extension' }

  console.log(`[ext] ${force ? 'Re-' : ''}Downloading extension ${ext.name} from ${downloadUrl}`)

  // Hoist path vars for catch block access
  let filePath = ''
  let tmpPath = ''

  try {
    const res = await fetch(downloadUrl)
    if (!res.ok) return { ok: false, error: `Download failed: ${res.status}` }

    const extType = ext.type
    let finalExt = 'jar'
    if (extType === 'cloudstream') finalExt = 'cs3'
    else if (extType?.startsWith('aniyomi')) {
      finalExt = downloadUrl.endsWith('.jar') ? 'jar' : 'apk'
    }

    const fileName = `${ext.pkg || ext.name.replace(/[^a-zA-Z0-9]/g, '_')}.${finalExt}`
    filePath = join(EXT_DIR, fileName)
    tmpPath = filePath + '.tmp'

    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(tmpPath, buf)

    const fileHash = createHash('sha256').update(buf).digest('hex')

    // If hash hasn't changed, skip (no real update)
    if (!force && ext.file_hash === fileHash) {
      try { unlinkSync(tmpPath) } catch {}
      return { ok: true, filePath: ext.file_path, updated: false }
    }

    // Hash changed → replace old file
    if (existsSync(filePath)) unlinkSync(filePath)
    renameSync(tmpPath, filePath)

    // Delete old file if path changed (e.g. APK → JAR after convert)
    if (ext.file_path && ext.file_path !== filePath && existsSync(ext.file_path)) {
      try { unlinkSync(ext.file_path) } catch {}
    }

    db.run('UPDATE extensions SET file_path = ?, file_hash = ? WHERE id = ?', [filePath, fileHash, extId])

    console.log(`[ext] Saved: ${filePath} (${(buf.length / 1024).toFixed(1)}KB) ${ext.file_hash ? '[UPDATED]' : ''}`)
    return { ok: true, filePath, updated: !!ext.file_hash }
  } catch (e: any) {
    // Clean up tmp file on error
    if (tmpPath) try { unlinkSync(tmpPath) } catch {}
    return { ok: false, error: `Download error: ${e.message}` }
  }
}

// Install extension for user — downloads if needed, tracks in DB
export async function installExtension(userId: string, extId: number): Promise<{ ok: boolean; error?: string }> {
  const dl = await downloadExtension(extId)
  if (!dl.ok) return dl

  installExtensionForUser(userId, extId)
  console.log(`[ext] Installed ext ${extId} for user ${userId}`)
  return { ok: true }
}

// Convert APK to JAR using the runtime JAR
export async function convertApkToJar(apkPath: string): Promise<{ ok: boolean; error?: string; jarPath?: string }> {
  if (!isJarReady()) return { ok: false, error: 'Runtime JAR not available' }

  try {
    const result = await invokeJar('convertApk', { apkPath })
    if (result?.jarPath && existsSync(result.jarPath)) {
      return { ok: true, jarPath: result.jarPath }
    }
    return { ok: false, error: 'JAR convertApk returned no jarPath' }
  } catch (e: any) {
    return { ok: false, error: `convertApk failed: ${e.message}` }
  }
}

// Batch re-download extensions that had version changes
export async function updateExtensions(extIds: number[]): Promise<{ updated: number; failed: number }> {
  let updated = 0
  let failed = 0

  for (const id of extIds) {
    const result = await downloadExtension(id, true)
    if (result.ok && result.updated) {
      updated++
    } else if (!result.ok) {
      failed++
      console.error(`[ext] Failed to update ext ${id}: ${result.error}`)
    }
  }

  return { updated, failed }
}
