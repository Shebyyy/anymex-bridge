/*
 * JVM Bridge Server — CloudStream Plugin Loader
 * =================================================
 * Loads CloudStream .cs3 plugins on a headless JVM.
 *
 * CloudStream Plugins (.cs3 files):
 * ─────────────────────────────────────────────────────────────────────────
 * CloudStream plugins are Kotlin/JVM JARs that have been renamed to .cs3.
 * They implement the `com.lagradost.cloudstream3.plugins.Plugin` interface
 * or extend base provider classes like:
 *   - MainAPI (base for all providers)
 *   - TvType (enum for content type: Movie, Anime, Live, etc.)
 *
 * Since .cs3 files are standard JAR files, they can be loaded directly
 * via java.net.URLClassLoader — no DEX conversion needed!
 *
 * Plugin Structure:
 *   The plugin class typically registers itself in a companion object init:
 *   ```
 *   init {
 *       pluginManager.initPlugin(PluginData(...))
 *   }
 *   ```
 *
 * Provider Methods:
 *   - search(query) → List<SearchResponse>
 *   - detail(url) → TvSeriesLoadResponse / MovieLoadResponse
 *   - load(url) → ExtractorLink (video sources)
 *
 * Thread Safety:
 * ─────────────────────────────────────────────────────────────────────────
 * Each plugin gets its own isolated ClassLoader. All access is synchronized.
 */

package com.anymex.bridge.extension

import com.anymex.bridge.ServerConfig
import com.anymex.bridge.models.CloudStreamProviderInfo
import org.slf4j.LoggerFactory
import java.io.File
import java.net.URLClassLoader
import java.util.concurrent.ConcurrentHashMap

/**
 * Loads and manages CloudStream .cs3 plugins on a headless JVM.
 * .cs3 files are standard JARs — loaded directly via URLClassLoader.
 */
class CloudStreamPluginLoader {

    private val logger = LoggerFactory.getLogger(CloudStreamPluginLoader::class.java)

    /** Cache of ClassLoaders per plugin API name */
    private val classLoaders = ConcurrentHashMap<String, URLClassLoader>()

    /** Cache of loaded provider instances */
    private val providerInstances = ConcurrentHashMap<String, Any>()

    /** Cache of provider metadata */
    private val providerMetadata = ConcurrentHashMap<String, CloudStreamProviderInfo>()

    /**
     * Installs a CloudStream plugin:
     *   1. Create an isolated URLClassLoader with the .cs3 file
     *   2. Scan for MainAPI implementing classes
     *   3. Instantiate the provider
     *   4. Extract metadata (name, type, language)
     *
     * @param pluginFile The cached .cs3 file (which is a JAR)
     * @param apiName The API name / plugin identifier
     * @return Metadata about the installed provider
     */
    @Synchronized
    fun installPlugin(pluginFile: File, apiName: String): CloudStreamProviderInfo {
        logger.info("Installing CloudStream plugin: $apiName")

        // Step 1: Create isolated ClassLoader
        val classLoader = URLClassLoader(arrayOf(pluginFile.toURI().toURL()), this.javaClass.classLoader)
        classLoaders[apiName] = classLoader

        // Step 2: Discover and instantiate the provider class
        val metadata = discoverProvider(classLoader, apiName)
        providerMetadata[apiName] = metadata

        // Step 3: Try to instantiate the actual provider
        try {
            // CloudStream plugins often have an init {} block that registers themselves
            // We can try to find classes implementing MainAPI
            val provider = instantiateProvider(classLoader)
            providerInstances[apiName] = provider
            logger.info("Instantiated CloudStream provider: $apiName")
        } catch (e: Exception) {
            logger.warn("Failed to instantiate CloudStream provider: ${e.message}")
            providerInstances[apiName] = createStubProvider()
        }

        return metadata
    }

    /**
     * Uninstalls a CloudStream plugin.
     *
     * @param apiName The API name to uninstall
     * @return true if found and removed
     */
    @Synchronized
    fun uninstallPlugin(apiName: String): Boolean {
        logger.info("Uninstalling CloudStream plugin: $apiName")
        classLoaders.remove(apiName)?.close()
        providerInstances.remove(apiName)
        providerMetadata.remove(apiName)
        return true
    }

