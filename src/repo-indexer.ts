/**
 * AnymeX Bridge — Repo Indexer
 *
 * Fetches & parses Aniyomi / CloudStream / Mangayomi repo index.json files.
 * Caches parsed results to disk so we don't hammer repos on every request.
 *
 * Supported index formats:
 *   - Aniyomi-style: { extensions: [{ name, fileName, version, ... }] }
 *       (iconUrl and fileUrl are resolved against the repo base URL)
 *   - CloudStream-style: { plugins: [{ name, url, ... }] }
 *   - Mangayomi-style: same as Aniyomi
 *
 * We normalise everything to RepoIndex.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RepoExtensionMeta, RepoIndex } from './types.js';
import { stampItemTypeAndManager, ITEM_TYPE_INT, type ItemTypeStr } from './item-type.js';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const REPO_CACHE_DIR = join(DATA_DIR, 'repos');
mkdirSync(REPO_CACHE_DIR, { recursive: true });

/** Refresh interval: 6 hours. */
const REPO_TTL_MS = 6 * 60 * 60 * 1000;

function repoCachePath(repoUrl: string): string {
  // Hash to keep filename stable & filesystem-safe.
  const hash = createHash('sha256').update(repoUrl).digest('hex').slice(0, 32);
  return join(REPO_CACHE_DIR, `${hash}.json`);
}

/** Resolve a possibly-relative URL against a base. */
function resolveUrl(base: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

/** Derive the "repo base" used for resolving relative file/icon URLs.
 *  Conventionally the index.json lives at $REPO/index.min.json — the base
 *  is the directory part. MUST end with a trailing slash so that relative
 *  URL resolution appends rather than replaces the last segment. */
function repoBaseUrl(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    u.search = '';
    u.hash = '';
    // strip filename
    const parts = u.pathname.split('/');
    parts.pop();
    // ensure trailing slash so relative URLs append to the directory
    u.pathname = (parts.join('/') || '/') + '/';
    return u.toString();
  } catch {
    return repoUrl.endsWith('/') ? repoUrl : repoUrl + '/';
  }
}

/** Normalise various repo index formats into RepoIndex.
 *
 *  Supported formats:
 *    1. Bare JSON array — Aniyomi (yuzono etc.):
 *         [{ name, pkg, apk, lang, version, nsfw, sources:[{name,lang,id,baseUrl}] }]
 *    2. Aniyomi/Mangayomi wrapped: { extensions: [{ name, fileName/package, ... }] }
 *    3. CloudStream meta-repo: { name, iconUrl, pluginLists: [url1, url2, ...] }
 *         → we follow each URL in pluginLists (each is a bare array of plugins)
 *    4. CloudStream plugin list (bare array): [{ name, internalName, url, jarUrl, language, tvTypes, version, iconUrl }]
 *    5. CloudStream wrapped: { plugins: [{ name, url, ... }] }
 *
 *  Aniyomi items have `pkg`/`apk`; CloudStream items have `internalName`/`tvTypes`/`jarUrl`.
 *  We auto-detect the runtime from the item shape.
 */
