/*
 * JVM Bridge Server — Image Proxy Routes
 * ==========================================
 * Image proxy endpoint for manga page images.
 *
 * Many manga sources block direct image access based on Referer headers.
 * This proxy endpoint fetches images on behalf of the iOS client, adding the
 * appropriate Referer and other headers that the source expects.
 *
 * Endpoints:
 *   GET /api/proxy/image?sourceId=xxx&imageUrl=xxx&pageUrl=xxx&pageNumber=1
 *
 * Features:
 *   - Adds Referer header from the source's base URL
 *   - Supports configurable headers per source
 *   - Streams image bytes directly (no disk caching of images)
 *   - Returns proper Content-Type headers
 *   - Supports common image formats: JPEG, PNG, GIF, WebP, AVIF
 */

package com.anymex.bridge.routes

import com.anymex.bridge.util.HttpUtil
import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory
import java.io.IOException

private val logger = LoggerFactory.getLogger("ImageProxyRoutes")

/**
 * Registers the image proxy route.
 *
 * @param cache The extension cache (used for resolving source metadata)
 */
fun Routing.registerImageProxyRoutes(/* cache: ExtensionCache */) {
    route("/api/proxy") {

        get("/image") {
            val sourceId = call.request.queryParameters["sourceId"]
            val imageUrl = call.request.queryParameters["imageUrl"]
            val pageUrl = call.request.queryParameters["pageUrl"]
            val pageNumber = call.request.queryParameters["pageNumber"]

            // Validate required parameters
            if (sourceId.isNullOrBlank()) {
                call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Missing required parameter: sourceId")
                )
                return@get
            }

            if (imageUrl.isNullOrBlank()) {
                call.respond(
                    HttpStatusCode.BadRequest,
                    mapOf("error" to "Missing required parameter: imageUrl")
                )
                return@get
            }

            logger.debug(
                "Proxying image: source=$sourceId, page=$pageNumber, " +
                "url=${imageUrl.take(100)}..."
            )

            try {
                // Build headers for the image request
                // Many manga sources require a Referer header matching their domain
                val referer = pageUrl ?: extractRefererFromImageUrl(imageUrl)
                val headers = mutableMapOf(
                    "Referer" to referer,
                    "User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept" to "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                )

                // Some sources have anti-hotlinking that checks Accept-Language
                headers["Accept-Language"] = "en-US,en;q=0.9"

                // Fetch the image bytes
                val (bytes, contentType) = HttpUtil.getBytes(imageUrl, headers)

                // Determine content type from URL if response didn't provide one
                val resolvedContentType = when {
                    contentType.contains("image") -> contentType
                    imageUrl.contains(".png", ignoreCase = true) -> ContentType.Image.PNG.toString()
                    imageUrl.contains(".gif", ignoreCase = true) -> ContentType.Image.GIF.toString()
                    imageUrl.contains(".webp", ignoreCase = true) -> "image/webp"
                    imageUrl.contains(".avif", ignoreCase = true) -> "image/avif"
                    imageUrl.contains(".jpg", ignoreCase = true) ||
                    imageUrl.contains(".jpeg", ignoreCase = true) -> ContentType.Image.JPEG.toString()
                    else -> ContentType.Application.OctetStream.toString()
                }

                // Stream the response
                call.respondBytes(
                    bytes,
                    ContentType.parse(resolvedContentType),
                    HttpStatusCode.OK
                )

                logger.debug(
                    "Image proxied successfully: ${bytes.size} bytes, " +
                    "type=$resolvedContentType"
                )

            } catch (e: IOException) {
                logger.error("Image proxy failed for $sourceId: ${e.message}", e)
                call.respond(
                    HttpStatusCode.BadGateway,
                    mapOf("error" to "Failed to fetch image: ${e.message}")
                )
            } catch (e: Exception) {
                logger.error("Image proxy error for $sourceId: ${e.message}", e)
                call.respond(
                    HttpStatusCode.InternalServerError,
                    mapOf("error" to "Proxy error: ${e.message}")
                )
            }
        }
    }
}

/**
 * Extracts a Referer URL from an image URL by taking the origin.
 * For example: "https://cdn.example.com/path/img.jpg" → "https://cdn.example.com"
 * But for manga sources, we want the source's base URL, not the CDN URL.
 * So we use the pageUrl if available, otherwise fall back to the image URL origin.
 */
private fun extractRefererFromImageUrl(imageUrl: String): String {
    return try {
        val url = java.net.URL(imageUrl)
        "${url.protocol}://${url.host}"
    } catch (e: Exception) {
        imageUrl
    }
}
