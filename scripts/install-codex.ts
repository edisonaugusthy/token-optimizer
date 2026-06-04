#!/usr/bin/env node
/**
 * install-codex — Sets up token-saver for Codex
 *
 * What this does:
 *   1. Copies the compiled filter.js to ~/.config/token-saver/
 *   2. Detects or creates AGENTS.md in the current project directory
 *   3. Appends the token-saver hook instructions if not already present
 *
 * Usage:
 *   node dist/scripts/install-codex.js [--global] [--project-dir <path>]
 *
 * Flags:
 *   --global          Install filter binary globally (default: ~/.config/token-saver/)
 *   --project-dir     Target project directory (default: cwd)
 *   --agents-md       Path to AGENTS.md (default: <project-dir>/AGENTS.md)
 *   --dry-run         Print what would be done without making changes
 *   --uninstall       Remove token-saver sections from AGENTS.md
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

const INSTALL_DIR = path.join(os.homedir(), ".config", "token-saver")
const FILTER_DEST = path.join(INSTALL_DIR, "filter.js")

function installFilter(args: InstallArgs): void {
  const filterSrc = path.join(args.filterSrcDir, "dist", "scripts", "filter.js")

  if (!fs.existsSync(filterSrc)) {
    // Try the local scripts directory (when running from source)
    const altSrc = path.join(args.filterSrcDir, "scripts", "filter.js")
    if (!fs.existsSync(altSrc)) {
      console.error(`[token-saver] ERROR: filter.js not found at ${filterSrc}`)
      console.error(`  Run 'npm run build' first to compile the TypeScript source.`)
      process.exit(1)
    }
  }

  if (args.dryRun) {
    console.log(`[dry-run] Would install filter.js to: ${FILTER_DEST}`)
    return
  }

  fs.mkdirSync(INSTALL_DIR, { recursive: true })

  const src = fs.existsSync(path.join(args.filterSrcDir, "dist", "scripts", "filter.js"))
    ? path.join(args.filterSrcDir, "dist", "scripts", "filter.js")
    : path.join(args.filterSrcDir, "scripts", "filter.js")

  fs.copyFileSync(src, FILTER_DEST)

  // Also copy the filters directory (dependency of filter.js)
  const filtersSrc = path.join(args.filterSrcDir, "dist", "src", "filters")
  const filtersDest = path.join(INSTALL_DIR, "src", "filters")
  if (fs.existsSync(filtersSrc)) {
    fs.mkdirSync(filtersDest, { recursive: true })
    for (const file of fs.readdirSync(filtersSrc)) {
      fs.copyFileSync(path.join(filtersSrc, file), path.join(filtersDest, file))
    }
  }

  console.log(`[token-saver] Installed filter → ${FILTER_DEST}`)
}

// ─── AGENTS.md injection ──────────────────────────────────────────────────────

const MARKER_START = "<!-- opencode-token-saver start -->"
const MARKER_END   = "<!-- opencode-token-saver end -->"

function buildAgentsMdBlock(filterPath: string): string {
  return `${MARKER_START}

## Token Optimization (opencode-token-saver)

Always route shell commands through the token filter:

\`\`\`bash
node ${filterPath} <command> [args...]
\`\`\`

Applies to git, tests, builds, package managers, search/listing commands, Docker/Kubernetes, and any other shell command. The filter preserves exit codes and falls back to raw output on errors. Request raw/full/verbose output when exact logs are required.

${MARKER_END}`
}

function removeManagedBlocks(content: string): string {
  const managedBlock = new RegExp(`${MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g")
  return content.replace(managedBlock, "").trimEnd()
}

function injectAgentsMd(args: InstallArgs): void {
  const block = buildAgentsMdBlock(FILTER_DEST)
  const agentsMdPath = args.agentsMdPath

  let existing = ""
  if (fs.existsSync(agentsMdPath)) {
    existing = fs.readFileSync(agentsMdPath, "utf-8")
  }

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
  console.log(`[token-saver] Injected hook instructions → ${agentsMdPath}`)
}

function removeAgentsMd(args: InstallArgs): void {
  const agentsMdPath = args.agentsMdPath
  if (!fs.existsSync(agentsMdPath)) {
    console.log("[token-saver] AGENTS.md not found — nothing to remove")
    return
  }

  let content = fs.readFileSync(agentsMdPath, "utf-8")
  if (!content.includes(MARKER_START)) {
    console.log("[token-saver] No token-saver block found in AGENTS.md")
    return
  }

  content = removeManagedBlocks(content) + "\n"

  if (args.dryRun) {
    console.log(`[dry-run] Would remove token-saver block from ${agentsMdPath}`)
    return
  }

  fs.writeFileSync(agentsMdPath, content)
  console.log(`[token-saver] Removed token-saver block from ${agentsMdPath}`)
}

// ─── Stats command ────────────────────────────────────────────────────────────

function showStats(): void {
  const statsPath = path.join(INSTALL_DIR, "stats.json")
  if (!fs.existsSync(statsPath)) {
    console.log("[token-saver] No stats yet — run some commands first")
    return
  }

  const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"))
  const saved = stats.totalOriginalTokens - stats.totalFilteredTokens
  const pct = stats.totalOriginalTokens === 0 ? 0 :
    Math.round((saved / stats.totalOriginalTokens) * 100)

  console.log("=== opencode-token-saver stats ===")
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
    const globalCodexAgents = path.join(os.homedir(), ".codex", "AGENTS.md")
    if (fs.existsSync(globalCodexAgents)) {
      patchAgentsMd(globalCodexAgents, args, true)
    }
    return
  }

  console.log("=== opencode-token-saver: Codex installation ===")
  installFilter(args)

  // 1. Patch project-local AGENTS.md (or --agents-md if specified)
  injectAgentsMd(args)

  // 2. Always also patch ~/.codex/AGENTS.md (global Codex instructions)
  const globalCodexAgents = path.join(os.homedir(), ".codex", "AGENTS.md")
  if (globalCodexAgents !== args.agentsMdPath) {
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
