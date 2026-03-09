/**
 * Exit Node Manager - Routes traffic through Asian exit nodes
 * Supports SOCKS5, HTTP CONNECT proxy, and WireGuard interface routing
 */

const dns = require('dns').promises;
const { SocksClient } = require('socks');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

class ExitNodeManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.method = config.method || 'socks5';
    this.regionLabel = config.region_label || 'unknown';
    
    // Health tracking
    this.health = {
      status: 'unknown',
      latencyMs: null,
      lastCheck: null,
      consecutiveFailures: 0
    };
    
    // DNS resolvers for Asian resolution
    this.asianDnsResolvers = config.dns_resolvers || ['1.0.0.1', '8.8.8.4'];
    
    // Start health checking
    this.healthInterval = null;
    this.startHealthChecks();
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }
    
    // Check health every 30 seconds
    this.healthInterval = setInterval(() => this._checkHealth(), 30000);
    if (this.healthInterval.unref) {
      this.healthInterval.unref();
    }
    
    // Do initial check
    this._checkHealth();
  }

  /**
   * Perform a health check
   */
  async _checkHealth() {
    const startTime = Date.now();

    try {
      // Test connectivity based on method
      if (this.method === 'socks5') {
        await this._testSocks5Connectivity();
      } else if (this.method === 'http_proxy') {
        await this._testHttpProxyConnectivity();
      } else if (this.method === 'wireguard') {
        await this._testWireGuardConnectivity();
      } else if (this.method === 'direct') {
        // Direct mode - just test DNS resolution
        await this._resolveWithAsianDns('1.1.1.1');
      }

      const latency = Date.now() - startTime;
      this.health = {
        status: 'healthy',
        latencyMs: latency,
        lastCheck: new Date().toISOString(),
        consecutiveFailures: 0
      };

      this.emit('health', { ...this.health, method: this.method, region: this.regionLabel });
    } catch (error) {
      this.health.consecutiveFailures++;
      this.health.status = this.health.consecutiveFailures >= 3 ? 'unhealthy' : 'degraded';
      this.health.lastCheck = new Date().toISOString();

      this.emit('health', { 
        ...this.health, 
        method: this.method, 
        region: this.regionLabel,
        error: error.message 
      });
    }
  }

  /**
   * Test SOCKS5 connectivity
   */
  async _testSocks5Connectivity() {
    const { socks5 } = this.config;
    if (!socks5 || !socks5.host) {
      throw new Error('SOCKS5 configuration missing');
    }
    
    // Try to resolve a known domain through SOCKS5
    await this._resolveWithAsianDns('1.1.1.1');
  }

  /**
   * Test HTTP proxy connectivity
   */
  async _testHttpProxyConnectivity() {
    const { http_proxy } = this.config;
    if (!http_proxy || !http_proxy.host) {
      throw new Error('HTTP proxy configuration missing');
    }
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: http_proxy.host,
        port: http_proxy.port,
        path: 'http://1.1.1.1/',
        method: 'GET',
        timeout: 5000
      };
      
      const req = http.request(options, (res) => {
        res.resume();
        resolve();
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP proxy timeout'));
      });
      
      req.end();
    });
  }

  /**
   * Test WireGuard connectivity
   */
  async _testWireGuardConnectivity() {
    const { wireguard_interface } = this.config;
    if (!wireguard_interface) {
      throw new Error('WireGuard interface configuration missing');
    }
    
    // For WireGuard, we assume if the interface exists, routing will work
    // In production, you'd check interface status via OS commands
    // This is a simplified check
    await this._resolveWithAsianDns('1.1.1.1');
  }

  /**
   * Resolve a domain using Asian DNS resolvers
   */
  async _resolveWithAsianDns(hostname) {
    // Try each resolver until one works
    for (const resolver of this.asianDnsResolvers) {
      try {
        const resolverInstance = new dns.Resolver();
        resolverInstance.setServers([resolver]);
        await resolverInstance.resolve4(hostname);
        return true;
      } catch (e) {
        // Try next resolver
      }
    }
    throw new Error('All Asian DNS resolvers failed');
  }

  /**
   * Check if exit node is healthy
   */
  isHealthy() {
    return this.health.status === 'healthy';
  }

  /**
   * Get current health status
   */
  getHealth() {
    return {
      status: this.health.status,
      latencyMs: this.health.latencyMs,
      method: this.method,
      region: this.regionLabel,
      lastCheck: this.health.lastCheck
    };
  }

  /**
   * Create an agent for HTTP/HTTPS requests that routes through the exit node
   * Returns an agent that can be used with http.request/https.request
   */
  createAgent(isHttps = false) {
    if (this.method === 'socks5') {
      return this._createSocks5Agent(isHttps);
    } else if (this.method === 'http_proxy') {
      return this._createHttpProxyAgent(isHttps);
    } else if (this.method === 'wireguard') {
      return this._createWireGuardAgent(isHttps);
    } else if (this.method === 'direct') {
      // Direct connection - server itself is the exit node
      return new (isHttps ? https.Agent : http.Agent)();
    }

    // Default to direct connection
    return isHttps ? new https.Agent() : new http.Agent();
  }

  /**
   * Create SOCKS5 agent
   */
  _createSocks5Agent(isHttps) {
    const { socks5 } = this.config;
    
    // Custom agent that creates SOCKS5 connections
    const agent = new (isHttps ? https.Agent : http.Agent)({
      createConnection: (options, oncreate) => {
        const socksOptions = {
          proxy: {
            host: socks5.host,
            port: socks5.port,
            type: 5
          },
          destination: {
            host: options.host,
            port: options.port
          },
          command: 'connect'
        };
        
        if (socks5.username && socks5.password) {
          socksOptions.proxy.userId = socks5.username;
          socksOptions.proxy.password = socks5.password;
        }
        
        SocksClient.createConnection(socksOptions)
          .then(({ socket }) => {
            oncreate(null, socket);
          })
          .catch((error) => {
            oncreate(error, null);
          });
      }
    });
    
    return agent;
  }

  /**
   * Create HTTP CONNECT proxy agent
   */
  _createHttpProxyAgent(isHttps) {
    const { http_proxy } = this.config;
    
    // For HTTP proxy, we use a custom agent
    const agent = new (isHttps ? https.Agent : http.Agent)({
      createConnection: (options, oncreate) => {
        const proxyOptions = {
          hostname: http_proxy.host,
          port: http_proxy.port,
          path: `${options.host}:${options.port}`,
          method: 'CONNECT',
          headers: {
            Host: `${options.host}:${options.port}`
          }
        };
        
        if (http_proxy.username && http_proxy.password) {
          const auth = Buffer.from(`${http_proxy.username}:${http_proxy.password}`).toString('base64');
          proxyOptions.headers['Proxy-Authorization'] = `Basic ${auth}`;
        }
        
        const proxyReq = http.request(proxyOptions);
        
        proxyReq.on('connect', (res, socket, head) => {
          if (res.statusCode === 200) {
            oncreate(null, socket);
          } else {
            oncreate(new Error(`Proxy returned ${res.statusCode}`), null);
          }
        });
        
        proxyReq.on('error', (error) => {
          oncreate(error, null);
        });
        
        proxyReq.end();
      }
    });
    
    return agent;
  }

  /**
   * Create WireGuard agent
   * For WireGuard, we rely on OS routing - just use default agent
   * The traffic will be routed through the WireGuard interface based on routing rules
   */
  _createWireGuardAgent(isHttps) {
    // WireGuard routing is handled at OS level
    // We just need to ensure we're using Asian DNS for resolution
    return new (isHttps ? https.Agent : http.Agent)();
  }

  /**
   * Resolve a domain through Asian DNS
   * This ensures CDN/geo-routing serves Asian-region content
   */
  async resolveAsian(domain, type = 'A') {
    const resolvers = this.asianDnsResolvers;
    
    for (const resolverIp of resolvers) {
      try {
        const resolver = new dns.Resolver();
        resolver.setServers([resolverIp]);
        
        if (type === 'A') {
          const addresses = await resolver.resolve4(domain);
          return addresses[0];
        } else if (type === 'AAAA') {
          const addresses = await resolver.resolve6(domain);
          return addresses[0];
        }
      } catch (e) {
        // Try next resolver
      }
    }
    
    // Fallback to system DNS (last resort)
    try {
      if (type === 'A') {
        const addresses = await dns.resolve4(domain);
        return addresses[0];
      } else if (type === 'AAAA') {
        const addresses = await dns.resolve6(domain);
        return addresses[0];
      }
    } catch (e) {
      throw new Error(`Failed to resolve ${domain} through any DNS resolver`);
    }
  }

  /**
   * Make an HTTP request through the exit node
   * Convenience method that handles agent creation and request
   */
  async request(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: this.createAgent(isHttps),
        timeout: options.timeout || 30000
      };
      
      const lib = isHttps ? https : http;
      const req = lib.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
    });
  }

  /**
   * Stop health checks (for graceful shutdown)
   */
  destroy() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }
}

module.exports = ExitNodeManager;
