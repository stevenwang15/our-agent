# our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
# Installer for Windows (PowerShell)
# Usage: .\install.ps1  (run from our-agent source directory)

$ErrorActionPreference = "Stop"

function Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "OK  $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "WARN $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "FAIL $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  +-----------------------------------+"
Write-Host "  |      our-agent CLI Installer       |"
Write-Host "  +-----------------------------------+"
Write-Host ""

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $SCRIPT_DIR

# ---- Node.js ----
try {
    $node = & node -v 2>$null
    if (-not $node) { Fail "Node.js not found. Install Node.js 18+ from https://nodejs.org" }
    $ver = $node -replace 'v',''
    $major = [int]$ver.Split('.')[0]
    if ($major -lt 18) { Fail "Node.js $node is too old. Need v18+." }
    Ok "Node.js $node"
} catch { Fail "Node.js not found. Install Node.js 18+ first." }

# ---- npm ----
try {
    $npmv = & npm -v 2>$null
    Ok "npm $npmv"
} catch { Fail "npm not found (should come with Node.js)." }

# ---- deps ----
if (-not (Test-Path "node_modules")) {
    Step "Installing project dependencies..."
    & npm install --production=false --no-audit --no-fund --loglevel=error
    Ok "Dependencies installed"
} else { Ok "Dependencies present" }

# ---- global install ----
Step "Installing our-agent CLI globally..."
& npm install -g . --no-audit --no-fund --loglevel=error

# ---- verify ----
$where = Get-Command our-agent -ErrorAction SilentlyContinue
if (-not $where) { Fail "Install failed: our-agent command not found." }

try { $ver = & our-agent --version 2>$null } catch { $ver = "?" }
Ok "our-agent v$ver ($($where.Source))"

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick start:"
Write-Host "    our-agent init               # Create a new agent"
Write-Host "    our-agent lint my.conf       # Check a .conf file"
Write-Host "    our-agent run my.conf        # Run an agent"
Write-Host "    our-agent export my.conf     # Export Skill / MCP"
Write-Host "    our-agent build my.conf      # Build executable"
Write-Host "    our-agent providers          # List LLM providers"
Write-Host "    our-agent --help             # Full help"
Write-Host ""
Write-Host "  Examples in: $SCRIPT_DIR\examples"
Write-Host ""
