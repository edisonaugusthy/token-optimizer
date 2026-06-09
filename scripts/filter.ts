#!/usr/bin/env node
/**
 * oc-filter — Standalone self-contained CLI token filter for Codex and other agents.
 *
 * This script is designed to be installed standalone at ~/.config/token-optimizer/filter.js
 * and has NO external imports — all filter logic is inlined.
 *
 * Usage:
 *   node ~/.config/token-optimizer/filter.js <command> [args...]
 *   node ~/.config/token-optimizer/filter.js git status
 *   node ~/.config/token-optimizer/filter.js npm test
 *   node ~/.config/token-optimizer/filter.js stats
 *
 * How it works:
 *   1. Spawns the given command via child_process
 *   2. Captures stdout + stderr
 *   3. Applies command-specific compression filters
 *   4. Prints compressed output to stdout
 *   5. Exits with the original command's exit code
 *
 * The filter preserves exit codes, so CI/CD scripts work correctly.
 * On filter failure, raw output is printed (fail-safe).
 */

import { spawnSync } from "child_process"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"

// ═══════════════════════════════════════════════════════════════════
// INLINED FILTER LIBRARY (copy of src/filters/bash.ts logic)
// Self-contained so this file can run from any location
// ═══════════════════════════════════════════════════════════════════

interface FilterResult {
  output: string
  savedPct: number
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function savings(original: string, filtered: string): FilterResult {
  const before = estimateTokens(original)
  const after = estimateTokens(filtered)
  const pct = before === 0 ? 0 : Math.round(((before - after) / before) * 100)
  return { output: filtered, savedPct: Math.max(0, pct) }
}

function splitLines(text: string): string[] {
  return text.split("\n")
}

function deduplicateLines(text: string, maxRepeats = 1): string {
  const result: string[] = []
  let prev = ""
  let count = 0
  for (const line of splitLines(text)) {
    if (line === prev) {
      count++
    } else {
      if (prev !== "" && count > maxRepeats) {
        result.push(`${prev} (×${count})`)
      } else if (prev !== "") {
        for (let i = 1; i < count; i++) result.push(prev)
      }
      prev = line
      count = 1
    }
  }
  if (prev !== "" && count > maxRepeats) {
    result.push(`${prev} (×${count})`)
  } else if (prev !== "") {
    for (let i = 0; i < count; i++) result.push(prev)
  }
  return result.join("\n").trim()
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "")
}

function truncate(text: string, maxLines: number): string {
  const ls = splitLines(text)
  if (ls.length <= maxLines) return text
  const kept = ls.slice(0, maxLines)
  kept.push(`... (${ls.length - maxLines} more lines omitted)`)
  return kept.join("\n")
}

