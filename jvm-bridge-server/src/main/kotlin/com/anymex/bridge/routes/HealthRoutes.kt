/*
 * JVM Bridge Server — Health Routes
 * =====================================
 * Health check and server status endpoints.
 * These endpoints don't require authentication and are used for monitoring,
 * load balancing health checks, and diagnostic information.
 *
 * Endpoints:
 *   GET /api/health — Server health status with JVM info, loaded extension counts
 */

package com.anymex.bridge.routes

import com.anymex.bridge.extension.AniyomiExtensionLoader
import com.anymex.bridge.extension.CloudStreamPluginLoader
import com.anymex.bridge.extension.KotatsuExtensionLoader
import com.anymex.bridge.models.ApiResponse
import com.anymex.bridge.models.HealthStatus
import io.ktor.server.response.*
import io.ktor.server.routing.*

/** Server start timestamp for uptime calculation */
private val startTime = System.currentTimeMillis()

/**
 * Registers health and status routes.
 * Receives loader references to report accurate extension counts.
 *
 * @param aniyomiLoader The Aniyomi extension loader
 * @param cloudStreamLoader The CloudStream plugin loader
 * @param kotatsuLoader The Kotatsu extension loader
 */
fun Routing.registerHealthRoutes(
    aniyomiLoader: AniyomiExtensionLoader,
    cloudStreamLoader: CloudStreamPluginLoader,
    kotatsuLoader: KotatsuExtensionLoader
) {
    route("/api/health") {
        get {
            val uptimeMs = System.currentTimeMillis() - startTime

            val aniyomiCount = aniyomiLoader.getInstalledExtensions().size
            val cloudStreamCount = cloudStreamLoader.getInstalledProviders().size
            val kotatsuCount = kotatsuLoader.getInstalledExtensions().size
            val totalCount = aniyomiCount + cloudStreamCount + kotatsuCount

            val status = HealthStatus(
                uptimeMs = uptimeMs,
                aniyomiExtensions = aniyomiCount,
                cloudStreamPlugins = cloudStreamCount,
                kotatsuExtensions = kotatsuCount,
                totalExtensions = totalCount
            )

            call.respond(
                ApiResponse.success(status)
            )
        }
    }
}
