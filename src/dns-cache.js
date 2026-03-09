/**
 * DNS Cache - TTL-based caching for DNS responses
 * Automatically expires entries based on TTL
 */

class DnsCache {
  constructor(defaultTtl = 300) {
    this.defaultTtl = defaultTtl; // Default TTL in seconds
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
    
    // Start cleanup interval (run every 60 seconds)
    this.cleanupInterval = setInterval(() => this._cleanup(), 60000);
    
    // Ensure cleanup is unref'd so it doesn't keep process alive
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Generate a cache key from domain and query type
   */
  _makeKey(domain, queryType) {
    return `${domain.toLowerCase()}:${queryType}`;
  }

  /**
   * Parse a DNS key back to domain and type
   */
  _parseKey(key) {
    const [domain, queryType] = key.split(':');
    return { domain, queryType };
  }

  /**
   * Get current timestamp in seconds
   */
  _now() {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Check if an entry is still valid
   */
  _isValid(entry) {
    if (!entry) return false;
    return this._now() < entry.expiresAt;
  }

  /**
   * Get a cached response
   * @param {string} domain - The domain name
   * @param {string} queryType - The DNS query type (A, AAAA, etc.)
   * @returns {object|null} - Cached response or null if not found/expired
   */
  get(domain, queryType) {
    const key = this._makeKey(domain, queryType);
    const entry = this.cache.get(key);
    
    if (this._isValid(entry)) {
      this.stats.hits++;
      return {
        ...entry.response,
        _cached: true,
        _ttl: entry.expiresAt - this._now()
      };
    }
    
    this.stats.misses++;
    return null;
  }

  /**
   * Store a response in the cache
   * @param {string} domain - The domain name
   * @param {string} queryType - The DNS query type
   * @param {object} response - The DNS response to cache
   * @param {number} ttl - TTL in seconds (optional, uses default if not provided)
   */
  set(domain, queryType, response, ttl = null) {
    const key = this._makeKey(domain, queryType);
    const effectiveTtl = ttl ?? this.defaultTtl;
    const now = this._now();
    
    // Remove existing entry if present (to update TTL)
    if (this.cache.has(key)) {
      this.stats.evictions++;
    }
    
    this.cache.set(key, {
      response,
      expiresAt: now + effectiveTtl,
      createdAt: now,
      ttl: effectiveTtl
    });
  }

  /**
   * Delete a specific entry from the cache
   */
  delete(domain, queryType) {
    const key = this._makeKey(domain, queryType);
    return this.cache.delete(key);
  }

  /**
   * Clear the entire cache
   */
  clear() {
    this.cache.clear();
    this.stats.evictions += this.cache.size;
  }

  /**
   * Clean up expired entries
   */
  _cleanup() {
    const now = this._now();
    let expiredCount = 0;
    
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      this.stats.evictions += expiredCount;
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate: total > 0 ? (this.stats.hits / total) : 0
    };
  }

  /**
   * Get all cached entries (for debugging/inspection)
   */
  getAll() {
    const now = this._now();
    const entries = [];
    
    for (const [key, entry] of this.cache) {
      const { domain, queryType } = this._parseKey(key);
      entries.push({
        domain,
        queryType,
        ttl: Math.max(0, entry.expiresAt - now),
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt
      });
    }
    
    return entries;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = DnsCache;
