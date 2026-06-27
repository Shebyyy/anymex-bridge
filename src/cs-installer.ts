/**
 * AnymeX Bridge — CloudStream Plugin Installer
 *
 * CloudStream plugins ship as .cs3 (zip with classes.dex + manifest.json).
 * The bridge JAR's `csLoadExtensions` expects .jar files containing a
 * `manifest.json` with {pluginClassName, name, version, authors, requires:1}.
 *
 * The repo also provides a pre-converted .jar (jarUrl). We:
 *   1. Download the .cs3 → extract manifest.json (for pluginClassName)
 *   2. Download the .jar (jarUrl)
 *   3. Repackage: strip the .jar's manifest, inject a bridge-format manifest
 *   4. Save as <internalName>.jar in exts-jar-cs/
 *
 * If jarUrl is missing, fall back to: extract classes.dex from .cs3 → dex2jar.
 */

import { execSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { ensureDex2Jar } from './dex2jar.js';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const CS_JAR_DIR = join(DATA_DIR, 'exts-jar-cs'); // CloudStream .jar files
const TMP_DIR = join(DATA_DIR, 'tmp');

mkdirSync(CS_JAR_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

/** Folder passed to the JAR's csLoadExtensions. */
export function csJarDir(): string {
  return CS_JAR_DIR;
}

/** Check if a CloudStream .jar is already cached. */
export function isCsJarCached(internalName: string): boolean {
  return existsSync(join(CS_JAR_DIR, `${internalName}.jar`));
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

/** Extract manifest.json from a .cs3 (zip) file. Returns parsed JSON. */
function extractCs3Manifest(cs3Path: string, workDir: string): any {
  execSync(`unzip -o -q "${cs3Path}" manifest.json -d "${workDir}"`);
  const manifestPath = join(workDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    // Try plugins.manifest as fallback
    execSync(`unzip -o -q "${cs3Path}" plugins.manifest -d "${workDir}"`);
    const pm = join(workDir, 'plugins.manifest');
    if (!existsSync(pm)) throw new Error('No manifest.json or plugins.manifest in .cs3');
    const raw = JSON.parse(readFileSync(pm, 'utf8'));
    // plugins.manifest might be a different shape — normalize
    return raw;
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/** Repackage a .jar: strip its manifest, inject a bridge-format manifest. */
function repackageJar(rawJarPath: string, bridgeManifest: any, outJarPath: string, workDir: string): void {
  // Extract the raw jar (without manifest.json)
  const extractDir = join(workDir, 'jar-extracted');
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -o -q "${rawJarPath}" -d "${extractDir}"`);
  // Remove existing manifest.json if present
  const existingManifest = join(extractDir, 'manifest.json');
  if (existsSync(existingManifest)) {
    rmSync(existingManifest, { force: true });
  }
  // Write the bridge manifest
  writeFileSync(join(extractDir, 'manifest.json'), JSON.stringify(bridgeManifest));
  // Re-zip into outJarPath
  if (existsSync(outJarPath)) rmSync(outJarPath, { force: true });
  // Use zip from inside the extract dir so paths are relative
  execSync(`cd "${extractDir}" && zip -q -r "${outJarPath}" .`);
  // Cleanup
  rmSync(extractDir, { recursive: true, force: true });
}

/** Build the bridge-format manifest from a CS3 manifest + source metadata. */
function buildBridgeManifest(cs3Manifest: any, source: { name: string; version?: string; authors?: string[] }): any {
  return {
    pluginClassName: String(cs3Manifest.pluginClassName ?? ''),
    name: String(source.name ?? cs3Manifest.name ?? 'unknown'),
    version: String(source.version ?? cs3Manifest.version ?? '1.0.0'),
    authors: Array.isArray(cs3Manifest.authors)
      ? cs3Manifest.authors.join(', ')
      : String(cs3Manifest.authors ?? source.authors?.join(', ') ?? 'Unknown'),
    requires: 1,
  };
}

/** Install a CloudStream plugin.
 *  @param source  {name, internalName, version, jarUrl, pluginUrl, authors?}
 *  @returns path to the produced .jar in CS_JAR_DIR */
export async function installCsPlugin(source: {
  name: string;
  internalName: string;
  version?: string;
  jarUrl?: string;
  pluginUrl: string;
  authors?: string[];
}): Promise<string> {
  const safeName = (source.internalName || source.name || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const outJar = join(CS_JAR_DIR, `${safeName}.jar`);

  if (existsSync(outJar)) {
    console.log(`[cs-installer] ${safeName}.jar already cached, skipping`);
    return outJar;
  }

  const workDir = join(TMP_DIR, `cs-${safeName}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  try {
    // 1. Download .cs3 and extract manifest
    console.log(`[cs-installer] downloading .cs3 from ${source.pluginUrl}`);
    const cs3Path = join(workDir, 'plugin.cs3');
    await downloadToFile(source.pluginUrl, cs3Path);
    const cs3Manifest = extractCs3Manifest(cs3Path, workDir);
    console.log(`[cs-installer] cs3 manifest: pluginClassName=${cs3Manifest.pluginClassName}`);

    // 2. Build the bridge manifest
    const bridgeManifest = buildBridgeManifest(cs3Manifest, source);

    // 3. Get the .jar (either from jarUrl or via dex2jar)
    if (source.jarUrl) {
      console.log(`[cs-installer] downloading .jar from ${source.jarUrl}`);
      const rawJarPath = join(workDir, 'raw.jar');
      await downloadToFile(source.jarUrl, rawJarPath);
      console.log(`[cs-installer] repackaging .jar with bridge manifest`);
      repackageJar(rawJarPath, bridgeManifest, outJar, workDir);
    } else {
      // Fallback: dex2jar the classes.dex from the .cs3
      console.log(`[cs-installer] no jarUrl — extracting classes.dex + dex2jar`);
      execSync(`unzip -o -q "${cs3Path}" classes.dex -d "${workDir}"`);
      const dexPath = join(workDir, 'classes.dex');
      const dex2jarBin = await ensureDex2Jar();
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const p = spawn(dex2jarBin, ['--force', dexPath, '-o', outJar], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: join(dex2jarBin, '..'),
        });
        let stderr = '';
        p.stderr.on('data', (d) => (stderr += d.toString()));
        p.on('error', reject);
        p.on('close', (code) => (code !== 0 ? reject(new Error(`dex2jar: ${stderr}`)) : resolve()));
      });
      // Now repackage to add the manifest
      repackageJar(outJar, bridgeManifest, outJar + '.tmp', workDir);
      renameSync(outJar + '.tmp', outJar);
    }

    if (!existsSync(outJar)) throw new Error(`Failed to produce ${outJar}`);
    console.log(`[cs-installer] ✓ ${safeName}.jar (${statSync(outJar).size} bytes)`);
    return outJar;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** List all cached CloudStream .jar files. */
export function listCsJars(): string[] {
  return readdirSync(CS_JAR_DIR).filter((f) => f.endsWith('.jar'));
}