const IMPORTANT_LINE_RE =
  /\b(error|failed|failure|fatal|panic|exception|traceback|warning|warn|denied|forbidden|unauthorized|timeout|timed out|not found|cannot|can't|conflict|rejected|invalid|vulnerabilit|deprecated|npm ERR!|npm error|ERR!)\b/i

function uniquePush(target: string[], seen: Set<string>, line: string): void {
  if (!line || seen.has(line)) return
  target.push(line)
  seen.add(line)
}

function truncateImportant(text: string, maxLines: number): string {
  const ls = splitLines(text)
  if (ls.length <= maxLines) return text

  const kept: string[] = []
  const seen = new Set<string>()
  const important = ls.filter(line => IMPORTANT_LINE_RE.test(line)).slice(0, Math.max(4, Math.floor(maxLines * 0.35)))

  for (const line of ls.slice(0, Math.ceil(maxLines * 0.4))) uniquePush(kept, seen, line)
  for (const line of important) uniquePush(kept, seen, line)
  for (const line of ls.slice(-Math.ceil(maxLines * 0.25))) uniquePush(kept, seen, line)

  const compact = kept.slice(0, maxLines - 1)
  compact.push(`... (${ls.length - compact.length} lines omitted; kept head/tail/errors)`)
  return compact.join("\n")
}

// ── Git ──────────────────────────────────────────────────────────────────────

function filterGitStatus(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean || clean.includes("nothing to commit")) {
    return savings(raw, "nothing to commit, working tree clean")
  }

  const staged: string[] = []
  const unstaged: string[] = []
  let untracked = 0

  for (const line of splitLines(clean)) {
    const modifiedMatch = line.match(/^\s+modified:\s+(.+)$/)
    if (modifiedMatch) { unstaged.push(modifiedMatch[1].trim()); continue }
    const newFileMatch = line.match(/^\s+new file:\s+(.+)$/)
    if (newFileMatch) { staged.push(`A:${newFileMatch[1].trim()}`); continue }
    const deletedMatch = line.match(/^\s+deleted:\s+(.+)$/)
    if (deletedMatch) { unstaged.push(`D:${deletedMatch[1].trim()}`); continue }
    const renamedMatch = line.match(/^\s+renamed:\s+(.+)$/)
    if (renamedMatch) { staged.push(`R:${renamedMatch[1].trim()}`); continue }
    const porcelain = line.match(/^([MADRCU?!]{1})([MADRCU?! ]{1})\s+(.+)$/)
    if (porcelain) {
      const [, x, y, file] = porcelain
      if (x !== " " && x !== "?") staged.push(`${x}:${file.trim()}`)
      if (y !== " " && y !== "?") unstaged.push(`${y}:${file.trim()}`)
      if (x === "?" && y === "?") untracked++
    }
  }

  if (untracked === 0) {
    const idx = clean.indexOf("Untracked files:")
    if (idx !== -1) {
      untracked = splitLines(clean.slice(idx)).filter(l => l.startsWith("\t")).length
    }
  }

  const branch = clean.match(/On branch (\S+)/)?.[1] || ""
  const parts: string[] = []
  if (branch) parts.push(`branch:${branch}`)
  if (staged.length)   parts.push(`staged:[${staged.join(",")}]`)
  if (unstaged.length) parts.push(`modified:[${unstaged.join(",")}]`)
  if (untracked > 0)   parts.push(`untracked:${untracked}`)

  if (!staged.length && !unstaged.length && !untracked) {
    const summary = splitLines(clean)
      .filter(l => l.includes("modified:") || l.includes("new file:") ||
                   l.includes("deleted:") || l.includes("renamed:") ||
                   l.startsWith("On branch") || l.includes("to commit"))
      .slice(0, 10).join("\n")
    return savings(raw, summary || clean.slice(0, 200))
  }

  return savings(raw, parts.join(" | "))
}

function filterGitDiff(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no diff)")

  const result: string[] = []
  let fileHeader = ""
  let adds = 0, dels = 0

  for (const line of splitLines(clean)) {
    if (line.startsWith("diff --git")) {
      if (fileHeader && (adds || dels)) result.push(`${fileHeader} +${adds}/-${dels}`)
      fileHeader = line.replace("diff --git ", "").replace(/^a\/\S+ b\//, "")
      adds = 0; dels = 0
    } else if (line.startsWith("@@")) {
      result.push(line.replace(/@@[^@]+@@/, "@@").trim())
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      adds++; result.push(line)
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      dels++; result.push(line)
    }
  }
  if (fileHeader && (adds || dels)) result.push(`${fileHeader} +${adds}/-${dels}`)
  return savings(raw, truncate(result.join("\n"), 120))
}

function filterGitLog(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const result: string[] = []
  for (const line of splitLines(clean)) {
    const onelineMatch = line.match(/^([0-9a-f]{7,40})\s+(.+)$/)
    const commitMatch = line.match(/^commit ([0-9a-f]{40})/)
    const subjectMatch = line.match(/^\s{4}(.+)$/)
    if (onelineMatch) {
      result.push(`${onelineMatch[1].slice(0, 7)} ${onelineMatch[2]}`)
    } else if (commitMatch) {
      result.push(commitMatch[1].slice(0, 7))
    } else if (subjectMatch && result.length > 0) {
      const last = result[result.length - 1]
      if (/^[0-9a-f]{7}$/.test(last)) result[result.length - 1] = `${last} ${subjectMatch[1]}`
    }
  }
  return savings(raw, result.join("\n") || clean)
}

