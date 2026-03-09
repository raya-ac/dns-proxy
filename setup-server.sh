#!/bin/bash
# DNS Proxy Server Setup Script
# Run this on your Linux server as root

set -e

echo "=== DNS Proxy Server Setup ==="
echo ""

# Get server's primary IP
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "Server IP: $SERVER_IP"
echo ""

# Install Node.js 18
echo "Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
echo "Node.js version: $(node --version)"
echo ""

# Create app directory
echo "Setting up application directory..."
mkdir -p /opt/dns-proxy/{certs,logs}
cd /opt/dns-proxy

# Copy project files (if running from uploaded tarball)
if [ -f /tmp/dns-proxy.tar.gz ]; then
    tar -xzf /tmp/dns-proxy.tar.gz -C /opt/dns-proxy --strip-components=1
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install --production
echo ""

# Generate CA certificate
echo "Generating CA certificate..."
npm run generate-ca
echo ""

# Create config file
echo "Creating configuration..."
cat > /opt/dns-proxy/config.json << EOF
{
  "proxy_ip": "$SERVER_IP",
  "dns": {
    "listen": "0.0.0.0:53",
    "upstream_au": ["61.8.0.113", "203.12.160.35", "1.1.1.1"],
    "upstream_asia": ["1.0.0.1", "8.8.4.4"],
    "cache_ttl": 300
  },
  "asian_exit": {
    "method": "socks5",
    "socks5": {
      "host": "your-asian-vps.example.com",
      "port": 1080,
      "username": "",
      "password": ""
    }
  },
  "proxy": {
    "http_port": 6000,
    "https_port": 443,
    "ca_cert": "./certs/ca.pem",
    "ca_key": "./certs/ca-key.pem"
  },
  "proxied_domains": [
    "example.com"
  ],
  "logging": {
    "level": "info",
    "file": "./logs/proxy.log"
  },
  "dashboard": {
    "enabled": true,
    "port": 3000,
    "password": ""
  }
}
EOF

echo "Config created at /opt/dns-proxy/config.json"
echo "EDIT THIS FILE to add your Asian VPS details!"
echo ""

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/dns-proxy.service << EOF
[Unit]
Description=DNS Web Proxy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/dns-proxy
ExecStart=/usr/bin/node /opt/dns-proxy/src/index.js
Restart=always
RestartSec=5

# Allow binding to privileged ports
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and start service
systemctl daemon-reload
systemctl enable dns-proxy
systemctl start dns-proxy

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Service status:"
systemctl status dns-proxy --no-pager
echo ""
echo "Ports in use:"
netstat -tlnp | grep -E ':(53|6000|443|3000)\s'
echo ""
echo "=== Next Steps ==="
echo "1. Edit /opt/dns-proxy/config.json with your Asian VPS details"
echo "2. Restart the service: systemctl restart dns-proxy"
echo "3. Access dashboard: http://$SERVER_IP:3000"
echo "4. Point your DNS to $SERVER_IP"
echo "5. Install the CA cert from: http://$SERVER_IP:3000/api/ca-cert"
echo ""
