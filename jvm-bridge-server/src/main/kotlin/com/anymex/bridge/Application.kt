/*
 * JVM Bridge Server — Application Entry Point
 * =============================================
 * Main entry point for the JVM Bridge Server.
 * Configures and starts the Ktor server with Netty engine.
 *
 * Responsibilities:
 *  - Initializes all extension loaders
 *  - Registers all REST API routes
 *  - Configures CORS, logging, error handling, and serialization
 *  - Starts the server on the configured port
 */

package com.anymex.bridge

import com.anymex.bridge.routes.*
import com.anymex.bridge.extension.*
import com.anymex.bridge.models.ApiResponse
import com.google.gson.GsonBuilder
import io.ktor.http.*
import io.ktor.serialization.gson.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.plugins.defaultheaders.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory
import org.slf4j.event.Level
import java.util.concurrent.TimeUnit

// ─── Extension Loaders (singletons) ────────────────────────────────────────────
// Each loader manages one extension ecosystem: Aniyomi, CloudStream, Kotatsu.

/** Aniyomi extension loader — handles APK download, DEX→JAR conversion, class loading */
private val aniyomiLoader = AniyomiExtensionLoader()

/** CloudStream plugin loader — handles .cs3 file download and JAR loading */
private val cloudStreamLoader = CloudStreamPluginLoader()

/** Kotatsu extension loader — handles .jar file download and loading */
private val kotatsuLoader = KotatsuExtensionLoader()

/** Extension cache — manages file download and disk caching */
private val extensionCache = ExtensionCache()

private val logger = LoggerFactory.getLogger("Application")

/**
 * Main function — server entry point.
 * Called by the Gradle application plugin or when running the fat JAR.
 */
fun main() {
    ServerConfig.printConfig()

    embeddedServer(Netty, port = ServerConfig.port, host = ServerConfig.host) {
        configureServer()
    }.start(wait = true)
}

/**
 * Configures the Ktor server with all plugins, routes, and middleware.
 */
fun Application.configureServer() {
    // ─── 1. Default Headers ──────────────────────────────────────────────────
    // Security headers for production safety
    install(DefaultHeaders) {
        header("X-Server", ServerConfig.SERVER_NAME)
        header("X-Version", ServerConfig.VERSION)
        header("X-Powered-By", "Ktor/Netty")
    }

    // ─── 2. CORS ────────────────────────────────────────────────────────────
    // Allow cross-origin requests from the iOS app (and any web client)
    install(CORS) {
        anyHost() // Allow all origins
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.Authorization)
        allowHeader(HttpHeaders.Accept)
        allowHeader(HttpHeaders.Origin)
        allowHeader(HttpHeaders.UserAgent)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Put)
        allowMethod(HttpMethod.Delete)
        allowMethod(HttpMethod.Options)
        maxAgeInSeconds = 86400 // 24 hours preflight cache
    }

    // ─── 3. Content Negotiation (JSON) ─────────────────────────────────────
    // Automatic JSON serialization/deserialization using Gson
    install(ContentNegotiation) {
        gson {
            // Custom Gson configuration for clean JSON output
            setPrettyPrinting()
            serializeNulls() // Include null fields in responses
            disableHtmlEscaping() // Don't escape HTML characters in strings
        }
    }

    // ─── 4. Call Logging ────────────────────────────────────────────────────
    // Log all HTTP requests with timing information
    install(CallLogging) {
        level = Level.INFO
        format { call ->
            val status = call.response.status()
            val method = call.request.httpMethod.value
            val uri = call.request.uri
            val duration = call.response.timeTaken()
            "$method $uri -> $status (${duration}ms)"
        }
    }

    // ─── 5. Status Pages (Global Error Handling) ─────────────────────────────
    // Convert all uncaught exceptions to standardized JSON error responses
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            logger.error("Unhandled exception for ${call.request.uri}", cause)
            call.respond(
                HttpStatusCode.InternalServerError,
                ApiResponse.error("Internal server error: ${cause.message}")
            )
        }
    }

    // ─── 6. Routes ──────────────────────────────────────────────────────────
    // Register all REST API route groups
    routing {
        // Health & diagnostics
        registerHealthRoutes(aniyomiLoader, cloudStreamLoader, kotatsuLoader)

        // Aniyomi extension API
        registerAniyomiRoutes(aniyomiLoader, extensionCache)

        // CloudStream plugin API
        registerCloudStreamRoutes(cloudStreamLoader, extensionCache)

        // Kotatsu extension API
        registerKotatsuRoutes(kotatsuLoader, extensionCache)

        // Image proxy for manga pages
        registerImageProxyRoutes()

        // Root endpoint — redirects to health check
        get("/") {
            call.respond(
                ApiResponse.success(
                    mapOf(
                        "server" to ServerConfig.SERVER_NAME,
                        "version" to ServerConfig.VERSION,
                        "endpoints" to listOf(
                            "/api/health",
                            "/api/aniyomi/*",
                            "/api/cloudstream/*",
                            "/api/kotatsu/*",
                            "/api/proxy/image"
                        )
                    )
                )
            )
        }
    }

    // ─── 7. Startup Banner ──────────────────────────────────────────────────
    environment.monitor.subscribe(ApplicationStarted) {
        logger.info("Server started successfully on ${ServerConfig.host}:${ServerConfig.port}")
    }

    environment.monitor.subscribe(ApplicationStopPreparing) {
        logger.info("Server shutting down...")
        // Clean up extension loaders (close ClassLoaders, release resources)
        aniyomiLoader.shutdown()
        cloudStreamLoader.shutdown()
        kotatsuLoader.shutdown()
    }
}
