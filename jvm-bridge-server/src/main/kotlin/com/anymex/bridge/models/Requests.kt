/*
 * JVM Bridge Server — API Request Models
 * =========================================
 * Data classes representing incoming API request bodies.
 * These mirror the MethodChannel interface used by the AnymeX Flutter app,
 * allowing iOS clients to send the same structured requests over HTTP.
 *
 * Each sealed class hierarchy represents one extension ecosystem.
 * Gson deserializes the JSON body into the appropriate Kotlin data class.
 */

package com.anymex.bridge.models

import com.google.gson.annotations.SerializedName

// ═══════════════════════════════════════════════════════════════════════════════
// ANIYOMI REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Request to install an Aniyomi extension.
 * The server downloads the APK, converts DEX→JAR, and loads the source classes.
 */
data class AniyomiInstallRequest(
    @SerializedName("downloadUrl")
    val downloadUrl: String,
    @SerializedName("pkgName")
    val pkgName: String,
    @SerializedName("repoUrl")
    val repoUrl: String? = null
)

/**
 * Request to uninstall (remove) a cached Aniyomi extension.
 */
data class AniyomiUninstallRequest(
    @SerializedName("pkgName")
    val pkgName: String
)

/**
 * Request to search for media using an Aniyomi source.
 * Supports both anime and manga sources.
 */
data class AniyomiSearchRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true,
    @SerializedName("query")
    val query: String,
    @SerializedName("page")
    val page: Int = 1,
    @SerializedName("filters")
    val filters: List<Map<String, Any>>? = null,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to fetch popular/trending media from an Aniyomi source.
 */
data class AniyomiPopularRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true,
    @SerializedName("page")
    val page: Int = 1,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to fetch the latest updates from an Aniyomi source.
 */
data class AniyomiLatestRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true,
    @SerializedName("page")
    val page: Int = 1,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Minimal media info object used to identify a specific title.
 * Sent from the iOS client when requesting details, video lists, or page lists.
 */
data class AniyomiMediaInfo(
    @SerializedName("title")
    val title: String? = null,
    @SerializedName("url")
    val url: String,
    @SerializedName("thumbnail_url")
    val thumbnailUrl: String? = null,
    @SerializedName("description")
    val description: String? = null,
    @SerializedName("author")
    val author: String? = null,
    @SerializedName("artist")
    val artist: String? = null,
    @SerializedName("genre")
    val genre: List<String>? = null
)

/**
 * Minimal episode info object identifying a specific episode/chapter.
 */
data class AniyomiEpisodeInfo(
    @SerializedName("name")
    val name: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("episode_number")
    val episodeNumber: Float? = null,
    @SerializedName("scanlator")
    val scanlator: String? = null
)

/**
 * Request to get detailed information about a specific media title.
 */
data class AniyomiDetailRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true,
    @SerializedName("media")
    val media: AniyomiMediaInfo,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to get the video list (server URLs) for an anime episode.
 */
data class AniyomiVideoListRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true,
    @SerializedName("episode")
    val episode: AniyomiEpisodeInfo,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to get the page list (image URLs) for a manga chapter.
 */
data class AniyomiPageListRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true,
    @SerializedName("episode")
    val episode: AniyomiEpisodeInfo,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to get available filter/tracker list for an Aniyomi source.
 */
data class AniyomiFilterListRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true
)

/**
 * Request to get preference entries for an Aniyomi source.
 */
data class AniyomiPreferenceRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("isAnime")
    val isAnime: Boolean = true
)

/**
 * Request to save a preference value for an Aniyomi source.
 */
data class AniyomiSavePreferenceRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("key")
    val key: String,
    @SerializedName("value")
    val value: String
)

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUDSTREAM REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Request to install a CloudStream .cs3 plugin.
 */
data class CloudStreamInstallRequest(
    @SerializedName("downloadUrl")
    val downloadUrl: String,
    @SerializedName("fileName")
    val fileName: String
)

/**
 * Request to uninstall a CloudStream plugin.
 */
data class CloudStreamUninstallRequest(
    @SerializedName("apiName")
    val apiName: String
)

/**
 * Request to search for content in CloudStream providers.
 */
data class CloudStreamSearchRequest(
    @SerializedName("query")
    val query: String,
    @SerializedName("apiName")
    val apiName: String? = null,
    @SerializedName("page")
    val page: Int = 1,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to get details about a specific CloudStream title.
 */
data class CloudStreamDetailRequest(
    @SerializedName("apiName")
    val apiName: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

/**
 * Request to get video sources for a CloudStream episode.
 */
data class CloudStreamVideoListRequest(
    @SerializedName("apiName")
    val apiName: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("parameters")
    val parameters: Map<String, String>? = null
)

// ═══════════════════════════════════════════════════════════════════════════════
// KOTATSU REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Request to install a Kotatsu extension (.jar file).
 */
data class KotatsuInstallRequest(
    @SerializedName("downloadUrl")
    val downloadUrl: String,
    @SerializedName("sourceId")
    val sourceId: String
)

/**
 * Request to uninstall a Kotatsu extension.
 */
data class KotatsuUninstallRequest(
    @SerializedName("sourceId")
    val sourceId: String
)

/**
 * Request to search for manga in a Kotatsu source.
 */
data class KotatsuSearchRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("query")
    val query: String,
    @SerializedName("page")
    val page: Int = 1
)

/**
 * Request to get popular manga from a Kotatsu source.
 */
data class KotatsuPopularRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("page")
    val page: Int = 1
)

/**
 * Request to get the latest manga from a Kotatsu source.
 */
data class KotatsuLatestRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("page")
    val page: Int = 1
)

/**
 * Request to get details about a specific Kotatsu manga.
 */
data class KotatsuDetailRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("title")
    val title: String? = null,
    @SerializedName("cover")
    val cover: String? = null
)

/**
 * Request to get the page list for a Kotatsu manga chapter.
 */
data class KotatsuPageListRequest(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("name")
    val name: String? = null
)
