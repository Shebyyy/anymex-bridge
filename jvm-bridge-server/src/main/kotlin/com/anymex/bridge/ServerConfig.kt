/*
 * JVM Bridge Server — Server Configuration
 * ===========================================
 * Centralized configuration for the JVM Bridge Server.
 * All settings can be overridden via environment variables, making the server
 * easily configurable for different deployment environments (Docker, bare metal, CI).
 *
 * Environment Variables:
 *   BRIDGE_PORT          — HTTP server port (default: 8080)
 *   BRIDGE_HOST          — Bind address (default: 0.0.0.0)
 *   BRIDGE_CACHE_DIR     — Directory for cached extensions (default: ./extensions-cache)
 *   BRIDGE_TEMP_DIR      — Directory for temporary files (default: ./tmp)
 *   BRIDGE_MAX_MEMORY_MB — Maximum heap memory hint for extension loading (default: 512)
 *   BRIDGE_LOG_LEVEL     — Log verbosity: TRACE, DEBUG, INFO, WARN, ERROR (default: INFO)
 *   BRIDGE_CORS_ORIGINS  — Comma-separated allowed CORS origins (default: *)
 */

package com.anymex.bridge

import org.slf4j.LoggerFactory
import java.io.File

/**
 * Singleton object holding all server configuration.
 * Reads environment variables at construction time; values are immutable after that.
 */
object ServerConfig {

    private val logger = LoggerFactory.getLogger(ServerConfig::class.java)

    // ─── Network ────────────────────────────────────────────────────────────────

    /** HTTP server port */
    val port: Int by lazy {
        System.getenv("BRIDGE_PORT")?.toIntOrNull() ?: 8080
    }

    /** Bind address — "0.0.0.0" for all interfaces, "127.0.0.1" for localhost only */
    val host: String by lazy {
        System.getenv("BRIDGE_HOST") ?: "0.0.0.0"
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    /** Root directory for cached extension files (APKs, JARs, converted files) */
    val cacheDir: File by lazy {
        val path = System.getenv("BRIDGE_CACHE_DIR") ?: "./extensions-cache"
        val dir = File(path).absoluteFile
        dir.mkdirs()
        logger.info("Extension cache directory: ${dir.absolutePath}")
        dir
    }

    /** Subdirectory for Aniyomi APK extensions */
    val aniyomiCacheDir: File get() = File(cacheDir, "aniyomi").also { it.mkdirs() }

    /** Subdirectory for CloudStream .cs3 plugins */
    val cloudStreamCacheDir: File get() = File(cacheDir, "cloudstream").also { it.mkdirs() }

    /** Subdirectory for Kotatsu .jar extensions */
    val kotatsuCacheDir: File get() = File(cacheDir, "kotatsu").also { it.mkdirs() }

    /** Subdirectory for DEX→JAR converted files */
    val convertedDir: File get() = File(cacheDir, "converted").also { it.mkdirs() }

    /** Temporary file directory */
    val tempDir: File by lazy {
        val path = System.getenv("BRIDGE_TEMP_DIR") ?: "./tmp"
        val dir = File(path).absoluteFile
        dir.mkdirs()
        dir
    }

    // ─── Performance ───────────────────────────────────────────────────────────

    /** Maximum memory hint (in MB) for extension loading operations */
    val maxMemoryMB: Int by lazy {
        System.getenv("BRIDGE_MAX_MEMORY_MB")?.toIntOrNull() ?: 512
    }

    /** Connection timeout (in seconds) for outbound HTTP requests */
    val httpTimeoutSeconds: Long = 30

    /** Read timeout (in seconds) for outbound HTTP requests */
    val httpReadTimeoutSeconds: Long = 60

    // ─── CORS ───────────────────────────────────────────────────────────────────

    /** Comma-separated list of allowed CORS origins. "*" allows all origins. */
    val corsOrigins: List<String> by lazy {
        val raw = System.getenv("BRIDGE_CORS_ORIGINS") ?: "*"
        raw.split(",").map { it.trim() }
    }

    // ─── Logging ────────────────────────────────────────────────────────────────

    /** Server log level */
    val logLevel: String by lazy {
        System.getenv("BRIDGE_LOG_LEVEL") ?: "INFO"
    }

    /** Server version string */
    const val VERSION = "1.0.0"

    /** Server name for identification in responses */
    const val SERVER_NAME = "AnymeX JVM Bridge Server"

    /**
     * Prints the full configuration to stdout at startup.
     * Useful for debugging deployment issues.
     */
    fun printConfig() {
        logger.info("╔══════════════════════════════════════════════════╗")
        logger.info("║   $SERVER_NAME v$VERSION          ║")
        logger.info("╠══════════════════════════════════════════════════╣")
        logger.info("║  Port:            $port                              ║")
        logger.info("║  Host:            $host                              ║")
        logger.info("║  Cache Dir:       ${cacheDir.absolutePath}")
        logger.info("║  Temp Dir:        ${tempDir.absolutePath}")
        logger.info("║  Max Memory:       ${maxMemoryMB}MB                          ║")
        logger.info("║  CORS Origins:    ${corsOrigins.joinToString(", ")}")
        logger.info("║  Log Level:       $logLevel                             ║")
        logger.info("╚══════════════════════════════════════════════════╝")
    }
}
