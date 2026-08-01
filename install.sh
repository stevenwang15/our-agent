#!/usr/bin/env bash
# our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
# Installer for macOS / Linux
# Usage: ./install.sh  (run from our-agent source directory)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}→${NC} $*"; }
ok()   { echo -e "${GREEN}✅${NC} $*"; }
warn() { echo -e "${YELLOW}⚠️${NC}  $*"; }
fail() { echo -e "${RED}❌${NC} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║     our-agent CLI Installer            ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ---- Check Node.js ----
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install Node.js 18+ first: https://nodejs.org"
fi
NODE_VER="$(node -v | sed 's/v//')"
NODE_MAJOR="${NODE_VER%%.*}"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js v$NODE_VER is too old. Need v18 or higher."
fi
ok "Node.js v$NODE_VER"

# ---- Check npm ----
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found (should come with Node.js)"
fi
ok "npm $(npm -v)"

# ---- Install dependencies if missing ----
if [ ! -d "node_modules" ]; then
  log "Installing project dependencies..."
  npm install --production=false --no-audit --no-fund --loglevel=error
  ok "Dependencies installed"
else
  ok "Dependencies present"
fi

# ---- Install globally ----
log "Installing our-agent CLI globally..."
npm install -g . --no-audit --no-fund --loglevel=error

# ---- Verify ----
INSTALLED="$(command -v our-agent || true)"
if [ -z "$INSTALLED" ]; then
  fail "Install failed: our-agent command not found after install."
fi

VERSION="$(our-agent --version 2>/dev/null || true)"
ok "Installed: our-agent v${VERSION:-unknown} ($INSTALLED)"

echo ""
echo "  🚀  Installation complete!"
echo ""
echo "  Quick start:"
echo "    our-agent init               # Create a new agent"
echo "    our-agent lint my.conf       # Check a .conf file"
echo "    our-agent run my.conf        # Run an agent"
echo "    our-agent export my.conf     # Export Skill / MCP"
echo "    our-agent build my.conf      # Build executable"
echo "    our-agent providers          # List LLM providers"
echo "    our-agent --help             # Full help"
echo ""
echo "  📁  Examples in: $SCRIPT_DIR/examples"
echo ""
