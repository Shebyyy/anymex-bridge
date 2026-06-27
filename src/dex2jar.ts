/**
 * AnymeX Bridge — dex2jar tooling
 *
 * Aniyomi/CloudStream extensions ship as .apk (Android packages). The bridge
 * JAR can only load JVM .jar files, so we must convert classes.dex (inside
 * the .apk) to a .jar via dex2jar — same flow the desktop client uses in
 * RuntimeTools.dart.
 *
 * We download dex-tools-v2.4 from pxb1988/dex2jar on first use, extract it,
 * chmod the shell scripts, and invoke d2j-dex2jar.sh on the extracted
 * classes.dex.
 */

import {
  mkdirSync,
  existsSync,
  createWriteStream,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const TOOLS_DIR = join(DATA_DIR, 'tools');
const EXTS_JAR_DIR = join(DATA_DIR, 'exts-jar'); // converted .jar files live here
const TMP_DIR = join(DATA_DIR, 'tmp');

mkdirSync(TOOLS_DIR, { recursive: true });
mkdirSync(EXTS_JAR_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

const DEX2JAR_VERSION = '2.4';
const DEX2JAR_ZIP_URL = `https://github.com/pxb1988/dex2jar/releases/download/v${DEX2JAR_VERSION}/dex-tools-v${DEX2JAR_VERSION}.zip`;
const DEX2JAR_EXTRACTED = join(TOOLS_DIR, `dex-tools-v${DEX2JAR_VERSION}`);
// dex-tools-v2.4 ships the .sh scripts at the archive root (no bin/ subdir).
const DEX2JAR_BIN = join(DEX2JAR_EXTRACTED, 'd2j-dex2jar.sh');

let ensurePromise: Promise<string> | null = null;

/** Path to the folder of converted .jar files — passed to the JAR's loadExtensions. */
export function extJarDir(): string {
  return EXTS_JAR_DIR;
}

/** Download + extract dex2jar if not already present. Returns path to the bin. */
export function ensureDex2Jar(): Promise<string> {
  if (existsSync(DEX2JAR_BIN)) return Promise.resolve(DEX2JAR_BIN);
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    console.log(`[dex2jar] downloading from ${DEX2JAR_ZIP_URL}...`);
    const zipPath = join(TOOLS_DIR, 'dex2jar.zip');
    const resp = await fetch(DEX2JAR_ZIP_URL, { redirect: 'follow' });
    if (!resp.ok || !resp.body) throw new Error(`dex2jar download failed: HTTP ${resp.status}`);
    const ws = createWriteStream(zipPath);
    // @ts-ignore
    await new Promise<void>((resolve, reject) => {
      const rs = Readable.fromWeb(resp.body);
      rs.pipe(ws);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
    });

    console.log('[dex2jar] extracting...');
    // Use system unzip (faster + handles zip natively; bun has no built-in zip extract).
    const { execSync } = await import('node:child_process');
    execSync(`unzip -o -q "${zipPath}" -d "${TOOLS_DIR}"`);
    unlinkSync(zipPath);

    if (!existsSync(DEX2JAR_BIN)) {
      throw new Error(`dex2jar bin not found at ${DEX2JAR_BIN} after extraction`);
    }
    // chmod all .sh in the extracted dir
    for (const f of readdirSync(DEX2JAR_EXTRACTED)) {
      if (f.endsWith('.sh')) chmodSync(join(DEX2JAR_EXTRACTED, f), 0o755);
    }
    console.log(`[dex2jar] ready at ${DEX2JAR_BIN}`);
    return DEX2JAR_BIN;
  })();
  return ensurePromise;
}

/** Convert an .apk into a .jar via dex2jar.
 *  @param apkPath  path to the downloaded .apk
 *  @param pkgName  package name (used for the output filename)
 *  @returns path to the produced .jar in EXTS_JAR_DIR */
export async function apkToJar(apkPath: string, pkgName: string): Promise<string> {
  const bin = await ensureDex2Jar();
  const safeName = (pkgName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const outJar = join(EXTS_JAR_DIR, `${safeName}.jar`);

  if (existsSync(outJar)) {
    console.log(`[dex2jar] ${safeName}.jar already exists, skipping conversion`);
    return outJar;
  }

  // Extract classes.dex to a temp file dex2jar can read.
  const dexTmp = join(TMP_DIR, `${safeName}-${Date.now()}.dex`);
  const { execSync } = await import('node:child_process');
  execSync(`unzip -o -q "${apkPath}" classes.dex -d "${TMP_DIR}"`);
  const extractedDex = join(TMP_DIR, 'classes.dex');
  renameSync(extractedDex, dexTmp);

  console.log(`[dex2jar] converting ${safeName}: ${dexTmp} → ${outJar}`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, ['--force', dexTmp, '-o', outJar], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: DEX2JAR_EXTRACTED, // d2j scripts resolve lib/ relative to $0
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      try { unlinkSync(dexTmp); } catch {}
      if (code !== 0) {
        reject(new Error(`dex2jar failed (code=${code}):\n${stderr}\n${stdout}`));
      } else {
        resolve();
      }
    });
  });

  if (!existsSync(outJar)) {
    throw new Error(`dex2jar produced no output at ${outJar}`);
  }
  console.log(`[dex2jar] ✓ ${safeName}.jar (${statSync(outJar).size} bytes)`);
  return outJar;
}

/** Check whether a converted .jar exists for a package. */
export function isJarCached(pkgName: string): boolean {
  const safeName = (pkgName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return existsSync(join(EXTS_JAR_DIR, `${safeName}.jar`));
}

/** Path for a converted .jar (whether or not it exists yet). */
export function jarPathFor(pkgName: string): string {
  const safeName = (pkgName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(EXTS_JAR_DIR, `${safeName}.jar`);
}
