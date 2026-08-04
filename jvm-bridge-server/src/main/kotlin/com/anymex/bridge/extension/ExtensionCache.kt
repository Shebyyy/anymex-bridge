/*
 * JVM Bridge Server — Extension Cache
 * =====================================
 * Manages the download, caching, and lifecycle of extension files on disk.
 * Serves as the shared file layer between the route handlers and extension loaders.
 *
 * Responsibilities:
 *   - Download extension files (APK, .cs3, .jar) from URLs
 *   - Cache files on disk in organized subdirectories
 *   - Track installed extensions via a simple JSON manifest
 *   - Clean up (uninstall) cached files when extensions are removed
 *   - Resolve extension file paths by package name / source ID
 *
 * File layout on disk:
 *   <cacheDir>/
 *   ├── aniyomi/
 *   │   ├── <pkgName>.apk           — Original APK file
 *   │   ├── <pkgName>.jar           — Converted JAR (DEX→JAR)
 *   │   └── manifest.json           — Installed extension records
 *   ├── cloudstream/
 *   │   ├── <apiName>.cs3           — Original plugin file
 *   │   └── manifest.json
 *   ├── kotatsu/
 *   │   ├── <sourceId>.jar          — Original JAR extension
 *   │   └── manifest.json
 *   └── converted/
 *       └── <pkgName>-<hash>.jar    — DEX→JAR converted files
 */

package com.anymex.bridge.extension

import com.anymex.bridge.ServerConfig
import com.anymex.bridge.models.AniyomiExtensionInfo
import com.anymex.bridge.models.CloudStreamProviderInfo
import com.anymex.bridge.models.KotatsuExtensionInfo
import com.anymex.bridge.util.HttpUtil
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.reflect.TypeToken
import org.slf4j.LoggerFactory
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * Centralized cache manager for all extension types.
 * Thread-safe via ConcurrentHashMap and synchronized file operations.
 */
class ExtensionCache {

    private val logger = LoggerFactory.getLogger(ExtensionCache::class.java)
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    // ─── In-memory extension registries ──────────────────────────────────────
    // These are loaded from disk manifests at startup and kept in sync.

    /** Map of pkgName → AniyomiExtensionInfo */
    private val aniyomiRegistry = ConcurrentHashMap<String, AniyomiExtensionInfo>()

    /** Map of apiName → CloudStreamProviderInfo */
    private val cloudStreamRegistry = ConcurrentHashMap<String, CloudStreamProviderInfo>()

    /** Map of sourceId → KotatsuExtensionInfo */
    private val kotatsuRegistry = ConcurrentHashMap<String, KotatsuExtensionInfo>()