function normaliseIndex(rawUrl: string, raw: any): RepoIndex {
  const baseUrl = repoBaseUrl(rawUrl);
  const out: RepoExtensionMeta[] = [];

  // 0. CloudStream meta-repo: { pluginLists: [url, ...] }
  //    Follow each URL and merge. (We can't do this synchronously here — caller handles it.)
  //    If we get here, the caller already resolved pluginLists, so this is a marker.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.pluginLists)) {
    // The caller (getRepoIndex) should have followed pluginLists before calling normaliseIndex.
    // If we see this, treat as empty (the caller will merge sub-repos).
    return {
      url: rawUrl,
      name: raw.name,
      extensions: out,
      fetchedAt: Date.now(),
      isCloudStreamMeta: true,
      pluginLists: raw.pluginLists,
    } as any;
  }

  // 1. Bare JSON array — could be Aniyomi OR CloudStream plugin list.
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (!e || typeof e !== 'object') continue;
      // Detect CloudStream by presence of tvTypes / internalName / jarUrl
      const isCloudStream = !!e.tvTypes || !!e.internalName || !!e.jarUrl || (!!e.url && String(e.url).endsWith('.cs3'));
      if (isCloudStream) {
        const internalName = String(e.internalName ?? e.name ?? 'unknown');
        const name = String(e.name ?? internalName);
        out.push({
          id: (e.id ?? internalName).toString().toLowerCase(),
          name,
          internalName,
          file: e.url?.split('/').pop() ?? '',
          version: e.version != null ? String(e.version) : undefined,
          type: 'anime',
          lang: e.language != null ? String(e.language) : undefined,
          fileUrl: e.url ? resolveUrl(baseUrl, e.url) : undefined,
          jarUrl: e.jarUrl ? resolveUrl(baseUrl, e.jarUrl) : undefined,
          iconUrl: e.iconUrl ? resolveUrl(baseUrl, e.iconUrl) : undefined,
          isNsfw: !!e.isNsfw,
          baseUrl: e.baseUrl,
          runtime: 'cloudstream',
          tvTypes: Array.isArray(e.tvTypes) ? e.tvTypes.map(String) : undefined,
          authors: Array.isArray(e.authors) ? e.authors.map(String) : undefined,
        });
      } else {
        // Aniyomi bare array
        const pkg = String(e.pkg ?? e.package ?? '');
        const file = String(e.apk ?? e.fileName ?? e.file ?? '');
        const sourceId =
          (Array.isArray(e.sources) && e.sources[0]?.id != null
            ? String(e.sources[0].id)
            : pkg.split('.').pop() ?? file) || String(e.name ?? 'unknown');
        const name = String(e.name ?? pkg ?? file);
        const displayName = name.replace(/^(Aniyomi|Tachiyomi|Mangayomi):\s*/i, '');
        out.push({
          id: sourceId,
          name: displayName,
          fullName: name,
          pkg,
          file,
          version: e.version != null ? String(e.version) : undefined,
          type: name.startsWith('Aniyomi:') ? 'anime' : name.startsWith('Tachiyomi:') ? 'manga' : undefined,
          lang: e.lang != null ? String(e.lang) : undefined,
          fileUrl: file ? resolveUrl(baseUrl, `apk/${file}`) : undefined,
          iconUrl: pkg ? resolveUrl(baseUrl, `icon/${pkg}.png`) : undefined,
          isNsfw: !!(e.nsfw ?? e.isNsfw),
          baseUrl: Array.isArray(e.sources) && e.sources[0]?.baseUrl ? String(e.sources[0].baseUrl) : undefined,
          runtime: 'aniyomi',
        });
      }
    }
  }
  // 2. Aniyomi / Mangayomi wrapped format
  else if (Array.isArray(raw?.extensions)) {
    for (const e of raw.extensions) {
      const pkg = String(e.package ?? e.pkg ?? '');
      const file = String(e.fileName ?? e.file ?? e.apk ?? e.name + '.apk');
      const sourceId =
        (Array.isArray(e.sources) && e.sources[0]?.id != null
          ? String(e.sources[0].id)
          : pkg.split('.').pop() ?? file) || String(e.name ?? 'unknown');
      out.push({
        id: sourceId,
        name: String(e.name ?? file),
        pkg,
        file,
        version: e.version != null ? String(e.version) : undefined,
        type: e.type,
        lang: e.lang != null ? String(e.lang) : undefined,
        fileUrl: resolveUrl(baseUrl, `apk/${file}`),
        iconUrl: e.iconUrl ? resolveUrl(baseUrl, e.iconUrl) : pkg ? resolveUrl(baseUrl, `icon/${pkg}.png`) : undefined,
        isNsfw: !!e.isNsfw,
        baseUrl: Array.isArray(e.sources) && e.sources[0]?.baseUrl ? String(e.sources[0].baseUrl) : undefined,
        runtime: 'aniyomi',
      });
    }
  }
  // 3. CloudStream wrapped format
  else if (Array.isArray(raw?.plugins)) {
    for (const e of raw.plugins) {
      const internalName = String(e.internalName ?? e.name ?? 'unknown');
      out.push({
        id: (e.id ?? internalName).toString().toLowerCase(),
        name: String(e.name ?? internalName),
        internalName,
        file: e.url?.split('/').pop() ?? '',
        version: e.version ? String(e.version) : undefined,
        type: 'anime',
        lang: e.language ? String(e.language) : undefined,
        fileUrl: e.url ? resolveUrl(baseUrl, e.url) : undefined,
        jarUrl: e.jarUrl ? resolveUrl(baseUrl, e.jarUrl) : undefined,
        iconUrl: e.iconUrl ? resolveUrl(baseUrl, e.iconUrl) : undefined,
        isNsfw: !!e.isNsfw,
        runtime: 'cloudstream',
        tvTypes: Array.isArray(e.tvTypes) ? e.tvTypes.map(String) : undefined,
        authors: Array.isArray(e.authors) ? e.authors.map(String) : undefined,
      });
    }
  }
  // Unknown — bail
  else {
    throw new Error(`Unrecognised repo index format at ${rawUrl} (expected a JSON array, or {extensions|plugins|pluginLists:[]})`);
  }

  // Stamp every entry with the runtime's int `itemType` (0=manga,1=anime,2=novel)
  // and `managerId` ('aniyomi'|'cloudstream'|'kotatsu') — required by the iOS
  // client's Source.fromJson + getSourceManager(). Done once here so every
  // push site above doesn't need to repeat the logic.
  for (const ext of out) stampItemTypeAndManager(ext);

  return {
    url: rawUrl,
    name: raw?.name,
    extensions: out,
    fetchedAt: Date.now(),
  };
}

