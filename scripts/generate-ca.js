#!/usr/bin/env node

/**
 * CA Certificate Generation Script
 * Generates a self-signed CA certificate for the DNS proxy
 * 
 * Usage: node scripts/generate-ca.js [--force]
 * 
 * Options:
 *   --force  Overwrite existing CA certificate
 */

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

// Parse arguments
const args = process.argv.slice(2);
const force = args.includes('--force');

// Configuration
const certsDir = path.join(__dirname, '..', 'certs');
const caCertPath = path.join(certsDir, 'ca.pem');
const caKeyPath = path.join(certsDir, 'ca-key.pem');

// Check if CA already exists
if (!force && fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
  console.log('CA certificate already exists!');
  console.log(`  Certificate: ${caCertPath}`);
  console.log(`  Private Key: ${caKeyPath}`);
  console.log('');
  console.log('To regenerate, run with --force flag:');
  console.log('  node scripts/generate-ca.js --force');
  console.log('');
  console.log('WARNING: Regenerating will invalidate all previously issued certificates!');
  process.exit(0);
}

// Ensure certs directory exists
if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

console.log('Generating CA certificate...');

// Generate RSA key pair
console.log('  Generating 2048-bit RSA key pair...');
const keys = forge.pki.rsa.generateKeyPair(2048);

// Create CA certificate
console.log('  Creating CA certificate...');
const cert = forge.pki.createCertificate();

cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10); // 10 years

const attrs = [
  { name: 'commonName', value: 'DNS Proxy Local CA' },
  { name: 'countryName', value: 'AU' },
  { name: 'organizationName', value: 'DNS Proxy' },
  { name: 'organizationalUnitName', value: 'Local Development' }
];

cert.setSubject(attrs);
cert.setIssuer(attrs); // Self-signed

// Set CA extensions
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
  },
  {
    name: 'authorityKeyIdentifier'
  }
]);

// Self-sign the certificate
console.log('  Signing certificate...');
cert.sign(keys.privateKey, forge.md.sha256.create());

// Convert to PEM format
const certPem = forge.pki.certificateToPem(cert);
const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

// Write files
console.log('  Writing files...');
fs.writeFileSync(caCertPath, certPem);
fs.writeFileSync(caKeyPath, keyPem);

// Set restrictive permissions on key file (Unix-like systems)
try {
  fs.chmodSync(caKeyPath, 0o600);
  console.log('  Set private key permissions to 600');
} catch (e) {
  // Ignore on Windows
}

console.log('');
console.log('CA certificate generated successfully!');
console.log('');
console.log('Files created:');
console.log(`  Certificate: ${caCertPath}`);
console.log(`  Private Key: ${caKeyPath}`);
console.log('');
console.log('IMPORTANT: Install the CA certificate in your client\'s trusted root store');
console.log('to enable HTTPS proxying without certificate warnings.');
console.log('');
console.log('Installation instructions:');
console.log('');
console.log('Windows:');
console.log('  1. Double-click ca.pem');
console.log('  2. Click "Install Certificate"');
console.log('  3. Choose "Local Machine"');
console.log('  4. Select "Place all certificates in the following store"');
console.log('  5. Browse to "Trusted Root Certification Authorities"');
console.log('  6. Click OK and complete the wizard');
console.log('');
console.log('macOS:');
console.log('  1. Double-click ca.pem to open in Keychain Access');
console.log('  2. Add to "System" keychain');
console.log('  3. Double-click the certificate');
console.log('  4. Expand "Trust"');
console.log('  5. Set "When using this certificate" to "Always Trust"');
console.log('  6. Close and authenticate');
console.log('');
console.log('Linux (Ubuntu/Debian):');
console.log('  1. sudo cp ca.pem /usr/local/share/ca-certificates/dns-proxy.crt');
console.log('  2. sudo update-ca-certificates');
console.log('');
console.log('Firefox (all platforms):');
console.log('  1. Open Settings > Privacy & Security');
console.log('  2. Scroll to "Certificates"');
console.log('  3. Click "View Certificates"');
console.log('  4. Import ca.pem into "Authorities"');
console.log('  5. Check "Trust this CA to identify websites"');
console.log('');
