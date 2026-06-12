#!/usr/bin/env bash
set -euo pipefail

# install.sh — One-line installer for token-optimizer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
#   curl -fsSL ... | bash -s -- --reset-stats
#   curl -fsSL ... | bash -s -- --dir /path
#
# Environment:
#   TO_DOWNLOAD_URL  Override base URL for downloads (for testing)

# Wrap in main() to prevent partial execution from piped downloads.
# If curl|bash is interrupted mid-transfer, bash would execute the partial
# script. With this wrapper, the function is defined but main() is never
# called because the final line hasn't arrived yet.
main() {

REPO="edisonaugusthy/token-optimizer"
CONFIG_DIR="$HOME/.config/token-optimizer"
BIN_DIR="$HOME/.local/bin"
SKIP_CONFIG=false
RESET_STATS=false
UNINSTALL=false
TO_DOWNLOAD_URL="${TO_DOWNLOAD_URL:-https://unpkg.com/token-optimizer@latest/dist}"

# Security: reject non-HTTPS download URLs (defense-in-depth)
case "$TO_DOWNLOAD_URL" in
    https://*|http://localhost*|http://127.0.0.1*) ;;
    *) echo "error: refusing non-HTTPS download URL: $TO_DOWNLOAD_URL" >&2; exit 1 ;;
esac

for arg in "$@"; do
    case "$arg" in
        --reset-stats)   RESET_STATS=true ;;
        --uninstall)     UNINSTALL=true ;;
        --dir=*)         CONFIG_DIR="${arg#--dir=}" ;;
        --bin-dir=*)     BIN_DIR="${arg#--bin-dir=}" ;;
        --bin-dir)       shift; BIN_DIR="${1:-$BIN_DIR}" ;;
        --skip-config)   SKIP_CONFIG=true ;;
        --help|-h)
            cat << 'EOF'
token-optimizer installer

Usage:
  install.sh [options]

Options:
  --reset-stats    Clear token statistics
  --uninstall      Remove token-optimizer
  --dir PATH       Install directory (default: ~/.config/token-optimizer)
  --bin-dir PATH   Command directory (default: ~/.local/bin)
  --skip-config    Skip automatic agent configuration
  --help           Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
  curl -fsSL ... | bash -s -- --reset-stats
