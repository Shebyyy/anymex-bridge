/*
 * JVM Bridge Server — Kotatsu REST Routes
 * ========================================
 * REST API endpoints for Kotatsu manga extension management and reading.
 *
 * Kotatsu extensions (.jar files) provide manga source scraping capabilities.
 * They implement the MangaParser interface and support search, browse, and
 * chapter page list retrieval.
 *
 * Endpoints:
 *   POST /api/kotatsu/install      — Download & install a .jar extension
 *   POST /api/kotatsu/uninstall    — Remove a cached extension
 *   GET  /api/kotatsu/extensions   — List all installed extensions
 *   POST /api/kotatsu/search       — Search manga via a source
 *   POST /api/kotatsu/popular      — Get popular manga
 *   POST /api/kotatsu/latest       — Get latest manga updates
 *   POST /api/kotatsu/detail       — Get manga details
 *   POST /api/kotatsu/page-list    — Get page URLs for a chapter
 */

package com.anymex.bridge.routes

import com.anymex.bridge.extension.ExtensionCache
import com.anymex.bridge.extension.KotatsuExtensionLoader
import com.anymex.bridge.models.*
import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("KotatsuRoutes")

/**
 * Registers all Kotatsu REST API routes.
 *
 * @param loader The Kotatsu extension loader for invoking parser methods
 * @param cache The extension cache for file management
 */
fun Routing.registerKotatsuRoutes(
    loader: KotatsuExtensionLoader,
    cache: ExtensionCache
) {
    route("/api/kotatsu") {

        // ─── Install Extension ──────────────────────────────────────────────
        // Downloads a .jar extension from a URL and loads it
        post("/install") {
            try {
                val request = call.receive<KotatsuInstallRequest>()
                logger.info("Installing Kotatsu extension: ${request.sourceId}")

                // Download the extension
                val jarFile = cache.downloadKotatsuExtension(
                    downloadUrl = request.downloadUrl,
                    sourceId = request.sourceId
                )

                // Load the extension (create ClassLoader, instantiate parser)
                val extensionInfo = loader.installExtension(
                    jarFile = jarFile,
                    sourceId = request.sourceId
                )

                // Register in the cache manifest
                cache.registerKotatsuExtension(extensionInfo)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(extensionInfo)
                )
            } catch (e: Exception) {
                logger.error("Failed to install Kotatsu extension: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Installation failed: ${e.message}")
                )
            }
        }

        // ─── Uninstall Extension ──────────────────────────────────────────────
        // Removes a cached .jar extension and its ClassLoader
        post("/uninstall") {
            try {
                val request = call.receive<KotatsuUninstallRequest>()
                logger.info("Uninstalling Kotatsu extension: ${request.sourceId}")

                loader.uninstallExtension(request.sourceId)
                cache.unregisterKotatsuExtension(request.sourceId)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(mapOf("uninstalled" to true, "sourceId" to request.sourceId))
                )
            } catch (e: Exception) {
                logger.error("Failed to uninstall Kotatsu extension: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Uninstall failed: ${e.message}")
                )
            }
        }

        // ─── List Extensions ────────────────────────────────────────────────
        // Returns metadata for all installed Kotatsu extensions
        get("/extensions") {
            try {
                val extensions = loader.getInstalledExtensions()
                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(extensions)
                )
            } catch (e: Exception) {
                logger.error("Failed to list Kotatsu extensions: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Failed to list extensions: ${e.message}")
                )
            }
        }

        // ─── Search ──────────────────────────────────────────────────────────
        // Searches for manga using a Kotatsu source
        post("/search") {
            try {
                val request = call.receive<KotatsuSearchRequest>()
                logger.info("Kotatsu search: source=${request.sourceId}, query=${request.query}, page=${request.page}")

                val result = loader.invokeParserMethod(
                    request.sourceId,
                    "search",
                    request.query,
                    request.page
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Kotatsu search failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Search failed: ${e.message}")
                )
            }
        }

        // ─── Popular ──────────────────────────────────────────────────────────
        // Gets popular manga from a Kotatsu source
        post("/popular") {
            try {
                val request = call.receive<KotatsuPopularRequest>()
                logger.info("Kotatsu popular: source=${request.sourceId}, page=${request.page}")

                val result = loader.invokeParserMethod(
                    request.sourceId,
                    "getPopular",
                    request.page
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Kotatsu popular failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Popular fetch failed: ${e.message}")
                )
            }
        }

        // ─── Latest ─────────────────────────────────────────────────────────
        // Gets the latest manga updates from a Kotatsu source
        post("/latest") {
            try {
                val request = call.receive<KotatsuLatestRequest>()
                logger.info("Kotatsu latest: source=${request.sourceId}, page=${request.page}")

                val result = loader.invokeParserMethod(
                    request.sourceId,
                    "getLatestUpdates",
                    request.page
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Kotatsu latest failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Latest fetch failed: ${e.message}")
                )
            }
        }

        // ─── Detail ──────────────────────────────────────────────────────────
        // Gets detailed information about a specific manga title
        post("/detail") {
            try {
                val request = call.receive<KotatsuDetailRequest>()
                logger.info("Kotatsu detail: source=${request.sourceId}, url=${request.url}")

                val result = loader.invokeParserMethod(
                    request.sourceId,
                    "getDetails",
                    request.url,
                    request.title,
                    request.cover
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Kotatsu detail failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Detail fetch failed: ${e.message}")
                )
            }
        }

        // ─── Page List ───────────────────────────────────────────────────────
        // Gets page image URLs for a manga chapter
        post("/page-list") {
            try {
                val request = call.receive<KotatsuPageListRequest>()
                logger.info("Kotatsu page-list: source=${request.sourceId}, url=${request.url}")

                val result = loader.invokeParserMethod(
                    request.sourceId,
                    "getPages",
                    request.url,
                    request.name
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("Kotatsu page-list failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Page list fetch failed: ${e.message}")
                )
            }
        }
    }
}
