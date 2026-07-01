/**
 * AnymeX Bridge — Request Router
 *
 * Dispatches ClientRequests to handlers, doing install-gating before
 * forwarding invoke requests to the JAR.
 *
 * For invoke/invokeStream, we:
 *   1. validate userId has the requested ext installed
 *   2. ensure the .apk is downloaded (shared store)
 *   3. forward the inner {method, args, id} to the JAR
 *   4. stream responses back to the client
 *
 * For management actions (install/uninstall/addRepo/etc.), we handle
 * them locally (DB + filesystem) and return JSON immediately.
 */

import { jarRunner } from './jar-runner.js';
import { downloadExt, extPath, isExtCached } from './extension-store.js';
import { apkToJar, extJarDir, isJarCached, jarPathFor } from './dex2jar.js';
import { installCsPlugin, isCsJarCached, csJarDir } from './cs-installer.js';
import { installKotatsuJar, isKotatsuJarCached, kotatsuJarPath } from './kotatsu-installer.js';
import { listAvailableForRepos, getRepoIndex, synthesizeKotatsuRepoIndex } from './repo-indexer.js';
import { loadExtensionsCache, csLoadExtensionsCache, kotatsuLoadExtensionsCache } from './ext-loader.js';
import {
  addRepo,
  getOrCreateUser,
  installExt,
  isExtInstalled,
  listRepos,
  listUserExts,
  removeRepo,
  uninstallExt,
} from './db.js';
import type { ClientRequest, ServerResponse, BridgeAction } from './types.js';
import { stampItemTypeAndManager, ITEM_TYPE_INT, type ItemTypeStr } from './item-type.js';

export type SendFn = (resp: ServerResponse) => void;

/**
 * Management methods that arrive via the `invoke` wrapper.
 *
 * The Dart client calls these via `BridgeDispatcher().invokeMethod(...)` which
 * `RemoteSidecarBridge` wraps as `{action:'invoke', payload:{method:'addRepo',
 * args:{...}}}`. Without interception, `handleInvoke` rejects them because
 * `extId` is null.
 *
 * We intercept them here and re-dispatch as top-level actions so they hit
 * the dedicated `case 'addRepo'` / `case 'install'` / etc. handlers.
 */
const MANAGEMENT_METHODS = new Set<string>([
  'addRepo',
  'removeRepo',
  'listRepos',
  'listAvailable',
  'listInstalled',
  'install',
  'uninstall',
  'loadExtensions',
  'csLoadExtensions',
  'kotatsuLoadExtensions',
]);

