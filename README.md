# DNS-Based Web Proxy

This proxy intercepts DNS queries and routes specific domains through an Asian exit node while everything else goes through your local Australian network. It's built for getting around the new wave of ISP-level blocks and geo-restrictions that have become common in Australia — whether that's gambling site bans, copyright blocks, or streaming services that don't carry the same content here.

The point is simple: you can access what you need through an Asian exit node without your everyday browsing getting routed overseas. Your banking stays local. Your Australian services stay local. Only the stuff that's blocked or restricted goes through the proxy.

## Why This Exists

Australia's internet has gotten progressively more restricted over the past few years:

- **Age verification laws** — The Online Safety Amendment Act 2024 requires age verification for adult content, with ISPs expected to enforce blocks starting late 2024. Multiple sites have already been caught up in the initial enforcement waves.

- **Gambling blocks** — Major betting sites are now blocked at the ISP level under the Interactive Gambling Act amendments.

- **Copyright blocks** — The Federal Court continues to order ISPs to block torrent and streaming sites on behalf of rights holders.

- **Geo-restricted streaming** — Netflix, Disney+, and others still serve different libraries here. Some services aren't available at all.

This proxy gives you a way around those blocks without routing all your traffic through another country. Your everyday browsing — banking, government services, local news — stays on Australian IPs. Only the domains you explicitly configure go through the Asian exit node.

## What It Does

**DNS routing:**
- Domains you specify get resolved to the proxy's IP and exit through an Asian VPS (Singapore, Tokyo, Hong Kong)
- Everything else forwards to Australian DNS resolvers and stays local

**Exit options:**
- SOCKS5 tunnel (works with a simple SSH tunnel)
- HTTP CONNECT proxy
- WireGuard interface

**HTTPS handling:**
- Generates certificates on the fly using a local CA
- Supports SNI for multiple domains
- Passes through headers and cookies unchanged

**WebSocket support:**
- Full upgrade passthrough
- Bidirectional streaming works as expected

**Dashboard:**
- Live DNS query log with filtering
- Add/remove proxied domains from the UI
- Stats on queries, bandwidth, and exit node health
- Requests per minute chart (last 60 minutes)

## How Traffic Flows

```
Client DNS query
       │
       ▼
┌──────────────┐
│  DNS Server   │ ── proxied domain? ──▶ Resolve to PROXY_IP (local)
│  (port 53)    │ ── everything else? ──▶ Forward to AU upstream DNS
└──────────────┘
       │
       ▼ (if proxied)
┌──────────────┐        ┌─────────────────┐
│ Reverse Proxy │ ──────▶│ Asian Exit Node  │ ──▶ Origin Server
│ (local 6000) │        │ (SG/TK/HK VPS)  │     (sees Asian IP)
└──────────────┘        └─────────────────┘
       │
       ▼
   Client gets response
```

## Getting Started

### What You Need

- Node.js 18 or higher
- npm
- Admin/root privileges for port 53 (or use setcap on Linux)

### Setup

1. **Install dependencies**

```bash
cd dns-proxy
npm install
```

2. **Generate the CA certificate**

```bash
npm run generate-ca
```

This creates a self-signed CA in `certs/`. You'll need to install this in your client's trusted root store, otherwise HTTPS connections will show warnings.

3. **Edit config.json**

The defaults work as a starting point. You'll want to change:

```json
{
  "proxy_ip": "10.0.0.1",
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
    "https_port": 443
  },
  "proxied_domains": [
    "example.com",
    "*.blocked-site.net"
  ],
  "dashboard": {
    "enabled": true,
    "port": 3000
  }
}
```

4. **Start it**

```bash
# Linux/Mac - needs sudo for port 53
sudo npm start

# Windows - run as Administrator
npm start
```

5. **Point your DNS at the proxy**

Change your device's DNS server to the IP of the machine running the proxy:
- Windows: Network settings → DNS
- macOS: System Preferences → Network → Advanced → DNS
- Linux: `/etc/resolv.conf` or NetworkManager
- Router: Set in DHCP (applies to everything on your network)

## Configuration Details

### config.json Keys

| Key | Type | What It Does |
|-----|------|--------------|
| `proxy_ip` | string | IP the proxy returns for proxied domains |
| `dns.listen` | string | Where DNS server binds (default: `0.0.0.0:53`) |
| `dns.upstream_au` | array | Australian DNS for non-proxied traffic |
| `dns.upstream_asia` | array | Asian DNS for resolving proxied origins |
| `dns.cache_ttl` | number | How long to cache DNS responses (seconds) |
| `asian_exit.method` | string | `socks5`, `http_proxy`, or `wireguard` |
| `asian_exit.socks5` | object | SOCKS5 host, port, credentials |
| `asian_exit.http_proxy` | object | HTTP proxy host and port |
| `asian_exit.wireguard_interface` | string | WireGuard interface name |
| `asian_exit.dns_resolvers` | array | Asian DNS for origin lookups |
| `asian_exit.region_label` | string | Label for dashboard (e.g., `sg`, `tk`) |
| `proxy.http_port` | number | HTTP proxy port (default: 6000) |
| `proxy.https_port` | number | HTTPS proxy port (default: 443) |
| `proxy.ca_cert` | string | Path to CA certificate |
| `proxy.ca_key` | string | Path to CA private key |
| `proxied_domains` | array | Domains to intercept (wildcards work) |
| `logging.level` | string | `error`, `warn`, `info`, or `debug` |
| `logging.file` | string | Where to write logs |
| `dashboard.enabled` | boolean | Turn dashboard on/off |
| `dashboard.port` | number | Dashboard port (default: 3000) |
| `dashboard.password` | string | Optional basic auth password |