    init {
        loadManifests()
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DOWNLOAD OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Downloads an Aniyomi APK and saves it to the cache directory.
     *
     * @param downloadUrl URL to download the APK from
     * @param pkgName Package name (used as filename)
     * @param repoUrl Optional repository URL for metadata
     * @return The cached APK file
     */
    @Throws(IOException::class)
    fun downloadAniyomiApk(downloadUrl: String, pkgName: String, repoUrl: String? = null): File {
        val destFile = File(ServerConfig.aniyomiCacheDir, "$pkgName.apk")
        logger.info("Downloading Aniyomi APK: $pkgName from $downloadUrl")
        return HttpUtil.downloadFile(downloadUrl, destFile)
    }

    /**
     * Downloads a CloudStream .cs3 plugin and saves it to the cache directory.
     *
     * @param downloadUrl URL to download the plugin from
     * @param fileName Filename to save as
     * @return The cached .cs3 file
     */
    @Throws(IOException::class)
    fun downloadCloudStreamPlugin(downloadUrl: String, fileName: String): File {
        val destFile = File(ServerConfig.cloudStreamCacheDir, fileName)
        logger.info("Downloading CloudStream plugin: $fileName from $downloadUrl")
        return HttpUtil.downloadFile(downloadUrl, destFile)
    }

    /**
     * Downloads a Kotatsu .jar extension and saves it to the cache directory.
     *
     * @param downloadUrl URL to download the extension from
     * @param sourceId Source ID (used as filename)
     * @return The cached .jar file
     */
    @Throws(IOException::class)
    fun downloadKotatsuExtension(downloadUrl: String, sourceId: String): File {
        val destFile = File(ServerConfig.kotatsuCacheDir, "$sourceId.jar")
        logger.info("Downloading Kotatsu extension: $sourceId from $downloadUrl")
        return HttpUtil.downloadFile(downloadUrl, destFile)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FILE RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Resolves the cached APK file for an Aniyomi extension.
     *
     * @param pkgName The package name
     * @return The APK file, or null if not cached
     */
    fun getAniyomiApkFile(pkgName: String): File? {
        val file = File(ServerConfig.aniyomiCacheDir, "$pkgName.apk")
        return if (file.exists()) file else null
    }

    /**
     * Resolves the cached JAR file for a converted Aniyomi extension.
     *
     * @param pkgName The package name
     * @return The converted JAR file, or null if not cached
     */
    fun getAniyomiConvertedJar(pkgName: String): File? {
        // Look for any file starting with pkgName in the converted dir
        val convertedDir = ServerConfig.convertedDir
        return convertedDir.listFiles()
            ?.firstOrNull { it.name.startsWith(pkgName) && it.extension == "jar" }
    }

    /**
     * Resolves the cached .cs3 file for a CloudStream plugin.
     *
     * @param apiName The API name
     * @return The plugin file, or null if not cached
     */
    fun getCloudStreamPluginFile(apiName: String): File? {
        val file = File(ServerConfig.cloudStreamCacheDir, "$apiName.cs3")
        return if (file.exists()) file else null
    }

    /**
     * Resolves the cached .jar file for a Kotatsu extension.
     *
     * @param sourceId The source ID
     * @return The JAR file, or null if not cached
     */
    fun getKotatsuExtensionFile(sourceId: String): File? {
        val file = File(ServerConfig.kotatsuCacheDir, "$sourceId.jar")
        return if (file.exists()) file else null
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRY OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Registers an Aniyomi extension in the manifest.
     */
    fun registerAniyomiExtension(info: AniyomiExtensionInfo) {
        aniyomiRegistry[info.pkgName] = info
        saveAniyomiManifest()
        logger.info("Registered Aniyomi extension: ${info.pkgName} (${info.name})")
    }

    /**
     * Unregisters an Aniyomi extension from the manifest and deletes cached files.
     *
     * @return true if the extension was found and removed
     */
    fun unregisterAniyomiExtension(pkgName: String): Boolean {
        aniyomiRegistry.remove(pkgName) ?: return false

        // Delete cached files
        getAniyomiApkFile(pkgName)?.delete()
        getAniyomiConvertedJar(pkgName)?.delete()

        saveAniyomiManifest()
        logger.info("Unregistered Aniyomi extension: $pkgName")
        return true
    }

    /**
     * Registers a CloudStream plugin in the manifest.
     */
    fun registerCloudStreamPlugin(info: CloudStreamProviderInfo) {
        cloudStreamRegistry[info.apiName] = info
        saveCloudStreamManifest()
        logger.info("Registered CloudStream plugin: ${info.apiName} (${info.name})")
    }

    /**
     * Unregisters a CloudStream plugin from the manifest and deletes cached files.
     *
     * @return true if the plugin was found and removed
     */
    fun unregisterCloudStreamPlugin(apiName: String): Boolean {
        cloudStreamRegistry.remove(apiName) ?: return false
        getCloudStreamPluginFile(apiName)?.delete()
        saveCloudStreamManifest()
        logger.info("Unregistered CloudStream plugin: $apiName")
        return true
    }

    /**
     * Registers a Kotatsu extension in the manifest.
     */
    fun registerKotatsuExtension(info: KotatsuExtensionInfo) {
        kotatsuRegistry[info.sourceId] = info
        saveKotatsuManifest()
        logger.info("Registered Kotatsu extension: ${info.sourceId} (${info.title})")
    }

    /**
     * Unregisters a Kotatsu extension from the manifest and deletes cached files.
     *
     * @return true if the extension was found and removed
     */
    fun unregisterKotatsuExtension(sourceId: String): Boolean {
        kotatsuRegistry.remove(sourceId) ?: return false
        getKotatsuExtensionFile(sourceId)?.delete()
        saveKotatsuManifest()
        logger.info("Unregistered Kotatsu extension: $sourceId")
        return true
    }

    /**
     * Returns all registered Aniyomi extensions.
     */
    fun getAniyomiExtensions(): List<AniyomiExtensionInfo> =
        aniyomiRegistry.values.toList()

    /**
     * Returns all registered CloudStream plugins.
     */
    fun getCloudStreamPlugins(): List<CloudStreamProviderInfo> =
        cloudStreamRegistry.values.toList()

    /**
     * Returns all registered Kotatsu extensions.
     */
    fun getKotatsuExtensions(): List<KotatsuExtensionInfo> =
        kotatsuRegistry.values.toList()

    // ═══════════════════════════════════════════════════════════════════════════
    // MANIFEST PERSISTENCE
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Loads all manifests from disk into memory.
     * Called at startup to restore previously installed extensions.
     */
    private fun loadManifests() {
        loadAniyomiManifest()
        loadCloudStreamManifest()
        loadKotatsuManifest()
    }

    private fun loadAniyomiManifest() {
        val file = File(ServerConfig.aniyomiCacheDir, "manifest.json")
        if (file.exists()) {
            try {
                val type = object : TypeToken<Map<String, AniyomiExtensionInfo>>() {}.type
                val map: Map<String, AniyomiExtensionInfo> = gson.fromJson(file.readText(), type)
                aniyomiRegistry.putAll(map)
                logger.info("Loaded ${map.size} Aniyomi extensions from manifest")
            } catch (e: Exception) {
                logger.warn("Failed to load Aniyomi manifest: ${e.message}")
            }
        }
    }

    private fun loadCloudStreamManifest() {
        val file = File(ServerConfig.cloudStreamCacheDir, "manifest.json")
        if (file.exists()) {
            try {
                val type = object : TypeToken<Map<String, CloudStreamProviderInfo>>() {}.type
                val map: Map<String, CloudStreamProviderInfo> = gson.fromJson(file.readText(), type)
                cloudStreamRegistry.putAll(map)
                logger.info("Loaded ${map.size} CloudStream plugins from manifest")
            } catch (e: Exception) {
                logger.warn("Failed to load CloudStream manifest: ${e.message}")
            }
        }
    }

    private fun loadKotatsuManifest() {
        val file = File(ServerConfig.kotatsuCacheDir, "manifest.json")
        if (file.exists()) {
            try {
                val type = object : TypeToken<Map<String, KotatsuExtensionInfo>>() {}.type
                val map: Map<String, KotatsuExtensionInfo> = gson.fromJson(file.readText(), type)
                kotatsuRegistry.putAll(map)
                logger.info("Loaded ${map.size} Kotatsu extensions from manifest")
            } catch (e: Exception) {
                logger.warn("Failed to load Kotatsu manifest: ${e.message}")
            }
        }
    }

    private fun saveAniyomiManifest() {
        val file = File(ServerConfig.aniyomiCacheDir, "manifest.json")
        file.writeText(gson.toJson(aniyomiRegistry.toMap()))
    }

    private fun saveCloudStreamManifest() {
        val file = File(ServerConfig.cloudStreamCacheDir, "manifest.json")
        file.writeText(gson.toJson(cloudStreamRegistry.toMap()))
    }

    private fun saveKotatsuManifest() {
        val file = File(ServerConfig.kotatsuCacheDir, "manifest.json")
        file.writeText(gson.toJson(kotatsuRegistry.toMap()))
    }

    /**
     * Cleans up temporary files.
     */
    fun cleanup() {
        ServerConfig.tempDir.deleteRecursively()
        ServerConfig.tempDir.mkdirs()
        logger.info("Cleaned up temporary files")
    }
}
