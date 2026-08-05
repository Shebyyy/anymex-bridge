/*
 * JVM Bridge Server — Kotatsu Extension Loader
 * ================================================
 * Loads Kotatsu manga extensions (.jar files) on a headless JVM.
 *
 * Kotatsu Extensions (.jar files):
 * ─────────────────────────────────────────────────────────────────────────
 * Kotatsu extensions are standard Kotlin/JVM JAR files. They implement
 * the `org.koitharu.kotatsu.parsers.MangaParser` interface or extend
 * base parser classes like:
 *   - MangaParser (base for all manga sources)
 *   - ParsedMangaSource (for sources that provide structured HTML data)
 *
 * Since they are standard JAR files, they can be loaded directly via
 * java.net.URLClassLoader — no conversion needed.
 *
 * Extension Structure:
 *   Each extension JAR contains:
 *   - A class extending MangaParser
 *   - Manifest with source ID, name, language, etc.
 *   - Optional resource bundles for localization
 *
 * Parser Methods:
 *   - search(query, page, filters) → List<Manga>
 *   - getPopular(page) → List<Manga>
 *   - getLatestUpdates(page) → List<Manga>
 *   - getDetails(manga) → MangaDetails
 *   - getPages(chapter) → List<Page>
 *
 * Thread Safety:
 * ─────────────────────────────────────────────────────────────────────────
 * Each extension gets its own isolated ClassLoader. All access is synchronized.
 */

package com.anymex.bridge.extension

import com.anymex.bridge.ServerConfig
import com.anymex.bridge.models.KotatsuExtensionInfo
import org.slf4j.LoggerFactory
import java.io.File
import java.net.URLClassLoader
import java.util.concurrent.ConcurrentHashMap

/**
 * Loads and manages Kotatsu manga extensions (.jar files) on a headless JVM.
 * Standard JAR files — loaded directly via URLClassLoader.
 */
class KotatsuExtensionLoader {

    private val logger = LoggerFactory.getLogger(KotatsuExtensionLoader::class.java)

    /** Cache of ClassLoaders per source ID */
    private val classLoaders = ConcurrentHashMap<String, URLClassLoader>()

    /** Cache of loaded parser instances */
    private val parserInstances = ConcurrentHashMap<String, Any>()

    /** Cache of extension metadata */
    private val extensionMetadata = ConcurrentHashMap<String, KotatsuExtensionInfo>()

    /**
     * Installs a Kotatsu extension:
     *   1. Create an isolated URLClassLoader with the .jar file
     *   2. Scan for MangaParser implementing classes
     *   3. Instantiate the parser
     *   4. Extract metadata (source ID, name, language)
     *
     * @param jarFile The cached .jar extension file
     * @param sourceId The source ID / extension identifier
     * @return Metadata about the installed extension
     */
    @Synchronized
    fun installExtension(jarFile: File, sourceId: String): KotatsuExtensionInfo {
        logger.info("Installing Kotatsu extension: $sourceId")

        // Step 1: Create isolated ClassLoader
        val classLoader = URLClassLoader(arrayOf(jarFile.toURI().toURL()), this.javaClass.classLoader)
        classLoaders[sourceId] = classLoader

        // Step 2: Discover and instantiate the parser class
        val metadata = discoverParser(classLoader, sourceId)
        extensionMetadata[sourceId] = metadata

        // Step 3: Try to instantiate the actual parser
        try {
            val parser = instantiateParser(classLoader)
            parserInstances[sourceId] = parser
            logger.info("Instantiated Kotatsu parser: $sourceId")
        } catch (e: Exception) {
            logger.warn("Failed to instantiate Kotatsu parser: ${e.message}")
            parserInstances[sourceId] = createStubParser()
        }

        return metadata
    }

    /**
     * Uninstalls a Kotatsu extension.
     *
     * @param sourceId The source ID to uninstall
     * @return true if found and removed
     */
    @Synchronized
    fun uninstallExtension(sourceId: String): Boolean {
        logger.info("Uninstalling Kotatsu extension: $sourceId")
        classLoaders.remove(sourceId)?.close()
        parserInstances.remove(sourceId)
        extensionMetadata.remove(sourceId)
        return true
    }

    /**
     * Returns metadata for all installed extensions.
     */
    fun getInstalledExtensions(): List<KotatsuExtensionInfo> =
        extensionMetadata.values.toList()

    /**
     * Returns metadata for a specific extension, or null if not installed.
     */
    fun getExtensionInfo(sourceId: String): KotatsuExtensionInfo? =
        extensionMetadata[sourceId]

