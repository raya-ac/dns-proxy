#!/bin/bash
# DNS Proxy Server Setup Script
# Run this on your Linux server as root
# This server IS the exit node - traffic exits directly from here

set -e

echo "=== DNS Proxy Server Setup ==="
echo "This server will be the exit node - all proxied traffic exits from here"
echo ""

# Get server's primary IP
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "Server IP: $SERVER_IP"

# Detect region (simple heuristic based on common Asian IP ranges)
REGION="unknown"
if [[ $SERVER_IP == 103.* ]] || [[ $SERVER_IP == 101.* ]] || [[ $SERVER_IP == 175.* ]]; then
    REGION="sg"
    echo "Detected region: Singapore (SG)"
elif [[ $SERVER_IP == 45.* ]] || [[ $SERVER_IP == 104.* ]]; then
    REGION="us"
    echo "Detected region: United States (US)"
elif [[ $SERVER_IP == 79.* ]] || [[ $SERVER_IP == 88.* ]]; then
    REGION="eu"
    echo "Detected region: Europe (EU)"
fi
echo ""

# Install Node.js 18
echo "Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs git
echo "Node.js version: $(node --version)"
echo ""

# Create app directory and clone repo
echo "Setting up application directory..."
rm -rf /opt/dns-proxy
mkdir -p /opt/dns-proxy
cd /opt/dns-proxy

# Clone from GitHub
echo "Cloning repository..."
git clone https://github.com/raya-ac/dns-proxy.git . 
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to clone repository. Check your internet connection."
    exit 1
fi
echo "Cloned successfully!"

# Create directories
mkdir -p /opt/dns-proxy/{certs,logs}
echo ""

# Install dependencies
echo "Installing npm dependencies..."
npm install --omit=dev
if [ $? -ne 0 ]; then
    echo "ERROR: npm install failed"
    exit 1
fi
echo ""

# Generate CA certificate
echo "Generating CA certificate..."
npm run generate-ca
echo ""

# Create config file for direct mode (server IS the exit node)
echo "Creating configuration (direct mode - server is exit node)..."
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
    "method": "direct",
    "socks5": {
      "host": "",
      "port": 0,
      "username": "",
      "password": ""
    },
    "http_proxy": {
      "host": "",
      "port": 0
    },
    "wireguard_interface": "",
    "dns_resolvers": ["1.0.0.1", "8.8.8.8"],
    "region_label": "$REGION"
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

# Wait for service to start
sleep 2

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Service status:"
systemctl status dns-proxy --no-pager || true
echo ""
echo "Ports in use:"
ss -tlnp | grep -E ':(53|6000|443|3000)\s' || netstat -tlnp | grep -E ':(53|6000|443|3000)\s' || true
echo ""
echo "=== What This Does ==="
echo "- DNS queries for proxied domains resolve to: $SERVER_IP"
echo "- Traffic exits directly from this server (no tunnel)"
echo "- Origins see this server's IP: $SERVER_IP"
echo ""
echo "=== Access ==="
echo "Dashboard: http://$SERVER_IP:3000"
echo "Set your DNS to: $SERVER_IP"
echo "Download CA cert: http://$SERVER_IP:3000/api/ca-cert"
echo ""
echo "=== Manage ==="
echo "Edit domains: nano /opt/dns-proxy/config.json"
echo "Restart: systemctl restart dns-proxy"
echo "Logs: journalctl -u dns-proxy -f"
echo ""
