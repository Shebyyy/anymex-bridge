/**
 * In-memory sliding-window rate limiter.
 * No dependencies, no DB — pure Map with auto-cleanup.
 */

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private cleanupInterval: ReturnType<typeof setInterval>

  constructor(
    private maxRequests: number,
    private windowMs: number,
    private name: string = 'rate-limit'
  ) {
    // Auto-cleanup expired buckets every 5 min
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000)
  }

  /** Returns true if the request is ALLOWED, false if rate-limited */
  check(key: string): boolean {
    const now = Date.now()
    const fullKey = `${this.name}:${key}`
    const bucket = this.buckets.get(fullKey)

    if (!bucket || now >= bucket.resetAt) {
      // New window
      this.buckets.set(fullKey, { count: 1, resetAt: now + this.windowMs })
      return true
    }

    if (bucket.count < this.maxRequests) {
      bucket.count++
      return true
    }

    // Rate limited
    return false
  }

  /** Increment count without checking (e.g. track failed login) */
  hit(key: string): void {
    const now = Date.now()
    const fullKey = `${this.name}:${key}`
    const bucket = this.buckets.get(fullKey)

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(fullKey, { count: 1, resetAt: now + this.windowMs })
    } else {
      bucket.count++
    }
  }

  /** Get remaining attempts (0 = rate limited) */
  remaining(key: string): number {
    const now = Date.now()
    const fullKey = `${this.name}:${key}`
    const bucket = this.buckets.get(fullKey)

    if (!bucket || now >= bucket.resetAt) return this.maxRequests
    return Math.max(0, this.maxRequests - bucket.count)
  }

  /** Reset a bucket (e.g. on successful login) */
  reset(key: string): void {
    this.buckets.delete(`${this.name}:${key}`)
  }

  /** Remove expired buckets to prevent memory leak */
  private cleanup(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key)
      }
    }
  }

  /** Stop the cleanup timer */
  destroy(): void {
    clearInterval(this.cleanupInterval)
    this.buckets.clear()
  }
}

// ── Pre-configured limiters ──

/** 3 registrations per IP per hour */
export const registerLimiter = new RateLimiter(3, 60 * 60 * 1000, 'register')

/** 10 failed login attempts per IP per 15 min → then blocked */
export const loginLimiter = new RateLimiter(10, 15 * 60 * 1000, 'login')

/** 5 admin key attempts per IP per 30 min */
export const adminLoginLimiter = new RateLimiter(5, 30 * 60 * 1000, 'admin-login')

/** 120 RPC calls per user per minute */
export const rpcLimiter = new RateLimiter(120, 60 * 1000, 'rpc')

/** 200 total HTTP requests per IP per minute (global guard) */
export const globalLimiter = new RateLimiter(200, 60 * 1000, 'global')
