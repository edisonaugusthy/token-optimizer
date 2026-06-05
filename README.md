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

## Install

**Recommended — global install (stable path across npx cache evictions):**

```bash
npm install -g token-optimizer
token-optimizer install
```

**Or via npx (no prior install needed):**

```bash
npx token-optimizer install
```

**Or via curl (macOS / Linux):**

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
```

All options detect installed agents and patch their configs automatically.

Supported agents and platforms:

| Agent                  | macOS / Linux                         | Windows                                     |
| ---------------------- | ------------------------------------- | ------------------------------------------- |
| OpenCode               | MCP server + `plugin` array entry     | MCP server + `plugin` array entry           |
| Cursor                 | MCP server (`~/.cursor/mcp.json`)     | MCP server (`%APPDATA%\Cursor\mcp.json`)    |
| Claude Desktop         | MCP server (Application Support)      | MCP server (`%APPDATA%\Claude\...`)         |
| Windsurf               | MCP server (`~/.codeium/windsurf/...`)| MCP server (`%APPDATA%\Codeium\windsurf\...`)|
| Codex                  | `AGENTS.md` shell-filter instructions | `AGENTS.md` shell-filter instructions       |

> **Why global install?** When run via `npx`, the resolved package path points to
> the volatile npx cache (`~/.npm/_npx/...` on macOS/Linux, `%LOCALAPPDATA%\npm-cache\npx\...`
> on Windows). A global install (`npm install -g`) writes a stable path that survives
> cache evictions and npm upgrades.

## Commands

```bash
npx token-optimizer status     # Install status and token totals
npx token-optimizer stats      # Token savings summary
npx token-optimizer update     # Pull latest version and reinstall
npx token-optimizer uninstall  # Remove injected configs
```

## Development

```bash
git clone https://github.com/edisonaugusthy/token-optimizer
cd token-optimizer
npm install
npm run build
node dist/scripts/setup.js install
```

Useful scripts:

| Command         | Description          |
| --------------- | -------------------- |
| `npm run build` | Compile TypeScript   |
| `npm start`     | Start the MCP server |

## License

MIT
