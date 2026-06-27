/**
 * AnymeX Bridge — Kotatsu Plugin Installer
 *
 * Kotatsu is a manga reader. Unlike Aniyomi/CloudStream:
 *   - The "repo URL" IS a direct .jar download (not an index.json)
 *   - ONE .jar contains MULTIPLE manga sources (site parsers)
 *   - The .jar is usually an APK with classes.dex → needs dex2jar
 *   - `install(sourceId)` = just mark active (no per-source download)
 *
 * Flow:
 *   1. Download .jar from repoUrl
 *   2. dex2jar convert (if it has classes.dex)
 *   3. Save to exts-jar-kotatsu/<hash>.jar
 *   4. kotatsuLoadExtensions({folderPath}) → returns list of sources
 *   5. Each source has {id, name, baseUrl, lang, ...}
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { ensureDex2Jar } from './dex2jar.js';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const KOTATSU_JAR_DIR = join(DATA_DIR, 'exts-jar-kotatsu');
const TMP_DIR = join(DATA_DIR, 'tmp');

mkdirSync(KOTATSU_JAR_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

/** Folder passed to the JAR's kotatsuLoadExtensions. */
export function kotatsuJarDir(): string {
  return KOTATSU_JAR_DIR;
}

/** Hash a URL into a stable filename. */
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/** Path for a Kotatsu .jar (whether or not it exists yet).
 *  The bridge JAR's kotatsuLoadExtensions specifically looks for "plugin.jar"
 *  (matching the Dart DesktopKotatsuExtensions.dart behaviour). Since there's
 *  only one jar per folder, we use a fixed name. */
export function kotatsuJarPath(_repoUrl: string): string {
  return join(KOTATSU_JAR_DIR, 'plugin.jar');
}

/** Check whether a Kotatsu .jar is already cached. */
export function isKotatsuJarCached(_repoUrl: string): boolean {
  return existsSync(kotatsuJarPath(_repoUrl));
}

/** Download a URL to a file path. */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} for ${url}`);
  const ws = createWriteStream(dest);
  // @ts-ignore
  const rs = Readable.fromWeb(resp.body);
  await new Promise<void>((resolve, reject) => {
    rs.pipe(ws);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve());
  });
}

/** Check if a .jar contains classes.dex (i.e. needs dex2jar). */
function hasClassesDex(jarPath: string): boolean {
  try {
    const { execSync } = require('node:child_process');
    execSync(`unzip -l "${jarPath}" classes.dex 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Install a Kotatsu plugin .jar.
 *  @param repoUrl  direct .jar download URL
 *  @returns path to the converted .jar in KOTATSU_JAR_DIR */
export async function installKotatsuJar(repoUrl: string): Promise<string> {
  const finalPath = kotatsuJarPath(repoUrl);

  if (existsSync(finalPath)) {
    console.log(`[kotatsu-installer] plugin.jar already cached`);
    return finalPath;
  }

  // Clear the JAR's internal cache so it rescans the folder.
  const cacheFile = join(KOTATSU_JAR_DIR, 'kotatsu_extensions_cache.json');
  if (existsSync(cacheFile)) {
    try { unlinkSync(cacheFile); } catch {}
  }

  const rawPath = join(TMP_DIR, `kotatsu-${hashUrl(repoUrl)}-${Date.now()}.jar`);
  console.log(`[kotatsu-installer] downloading ${repoUrl}`);
  await downloadToFile(repoUrl, rawPath);
  console.log(`[kotatsu-installer] downloaded ${statSync(rawPath).size} bytes`);

  // Check if it needs dex2jar (has classes.dex = APK-style)
  if (hasClassesDex(rawPath)) {
    console.log(`[kotatsu-installer] contains classes.dex → dex2jar conversion needed`);
    const bin = await ensureDex2Jar();
    const dexTmp = join(TMP_DIR, `kotatsu-${hashUrl(repoUrl)}-${Date.now()}.dex`);

    // Extract classes.dex
    const { execSync } = await import('node:child_process');
    execSync(`unzip -o -q "${rawPath}" classes.dex -d "${TMP_DIR}"`);
    renameSync(join(TMP_DIR, 'classes.dex'), dexTmp);

    console.log(`[kotatsu-installer] converting: ${dexTmp} → ${finalPath}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, ['--force', dexTmp, '-o', finalPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: join(bin, '..'),
      });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d.toString()));
      p.on('error', reject);
      p.on('close', (code) => {
        try { unlinkSync(dexTmp); } catch {}
        if (code !== 0) reject(new Error(`dex2jar failed (code=${code}): ${stderr}`));
        else resolve();
      });
    });
    // Clean up the raw APK
    try { unlinkSync(rawPath); } catch {}
  } else {
    // Already a JVM .jar — just move it
    renameSync(rawPath, finalPath);
  }

  if (!existsSync(finalPath)) {
    throw new Error(`Failed to produce ${finalPath}`);
  }
  console.log(`[kotatsu-installer] ✓ plugin.jar (${statSync(finalPath).size} bytes)`);
  return finalPath;
}