function filterGitWriteOp(raw: string, cmd: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (cmd === "commit") {
    const m = clean.match(/\[[\w/]+\s+([0-9a-f]{7})\]/) || clean.match(/([0-9a-f]{7,40})/)
    const hash = m ? m[1].slice(0, 7) : ""
    const filesMatch = clean.match(/(\d+) file/)
    const insertMatch = clean.match(/(\d+) insertion/)
    const deleteMatch = clean.match(/(\d+) deletion/)
    const parts = ["ok"]
    if (hash) parts.push(hash)
    if (filesMatch) parts.push(`${filesMatch[1]}f`)
    if (insertMatch) parts.push(`+${insertMatch[1]}`)
    if (deleteMatch) parts.push(`-${deleteMatch[1]}`)
    return savings(raw, parts.join(" "))
  }
  if (cmd === "push") {
    if (/error|rejected|denied/i.test(clean)) {
      const errorLine = splitLines(clean).find(l => /error|rejected|denied/i.test(l)) || ""
      return savings(raw, `FAILED: ${errorLine.trim()}`)
    }
    const branchMatch = clean.match(/\b([\w/.-]+)\s*->\s*([\w/.-]+)/) ||
                        clean.match(/refs\/heads\/([\w/.-]+)/)
    const branch = branchMatch ? branchMatch[1] : "origin"
    return savings(raw, `ok ${branch}`)
  }
  if (cmd === "add")  return savings(raw, "ok")
  if (cmd === "pull") {
    const filesMatch = clean.match(/(\d+) file/)
    const parts = ["ok"]
    if (filesMatch) parts.push(`${filesMatch[1]}f`)
    return savings(raw, parts.join(" ") || "ok")
  }
  return savings(raw, clean || "ok")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function parseTestSummary(clean: string): { passed: number; failed: number; skipped: number; failures: string[] } {
  let passed = 0, failed = 0, skipped = 0
  const failures: string[] = []
  const passMatch = clean.match(/(\d+)\s+passed/)
  const failMatch = clean.match(/(\d+)\s+failed/)
  const skipMatch = clean.match(/(\d+)\s+skipped/)
  if (passMatch) passed = parseInt(passMatch[1])
  if (failMatch) failed = parseInt(failMatch[1])
  if (skipMatch) skipped = parseInt(skipMatch[1])
  for (const line of splitLines(clean)) {
    if (/\bFAILED\b/.test(line) || /^FAIL\b/.test(line)) {
      const name = line.replace(/^test\s+/, "").replace(/\s+FAILED.*$/, "").trim()
      if (name && !failures.includes(name)) failures.push(name)
    }
    if (/test result:.*ok/.test(line)) {
      const m = line.match(/(\d+) passed/); if (m) passed = parseInt(m[1])
    }
    if (/test result:.*FAILED/.test(line)) {
      const m = line.match(/(\d+) failed/); if (m) failed = parseInt(m[1])
    }
    if (/FAILED\s+/.test(line)) {
      const m = line.match(/FAILED\s+(.+?)(?:\s+-|$)/)
      if (m && !failures.includes(m[1].trim())) failures.push(m[1].trim())
    }
    if (/^--- FAIL:/.test(line)) {
      const m = line.match(/--- FAIL:\s+(\S+)/)
      if (m && !failures.includes(m[1])) failures.push(m[1])
    }
  }
  return { passed, failed, skipped, failures }
}

function extractFailureDetails(clean: string): string {
  const details: string[] = []
  let inFailure = false
  for (const line of splitLines(clean)) {
    if (/^(?:FAIL|FAILED|Error|AssertionError|panicked at|thread '.*' panicked)/.test(line)) {
      inFailure = true; details.push(line)
    } else if (inFailure) {
      if (/^(?:PASS|ok\s|test result:|={3,}|-{3,}|\d+ passed)/.test(line)) {
        inFailure = false
      } else if (line.trim()) {
        details.push(`  ${line.trim()}`)
        if (details.length > 30) { details.push("  ..."); break }
      }
    }
  }
  return details.slice(0, 25).join("\n")
}

function filterTestOutput(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const { passed, failed, skipped, failures } = parseTestSummary(clean)
  if (failed === 0 && passed === 0) return savings(raw, truncate(clean, 40))
  const total = passed + failed
  const summary = [
    `${failed > 0 ? "FAILED" : "PASSED"}: ${total} tests`,
    passed  ? `${passed} passed`  : "",
    failed  ? `${failed} failed`  : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean).join(", ")
  const result: string[] = [summary]
  if (failures.length > 0) {
    result.push("Failures:")
    failures.slice(0, 20).forEach(f => result.push(`  - ${f}`))
    if (failures.length > 20) result.push(`  ... (${failures.length - 20} more)`)
    const details = extractFailureDetails(clean)
    if (details) result.push(details)
  }
  return savings(raw, result.join("\n"))
}

// ── Linters ───────────────────────────────────────────────────────────────────

function filterEslint(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const byRule: Record<string, number> = {}
  const byFile: Record<string, string[]> = {}
  let currentFile = ""
  for (const line of splitLines(clean)) {
    if (/^[/\w].*\.(js|ts|jsx|tsx|vue|svelte)$/.test(line.trim())) {
      currentFile = line.trim()
      if (!byFile[currentFile]) byFile[currentFile] = []
      continue
    }
    const m = line.match(/\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w/-]+)$/)
    if (m) {
      const [, , , severity, message, rule] = m
      byRule[rule] = (byRule[rule] || 0) + 1
      if (currentFile) byFile[currentFile].push(`${m[1]}:${m[2]} ${severity}: ${message}`)
    }
  }
  const totalErrors = Object.values(byRule).reduce((a, b) => a + b, 0)
  const fileCount = Object.keys(byFile).length
  if (totalErrors === 0) return savings(raw, "no lint errors")
  const result = [`${totalErrors} issues in ${fileCount} files:`]
  Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([rule, count]) => result.push(`  ${rule}: ${count}`))
  Object.entries(byFile).sort((a, b) => b[1].length - a[1].length).slice(0, 5)
    .forEach(([file, errs]) => {
      result.push(file)
      errs.slice(0, 2).forEach(e => result.push(`  ${e}`))
      if (errs.length > 2) result.push(`  ... (${errs.length - 2} more)`)
    })
  return savings(raw, result.join("\n"))
}