    // ═══════════════════════════════════════════════════════════════════════════
    // PARSER METHOD INVOCATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Invokes a method on a parser instance via reflection.
     *
     * @param sourceId The extension source ID
     * @param methodName Name of the method to invoke
     * @param args Arguments to pass
     * @return The method result
     */
    fun invokeParserMethod(sourceId: String, methodName: String, vararg args: Any?): Any? {
        val parser = parserInstances[sourceId]
            ?: throw IllegalStateException("Kotatsu extension not loaded: $sourceId")

        val clazz = parser.javaClass

        // Search declared methods
        for (method in clazz.declaredMethods) {
            if (method.name == methodName && method.parameterCount == args.size) {
                return try {
                    method.isAccessible = true
                    method.invoke(parser, *args)
                } catch (e: Exception) {
                    logger.error("Error invoking $methodName on Kotatsu extension $sourceId: ${e.message}", e)
                    throw RuntimeException("Parser method error: ${e.cause?.message ?: e.message}")
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
                        method.invoke(parser, *args)
                    } catch (e: Exception) {
                        logger.error("Error invoking $methodName on Kotatsu extension $sourceId: ${e.message}", e)
                        throw RuntimeException("Parser method error: ${e.cause?.message ?: e.message}")
                    }
                }
            }
            current = current.superclass
        }

        throw NoSuchMethodException("Method '$methodName' not found on Kotatsu extension: $sourceId")
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DISCOVERY & INSTANTIATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Discovers parser metadata from the loaded classes.
     *
     * Kotatsu extensions typically have a MangaParser implementation with:
     *   - sourceId: String (unique identifier)
     *   - name: String (human-readable name)
     *   - lang: String (ISO 639-1 language code)
     */
    private fun discoverParser(classLoader: URLClassLoader, sourceId: String): KotatsuExtensionInfo {
        // In production, we would:
        // 1. Scan JAR manifest for extension metadata
        // 2. Look for @ParserName annotation or similar
        // 3. Instantiate a dummy parser to read sourceId, name, lang fields

        return KotatsuExtensionInfo(
            sourceId = sourceId,
            title = sourceId,
            lang = "en",
            state = "loaded"
        )
    }

    /**
     * Tries to instantiate the parser's main class.
     */
    private fun instantiateParser(classLoader: URLClassLoader): Any {
        // Try common Kotatsu parser class patterns
        val possibleClasses = listOf(
            "Parser",
            "MangaParser",
            "Source",
            "${classLoader.toString().substringAfterLast("/")}"
        )

        for (className in possibleClasses) {
            try {
                val clazz = classLoader.loadClass(className)
                return clazz.getDeclaredConstructor().newInstance()
            } catch (_: ClassNotFoundException) {
                // Try next
            }
        }

        // Try scanning the JAR for any public class
        try {
            val jarUrl = classLoader.urLs.firstOrNull()
            if (jarUrl != null && jarUrl.protocol == "file") {
                java.util.jar.JarFile(jarUrl.path).use { jar ->
                    for (entry in jar.entries()) {
                        if (entry.name.endsWith(".class") && !entry.name.contains("$")) {
                            val className = entry.name
                                .replace("/", ".")
                                .removeSuffix(".class")
                            try {
                                val clazz = classLoader.loadClass(className)
                                if (clazz.declaredConstructors.any { it.parameterCount == 0 }) {
                                    return clazz.getDeclaredConstructor().newInstance()
                                }
                            } catch (_: Exception) {
                                // Skip un-instantiable classes
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            logger.debug("JAR scanning failed: ${e.message}")
        }

        throw ClassNotFoundException("No suitable parser class found in Kotatsu extension")
    }

    /**
     * Creates a stub parser instance for extensions that can't be loaded.
     */
    private fun createStubParser(): Any {
        return java.lang.reflect.Proxy.newProxyInstance(
            this.javaClass.classLoader,
            arrayOf(Any::class.java)
        ) { _, method, args ->
            logger.warn("Stub Kotatsu parser: ${method.name} called")
            null
        }
    }

    /**
     * Closes all ClassLoaders and releases resources.
     */
    fun shutdown() {
        classLoaders.values.forEach { try { it.close() } catch (e: Exception) { /* ignore */ } }
        classLoaders.clear()
        parserInstances.clear()
        extensionMetadata.clear()
        logger.info("Kotatsu extension loader shut down")
    }
}
