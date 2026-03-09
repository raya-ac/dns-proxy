/**
 * Stats Collector - Tracks queries, bandwidth, RPM, and other metrics
 * Maintains rolling windows for time-series data
 */

class StatsCollector {
  constructor() {
    // DNS query stats
    this.dns = {
      totalQueries: 0,
      proxied: 0,
      forwarded: 0,
      cacheHits: 0,
      errors: 0
    };

    // Proxy stats
    this.proxy = {
      activeConnections: 0,
      totalRequests: 0,
      bandwidthUp: 0,      // bytes sent to clients
      bandwidthDown: 0,    // bytes received from origins
      errors: 0
    };

    // Requests per minute - rolling 60-minute window
    this.rpmHistory = [];
    this.currentMinuteRequests = 0;
    this.lastMinuteChange = Math.floor(Date.now() / 1000);

    // Bandwidth per domain (for proxied domains)
    this.domainBandwidth = new Map();

    // Start RPM tracking interval
    this.rpmInterval = setInterval(() => this._updateRpm(), 60000);
    if (this.rpmInterval.unref) {
      this.rpmInterval.unref();
    }
  }

  /**
   * Update RPM tracking
   */
  _updateRpm() {
    const now = Math.floor(Date.now() / 1000);
    
    // Add current minute to history
    this.rpmHistory.push({
      minute: this.lastMinuteChange,
      requests: this.currentMinuteRequests
    });
    
    // Keep only last 60 minutes
    if (this.rpmHistory.length > 60) {
      this.rpmHistory.shift();
    }
    
    // Reset for next minute
    this.currentMinuteRequests = 0;
    this.lastMinuteChange = now;
  }

  /**
   * Record a DNS query
   */
  recordDnsQuery(route /* 'proxied' | 'forwarded' */, isCacheHit = false) {
    this.dns.totalQueries++;
    if (route === 'proxied') {
      this.dns.proxied++;
    } else {
      this.dns.forwarded++;
    }
    if (isCacheHit) {
      this.dns.cacheHits++;
    }
  }

  /**
   * Record a DNS error
   */
  recordDnsError() {
    this.dns.errors++;
  }

  /**
   * Record proxy connection start
   */
  recordConnectionStart() {
    this.proxy.activeConnections++;
  }

  /**
   * Record proxy connection end
   */
  recordConnectionEnd() {
    this.proxy.activeConnections = Math.max(0, this.proxy.activeConnections - 1);
  }

  /**
   * Record a proxy request
   */
  recordRequest(host, bytesUp = 0, bytesDown = 0) {
    this.proxy.totalRequests++;
    this.proxy.bandwidthUp += bytesUp;
    this.proxy.bandwidthDown += bytesDown;
    this.currentMinuteRequests++;

    // Track per-domain bandwidth for proxied domains
    if (host) {
      const normalizedHost = host.toLowerCase();
      const existing = this.domainBandwidth.get(normalizedHost) || { requests: 0, bytesUp: 0, bytesDown: 0 };
      existing.requests++;
      existing.bytesUp += bytesUp;
      existing.bytesDown += bytesDown;
      this.domainBandwidth.set(normalizedHost, existing);
    }
  }

  /**
   * Record a proxy error
   */
  recordProxyError() {
    this.proxy.errors++;
  }

  /**
   * Get current stats snapshot
   */
  getStats() {
    // Ensure RPM is up to date
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastMinuteChange >= 60) {
      this._updateRpm();
    }

    // Get RPM array (just the request counts)
    const rpm = this.rpmHistory.map(h => h.requests);
    
    // Fill with zeros if we don't have 60 minutes yet
    while (rpm.length < 60) {
      rpm.unshift(0);
    }

    return {
      dns: {
        totalQueries: this.dns.totalQueries,
        proxied: this.dns.proxied,
        forwarded: this.dns.forwarded,
        cacheHits: this.dns.cacheHits,
        errors: this.dns.errors,
        cacheHitRate: this.dns.totalQueries > 0 
          ? (this.dns.cacheHits / this.dns.totalQueries) 
          : 0
      },
      proxy: {
        activeConnections: this.proxy.activeConnections,
        totalRequests: this.proxy.totalRequests,
        bandwidthUp: this.proxy.bandwidthUp,
        bandwidthDown: this.proxy.bandwidthDown,
        errors: this.proxy.errors
      },
      rpm: rpm.slice(-60) // Last 60 minutes
    };
  }

  /**
   * Get bandwidth breakdown by domain
   */
  getDomainBandwidth() {
    const result = [];
    for (const [domain, stats] of this.domainBandwidth) {
      result.push({
        domain,
        requests: stats.requests,
        bytesUp: stats.bytesUp,
        bytesDown: stats.bytesDown,
        totalBytes: stats.bytesUp + stats.bytesDown
      });
    }
    // Sort by total bytes descending
    return result.sort((a, b) => b.totalBytes - a.totalBytes);
  }

  /**
   * Get top domains by bandwidth
   */
  getTopDomains(limit = 10) {
    return this.getDomainBandwidth().slice(0, limit);
  }

  /**
   * Reset all stats
   */
  reset() {
    this.dns = {
      totalQueries: 0,
      proxied: 0,
      forwarded: 0,
      cacheHits: 0,
      errors: 0
    };
    this.proxy = {
      activeConnections: 0,
      totalRequests: 0,
      bandwidthUp: 0,
      bandwidthDown: 0,
      errors: 0
    };
    this.rpmHistory = [];
    this.currentMinuteRequests = 0;
    this.lastMinuteChange = Math.floor(Date.now() / 1000);
    this.domainBandwidth.clear();
  }

  /**
   * Stop tracking intervals (for graceful shutdown)
   */
  destroy() {
    if (this.rpmInterval) {
      clearInterval(this.rpmInterval);
      this.rpmInterval = null;
    }
  }

  /**
   * Format bytes to human-readable string
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = StatsCollector;
