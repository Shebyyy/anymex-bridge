# ──────────────────────────────────────────────────────────────────────────────
# JVM Bridge Server — Dockerfile
# ──────────────────────────────────────────────────────────────────────────────
# Multi-stage build for the AnymeX JVM Bridge Server.
# Stage 1: Build the fat JAR using Gradle
# Stage 2: Runtime image with JRE 17 only (much smaller than full JDK)
#
# Usage:
#   docker build -t anymex-bridge-server .
#   docker run -p 8080:8080 anymex-bridge-server
#   docker run -p 8080:8080 -e BRIDGE_PORT=8080 -e BRIDGE_CACHE_DIR=/data/extensions anymex-bridge-server
# ──────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: Build ────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jdk-jammy AS builder

WORKDIR /build

# Copy Gradle wrapper and source files
COPY gradle/ gradle/
COPY gradlew .
COPY build.gradle.kts .
COPY settings.gradle.kts .
COPY gradle.properties .

# Download dependencies first (layer caching)
RUN chmod +x gradlew && \
    ./gradlew dependencies --no-daemon || true

# Copy source code
COPY src/ src/

# Build the fat JAR (shadow JAR with all dependencies)
RUN ./gradlew shadowJar --no-daemon --parallel

# ─── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM eclipse-temurin:17-jre-jammy

# Labels for container metadata
LABEL maintainer="AnymeX"
LABEL description="AnymeX JVM Bridge Server — iOS extension runtime bridge"
LABEL version="1.0.0"

WORKDIR /app

# Create non-root user for security
RUN groupadd -r bridge && useradd -r -g bridge -d /app -s /sbin/nologin bridge

# Copy the fat JAR from the build stage
COPY --from=builder /build/build/libs/jvm-bridge-server-1.0.0.jar /app/jvm-bridge-server.jar

# Create cache and temp directories with proper permissions
RUN mkdir -p /app/extensions-cache /app/tmp && \
    chown -R bridge:bridge /app

# Switch to non-root user
USER bridge

# Expose the default server port
EXPOSE 8080

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

# Environment variables (can be overridden at runtime)
ENV BRIDGE_PORT=8080 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_CACHE_DIR=/app/extensions-cache \
    BRIDGE_TEMP_DIR=/app/tmp \
    BRIDGE_LOG_LEVEL=INFO \
    BRIDGE_MAX_MEMORY_MB=512 \
    BRIDGE_CORS_ORIGINS=*

# Run the server
ENTRYPOINT ["java", \
    "-XX:+UseContainerSupport", \
    "-XX:MaxRAMPercentage=75.0", \
    "-Djava.net.preferIPv4Stack=true", \
    "-jar", \
    "/app/jvm-bridge-server.jar"]
