/**
 * DNS Server - Listens on UDP port 53 and handles DNS queries
 * Routes proxied domains to local proxy IP, forwards others to upstream DNS
 */

const dgram = require('dgram');
const dns = require('dns').promises;
const { EventEmitter } = require('events');

// DNS Record Types
const DNS_TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41
};

const DNS_CLASSES = {
  IN: 1
};

class DnsServer extends EventEmitter {
  constructor(config, domainMatcher, dnsCache, statsCollector, logger) {
    super();
    this.config = config;
    this.domainMatcher = domainMatcher;
    this.dnsCache = dnsCache;
    this.stats = statsCollector;
    this.logger = logger;
    
    this.proxyIp = config.proxy_ip || '10.0.0.1';
    this.upstreamAu = config.upstream_au || ['8.8.8.8', '8.8.4.4'];
    this.upstreamAsia = config.upstream_asia || ['1.0.0.1', '8.8.4.4'];
    this.cacheTtl = config.cache_ttl || 300;
    
    this.socket = null;
    this.listening = false;
    
    // Parse listen address
    const [host, port] = (config.listen || '0.0.0.0:53').split(':');
    this.listenHost = host;
    this.listenPort = parseInt(port, 10) || 53;
  }

  /**
   * Start the DNS server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      
      this.socket.on('error', (err) => {
        this.logger.error('DNS server error', { error: err.message });
        this.emit('error', err);
        reject(err);
      });
      
      this.socket.on('message', (msg, rinfo) => {
        this._handleQuery(msg, rinfo).catch(err => {
          this.logger.error('Error handling DNS query', { error: err.message });
        });
      });
      
      this.socket.on('listening', () => {
        this.listening = true;
        this.logger.info('DNS server started', { 
          host: this.listenHost, 
          port: this.listenPort 
        });
        resolve();
      });
      
      this.socket.bind(this.listenPort, this.listenHost);
    });
  }

  /**
   * Stop the DNS server
   */
  async stop() {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }
      
