/**
 * DNS Web Proxy - Main Entry Point
 * Starts DNS server, HTTP/HTTPS proxy, and dashboard
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const DomainMatcher = require('./domain-matcher');
const DnsCache = require('./dns-cache');
const StatsCollector = require('./stats-collector');
const ExitNodeManager = require('./exit-node');
const CertManager = require('./cert-manager');
const DnsServer = require('./dns-server');
const ProxyServer = require('./proxy-server');
const DashboardApi = require('./dashboard-api');

// Load configuration
const configPath = path.join(__dirname, '..', 'config.json');
let config;

try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error('Failed to load config.json:', error.message);
  console.error('Please create a config.json file based on the example in the repository.');
  process.exit(1);
}

// Initialize logger
logger.configure(config.logging || { level: 'info', file: './logs/proxy.log' });
const log = logger.getLogger();

log.info('Starting DNS Web Proxy...');
log.info('Configuration loaded', { 
  proxy_ip: config.proxy_ip,
  proxied_domains_count: config.proxied_domains?.length || 0,
  asian_exit_method: config.asian_exit?.method
});

// Initialize components
const domainMatcher = new DomainMatcher(config.proxied_domains || []);
const dnsCache = new DnsCache(config.dns?.cache_ttl || 300);
const statsCollector = new StatsCollector();

const exitNode = new ExitNodeManager({
  method: config.asian_exit?.method || 'socks5',
  socks5: config.asian_exit?.socks5,
  http_proxy: config.asian_exit?.http_proxy,
  wireguard_interface: config.asian_exit?.wireguard_interface,
  dns_resolvers: config.asian_exit?.dns_resolvers,
  region_label: config.asian_exit?.region_label || 'unknown'
});

const certManager = new CertManager({
  ca_cert: config.proxy?.ca_cert,
  ca_key: config.proxy?.ca_key
});

const dnsServer = new DnsServer(
  {
    listen: config.dns?.listen || '0.0.0.0:53',
    proxy_ip: config.proxy_ip,
    upstream_au: config.dns?.upstream_au,
    upstream_asia: config.dns?.upstream_asia,
    cache_ttl: config.dns?.cache_ttl
  },
  domainMatcher,
  dnsCache,
  statsCollector,
  log
);

const proxyServer = new ProxyServer(
  {
    http_port: config.proxy?.http_port,
    https_port: config.proxy?.https_port,
    region_label: config.asian_exit?.region_label
  },
  exitNode,
  certManager,
  statsCollector,
  log
);

const dashboardApi = new DashboardApi(
  {
    port: config.dashboard?.port,
    password: config.dashboard?.password,
    enabled: config.dashboard?.enabled,
    ca_cert: config.proxy?.ca_cert
  },
  dnsServer,
  proxyServer,
  exitNode,
  domainMatcher,
  statsCollector,
  dnsCache,
  log
);

// Graceful shutdown
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  log.info('Shutting down...');
  
  const shutdownTasks = [
    { name: 'DNS Server', fn: () => dnsServer.stop() },
    { name: 'Proxy Server', fn: () => proxyServer.stop() },
    { name: 'Dashboard', fn: () => dashboardApi.stop() },
    { name: 'Exit Node', fn: () => exitNode.destroy() },
    { name: 'DNS Cache', fn: () => dnsCache.destroy() },
    { name: 'Stats Collector', fn: () => statsCollector.destroy() }
  ];
  
  for (const task of shutdownTasks) {
    try {
      await task.fn();
      log.info(`${task.name} stopped`);
    } catch (error) {
      log.error(`Error stopping ${task.name}`, { error: error.message });
    }
  }
  
  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', { error: error.message, stack: error.stack });
  if (!isShuttingDown) {
    shutdown();
  }
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection', { reason: reason?.message || reason });
});

// Main startup sequence
async function main() {
  try {
    // Initialize CA certificate
    log.info('Initializing certificate manager...');
    const caResult = await certManager.initialize();
    if (caResult.generated) {
      log.info('Generated new CA certificate');
      log.info('IMPORTANT: Install the CA certificate in your client\'s trusted root store');
      log.info(`CA certificate location: ${config.proxy?.ca_cert || './certs/ca.pem'}`);
    } else {
      log.info('Loaded existing CA certificate');
    }
    
    // Start DNS server
    log.info('Starting DNS server...');
    await dnsServer.start();
    
    // Start proxy server
    log.info('Starting proxy server...');
    await proxyServer.start();
    
    // Start dashboard
    log.info('Starting dashboard...');
    await dashboardApi.start();
    
    log.info('DNS Web Proxy started successfully!');
    log.info('Configuration summary:', {
      proxy_ip: config.proxy_ip,
      http_port: config.proxy?.http_port,
      https_port: config.proxy?.https_port,
      dashboard_port: config.dashboard?.port,
      proxied_domains: config.proxied_domains?.length || 0,
      asian_exit: `${config.asian_exit?.method} (${config.asian_exit?.region_label || 'unknown'})`
    });
    
    // Log warning about admin privileges for port 53
    if (process.platform !== 'win32' && process.getuid() !== 0) {
      log.warn('Note: On Linux/Mac, binding to port 53 requires root privileges.');
      log.warn('Run with sudo or use setcap: sudo setcap cap_net_bind_service=+ep node');
    }
    
  } catch (error) {
    log.error('Failed to start DNS Web Proxy', { error: error.message, stack: error.stack });
    
    // Clean up on startup failure
    exitNode.destroy();
    dnsCache.destroy();
    statsCollector.destroy();
    
    process.exit(1);
  }
}

// Start the proxy
main();
