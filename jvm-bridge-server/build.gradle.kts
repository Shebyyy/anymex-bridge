/*
 * JVM Bridge Server — Build Configuration
 * ========================================
 * A headless JVM server that loads Aniyomi, CloudStream, and Kotatsu
 * extensions and exposes them as REST endpoints for iOS clients.
 *
 * Uses Ktor with Netty for HTTP, Gson for JSON, and OkHttp for outbound requests.
 * Extension APKs are converted DEX→JAR at install time, then loaded via URLClassLoader.
 */

plugins {
    // Kotlin JVM plugin — compiles Kotlin to standard JVM bytecode
    kotlin("jvm") version "1.9.24"

    // Ktor plugin — configures the Ktor server with application conventions
    alias(libs.plugins.ktor)

    // Shadow plugin — produces a fat JAR with all dependencies for easy deployment
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

group = "com.anymex.bridge"
version = "1.0.0"

application {
    // Entry point for the server application
    mainClass.set("com.anymex.bridge.ApplicationKt")
}

repositories {
    mavenCentral()
    // Google Maven for Android tooling (d8 compiler for DEX→JAR conversion)
    google()
}

dependencies {
    // ─── Ktor Server ────────────────────────────────────────────────────────────
    // Core Ktor server engine
    implementation(libs.ktor.server.core)
    // Netty-based engine for high-performance async HTTP
    implementation(libs.ktor.server.netty)
    // Content negotiation for automatic request/response serialization
    implementation(libs.ktor.server.content.negotiation)
    // Gson content negotiation support (JSON serialization via Gson)
    implementation(libs.ktor.server.gson)
    // CORS support for cross-origin requests from the iOS app
    implementation(libs.ktor.server.cors)
    // Status pages for standardized error responses
    implementation(libs.ktor.server.status.pages)
    // Default headers middleware (security best practices)
    implementation(libs.ktor.server.default.headers)
    // Call logging for request/response logging
    implementation(libs.ktor.server.call.logging)
    // Raw sockets support for advanced networking if needed
    implementation(libs.ktor.server.sockets)
    // WebSockets support for future real-time features
    implementation(libs.ktor.server.websockets)

    // ─── Serialization ─────────────────────────────────────────────────────────
    // Gson for JSON serialization — lightweight, fast, well-known API
    implementation(libs.gson)

    // ─── HTTP Client ────────────────────────────────────────────────────────────
    // OkHttp for outbound HTTP requests (downloading extensions, proxying images)
    implementation(libs.okhttp)
    // OkHttp logging interceptor for debugging HTTP traffic
    implementation(libs.okhttp.logging)

    // ─── DEX Processing ────────────────────────────────────────────────────────
    // dexlib2 — library for reading/writing DEX files (extracting classes from APKs)
    implementation(libs.dexlib2)

    // ─── Kotlin Coroutines ──────────────────────────────────────────────────────
    // Coroutines core for async programming
    implementation(libs.kotlinx.coroutines.core)

    // ─── Logging ───────────────────────────────────────────────────────────────
    // SLF4J simple logger for development
    implementation(libs.slf4j.simple)

    // ─── CLI Argument Parsing ──────────────────────────────────────────────────
    // kotlinx-cli for parsing command-line arguments
    implementation(libs.kotlinx.cli)

    // ─── Testing ───────────────────────────────────────────────────────────────
    testImplementation(kotlin("test"))
    testImplementation(libs.ktor.server.tests)
}

// ─── Kotlin Compiler Options ──────────────────────────────────────────────────
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    kotlinOptions {
        jvmTarget = "17"
        // Allow opt-in APIs (e.g., experimental coroutines)
        freeCompilerArgs += "-opt-in=kotlin.RequiresOptIn"
    }
}

// ─── Java Compatibility ────────────────────────────────────────────────────────
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

// ─── Shadow JAR Configuration ──────────────────────────────────────────────────
tasks.shadowJar {
    archiveBaseName.set("jvm-bridge-server")
    archiveClassifier.set("")
    archiveVersion.set("${project.version}")
    manifest {
        attributes("Main-Class" to "com.anymex.bridge.ApplicationKt")
    }
    // Merge service files (META-INF/services/*) from all dependencies
    mergeServiceFiles()
}

// ─── Build Output ──────────────────────────────────────────────────────────────
tasks.build {
    dependsOn(tasks.shadowJar)
}
