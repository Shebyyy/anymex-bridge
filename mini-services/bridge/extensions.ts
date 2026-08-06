import { existsSync, mkdirSync, createWriteStream, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getExtension, upsertExtension, installForUser, uninstallForUser, getExtUserCount } from './db.js'
import { jar } from './jar.js'
import type { ExtMeta } from './repos.js'

const EXT_DIR = join(jar.getDataDir(), 'extensions')
mkdirSync(join(EXT_DIR, 'Aniyomi'), { recursive: true })
mkdirSync(join(EXT_DIR, 'CloudStream'), { recursive: true })
mkdirSync(join(EXT_DIR, 'Kotatsu'), { recursive: true })

/**
 * Install an extension for a user.
 * 1. Download the file if not already on disk
 * 2. Convert APK→JAR if needed (Aniyomi)
 * 3. Load into JAR if needed
 * 4. Track in user_extensions
 */
export async function installExtension(extId: string, userId: string): Promise<any> {
  const ext = getExtension(extId)
  if (!ext) throw new Error(`extension not found: ${extId}`)

  // Already installed for this user?
  if (installForUser.__proto__.constructor.name === 'Function') {
    // We call it below after download
  }

  // Download file if not present
  const extra = ext.extra ? JSON.parse(ext.extra) : {}
  const filePath = await ensureFileOnDisk(ext)

  // Update DB with file path
  upsertExtension({ ...ext, file_path: filePath, extra })

  // Track for user
  installForUser(userId, extId)

  return { extId, filePath }
}

/**
 * Uninstall for a user. Delete file if no other user has it.
 */
export async function uninstallExtension(extId: string, userId: string): Promise<void> {
  uninstallForUser(userId, extId)

  // Check if anyone else has it
  const count = getExtUserCount(extId)
  if (count === 0) {
    // Safe to delete file
    const ext = getExtension(extId)
    if (ext?.file_path && existsSync(ext.file_path)) {
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(ext.file_path) } catch {}
      console.log(`[ext] deleted file: ${ext.file_path}`)
      // Clear file_path in DB
      upsertExtension({ ...ext, file_path: undefined })
    }
  }
}

/**
 * Ensure the extension file is downloaded (and converted if needed).
 * Returns the path to the ready-to-use file.
 */
async function ensureFileOnDisk(ext: any): Promise<string> {
  const extra = ext.extra ? (typeof ext.extra === 'string' ? JSON.parse(ext.extra) : ext.extra) : {}

  // If file already exists on disk, check if we need to reload into JAR
  if (ext.file_path && existsSync(ext.file_path)) {
    // Reload extensions in the JAR so it picks up changes
    await reloadJarExtensions(ext.type)
    return ext.file_path
  }

  // Need to download
  const downloadUrl = ext.downloadUrl || extra.url || extra.jarUrl || extra.downloadUrl
  if (!downloadUrl) throw new Error(`no download URL for ${ext.id}`)

  let targetPath: string

  switch (ext.type) {
    case 'aniyomi-anime':
    case 'aniyomi-manga': {
      // Download APK, convert to JAR
      const apkPath = await downloadFile(downloadUrl, join(EXT_DIR, 'Aniyomi', `_tmp_${Date.now()}.apk`))
      const jarPath = join(EXT_DIR, 'Aniyomi', `${ext.id}.jar`)
      await convertApkToJar(apkPath, jarPath)
      targetPath = jarPath
      break
    }
    case 'cloudstream': {
      // Download .cs3 directly
      const csPath = join(EXT_DIR, 'CloudStream', `${ext.id}.cs3`)
      targetPath = await downloadFile(downloadUrl, csPath)
      break
    }
    case 'kotatsu': {
      // Download plugin.jar
      const jarPath = join(EXT_DIR, 'Kotatsu', `${ext.id}.jar`)
      targetPath = await downloadFile(downloadUrl, jarPath)
      break
    }
    default:
      throw new Error(`unknown type: ${ext.type}`)
  }

  // Reload into JAR
  await reloadJarExtensions(ext.type)

  return targetPath
}

/**
 * Tell the JAR to load extensions from the appropriate folder.
 */
async function reloadJarExtensions(type: string) {
  try {
    await jar.ensureReady()
    let folderPath: string
    switch (type) {
      case 'aniyomi-anime':
      case 'aniyomi-manga':
        folderPath = join(EXT_DIR, 'Aniyomi')
        break
      case 'cloudstream':
        folderPath = join(EXT_DIR, 'CloudStream')
        break
      case 'kotatsu':
        folderPath = join(EXT_DIR, 'Kotatsu')
        break
      default:
        return
    }
    await jar.invoke('loadExtensions', { folderPath }, `reload-${type}-${Date.now()}`, 30_000)
    console.log(`[ext] loaded extensions from ${folderPath}`)
  } catch (e: any) {
    console.error(`[ext] loadExtensions failed: ${e.message}`)
  }
}

/**
 * Convert APK to JAR using the official runtime JAR's convertApk method.
 */
async function convertApkToJar(apkPath: string, outJarPath: string): Promise<void> {
  console.log(`[ext] converting ${apkPath} → ${outJarPath}`)
  await jar.invoke('convertApk', { apkPath, outJarPath }, `convert-${Date.now()}`, 120_000)

  if (!existsSync(outJarPath)) {
    throw new Error(`convertApk did not produce ${outJarPath}`)
  }

  // Clean up APK
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(apkPath)
  } catch {}

  console.log(`[ext] conversion done: ${outJarPath}`)
}

/**
 * Download a file from URL to local path.
 */
async function downloadFile(url: string, destPath: string): Promise<string> {
  console.log(`[ext] downloading ${url}...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)

  const tmpPath = destPath + '.tmp'
  const file = createWriteStream(tmpPath)
  const reader = res.body!.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    file.write(value)
  }
  file.end()

  // Atomic rename
  await new Promise<void>((resolve, reject) => {
    file.on('finish', () => {
      renameSync(tmpPath, destPath)
      resolve()
    })
    file.on('error', reject)
  })

  const { statSync } = await import('node:fs')
  const size = (statSync(destPath).size / 1024).toFixed(0)
  console.log(`[ext] downloaded ${size}KB → ${destPath}`)
  return destPath
}