/** Main dispatcher. Returns nothing; pushes responses via `send`. */
export async function routeRequest(
  req: ClientRequest,
  send: SendFn,
): Promise<void> {
  const { id, action } = req;
  const userId = req.userId;

  if (!userId) {
    send({ id, status: 'error', error: 'Missing userId (server should set this from SSH key)' });
    return;
  }

  try {
    switch (action) {
      case 'hello': {
        send({ id, status: 'ok', data: { pong: true, userId, ts: Date.now() } });
        return;
      }

      case 'addRepo': {
        const { repoUrl, runtime } = req.payload ?? {};
        if (typeof repoUrl !== 'string' || !/^https?:\/\//.test(repoUrl)) {
          send({ id, status: 'error', error: 'Invalid repoUrl' });
          return;
        }
        if (runtime != null && !['aniyomi', 'cloudstream', 'kotatsu'].includes(runtime)) {
          send({ id, status: 'error', error: `Invalid runtime '${runtime}' (expected aniyomi|cloudstream|kotatsu)` });
          return;
        }
        // Validate the repo is reachable & parses.
        const idx = await getRepoIndex(repoUrl, { force: true });
        addRepo(userId, repoUrl, runtime);

        // For Kotatsu .jar repos, the index is empty until we download + load the jar.
        // Trigger that now so addRepo returns a meaningful extension count.
        if ((idx as any).isKotatsuJar && idx.extensions.length === 0) {
          try {
            await installKotatsuJar(repoUrl);
            const sources = await kotatsuLoadExtensionsCache.reload();
            const synth = synthesizeKotatsuRepoIndex(repoUrl, sources);
            send({ id, status: 'ok', data: { repoUrl, name: synth.name, extensionCount: synth.extensions.length, runtime: 'kotatsu' } });
            return;
          } catch (e: any) {
            send({ id, status: 'ok', data: { repoUrl, name: idx.name, extensionCount: 0, runtime: 'kotatsu', warning: `jar load failed: ${e?.message ?? e}` } });
            return;
          }
        }

        send({ id, status: 'ok', data: { repoUrl, name: idx.name, extensionCount: idx.extensions.length } });
        return;
      }

      case 'removeRepo': {
        const { repoUrl, runtime } = req.payload ?? {};
        removeRepo(userId, repoUrl, runtime);
        send({ id, status: 'ok', data: { repoUrl } });
        return;
      }

      case 'listRepos': {
        const { runtime } = req.payload ?? {};
        const repos = listRepos(userId, runtime);
        send({ id, status: 'ok', data: { repos } });
        return;
      }

      case 'listAvailable': {
        // Optional filters:
        //   payload.type = 'anime' | 'manga' | 'novel'
        //   payload.runtime = 'aniyomi' | 'cloudstream' | 'kotatsu'
        // Mirrors the runtime's fetchAnimeExtensions / fetchMangaExtensions /
        // fetchNovelExtensions — iOS calls each separately so it can populate
        // the three aggregated Rx lists (availableAnimeExtensions etc.).
        const typeFilter: ItemTypeStr | undefined = req.payload?.type;
        if (typeFilter != null && !['anime', 'manga', 'novel'].includes(typeFilter)) {
          send({ id, status: 'error', error: `listAvailable: invalid type '${typeFilter}' (expected anime|manga|novel)` });
          return;
        }
        const runtimeFilter: string | undefined = req.payload?.runtime;
        if (runtimeFilter != null && !['aniyomi', 'cloudstream', 'kotatsu'].includes(runtimeFilter)) {
          send({ id, status: 'error', error: `listAvailable: invalid runtime '${runtimeFilter}' (expected aniyomi|cloudstream|kotatsu)` });
          return;
        }
        const repos = listRepos(userId, runtimeFilter).map((r) => r.repoUrl);
        const grouped = await listAvailableForRepos(repos);
        // Flatten + tag each entry with its source repo.
        const installed = new Set(listUserExts(userId).map((e) => e.extId));
        let all = grouped.flatMap((g) =>
          g.extensions.map((e) => ({
            ...stampItemTypeAndManager({ ...e }),
            repoUrl: g.repoUrl,
            installed: installed.has(e.id),
          })),
        );
        // Filter by runtime FIRST — this prevents CloudStream/Kotatsu extensions
        // from leaking into Aniyomi's list and vice versa.
        if (runtimeFilter) {
          all = all.filter((e) => e.runtime === runtimeFilter || e.managerId === runtimeFilter);
        }
        if (typeFilter) {
          const wantInt = ITEM_TYPE_INT[typeFilter];
          all = all.filter((e) => e.type === typeFilter || e.itemType === wantInt);
        }
        send({ id, status: 'ok', data: { extensions: all, type: typeFilter ?? null } });
        return;
      }

      case 'listInstalled': {
        // Optional filters:
        //   payload.type = 'anime' | 'manga' | 'novel'
        //   payload.runtime = 'aniyomi' | 'cloudstream' | 'kotatsu'
        const typeFilter: ItemTypeStr | undefined = req.payload?.type;
        if (typeFilter != null && !['anime', 'manga', 'novel'].includes(typeFilter)) {
          send({ id, status: 'error', error: `listInstalled: invalid type '${typeFilter}' (expected anime|manga|novel)` });
          return;
        }
        const runtimeFilter: string | undefined = req.payload?.runtime;
        if (runtimeFilter != null && !['aniyomi', 'cloudstream', 'kotatsu'].includes(runtimeFilter)) {
          send({ id, status: 'error', error: `listInstalled: invalid runtime '${runtimeFilter}' (expected aniyomi|cloudstream|kotatsu)` });
          return;
        }
        const userExts = listUserExts(userId);
        // Enrich with metadata from the source repo.
        let enriched = await Promise.all(
          userExts.map(async (ue) => {
            try {
              const idx = await getRepoIndex(ue.repoUrl);
              // Kotatsu: look up source from loaded jar
              if ((idx as any).isKotatsuJar) {
                const sources = await kotatsuLoadExtensionsCache.ensureLoaded();
                const src = sources.find((s) => String(s.id) === String(ue.extId)) ?? null;
                const meta = src
                  ? stampItemTypeAndManager({
                      id: String(src.id ?? ''),
                      name: String(src.name ?? src.id ?? ''),
                      file: '',
                      baseUrl: src.baseUrl ? String(src.baseUrl) : undefined,
                      lang: src.lang ? String(src.lang) : undefined,
                      isNsfw: !!src.isNsfw,
                      version: src.version ? String(src.version) : undefined,
                      type: 'manga',
                      runtime: 'kotatsu',
                    })
                  : null;
                return {
                  ...ue,
                  meta,
                  runtime: 'kotatsu' as const,
                  managerId: 'kotatsu' as const,
                  itemType: 0,
                  jarCached: isKotatsuJarCached(ue.repoUrl),
                };
              }
              const meta = idx.extensions.find((e) => e.id === ue.extId) ?? null;
              const stampedMeta = meta ? stampItemTypeAndManager({ ...meta }) : null;
              const runtime = stampedMeta?.runtime ?? 'aniyomi';
              return {
                ...ue,
                meta: stampedMeta,
                runtime,
                managerId: stampedMeta?.managerId ?? runtime,
                itemType: stampedMeta?.itemType,
                apkCached: runtime === 'aniyomi' ? isExtCached(stampedMeta?.fileUrl ?? '') : false,
                jarCached: runtime === 'cloudstream'
                  ? (stampedMeta?.internalName ? isCsJarCached(stampedMeta.internalName) : false)
                  : (stampedMeta?.pkg ? isJarCached(stampedMeta.pkg) : false),
              };
            } catch {
              // Don't default to 'aniyomi' — preserve whatever runtime the user
              // originally installed this extension under. If we can't determine it,
              // omit runtime/managerId so the client can skip it rather than mis-categorize.
              return { ...ue, meta: null, itemType: undefined, apkCached: false, jarCached: false };
            }
          }),
        );
        // Filter by runtime FIRST — prevents cross-runtime leaking.
        if (runtimeFilter) {
          enriched = enriched.filter((e: any) => e.runtime === runtimeFilter || e.managerId === runtimeFilter || e.meta?.runtime === runtimeFilter || e.meta?.managerId === runtimeFilter);
        }
        if (typeFilter) {
          const wantInt = ITEM_TYPE_INT[typeFilter];
          enriched = enriched.filter((e: any) => e.meta?.type === typeFilter || e.meta?.itemType === wantInt || e.itemType === wantInt);
        }
        send({ id, status: 'ok', data: { extensions: enriched, type: typeFilter ?? null } });
        return;
      }

      case 'loadExtensions': {
        // Force the JAR to rescan the Aniyomi exts-jar folder.
        // Returns the bare `sources` array — the Dart client's
        // `_loadInstalled` does `for (final e in (result as List))` and
        // expects each element to be a Map with keys: type, className,
        // pkgName, version, isNsfw, name, lang, baseUrl, id.
        const sources = await loadExtensionsCache.reload();
        send({ id, status: 'ok', data: sources });
        return;
      }

      case 'csLoadExtensions': {
        // Force the JAR to rescan the CloudStream exts-jar-cs folder.
        // Returns the bare `sources` array — the Dart client's
        // `_loadInstalled` does `for (final e in (result as List))`.
        const sources = await csLoadExtensionsCache.reload();
        send({ id, status: 'ok', data: sources });
        return;
      }

      case 'kotatsuLoadExtensions': {
        // Force the JAR to rescan the Kotatsu exts-jar-kotatsu folder.
        // Returns the bare `sources` array — the Dart client checks
        // `if (data == null || data is! List)` and then maps each element
        // via `KotatsuSource.fromJson(...)`.
        const sources = await kotatsuLoadExtensionsCache.reload();
        send({ id, status: 'ok', data: sources });
        return;
      }

      case 'install': {
        const { extId, repoUrl } = req.payload ?? {};
        if (typeof extId !== 'string' || typeof repoUrl !== 'string') {
          send({ id, status: 'error', error: 'install requires { extId, repoUrl }' });
          return;
        }
        const idx = await getRepoIndex(repoUrl);

        // Kotatsu special case: the repo is a single .jar containing multiple sources.
        // The "extension" is a source inside that jar — no per-source download.
        if ((idx as any).isKotatsuJar) {
          // Ensure the jar is downloaded + loaded.
          try {
            await installKotatsuJar(repoUrl);
          } catch (e: any) {
            send({ id, status: 'error', error: `Kotatsu jar install failed: ${e?.message ?? e}` });
            return;
          }
          const sources = await kotatsuLoadExtensionsCache.reload();
          const src = sources.find((s) => String(s.id) === String(extId)) ?? null;
          if (!src) {
            send({ id, status: 'error', error: `Kotatsu source ${extId} not found in jar` });
            return;
          }
          // Record install in DB (just marks it active — no per-source download).
          installExt(userId, extId, repoUrl);
          send({
            id,
            status: 'ok',
            data: {
              extId,
              repoUrl,
              runtime: 'kotatsu',
              managerId: 'kotatsu',
              type: 'manga',
              itemType: 0, // manga
              sourceId: src.id,
              name: src.name,
              baseUrl: src.baseUrl,
              lang: src.lang,
              loaded: true,
            },
          });
          return;
        }

        const meta = idx.extensions.find((e) => e.id === extId);
        if (!meta || !meta.fileUrl) {
          send({ id, status: 'error', error: `Extension ${extId} not found in repo ${repoUrl}` });
          return;
        }

        // 1. Record install in DB.
        installExt(userId, extId, repoUrl);

        // 2. Branch on runtime.
        const runtime = meta.runtime ?? 'aniyomi';
        if (runtime === 'cloudstream') {
          // CloudStream: download .cs3 + .jar, repackage with bridge manifest.
          let jarPath: string | undefined;
          let installError: string | undefined;
          try {
            jarPath = await installCsPlugin({
              name: meta.name,
              internalName: meta.internalName ?? meta.name,
              version: meta.version,
              jarUrl: meta.jarUrl,
              pluginUrl: meta.fileUrl,
              authors: meta.authors,
            });
          } catch (e: any) {
            installError = e?.message ?? String(e);
            console.warn(`[router] CS install failed for ${extId}: ${installError}`);
          }
          // Reload CS extensions in the JAR.
          let sources: any[] = [];
          if (jarPath) {
            try {
              sources = await csLoadExtensionsCache.reload();
            } catch (e: any) {
              console.warn(`[router] csLoadExtensions failed: ${e?.message ?? e}`);
            }
          }
          const loaded = sources.find(
            (s) => String(s.id).toLowerCase() === String(extId).toLowerCase() ||
                   String(s.name).toLowerCase() === String(meta.internalName ?? meta.name).toLowerCase(),
          );
          send({
            id,
            status: jarPath ? 'ok' : 'error',
            error: installError,
            data: {
              extId,
              repoUrl,
              runtime: 'cloudstream',
              managerId: 'cloudstream',
              type: meta.type ?? 'anime',
              itemType: meta.itemType ?? 1, // anime
              internalName: meta.internalName,
              version: meta.version,
              jarPath: jarPath?.split('/').pop(),
              loaded: !!loaded,
              sourceId: loaded?.id ?? extId,
              baseUrl: loaded?.baseUrl ?? meta.baseUrl,
            },
          });
          return;
        }

        // Aniyomi: download .apk → dex2jar → .jar
        const apkPath = await downloadExt(meta.fileUrl);
        let jarPath: string | undefined;
        let convertError: string | undefined;
        try {
          jarPath = await apkToJar(apkPath, meta.pkg ?? extId);
        } catch (e: any) {
          convertError = e?.message ?? String(e);
          console.warn(`[router] dex2jar conversion failed for ${extId}: ${convertError}`);
        }
        // Reload extensions in the JAR so the new .jar is registered.
        let sources: any[] = [];
        if (jarPath) {
          try {
            sources = await loadExtensionsCache.reload();
          } catch (e: any) {
            console.warn(`[router] loadExtensions failed: ${e?.message ?? e}`);
          }
        }
        const loaded = sources.find((s) => String(s.id) === String(extId));
        send({
          id,
          status: jarPath ? 'ok' : 'error',
          error: convertError,
          data: {
            extId,
            repoUrl,
            runtime: 'aniyomi',
            managerId: 'aniyomi',
            type: meta.type,
            itemType: meta.itemType,
            pkg: meta.pkg,
            version: meta.version,
            sourceId: meta.id,
            apkPath,
            jarPath: jarPath?.split('/').pop(),
            loaded: !!loaded,
            baseUrl: loaded?.baseUrl ?? meta.baseUrl,
          },
        });
        return;
      }

      case 'uninstall': {
        const { extId } = req.payload ?? {};
        if (typeof extId !== 'string') {
          send({ id, status: 'error', error: 'uninstall requires { extId }' });
          return;
        }
        uninstallExt(userId, extId);
        send({ id, status: 'ok', data: { extId } });
        // NOTE: We do NOT delete the .apk here — another user may still
        // reference it. A separate GC pass could clean up unreferenced files.
        return;
      }

      case 'invoke': {
        await handleInvoke(req, send, /*stream=*/ false);
        return;
      }

      case 'invokeStream': {
        await handleInvoke(req, send, /*stream=*/ true);
        return;
      }

      case 'cancel': {
        const { innerId } = req.payload ?? {};
        if (typeof innerId !== 'string') {
          send({ id, status: 'error', error: 'cancel requires { innerId }' });
          return;
        }
        // Forward cancel to JAR (same shape SidecarBridge.dart sends).
        await jarRunner.ensureReady();
        await jarRunner.send({ method: 'cancel', args: { id: innerId } });
        send({ id, status: 'ok', data: { cancelled: innerId } });
        return;
      }

      default:
        send({ id, status: 'error', error: `Unknown action: ${action}` });
    }
  } catch (e: any) {
    send({ id, status: 'error', error: e?.message ?? String(e) });
  }
}

