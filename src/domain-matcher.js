/**
 * Domain Matcher - Wildcard and exact domain matching for proxied domains
 * Supports patterns like:
 *   - exact: "example.com"
 *   - wildcard: "*.example.com" (matches all subdomains)
 *   - specific: "sub.example.com"
 */

class DomainMatcher {
  constructor(domains = []) {
    // Store domains as objects with pattern and enabled state
    this.domains = new Map();
    domains.forEach(d => this.add(d));
  }

  /**
   * Normalize a domain to lowercase
   */
  _normalize(domain) {
    return domain.toLowerCase().trim();
  }

  /**
   * Parse a domain pattern into its components
   */
  _parsePattern(pattern) {
    const normalized = this._normalize(pattern);
    const isWildcard = normalized.startsWith('*.');
    const baseDomain = isWildcard ? normalized.slice(2) : normalized;
    return { pattern: normalized, isWildcard, baseDomain };
  }

  /**
   * Check if a domain matches a pattern
   */
  _matches(domain, patternObj) {
    const normalizedDomain = this._normalize(domain);
    
    if (patternObj.isWildcard) {
      // Wildcard: *.example.com matches foo.example.com, bar.example.com, but NOT example.com
      if (normalizedDomain === patternObj.baseDomain) {
        return false;
      }
      // Check if domain ends with .baseDomain
      return normalizedDomain.endsWith('.' + patternObj.baseDomain);
    } else {
      // Exact match
      return normalizedDomain === patternObj.pattern;
    }
  }

  /**
   * Add a domain pattern to the matcher
   */
  add(pattern, enabled = true) {
    const { pattern: normalized, isWildcard, baseDomain } = this._parsePattern(pattern);
    this.domains.set(normalized, {
      pattern: normalized,
      isWildcard,
      baseDomain,
      enabled
    });
    return true;
  }

  /**
   * Remove a domain pattern from the matcher
   */
  remove(pattern) {
    const { pattern: normalized } = this._parsePattern(pattern);
    return this.domains.delete(normalized);
  }

  /**
   * Toggle enabled state for a domain
   */
  toggle(pattern) {
    const { pattern: normalized } = this._parsePattern(pattern);
    const domain = this.domains.get(normalized);
    if (domain) {
      domain.enabled = !domain.enabled;
      return domain.enabled;
    }
    return null;
  }

  /**
   * Check if a domain should be proxied
   */
  shouldProxy(domain) {
    const normalizedDomain = this._normalize(domain);
    
    for (const [pattern, domainObj] of this.domains) {
      if (!domainObj.enabled) continue;
      if (this._matches(normalizedDomain, domainObj)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all configured domains
   */
  getAll() {
    return Array.from(this.domains.values()).map(d => ({
      pattern: d.pattern,
      enabled: d.enabled,
      isWildcard: d.isWildcard
    }));
  }

  /**
   * Get enabled domains only
   */
  getEnabled() {
    return Array.from(this.domains.values())
      .filter(d => d.enabled)
      .map(d => d.pattern);
  }

  /**
   * Load domains from an array
   */
  loadDomains(domains) {
    this.domains.clear();
    domains.forEach(d => {
      if (typeof d === 'string') {
        this.add(d, true);
      } else if (d && d.pattern) {
        this.add(d.pattern, d.enabled !== false);
      }
    });
  }

  /**
   * Export domains as a simple array
   */
  export() {
    return Array.from(this.domains.values()).map(d => d.pattern);
  }

  /**
   * Get count of configured domains
   */
  count() {
    return this.domains.size;
  }

  /**
   * Get count of enabled domains
   */
  enabledCount() {
    return Array.from(this.domains.values()).filter(d => d.enabled).length;
  }
}

module.exports = DomainMatcher;
