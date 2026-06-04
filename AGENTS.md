# opencode-token-saver — Codex Agent Instructions

This project uses a token filter to reduce LLM context usage by 60-75%.

## Token Optimization Rules

**Always pipe shell commands through the token filter:**

```bash
node ~/.config/token-saver/filter.js <command> [args...]
```

### Required: Use the filter for these command families

| Command type          | Example                                                       |
| --------------------- | ------------------------------------------------------------- |
| Git operations        | `node ~/.config/token-saver/filter.js git status`             |
| Git diff              | `node ~/.config/token-saver/filter.js git diff`               |
| Git log               | `node ~/.config/token-saver/filter.js git log -n 10`          |
| Tests (npm/yarn/pnpm) | `node ~/.config/token-saver/filter.js npm test`               |
| Tests (cargo)         | `node ~/.config/token-saver/filter.js cargo test`             |
| Tests (pytest)        | `node ~/.config/token-saver/filter.js pytest`                 |
| Tests (go)            | `node ~/.config/token-saver/filter.js go test ./...`          |
| Linting (eslint)      | `node ~/.config/token-saver/filter.js eslint src/`            |
| Linting (tsc)         | `node ~/.config/token-saver/filter.js tsc --noEmit`           |
| Linting (ruff)        | `node ~/.config/token-saver/filter.js ruff check .`           |
| Directory listing     | `node ~/.config/token-saver/filter.js ls -la`                 |
| File search           | `node ~/.config/token-saver/filter.js find . -name "*.ts"`    |
| Content search        | `node ~/.config/token-saver/filter.js grep -r "pattern" src/` |
| Docker                | `node ~/.config/token-saver/filter.js docker ps`              |
| Kubectl               | `node ~/.config/token-saver/filter.js kubectl get pods`       |

### Safety guarantees

- The filter **preserves exit codes** — commands that fail still fail
- On any filter error, raw output is printed unchanged (fail-safe)
- Errors and failure details are **always** preserved in the filtered output
- Only verbose noise (progress bars, passing tests, boilerplate) is stripped

### Fallback for commands not listed above

For any command not listed, still use the filter — it applies generic deduplication:

```bash
node ~/.config/token-saver/filter.js <any-command> [args...]
```

---

## Setup

If the filter is not installed, run:

```bash
cd /path/to/opencode-token-saver
npm run build
node dist/scripts/install-codex.js
```

Or use the npm package:

```bash
npx opencode-token-saver --install-codex
```

---

## Stats

View cumulative token savings:

```bash
npx token-optimizer stats
```

---

_This file is managed by token-optimizer. Do not edit the section between the markers._

<!-- opencode-token-saver start -->

## Token Optimization (token-optimizer)

To minimize token usage, pipe all shell commands through the token filter:

```
node ~/.config/token-saver/filter.js <command> [args...]
```

**Examples:**

```bash
node ~/.config/token-saver/filter.js git status
node ~/.config/token-saver/filter.js git diff
node ~/.config/token-saver/filter.js npm test
node ~/.config/token-saver/filter.js cargo test
node ~/.config/token-saver/filter.js ls -la
node ~/.config/token-saver/filter.js grep -r "pattern" src/
node ~/.config/token-saver/filter.js pytest
node ~/.config/token-saver/filter.js docker ps
```

**Rules:**

- Always use the filter prefix for shell commands
- The filter preserves exit codes — no behavior change
- On any error, the filter falls back to raw output safely
- Do NOT pipe git, test, or build commands directly

<!-- opencode-token-saver end -->