/** Fetch (or load from cache) the parsed RepoIndex for a repo URL.
 *  Handles:
 *    - CloudStream meta-repos ({pluginLists:[]}) by following each URL
 *    - Kotatsu direct-.jar URLs (downloads + dex2jar + kotatsuLoadExtensions
 *      to synthesize a RepoIndex from the loaded sources)
 *  Merges sub-repos into one RepoIndex. */
export async function getRepoIndex(repoUrl: string, opts: { force?: boolean } = {}): Promise<RepoIndex> {
  const cachePath = repoCachePath(repoUrl);

  // 1. Try cache first (if not forced refresh & not expired)
  if (!opts.force && existsSync(cachePath)) {
    try {
      const cached: RepoIndex = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (Date.now() - cached.fetchedAt < REPO_TTL_MS) {
        return cached;
      }
    } catch {
      // corrupt cache → refetch
    }
  }

  // 2. Fetch fresh
  console.log(`[repo-indexer] fetching ${repoUrl}`);
  const resp = await fetch(repoUrl, { redirect: 'follow' });
  if (!resp.ok) {
    if (existsSync(cachePath)) {
      console.warn(`[repo-indexer] ${repoUrl} returned ${resp.status}, falling back to stale cache`);
      return JSON.parse(readFileSync(cachePath, 'utf8'));
    }
    throw new Error(`Failed to fetch repo ${repoUrl}: HTTP ${resp.status}`);
  }

  // 2a. Check if this is a Kotatsu direct-.jar URL (binary, not JSON)
  const contentType = resp.headers.get('content-type') ?? '';
  const urlEndsWithJar = repoUrl.toLowerCase().endsWith('.jar');
  if (urlEndsWithJar || contentType.includes('java-archive') || contentType.includes('application/jar') || contentType.includes('application/java-archive')) {
    // Kotatsu: the repo URL IS a .jar download. We can't parse it as JSON.
    // The sources are discovered AFTER downloading + loading the jar.
    // Return an empty index with a kotatsu marker — the caller (addRepo/install)
    // will trigger the jar download + kotatsuLoadExtensions and synthesize sources.
    console.log(`[repo-indexer] Kotatsu .jar repo detected (content-type=${contentType})`);
    const normalised: RepoIndex = {
      url: repoUrl,
      name: 'Kotatsu Manga Repo',
      extensions: [], // populated lazily after jar download + load
      fetchedAt: Date.now(),
      isKotatsuJar: true,
    } as any;
    try {
      writeFileSync(cachePath, JSON.stringify(normalised, null, 2));
    } catch {}
    return normalised;
  }

  const raw = await resp.json();
  const normalised = normaliseIndex(repoUrl, raw);

  // 3. If this is a CloudStream meta-repo, follow pluginLists and merge.
  if ((normalised as any).isCloudStreamMeta && Array.isArray((normalised as any).pluginLists)) {
    const pluginLists: string[] = (normalised as any).pluginLists;
    console.log(`[repo-indexer] CloudStream meta-repo with ${pluginLists.length} sub-list(s), following...`);
    const subExtensions: RepoExtensionMeta[] = [];
    await Promise.all(
      pluginLists.map(async (subUrl) => {
        try {
          const subResp = await fetch(subUrl, { redirect: 'follow' });
          if (!subResp.ok) {
            console.warn(`[repo-indexer] sub-list ${subUrl} returned ${subResp.status}`);
            return;
          }
          const subRaw = await subResp.json();
          const subIdx = normaliseIndex(subUrl, subRaw);
          // Tag each extension with the original meta-repo URL (so the client
          // can uninstall/track against the repo the user subscribed to).
          for (const ext of subIdx.extensions) {
            (ext as any).repoUrl = repoUrl;
          }
          subExtensions.push(...subIdx.extensions);
        } catch (e: any) {
          console.warn(`[repo-indexer] failed to fetch sub-list ${subUrl}: ${e?.message ?? e}`);
        }
      }),
    );
    normalised.extensions = subExtensions;
    normalised.name = normalised.name ?? 'CloudStream Repo';
    // Remove the meta markers before caching
    delete (normalised as any).isCloudStreamMeta;
    delete (normalised as any).pluginLists;
    console.log(`[repo-indexer] meta-repo resolved: ${subExtensions.length} total extensions`);
  }

  // 4. Persist cache
  try {
    writeFileSync(cachePath, JSON.stringify(normalised, null, 2));
  } catch (e) {
    console.warn(`[repo-indexer] failed to cache ${repoUrl}:`, e);
  }

  return normalised;
}

