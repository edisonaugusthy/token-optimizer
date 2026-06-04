#!/usr/bin/env bash
# install.sh — One-line installer for token-optimizer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/token-optimizer/main/install.sh | bash
#
# Options (pass after --):
#   --skip-config   Install the npm package but don't patch agent configs
#   --global        Install globally with npm -g instead of npx (default: npx)
#   --help          Show this help
#
# Wrapping everything in main() prevents partial execution if the download
# is interrupted mid-stream (curl | bash safety pattern).

main() {

SKIP_CONFIG=false
USE_GLOBAL=false
NPM_PACKAGE="token-optimizer"
GITHUB_RAW="https://raw.githubusercontent.com/YOUR_ORG/token-optimizer/main"

for arg in "$@"; do
  case "$arg" in
    --skip-config) SKIP_CONFIG=true ;;
    --global)      USE_GLOBAL=true ;;
    --help|-h)
      echo "Usage: install.sh [--skip-config] [--global]"
      echo "  --skip-config   Install package only, skip agent config patching"
      echo "  --global        Install globally via npm -g (default: uses npx)"
      exit 0
      ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

info()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}!${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
heading() { echo -e "\n${BOLD}$*${RESET}"; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
heading "token-optimizer installer"

if ! command -v node &>/dev/null; then
  error "Node.js is required but not found."
  echo ""
  echo "Install Node.js from https://nodejs.org (LTS recommended), then re-run:"
  echo ""
  echo "  curl -fsSL ${GITHUB_RAW}/install.sh | bash"
  exit 1
fi

NODE_VERSION=$(node --version 2>&1 | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js >= 18 required (found v${NODE_VERSION})."
  echo "Upgrade from https://nodejs.org"
  exit 1
fi
info "Node.js v${NODE_VERSION}"

if ! command -v npm &>/dev/null; then
  error "npm is required but not found. It ships with Node.js — check your PATH."
  exit 1
fi
info "npm $(npm --version)"

# ── Install ───────────────────────────────────────────────────────────────────
heading "Installing ${NPM_PACKAGE}..."

if [ "$USE_GLOBAL" = true ]; then
  if npm install -g "$NPM_PACKAGE" 2>&1; then
    info "Installed ${NPM_PACKAGE} globally"
    RUNNER="token-optimizer"
  else
    error "Global npm install failed. Try with sudo, or omit --global to use npx."
    exit 1
  fi
else
  # npx path: ensure the package is cached and get its location
  info "Fetching ${NPM_PACKAGE} via npx..."
  # We'll call npx directly for setup; no persistent global install needed
  RUNNER="npx --yes ${NPM_PACKAGE}"
fi

# ── Configure agents ──────────────────────────────────────────────────────────
if [ "$SKIP_CONFIG" = true ]; then
  heading "Skipping agent configuration (--skip-config)"
  echo ""
  echo "Run this when ready:"
  echo "  npx ${NPM_PACKAGE} install"
else
  heading "Configuring coding agents..."
  echo ""

  if $RUNNER install; then
    true  # success message printed by the setup script itself
  else
    warn "Agent configuration step failed (non-fatal)."
    echo "Run manually: npx ${NPM_PACKAGE} install"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
heading "Done!"
echo ""
echo "Restart your AI coding agent to activate token-optimizer."
echo ""
echo "Commands:"
echo "  npx ${NPM_PACKAGE} status     — check what's installed"
echo "  npx ${NPM_PACKAGE} uninstall  — remove agent configs"
echo ""

} # end main()

main "$@"
