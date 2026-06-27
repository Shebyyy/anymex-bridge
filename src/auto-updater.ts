/**
 * AnymeX Bridge — Auto-Updater
 *
 * Polls the GitHub Releases of RyanYuuki/AnymeXExtensionRuntimeBridge,
 * downloads the latest bridge.jar, and hot-swaps it into the running
 * server without dropping in-flight requests longer than necessary.
 *
 * The same updater is reused (lightly) to periodically refresh repo
 * caches — though repo caches already self-refresh on demand.
 */

import { existsSync, renameSync, createWriteStream, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { jarRunner, JAR_PATH, JAR_NEW_PATH } from './jar-runner.js';

const REPO_OWNER = 'RyanYuuki';
const REPO_NAME = 'AnymeXExtensionRuntimeBridge';
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const DATA_DIR = join(import.meta.dir, '..', 'data');
const STATE_PATH = join(DATA_DIR, 'updater-state.json');

interface UpdaterState {
  lastCheckedAt: number;
  lastReleaseTag: string | null;
}

function loadState(): UpdaterState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {}
  return { lastCheckedAt: 0, lastReleaseTag: null };
}

function saveState(s: UpdaterState): void {
  try { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {}
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

/** Find the bridge.jar asset in a release (name ends with .jar). */
function findBridgeJarAsset(release: GitHubRelease): GitHubAsset | null {
  // Prefer exact "bridge.jar" / "AnymeXRuntimeBridge.jar"; fall back to any .jar.
  const exact = release.assets.find((a) => /bridge\.jar$/i.test(a.name));
  if (exact) return exact;
  const any = release.assets.find((a) => a.name.endsWith('.jar'));
  return any ?? null;
}

/** Poll once: check GitHub for a new release, download if newer. */
async function pollOnce(): Promise<void> {
  const state = loadState();
  state.lastCheckedAt = Date.now();

  console.log('[updater] polling GitHub releases...');
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'anymex-bridge-updater',
        },
        redirect: 'follow',
      },
    );
  } catch (e: any) {
    console.warn(`[updater] fetch failed: ${e?.message ?? e}`);
    saveState(state);
    return;
  }

  if (!resp.ok) {
    console.warn(`[updater] GitHub releases HTTP ${resp.status} (rate-limited?)`);
    saveState(state);
    return;
  }

  const release = (await resp.json()) as GitHubRelease;
  if (!release?.tag_name) {
    console.warn('[updater] no tag_name in release');
    saveState(state);
    return;
  }

  if (state.lastReleaseTag === release.tag_name && existsSync(JAR_PATH)) {
    console.log(`[updater] already on ${release.tag_name}`);
    saveState(state);
    return;
  }

  const asset = findBridgeJarAsset(release);
  if (!asset) {
    console.warn(`[updater] release ${release.tag_name} has no .jar asset; skipping`);
    saveState(state);
    return;
  }

  console.log(`[updater] downloading ${asset.name} (${asset.size} bytes) from ${asset.browser_download_url}`);
  const dl = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!dl.ok || !dl.body) {
    console.warn(`[updater] download failed: HTTP ${dl.status}`);
    saveState(state);
    return;
  }

  // Stream into bridge.jar.new, then hot-swap.
  const tmpStream = createWriteStream(JAR_NEW_PATH);
  // @ts-ignore
  const nodeStream = Readable.fromWeb(dl.body);
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(tmpStream);
    nodeStream.on('error', reject);
    tmpStream.on('error', reject);
    tmpStream.on('finish', () => resolve());
  });

  console.log(`[updater] downloaded ${JAR_NEW_PATH} (${statSync(JAR_NEW_PATH).size} bytes)`);
  await jarRunner.hotSwap();

  state.lastReleaseTag = release.tag_name;
  saveState(state);
  console.log(`[updater] hot-swapped to ${release.tag_name}`);
}

/** Start the periodic updater. */
export function startUpdater(): void {
  // Initial run on next tick (non-blocking startup).
  setTimeout(() => {
    pollOnce().catch((e) => console.error('[updater] initial poll failed:', e));
  }, 1000);

  const timer = setInterval(() => {
    pollOnce().catch((e) => console.error('[updater] poll failed:', e));
  }, POLL_INTERVAL_MS);

  // Don't keep the process alive just for the timer.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Trigger an immediate poll (used by admin/debug endpoints). */
export async function checkNow(): Promise<void> {
  await pollOnce();
}