function filterTsc(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "tsc: no errors")
  const byFile: Record<string, string[]> = {}
  for (const line of splitLines(clean)) {
    const m = line.match(/^([^(]+)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/)
    if (m) {
      const [, file, lineNo, , code, msg] = m
      if (!byFile[file]) byFile[file] = []
      byFile[file].push(`  ${lineNo}: ${code} ${msg.slice(0, 80)}`)
    }
  }
  const totalErrors = Object.values(byFile).flat().length
  if (totalErrors === 0) return savings(raw, truncate(clean, 20))
  const result = [`${totalErrors} TypeScript errors in ${Object.keys(byFile).length} files:`]
  for (const [file, errs] of Object.entries(byFile)) {
    result.push(file)
    errs.slice(0, 4).forEach(e => result.push(e))
    if (errs.length > 4) result.push(`  ... (${errs.length - 4} more)`)
  }
  return savings(raw, result.join("\n"))
}

// ── Directory / search ────────────────────────────────────────────────────────

function filterLs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = splitLines(clean)
  if (ls.length <= 20) {
    const simplified = ls.map(l => {
      const m = l.match(/(?:[\d-]+\s+\d+\s+\w+\s+\w+\s+[\d.]+[KMG]?\s+\w+\s+\d+\s+[\d:]+\s+)?(.+)$/)
      return m ? m[1] : l
    }).filter(Boolean)
    return savings(raw, simplified.join("\n"))
  }
  const byExt: Record<string, number> = {}
  const dirs: string[] = []
  for (const line of ls) {
    const name = line.split(/\s+/).pop() || ""
    if (name.startsWith(".")) continue
    if (line.startsWith("d") || name.endsWith("/")) dirs.push(name.replace(/\/$/, ""))
    else {
      const ext = name.includes(".") ? name.split(".").pop()! : "(no ext)"
      byExt[ext] = (byExt[ext] || 0) + 1
    }
  }
  const parts: string[] = []
  if (dirs.length) parts.push(`dirs: ${dirs.slice(0, 10).join(" ")}${dirs.length > 10 ? ` +${dirs.length - 10}` : ""}`)
  for (const [ext, count] of Object.entries(byExt).sort((a, b) => b[1] - a[1])) {
    parts.push(`*.${ext}: ${count}`)
  }
  return savings(raw, parts.join("\n") || clean)
}