/** Handle invoke / invokeStream: gate + forward to JAR + relay responses. */
async function handleInvoke(req: ClientRequest, send: SendFn, stream: boolean): Promise<void> {
  const { id, userId } = req;
  const { extId, method, innerId } = req.payload ?? {};
  let args = req.payload?.args;

  if (typeof method !== 'string') {
    send({ id, status: 'error', error: 'invoke requires { extId, method, args?, innerId? }' });
    return;
  }

  // --- Management method interception ---
  // The Dart client calls management actions (addRepo, install, uninstall,
  // loadExtensions, etc.) via `BridgeDispatcher().invokeMethod(...)`, which
  // `RemoteSidecarBridge` wraps as `{action:'invoke', payload:{method:'addRepo',
  // args:{...}}}` with `extId: null`. Without this interception, `handleInvoke`
  // rejects them at the `extId` validation below.
  //
  // Re-dispatch as top-level actions so they hit the dedicated case handlers
  // (addRepo/install/uninstall/loadExtensions/etc.) which handle them locally
  // (DB + filesystem) and return a single JSON response.
  if (MANAGEMENT_METHODS.has(method)) {
    await routeRequest(
      // `method` is verified to be in MANAGEMENT_METHODS (a subset of
      // BridgeAction), so the cast is safe.
      { id, action: method as BridgeAction, userId, payload: args ?? {} },
      send,
    );
    return;
  }

  if (typeof extId !== 'string') {
    send({ id, status: 'error', error: `invoke requires { extId } for method: ${method}` });
    return;
  }

  // 1. Install-gate
  if (!isExtInstalled(userId!, extId)) {
    send({ id, status: 'error', error: `Extension ${extId} is not installed for user ${userId}` });
    return;
  }

  // 2. Look up metadata + runtime
  const userExts = listUserExts(userId!);
  const ue = userExts.find((e) => e.extId === extId);
  if (!ue) {
    send({ id, status: 'error', error: `Lost reference to ${extId}` });
    return;
  }
  const idx = await getRepoIndex(ue.repoUrl);

  // Kotatsu: the repo is a single .jar, sources are inside it.
  let runtime: 'aniyomi' | 'cloudstream' | 'kotatsu';
  let meta: any;
  if ((idx as any).isKotatsuJar) {
    runtime = 'kotatsu';
    // Ensure jar is downloaded + loaded, then find the source.
    if (!isKotatsuJarCached(ue.repoUrl)) {
      try { await installKotatsuJar(ue.repoUrl); }
      catch (e: any) {
        send({ id, status: 'error', error: `Kotatsu jar install failed: ${e?.message ?? e}` });
        return;
      }
    }
    await kotatsuLoadExtensionsCache.ensureLoaded();
    const src = kotatsuLoadExtensionsCache.getSource(extId);
    if (!src) {
      send({ id, status: 'error', error: `Kotatsu source ${extId} not loaded` });
      return;
    }
    meta = { id: src.id, name: src.name, baseUrl: src.baseUrl, lang: src.lang, runtime: 'kotatsu' };
  } else {
    meta = idx.extensions.find((e) => e.id === extId);
    if (!meta) {
      send({ id, status: 'error', error: `Extension ${extId} metadata missing from repo` });
      return;
    }
    runtime = meta.runtime ?? 'aniyomi';
  }

  // 3. Ensure the binary is downloaded + converted + loaded into the JAR.
  if (runtime === 'cloudstream') {
    // CloudStream: ensure .cs3+.jar downloaded + repackaged + csLoadExtensions called.
    if (!isCsJarCached(meta.internalName ?? meta.name)) {
      try {
        await installCsPlugin({
          name: meta.name,
          internalName: meta.internalName ?? meta.name,
          version: meta.version,
          jarUrl: meta.jarUrl,
          pluginUrl: meta.fileUrl,
          authors: meta.authors,
        });
      } catch (e: any) {
        send({ id, status: 'error', error: `CS install failed: ${e?.message ?? e}` });
        return;
      }
    }
    await csLoadExtensionsCache.ensureLoaded();
  } else if (runtime === 'kotatsu') {
    // Already ensured above.
  } else {
    // Aniyomi: ensure .apk downloaded + dex2jar + loadExtensions called.
    if (meta.fileUrl) {
      const apkPath = await downloadExt(meta.fileUrl); // idempotent
      if (meta.pkg && !isJarCached(meta.pkg)) {
        try {
          await apkToJar(apkPath, meta.pkg);
        } catch (e: any) {
          send({ id, status: 'error', error: `dex2jar conversion failed: ${e?.message ?? e}` });
          return;
        }
      }
    }
    await loadExtensionsCache.ensureLoaded();
  }

  // 4. Build the JAR request — different per runtime.
  //    Aniyomi: { method, args:{...methodArgs, sourceId, isAnime}, id }
  //    CloudStream: method is prefixed 'cs' + args shape differs:
  //      csSearch      → { sourceId, query, page }
  //      csGetDetail   → { sourceId, url }
  //      csGetVideoList→ { sourceId, url }
  //    Kotatsu: method is prefixed 'kotatsu' + args shape:
  //      kotatsuGetPopular      → { sourceId, page }
  //      kotatsuGetLatestUpdates→ { sourceId, page }
  //      kotatsuSearch          → { sourceId, query, page }
  //      kotatsuGetDetail       → { sourceId, media:{title,url,thumbnail_url} }
  //      kotatsuGetPageList     → { sourceId, episode:{name,url} }
  //    The client passes `method` as the Aniyomi-style name (getPopular/search/getDetail/getVideoList);
  //    we translate to the runtime-specific method name + arg shape here.
  let jarMethod: string = method;
  let jarArgs: any;

  if (runtime === 'cloudstream') {
    // Resolve the JAR-assigned sourceId (CloudStream ids may differ from our extId).
    const csSource = csLoadExtensionsCache.getSource(meta.internalName ?? meta.id);
    const csSourceId = csSource?.id ?? meta.id;
    const clientArgs = args ?? {};

    if (method === 'getPopular' || method === 'getLatestUpdates') {
      jarMethod = 'csSearch';
      jarArgs = { sourceId: csSourceId, query: '', page: clientArgs.page ?? 1 };
    } else if (method === 'search') {
      jarMethod = 'csSearch';
      jarArgs = { sourceId: csSourceId, query: clientArgs.query ?? '', page: clientArgs.page ?? 1 };
    } else if (method === 'getDetail') {
      jarMethod = 'csGetDetail';
      jarArgs = { sourceId: csSourceId, url: clientArgs.url ?? clientArgs.media?.url };
    } else if (method === 'getVideoList') {
      jarMethod = 'csGetVideoList';
      jarArgs = { sourceId: csSourceId, url: clientArgs.url ?? clientArgs.episode?.url };
    } else if (method.startsWith('cs')) {
      // Already a CloudStream method — pass through.
      jarMethod = method;
      jarArgs = { ...clientArgs, sourceId: csSourceId };
    } else {
      send({ id, status: 'error', error: `CloudStream runtime doesn't support method: ${method}` });
      return;
    }
  } else if (runtime === 'kotatsu') {
    const kotatsuSourceId = meta.id; // already resolved from kotatsuLoadExtensionsCache
    const clientArgs = args ?? {};

    if (method === 'getPopular') {
      jarMethod = 'kotatsuGetPopular';
      jarArgs = { sourceId: kotatsuSourceId, page: clientArgs.page ?? 1 };
    } else if (method === 'getLatestUpdates') {
      jarMethod = 'kotatsuGetLatestUpdates';
      jarArgs = { sourceId: kotatsuSourceId, page: clientArgs.page ?? 1 };
    } else if (method === 'search') {
      jarMethod = 'kotatsuSearch';
      jarArgs = { sourceId: kotatsuSourceId, query: clientArgs.query ?? '', page: clientArgs.page ?? 1 };
    } else if (method === 'getDetail') {
      jarMethod = 'kotatsuGetDetail';
      // Kotatsu expects { media: { title, url, thumbnail_url } }
      const media = clientArgs.media ?? {};
      jarArgs = {
        sourceId: kotatsuSourceId,
        media: {
          title: media.title ?? clientArgs.title,
          url: media.url ?? clientArgs.url,
          thumbnail_url: media.thumbnail_url ?? media.cover ?? clientArgs.cover,
        },
      };
    } else if (method === 'getPageList' || method === 'getVideoList') {
      // For Kotatsu, "getVideoList" from the client maps to kotatsuGetPageList
      // (Kotatsu is manga-only — returns page URLs, not video streams).
      jarMethod = 'kotatsuGetPageList';
      const episode = clientArgs.episode ?? {};
      jarArgs = {
        sourceId: kotatsuSourceId,
        episode: {
          name: episode.name ?? clientArgs.name,
          url: episode.url ?? clientArgs.url,
        },
      };
    } else if (method.startsWith('kotatsu')) {
      // Already a Kotatsu method — pass through.
      jarMethod = method;
      jarArgs = { ...clientArgs, sourceId: kotatsuSourceId };
    } else {
      send({ id, status: 'error', error: `Kotatsu runtime doesn't support method: ${method}` });
      return;
    }
  } else {
    // Aniyomi
    const sourceId = meta.id;
    const isAnime = meta.type !== 'manga';
    jarArgs = { ...(args ?? {}), sourceId, isAnime };
  }

  // 5. Forward to JAR.
  await jarRunner.ensureReady();
  const jid = innerId ?? id;
  await jarRunner.send({ method: jarMethod, args: jarArgs, id: jid });

  if (!stream) {
    // Wait for ONE final response, then unsubscribe.
    // The JAR's final response has NO status field (just {id, data}) — mirrors
    // Dart SidecarBridge._handleResponse where non-'partial' → complete.
    return new Promise<void>((resolve) => {
      let settled = false;
      const off = jarRunner.onLine((line) => {
        try {
          const resp = JSON.parse(line);
          if (resp?.id !== jid) return;
          if (settled) return;
          const status = resp.status;
          if (status === 'partial' || status === 'log') {
            // Intermediate — forward as a log line.
            send({ id, status: 'log', data: resp.data });
            return;
          }
          settled = true;
          off();
          // Final response. Detect error payloads.
          const isError = status === 'error' || (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data) && resp.data.error);
          if (isError) {
            send({
              id,
              status: 'error',
              error: resp.error ?? (resp.data?.error ? String(resp.data.error) : 'unknown error'),
              data: resp.data,
            });
          } else {
            send({ id, status: 'ok', data: resp.data });
          }
          resolve();
        } catch {
          // not JSON, ignore
        }
      });
      // Safety timeout: 5 min
      setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        send({ id, status: 'error', error: 'invoke timeout (5min)' });
        resolve();
      }, 5 * 60 * 1000);
    });
  } else {
    // Stream: relay all responses with this jid until completed/error.
    // The JAR emits 'partial' for intermediate chunks and 'completed'/'error'
    // for the terminal event. If the JAR sends a statusless response (no
    // 'partial'/'completed'/'error'), treat it as a single chunk.
    return new Promise<void>((resolve) => {
      let settled = false;
      const off = jarRunner.onLine((line) => {
        try {
          const resp = JSON.parse(line);
          if (resp?.id !== jid) return;
          const status = resp.status;
          if (status === 'completed') {
            if (settled) return;
            settled = true;
            off();
            send({ id, status: 'completed' });
            resolve();
          } else if (status === 'error') {
            if (settled) return;
            settled = true;
            off();
            send({ id, status: 'error', error: resp.error ?? 'unknown', data: resp.data });
            resolve();
          } else if (status === 'partial' || status === 'log') {
            // relay chunk
            send({ id, status: 'partial', data: resp.data });
          } else {
            // statusless final (single-shot response) — relay + complete
            if (settled) return;
            settled = true;
            off();
            send({ id, status: 'ok', data: resp.data });
            resolve();
          }
        } catch {}
      });
    });
  }
}

/** Helper for SSH auth: create-or-touch user record from a key fingerprint. */
export function authenticateUser(fingerprint: string): string {
  const user = getOrCreateUser(fingerprint);
  return user.id;
}