EOF
            exit 0
            ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()    { echo -e "${CYAN}→${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# Create AGENTS.md file
create_agents_md() {
    local file="$1"
    cat > "$file" << 'AGENTEOF'
# token-optimizer — Agent Instructions

This project uses a token filter to reduce noisy tool output before it reaches the agent.

## Token Optimization Rules

**Always pipe shell commands through the token filter:**

```bash
node ~/.config/token-optimizer/filter.js <command> [args...]
```

### Required: Use the filter for these command families

| Command type          | Example                                                           |
| --------------------- | ----------------------------------------------------------------- |
| Git operations        | `node ~/.config/token-optimizer/filter.js git status`             |
| Git diff              | `node ~/.config/token-optimizer/filter.js git diff`               |
| Git log               | `node ~/.config/token-optimizer/filter.js git log -n 10`          |
| Tests (npm/yarn/pnpm) | `node ~/.config/token-optimizer/filter.js npm test`               |
| Tests (cargo)         | `node ~/.config/token-optimizer/filter.js cargo test`             |
| Tests (pytest)        | `node ~/.config/token-optimizer/filter.js pytest`                 |
| Tests (go)            | `node ~/.config/token-optimizer/filter.js go test ./...`          |
| Linting (eslint)      | `node ~/.config/token-optimizer/filter.js eslint src/`            |
| Linting (tsc)         | `node ~/.config/token-optimizer/filter.js tsc --noEmit`           |
| Linting (ruff)        | `node ~/.config/token-optimizer/filter.js ruff check .`           |
| Directory listing     | `node ~/.config/token-optimizer/filter.js ls -la`                 |
| File search           | `node ~/.config/token-optimizer/filter.js find . -name "*.ts"`    |
| Content search        | `node ~/.config/token-optimizer/filter.js grep -r "pattern" src/` |
| Docker                | `node ~/.config/token-optimizer/filter.js docker ps`              |
| Kubectl               | `node ~/.config/token-optimizer/filter.js kubectl get pods`       |

### Safety guarantees

- The filter **preserves exit codes** — commands that fail still fail
- On any filter error, raw output is printed unchanged (fail-safe)
- Errors and failure details are **always** preserved in the filtered output
- Only verbose noise (progress bars, passing tests, boilerplate) is stripped

### Fallback for commands not listed above

For any command not listed, still use the filter — it applies generic deduplication:

```bash
node ~/.config/token-optimizer/filter.js <any-command> [args...]
```

---

## Stats

View cumulative token savings:

```bash
node ~/.config/token-optimizer/filter.js stats
```

---

_This file is managed by token-optimizer. Do not edit the section between the markers._

<!-- token-optimizer start -->

## Token Optimization (token-optimizer)

Always route shell commands through the token filter:

```bash
node ~/.config/token-optimizer/filter.js <command> [args...]
```

Applies to git, tests, builds, package managers, search/listing commands, Docker/Kubernetes, and any other shell command. The filter preserves exit codes and falls back to raw output on errors. Request raw/full/verbose output when exact logs are required.

Keep agent replies concise:

- Do not narrate tool choice, MCP usage, or step-by-step thinking.
- Progress updates should be one short sentence only when useful.
- Final replies should include only the result, changed files, and verification.
- Prefer terse bullets over paragraphs; avoid restating the user's request.

<!-- token-optimizer end -->
AGENTEOF
}

# Update AGENTS.md file (preserves existing content)
update_agents_md() {
    local file="$1"
    
    # Check if token-optimizer section already exists
    if grep -q "<!-- token-optimizer start -->" "$file" 2>/dev/null; then
        # Remove old token-optimizer section
        sed -i.tmp '/<!-- token-optimizer start -->/,/<!-- token-optimizer end -->/d' "$file"
        rm -f "${file}.tmp"
    fi
    
    # Append new token-optimizer section
    cat >> "$file" << 'AGENTEOF'

<!-- token-optimizer start -->

## Token Optimization (token-optimizer)

Always route shell commands through the token filter:

```bash
node ~/.config/token-optimizer/filter.js <command> [args...]
```

Applies to git, tests, builds, package managers, search/listing commands, Docker/Kubernetes, and any other shell command. The filter preserves exit codes and falls back to raw output on errors. Request raw/full/verbose output when exact logs are required.

Keep agent replies concise:

- Do not narrate tool choice, MCP usage, or step-by-step thinking.
- Progress updates should be one short sentence only when useful.
- Final replies should include only the result, changed files, and verification.
- Prefer terse bullets over paragraphs; avoid restating the user's request.

<!-- token-optimizer end -->
AGENTEOF
}


# Handle reset-stats
if [ "$RESET_STATS" = true ]; then
    info "Resetting token statistics..."
    
    STATS_FILE="$CONFIG_DIR/stats.json"
    LEGACY_STATS="$CONFIG_DIR/.token-optimizer-stats.json"
    
    if [ -f "$STATS_FILE" ]; then
        rm -f "$STATS_FILE"
        success "Stats reset successfully"
    else
        success "No stats file found (already clean)"
    fi
    
    if [ -f "$LEGACY_STATS" ]; then
        rm -f "$LEGACY_STATS"
        success "Legacy stats cleaned"
    fi
    
    exit 0
fi

# Handle uninstall
if [ "$UNINSTALL" = true ]; then
    info "Uninstalling token-optimizer..."
    
    if [ -d "$CONFIG_DIR" ]; then
        rm -rf "$CONFIG_DIR"
        success "Removed $CONFIG_DIR"
    else
        warn "Token-optimizer not installed at $CONFIG_DIR"
    fi
    if [ -f "$BIN_DIR/token-optimizer" ]; then
        rm -f "$BIN_DIR/token-optimizer"
        success "Removed $BIN_DIR/token-optimizer"
    fi
    
    success "Token-optimizer uninstalled"
    exit 0
fi

# Check Node.js
if ! command -v node &>/dev/null; then
    error "Node.js is required but not found.\nInstall Node.js from https://nodejs.org, then re-run this installer."
fi

NODE_VERSION=$(node --version 2>&1 | tr -d 'v')
success "Node.js $NODE_VERSION detected"

# Install
echo ""
echo "token-optimizer installer"
echo "  target: $CONFIG_DIR"
echo ""

# Create config directory
mkdir -p "$CONFIG_DIR"
mkdir -p "$BIN_DIR"

# Download filter.js
FILTER_URL="${TO_DOWNLOAD_URL}/scripts/filter.js"
FILTER_DEST="$CONFIG_DIR/filter.js"

info "Downloading filter.js..."
if command -v curl &>/dev/null; then
    curl -fsSL -o "$FILTER_DEST" "$FILTER_URL"
elif command -v wget &>/dev/null; then
    wget -q -O "$FILTER_DEST" "$FILTER_URL"
else
    error "curl or wget required"
fi
success "Downloaded filter.js"

# Verify installation
info "Verifying installation..."
if node "$FILTER_DEST" --version &>/dev/null; then
    success "filter.js verified successfully"
else
    warn "Could not verify filter.js (non-fatal)"
fi

TOKEN_OPTIMIZER_BIN="$BIN_DIR/token-optimizer"
cat > "$TOKEN_OPTIMIZER_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${TOKEN_OPTIMIZER_HOME:-$HOME/.config/token-optimizer}"
FILTER="$CONFIG_DIR/filter.js"

status() {
    echo "token-optimizer - status"
    echo "Filter path: $FILTER"
    if [ -f "$FILTER" ]; then
        echo "Filter exists: yes"
        echo
        node "$FILTER" stats
    else
        echo "Filter exists: no"
        echo "Run the installer again to restore filter.js."
        exit 1
    fi
}

case "${1:-status}" in
    status) status ;;
    stats) node "$FILTER" stats ;;
    reset-stats) node "$FILTER" reset-stats ;;
    run|filter) shift; node "$FILTER" "$@" ;;
    install|update)
        echo "The shell installer already installed the local command filter."
        echo "For MCP agent config, run: npm install -g token-optimizer && token-optimizer install"
        ;;
    *) node "$FILTER" "$@" ;;
