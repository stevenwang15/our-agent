#!/usr/bin/env bash
# my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
# Uninstaller for macOS / Linux
# Removes the globally-installed my-agent CLI

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}→${NC} $*"; }
ok()   { echo -e "${GREEN}✅${NC} $*"; }
fail() { echo -e "${RED}❌${NC} $*"; exit 1; }

echo ""
echo "  my-agent CLI Uninstaller"
echo ""

log "Uninstalling my-agent..."
npm uninstall -g my-agent 2>&1 || true

AFTER="$(command -v my-agent 2>/dev/null || true)"
if [ -n "$AFTER" ]; then
  # still there — try force remove
  TARGET="$(which my-agent 2>/dev/null || true)"
  if [ -n "$TARGET" ]; then
    log "Removing leftover: $TARGET"
    rm -f "$TARGET"
  fi
fi

AFTER2="$(command -v my-agent 2>/dev/null || true)"
if [ -z "$AFTER2" ]; then
  ok "my-agent uninstalled successfully."
else
  fail "Could not fully remove my-agent. Still at: $AFTER2"
fi
