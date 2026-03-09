/**
 * Dashboard API - REST + WebSocket API for the admin dashboard
 * Serves the single-page dashboard UI and provides real-time data
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const express = require('express');

class DashboardApi {
  constructor(config, dnsServer, proxyServer, exitNode, domainMatcher, statsCollector, dnsCache, logger) {
    this.config = config;
    this.dnsServer = dnsServer;
    this.proxyServer = proxyServer;
    this.exitNode = exitNode;
    this.domainMatcher = domainMatcher;
    this.stats = statsCollector;
    this.dnsCache = dnsCache;
    this.logger = logger;
    
    this.port = config.port || 3000;
    this.password = config.password || '';
    this.enabled = config.enabled !== false;
    
    this.server = null;
    this.wss = null;
    this.app = null;
    
    // Log buffer for WebSocket streaming (last 500 entries)
    this.logBuffer = [];
    this.maxLogEntries = 500;
    
    // Start time for uptime calculation
    this.startTime = Date.now();
    
    // Bind event handlers
    this._bindEvents();
  }

  /**
   * Bind events from other components
   */
  _bindEvents() {
    // Listen for DNS queries
    if (this.dnsServer) {
      this.dnsServer.on('query', (query) => {
        this._addLogEntry(query);
        this._broadcast({ type: 'dns_log', data: query });
      });
    }
    
    // Listen for exit node health updates
    if (this.exitNode) {
      this.exitNode.on('health', (health) => {
        this._broadcast({ type: 'exit_health', data: health });
      });
    }
  }

  /**
   * Add entry to log buffer
   */
  _addLogEntry(entry) {
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogEntries) {
      this.logBuffer.shift();
    }
  }

  /**
   * Broadcast message to all WebSocket clients
   */
  _broadcast(message) {
    if (!this.wss) return;
    
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    }
  }

  /**
   * Start the dashboard server
   */
  async start() {
    if (!this.enabled) {
      this.logger.info('Dashboard disabled');
      return;
    }
    
    return new Promise((resolve, reject) => {
      // Use Express for easier routing
      this.app = express();
      
      // Basic auth middleware (optional)
      if (this.password) {
        this.app.use((req, res, next) => {
          const auth = req.headers.authorization;
          if (!auth || !auth.startsWith('Basic ')) {
            res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
            return res.status(401).send('Authentication required');
          }
          
          try {
            const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf8');
            const [username, password] = credentials.split(':');
            if (password !== this.password) {
              res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
              return res.status(401).send('Authentication required');
            }
          } catch (e) {
            res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
            return res.status(401).send('Authentication required');
          }
          
          next();
        });
      }
      
      // JSON parsing
      this.app.use(express.json());
      
      // API Routes
      this._setupRoutes();
      
      // Serve dashboard HTML
      this.app.get('/', (req, res) => {
        const dashboardPath = path.join(__dirname, '..', 'public', 'dashboard.html');
        if (fs.existsSync(dashboardPath)) {
          res.sendFile(dashboardPath);
        } else {
          res.status(404).send('Dashboard not found');
        }
      });
      
      // Create HTTP server
      this.server = http.createServer(this.app);
      
      // Setup WebSocket
      this.wss = new WebSocketServer({ 
        server: this.server,
        path: '/api/ws'
      });
      
      this.wss.on('connection', (ws) => {
        this._handleWebSocketConnection(ws);
      });
      
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          this.logger.error('Dashboard server error', { error: err.message });
        }
      });
      
      this.server.listen(this.port, () => {
        this.logger.info('Dashboard started', { port: this.port });
        resolve();
      });
    });
  }

  /**
   * Setup REST API routes
   */
  _setupRoutes() {
    // System status
    this.app.get('/api/status', (req, res) => {
      res.json({
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        exitNode: this.exitNode?.getHealth() || { status: 'unknown' },
        version: '1.0.0'
      });
    });
    
    // Get domains
    this.app.get('/api/domains', (req, res) => {
      res.json(this.domainMatcher.getAll());
    });
    
    // Add domain
    this.app.post('/api/domains', (req, res) => {
      const { domain } = req.body;
      if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
      }
      
      this.domainMatcher.add(domain);
      this._saveDomains();
      res.json({ success: true, domain });
    });
    
    // Remove domain
    this.app.delete('/api/domains/:domain', (req, res) => {
      const domain = decodeURIComponent(req.params.domain);
      const removed = this.domainMatcher.remove(domain);
      if (removed) {
        this._saveDomains();
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Domain not found' });
      }
    });
    
    // Toggle domain
    this.app.put('/api/domains/:domain', (req, res) => {
      const domain = decodeURIComponent(req.params.domain);
      const enabled = this.domainMatcher.toggle(domain);
      if (enabled !== null) {
        this._saveDomains();
        res.json({ success: true, enabled });
      } else {
        res.status(404).json({ error: 'Domain not found' });
      }
    });
    
    // Get stats
    this.app.get('/api/stats', (req, res) => {
      res.json(this.stats.getStats());
    });
    
    // Get logs
    this.app.get('/api/logs', (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 100;
      res.json(this.logBuffer.slice(-limit));
    });
    
    // Get cache stats
    this.app.get('/api/cache', (req, res) => {
      res.json(this.dnsCache?.getStats() || {});
    });
    
    // Get cert stats
    this.app.get('/api/certs', (req, res) => {
      // This would need certManager passed in
      res.json({});
    });
    
    // Download CA cert
    this.app.get('/api/ca-cert', (req, res) => {
      const caCertPath = this.config.ca_cert || './certs/ca.pem';
      if (fs.existsSync(caCertPath)) {
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.setHeader('Content-Disposition', 'attachment; filename="dns-proxy-ca.pem"');
        res.send(fs.readFileSync(caCertPath));
      } else {
        res.status(404).json({ error: 'CA certificate not found' });
      }
    });
    
    // Export domains
    this.app.get('/api/domains/export', (req, res) => {
      const domains = this.domainMatcher.export().join('\n');
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="proxied-domains.txt"');
      res.send(domains);
    });
    
    // Import domains
    this.app.post('/api/domains/import', (req, res) => {
      const { domains } = req.body;
      if (!domains || !Array.isArray(domains)) {
        return res.status(400).json({ error: 'Domains array is required' });
      }
      
      let added = 0;
      for (const domain of domains) {
        if (typeof domain === 'string' && domain.trim()) {
          this.domainMatcher.add(domain.trim());
          added++;
        }
      }
      
      this._saveDomains();
      res.json({ success: true, added });
    });
    
    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  /**
   * Handle WebSocket connection
   */
  _handleWebSocketConnection(ws) {
    // Send initial stats
    ws.send(JSON.stringify({
      type: 'stats',
      data: this.stats.getStats()
    }));
    
    ws.send(JSON.stringify({
      type: 'exit_health',
      data: this.exitNode?.getHealth() || { status: 'unknown' }
    }));
    
    // Send recent logs
    for (const entry of this.logBuffer.slice(-50)) {
      ws.send(JSON.stringify({
        type: 'dns_log',
        data: entry
      }));
    }
    
    ws.on('close', () => {
      this.logger.debug('Dashboard WebSocket client disconnected');
    });
    
    ws.on('error', (err) => {
      this.logger.debug('Dashboard WebSocket error', { error: err.message });
    });
  }

  /**
   * Save domains to config file
   */
  _saveDomains() {
    const configPath = path.join(__dirname, '..', 'config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.proxied_domains = this.domainMatcher.export();
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      this.logger.error('Failed to save domains', { error: error.message });
    }
  }

  /**
   * Stop the dashboard server
   */
  async stop() {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      
      // Close all WebSocket connections
      if (this.wss) {
        for (const client of this.wss.clients) {
          client.close();
        }
      }
      
      this.server.close(() => {
        this.logger.info('Dashboard stopped');
        resolve();
      });
    });
  }
}

module.exports = DashboardApi;
