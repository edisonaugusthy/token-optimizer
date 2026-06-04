# token-optimizer

> **60–75% token reduction** for AI coding agents — one command to install, works everywhere.

[![npm](https://img.shields.io/npm/v/token-optimizer)](https://www.npmjs.com/package/token-optimizer)
[![license](https://img.shields.io/npm/l/token-optimizer)](./LICENSE)

## What it does

AI agents burn enormous context on verbose output: passing test lines, progress bars, binary diffs, duplicate stack traces, web page nav boilerplate, and XML wrappers from sub-agent results. `token-optimizer` intercepts all of that and compresses it before it hits your context window — without changing any agent behavior.

It stacks **three complementary techniques**:

1. **Tool schema compression** — Slims built-in tool descriptions sent on every API call (~15–25% savings per request, multiplicative).
2. **Line-range edit expansion** — Lets the model write `oldString` as `"55-64"` instead of pasting the full lines. Saves output tokens on every edit.
3. **Tool output compression** — Compresses bash/shell output, file reads, web fetches, and sub-agent task results.

| Output type | Typical savings |
|---|---|
| `npm test` / `cargo test` / `pytest` | 70–85% |
| `git diff` (large) | 50–70% |
| `eslint` / `tsc` / `ruff` | 60–75% |
| `ls` / `find` / `grep` | 40–60% |
| Web page fetches | 65–75% |
| Sub-agent task results | 70–80% |

## Quick install

```bash
npx token-optimizer install
```

That's it. The installer:
1. Detects which AI agents are installed (OpenCode, Cursor, Claude Desktop, Windsurf, Codex)
2. Patches each agent's MCP / config file to register the `token-optimizer` MCP server
3. Reports exactly what was changed

Restart your agent apps and token savings begin immediately.

### One-line curl install

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/token-optimizer/main/install.sh | bash
```

Options:

| Flag | Effect |
|---|---|
| `--skip-config` | Install the npm package but don't patch agent configs |
| `--global` | Install globally via `npm -g` instead of `npx` |

## Supported agents

| Agent | Config patched | Integration type |
|---|---|---|
| **OpenCode** | `~/.config/opencode/opencode.json` | MCP server + plugin hooks (`tool.definition`, `tool.execute.before`, `tool.execute.after`) |
| **Cursor** | `~/.cursor/mcp.json` | MCP server |
| **Claude Desktop (macOS)** | `~/Library/Application Support/Claude/claude_desktop_config.json` | MCP server |
| **Claude Desktop (Linux)** | `~/.config/claude/claude_desktop_config.json` | MCP server |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | MCP server |
| **Codex** | `~/.codex/AGENTS.md` | CLI filter injected into agent instructions |

## MCP server

The core is a lightweight stdio MCP server exposing one tool:

### `filter_output`

Compress verbose command or file output.

```json
{
  "name": "filter_output",
  "arguments": {
    "output": "<raw stdout/stderr>",
    "type": "bash",
    "command": "npm test"
  }
}
```

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `output` | string | yes | Raw command or file output to compress |
| `type` | `"bash"` \| `"read"` \| `"edit"` | no | Kind of output (`bash` is the default) |
| `command` | string | no | The command that produced the output — enables command-specific filters |

Returns the compressed output. The server is stateless and starts in milliseconds.

## CLI filter (Codex / shell)

For agents that don't support MCP, use the CLI filter:

```bash
node ~/.config/token-saver/filter.js <command> [args...]

# Examples
node ~/.config/token-saver/filter.js git status
node ~/.config/token-saver/filter.js git diff
node ~/.config/token-saver/filter.js npm test
node ~/.config/token-saver/filter.js grep -r "pattern" src/
node ~/.config/token-saver/filter.js eslint src/
node ~/.config/token-saver/filter.js kubectl get pods
```

The filter preserves exit codes and falls back to raw output on any error.

## What gets compressed

**Shell output (`bash` filter)**
- Passing test lines (Jest, Cargo, pytest, Go test)
- Progress bars and spinner lines
- Binary file diffs
- Duplicate adjacent lines
- npm/yarn install boilerplate
- Docker layer pull lines
- kubectl event noise

**File content (`read` filter)**
- Generated file headers
- Long comment blocks (collapsed)
- Repeated blank lines
- Auto-generated type declaration noise

**Web pages (`webfetch` filter)**
- Nav / footer / cookie banner boilerplate
- Hard cap at 6 000 chars (≈1 500 tokens) per fetch

**Sub-agent results (`task` filter)**
- XML wrapper stripped
- Cap at 4 000 chars (≈1 000 tokens) per result

## Commands

```bash
npx token-optimizer install    # Auto-detect agents and wire MCP config
npx token-optimizer uninstall  # Remove injected configs
npx token-optimizer status     # Show what is installed
```

## Manual setup (OpenCode)

If you prefer to wire things manually, add this to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "token-optimizer": {
        "command": "node",
        "args": ["/path/to/token-optimizer/dist/src/mcp-server.js"]
      }
    }
  }
}
```

## Manual setup (Cursor / Claude Desktop / Windsurf)

Add to `~/.cursor/mcp.json`, `claude_desktop_config.json`, or `~/.codeium/windsurf/mcp_config.json`:

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

## Development

```bash
git clone https://github.com/YOUR_ORG/token-optimizer
cd token-optimizer
npm install
npm run build
npx token-optimizer install
```

| Script | Effect |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode |
| `npm run clean` | Remove `dist/` |
| `npm start` | Start MCP server directly |

## Project structure

```
src/
  plugin.ts        OpenCode plugin (schema compression + output hooks)
  mcp-server.ts    Stdio MCP server exposing filter_output tool
  schema-slim.ts   Tool description slimmer + line-range edit expander
  filters/         Per-output-type filter implementations
scripts/
  filter.ts        CLI filter for Codex / shell usage
  setup.ts         npx install/uninstall/status CLI
  install-codex.ts Codex-specific AGENTS.md patcher
```

## License

MIT
