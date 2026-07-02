/**
 * AnymeX Bridge — Extension Loader
 *
 * Calls the JAR's `loadExtensions({folderPath})` method (Aniyomi) and
 * `csLoadExtensions({folderPath})` method (CloudStream) to make it scan
 * the exts-jar / exts-jar-cs folders and register all converted .jar files.
 * Caches the returned source list so we can verify a sourceId is known
 * before invoking.
 *
 * The JAR returns a list like:
 *   [{ id, name, className, pkgName, version, lang, isNsfw, baseUrl, type }, ...]
 */

import { jarRunner } from './jar-runner.js';
import { extJarDir } from './dex2jar.js';
import { csJarDir } from './cs-installer.js';
import { kotatsuJarDir } from './kotatsu-installer.js';

class ExtLoaderCache {
  private sources: any[] = [];
  private loaded = false;
  private loadingPromise: Promise<any[]> | null = null;

  /** Ensure loadExtensions has been called at least once. */
  async ensureLoaded(): Promise<any[]> {
    if (this.loaded) return this.sources;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._doReload();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  /** Force a fresh loadExtensions call — deduplicates concurrent calls. */
  async reload(): Promise<any[]> {
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._doReload();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async _doReload(): Promise<any[]> {
    await jarRunner.ensureReady();
    const id = `loadext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[ext-loader] calling loadExtensions(folderPath=${extJarDir()}) id=${id}`);
    await jarRunner.send({ method: 'loadExtensions', args: { folderPath: extJarDir() }, id });

    const resp = await waitForJarResponse(id);
    if (resp.status === 'error') {
      console.warn(`[ext-loader] loadExtensions failed: ${resp.error}`);
      // Don't throw — return whatever we have cached so callers don't break.
      if (this.sources.length > 0) return this.sources;
      throw new Error(resp.error ?? 'loadExtensions failed');
    }
    const data = resp.data;
    const list = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : [];
    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      console.warn(`[ext-loader] loadExtensions error in data: ${data.error}`);
      if (this.sources.length > 0) return this.sources;
      throw new Error(String(data.error));
    }
    this.sources = list;
    this.loaded = true;
    console.log(`[ext-loader] ✓ loaded ${list.length} Aniyomi sources`);
    for (const s of list.slice(0, 5)) {
      console.log(`[ext-loader]   - id=${s.id} name=${s.name} pkg=${s.pkgName} type=${s.type}`);
    }
    return list;
  }

  /** Look up a source by id. */
  getSource(sourceId: string): any | null {
    return this.sources.find((s) => String(s.id) === String(sourceId)) ?? null;
  }

  /** Invalidate cache (e.g. after JAR restart). */
  invalidate(): void {
    this.loaded = false;
    this.sources = [];
  }
}

/** CloudStream loader — same pattern but calls csLoadExtensions on the cs folder. */
class CsExtLoaderCache {
  private sources: any[] = [];
  private loaded = false;
  private loadingPromise: Promise<any[]> | null = null;

  async ensureLoaded(): Promise<any[]> {
    if (this.loaded) return this.sources;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._doReload();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async reload(): Promise<any[]> {
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._doReload();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async _doReload(): Promise<any[]> {
    await jarRunner.ensureReady();
    const id = `csloadext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[ext-loader] calling csLoadExtensions(folderPath=${csJarDir()}) id=${id}`);
    await jarRunner.send({ method: 'csLoadExtensions', args: { folderPath: csJarDir() }, id });

    const resp = await waitForJarResponse(id);
    if (resp.status === 'error') {
      console.warn(`[ext-loader] csLoadExtensions failed: ${resp.error}`);
      if (this.sources.length > 0) return this.sources;
      throw new Error(resp.error ?? 'csLoadExtensions failed');
    }
    const data = resp.data;
    const list = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : [];
    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      console.warn(`[ext-loader] csLoadExtensions error in data: ${data.error}`);
      if (this.sources.length > 0) return this.sources;
      throw new Error(String(data.error));
    }
    this.sources = list;
    this.loaded = true;
    console.log(`[ext-loader] ✓ loaded ${list.length} CloudStream sources`);
    for (const s of list.slice(0, 5)) {
      console.log(`[ext-loader]   - id=${s.id} name=${s.name} baseUrl=${s.baseUrl ?? '-'}`);
    }
    return list;
  }

