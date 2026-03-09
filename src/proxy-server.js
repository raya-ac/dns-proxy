/**
 * Reverse Proxy Server - HTTP/HTTPS proxy that routes traffic through Asian exit node
 * Handles TLS termination, WebSocket upgrade, and transparent proxying
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const { EventEmitter } = require('events');

class ProxyServer extends EventEmitter {
  constructor(config, exitNodeManager, certManager, statsCollector, logger) {
    super();
    this.config = config;
    this.exitNode = exitNodeManager;
    this.certManager = certManager;
    this.stats = statsCollector;
    this.logger = logger;
    
    this.httpPort = config.http_port || 80;
    this.httpsPort = config.https_port || 443;
    
    this.httpServer = null;
    this.httpsServer = null;
    
    // Connection tracking
    this.connections = new Set();
    
    // Header injection (configurable)
    this.injectHeaders = {
      'X-Proxied-Via': `asia-${config.region_label || 'unknown'}`
    };
    
    // Timeouts
    this.timeout = 30000;
    this.keepAliveTimeout = 60000;
  }

  /**
   * Start the proxy servers
   */
  async start() {
    await Promise.all([
      this._startHttpServer(),
      this._startHttpsServer()
    ]);
    
    this.logger.info('Proxy servers started', {
      http_port: this.httpPort,
      https_port: this.httpsPort
    });
  }

  /**
   * Start HTTP server
   */
  async _startHttpServer() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer();
      
      this.httpServer.on('request', (req, res) => {
        this._handleRequest(req, res, false);
      });
      
      this.httpServer.on('upgrade', (req, socket, head) => {
        this._handleUpgrade(req, socket, head, false);
      });
      
      this.httpServer.on('connection', (socket) => {
        this._trackConnection(socket);
      });
      
      this.httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          this.logger.error('HTTP server error', { error: err.message });
        }
      });
      
      this.httpServer.listen(this.httpPort, () => resolve());
    });
  }

  /**
   * Start HTTPS server
   */
  async _startHttpsServer() {
    return new Promise((resolve, reject) => {
      // TLS options with SNI callback for dynamic cert generation
      const tlsOptions = {
        SNICallback: (servername, cb) => {
          try {
            const certData = this.certManager.getCertificate(servername);
            cb(null, tls.createSecureContext({
              cert: certData.certPem,
              key: certData.keyPem
            }));
          } catch (error) {
            this.logger.error('SNI cert generation failed', { 
              domain: servername, 
              error: error.message 
            });
            cb(error);
          }
        },
        keepAliveTimeout: this.keepAliveTimeout,
        requestCert: false,
        rejectUnauthorized: false
      };
      
      this.httpsServer = https.createServer(tlsOptions);
      
      this.httpsServer.on('request', (req, res) => {
        this._handleRequest(req, res, true);
      });
      
      this.httpsServer.on('upgrade', (req, socket, head) => {
        this._handleUpgrade(req, socket, head, true);
      });
      
      this.httpsServer.on('connection', (socket) => {
        this._trackConnection(socket);
      });
      
      this.httpsServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          this.logger.error('HTTPS server error', { error: err.message });
        }
      });
      
      this.httpsServer.listen(this.httpsPort, () => resolve());
    });
  }

  /**
   * Track connections for stats and cleanup
   */
  _trackConnection(socket) {
    this.connections.add(socket);
    this.stats.recordConnectionStart();
    
    socket.on('close', () => {
      this.connections.delete(socket);
      this.stats.recordConnectionEnd();
    });
    
    socket.on('error', (err) => {
      this.logger.debug('Connection error', { error: err.message });
    });
  }

  /**
   * Handle HTTP/HTTPS request
   */
  async _handleRequest(req, res, isHttps) {
    const startTime = Date.now();
    const host = this._getHost(req);
    const path = req.url;
    
    this.logger.debug('Proxy request', { 
      method: req.method, 
      host, 
      path,
      https: isHttps 
    });
    
    try {
      // Get the real origin IP through Asian DNS
      const originIp = await this.exitNode.resolveAsian(host);
      
      // Create agent for exit node routing
      const agent = this.exitNode.createAgent(isHttps);
      
      // Build upstream request options
      const options = {
        hostname: originIp,
        port: isHttps ? 443 : 80,
        path: path,
        method: req.method,
        headers: this._prepareHeaders(req, host),
        agent,
        timeout: this.timeout,
        servername: host, // For SNI
        rejectUnauthorized: false // Accept any cert from origin
      };
      
      // Make the upstream request
      const lib = isHttps ? https : http;
      const proxyReq = lib.request(options, (proxyRes) => {
        const latency = Date.now() - startTime;
        
        // Send response to client
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        
        let bytesUp = 0;
        let bytesDown = 0;
        
        proxyRes.on('data', (chunk) => {
          bytesDown += chunk.length;
          if (res.writable) {
            res.write(chunk);
          }
        });
        
        proxyRes.on('end', () => {
          res.end();
          this._logRequest(req, res, proxyRes, host, path, bytesUp, bytesDown, latency);
        });
        
        proxyRes.on('error', (err) => {
          this.logger.error('Upstream response error', { error: err.message });
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          res.end('Bad Gateway');
          this.stats.recordProxyError();
        });
      });
      
      proxyReq.on('error', (err) => {
        this.logger.error('Upstream request error', { 
          host, 
          error: err.message 
        });
        
        if (!res.headersSent) {
          // Check if it's an exit node failure
          if (!this.exitNode.isHealthy()) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Service Unavailable - Exit node unreachable');
          } else {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway');
          }
        }
        this.stats.recordProxyError();
      });
      
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'text/plain' });
          res.end('Gateway Timeout');
        }
        this.stats.recordProxyError();
      });
      
      // Pipe request body if present
      let bytesUp = 0;
      req.on('data', (chunk) => {
        bytesUp += chunk.length;
        if (proxyReq.writable) {
          proxyReq.write(chunk);
        }
      });
      
      req.on('end', () => {
        proxyReq.end();
      });
      
      req.on('error', (err) => {
        this.logger.debug('Client request error', { error: err.message });
        proxyReq.destroy();
      });
      
    } catch (error) {
      this.logger.error('Request handling error', { 
        host, 
        error: error.message 
      });
      
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      this.stats.recordProxyError();
    }
  }

  /**
   * Handle WebSocket upgrade
   */
  async _handleUpgrade(req, socket, head, isHttps) {
    const host = this._getHost(req);
    
    this.logger.debug('WebSocket upgrade', { host, url: req.url });
    
    try {
      // Get origin IP through Asian DNS
      const originIp = await this.exitNode.resolveAsian(host);
      
      // Create agent for exit node routing
      const agent = this.exitNode.createAgent(isHttps);
      
      // Build upstream request options for WebSocket
      const options = {
        hostname: originIp,
        port: isHttps ? 443 : 80,
        path: req.url,
        method: 'GET',
        headers: this._prepareHeaders(req, host),
        agent,
        servername: host,
        rejectUnauthorized: false
      };
      
      const lib = isHttps ? https : http;
      const proxyReq = lib.request(options);
      
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        // Send upgrade response to client
        socket.write('HTTP/1.1 101 Switching Protocols\r\n');
        socket.write('Upgrade: websocket\r\n');
        socket.write('Connection: Upgrade\r\n');
        if (proxyRes.headers['sec-websocket-accept']) {
          socket.write(`Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept']}\r\n`);
        }
        socket.write('\r\n');
        
        // Bidirectional pipe
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
        
        // Handle proxy head if present
        if (proxyHead && proxyHead.length > 0) {
          proxySocket.write(proxyHead);
        }
        
        if (head && head.length > 0) {
          socket.write(head);
        }
      });
      
      proxyReq.on('error', (err) => {
        this.logger.error('WebSocket upgrade error', { error: err.message });
        socket.destroy();
      });
      
      proxyReq.end();
      
    } catch (error) {
      this.logger.error('WebSocket handling error', { error: error.message });
      socket.destroy();
    }
  }

  /**
   * Get host from request (Host header or SNI)
   */
  _getHost(req) {
    return req.headers.host?.split(':')[0] || req.socket.servername || 'localhost';
  }

  /**
   * Prepare headers for upstream request
   */
  _prepareHeaders(req, host) {
    const headers = { ...req.headers };
    
    // Remove hop-by-hop headers
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers['transfer-encoding'];
    delete headers.te;
    delete headers.trailer;
    delete headers.upgrade;
    
    // Set proper Host header for upstream
    headers.host = host;
    
    // Add injected headers
    Object.assign(headers, this.injectHeaders);
    
    // Ensure we have a proper Connection header
    headers.connection = 'close';
    
    return headers;
  }

  /**
   * Log request details
   */
  _logRequest(req, res, proxyRes, host, path, bytesUp, bytesDown, latency) {
    this.stats.recordRequest(host, bytesUp, bytesDown);
    
    this.logger.logProxyRequest(
      req.method,
      host,
      path,
      proxyRes.statusCode,
      bytesUp + bytesDown,
      latency
    );
  }

  /**
   * Stop the proxy servers
   */
  async stop() {
    const closePromises = [];
    
    // Close all tracked connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    
    if (this.httpServer) {
      closePromises.push(this._closeServer(this.httpServer, 'HTTP'));
    }
    
    if (this.httpsServer) {
      closePromises.push(this._closeServer(this.httpsServer, 'HTTPS'));
    }
    
    await Promise.all(closePromises);
    
    this.logger.info('Proxy servers stopped');
  }

  /**
   * Close a server gracefully
   */
  _closeServer(server, name) {
    return new Promise((resolve) => {
      server.close(() => {
        this.logger.info(`${name} server closed`);
        resolve();
      });
      
      // Force close after timeout
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 5000);
    });
  }

  /**
   * Get active connection count
   */
  getConnectionCount() {
    return this.connections.size;
  }
}

module.exports = ProxyServer;