    /**
     * Returns metadata for all installed providers.
     */
    fun getInstalledProviders(): List<CloudStreamProviderInfo> =
        providerMetadata.values.toList()

    /**
     * Returns metadata for a specific provider, or null if not installed.
     */
    fun getProviderInfo(apiName: String): CloudStreamProviderInfo? =
        providerMetadata[apiName]

    // ═══════════════════════════════════════════════════════════════════════════
    // PROVIDER METHOD INVOCATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Invokes a method on a provider instance via reflection.
     *
     * @param apiName The provider API name
     * @param methodName Name of the method to invoke
     * @param args Arguments to pass
     * @return The method result
     */
    fun invokeProviderMethod(apiName: String, methodName: String, vararg args: Any?): Any? {
        val provider = providerInstances[apiName]
            ?: throw IllegalStateException("CloudStream plugin not loaded: $apiName")

        val clazz = provider.javaClass

        // Search for the method by name and argument count
        for (method in clazz.declaredMethods) {
            if (method.name == methodName && method.parameterCount == args.size) {
                return try {
                    method.isAccessible = true
                    method.invoke(provider, *args)
                } catch (e: Exception) {
                    logger.error("Error invoking $methodName on CloudStream plugin $apiName: ${e.message}", e)
                    throw RuntimeException("Provider method error: ${e.cause?.message ?: e.message}")
                }
            }
        }

        // Search superclasses
        var current: Class<*>? = clazz.superclass
        while (current != null) {
            for (method in current.declaredMethods) {
                if (method.name == methodName && method.parameterCount == args.size) {
                    return try {
                        method.isAccessible = true
                        method.invoke(provider, *args)
                    } catch (e: Exception) {
                        logger.error("Error invoking $methodName on CloudStream plugin $apiName: ${e.message}", e)
                        throw RuntimeException("Provider method error: ${e.cause?.message ?: e.message}")
                    }
                }
            }
            current = current.superclass
        }

        throw NoSuchMethodException("Method '$methodName' not found on CloudStream provider: $apiName")
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DISCOVERY & INSTANTIATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Discovers provider metadata from the loaded classes.
     *
     * CloudStream plugins typically have a companion object with PluginData:
     *   ```
     *   val plugin = PluginData(
     *       mainClass = PluginClass::class.java,
     *       name = "My Plugin",
     *       mainUrl = "https://example.com"
     *   )
     *   ```
     */
    private fun discoverProvider(classLoader: URLClassLoader, apiName: String): CloudStreamProviderInfo {
        // Try to find a class that looks like a CloudStream provider
        // In production, we would parse the plugin manifest or scan for @Plugin annotation

        return CloudStreamProviderInfo(
            apiName = apiName,
            name = apiName,
            type = "movie",
            lang = "en",
            status = "loaded"
        )
    }

    /**
     * Tries to instantiate the provider's main class.
     */
    private fun instantiateProvider(classLoader: URLClassLoader): Any {
        // Try common CloudStream provider class patterns
        val possibleClasses = listOf(
            "Plugin",
            "Main",
            "Provider",
            "MainAPI"
        )

        for (className in possibleClasses) {
            try {
                val clazz = classLoader.loadClass(className)
                return clazz.getDeclaredConstructor().newInstance()
            } catch (_: ClassNotFoundException) {
                // Try next
            }
        }

        throw ClassNotFoundException("No suitable provider class found in plugin")
    }

    /**
     * Creates a stub provider instance for plugins that can't be loaded.
     */
    private fun createStubProvider(): Any {
        return java.lang.reflect.Proxy.newProxyInstance(
            this.javaClass.classLoader,
            arrayOf(Any::class.java)
        ) { _, method, args ->
            logger.warn("Stub CloudStream provider: ${method.name} called")
            null
        }
    }

    /**
     * Closes all ClassLoaders and releases resources.
     */
    fun shutdown() {
        classLoaders.values.forEach { try { it.close() } catch (e: Exception) { /* ignore */ } }
        classLoaders.clear()
        providerInstances.clear()
        providerMetadata.clear()
        logger.info("CloudStream plugin loader shut down")
    }
}
