#!/usr/bin/env node
/**
 * token-optimizer setup script
 *
 * Usage:
 *   token-optimizer           — show install status and token totals
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
const IS_WINDOWS = process.platform === "win32";
const PKG_NAME = "token-optimizer";
const SERVER_ENTRY = "dist/src/mcp-server.js";

// ── Normalize path to forward slashes (for cross-platform comparison) ──────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ── Resolve the absolute path to the installed package's server entry ─────────
// Priority:
//   1. Local project (cwd or parent has dist/src/mcp-server.js) — dev mode
//   2. Global npm install — stable path
//   3. npx cache — fallback

function resolveServerPath(): string {
  const here = normalizePath(new URL(import.meta.url).pathname);
  const pkgRoot = path.resolve(path.dirname(here), "..", "..");
  const pkgRootNorm = normalizePath(pkgRoot);

  // 1. Local project: check if we're inside the token-optimizer repo
  //    Look for package.json with matching name in current dir or parents
  let searchDir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(searchDir, SERVER_ENTRY);
    if (fs.existsSync(candidate)) {
      const pkgJson = path.join(searchDir, "package.json");
      if (fs.existsSync(pkgJson)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
          if (pkg.name === PKG_NAME) return normalizePath(candidate);
        } catch { /* ignore */ }
      }
    }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  // 2. Check if the script itself is in a local (non-npx-cache) package
  const isNpxCache =
    pkgRootNorm.includes("/_npx/") ||
    pkgRootNorm.includes(".npm/_npx") ||
    pkgRootNorm.toLowerCase().includes("\\npm\\npx\\") ||
    pkgRootNorm.toLowerCase().includes("/npm/npx/");

  if (!isNpxCache) {
    const candidate = path.join(pkgRoot, SERVER_ENTRY);
    if (fs.existsSync(candidate)) return normalizePath(candidate);
  }

  // 3. Global npm install
  const globalPrefixes: string[] = [];
  try {
    const npmPrefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
    if (npmPrefix) globalPrefixes.push(normalizePath(npmPrefix));
  } catch { /* ignore */ }

  if (IS_WINDOWS) {
    const APPDATA = normalizePath(process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"));
    const LOCALAPPDATA = normalizePath(process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"));
    globalPrefixes.push(`${APPDATA}/npm`, `${LOCALAPPDATA}/npm`);
    for (const prefix of globalPrefixes) {
      const candidate = `${prefix}/node_modules/${PKG_NAME}/${SERVER_ENTRY}`;
      if (fs.existsSync(candidate)) return candidate;
    }
  } else {
    globalPrefixes.push(`${HOME}/.npm-global`, "/usr/local", "/usr");
    for (const prefix of globalPrefixes) {
      const candidate = `${prefix}/lib/node_modules/${PKG_NAME}/${SERVER_ENTRY}`;
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 4. Fallback: resolve via node require
  try {
    const resolved = execSync(
      `node -e "console.log(require.resolve('token-optimizer/mcp-server'))"`,
      { encoding: "utf8", shell: IS_WINDOWS } as any,
    ).trim();
    if (resolved) return normalizePath(resolved);
  } catch { /* ignore */ }

  // 5. Last resort
  return normalizePath(path.resolve(process.cwd(), SERVER_ENTRY));
}

// ── Agent config locators ─────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  configPath: string;
  type: "opencode-json" | "mcp-json" | "agents-md";
  exists: boolean;
}

function detectAgents(): AgentConfig[] {
  const APPDATA = normalizePath(process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"));
  const LOCALAPPDATA = normalizePath(process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"));

  const candidates: AgentConfig[] = [
    // ── OpenCode ──────────────────────────────────────────────────────────────
    {
      name: "OpenCode",
      configPath: IS_WINDOWS
        ? `${APPDATA}/opencode/opencode.json`
        : `${HOME}/.config/opencode/opencode.json`,
      type: "opencode-json",
      exists: false,
    },
    // ── Cursor ────────────────────────────────────────────────────────────────
    {
      name: "Cursor",
      configPath: IS_WINDOWS
        ? `${APPDATA}/Cursor/mcp.json`
        : `${HOME}/.cursor/mcp.json`,
      type: "mcp-json",
      exists: false,
    },
    // ── Claude Desktop ────────────────────────────────────────────────────────
    {
      name: "Claude Desktop (macOS)",
      configPath: `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`,
      type: "mcp-json",
      exists: false,
    },
    {
      name: "Claude Desktop (Linux)",
      configPath: `${HOME}/.config/claude/claude_desktop_config.json`,
      type: "mcp-json",
      exists: false,
    },
    {
      name: "Claude Desktop (Windows)",
      configPath: `${APPDATA}/Claude/claude_desktop_config.json`,
      type: "mcp-json",
      exists: false,
    },
    // ── Windsurf ──────────────────────────────────────────────────────────────
    {
      name: "Windsurf",
      configPath: IS_WINDOWS
        ? `${APPDATA}/Codeium/windsurf/mcp_config.json`
        : `${HOME}/.codeium/windsurf/mcp_config.json`,
      type: "mcp-json",
      exists: false,
    },
    // ── Codex ─────────────────────────────────────────────────────────────────
    {
      name: "Codex (global AGENTS.md)",
      configPath: `${HOME}/.codex/AGENTS.md`,
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

// OpenCode MCP entry format (matches opencode.json schema)
const OPENCODE_MCP_ENTRY = (serverPath: string) => ({
  enabled: true,
  type: "local",
  command: ["node", serverPath],
});

// Other agents (Cursor, Claude Desktop, Windsurf) use the flat { command, args } shape
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

  // ── MCP server entry ────────────────────────────────────────────────────────
  if (!cfg.mcp || typeof cfg.mcp !== "object") {
    cfg.mcp = {};
  }
  const mcp = cfg.mcp as Record<string, unknown>;

  // Clean up stale mcp.servers entries written by older versions
  if (mcp.servers && typeof mcp.servers === "object") {
    const servers = mcp.servers as Record<string, unknown>;
    delete servers[PKG_NAME];
    if (Object.keys(servers).length === 0) delete mcp.servers;
  }

  if (remove) {
    delete mcp[PKG_NAME];
  } else {
    mcp[PKG_NAME] = OPENCODE_MCP_ENTRY(serverPath);
  }

  // ── Plugin entry ─────────────────────────────────────────────────────────────
  if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
  const plugins = (cfg.plugin as string[]).filter(
    (p) => p !== PKG_NAME && !p.includes(path.join(PKG_NAME, "dist"))
  );
  if (remove) {
    cfg.plugin = plugins;
    if (plugins.length === 0) delete cfg.plugin;
  } else {
    cfg.plugin = [...plugins, PKG_NAME];
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
  const statsPath = normalizePath(path.join(HOME, ".config", "token-optimizer", "stats.json"));
  const legacyStatsPath = normalizePath(path.join(HOME, ".config", "token-" + "saver", "stats.json"));
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
  console.log("\ntoken-optimizer — install\n");

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

  console.log("Detected agents:");
  for (const a of agents) {
    const status = a.exists ? "found" : "not found";
    console.log(`  ${a.exists ? "●" : "○"} ${a.name} (${status})`);
  }

  // Only patch configs that already exist (don't create from scratch)
  let patched = 0;
  console.log("\nPatching configs...");
  for (const a of agents) {
    if (a.exists) {
      patchAgent(a, serverPath, false);
      patched++;
    }
  }

  if (patched === 0) {
    console.log("\nNo agent config files found. Nothing to patch.");
    console.log("Install an agent first, then re-run: token-optimizer install");
    return;
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
    shell: IS_WINDOWS,
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
  const here = normalizePath(new URL(import.meta.url).pathname);
  return path.resolve(path.dirname(here), "..", "..");
}

function cmdUpdate(): void {
  console.log("\ntoken-optimizer — update\n");

  // Check for newer version available
  try {
    const latest = execSync("npm view token-optimizer version", { encoding: "utf8" }).trim();
    const pkgJsonPath = path.join(packageRoot(), "package.json");
    const current = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
    if (latest === current) {
      console.log(`Already up to date (v${current}).`);
    } else {
      console.log(`New version available: v${current} → v${latest}`);
    }
  } catch { /* ignore */ }

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

const arg = process.argv[2] ?? "status";

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
    console.log(`token-optimizer v0.2.1

Usage:
  token-optimizer            Show install status and token totals
  token-optimizer status     Show install status and token totals
  token-optimizer install    Auto-detect agents and wire MCP config
  token-optimizer update     Pull latest changes and reinstall
  token-optimizer uninstall  Remove injected configs
  token-optimizer stats      Show token savings stats

Global command:
  npm install -g token-optimizer
  npx token-optimizer status

If the global command is not found, add your npm global bin directory to PATH.
`);
}
