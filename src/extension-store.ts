/**
 * AnymeX Bridge — Extension Store
 *
 * Manages the shared on-disk pool of .apk / .cs3 / .jar files.
 * Files are content-addressed by URL hash so multiple users installing
 * the same extension share one copy on disk.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, createWriteStream, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const EXTS_DIR = join(DATA_DIR, 'exts');
const TMP_DIR = join(DATA_DIR, 'tmp');

mkdirSync(EXTS_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

/** Hash a URL into a stable filename. */
export function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/** Build the on-disk path for an extension's binary. */
export function extPath(fileUrl: string): string {
  // Preserve extension (.apk / .cs3) for readability / debugging.
  const ext = fileUrl.split('?')[0].split('.').pop() ?? 'bin';
  return join(EXTS_DIR, `${hashUrl(fileUrl)}.${ext}`);
}

/** Check whether a given extension file is already downloaded. */
export function isExtCached(fileUrl: string): boolean {
  return existsSync(extPath(fileUrl));
}

/** Download an extension file into the shared store (atomic via temp + rename). */
export async function downloadExt(fileUrl: string): Promise<string> {
  const finalPath = extPath(fileUrl);
  if (existsSync(finalPath)) return finalPath;

  const tmpPath = join(TMP_DIR, `${hashUrl(fileUrl)}-${Date.now()}.part`);
  console.log(`[ext-store] downloading ${fileUrl} → ${finalPath}`);

  const resp = await fetch(fileUrl, { redirect: 'follow' });
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to download ${fileUrl}: HTTP ${resp.status}`);
  }

  // stream into temp file
  const fileStream = createWriteStream(tmpPath);
  // @ts-ignore — fetch body is a web stream; bun supports piping via Readable.fromWeb
  const nodeStream = Readable.fromWeb(resp.body);
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(fileStream);
    nodeStream.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', () => resolve());
  });

  renameSync(tmpPath, finalPath);
  console.log(`[ext-store] saved ${finalPath} (${statSync(finalPath).size} bytes)`);
  return finalPath;
}

/** Delete an extension file from disk if no users reference it.
 *  Caller decides whether to call this; we expose the primitive. */
export function deleteExt(fileUrl: string): void {
  const p = extPath(fileUrl);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch (e) {
    console.warn(`[ext-store] failed to delete ${p}:`, e);
  }
}

/** List all cached extension files (used by GC + diagnostics). */
export function listCachedExts(): string[] {
  return readdirSync(EXTS_DIR);
}
