# DNS Proxy Windows Setup Script
# Run this in PowerShell as Administrator

param(
    [string]$ProxyIP = "79.108.225.56",
    [string]$DashboardPort = "3000"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DNS Proxy - Windows Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator'" -ForegroundColor Yellow
    exit 1
}

Write-Host "[1/4] Downloading CA certificate..." -ForegroundColor Green
try {
    $caUrl = "http://${ProxyIP}:${DashboardPort}/api/ca-cert"
    $caPath = "$env:TEMP\dns-proxy-ca.pem"
    Invoke-WebRequest -Uri $caUrl -OutFile $caPath -UseBasicParsing
    Write-Host "  Downloaded to: $caPath" -ForegroundColor Gray
} catch {
    Write-Host "  ERROR: Could not download CA certificate" -ForegroundColor Red
    Write-Host "  Make sure the proxy server is running and accessible" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "[2/4] Installing CA certificate to Trusted Root..." -ForegroundColor Green
try {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store "Root", "LocalMachine"
    $store.Open("ReadWrite")
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $caPath
    $store.Add($cert)
    $store.Close()
    Write-Host "  Certificate installed successfully" -ForegroundColor Gray
} catch {
    Write-Host "  ERROR: Failed to install certificate" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "[3/4] Configuring DNS settings..." -ForegroundColor Green

# Get all network adapters that are up
$adapters = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }

if ($adapters.Count -eq 0) {
    Write-Host "  ERROR: No active network adapters found" -ForegroundColor Red
    exit 1
}

Write-Host "  Found $($adapters.Count) active network adapter(s)" -ForegroundColor Gray

foreach ($adapter in $adapters) {
    Write-Host "  Configuring: $($adapter.Name)" -ForegroundColor Gray
    try {
        # Set DNS server to proxy
        Set-DnsClientServerAddress -InterfaceIndex $adapter.InterfaceIndex -ServerAddresses $ProxyIP
        Write-Host "    DNS set to: $ProxyIP" -ForegroundColor Gray
    } catch {
        Write-Host "    WARNING: Could not configure $($adapter.Name)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "[4/4] Flushing DNS cache..." -ForegroundColor Green
Clear-DnsClientCache
Write-Host "  DNS cache cleared" -ForegroundColor Gray

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Your DNS is now configured to use: $ProxyIP" -ForegroundColor White
Write-Host ""
Write-Host "Dashboard: http://${ProxyIP}:${DashboardPort}" -ForegroundColor Cyan
Write-Host ""
Write-Host "To add domains to proxy:" -ForegroundColor Yellow
Write-Host "  1. Open the dashboard in your browser" -ForegroundColor Gray
Write-Host "  2. Go to 'Proxied Domains' tab" -ForegroundColor Gray
Write-Host "  3. Add domains you want to route through the proxy" -ForegroundColor Gray
Write-Host ""
Write-Host "To revert DNS settings (use Google DNS):" -ForegroundColor Yellow
Write-Host "  Set-DnsClientServerAddress -InterfaceIndex <index> -ServerAddresses 8.8.8.8,8.8.4.4" -ForegroundColor Gray
Write-Host ""

# Test DNS
Write-Host "Testing DNS connection..." -ForegroundColor Green
try {
    $result = Resolve-DnsName -Name "google.com" -Server $ProxyIP -QuickTimeout -ErrorAction Stop
    Write-Host "  DNS resolution working!" -ForegroundColor Green
} catch {
    Write-Host "  WARNING: DNS test failed" -ForegroundColor Yellow
    Write-Host "  The proxy may still be starting up, try again in a minute" -ForegroundColor Gray
}

Write-Host ""