### Domain Matching

The `proxied_domains` list handles three patterns:

- **Exact**: `example.com` matches only `example.com`
- **Wildcard**: `*.example.com` matches `foo.example.com` and `bar.example.com`, but not `example.com` itself
- **Specific subdomain**: `sub.example.com` matches just that one

## Installing the CA Certificate

HTTPS proxying requires clients to trust your CA. Here's how:

### Windows

1. Double-click `certs/ca.pem`
2. Click "Install Certificate"
3. Choose "Local Machine"
4. Select "Place all certificates in the following store"
5. Browse to "Trusted Root Certification Authorities"
6. Finish the wizard

### macOS

1. Double-click `certs/ca.pem` (opens Keychain Access)
2. Add to "System" keychain
3. Double-click the certificate
4. Expand "Trust"
5. Set to "Always Trust"
6. Authenticate

### Linux (Ubuntu/Debian)

```bash
sudo cp certs/ca.pem /usr/local/share/ca-certificates/dns-proxy.crt
sudo update-ca-certificates
```

### Firefox

Firefox doesn't use the system store:

1. Settings → Privacy & Security
2. Scroll to "Certificates"
3. Click "View Certificates"
4. Import `certs/ca.pem` into "Authorities"
5. Check "Trust this CA to identify websites"

## Setting Up an Asian Exit Node

### Option 1: SOCKS5 (Easiest)

**Quick SSH tunnel:**
```bash
ssh -D 1080 -N -f user@your-asian-vps.com
```

**Persistent setup with Dante:**
```bash
# On your Asian VPS
apt-get install dante-server

cat > /etc/danted.conf << EOF
logoutput: syslog
internal: eth0 port = 1080
external: eth0
socksmethod: none
clientmethod: none
client pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: connect disconnect
}
socks pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: connect disconnect
}
EOF

systemctl enable danted
systemctl start danted
```

### Option 2: HTTP Proxy

**Using Squid:**
```bash
# On your Asian VPS
apt-get install squid

# Edit /etc/squid/squid.conf
http_port 8888
http_access allow all
```

### Option 3: WireGuard

Set up WireGuard on your VPS, then configure routing so traffic from the proxy exits through the WireGuard interface.

## Dashboard

Open `http://localhost:3000` (or whatever port you set).

**What's there:**
- DNS query log with filters (pause, search by domain, filter by route)
- Domain manager (add, remove, toggle on/off)
- Stats: query counts, bandwidth, exit node latency
- Import/export domains as text files

**API endpoints:**

| Method | Endpoint | Returns |
|--------|----------|---------|
| GET | `/api/status` | Uptime, exit node health |
| GET | `/api/domains` | List of proxied domains |
| POST | `/api/domains` | Add a domain |
| DELETE | `/api/domains/:domain` | Remove a domain |
| PUT | `/api/domains/:domain` | Toggle enabled/disabled |
| GET | `/api/stats` | Current stats |
| GET | `/api/logs?limit=100` | Recent DNS queries |
| GET | `/api/domains/export` | Download domains list |
| POST | `/api/domains/import` | Upload domains list |
| WS | `/api/ws` | Live updates |

## Common Issues

**Port 53 won't bind**

Linux/Mac requires root for ports under 1024:

```bash
sudo npm start
```

Or use setcap (Linux only, lets node bind without sudo):
```bash
sudo setcap cap_net_bind_service=+ep $(which node)
npm start
```

**Certificate warnings on HTTPS sites**

The CA isn't installed in your client's trust store. See the installation steps above.

**Exit node won't connect**

Check:
1. Host and port in `config.json` are correct
2. Test with `telnet your-vps.com 1080`
3. Firewall rules on the VPS allow the connection
4. Credentials are correct if using auth

**DNS queries aren't being intercepted**

1. Your client's DNS must point to the proxy's IP
2. Verify domains are in `proxied_domains`
3. Check the DNS server is running: `netstat -ulnp | grep :53`

**Things are slow**

1. Increase `dns.cache_ttl` in config
2. Check exit node latency (shown in dashboard)
3. Watch the dashboard stats for bottlenecks

## Docker

There's a Docker Compose setup if you prefer containers:

```bash
docker-compose up -d
```

Check `docker-compose.yml` for port mappings and volume mounts.

## Security Notes

1. **CA private key** - Keep `certs/ca-key.pem` locked down. Anyone with it can issue certificates your clients will trust.

2. **Dashboard auth** - Set `dashboard.password` if this is exposed anywhere.

3. **DNS binding** - The server binds to `0.0.0.0` by default. You might want to restrict it to specific interfaces.

4. **VPS security** - Make sure your Asian exit node has proper firewall rules and authentication.

## License

MIT