esac
EOF
chmod +x "$TOKEN_OPTIMIZER_BIN"
success "Installed command: $TOKEN_OPTIMIZER_BIN"
if ! command -v token-optimizer >/dev/null 2>&1; then
    warn "$BIN_DIR is not on PATH for this shell."
    warn "Add this to your shell rc file: export PATH=\"$BIN_DIR:\$PATH\""
fi

# Configure agents
if [ "$SKIP_CONFIG" = true ]; then
    echo ""
    warn "Skipping agent configuration (--skip-config)"
else
    echo ""
    info "Detecting coding agents..."
    
    AGENTS_DETECTED=()
    
    # Check for OpenCode
    OPENCODE_DIR="$HOME/.config/opencode"
    if [ -d "$OPENCODE_DIR" ]; then
        AGENTS_DETECTED+=("OpenCode")
        success "OpenCode detected at $OPENCODE_DIR"
        
        # Create/update AGENTS.md
        OPENCODE_AGENTS="$OPENCODE_DIR/AGENTS.md"
        if [ ! -f "$OPENCODE_AGENTS" ]; then
            info "Creating AGENTS.md for OpenCode..."
            create_agents_md "$OPENCODE_AGENTS"
            success "Created $OPENCODE_AGENTS"
        else
            info "Updating AGENTS.md for OpenCode..."
            update_agents_md "$OPENCODE_AGENTS"
            success "Updated $OPENCODE_AGENTS"
        fi
    fi
    
    # Check for Cursor
    CURSOR_DIR="$HOME/.cursor"
    if [ -d "$CURSOR_DIR" ]; then
        AGENTS_DETECTED+=("Cursor")
        success "Cursor detected at $CURSOR_DIR"
    fi
    
    # Check for Windsurf
    WINDSURF_DIR="$HOME/.windsurf"
    if [ -d "$WINDSURF_DIR" ]; then
        AGENTS_DETECTED+=("Windsurf")
        success "Windsurf detected at $WINDSURF_DIR"
    fi
    
    # Check for Claude Desktop
    CLAUDE_DIR="$HOME/Library/Application Support/Claude"
    if [ -d "$CLAUDE_DIR" ]; then
        AGENTS_DETECTED+=("Claude Desktop")
        success "Claude Desktop detected at $CLAUDE_DIR"
    fi
    
    echo ""
    if [ ${#AGENTS_DETECTED[@]} -gt 0 ]; then
        echo "Detected agents: ${AGENTS_DETECTED[*]}"
    else
        warn "No AI agents detected. Supported agents:"
        echo "  - OpenCode, Cursor, Claude Desktop, Windsurf"
    fi
fi

# Success
echo ""
success "Installation complete!"
echo ""
echo "Usage:"
echo "  token-optimizer                  # status"
echo "  token-optimizer stats            # token totals"
echo "  token-optimizer run <command>     # filter one command"
echo "  node ~/.config/token-optimizer/filter.js <command>"
echo ""
echo "Commands:"
echo "  stats        View token savings"
echo "  reset-stats  Clear statistics"
echo ""

} # end main()

main "$@"
