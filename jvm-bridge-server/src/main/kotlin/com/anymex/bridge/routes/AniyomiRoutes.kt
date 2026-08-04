/*
 * JVM Bridge Server — Aniyomi REST Routes
 * ==========================================
 * REST API endpoints for Aniyomi extension management and media operations.
 *
 * These endpoints mirror the Aniyomi MethodChannel interface used in the
 * Flutter app, translated to HTTP POST/GET endpoints with JSON bodies.
 *
 * Endpoints:
 *   POST /api/aniyomi/install       — Download & install an extension APK
 *   POST /api/aniyomi/uninstall     — Remove a cached extension
 *   GET  /api/aniyomi/extensions    — List all installed extensions
 *   POST /api/aniyomi/search        — Search media via a source
 *   POST /api/aniyomi/popular       — Get popular media
 *   POST /api/aniyomi/latest        — Get latest updates
 *   POST /api/aniyomi/detail        — Get media details
 *   POST /api/aniyomi/video-list    — Get video URLs for an episode
 *   POST /api/aniyomi/page-list     — Get page URLs for a chapter
 *   POST /api/aniyomi/filter-list   — Get available filters
 *   POST /api/aniyomi/preference    — Get source preferences
 *   POST /api/aniyomi/save-preference — Save a preference value
 */

package com.anymex.bridge.routes

import com.anymex.bridge.extension.AniyomiExtensionLoader
import com.anymex.bridge.extension.ExtensionCache
import com.anymex.bridge.models.*
import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("AniyomiRoutes")

/**
 * Registers all Aniyomi REST API routes.
 *
 * @param loader The Aniyomi extension loader for invoking source methods
 * @param cache The extension cache for file management
 */
