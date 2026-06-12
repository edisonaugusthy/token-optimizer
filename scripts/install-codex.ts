#!/usr/bin/env node
/**
 * install-codex — Sets up token-optimizer for Codex
 *
 * What this does:
 *   1. Copies the compiled filter.js to ~/.config/token-optimizer/
 *   2. Detects or creates AGENTS.md in the current project directory
 *   3. Appends the token-optimizer hook instructions if not already present
 *
 * Usage:
 *   node dist/scripts/install-codex.js [--global] [--project-dir <path>]
 *
 * Flags:
 *   --global          Install filter binary globally (default: ~/.config/token-optimizer/)
 *   --project-dir     Target project directory (default: cwd)
 *   --agents-md       Path to AGENTS.md (default: <project-dir>/AGENTS.md)
 *   --dry-run         Print what would be done without making changes
 *   --uninstall       Remove token-optimizer sections from AGENTS.md
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Helpers ──────────────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32"

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface InstallArgs {
  global: boolean
  projectDir: string
  agentsMdPath: string
  dryRun: boolean
  uninstall: boolean
  filterSrcDir: string
}

function parseArgs(): InstallArgs {
  const argv = process.argv.slice(2)
  const args: InstallArgs = {
    global: false,
    projectDir: process.cwd(),
    agentsMdPath: "",
    dryRun: false,
    uninstall: false,
    filterSrcDir: path.join(__dirname, ".."),
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--global":        args.global = true; break
      case "--dry-run":       args.dryRun = true; break
      case "--uninstall":     args.uninstall = true; break
      case "--project-dir":   args.projectDir = argv[++i]; break
      case "--agents-md":     args.agentsMdPath = argv[++i]; break
    }
  }

  if (!args.agentsMdPath) {
    args.agentsMdPath = path.join(args.projectDir, "AGENTS.md")
  }

  return args
}

// ─── Filter installation ──────────────────────────────────────────────────────

const INSTALL_DIR = normalizePath(path.join(os.homedir(), ".config", "token-optimizer"))
const FILTER_DEST = normalizePath(path.join(INSTALL_DIR, "filter.js"))

function installFilter(args: InstallArgs): void {
  // Try multiple source locations (local dev, global install, npx cache)
  const candidates = [
    // Local dev: dist/scripts/filter.js relative to package root
    normalizePath(path.join(args.filterSrcDir, "dist", "scripts", "filter.js")),
    // Global install: scripts/filter.js
    normalizePath(path.join(args.filterSrcDir, "scripts", "filter.js")),
    // Fallback: current directory
    normalizePath(path.join(process.cwd(), "dist", "scripts", "filter.js")),
  ]

  const filterSrc = candidates.find((c) => fs.existsSync(c))
  if (!filterSrc) {
    console.error(`[token-optimizer] ERROR: filter.js not found`)
    console.error(`  Searched: ${candidates.join(", ")}`)
    console.error(`  Run 'npm run build' first to compile the TypeScript source.`)
    process.exit(1)
  }

  if (args.dryRun) {
    console.log(`[dry-run] Would install filter.js to: ${FILTER_DEST}`)
    console.log(`  Source: ${filterSrc}`)
    return
  }

  fs.mkdirSync(INSTALL_DIR, { recursive: true })
  fs.copyFileSync(filterSrc, FILTER_DEST)

  // Create package.json with type:module to avoid NODE warning
  const pkgJsonPath = path.join(INSTALL_DIR, "package.json")
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ type: "module" }, null, 2) + "\n")
  }

  // Also copy the filters directory (dependency of filter.js)
  const filtersSrc = normalizePath(path.join(args.filterSrcDir, "dist", "src", "filters"))
  const filtersDest = normalizePath(path.join(INSTALL_DIR, "src", "filters"))
  if (fs.existsSync(filtersSrc)) {
    fs.mkdirSync(filtersDest, { recursive: true })
    for (const file of fs.readdirSync(filtersSrc)) {
      fs.copyFileSync(path.join(filtersSrc, file), path.join(filtersDest, file))
    }
  }

  console.log(`[token-optimizer] Installed filter → ${FILTER_DEST}`)
}

// ─── AGENTS.md injection ──────────────────────────────────────────────────────

const MARKER_START = "<!-- token-optimizer start -->"
const MARKER_END   = "<!-- token-optimizer end -->"
const LEGACY_MARKER_START = "<!-- opencode-" + "token-" + "saver start -->"
const LEGACY_MARKER_END   = "<!-- opencode-" + "token-" + "saver end -->"

function buildAgentsMdBlock(filterPath: string): string {
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

${MARKER_END}`
}

function removeManagedBlocks(content: string): string {
  for (const [markerStart, markerEnd] of [
    [MARKER_START, MARKER_END],
    [LEGACY_MARKER_START, LEGACY_MARKER_END],
  ]) {
    const start = markerStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const end = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    content = content.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g"), "")
  }
  return content.trimEnd()
}

function injectAgentsMd(args: InstallArgs): void {
  const block = buildAgentsMdBlock(FILTER_DEST)
  const agentsMdPath = normalizePath(args.agentsMdPath)

  // Only patch if file already exists (don't create from scratch)
  if (!fs.existsSync(agentsMdPath)) {
    console.log(`[token-optimizer] ${agentsMdPath} not found — skipping (install agent first)`)
    return
  }

  let existing = fs.readFileSync(agentsMdPath, "utf-8")
  existing = removeManagedBlocks(existing)

  const updated = existing.trimEnd() + "\n\n" + block + "\n"

  if (args.dryRun) {
    console.log(`[dry-run] Would write to: ${agentsMdPath}`)
    console.log("--- injected block ---")
    console.log(block)
    console.log("---")
    return
  }

  fs.writeFileSync(agentsMdPath, updated)
  console.log(`[token-optimizer] Injected hook instructions → ${agentsMdPath}`)
}

function removeAgentsMd(args: InstallArgs): void {
  const agentsMdPath = normalizePath(args.agentsMdPath)
  if (!fs.existsSync(agentsMdPath)) {
    console.log("[token-optimizer] AGENTS.md not found — nothing to remove")
    return
  }

  let content = fs.readFileSync(agentsMdPath, "utf-8")
  if (!content.includes(MARKER_START)) {
    console.log("[token-optimizer] No token-optimizer block found in AGENTS.md")
    return
  }

  content = removeManagedBlocks(content) + "\n"

  if (args.dryRun) {
    console.log(`[dry-run] Would remove token-optimizer block from ${agentsMdPath}`)
    return
  }

  fs.writeFileSync(agentsMdPath, content)
  console.log(`[token-optimizer] Removed token-optimizer block from ${agentsMdPath}`)
}

// ─── Stats command ────────────────────────────────────────────────────────────

function showStats(): void {
  const statsPath = normalizePath(path.join(INSTALL_DIR, "stats.json"))
  const legacyStatsPath = normalizePath(path.join(os.homedir(), ".config", "token-" + "saver", "stats.json"))
  const existingStatsPath = fs.existsSync(statsPath) ? statsPath : legacyStatsPath
  if (!fs.existsSync(existingStatsPath)) {
    console.log("[token-optimizer] No stats yet — run some commands first")
    return
  }

  const stats = JSON.parse(fs.readFileSync(existingStatsPath, "utf-8"))
  const saved = stats.totalOriginalTokens - stats.totalFilteredTokens
  const pct = stats.totalOriginalTokens === 0 ? 0 :
    Math.round((saved / stats.totalOriginalTokens) * 100)

  console.log("=== token-optimizer stats ===")
  console.log(`Commands filtered : ${stats.commandCount}`)
  console.log(`Original tokens   : ${stats.totalOriginalTokens.toLocaleString()}`)
  console.log(`Filtered tokens   : ${stats.totalFilteredTokens.toLocaleString()}`)
  console.log(`Saved tokens      : ${saved.toLocaleString()} (${pct}%)`)
  console.log(`Last updated      : ${stats.lastUpdated}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/** Patch an AGENTS.md at the given absolute path (install or uninstall). */
