/**
 * AnymeX Bridge — Shared Types
 *
 * Wire protocol between iOS (RemoteSidecarBridge.dart) and this server.
 * One JSON object per line over an SSH exec channel.
 */

/** Actions the iOS client can request. */
export type BridgeAction =
  | 'hello' // ping / handshake
  | 'addRepo' // subscribe user to a repo URL
  | 'removeRepo' // unsubscribe
  | 'listRepos' // list user's subscribed repos
  | 'listAvailable' // list exts available across user's repos
  | 'listInstalled' // list exts the user has installed
  | 'install' // install an ext for the user (download .apk, convert to .jar, load into JAR)
  | 'uninstall' // uninstall
  | 'loadExtensions' // force the JAR to rescan the Aniyomi exts-jar folder
  | 'csLoadExtensions' // force the JAR to rescan the CloudStream exts-jar-cs folder
  | 'kotatsuLoadExtensions' // force the JAR to rescan the Kotatsu exts-jar-kotatsu folder
  | 'invoke' // run a method on an extension (request/response)
  | 'invokeStream' // run a streaming method (multiple responses)
  | 'cancel'; // cancel an in-flight invoke

/** Envelope sent from iOS → server, one per line. */
export interface ClientRequest {
  /** Random correlation id; matches response.id. */
  id: string;
  /** Authenticated user id (set by server from SSH key fingerprint). */
  userId?: string;
  action: BridgeAction;
  /** Action-specific payload. */
  payload?: any;
}

/** Envelope sent from server → iOS, one per line. */
export interface ServerResponse {
  id: string;
  status: 'ok' | 'error' | 'partial' | 'completed' | 'log';
  data?: any;
  error?: string;
}

/** A repo index entry — what an extension repo's index.json describes. */
export interface RepoExtensionMeta {
  /** Stable identifier — the sourceId the JAR returns after loadExtensions. */
  id: string;
  /** Display name (prefix-stripped, e.g. "Animetsu") */
  name: string;
  /** Full name as published (e.g. "Aniyomi: Animetsu") */
  fullName?: string;
  /** Android package name, e.g. "eu.kanade.tachiyomi.animeextension.all.animetsu" */
  pkg?: string;
  /** CloudStream internal name (e.g. "AllMovieLandProvider") */
  internalName?: string;
  /** File name on the repo, e.g. "aniyomi-all.animetsu-v14.6.apk" */
  file: string;
  /** Version string */
  version?: string;
  /** Type: anime / manga / novel (string form, for human/UI). */
  type?: 'anime' | 'manga' | 'novel';
  /**
   * ItemType as the runtime's integer enum — REQUIRED for wire-compat with
   * Source.fromJson which reads `itemType: ItemType.values[json['itemType'] ?? 0]`.
   *   0 = manga, 1 = anime, 2 = novel
   * Emitted alongside `type` (string) for round-trip safety.
   */
  itemType?: number;
  /**
   * The runtime manager that owns this source — used by the iOS client's
   * getSourceManager() to dispatch install/invoke to the correct manager.
   * One of: 'aniyomi' | 'cloudstream' | 'kotatsu' | 'mangayomi' | 'sora'.
   * Currently we only emit 'aniyomi' | 'cloudstream' | 'kotatsu'.
   */
  managerId?: 'aniyomi' | 'cloudstream' | 'kotatsu' | 'mangayomi' | 'sora';
  /** Language code */
  lang?: string;
  /** Source URL for the .apk/.cs3 file */
  fileUrl?: string;
  /** Pre-converted .jar URL (CloudStream provides this — skips dex2jar) */
  jarUrl?: string;
  /** Icon URL */
  iconUrl?: string;
  /** Whether the source is NSFW */
  isNsfw?: boolean;
  /** Base URL of the source (from sources[0].baseUrl or CloudStream url) */
  baseUrl?: string;
  /** Runtime: which JAR method family to use. Auto-detected from repo format. */
  runtime?: 'aniyomi' | 'cloudstream' | 'kotatsu';
  /** CloudStream tvTypes (e.g. ["Movie", "TvSeries", "Anime"]) */
  tvTypes?: string[];
  /** Authors (CloudStream) */
  authors?: string[];
}

/** A repo's parsed index.json. */
export interface RepoIndex {
  /** Repo URL (canonical, after redirects). */
  url: string;
  /** Human-friendly name. */
  name?: string;
  /** List of extensions published by this repo. */
  extensions: RepoExtensionMeta[];
  /** When we last fetched it (epoch ms). */
  fetchedAt: number;
}

/** A user's enabled extension. */
export interface UserExtension {
  userId: string;
  extId: string;
  repoUrl: string;
  installedAt: number;
}

/** A user's subscribed repo. */
export interface UserRepo {
  userId: string;
  repoUrl: string;
  addedAt: number;
}

/** A registered user (identified by SSH public key fingerprint). */
export interface User {
  id: string;
  /** SSH public key fingerprint (sha256:...). */
  pubkeyFingerprint: string;
  /** Optional display name. */
  displayName?: string;
  createdAt: number;
  /** Last seen (epoch ms). */
  lastSeen: number;
}
