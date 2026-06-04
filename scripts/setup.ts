#!/usr/bin/env node
/**
 * token-optimizer setup script
 *
 * Usage:
 *   token-optimizer install   — auto-detect agents and wire MCP config
 *   token-optimizer uninstall — remove injected configs
 *   token-optimizer status    — show install status and token totals
 *   token-optimizer update    — pull latest changes and reinstall
 *   token-optimizer           — same as "install"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";

const HOME = os.homedir();
const PKG_NAME = "token-optimizer";
const SERVER_ENTRY = "dist/src/mcp-server.js";

// ── Resolve the absolute path to the installed package's server entry ─────────

function resolveServerPath(): string {
  // When run via npx, __dirname is inside the package. Walk up to find package root.
  const here = new URL(import.meta.url).pathname;
  // here = .../token-optimizer/dist/scripts/setup.js  (after build)
  // or .../token-optimizer/scripts/setup.ts (ts-node / development)
  const pkgRoot = path.resolve(path.dirname(here), "..", "..");
  const candidate = path.join(pkgRoot, SERVER_ENTRY);
  if (fs.existsSync(candidate)) return candidate;

  // Fallback: try resolving from global node_modules
  try {
    const resolved = execSync(`node -e "console.log(require.resolve('token-optimizer/mcp-server'))"`, {
      encoding: "utf8",
    }).trim();
    if (resolved) return resolved;
  } catch {
    // ignore
  }

  // Last resort: return the relative path and hope the cwd is the package root
  return path.resolve(process.cwd(), SERVER_ENTRY);
}

// ── Agent config locators ─────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  configPath: string;
  type: "opencode-json" | "mcp-json" | "agents-md";
  exists: boolean;
}

function detectAgents(): AgentConfig[] {
  const candidates: AgentConfig[] = [
    {
      name: "OpenCode",
      configPath: path.join(HOME, ".config", "opencode", "opencode.json"),
      type: "opencode-json",
      exists: false,
    },
    {
      name: "Cursor",
      configPath: path.join(HOME, ".cursor", "mcp.json"),
      type: "mcp-json",
      exists: false,
    },
    {
      name: "Claude Desktop (macOS)",
      configPath: path.join(
        HOME,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
      type: "mcp-json",
      exists: false,
    },
    {
      name: "Claude Desktop (Linux)",
      configPath: path.join(HOME, ".config", "claude", "claude_desktop_config.json"),
      type: "mcp-json",
      exists: false,
    },
    {
      name: "Windsurf",
      configPath: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
      type: "mcp-json",
      exists: false,
    },
    {
      name: "Codex (global AGENTS.md)",
      configPath: path.join(HOME, ".codex", "AGENTS.md"),
      type: "agents-md",
      exists: false,
    },
  ];

  for (const c of candidates) {
    c.exists = fs.existsSync(c.configPath);
  }

  return candidates;
}

// ── Patchers ──────────────────────────────────────────────────────────────────

const MCP_ENTRY = (serverPath: string) => ({
  command: "node",
  args: [serverPath],
});

function patchOpenCodeJson(configPath: string, serverPath: string, remove: boolean): boolean {
  let raw = "{}";
  if (fs.existsSync(configPath)) raw = fs.readFileSync(configPath, "utf8");

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`  ✗ Could not parse ${configPath}`);
    return false;
  }

  if (!cfg.mcp || typeof cfg.mcp !== "object") {
    cfg.mcp = {};
  }
  const mcp = cfg.mcp as Record<string, unknown>;
  if (!mcp.servers || typeof mcp.servers !== "object") {
    mcp.servers = {};
  }
  const servers = mcp.servers as Record<string, unknown>;

  if (remove) {
    delete servers[PKG_NAME];
  } else {
    servers[PKG_NAME] = MCP_ENTRY(serverPath);
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

function patchMcpJson(configPath: string, serverPath: string, remove: boolean): boolean {
  let raw = "{}";
  if (fs.existsSync(configPath)) raw = fs.readFileSync(configPath, "utf8");

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`  ✗ Could not parse ${configPath}`);
    return false;
  }

  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") {
    cfg.mcpServers = {};
  }
  const servers = cfg.mcpServers as Record<string, unknown>;

  if (remove) {
    delete servers[PKG_NAME];
  } else {
    servers[PKG_NAME] = MCP_ENTRY(serverPath);
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

const MARKER_START = "<!-- token-optimizer start -->";
const MARKER_END = "<!-- token-optimizer end -->";
const LEGACY_MARKER_START = "<!-- opencode-" + "token-" + "saver start -->";
const LEGACY_MARKER_END = "<!-- opencode-" + "token-" + "saver end -->";

function agentsMdBlock(serverPath: string): string {
  const filterPath = path.join(path.dirname(serverPath), "..", "scripts", "filter.js");
  return `${MARKER_START}

## Token Optimization (token-optimizer)

Always route shell commands through the token filter:

\`\`\`bash
node ${filterPath} <command> [args...]
\`\`\`

Applies to git, tests, builds, package managers, search/listing commands, Docker/Kubernetes, and any other shell command. The filter preserves exit codes and falls back to raw output on errors. Request raw/full/verbose output when exact logs are required.

Keep agent replies concise:
- Do not narrate tool choice, MCP usage, or step-by-step thinking.
- Progress updates should be one short sentence only when useful.
- Final replies should include only the result, changed files, and verification.
- Prefer terse bullets over paragraphs; avoid restating the user's request.

${MARKER_END}`;
}

function removeManagedAgentsBlocks(content: string): string {
  for (const [markerStart, markerEnd] of [
    [MARKER_START, MARKER_END],
    [LEGACY_MARKER_START, LEGACY_MARKER_END],
  ]) {
    const start = markerStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const end = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    content = content.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g"), "");
  }
  return content.trimEnd();
}

function patchAgentsMd(configPath: string, serverPath: string, remove: boolean): boolean {
  let content = "";
  if (fs.existsSync(configPath)) content = fs.readFileSync(configPath, "utf8");

  content = removeManagedAgentsBlocks(content);

  if (!remove) {
    content = content.trimEnd() + "\n\n" + agentsMdBlock(serverPath) + "\n";
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content);
  return true;
}

function patchAgent(agent: AgentConfig, serverPath: string, remove: boolean): void {
  let ok = false;
  switch (agent.type) {
    case "opencode-json":
      ok = patchOpenCodeJson(agent.configPath, serverPath, remove);
      break;
    case "mcp-json":
      ok = patchMcpJson(agent.configPath, serverPath, remove);
      break;
    case "agents-md":
      ok = patchAgentsMd(agent.configPath, serverPath, remove);
      break;
  }
  const verb = remove ? "Removed from" : "Patched";
  const icon = ok ? "✓" : "✗";
  console.log(`  ${icon} ${verb} ${agent.name}: ${agent.configPath}`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

interface StatsFile {
  commandCount?: number;
  totalOriginalTokens?: number;
  totalFilteredTokens?: number;
  lastUpdated?: string;
  [key: string]: unknown;
}

function readStats(): { statsPath: string; stats?: StatsFile } {
  const statsPath = path.join(HOME, ".config", "token-optimizer", "stats.json");
  const legacyStatsPath = path.join(HOME, ".config", "token-" + "saver", "stats.json");
  const existingStatsPath = fs.existsSync(statsPath) ? statsPath : legacyStatsPath;

  if (!fs.existsSync(existingStatsPath)) {
    return { statsPath };
  }

  try {
    return {
      statsPath: existingStatsPath,
      stats: JSON.parse(fs.readFileSync(existingStatsPath, "utf-8")) as StatsFile,
    };
  } catch {
    console.error(`Could not parse stats file at ${existingStatsPath}`);
    process.exit(1);
  }
}

function printStatsSummary(stats: StatsFile): void {
  const orig = stats.totalOriginalTokens ?? 0;
  const filt = stats.totalFilteredTokens ?? 0;
  const saved = orig - filt;
  const pct = orig === 0 ? 0 : Math.round((saved / orig) * 100);
  const count = stats.commandCount ?? 0;
  const updated = stats.lastUpdated ?? "unknown";

  console.log(`Total optimisations: ${count.toLocaleString()}`);
  console.log(`Original tokens    : ${orig.toLocaleString()}`);
  console.log(`Filtered tokens    : ${filt.toLocaleString()}`);
  console.log(`Saved tokens       : ${saved.toLocaleString()} (${pct}%)`);
  console.log(`Last updated       : ${updated}`);
}

function cmdStats(): void {
  const { statsPath, stats } = readStats();

  if (!stats) {
    console.log("No stats yet — run some commands first.");
    console.log(`(Expected stats file: ${statsPath})`);
    return;
  }

  console.log("");
  console.log("=== token-optimizer stats ===");
  printStatsSummary(stats);
  console.log("");
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdInstall(): void {
  console.log("\ntoken-optimizer — one-click install\n");

  const serverPath = resolveServerPath();
  console.log(`Server path: ${serverPath}\n`);

  if (!fs.existsSync(serverPath)) {
    console.error(
      `ERROR: Server binary not found at ${serverPath}\n` +
        `Run \`npm run build\` in the package directory first, or install via npm:\n` +
        `  npm install -g token-optimizer`
    );
    process.exit(1);
  }

  const agents = detectAgents();
  const found = agents.filter((a) => a.exists || a.type === "opencode-json");

  if (found.length === 0) {
    console.log("No supported agent configs found. Nothing to patch.");
    return;
  }

  console.log("Detected agents:");
  for (const a of agents) {
    const status = a.exists ? "found" : "not found";
    console.log(`  ${a.exists ? "●" : "○"} ${a.name} (${status})`);
  }

  console.log("\nPatching configs...");
  for (const a of agents) {
    // Only patch if config exists OR it's OpenCode (create if missing)
    if (a.exists || a.name === "OpenCode") {
      patchAgent(a, serverPath, false);
    }
  }

  console.log(`
Done! token-optimizer MCP server is now registered.

Restart your AI agent apps to apply the changes.

The MCP server will start automatically when your agent connects.
Server entry: ${serverPath}

To verify: run \`token-optimizer status\`
To remove:  run \`token-optimizer uninstall\`
`);
}

function runUpdateStep(command: string, args: string[], cwd: string): void {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error(`\nUpdate failed: ${result.error.message}`);
    process.exit(1);
  }

  if ((result.status ?? 0) !== 0) {
    console.error(`\nUpdate failed while running: ${[command, ...args].join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

function cmdUpdate(): void {
  console.log("\ntoken-optimizer — update\n");

  const root = packageRoot();
  if (fs.existsSync(path.join(root, ".git"))) {
    console.log(`Updating git checkout: ${root}`);
    runUpdateStep("git", ["pull", "--ff-only"], root);
    runUpdateStep("npm", ["install"], root);
    runUpdateStep("npm", ["run", "build"], root);
    runUpdateStep("npm", ["install", "-g", "."], root);
  } else {
    console.log("No git checkout found for this install. Updating from npm instead.");
    runUpdateStep("npm", ["install", "-g", "token-optimizer@latest"], root);
  }

  console.log("\nDone. token-optimizer is updated.");
}

function cmdUninstall(): void {
  console.log("\ntoken-optimizer — uninstall\n");
  const serverPath = resolveServerPath();
  const agents = detectAgents();

  console.log("Removing from agent configs...");
  for (const a of agents) {
    if (a.exists) {
      patchAgent(a, serverPath, true);
    }
  }
  console.log("\nDone! Restart your agent apps to apply the changes.");
}

function cmdStatus(): void {
  console.log("\ntoken-optimizer — status\n");
  const serverPath = resolveServerPath();
  console.log(`Server path: ${serverPath}`);
  console.log(`Server exists: ${fs.existsSync(serverPath) ? "YES ✓" : "NO ✗"}\n`);

  const agents = detectAgents();
  console.log("Agent configs:");
  for (const a of agents) {
    if (!a.exists) {
      console.log(`  ○ ${a.name}: not found`);
      continue;
    }
    let hasEntry = false;
    try {
      const content = fs.readFileSync(a.configPath, "utf8");
      hasEntry =
        content.includes(PKG_NAME) ||
        content.includes(MARKER_START) ||
        content.includes(LEGACY_MARKER_START);
    } catch {
      // ignore
    }
    console.log(`  ${hasEntry ? "✓" : "○"} ${a.name}: ${hasEntry ? "installed" : "config exists but not patched"}`);
  }

  const { statsPath, stats } = readStats();
  console.log("\nOptimization totals:");
  if (stats) {
    printStatsSummary(stats);
  } else {
    console.log("No stats yet — run some commands first.");
    console.log(`(Expected stats file: ${statsPath})`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const arg = process.argv[2] ?? "install";

switch (arg) {
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case "status":
    cmdStatus();
    break;
  case "update":
    cmdUpdate();
    break;
  case "stats":
    cmdStats();
    break;
  default:
    console.log(`token-optimizer v0.1.0

Usage:
  token-optimizer install    Auto-detect agents and wire MCP config
  token-optimizer uninstall  Remove injected configs
  token-optimizer status     Show install status and token totals
  token-optimizer update     Pull latest changes and reinstall
  token-optimizer stats      Show token savings stats
`);
}