function patchAgentsMd(agentsMdPath: string, args: InstallArgs, remove: boolean): void {
  const patchArgs = { ...args, agentsMdPath }
  if (remove) removeAgentsMd(patchArgs)
  else injectAgentsMd(patchArgs)
}

function main(): void {
  const args = parseArgs()

  if (process.argv.includes("stats")) {
    showStats()
    return
  }

  if (args.uninstall) {
    removeAgentsMd(args)
    // Also remove from global Codex AGENTS.md if it exists
    const globalCodexAgents = normalizePath(path.join(os.homedir(), ".codex", "AGENTS.md"))
    if (fs.existsSync(globalCodexAgents)) {
      patchAgentsMd(globalCodexAgents, args, true)
    }
    return
  }

  console.log("=== token-optimizer: Codex installation ===")
  installFilter(args)

  // 1. Patch project-local AGENTS.md (or --agents-md if specified)
  injectAgentsMd(args)

  // 2. Always also patch ~/.codex/AGENTS.md (global Codex instructions)
  const globalCodexAgents = normalizePath(path.join(os.homedir(), ".codex", "AGENTS.md"))
  if (globalCodexAgents !== normalizePath(args.agentsMdPath)) {
    patchAgentsMd(globalCodexAgents, args, false)
  }

  console.log("")
  console.log("Done! Codex will now route shell commands through the token filter.")
  console.log(`Filter installed at:         ${FILTER_DEST}`)
  console.log(`Project AGENTS.md updated:   ${args.agentsMdPath}`)
  console.log(`Global  AGENTS.md updated:   ${globalCodexAgents}`)
  console.log("")
  console.log("Debug mode: OC_FILTER_DEBUG=1 node filter.js <cmd>")
}

main()
