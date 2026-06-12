# token-optimizer

Reduce token waste from coding-agent tool output.

`token-optimizer` filters noisy command output before it is sent back into an AI coding agent. It keeps errors, failures, changed files, paths, summaries, and other useful details, while removing repeated progress output, boilerplate, wrappers, and duplicated history.

It is useful for Codex, OpenCode, Cursor, Claude Desktop, and other coding-agent setups that read terminal or MCP tool output.

## Install

### npm global install

```bash
npm install -g token-optimizer
token-optimizer install
token-optimizer status
```

This exposes the `token-optimizer` command through npm's global bin directory. If your shell cannot find it, add your npm global bin directory to `PATH`.

You can also run it without a global install:

```bash
npx token-optimizer status
npx token-optimizer install
```

### One-line shell install

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.ps1 | iex
```

The shell installers place the filter in `~/.config/token-optimizer` and create a `token-optimizer` command shim:

```bash
token-optimizer
token-optimizer stats
token-optimizer run git status --short
```

On macOS/Linux the shim is installed to `~/.local/bin/token-optimizer`. If that directory is not on `PATH`, add this to your shell rc file:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Commands

```bash
token-optimizer            # show install status and token totals
token-optimizer status     # same as above
token-optimizer install    # detect agents and wire MCP config
token-optimizer update     # update package and refresh configs
token-optimizer uninstall  # remove managed config blocks
token-optimizer stats      # show token savings totals
```

Standalone filter commands:

```bash
to-filter git status --short
to-filter npm test
to-filter stats
```

Shell-installer shim:

```bash
token-optimizer run npm test
token-optimizer run rg "TODO" src
```

## What It Filters

`token-optimizer` focuses on output that coding agents commonly send back into context:

- Git status, diffs, logs, commits, pulls, pushes, and fetches.
- Test output from npm, pnpm, yarn, bun, deno, pytest, cargo, go, rspec, Playwright, Gradle, Maven, .NET, PHP, and more.
- Build and lint output from TypeScript, ESLint, Ruff, Go, Cargo, Make, CMake, Ninja, Vite, Next, Turbo, Nx, Docker, Kubernetes, Helm, and Terraform.
- Search and listing output from `rg`, `grep`, `find`, `tree`, and directory reads.
- MCP and browser/tool output where repeated metadata or duplicate lines are common.

The filter preserves exit codes. If filtering fails, raw output is returned.

## How It Saves Tokens

Savings come from output the tool actually changes:

- Removing repeated progress bars and spinner lines.
- Grouping long file lists into smaller summaries.
- Keeping failure details while dropping passing-test noise.
- Removing duplicated browser console/network lines.
- Cleaning repeated MCP metadata and schema descriptions.
- Trimming old duplicate tool outputs from agent history while keeping the newest full copy.

It does not rely on current-output caps or response-token caps.

## Manual Agent Rule

If you want to route shell commands manually, add this to your agent instructions:

~~~markdown
Always route shell commands through the token filter:

```bash
node ~/.config/token-optimizer/filter.js <command> [args...]
```

Request raw/full/verbose output when exact logs are required.
~~~

## Local Development

```bash
npm install
npm run build
npm test
```

Useful local commands:

```bash
node dist/scripts/setup.js status
node dist/scripts/setup.js install
node dist/scripts/filter.js git status --short
node dist/scripts/filter.js stats
```

## Uninstall

```bash
token-optimizer uninstall
```

For shell-installer installs:

```bash
curl -fsSL https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.sh | bash -s -- --uninstall
```

Windows:

```powershell
irm https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.ps1 | iex -Uninstall
```

## License

MIT
