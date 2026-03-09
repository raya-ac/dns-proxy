/**
 * Certificate Manager - On-the-fly TLS certificate generation
 * Generates self-signed certificates per domain using a local CA
 */

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

class CertManager {
  constructor(config) {
    this.caCertPath = config.ca_cert || './certs/ca.pem';
    this.caKeyPath = config.ca_key || './certs/ca-key.pem';
    this.certsDir = path.dirname(this.caCertPath);
    
    this.caCert = null;
    this.caKey = null;
    this.certCache = new Map(); // Cache generated certs per domain
    
    // Certificate validity in days
    this.certValidityDays = 365;
    
    // Ensure certs directory exists
    if (!fs.existsSync(this.certsDir)) {
      fs.mkdirSync(this.certsDir, { recursive: true });
    }
  }

  /**
   * Initialize the CA (load existing or generate new)
   */
  async initialize() {
    try {
      // Try to load existing CA
      if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
        const caCertPem = fs.readFileSync(this.caCertPath, 'utf8');
        const caKeyPem = fs.readFileSync(this.caKeyPath, 'utf8');
        
        this.caCert = forge.pki.certificateFromPem(caCertPem);
        this.caKey = forge.pki.privateKeyFromPem(caKeyPem);
        
        return { loaded: true, generated: false };
      }
      
      // Generate new CA
      await this._generateCa();
      return { loaded: false, generated: true };
    } catch (error) {
      throw new Error(`Failed to initialize CA: ${error.message}`);
    }
  }

  /**
   * Generate a new CA certificate and key
   */
  async _generateCa() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    
    const attrs = [
      { name: 'commonName', value: 'DNS Proxy Local CA' },
      { name: 'countryName', value: 'AU' },
      { name: 'organizationName', value: 'DNS Proxy' }
    ];
    
    cert.setSubject(attrs);
    cert.setIssuer(attrs); // Self-signed
    
    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: true,
        critical: true
      },
      {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true,
        critical: true
      },
      {
        name: 'subjectKeyIdentifier'
      }
    ]);
    
    // Self-sign the CA certificate
    cert.sign(keys.privateKey, forge.md.sha256.create());
    
    this.caCert = cert;
    this.caKey = keys.privateKey;
    
    // Save CA cert and key
    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    
    fs.writeFileSync(this.caCertPath, certPem);
    fs.writeFileSync(this.caKeyPath, keyPem);
    
    // Set restrictive permissions on key file
    try {
      fs.chmodSync(this.caKeyPath, 0o600);
    } catch (e) {
      // Ignore on Windows
    }
  }

  /**
   * Get or generate a certificate for a domain
   */
  getCertificate(domain) {
    // Normalize domain
    const normalizedDomain = domain.toLowerCase();
    
    // Check cache first
    const cached = this.certCache.get(normalizedDomain);
    if (cached && !this._isCertExpiringSoon(cached.cert)) {
      return cached;
    }
    
    // Generate new certificate
    const certData = this._generateDomainCert(normalizedDomain);
    this.certCache.set(normalizedDomain, certData);
    
    return certData;
  }

  /**
   * Generate a certificate for a specific domain
   */
  _generateDomainCert(domain) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16);
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + 1
    );
    
    const attrs = [
      { name: 'commonName', value: domain },
      { name: 'countryName', value: 'AU' },
      { name: 'organizationName', value: 'DNS Proxy' }
    ];
    
    cert.setSubject(attrs);
    cert.setIssuer(this.caCert.subject.attributes);
    
    // Handle wildcard domains for SAN
    const altNames = [{ type: 2, value: domain }]; // DNS name
    
    // If it's a wildcard like *.example.com, also add example.com
    if (domain.startsWith('*.')) {
      const baseDomain = domain.slice(2);
      altNames.push({ type: 2, value: baseDomain });
    }
    
    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: false
      },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true
      },
      {
        name: 'subjectAltName',
        altNames
      },
      {
        name: 'subjectKeyIdentifier'
      }
    ]);
    
    // Sign with CA
    cert.sign(this.caKey, forge.md.sha256.create());
    
    return {
      cert: cert,
      key: keys.privateKey,
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey)
    };
  }

  /**
   * Check if a certificate is expiring soon (within 7 days)
   */
  _isCertExpiringSoon(certData) {
    if (!certData || !certData.cert) return true;
    
    const now = new Date();
    const expiryDate = certData.cert.validity.notAfter;
    const daysUntilExpiry = (expiryDate - now) / (1000 * 60 * 60 * 24);
    
    return daysUntilExpiry < 7;
  }

  /**
   * Get the CA certificate in PEM format (for client installation)
   */
  getCACertPem() {
    if (!this.caCert) {
      return null;
    }
    return forge.pki.certificateToPem(this.caCert);
  }

  /**
   * Clear the certificate cache (useful for testing or forced renewal)
   */
  clearCache() {
    this.certCache.clear();
  }

  /**
   * Get stats about cached certificates
   */
  getStats() {
    const now = new Date();
    const stats = {
      total: this.certCache.size,
      expiringSoon: 0,
      domains: []
    };
    
    for (const [domain, data] of this.certCache) {
      const expiryDate = data.cert.validity.notAfter;
      const daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      stats.domains.push({
        domain,
        expiresAt: expiryDate.toISOString(),
        daysUntilExpiry,
        expiringSoon: daysUntilExpiry < 7
      });
      
      if (daysUntilExpiry < 7) {
        stats.expiringSoon++;
      }
    }
    
    return stats;
  }
}

module.exports = CertManager;
