/*
 * JVM Bridge Server — HTTP Utility
 * ==================================
 * Centralized HTTP client for outbound requests.
 * Used for:
 *   - Downloading extension files (APKs, .cs3, .jar) from URLs
 *   - Proxying image requests with proper headers
 *   - Fetching metadata from remote sources
 *
 * Uses OkHttp as the HTTP client with configurable timeouts.
 * All network operations are logged and include error handling.
 */

package com.anymex.bridge.util

import com.anymex.bridge.ServerConfig
import okhttp3.*
import okhttp3.logging.HttpLoggingInterceptor
import org.slf4j.LoggerFactory
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Singleton HTTP client utility.
 * Provides methods for downloading files and making HTTP requests.
 */
object HttpUtil {

    private val logger = LoggerFactory.getLogger(HttpUtil::class.java)

    /** Shared OkHttp client instance — connection pooling and reuse */
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder().apply {
            connectTimeout(ServerConfig.httpTimeoutSeconds, TimeUnit.SECONDS)
            readTimeout(ServerConfig.httpReadTimeoutSeconds, TimeUnit.SECONDS)
            writeTimeout(ServerConfig.httpReadTimeoutSeconds, TimeUnit.SECONDS)

            // Follow redirects (some extension download URLs use 302)
            followRedirects(true)
            followSslRedirects(true)

            // Logging interceptor for debugging
            val loggingInterceptor = HttpLoggingInterceptor { message ->
                logger.debug("[HTTP] $message")
            }.apply {
                level = HttpLoggingInterceptor.Level.BASIC
            }
            addInterceptor(loggingInterceptor)

            // User-Agent header — identifies bridge server in server logs
            addInterceptor(Interceptor { chain ->
                val originalRequest = chain.request()
                val requestWithUserAgent = originalRequest.newBuilder()
                    .header("User-Agent", "AnymeX-JVM-Bridge/${ServerConfig.VERSION}")
                    .build()
                chain.proceed(requestWithUserAgent)
            })
        }.build()
    }

    /**
     * Downloads a file from the given URL and saves it to the specified destination.
     *
     * @param downloadUrl The URL to download from
     * @param destination The file to save to
     * @param onProgress Optional callback for download progress (bytes downloaded)
     * @return The downloaded file
     * @throws IOException if the download fails
     */
    @Throws(IOException::class)
    fun downloadFile(
        downloadUrl: String,
        destination: File,
        onProgress: ((Long) -> Unit)? = null
    ): File {
        logger.info("Downloading file from: $downloadUrl -> ${destination.absolutePath}")
        val request = Request.Builder().url(downloadUrl).build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException(
                    "Download failed: HTTP ${response.code} ${response.message} for URL: $downloadUrl"
                )
            }

            val body = response.body
                ?: throw IOException("Download failed: empty response body for URL: $downloadUrl")

            val contentLength = body.contentLength()
            logger.debug("Content-Length: $contentLength bytes")

            // Stream the response body to the destination file
            body.byteStream().use { input ->
                FileOutputStream(destination).use { output ->
                    val buffer = ByteArray(8192)
                    var bytesRead: Long = 0
                    var read: Int

                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        bytesRead += read
                        onProgress?.invoke(bytesRead)
                    }
                }
            }

            logger.info("Download complete: ${destination.absolutePath} ($bytesRead bytes)")
            return destination
        }
    }

    /**
     * Downloads a file from the given URL to a temporary file.
     * The caller is responsible for moving/cleaning up the temp file.
     *
     * @param downloadUrl The URL to download from
     * @param prefix Prefix for the temp file name
     * @param suffix Suffix for the temp file name (e.g., ".apk", ".jar")
     * @return The downloaded temporary file
     */
    @Throws(IOException::class)
    fun downloadToTempFile(
        downloadUrl: String,
        prefix: String = "download",
        suffix: String = ".tmp"
    ): File {
        val tempFile = File.createTempFile(prefix, suffix, ServerConfig.tempDir)
        return downloadFile(downloadUrl, tempFile)
    }

    /**
     * Makes a GET request and returns the response body as a String.
     *
     * @param url The URL to fetch
     * @param headers Optional request headers
     * @return The response body string
     * @throws IOException if the request fails
     */
    @Throws(IOException::class)
    fun getString(url: String, headers: Map<String, String>? = null): String {
        val requestBuilder = Request.Builder().url(url)
        headers?.forEach { (key, value) -> requestBuilder.header(key, value) }

        client.newCall(requestBuilder.build()).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("HTTP ${response.code} for URL: $url")
            }
            return response.body?.string() ?: throw IOException("Empty response body")
        }
    }

    /**
     * Makes a GET request and returns the response as bytes.
     * Used for image proxying and binary data.
     *
     * @param url The URL to fetch
     * @param headers Optional request headers
     * @return The response body bytes and content type
     */
    @Throws(IOException::class)
    fun getBytes(url: String, headers: Map<String, String>? = null): Pair<ByteArray, String> {
        val requestBuilder = Request.Builder().url(url)
        headers?.forEach { (key, value) -> requestBuilder.header(key, value) }

        client.newCall(requestBuilder.build()).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("HTTP ${response.code} for URL: $url")
            }
            val body = response.body
                ?: throw IOException("Empty response body for URL: $url")
            val contentType = response.header("Content-Type", "application/octet-stream")
            return Pair(body.bytes(), contentType)
        }
    }

    /**
     * Makes a POST request with JSON body and returns the response as String.
     *
     * @param url The URL to POST to
     * @param jsonBody The JSON string body
     * @param headers Optional request headers
     * @return The response body string
     */
    @Throws(IOException::class)
    fun postJson(
        url: String,
        jsonBody: String,
        headers: Map<String, String>? = null
    ): String {
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val requestBody = jsonBody.toRequestBody(mediaType)

        val requestBuilder = Request.Builder()
            .url(url)
            .post(requestBody)
        headers?.forEach { (key, value) -> requestBuilder.header(key, value) }

        client.newCall(requestBuilder.build()).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("HTTP ${response.code} for URL: $url")
            }
            return response.body?.string() ?: throw IOException("Empty response body")
        }
    }

    /**
     * Extracts a clean filename from a URL.
     * Falls back to a hash-based name if the URL doesn't have a clear filename.
     *
     * @param url The URL to extract a filename from
     * @param defaultExt Default file extension if none found in URL
     * @return A clean, safe filename
     */
    fun filenameFromUrl(url: String, defaultExt: String = ".bin"): String {
        return try {
            val path = URI(url).path
            val name = path.substringAfterLast('/').substringBefore('?')
            if (name.isBlank() || name.length > 200) {
                "download_${url.hashCode().toString(16)}$defaultExt"
            } else {
                // Sanitize: remove path traversal attempts
                name.replace("../", "").replace("/", "_")
            }
        } catch (e: Exception) {
            "download_${url.hashCode().toString(16)}$defaultExt"
        }
    }

    /**
     * Shuts down the HTTP client and releases all resources.
     * Called during server shutdown.
     */
    fun shutdown() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        logger.info("HTTP client shutdown complete")
    }
}
