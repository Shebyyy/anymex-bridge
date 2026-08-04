/*
 * JVM Bridge Server — API Response Models
 * =========================================
 * Data classes representing outgoing API responses.
 * All responses follow a consistent envelope format:
 *
 *   {
 *     "success": true|false,
 *     "data": <payload or null>,
 *     "error": <message or null>
 *   }
 *
 * This format mirrors the MethodChannel Result pattern used in the Flutter app,
 * making the HTTP API a drop-in replacement for the native bridge.
 */

package com.anymex.bridge.models

import com.google.gson.annotations.SerializedName

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC RESPONSE ENVELOPE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Standard API response envelope.
 * All endpoints return this wrapper to provide consistent success/error handling.
 *
 * @param T The type of the data payload. Gson serializes this to a JSON object.
 */
data class ApiResponse<T>(
    @SerializedName("success")
    val success: Boolean,
    @SerializedName("data")
    val data: T? = null,
    @SerializedName("error")
    val error: String? = null
) {
    companion object {
        /**
         * Creates a successful response with the given data payload.
         */
        fun <T> success(data: T): ApiResponse<T> = ApiResponse(
            success = true,
            data = data,
            error = null
        )

        /**
         * Creates an error response with the given error message.
         */
        fun <T> error(message: String): ApiResponse<T> = ApiResponse(
            success = false,
            data = null,
            error = message
        )
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENSION / PLUGIN INFO MODELS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Metadata about an installed Aniyomi extension.
 * Extracted from the APK manifest and source class annotations.
 */
data class AniyomiExtensionInfo(
    @SerializedName("pkgName")
    val pkgName: String,
    @SerializedName("name")
    val name: String,
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("lang")
    val lang: String,
    @SerializedName("isAnime")
    val isAnime: Boolean,
    @SerializedName("versionCode")
    val versionCode: Long,
    @SerializedName("versionName")
    val versionName: String?,
    @SerializedName("hasSettings")
    val hasSettings: Boolean = false,
    @SerializedName("repoUrl")
    val repoUrl: String? = null,
    @SerializedName("installedAt")
    val installedAt: Long = System.currentTimeMillis()
)

/**
 * Metadata about a registered CloudStream provider.
 */
data class CloudStreamProviderInfo(
    @SerializedName("apiName")
    val apiName: String,
    @SerializedName("name")
    val name: String,
    @SerializedName("type")
    val type: String,
    @SerializedName("lang")
    val lang: String? = null,
    @SerializedName("status")
    val status: String = "loaded"
)

/**
 * Metadata about an installed Kotatsu extension.
 */
data class KotatsuExtensionInfo(
    @SerializedName("sourceId")
    val sourceId: String,
    @SerializedName("title")
    val title: String,
    @SerializedName("lang")
    val lang: String,
    @SerializedName("state")
    val state: String = "loaded"
)

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH & MEDIA RESULT MODELS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single search result item from any source.
 * Uses generic String maps to accommodate the varying schemas across
 * Aniyomi, CloudStream, and Kotatsu source types.
 */
data class SearchResultItem(
    @SerializedName("title")
    val title: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("thumbnailUrl")
    val thumbnailUrl: String? = null,
    @SerializedName("description")
    val description: String? = null,
    @SerializedName("genre")
    val genre: List<String>? = null,
    @SerializedName("author")
    val author: String? = null,
    @SerializedName("artist")
    val artist: String? = null,
    @SerializedName("status")
    val status: String? = null,
    @SerializedName("extra")
    val extra: Map<String, Any>? = null
)

/**
 * A paginated list of search results.
 */
data class SearchResults(
    @SerializedName("results")
    val results: List<SearchResultItem>,
    @SerializedName("hasNextPage")
    val hasNextPage: Boolean = false
)

// ═══════════════════════════════════════════════════════════════════════════════
// DETAIL RESPONSE MODELS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detailed information about a media title (anime series, manga, movie, etc.)
 */
data class MediaDetailInfo(
    @SerializedName("title")
    val title: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("thumbnailUrl")
    val thumbnailUrl: String? = null,
    @SerializedName("description")
    val description: String? = null,
    @SerializedName("genre")
    val genre: List<String>? = null,
    @SerializedName("author")
    val author: String? = null,
    @SerializedName("artist")
    val artist: String? = null,
    @SerializedName("status")
    val status: String? = null,
    @SerializedName("chapters")
    val chapters: List<EpisodeInfo>? = null,
    @SerializedName("episodes")
    val episodes: List<EpisodeInfo>? = null,
    @SerializedName("extra")
    val extra: Map<String, Any>? = null
)

/**
 * Information about a single episode or chapter.
 */
data class EpisodeInfo(
    @SerializedName("name")
    val name: String,
    @SerializedName("url")
    val url: String,
    @SerializedName("episodeNumber")
    val episodeNumber: Float? = null,
    @SerializedName("scanlator")
    val scanlator: String? = null,
    @SerializedName("dateUpload")
    val dateUpload: Long? = null,
    @SerializedName("extra")
    val extra: Map<String, Any>? = null
)

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO / PAGE LIST MODELS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single video source (quality + URL).
 */
data class VideoSource(
    @SerializedName("url")
    val url: String,
    @SerializedName("quality")
    val quality: String? = null,
    @SerializedName("headers")
    val headers: Map<String, String>? = null,
    @SerializedName("extraData")
    val extraData: Map<String, Any>? = null
)

/**
 * A single manga page image URL.
 */
data class PageItem(
    @SerializedName("url")
    val url: String,
    @SerializedName("headers")
    val headers: Map<String, String>? = null,
    @SerializedName("pageNumber")
    val pageNumber: Int? = null
)

// ═══════════════════════════════════════════════════════════════════════════════
// FILTER & PREFERENCE MODELS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A filter/tracker entry from a source's filter list.
 * Uses String maps because filter types vary widely across sources.
 */
data class FilterEntry(
    @SerializedName("type")
    val type: String,
    @SerializedName("name")
    val name: String,
    @SerializedName("state")
    val state: Map<String, Any>? = null
)

/**
 * A preference (setting) entry from a source.
 */
data class PreferenceEntry(
    @SerializedName("key")
    val key: String,
    @SerializedName("title")
    val title: String,
    @SerializedName("summary")
    val summary: String? = null,
    @SerializedName("type")
    val type: String,
    @SerializedName("currentValue")
    val currentValue: Any? = null,
    @SerializedName("defaultValue")
    val defaultValue: Any? = null,
    @SerializedName("entries")
    val entries: Map<String, String>? = null
)

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH / STATUS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Server health status response.
 */
data class HealthStatus(
    @SerializedName("status")
    val status: String = "ok",
    @SerializedName("version")
    val version: String = "1.0.0",
    @SerializedName("serverName")
    val serverName: String = "AnymeX JVM Bridge Server",
    @SerializedName("uptimeMs")
    val uptimeMs: Long,
    @SerializedName("aniyomiExtensions")
    val aniyomiExtensions: Int = 0,
    @SerializedName("cloudStreamPlugins")
    val cloudStreamPlugins: Int = 0,
    @SerializedName("kotatsuExtensions")
    val kotatsuExtensions: Int = 0,
    @SerializedName("totalExtensions")
    val totalExtensions: Int = 0,
    @SerializedName("jvmInfo")
    val jvmInfo:JvmInfo = JvmInfo()
)

/**
 * JVM runtime information included in health check.
 */
data class JvmInfo(
    @SerializedName("javaVersion")
    val javaVersion: String = System.getProperty("java.version", "unknown"),
    @SerializedName("jvmName")
    val jvmName: String = System.getProperty("java.vm.name", "unknown"),
    @SerializedName("osName")
    val osName: String = System.getProperty("os.name", "unknown"),
    @SerializedName("osArch")
    val osArch: String = System.getProperty("os.arch", "unknown"),
    @SerializedName("availableProcessors")
    val availableProcessors: Int = Runtime.getRuntime().availableProcessors(),
    @SerializedName("maxMemoryMB")
    val maxMemoryMB: Long = Runtime.getRuntime().maxMemory() / (1024 * 1024),
    @SerializedName("usedMemoryMB")
    val usedMemoryMB: Long = (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) / (1024 * 1024),
    @SerializedName("freeMemoryMB")
    val freeMemoryMB: Long = Runtime.getRuntime().freeMemory() / (1024 * 1024)
)
