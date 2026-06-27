/**
 * ItemType ↔ int conversion.
 *
 * Mirrors the runtime's `enum ItemType { manga, anime, novel }` from
 * cloned-repos/AnymeXExtensionRuntimeBridge/lib/Models/Source.dart, which
 * reads `itemType: ItemType.values[json['itemType'] ?? 0]` from the wire.
 *
 *   0 = manga
 *   1 = anime
 *   2 = novel
 */

import type { RepoExtensionMeta } from './types.js';

export type ItemTypeStr = 'anime' | 'manga' | 'novel';

export const ITEM_TYPE_INT: Record<ItemTypeStr, number> = {
  manga: 0,
  anime: 1,
  novel: 2,
};

export const ITEM_TYPE_STR: Record<number, ItemTypeStr> = {
  0: 'manga',
  1: 'anime',
  2: 'novel',
};

/** Convert a string type to the runtime's int enum. Unknown → undefined. */
export function itemTypeToInt(t: ItemTypeStr | undefined): number | undefined {
  if (t == null) return undefined;
  return ITEM_TYPE_INT[t];
}

/** Convert the runtime's int enum to a string type. Unknown → undefined. */
export function intToItemType(n: number | undefined): ItemTypeStr | undefined {
  if (n == null) return undefined;
  return ITEM_TYPE_STR[n];
}

/**
 * Map a runtime string to its managerId (the runtime Extension.id used by
 * getSourceManager() to dispatch install/invoke).
 *
 * Runtime source (ExtensionManager.dart + each *Extensions.dart):
 *   aniyomi    → supportsAnime + supportsManga (split by name prefix)
 *   cloudstream → supportsAnime only
 *   kotatsu    → supportsManga only
 *   mangayomi  → supportsAnime + supportsManga + supportsNovel
 *   sora       → supportsAnime + supportsManga + supportsNovel
 *
 * Currently the bridge server only supports aniyomi / cloudstream / kotatsu.
 */
export function runtimeToManagerId(
  runtime: 'aniyomi' | 'cloudstream' | 'kotatsu',
): 'aniyomi' | 'cloudstream' | 'kotatsu' {
  return runtime;
}

/**
 * Stamp a RepoExtensionMeta with both `itemType` (int) and `managerId`,
 * based on its existing `type` (string) + `runtime` fields.
 *
 * Mutates + returns the same object for convenience.
 */
export function stampItemTypeAndManager(ext: RepoExtensionMeta): RepoExtensionMeta {
  if (ext.itemType == null && ext.type != null) {
    ext.itemType = ITEM_TYPE_INT[ext.type];
  }
  if (ext.type == null && ext.itemType != null) {
    ext.type = ITEM_TYPE_STR[ext.itemType];
  }
  if (ext.managerId == null && ext.runtime != null) {
    ext.managerId = runtimeToManagerId(ext.runtime);
  }
  return ext;
}
