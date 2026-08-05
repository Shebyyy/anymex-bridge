/*
 * JVM Bridge Server — CloudStream REST Routes
 * ==============================================
 * REST API endpoints for CloudStream plugin management and media operations.
 *
 * CloudStream plugins (.cs3 files) are Kotlin/JVM JARs that provide
 * movie/TV/anime streaming source scraping capabilities.
 *
 * Endpoints:
 *   POST /api/cloudstream/install    — Download & install a .cs3 plugin
 *   POST /api/cloudstream/uninstall  — Remove a cached plugin
 *   GET  /api/cloudstream/providers  — List all installed providers
 *   POST /api/cloudstream/search    — Search content via a provider
 *   POST /api/cloudstream/detail    — Get content details
 *   POST /api/cloudstream/video-list — Get video sources for an episode
 */

package com.anymex.bridge.routes

import com.anymex.bridge.extension.CloudStreamPluginLoader
import com.anymex.bridge.extension.ExtensionCache
import com.anymex.bridge.models.*
import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("CloudStreamRoutes")

/**
 * Registers all CloudStream REST API routes.
 *
 * @param loader The CloudStream plugin loader for invoking provider methods
 * @param cache The extension cache for file management
 */
fun Routing.registerCloudStreamRoutes(
    loader: CloudStreamPluginLoader,
    cache: ExtensionCache
) {
    route("/api/cloudstream") {

        // ─── Install Plugin ─────────────────────────────────────────────────
        // Downloads a .cs3 plugin from a URL and loads it
        post("/install") {
            try {
                val request = call.receive<CloudStreamInstallRequest>()
                logger.info("Installing CloudStream plugin: ${request.fileName}")

                // Download the plugin
                val pluginFile = cache.downloadCloudStreamPlugin(
                    downloadUrl = request.downloadUrl,
                    fileName = request.fileName
                )

                // Load the plugin (create ClassLoader, instantiate provider)
                val providerInfo = loader.installPlugin(
                    pluginFile = pluginFile,
                    apiName = request.fileName.removeSuffix(".cs3")
                )

                // Register in the cache manifest
                cache.registerCloudStreamPlugin(providerInfo)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(providerInfo)
                )
            } catch (e: Exception) {
                logger.error("Failed to install CloudStream plugin: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Installation failed: ${e.message}")
                )
            }
        }

        // ─── Uninstall Plugin ───────────────────────────────────────────────
        // Removes a cached .cs3 plugin and its ClassLoader
        post("/uninstall") {
            try {
                val request = call.receive<CloudStreamUninstallRequest>()
                logger.info("Uninstalling CloudStream plugin: ${request.apiName}")

                loader.uninstallPlugin(request.apiName)
                cache.unregisterCloudStreamPlugin(request.apiName)

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(mapOf("uninstalled" to true, "apiName" to request.apiName))
                )
            } catch (e: Exception) {
                logger.error("Failed to uninstall CloudStream plugin: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Uninstall failed: ${e.message}")
                )
            }
        }

        // ─── List Providers ────────────────────────────────────────────────
        // Returns metadata for all installed CloudStream providers
        get("/providers") {
            try {
                val providers = loader.getInstalledProviders()
                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(providers)
                )
            } catch (e: Exception) {
                logger.error("Failed to list CloudStream providers: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Failed to list providers: ${e.message}")
                )
            }
        }

        // ─── Search ─────────────────────────────────────────────────────────
        // Searches for content using a CloudStream provider
        post("/search") {
            try {
                val request = call.receive<CloudStreamSearchRequest>()
                logger.info("CloudStream search: provider=${request.apiName}, query=${request.query}, page=${request.page}")

                // If apiName is specified, use that specific provider
                val apiName = request.apiName
                if (apiName != null) {
                    val result = loader.invokeProviderMethod(
                        apiName,
                        "search",
                        request.query,
                        request.page,
                        request.parameters
                    )
                    call.respond(
                        HttpStatusCode.OK,
                        ApiResponse.success(result)
                    )
                } else {
                    // Search across all providers
                    val providers = loader.getInstalledProviders()
                    val results = mutableListOf<Any>()
                    for (provider in providers) {
                        try {
                            val result = loader.invokeProviderMethod(
                                provider.apiName,
                                "search",
                                request.query,
                                request.page,
                                request.parameters
                            )
                            if (result != null) {
                                results.add(result)
                            }
                        } catch (e: Exception) {
                            logger.warn("Search failed on provider ${provider.apiName}: ${e.message}")
                        }
                    }
                    call.respond(
                        HttpStatusCode.OK,
                        ApiResponse.success(mapOf("results" to results))
                    )
                }
            } catch (e: Exception) {
                logger.error("CloudStream search failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Search failed: ${e.message}")
                )
            }
        }

        // ─── Detail ─────────────────────────────────────────────────────────
        // Gets detailed information about a specific title
        post("/detail") {
            try {
                val request = call.receive<CloudStreamDetailRequest>()
                logger.info("CloudStream detail: provider=${request.apiName}, url=${request.url}")

                val result = loader.invokeProviderMethod(
                    request.apiName,
                    "getDetail",
                    request.url,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("CloudStream detail failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Detail fetch failed: ${e.message}")
                )
            }
        }

        // ─── Video List ──────────────────────────────────────────────────────
        // Gets video source URLs for a CloudStream episode
        post("/video-list") {
            try {
                val request = call.receive<CloudStreamVideoListRequest>()
                logger.info("CloudStream video-list: provider=${request.apiName}, url=${request.url}")

                val result = loader.invokeProviderMethod(
                    request.apiName,
                    "getVideoList",
                    request.url,
                    request.parameters
                )

                call.respond(
                    HttpStatusCode.OK,
                    ApiResponse.success(result)
                )
            } catch (e: Exception) {
                logger.error("CloudStream video-list failed: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    ApiResponse.error<Any>("Video list fetch failed: ${e.message}")
                )
            }
        }
    }
}