function filterGrep(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = splitLines(clean).filter(Boolean)
  if (ls.length <= 20) return savings(raw, clean)
  const byFile: Record<string, string[]> = {}
  for (const line of ls) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/) || line.match(/^([^:]+):(.*)$/)
    if (m) {
      const file = m[1]
      if (!byFile[file]) byFile[file] = []
      byFile[file].push(line.slice(file.length + 1))
    } else {
      if (!byFile["<stdin>"]) byFile["<stdin>"] = []
      byFile["<stdin>"].push(line)
    }
  }
  const result: string[] = []
  let totalMatches = 0
  for (const [file, matches] of Object.entries(byFile)) {
    totalMatches += matches.length
    if (matches.length <= 3) {
      matches.forEach(m => result.push(`${file}:${m}`))
    } else {
      result.push(`${file}: ${matches.length} matches`)
      matches.slice(0, 2).forEach(m => result.push(`  ${m.trim()}`))
      result.push(`  ... (${matches.length - 2} more)`)
    }
  }
  result.unshift(`${totalMatches} matches in ${Object.keys(byFile).length} files:`)
  return savings(raw, result.join("\n"))
}

// ── Docker / K8s ──────────────────────────────────────────────────────────────

function filterDockerPs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = splitLines(clean)
  if (ls.length <= 6) return savings(raw, clean)
  const result: string[] = []
  for (const line of ls) {
    if (/^CONTAINER|^---/.test(line)) { result.push(line); continue }
    const cols = line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean)
    if (cols.length >= 5) {
      const name = cols[cols.length - 1]
      const image = cols[1]
      const status = cols[4] || cols[3]
      result.push([name, image, status].filter(Boolean).join("  "))
    } else {
      result.push(line)
    }
  }
  return savings(raw, result.join("\n"))
}

// ── Generic fallback ──────────────────────────────────────────────────────────

function filterPackageMetadata(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const jsonStart = clean.search(/[\[{]/)
  const jsonEnd = Math.max(clean.lastIndexOf("]"), clean.lastIndexOf("}"))
  const jsonCandidate = jsonStart >= 0 && jsonEnd > jsonStart
    ? clean.slice(jsonStart, jsonEnd + 1)
    : clean

  try {
    const parsed = JSON.parse(jsonCandidate)
    const item = Array.isArray(parsed) ? parsed[0] : parsed
    if (item && typeof item === "object") {
      const pkg = item as Record<string, unknown>
      const name = typeof pkg.name === "string" ? pkg.name : ""
      const version = typeof pkg.version === "string" ? pkg.version : ""
      const files = Array.isArray(pkg.files) ? pkg.files.length : undefined
      const linesOut = [
        name || version ? `${name}${version ? `@${version}` : ""}` : "",
        typeof pkg.filename === "string" ? `filename: ${pkg.filename}` : "",
        typeof pkg.size === "number" ? `package size: ${pkg.size} bytes` : "",
        typeof pkg.unpackedSize === "number" ? `unpacked size: ${pkg.unpackedSize} bytes` : "",
        typeof pkg.entryCount === "number" ? `total files: ${pkg.entryCount}` : "",
        files !== undefined ? `files listed: ${files}` : "",
        typeof pkg.integrity === "string" ? `integrity: ${String(pkg.integrity).slice(0, 32)}...` : "",
      ].filter(Boolean)

      if (linesOut.length > 0) return savings(raw, linesOut.join("\n"))
    }
  } catch {
    // Non-JSON package output falls through to line filtering.
  }

  const ls = splitLines(clean).filter(Boolean)
  if (ls.length <= 12 && clean.length <= 1200) return savings(raw, clean)

  const kept: string[] = []
  const seen = new Set<string>()
  for (const line of ls) {
    const t = line.trim()
    if (
      IMPORTANT_LINE_RE.test(t) ||
      /^npm (notice|warn|error)/i.test(t) ||
      /^(name|version|filename|package size|unpacked size|total files|integrity|shasum):/i.test(t) ||
      /^[-+]?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t) ||
      /^\S+@\d+\.\d+\.\d+/.test(t)
    ) {
      uniquePush(kept, seen, t)
    }
  }

  if (kept.length === 0) {
    return savings(raw, truncateImportant(clean, 24))
  }

  const omitted = Math.max(0, ls.length - kept.length)
  if (omitted > 0) kept.push(`... (${omitted} package metadata lines omitted)`)
  return savings(raw, kept.slice(0, 30).join("\n"))
}

function filterGeneric(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, truncateImportant(deduplicateLines(clean), 80))
}

// ── Main router ───────────────────────────────────────────────────────────────

