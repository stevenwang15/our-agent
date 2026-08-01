#!/usr/bin/env bash
# our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
# Uninstaller for macOS / Linux
# Removes the globally-installed our-agent CLI

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}→${NC} $*"; }
ok()   { echo -e "${GREEN}✅${NC} $*"; }
fail() { echo -e "${RED}❌${NC} $*"; exit 1; }

echo ""
echo "  our-agent CLI Uninstaller"
echo ""

log "Uninstalling our-agent..."
npm uninstall -g our-agent 2>&1 || true

AFTER="$(command -v our-agent 2>/dev/null || true)"
if [ -n "$AFTER" ]; then
  # still there — try force remove
  TARGET="$(which our-agent 2>/dev/null || true)"
  if [ -n "$TARGET" ]; then
    log "Removing leftover: $TARGET"
    rm -f "$TARGET"
  fi
fi

AFTER2="$(command -v our-agent 2>/dev/null || true)"
if [ -z "$AFTER2" ]; then
  ok "our-agent uninstalled successfully."
else
  fail "Could not fully remove our-agent. Still at: $AFTER2"
fi