  /** Look up a source by id OR internalName (CloudStream ids are often lowercased names). */
  getSource(idOrName: string): any | null {
    const lower = String(idOrName).toLowerCase();
    return (
      this.sources.find((s) => String(s.id) === String(idOrName)) ??
      this.sources.find((s) => String(s.id).toLowerCase() === lower) ??
      this.sources.find((s) => String(s.name).toLowerCase() === lower) ??
      null
    );
  }

  invalidate(): void {
    this.loaded = false;
    this.sources = [];
  }
}

/** Kotatsu loader — calls kotatsuLoadExtensions on the kotatsu folder.
 *  ONE .jar contains MULTIPLE manga sources. */
class KotatsuExtLoaderCache {
  private sources: any[] = [];
  private loaded = false;
  private loadingPromise: Promise<any[]> | null = null;

  async ensureLoaded(): Promise<any[]> {
    if (this.loaded) return this.sources;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._doReload();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async reload(): Promise<any[]> {
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this._doReload();
    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async _doReload(): Promise<any[]> {
    await jarRunner.ensureReady();
    const id = `kotatsuloadext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[ext-loader] calling kotatsuLoadExtensions(folderPath=${kotatsuJarDir()}) id=${id}`);
    await jarRunner.send({ method: 'kotatsuLoadExtensions', args: { folderPath: kotatsuJarDir() }, id });

    const resp = await waitForJarResponse(id);
    if (resp.status === 'error') {
      console.warn(`[ext-loader] kotatsuLoadExtensions failed: ${resp.error}`);
      if (this.sources.length > 0) return this.sources;
      throw new Error(resp.error ?? 'kotatsuLoadExtensions failed');
    }
    // Kotatsu may return a JSON string instead of a parsed list
    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch {}
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : [];
    if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      console.warn(`[ext-loader] kotatsuLoadExtensions error in data: ${data.error}`);
      if (this.sources.length > 0) return this.sources;
      throw new Error(String(data.error));
    }
    this.sources = list;
    this.loaded = true;
    console.log(`[ext-loader] ✓ loaded ${list.length} Kotatsu sources`);
    for (const s of list.slice(0, 5)) {
      console.log(`[ext-loader]   - id=${s.id} name=${s.name} baseUrl=${s.baseUrl ?? '-'}`);
    }
    return list;
  }

  /** Look up a source by id. */
  getSource(sourceId: string): any | null {
    return this.sources.find((s) => String(s.id) === String(sourceId)) ?? null;
  }

  invalidate(): void {
    this.loaded = false;
    this.sources = [];
  }
}

/** Shared helper: wait for the JAR to send a final response for a given id.
 *  The JAR's final response has NO status field (just {id, data}) — mirrors
 *  Dart SidecarBridge._handleResponse where non-'partial' → complete. */
function waitForJarResponse(id: string, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    const off = jarRunner.onLine((line) => {
      try {
        const r = JSON.parse(line);
        if (r?.id !== id) return;
        if (settled) return;
        const status = r.status;
        if (status === 'partial' || status === 'log') return;
        settled = true;
        off();
        resolve(r);
      } catch {}
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve({ id, status: 'error', error: `JAR response timeout (${timeoutMs}ms)` });
    }, timeoutMs).unref();
  });
}

export const loadExtensionsCache = new ExtLoaderCache();
export const csLoadExtensionsCache = new CsExtLoaderCache();
export const kotatsuLoadExtensionsCache = new KotatsuExtLoaderCache();