/** Synthesize a RepoIndex for a Kotatsu .jar from the loaded sources.
 *  Called after installKotatsuJar + kotatsuLoadExtensionsCache.reload(). */
export function synthesizeKotatsuRepoIndex(
  repoUrl: string,
  sources: any[],
): RepoIndex {
  const extensions: RepoExtensionMeta[] = sources.map((s) => {
    const ext: RepoExtensionMeta = {
      id: String(s.id ?? s.name ?? 'unknown'),
      name: String(s.name ?? s.id ?? 'unknown'),
      file: '',
      version: s.version ? String(s.version) : undefined,
      type: 'manga',
      lang: s.lang ? String(s.lang) : undefined,
      isNsfw: !!s.isNsfw,
      baseUrl: s.baseUrl ? String(s.baseUrl) : undefined,
      runtime: 'kotatsu',
    };
    return stampItemTypeAndManager(ext);
  });
  return {
    url: repoUrl,
    name: 'Kotatsu Manga Repo',
    extensions,
    fetchedAt: Date.now(),
  };
}

/** Aggregate available extensions across a user's subscribed repos.
 *  For Kotatsu .jar repos, triggers jar download + load and synthesizes sources. */
export async function listAvailableForRepos(repoUrls: string[]): Promise<{
  repoUrl: string;
  extensions: RepoExtensionMeta[];
}[]> {
  const out: { repoUrl: string; extensions: RepoExtensionMeta[] }[] = [];
  await Promise.all(
    repoUrls.map(async (url) => {
      try {
        const idx = await getRepoIndex(url);
        // Kotatsu .jar repos have empty extensions until we download + load the jar.
        // Try loading but with a short tolerance — if it takes too long, return
        // empty and let the install flow handle it later.
        if ((idx as any).isKotatsuJar && idx.extensions.length === 0) {
          try {
            const { installKotatsuJar } = await import('./kotatsu-installer.js');
            const { kotatsuLoadExtensionsCache } = await import('./ext-loader.js');
            // Check if Kotatsu sources are already cached from a previous load
            const cached = kotatsuLoadExtensionsCache['sources'] ?? [];
            if (cached.length > 0 && kotatsuLoadExtensionsCache['loaded']) {
              const synthesized = synthesizeKotatsuRepoIndex(url, cached);
              out.push({ repoUrl: url, extensions: synthesized.extensions });
              return;
            }
            await installKotatsuJar(url);
            const sources = await kotatsuLoadExtensionsCache.reload();
            const synthesized = synthesizeKotatsuRepoIndex(url, sources);
            out.push({ repoUrl: url, extensions: synthesized.extensions });
          } catch (e: any) {
            console.warn(`[repo-indexer] Kotatsu jar load failed for ${url}: ${e?.message ?? e}`);
            out.push({ repoUrl: url, extensions: [] });
          }
          return;
        }
        out.push({ repoUrl: url, extensions: idx.extensions });
      } catch (e: any) {
        out.push({ repoUrl: url, extensions: [] });
        console.warn(`[repo-indexer] skipping repo ${url}: ${e?.message ?? e}`);
      }
    }),
  );
  return out;
}
