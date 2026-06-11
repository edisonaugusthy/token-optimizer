# token-optimizer

> **60–75% token reduction** for AI coding agents — one command to install, works everywhere.

[![npm](https://img.shields.io/npm/v/token-optimizer)](https://www.npmjs.com/package/token-optimizer)
[![license](https://img.shields.io/npm/l/token-optimizer)](./LICENSE)

## What it does

`token-optimizer` keeps useful information and removes low-value output from agent workflows:

- Compresses shell output from git, tests, builds, package managers, grep, Docker, and Kubernetes.
- Compacts file reads, web fetches, grep/glob results, and sub-agent task results.
- Omits gitignored files from glob, grep, and directory-read outputs.
- Encourages concise agent replies to reduce response-token overhead.
- Preserves exit codes and falls back to raw output on errors.

Typical savings:

| Workflow                                  | Without optimizer |     With optimizer | Typical saving |
| ----------------------------------------- | ----------------: | -----------------: | -------------: |
| `git status` / `git diff` checks          |      1,000 tokens |     150-300 tokens |         70-85% |
| Test/build logs                           |      4,000 tokens |   800-1,500 tokens |         60-80% |
| File search / grep / glob                 |      2,000 tokens |     400-900 tokens |         55-80% |
| Long file or web reads                    |      8,000 tokens | 2,000-4,000 tokens |         50-75% |
| Basic coding task with several tool calls |     12,000 tokens | 4,000-6,000 tokens |         50-65% |

## Quick Start

**One-line install (macOS / Linux / WSL):**

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
```

**Reset stats:**

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash -s -- --reset-stats
```

**Windows (PowerShell):**

```powershell
# One-line install (PowerShell 7+)
irm https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.ps1 | iex

# Or download and run manually
Invoke-WebRequest -Uri https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.ps1 -OutFile install.ps1
.\install.ps1
```

The installer automatically detects installed AI agents (OpenCode, Cursor, Windsurf, Claude Desktop) and configures them for token optimization.

| Agent          | macOS / Linux                         | Windows                                     |
| -------------- | ------------------------------------- | ------------------------------------------- |
| OpenCode       | MCP server + `plugin` array entry     | MCP server + `plugin` array entry           |
| Cursor         | MCP server (`~/.cursor/mcp.json`)     | MCP server (`%APPDATA%\Cursor\mcp.json`)    |
| Claude Desktop | MCP server (Application Support)      | MCP server (`%APPDATA%\Claude\...`)         |
| Windsurf       | MCP server (`~/.codeium/windsurf/...`)| MCP server (`%APPDATA%\Codeium\windsurf\...`)|
| Codex          | `AGENTS.md` shell-filter instructions | `AGENTS.md` shell-filter instructions       |

### AGENTS.md Configuration

The installer automatically creates or updates `AGENTS.md` for detected agents:

| Agent          | AGENTS.md Location (macOS/Linux)                 | AGENTS.md Location (Windows)                          |
| -------------- | ------------------------------------------------ | ----------------------------------------------------- |
| OpenCode       | `~/.config/opencode/AGENTS.md`                   | `%APPDATA%\opencode\AGENTS.md`                        |
| Cursor         | `~/.cursor/AGENTS.md`                            | `%APPDATA%\Cursor\AGENTS.md`                          |
| Windsurf       | `~/.windsurf/AGENTS.md`                          | `%APPDATA%\Codeium\windsurf\AGENTS.md`                |
| Claude Desktop | `~/Library/Application Support/Claude/AGENTS.md` | `%APPDATA%\Claude\AGENTS.md`                          |

If `AGENTS.md` doesn't exist, the installer creates it with token-optimizer configuration. If it exists, the installer adds/updates the token-optimizer section (marked with `<!-- token-optimizer start/end -->` comments).

## Usage

After installation, use the filter for shell commands:

```bash
# Git operations
node ~/.config/token-optimizer/filter.js git status
node ~/.config/token-optimizer/filter.js git diff

# Tests
node ~/.config/token-optimizer/filter.js npm test
node ~/.config/token-optimizer/filter.js pytest

# Search/listing
node ~/.config/token-optimizer/filter.js ls -la
node ~/.config/token-optimizer/filter.js find . -name "*.ts"
```

**Stats:**

```bash
node ~/.config/token-optimizer/filter.js stats        # View savings
node ~/.config/token-optimizer/filter.js reset-stats  # Clear stats
```

**Uninstall:**

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash -s -- --uninstall
```

## Development

```bash
git clone https://github.com/edisonaugusthy/token-optimizer
cd token-optimizer
npm install
npm run build
bash install.sh
```

Useful scripts:

| Command         | Description          |
| --------------- | -------------------- |
| `npm run build` | Compile TypeScript   |
| `npm start`     | Start the MCP server |

## License

MIT