fun Routing.registerAniyomiRoutes(
    loader: AniyomiExtensionLoader,
    cache: ExtensionCache
) {
    route("/api/aniyomi") {

        // ─── Install Extension ──────────────────────────────────────────────
        // Downloads an extension APK from a URL, converts DEX→JAR, loads classes
        post("/install") {
            try {
                val request = call.receive<AniyomiInstallRequest>()
                logger.info("Installing Aniyomi extension: ${request.pkgName}")

                // Download the APK
                val apkFile = cache.downloadAniyomiApk(
                    downloadUrl = request.downloadUrl,
                    pkgName = request.pkgName,
                    repoUrl = request.repoUrl
                )

                // Load the extension (convert DEX, create ClassLoader, instantiate source)
                val extensionInfo = loader.installExtension(
                    apkFile = apkFile,
                    pkgName = request.pkgName,
                    repoUrl = request.repoUrl
                )

                // Register in the cache manifest
                cache.registerAniyomiExtension(extensionInfo)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(extensionInfo)
                )
            } catch (e: Exception) {
                logger.error("Failed to install Aniyomi extension: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Installation failed: ${e.message}")
                )
            }
        }

        // ─── Uninstall Extension ────────────────────────────────────────────
        // Removes a cached extension APK and its converted JAR
        post("/uninstall") {
            try {
                val request = call.receive<AniyomiUninstallRequest>()
                logger.info("Uninstalling Aniyomi extension: ${request.pkgName}")

                loader.uninstallExtension(request.pkgName)
                cache.unregisterAniyomiExtension(request.pkgName)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(mapOf("uninstalled" to true, "pkgName" to request.pkgName))
                )
            } catch (e: Exception) {
                logger.error("Failed to uninstall Aniyomi extension: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Uninstall failed: ${e.message}")
                )
            }
        }

        // ─── List Extensions ───────────────────────────────────────────────
        // Returns metadata for all installed Aniyomi extensions
        get("/extensions") {
            try {
                val extensions = loader.getInstalledExtensions()
                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(extensions)
                )
            } catch (e: Exception) {
                logger.error("Failed to list Aniyomi extensions: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Failed to list extensions: ${e.message}")
                )
            }
        }

        // ─── Search ─────────────────────────────────────────────────────────
        // Searches for media using a specific Aniyomi source
        post("/search") {
            try {
                val request = call.receive<AniyomiSearchRequest>()
                logger.info("Aniyomi search: source=${request.sourceId}, query=${request.query}, page=${request.page}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "search",
                    request.query,
                    request.page,
                    request.filters,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi search failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Search failed: ${e.message}")
                )
            }
        }

        // ─── Popular ────────────────────────────────────────────────────────
        // Gets popular/trending media from a source
        post("/popular") {
            try {
                val request = call.receive<AniyomiPopularRequest>()
                logger.info("Aniyomi popular: source=${request.sourceId}, page=${request.page}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getPopular",
                    request.page,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi popular failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Popular fetch failed: ${e.message}")
                )
            }
        }

        // ─── Latest ─────────────────────────────────────────────────────────
        // Gets the latest updates from a source
        post("/latest") {
            try {
                val request = call.receive<AniyomiLatestRequest>()
                logger.info("Aniyomi latest: source=${request.sourceId}, page=${request.page}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getLatestUpdates",
                    request.page,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi latest failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Latest fetch failed: ${e.message}")
                )
            }
        }

        // ─── Detail ─────────────────────────────────────────────────────────
        // Gets detailed information about a specific media title
        post("/detail") {
            try {
                val request = call.receive<AniyomiDetailRequest>()
                logger.info("Aniyomi detail: source=${request.sourceId}, media=${request.media.title}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getDetail",
                    request.media,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi detail failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Detail fetch failed: ${e.message}")
                )
            }
        }

        // ─── Video List ──────────────────────────────────────────────────────
        // Gets video source URLs for an anime episode
        post("/video-list") {
            try {
                val request = call.receive<AniyomiVideoListRequest>()
                logger.info("Aniyomi video-list: source=${request.sourceId}, episode=${request.episode.name}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getVideoList",
                    request.episode,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi video-list failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Video list fetch failed: ${e.message}")
                )
            }
        }

        // ─── Page List ───────────────────────────────────────────────────────
        // Gets page image URLs for a manga chapter
        post("/page-list") {
            try {
                val request = call.receive<AniyomiPageListRequest>()
                logger.info("Aniyomi page-list: source=${request.sourceId}, episode=${request.episode.name}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getPageList",
                    request.episode,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi page-list failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Page list fetch failed: ${e.message}")
                )
            }
        }

        // ─── Filter List ───────────────────────────────────────────────────
        // Gets the available filter/tracker options for a source
        post("/filter-list") {
            try {
                val request = call.receive<AniyomiFilterListRequest>()
                logger.info("Aniyomi filter-list: source=${request.sourceId}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getFilterList"
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi filter-list failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Filter list fetch failed: ${e.message}")
                )
            }
        }

        // ─── Preference ─────────────────────────────────────────────────────
        // Gets the preference entries (settings) for a source
        post("/preference") {
            try {
                val request = call.receive<AniyomiPreferenceRequest>()
                logger.info("Aniyomi preference: source=${request.sourceId}")

                val result = loader.invokeSourceMethod(
                    request.sourceId,
                    "getPreferenceList"
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Aniyomi preference failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Preference fetch failed: ${e.message}")
                )
            }
        }

        // ─── Save Preference ────────────────────────────────────────────────
        // Saves a preference value for a source (replaces SharedPreferences)
        post("/save-preference") {
            try {
                val request = call.receive<AniyomiSavePreferenceRequest>()
                logger.info("Aniyomi save-preference: source=${request.sourceId}, key=${request.key}")

                loader.savePreference(request.sourceId, request.key, request.value)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(
                        mapOf(
                            "saved" to true,
                            "sourceId" to request.sourceId,
                            "key" to request.key,
                            "value" to request.value
                        )
                    )
                )
            } catch (e: Exception) {
                logger.error("Aniyomi save-preference failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Preference save failed: ${e.message}")
                )
            }
        }
    }
}
