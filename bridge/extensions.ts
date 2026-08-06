import { db, installExtensionForUser, upsertExtension, getExtension } from './db.js'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { getJarPath, isJarReady, invokeJar } from './jar.js'

const EXT_DIR = join(import.meta.dir, 'extensions')
mkdirSync(EXT_DIR, { recursive: true })

export function hashFile(path: string): string {
  const data = readFileSync(path)
  return createHash('sha256').update(data).digest('hex')
}

// Download extension file and save locally (single copy)
export async function downloadExtension(extId: number): Promise<{ ok: boolean; error?: string; filePath?: string }> {
  const ext = getExtension(extId)
  if (!ext) return { ok: false, error: 'Extension not found' }

  // Already downloaded?
  if (ext.file_path && existsSync(ext.file_path)) {
    return { ok: true, filePath: ext.file_path }
  }

  // Get download URL from extra
  let extra: any = {}
  try { extra = typeof ext.extra === 'string' ? JSON.parse(ext.extra) : (ext.extra || {}) } catch {}
  const downloadUrl = extra.downloadUrl
  if (!downloadUrl) return { ok: false, error: 'No download URL for this extension' }

  console.log(`[ext] Downloading extension ${ext.name} from ${downloadUrl}`)

  try {
    const res = await fetch(downloadUrl)
    if (!res.ok || !res.body) return { ok: false, error: `Download failed: ${res.status}` }

    const extType = ext.type
    let finalExt = 'jar'
    if (extType === 'cloudstream') finalExt = 'cs3'
    else if (extType?.startsWith('aniyomi')) {
      // APK files for aniyomi — we keep as-is, JAR will convert
      finalExt = downloadUrl.endsWith('.jar') ? 'jar' : 'apk'
    }

    const fileName = `${ext.pkg || ext.name.replace(/[^a-zA-Z0-9]/g, '_')}.${finalExt}`
    const filePath = join(EXT_DIR, fileName)
    const tmpPath = filePath + '.tmp'

    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(tmpPath, buf)

    // Hash
    const fileHash = createHash('sha256').update(buf).digest('hex')

    // Atomic
    if (existsSync(filePath)) unlinkSync(filePath)
    const { renameSync } = await import('node:fs')
    renameSync(tmpPath, filePath)

    // Update DB
    db.run('UPDATE extensions SET file_path = ?, file_hash = ? WHERE id = ?', [filePath, fileHash, extId])

    console.log(`[ext] Saved: ${filePath} (${(buf.length / 1024).toFixed(1)}KB)`)
    return { ok: true, filePath }
  } catch (e: any) {
    return { ok: false, error: `Download error: ${e.message}` }
  }
}

// Install extension for user — downloads if needed, tracks in DB
export async function installExtension(userId: string, extId: number): Promise<{ ok: boolean; error?: string }> {
  // Download the file first
  const dl = await downloadExtension(extId)
  if (!dl.ok) return dl

  // Track in DB
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