function filterBashOutput(command: string, rawOutput: string): FilterResult {
  if (!rawOutput || rawOutput.trim() === "") return { output: rawOutput, savedPct: 0 }
  const tokens = command.trim().split(/\s+/).slice(0, 4)
  const [cmd, sub] = tokens

  if (cmd === "git") {
    switch (sub) {
      case "status":           return filterGitStatus(rawOutput)
      case "diff": case "show": return filterGitDiff(rawOutput)
      case "log":              return filterGitLog(rawOutput)
      case "add":              return filterGitWriteOp(rawOutput, "add")
      case "commit":           return filterGitWriteOp(rawOutput, "commit")
      case "push":             return filterGitWriteOp(rawOutput, "push")
      case "pull": case "merge": return filterGitWriteOp(rawOutput, "pull")
      default:                 return filterGeneric(rawOutput)
    }
  }

  if (
    (cmd === "npm" && ["pack", "publish", "view", "info", "show", "version"].includes(sub ?? "")) ||
    (cmd === "yarn" && ["pack", "publish", "info", "npm"].includes(sub ?? "")) ||
    (cmd === "pnpm" && ["pack", "publish", "view", "info"].includes(sub ?? ""))
  ) return filterPackageMetadata(rawOutput)

  if ((cmd === "npm" && sub === "test") ||
      (cmd === "npx" && (sub === "jest" || sub === "vitest" || sub === "mocha")) ||
      (cmd === "yarn" && sub === "test") || (cmd === "pnpm" && sub === "test") ||
      cmd === "jest" || cmd === "vitest" || cmd === "mocha" ||
      (cmd === "cargo" && sub === "test") ||
      cmd === "pytest" || cmd === "py.test" ||
      (cmd === "go" && sub === "test") ||
      cmd === "rspec") {
    return filterTestOutput(rawOutput)
  }

  if (cmd === "eslint" || (cmd === "npx" && sub === "eslint") || cmd === "biome") {
    return filterEslint(rawOutput)
  }
  if (cmd === "tsc" || (cmd === "npx" && sub === "tsc")) {
    return filterTsc(rawOutput)
  }
  if (cmd === "ls" || cmd === "dir") return filterLs(rawOutput)
  if (cmd === "find" || cmd === "tree") return filterLs(rawOutput)
  if (cmd === "grep" || cmd === "rg" || cmd === "ag") return filterGrep(rawOutput)
  if (cmd === "docker") {
    if (sub === "ps" || sub === "images") return filterDockerPs(rawOutput)
    if (sub === "logs") return savings(rawOutput, deduplicateLines(stripAnsi(rawOutput), 2))
    return filterGeneric(rawOutput)
  }
  if (cmd === "kubectl") {
    const clean = stripAnsi(rawOutput).trim()
    return savings(rawOutput, truncate(clean, 30))
  }

  return filterGeneric(rawOutput)
}

// ═══════════════════════════════════════════════════════════════════
// CLI RUNNER
// ═══════════════════════════════════════════════════════════════════

const INSTALL_DIR = path.join(os.homedir(), ".config", "token-optimizer")
const STATS_PATH  = path.join(INSTALL_DIR, "stats.json")
const LEGACY_STATS_PATH = path.join(os.homedir(), ".config", "token-" + "saver", "stats.json")

interface Stats {
  totalOriginalTokens: number
  totalFilteredTokens: number
  commandCount: number
  lastUpdated: string
  bySurface?: Record<string, { originalTokens: number; filteredTokens: number; count: number }>
}

function loadStats(): Stats {
  try {
    const statsPath = fs.existsSync(STATS_PATH) ? STATS_PATH : LEGACY_STATS_PATH
    return JSON.parse(fs.readFileSync(statsPath, "utf-8"))
  } catch {
    return { totalOriginalTokens: 0, totalFilteredTokens: 0, commandCount: 0, lastUpdated: "", bySurface: {} }
  }
}

function saveStats(stats: Stats): void {
  try {
    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true })
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2))
  } catch { /* ignore */ }
}