      this.listening = false;
      this.socket.close(() => {
        this.logger.info('DNS server stopped');
        resolve();
      });
    });
  }

  /**
   * Handle incoming DNS query
   */
  async _handleQuery(msg, rinfo) {
    const startTime = Date.now();
    
    try {
      // Parse the DNS query
      const query = this._parseQuery(msg);
      if (!query) {
        this.logger.debug('Invalid DNS query', { source: rinfo.address });
        return;
      }
      
      const domain = query.questions[0]?.name;
      const queryType = query.questions[0]?.type;
      const queryTypeName = this._getRecordTypeName(queryType);
      
      if (!domain) {
        this.logger.debug('DNS query with no questions', { source: rinfo.address });
        return;
      }
      
      // Check if domain should be proxied
      const shouldProxy = this.domainMatcher.shouldProxy(domain);
      
      let response;
      let route;
      let isCacheHit = false;
      
      if (shouldProxy) {
        // Proxied domain - respond with proxy IP
        route = 'asia';
        
        // Check cache first
        const cached = this.dnsCache.get(domain, queryTypeName);
        if (cached) {
          response = cached;
          isCacheHit = true;
        } else {
          // Generate response with proxy IP
          response = this._createProxyResponse(query, queryType);
          this.dnsCache.set(domain, queryTypeName, response, this.cacheTtl);
        }
      } else {
        // Non-proxied domain - forward to Australian upstream
        route = 'au';
        
        // Check cache first
        const cached = this.dnsCache.get(domain, queryTypeName);
        if (cached && cached._cached) {
          response = cached;
          isCacheHit = true;
        } else {
          // Forward to upstream DNS
          response = await this._forwardQuery(domain, queryType, queryTypeName);
          if (response) {
            this.dnsCache.set(domain, queryTypeName, response, response.ttl || this.cacheTtl);
          }
        }
      }
      
      // Record stats
      this.stats.recordDnsQuery(route, isCacheHit);
      
      // Log the query
      const latency = Date.now() - startTime;
      const responseIp = response?.answers?.[0]?.data || 'N/A';
      this.logger.logQuery(rinfo.address, domain, queryTypeName, route, responseIp, latency);
      
      // Emit event for dashboard
      this.emit('query', {
        timestamp: new Date().toISOString(),
        source: rinfo.address,
        domain,
        queryType: queryTypeName,
        route,
        responseIp,
        latencyMs: latency
      });
      
      // Send response
      if (response) {
        const responseBuffer = this._createResponseBuffer(query, response);
        this.socket.send(responseBuffer, 0, responseBuffer.length, rinfo.port, rinfo.address);
      }
      
    } catch (error) {
      this.logger.error('Error processing DNS query', { error: error.message });
      this.stats.recordDnsError();
    }
  }

  /**
   * Parse a DNS query buffer
   */
  _parseQuery(buffer) {
    try {
      const header = {
        id: buffer.readUInt16BE(0),
        flags: buffer.readUInt16BE(2),
        questions: buffer.readUInt16BE(4),
        answers: buffer.readUInt16BE(6),
        authority: buffer.readUInt16BE(8),
        additional: buffer.readUInt16BE(10)
      };
      
      // Check if this is a standard query (QR=0, OPCODE=0)
      const isQuery = (header.flags & 0x8000) === 0;
      if (!isQuery) {
        return null;
      }
      
      const questions = [];
      let offset = 12;
      
      for (let i = 0; i < header.questions; i++) {
        const { name, offset: newOffset } = this._readName(buffer, offset);
        offset = newOffset;
        
        const type = buffer.readUInt16BE(offset);
        const cls = buffer.readUInt16BE(offset + 2);
        offset += 4;
        
        questions.push({ name, type, class: cls });
      }
      
      return { header, questions };
    } catch (error) {
      return null;
    }
  }

  /**
   * Read a domain name from DNS buffer (handles compression)
   */
  _readName(buffer, offset) {
    const labels = [];
    let jumped = false;
    let originalOffset = offset;
    let maxJumps = 10; // Prevent infinite loops
    const maxLength = buffer.length - 1; // Max valid offset

    while (true) {
      if (offset < 0 || offset > maxLength) {
        // Out of bounds
        if (!jumped) originalOffset = Math.min(offset, buffer.length);
        break;
      }

      const len = buffer.readUInt8(offset);

      if (len === 0) {
        if (!jumped) offset++;
        break;
      }

      // Check for compression pointer (top 2 bits set)
      if ((len & 0xC0) === 0xC0) {
        if (offset + 1 > maxLength) {
          // Not enough bytes for pointer
          if (!jumped) originalOffset = Math.min(offset + 1, buffer.length);
          break;
        }
        const pointer = buffer.readUInt16BE(offset) & 0x3FFF;
        if (pointer >= buffer.length) {
          // Invalid pointer
          if (!jumped) originalOffset = Math.min(offset + 2, buffer.length);
          break;
        }
        if (!jumped) {
          originalOffset = offset + 2;
        }
        offset = pointer;
        jumped = true;
        maxJumps--;
        if (maxJumps <= 0) break;
        continue;
      }

      offset++;
      // Sanity check on label length
      if (len > 63 || offset + len > buffer.length) {
        if (!jumped) originalOffset = Math.min(offset, buffer.length);
        break;
      }
      const label = buffer.slice(offset, offset + len).toString('ascii');
      labels.push(label);
      offset += len;
    }

    return {
      name: labels.join('.') || 'unknown',
      offset: jumped ? originalOffset : offset
    };
  }

  /**
   * Create a DNS response for proxied domains (returns proxy IP)
   */
  _createProxyResponse(query, queryType) {
    const answers = [];
    const ttl = this.cacheTtl;
    
    for (const question of query.questions) {
      if (question.type === DNS_TYPES.A) {
        answers.push({
          name: question.name,
          type: DNS_TYPES.A,
          class: DNS_CLASSES.IN,
          ttl,
          data: this.proxyIp
        });
      } else if (question.type === DNS_TYPES.AAAA) {
        // For IPv6, we could return ::1 or a mapped IPv6 address
        // For simplicity, we'll return empty (no IPv6 for proxy)
        // Client will fall back to IPv4
        continue;
      }
    }
    
    return {
      answers,
      ttl
    };
  }

  /**
   * Forward a DNS query to upstream servers
   */
  async _forwardQuery(domain, queryType, queryTypeName) {
    // Choose upstream based on whether this is for proxied domain resolution
    // For non-proxied domains, use Australian upstream
    const upstreams = this.upstreamAu;
    
    // Try each upstream until one succeeds
    for (const upstream of upstreams) {
      try {
        const resolver = new dns.Resolver();
        resolver.setServers([upstream]);
        
        let addresses;
        let ttl = this.cacheTtl;
        
        if (queryType === DNS_TYPES.A) {
          addresses = await resolver.resolve4(domain);
        } else if (queryType === DNS_TYPES.AAAA) {
          addresses = await resolver.resolve6(domain);
        } else if (queryType === DNS_TYPES.MX) {
          const records = await resolver.resolveMx(domain);
          addresses = records.map(r => `${r.priority} ${r.exchange}`);
        } else if (queryType === DNS_TYPES.TXT) {
          addresses = await resolver.resolveTxt(domain);
          addresses = addresses.map(a => a.join(' '));
        } else if (queryType === DNS_TYPES.CNAME) {
          addresses = await resolver.resolveCname(domain);
        } else if (queryType === DNS_TYPES.NS) {
          addresses = await resolver.resolveNs(domain);
        } else if (queryType === DNS_TYPES.SOA) {
          const soa = await resolver.resolveSoa(domain);
          addresses = [`${soa.nsname} ${soa.hostmaster}`];
        } else if (queryType === DNS_TYPES.PTR) {
          addresses = await resolver.resolvePtr(domain);
          addresses = addresses.map(a => a);
        } else if (queryType === DNS_TYPES.SRV) {
          const records = await resolver.resolveSrv(domain);
          addresses = records.map(r => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
        } else {
          // Unknown type, try A record as fallback
          addresses = await resolver.resolve4(domain);
        }
        
        if (addresses && addresses.length > 0) {
          return {
            answers: addresses.map(addr => ({
              name: domain,
              type: queryType,
              class: DNS_CLASSES.IN,
              ttl,
              data: Array.isArray(addr) ? addr.join(' ') : addr
            })),
            ttl
          };
        }
      } catch (error) {
        // Try next upstream
        continue;
      }
    }
    
    // All upstreams failed
    this.logger.warn('All upstream DNS servers failed', { domain, queryType: queryTypeName });
    return null;
  }

  /**
   * Create a DNS response buffer
   */
  _createResponseBuffer(query, responseData) {
    const answers = responseData.answers || [];
    
    // Calculate response size
    let size = 12; // Header
    for (const answer of answers) {
      size += this._estimateRecordSize(answer);
    }
    
    const buffer = Buffer.alloc(size);
    let offset = 0;
    
    // Header
    buffer.writeUInt16BE(query.header.id, offset); offset += 2;
    buffer.writeUInt16BE(0x8180, offset); offset += 2; // Response, no error
    buffer.writeUInt16BE(query.questions.length, offset); offset += 2;
    buffer.writeUInt16BE(answers.length, offset); offset += 2;
    buffer.writeUInt16BE(0, offset); offset += 2; // Authority
    buffer.writeUInt16BE(0, offset); offset += 2; // Additional
    
    // Questions (echo back)
    for (const question of query.questions) {
      offset = this._writeName(buffer, question.name, offset);
      buffer.writeUInt16BE(question.type, offset); offset += 2;
      buffer.writeUInt16BE(question.class, offset); offset += 2;
    }
    
    // Answers
    for (const answer of answers) {
      offset = this._writeRecord(buffer, answer, offset);
    }
    
    return buffer.slice(0, offset);
  }

  /**
   * Estimate the size of a DNS record
   */
  _estimateRecordSize(record) {
    let size = 0;
    size += record.name.length + 2; // Name with compression
    size += 10; // Type (2) + Class (2) + TTL (4) + Data length (2)
    
    if (record.type === DNS_TYPES.A) {
      size += 4;
    } else if (record.type === DNS_TYPES.AAAA) {
      size += 16;
    } else {
      size += String(record.data).length;
    }
    
    return size;
  }

  /**
   * Write a domain name to buffer
   */
  _writeName(buffer, name, offset) {
    const labels = name.split('.');
    for (const label of labels) {
      if (label.length > 0) {
        buffer.writeUInt8(label.length, offset);
        offset++;
        buffer.write(label, offset, 'ascii');
        offset += label.length;
      }
    }
    buffer.writeUInt8(0, offset);
    return offset + 1;
  }

  /**
   * Write a DNS record to buffer
   */
  _writeRecord(buffer, record, offset) {
    const nameOffset = offset;
    offset = this._writeName(buffer, record.name, offset);
    
    buffer.writeUInt16BE(record.type, offset); offset += 2;
    buffer.writeUInt16BE(record.class, offset); offset += 2;
    
    // Prepare data
    let data;
    if (record.type === DNS_TYPES.A) {
      data = this._ipToBuffer(record.data);
    } else if (record.type === DNS_TYPES.AAAA) {
      data = this._ipToBuffer(record.data);
    } else {
      data = Buffer.from(String(record.data), 'ascii');
    }
    
    buffer.writeUInt16BE(data.length, offset); offset += 2;
    data.copy(buffer, offset);
    offset += data.length;
    
    return offset;
  }

  /**
   * Convert IP address to buffer
   */
  _ipToBuffer(ip) {
    if (ip.includes(':')) {
      // IPv6
      return Buffer.from(ip.split(':').map(s => parseInt(s || '0', 16) || 0));
    } else {
      // IPv4
      return Buffer.from(ip.split('.').map(s => parseInt(s, 10)));
    }
  }

  /**
   * Get DNS record type name
   */
  _getRecordTypeName(type) {
    for (const [name, value] of Object.entries(DNS_TYPES)) {
      if (value === type) return name;
    }
    return `TYPE${type}`;
  }

  /**
   * Get DNS record type value
   */
  _getRecordTypeValue(name) {
    return DNS_TYPES[name.toUpperCase()] || 0;
  }
}

module.exports = DnsServer;
