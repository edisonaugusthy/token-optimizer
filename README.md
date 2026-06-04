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

Choose one:

**A. npm / npx**

```bash
npx token-optimizer install
```

**B. curl**

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
```

Both options detect supported agents and patch their config automatically.

Supported agents:

| Agent          | Integration                           |
| -------------- | ------------------------------------- |
| OpenCode       | MCP server plus plugin hooks          |
| Cursor         | MCP server                            |
| Claude Desktop | MCP server                            |
| Windsurf       | MCP server                            |
| Codex          | `AGENTS.md` shell-filter instructions |

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
