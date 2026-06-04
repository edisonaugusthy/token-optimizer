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

| Workflow | Without optimizer | With optimizer | Typical saving |
| --- | ---: | ---: | ---: |
| `git status` / `git diff` checks | 1,000 tokens | 150-300 tokens | 70-85% |
| Test/build logs | 4,000 tokens | 800-1,500 tokens | 60-80% |
| File search / grep / glob | 2,000 tokens | 400-900 tokens | 55-80% |
| Long file or web reads | 8,000 tokens | 2,000-4,000 tokens | 50-75% |
| Basic coding task with several tool calls | 12,000 tokens | 4,000-6,000 tokens | 50-65% |

## Install

```bash
npx token-optimizer install
```

This detects supported agents and patches their config automatically.

Supported agents:

| Agent          | Integration                           |
| -------------- | ------------------------------------- |
| OpenCode       | MCP server plus plugin hooks          |
| Cursor         | MCP server                            |
| Claude Desktop | MCP server                            |
| Windsurf       | MCP server                            |
| Codex          | `AGENTS.md` shell-filter instructions |

One-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
```

## Commands

```bash
token-optimizer status     # Install status and token totals
token-optimizer stats      # Token savings summary
token-optimizer update     # Pull latest version and reinstall
token-optimizer uninstall  # Remove injected configs
```

Use `npx token-optimizer install` for first install. After install, use `token-optimizer ...`.

## CLI filter

For shell-based agents or manual use:

```bash
node ~/.config/token-optimizer/filter.js <command> [args...]
```

Examples:

```bash
node ~/.config/token-optimizer/filter.js git status
node ~/.config/token-optimizer/filter.js git diff
node ~/.config/token-optimizer/filter.js npm test
node ~/.config/token-optimizer/filter.js rg "pattern" src/
```

## MCP tool

The MCP server exposes one tool:

```json
{
  "name": "filter_output",
  "arguments": {
    "output": "raw tool output",
    "type": "bash",
    "command": "npm test"
  }
}
```

Supported `type` values:

| Type   | Use                                             |
| ------ | ----------------------------------------------- |
| `bash` | Shell, git, test, build, package-manager output |
| `read` | File and directory read output                  |
| `edit` | Edit/write confirmations                        |

## Manual MCP setup

Add this to any MCP-compatible agent config:

```json
{
  "mcpServers": {
    "token-optimizer": {
      "command": "node",
      "args": ["/path/to/token-optimizer/dist/src/mcp-server.js"]
    }
  }
}
```

For OpenCode:

```json
{
  "mcp": {
    "token-optimizer": {
      "type": "local",
      "command": ["node", "/path/to/token-optimizer/dist/src/mcp-server.js"],
      "enabled": true
    }
  }
}
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