function showStats(): void {
  const s = loadStats()
  const saved = s.totalOriginalTokens - s.totalFilteredTokens
  const pct = s.totalOriginalTokens === 0 ? 0 :
    Math.round((saved / s.totalOriginalTokens) * 100)
  process.stdout.write([
    "=== token-optimizer stats ===",
    `Commands filtered : ${s.commandCount}`,
    `Original tokens   : ${s.totalOriginalTokens.toLocaleString()}`,
    `Filtered tokens   : ${s.totalFilteredTokens.toLocaleString()}`,
    `Saved tokens      : ${saved.toLocaleString()} (${pct}%)`,
    `Last updated      : ${s.lastUpdated || "never"}`,
    ...(s.bySurface ? [
      "",
      "By surface:",
      ...Object.entries(s.bySurface)
        .sort((a, b) => (b[1].originalTokens - b[1].filteredTokens) - (a[1].originalTokens - a[1].filteredTokens))
        .map(([name, v]) => {
          const surfaceSaved = v.originalTokens - v.filteredTokens
          const surfacePct = v.originalTokens === 0 ? 0 : Math.round((surfaceSaved / v.originalTokens) * 100)
          return `  ${name}: ${surfaceSaved.toLocaleString()} saved (${surfacePct}%, ${v.count} calls)`
        }),
    ] : []),
  ].join("\n") + "\n")
}

function commandSurface(command: string): string {
  const [cmd, sub] = command.trim().split(/\s+/)
  if (cmd === "git") return `git:${sub ?? "other"}`
  if (cmd === "npm" || cmd === "yarn" || cmd === "pnpm") return `package:${sub ?? "run"}`
  if (["jest", "vitest", "mocha", "pytest", "cargo", "go", "rspec", "rake"].includes(cmd ?? "")) return "test-build"
  if (["rg", "grep", "ag", "find", "ls", "tree"].includes(cmd ?? "")) return "search-list"
  if (["docker", "docker-compose", "kubectl"].includes(cmd ?? "")) return "infra"
  if (["curl", "wget", "http", "httpie"].includes(cmd ?? "")) return "http"
  if (["eslint", "tsc", "ruff", "biome"].includes(cmd ?? "")) return "lint"
  return cmd || "unknown"
}

function main(): void {
  const rawArgs = process.argv.slice(2)

  // Stats command
  if (rawArgs[0] === "stats") { showStats(); process.exit(0) }
  
  // Reset stats command
  if (rawArgs[0] === "reset-stats") {
    try {
      if (fs.existsSync(STATS_PATH)) {
        fs.unlinkSync(STATS_PATH)
        process.stdout.write("✓ Stats reset successfully\n")
      } else {
        process.stdout.write("✓ No stats file found (already clean)\n")
      }
      // Also clean up legacy stats if exists
      if (fs.existsSync(LEGACY_STATS_PATH)) {
        fs.unlinkSync(LEGACY_STATS_PATH)
        process.stdout.write("✓ Legacy stats also cleaned\n")
      }
    } catch (e) {
      process.stderr.write(`✗ Failed to reset stats: ${e}\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  // Strip "--" separator
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs

  if (args.length === 0) {
    process.stderr.write("Usage: node filter.js <command> [args...]\n")
    process.stderr.write("       node filter.js stats\n")
    process.exit(1)
  }

  const [command, ...cmdArgs] = args
  const fullCommand = [command, ...cmdArgs].join(" ")

  // Spawn
  const result = spawnSync(command, cmdArgs, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32",
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })

  const rawOutput = [result.stdout || "", result.stderr || ""].filter(Boolean).join("\n")

  let finalOutput: string
  try {
    const filterResult = filterBashOutput(fullCommand, rawOutput)
    finalOutput = filterResult.output

    const stats = loadStats()
    stats.totalOriginalTokens += estimateTokens(rawOutput)
    stats.totalFilteredTokens += estimateTokens(finalOutput)
    stats.commandCount++
    stats.lastUpdated = new Date().toISOString()
    const surface = commandSurface(fullCommand)
    stats.bySurface ??= {}
    const existing = stats.bySurface[surface] ?? { originalTokens: 0, filteredTokens: 0, count: 0 }
    existing.originalTokens += estimateTokens(rawOutput)
    existing.filteredTokens += estimateTokens(finalOutput)
    existing.count++
    stats.bySurface[surface] = existing
    saveStats(stats)

    if (process.env["OC_FILTER_DEBUG"] === "1") {
      process.stderr.write(`[oc-filter] ${fullCommand.slice(0, 50)} → ${filterResult.savedPct}% saved\n`)
    }
  } catch {
    finalOutput = rawOutput
  }

  process.stdout.write(finalOutput)
  if (finalOutput && !finalOutput.endsWith("\n")) process.stdout.write("\n")
  process.exit(result.status ?? 0)
}

main()
