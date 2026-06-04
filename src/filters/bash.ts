/**
 * Bash output compression filters.
 *
 * Each filter handles a specific command family. The main export `filterBashOutput`
 * routes by command name and falls back to a generic deduplicator.
 *
 * Savings targets per command type:
 *   git status/add/commit/push  → 80-92%
 *   git diff                   → 70-75%
 *   ls / find                  → 70-80%
 *   grep / rg                  → 75-80%
 *   npm/yarn/pnpm test         → 85-90%
 *   cargo test / pytest        → 88-92%
 *   eslint / tsc / ruff        → 80-85%
 *   docker ps / kubectl        → 75-80%
 *   generic long output        → 50-70%
 */

export interface FilterResult {
  output: string
  /** approximate % tokens saved vs original (0-100) */
  savedPct: number
}

// ─── Token estimation (4 chars ≈ 1 token) ──────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function savings(original: string, filtered: string): FilterResult {
  const before = estimateTokens(original)
  const after = estimateTokens(filtered)
  const pct = before === 0 ? 0 : Math.round(((before - after) / before) * 100)
  return { output: filtered, savedPct: Math.max(0, pct) }
}

// ─── Helper utilities ────────────────────────────────────────────────────────

function lines(text: string): string[] {
  return text.split("\n")
}

/** Deduplicate repeated identical lines, appending (×N) count */
function deduplicateLines(text: string, maxRepeats = 1): string {
  const result: string[] = []
  let prev = ""
  let count = 0

  function flush() {
    if (prev === "") return
    if (count > maxRepeats) {
      // Emit first occurrence + collapsed count annotation
      result.push(prev)
      result.push(`  ... (repeated ×${count - 1} more)`)
    } else {
      // Emit all occurrences (count ≤ maxRepeats)
      for (let i = 0; i < count; i++) result.push(prev)
    }
  }

  for (const line of lines(text)) {
    if (line === prev) {
      count++
    } else {
      flush()
      prev = line
      count = 1
    }
  }
  flush()
  return result.join("\n").trim()
}

/** Strip ANSI color/control codes */
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "")
}

/** Truncate output to maxLines, appending a summary line */
function truncate(text: string, maxLines: number): string {
  const ls = lines(text)
  if (ls.length <= maxLines) return text
  const kept = ls.slice(0, maxLines)
  const dropped = ls.length - maxLines
  kept.push(`... (${dropped} more lines omitted)`)
  return kept.join("\n")
}

// ─── Git filters ─────────────────────────────────────────────────────────────

function filterGitStatus(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean || clean.includes("nothing to commit")) {
    return savings(raw, "nothing to commit, working tree clean")
  }

  const staged: string[] = []
  const unstaged: string[] = []
  let untracked = 0

  for (const line of lines(clean)) {
    // Porcelain v1 format: "XY filename"
    const porcelain = line.match(/^([MADRCU?!]{1})([MADRCU?! ]{1})\s+(.+)$/)
    if (porcelain) {
      const [, x, y, file] = porcelain
      if (x !== " " && x !== "?") staged.push(`${x}:${file.trim()}`)
      if (y !== " " && y !== "?") unstaged.push(`${y}:${file.trim()}`)
      if (x === "?" && y === "?") untracked++
      continue
    }

    // Long format: "        modified:   src/foo.ts"
    const modifiedMatch = line.match(/^\s+modified:\s+(.+)$/)
    if (modifiedMatch) { unstaged.push(modifiedMatch[1].trim()); continue }

    const newFileMatch = line.match(/^\s+new file:\s+(.+)$/)
    if (newFileMatch) { staged.push(`A:${newFileMatch[1].trim()}`); continue }

    const deletedMatch = line.match(/^\s+deleted:\s+(.+)$/)
    if (deletedMatch) { unstaged.push(`D:${deletedMatch[1].trim()}`); continue }

    const renamedMatch = line.match(/^\s+renamed:\s+(.+)$/)
    if (renamedMatch) { staged.push(`R:${renamedMatch[1].trim()}`); continue }

    // Count untracked files
    if (line.startsWith("\t") || (line.match(/^\s+\S/) && !line.includes(":"))) {
      // Could be an untracked file in long format
    }
  }

  // Count untracked from raw if not parsed
  if (untracked === 0) {
    const untrackedSection = clean.indexOf("Untracked files:")
    if (untrackedSection !== -1) {
      const after = clean.slice(untrackedSection)
      const fileLines = lines(after).filter(l => l.startsWith("\t")).length
      untracked = fileLines
    }
  }

  const branch = clean.match(/On branch (\S+)/)?.[1] || ""
  const parts: string[] = []
  if (branch) parts.push(`branch:${branch}`)
  if (staged.length)    parts.push(`staged:[${staged.join(",")}]`)
  if (unstaged.length)  parts.push(`modified:[${unstaged.join(",")}]`)
  if (untracked > 0)    parts.push(`untracked:${untracked}`)

  // If we parsed nothing meaningful, fall back to a concise summary
  if (!staged.length && !unstaged.length && !untracked) {
    // Extract key status lines only
    const summary = lines(clean)
      .filter(l => l.includes("modified:") || l.includes("new file:") ||
                   l.includes("deleted:") || l.includes("renamed:") ||
                   l.startsWith("On branch") || l.includes("to commit"))
      .slice(0, 10)
      .join("\n")
    return savings(raw, summary || clean.slice(0, 200))
  }

  return savings(raw, parts.join(" | "))
}

function filterGitDiff(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no diff)")

  // Keep only diff headers and changed lines; strip context lines
  const result: string[] = []
  let fileHeader = ""
  let adds = 0, dels = 0

  for (const line of lines(clean)) {
    if (line.startsWith("diff --git")) {
      // Finalize previous file summary
      if (fileHeader) {
        if (adds || dels) result.push(`${fileHeader} +${adds}/-${dels}`)
        adds = 0; dels = 0
      }
      fileHeader = line.replace("diff --git ", "").replace(/^a\/\S+ b\//, "")
      result.push(`--- ${fileHeader}`)
    } else if (/^Binary files/.test(line)) {
      // Binary changed file — preserve the signal, don't silently drop
      result.push(`${fileHeader} [binary changed]`)
      fileHeader = ""
      adds = 0; dels = 0
    } else if (/^new file mode|^deleted file mode/.test(line)) {
      result.push(line.trim())
    } else if (line.startsWith("@@")) {
      result.push(line.replace(/@@[^@]+@@/, "@@").trim())
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      adds++
      result.push(line)
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      dels++
      result.push(line)
    }
    // skip context lines (start with " ") and file headers (---, +++)
  }
  if (fileHeader && (adds || dels)) {
    result.push(`${fileHeader} +${adds}/-${dels}`)
  }

  const out = truncate(result.join("\n"), 120)
  return savings(raw, out)
}

function filterGitLog(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  // Condense to one line per commit: hash + subject
  const result: string[] = []
  for (const line of lines(clean)) {
    // Match standard git log output (hash + message) or oneline format
    const onelineMatch = line.match(/^([0-9a-f]{7,40})\s+(.+)$/)
    const commitMatch = line.match(/^commit ([0-9a-f]{40})/)
    const subjectMatch = line.match(/^\s{4}(.+)$/)

    if (onelineMatch) {
      result.push(`${onelineMatch[1].slice(0, 7)} ${onelineMatch[2]}`)
    } else if (commitMatch) {
      result.push(commitMatch[1].slice(0, 7))
    } else if (subjectMatch && result.length > 0) {
      // Append subject to the last commit hash
      const last = result[result.length - 1]
      if (/^[0-9a-f]{7}$/.test(last)) {
        result[result.length - 1] = `${last} ${subjectMatch[1]}`
      }
    }
  }
  return savings(raw, result.join("\n") || clean)
}

function filterGitWriteOp(raw: string, cmd: string): FilterResult {
  const clean = stripAnsi(raw).trim()

  if (cmd === "commit") {
    const m = clean.match(/\[[\w/]+\s+([0-9a-f]{7})\]/) ||
              clean.match(/([0-9a-f]{7,40})/)
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
    // Match "  main -> main" or "refs/heads/main" in push output
    const branchMatch = clean.match(/\b([\w/.-]+)\s*->\s*([\w/.-]+)/) ||
                        clean.match(/refs\/heads\/([\w/.-]+)/)
    const branch = branchMatch ? branchMatch[1] : "origin"
    // Check for errors
    if (/error|rejected|denied/i.test(clean)) {
      const errorLine = lines(clean).find(l => /error|rejected|denied/i.test(l)) || ""
      return savings(raw, `FAILED: ${errorLine.trim()}`)
    }
    return savings(raw, `ok ${branch}`)
  }

  if (cmd === "add") {
    return savings(raw, "ok")
  }

  if (cmd === "pull") {
    const filesMatch = clean.match(/(\d+) file/)
    const insertMatch = clean.match(/(\d+) insertion/)
    const deleteMatch = clean.match(/(\d+) deletion/)
    const parts = ["ok"]
    if (filesMatch) parts.push(`${filesMatch[1]}f`)
    if (insertMatch) parts.push(`+${insertMatch[1]}`)
    if (deleteMatch) parts.push(`-${deleteMatch[1]}`)
    return savings(raw, parts.join(" ") || "ok")
  }

  if (cmd === "merge") {
    if (/conflict|CONFLICT/i.test(clean)) {
      const conflictLines = lines(clean)
        .filter(l => /conflict/i.test(l))
        .slice(0, 5)
      return savings(raw, `CONFLICT:\n${conflictLines.join("\n")}`)
    }
    if (/Already up to date/i.test(clean)) return savings(raw, "already up to date")
    const filesMatch = clean.match(/(\d+) file/)
    const insertMatch = clean.match(/(\d+) insertion/)
    const deleteMatch = clean.match(/(\d+) deletion/)
    const parts = ["ok"]
    if (filesMatch) parts.push(`${filesMatch[1]}f`)
    if (insertMatch) parts.push(`+${insertMatch[1]}`)
    if (deleteMatch) parts.push(`-${deleteMatch[1]}`)
    return savings(raw, parts.join(" ") || "ok")
  }

  return savings(raw, clean || "ok")
}

// ─── Directory listing filters ────────────────────────────────────────────────

function filterLs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()

  // Group files by extension for very long listings
  const ls = lines(clean)
  if (ls.length <= 20) {
    // Short enough — strip permissions/dates from -l format
    const simplified = ls.map(l => {
      const m = l.match(/(?:[\d-]+\s+\d+\s+\w+\s+\w+\s+[\d.]+[KMG]?\s+\w+\s+\d+\s+[\d:]+\s+)?(.+)$/)
      return m ? m[1] : l
    }).filter(Boolean)
    return savings(raw, simplified.join("\n"))
  }

  // Long listing: group by extension
  const byExt: Record<string, number> = {}
  const dirs: string[] = []

  for (const line of ls) {
    const name = line.split(/\s+/).pop() || ""
    if (name.startsWith(".")) continue
    if (line.startsWith("d") || name.endsWith("/")) {
      dirs.push(name.replace(/\/$/, ""))
    } else {
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

function filterFind(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = lines(clean).filter(Boolean)

  if (ls.length <= 30) return savings(raw, clean)

  // Group by directory
  const byDir: Record<string, string[]> = {}
  for (const f of ls) {
    const dir = f.includes("/") ? f.split("/").slice(0, -1).join("/") || "." : "."
    if (!byDir[dir]) byDir[dir] = []
    byDir[dir].push(f.split("/").pop() || f)
  }

  const result: string[] = []
  for (const [dir, files] of Object.entries(byDir)) {
    if (files.length <= 3) {
      files.forEach(f => result.push(`${dir}/${f}`))
    } else {
      result.push(`${dir}/ (${files.length} files: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""})`)
    }
  }

  return savings(raw, result.join("\n"))
}

// ─── Search filters ───────────────────────────────────────────────────────────

function filterRgJson(raw: string): FilterResult {
  // Parse ripgrep --json NDJSON output into a compact summary
  const byFile: Record<string, { count: number; samples: string[] }> = {}
  for (const line of lines(raw)) {
    if (!line.startsWith("{")) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === "match") {
        const file = obj.data?.path?.text ?? "<unknown>"
        const text = (obj.data?.lines?.text ?? "").trim().slice(0, 80)
        if (!byFile[file]) byFile[file] = { count: 0, samples: [] }
        byFile[file].count++
        if (byFile[file].samples.length < 2) byFile[file].samples.push(text)
      }
    } catch { /* skip malformed lines */ }
  }
  const total = Object.values(byFile).reduce((a, b) => a + b.count, 0)
  if (total === 0) return savings(raw, "(no matches)")
  const result = [`${total} matches in ${Object.keys(byFile).length} files:`]
  for (const [file, { count, samples }] of Object.entries(byFile)) {
    result.push(`  ${file}: ${count} match${count > 1 ? "es" : ""}`)
    samples.forEach(s => result.push(`    ${s}`))
  }
  return savings(raw, result.join("\n"))
}

function filterGrep(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = lines(clean).filter(Boolean)

  if (ls.length <= 20) return savings(raw, clean)

  // Detect rg --json output
  if (ls[0]?.startsWith('{"type":') || ls[0]?.startsWith('{"data":')) {
    return filterRgJson(clean)
  }

  // Group matches by file, show count + first few
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
      // Cap each sample line to 80 chars to avoid long minified-code lines
      matches.slice(0, 2).forEach(m => result.push(`  ${m.trim().slice(0, 80)}`))
      result.push(`  ... (${matches.length - 2} more)`)
    }
  }

  result.unshift(`${totalMatches} matches in ${Object.keys(byFile).length} files:`)
  return savings(raw, result.join("\n"))
}

// ─── Test runner filters ──────────────────────────────────────────────────────

interface TestSummary {
  passed: number
  failed: number
  skipped: number
  failures: string[]
}

function parseTestSummary(clean: string): TestSummary {
  let passed = 0, failed = 0, skipped = 0
  const failures: string[] = []

  // Jest / Vitest / generic
  const passMatch = clean.match(/(\d+)\s+passed/)
  const failMatch = clean.match(/(\d+)\s+failed/)
  const skipMatch = clean.match(/(\d+)\s+skipped/)
  if (passMatch) passed = parseInt(passMatch[1])
  if (failMatch) failed = parseInt(failMatch[1])
  if (skipMatch) skipped = parseInt(skipMatch[1])

  // Cargo test: "test X ... FAILED"
  for (const line of lines(clean)) {
    if (/\bFAILED\b/.test(line) || /^FAIL\b/.test(line)) {
      const name = line.replace(/^test\s+/, "").replace(/\s+FAILED.*$/, "").trim()
      if (name && !failures.includes(name)) failures.push(name)
    }
    if (/test result:.*ok/.test(line)) {
      const m = line.match(/(\d+) passed/) ; if (m) passed = parseInt(m[1])
    }
    if (/test result:.*FAILED/.test(line)) {
      const m = line.match(/(\d+) failed/) ; if (m) failed = parseInt(m[1])
    }
    // pytest
    if (/FAILED\s+/.test(line)) {
      const m = line.match(/FAILED\s+(.+?)(?:\s+-|$)/)
      if (m && !failures.includes(m[1].trim())) failures.push(m[1].trim())
    }
    // Go test
    if (/^--- FAIL:/.test(line)) {
      const m = line.match(/--- FAIL:\s+(\S+)/)
      if (m && !failures.includes(m[1])) failures.push(m[1])
    }
  }

  return { passed, failed, skipped, failures }
}

function filterTestOutput(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const { passed, failed, skipped, failures } = parseTestSummary(clean)

  if (failed === 0 && passed === 0) {
    // Can't parse — fall back to truncation
    return savings(raw, truncate(clean, 40))
  }

  const summary = [
    `${failed > 0 ? "FAILED" : "PASSED"}: ${passed + failed} tests`,
    passed  ? `${passed} passed`  : "",
    failed  ? `${failed} failed`  : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean).join(", ")

  const result: string[] = [summary]

  if (failures.length > 0) {
    result.push("Failures:")
    failures.slice(0, 20).forEach(f => result.push(`  - ${f}`))
    if (failures.length > 20) result.push(`  ... (${failures.length - 20} more)`)

    // Extract failure details (error messages, assertion diffs)
    const failureDetails = extractFailureDetails(clean)
    if (failureDetails) result.push(failureDetails)
  }

  return savings(raw, result.join("\n"))
}

function extractFailureDetails(clean: string): string {
  const details: string[] = []
  let inFailure = false

  for (const line of lines(clean)) {
    // Start of failure block markers
    if (/^(?:FAIL|FAILED|Error|AssertionError|panicked at|thread '.*' panicked)/.test(line)) {
      inFailure = true
      details.push(line)
    } else if (inFailure) {
      // Stop at success/summary lines
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

// ─── Linter / build filters ───────────────────────────────────────────────────

function filterEslint(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()

  // Group errors by rule
  const byRule: Record<string, number> = {}
  const byFile: Record<string, string[]> = {}
  let currentFile = ""

  for (const line of lines(clean)) {
    // File header line (no leading whitespace, ends in .js/.ts etc.)
    if (/^[/\w].*\.(js|ts|jsx|tsx|vue|svelte)$/.test(line.trim())) {
      currentFile = line.trim()
      if (!byFile[currentFile]) byFile[currentFile] = []
      continue
    }

    // Error/warning line: "  42:10  error  no-unused-vars  eslint..."
    const m = line.match(/\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w/-]+)$/)
    if (m) {
      const [, , , severity, message, rule] = m
      byRule[rule] = (byRule[rule] || 0) + 1
      if (currentFile) {
        byFile[currentFile].push(`${m[1]}:${m[2]} ${severity}: ${message}`)
      }
    }
  }

  const result: string[] = []
  const totalErrors = Object.values(byRule).reduce((a, b) => a + b, 0)
  const fileCount = Object.keys(byFile).length

  if (totalErrors === 0) return savings(raw, "no lint errors")

  result.push(`${totalErrors} issues in ${fileCount} files:`)

  // Top rules by count
  const sortedRules = Object.entries(byRule).sort((a, b) => b[1] - a[1])
  sortedRules.slice(0, 8).forEach(([rule, count]) => result.push(`  ${rule}: ${count}`))

  // Files with most errors
  const sortedFiles = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)
  sortedFiles.slice(0, 5).forEach(([file, errs]) => {
    result.push(`${file}: ${errs.length} issues`)
    errs.slice(0, 2).forEach(e => result.push(`  ${e}`))
    if (errs.length > 2) result.push(`  ... (${errs.length - 2} more)`)
  })

  return savings(raw, result.join("\n"))
}

function filterTsc(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean || clean.trim() === "") return savings(raw, "tsc: no errors")

  // Group by file
  const byFile: Record<string, string[]> = {}
  for (const line of lines(clean)) {
    // TS error: "src/foo.ts(12,34): error TS2345: ..."
    const m = line.match(/^([^(]+)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/)
    if (m) {
      const [, file, lineNo, , code, msg] = m
      if (!byFile[file]) byFile[file] = []
      byFile[file].push(`  ${lineNo}: ${code} ${msg.slice(0, 80)}`)
    }
  }

  const totalErrors = Object.values(byFile).flat().length
  if (totalErrors === 0) return savings(raw, truncate(clean, 20))

  const result: string[] = [`${totalErrors} TypeScript errors in ${Object.keys(byFile).length} files:`]
  for (const [file, errs] of Object.entries(byFile)) {
    result.push(file)
    errs.slice(0, 4).forEach(e => result.push(e))
    if (errs.length > 4) result.push(`  ... (${errs.length - 4} more)`)
  }

  return savings(raw, result.join("\n"))
}

function filterRuff(raw: string): FilterResult {
  // ruff outputs JSON with --format json, or human-readable otherwise
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ruff: no issues")

  const byRule: Record<string, number> = {}
  const errors: string[] = []
  let total = 0

  for (const line of lines(clean)) {
    // ruff human format: "src/foo.py:12:4: E501 Line too long (100 > 79)"
    const m = line.match(/^(.+?):(\d+):\d+:\s+([A-Z]\d+)\s+(.+)$/)
    if (m) {
      const [, , , code, msg] = m
      byRule[code] = (byRule[code] || 0) + 1
      total++
      if (errors.length < 5) errors.push(`${code}: ${msg.slice(0, 60)}`)
    }
  }

  if (total === 0) return savings(raw, truncate(clean, 20))

  const result = [`ruff: ${total} issues`]
  Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .forEach(([code, count]) => result.push(`  ${code}: ${count}`))

  return savings(raw, result.join("\n"))
}

// ─── Docker / Kubernetes filters ─────────────────────────────────────────────

function filterDockerPs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = lines(clean)
  if (ls.length <= 6) return savings(raw, clean)

  // Strip wide columns, keep only: container name, image, status, ports
  const result: string[] = []
  for (const line of ls) {
    // Header or separator
    if (/^CONTAINER|^---/.test(line)) { result.push(line); continue }
    // Parse columns by detecting multi-space separators
    const cols = line.split(/\s{2,}/).map(c => c.trim()).filter(Boolean)
    if (cols.length >= 5) {
      // CONTAINER ID, IMAGE, COMMAND, CREATED, STATUS, PORTS, NAMES
      const name = cols[cols.length - 1]
      const image = cols[1]
      const status = cols[4] || cols[3]
      const ports = cols[5] || ""
      result.push([name, image, status, ports].filter(Boolean).join("  "))
    } else {
      result.push(line)
    }
  }

  return savings(raw, result.join("\n"))
}

function filterDockerLogs(raw: string): FilterResult {
  return savings(raw, deduplicateLines(stripAnsi(raw), 2))
}

function filterKubectl(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = lines(clean)
  if (ls.length <= 10) return savings(raw, clean)

  // Keep header + strip wide status columns for pods/services
  const result = ls.map(line => {
    // Strip AGE column (last) from kubectl output if present
    const cols = line.split(/\s{2,}/)
    if (cols.length > 3 && /^\d+[smhd]$/.test(cols[cols.length - 1].trim())) {
      return cols.slice(0, -1).join("  ")
    }
    return line
  })

  return savings(raw, result.join("\n"))
}

// ─── Package manager filters ──────────────────────────────────────────────────

function filterNpmInstall(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  // Strip progress bars and per-package download lines
  const kept = lines(clean).filter(line => {
    if (/^(?:npm warn|npm notice|added \d+|updated \d+|audited \d+|found \d+)/.test(line.trim().toLowerCase())) return true
    if (/^error/i.test(line.trim())) return true
    return false
  })

  const summary = kept.join("\n") || clean.split("\n").slice(-3).join("\n")
  return savings(raw, summary)
}

// ─── Build script filter (npm run / yarn run / pnpm run) ─────────────────────

function filterNpmRunScript(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = lines(clean)
  if (ls.length <= 20) return savings(raw, clean)

  // Keep error lines, success summary, and warnings
  const kept = ls.filter(l => {
    const t = l.trim()
    // Vite/esbuild success
    if (/built in|✓ built|dist\/|Build complete/i.test(t)) return true
    // Webpack success
    if (/compiled successfully|webpack \d/i.test(t)) return true
    // tsc inside build
    if (/error TS\d+|\.ts\(\d+,\d+\)/i.test(t)) return true
    // Generic error/warning
    if (/^error[:\s]|^ERROR[:\s]|failed to compile/i.test(t)) return true
    if (/warning[:\s]/i.test(t) && t.length < 120) return true
    // Asset size table (keep but truncate each line)
    if (/\.(js|css|html|wasm)\s+[\d.]+\s*(kB|MB|B)/i.test(t)) return true
    return false
  }).map(l => l.slice(0, 120))  // cap line length

  const output = kept.length > 0 ? kept.join("\n") : ls.slice(-5).join("\n")
  return savings(raw, truncate(output, 40))
}

// ─── pip / uv install filter ─────────────────────────────────────────────────

function filterPipInstall(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const kept = lines(clean).filter(l => {
    const t = l.trim()
    return /^Successfully installed|^ERROR|^error|^Requirement already|^WARNING|^warning/i.test(t)
  })
  return savings(raw, kept.join("\n") || clean.split("\n").slice(-2).join("\n"))
}

// ─── brew filter ─────────────────────────────────────────────────────────────

function filterBrew(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const kept = lines(clean).filter(l => {
    const t = l.trim()
    return /^==> Summary|^Error:|^Warning:|already installed|🍺|\binstalled\b|\bpoured\b/i.test(t)
  })
  return savings(raw, kept.join("\n") || clean.split("\n").slice(-3).join("\n"))
}

// ─── make filter ─────────────────────────────────────────────────────────────

function filterMake(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const kept = lines(clean).filter(l => {
    return /^make[\[:]|error:|warning:|Error \d|\*\*\* /i.test(l)
  })
  if (kept.length === 0) {
    return savings(raw, /is up to date|nothing to be done/i.test(clean) ? "make: up to date" : "make: ok")
  }
  return savings(raw, kept.slice(0, 30).join("\n"))
}

// ─── curl / wget filter ──────────────────────────────────────────────────────

function filterHttpOutput(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  // Strip curl verbose lines (> request, < response headers, * info)
  const stripped = lines(clean)
    .filter(l => !/^[>*]\s|^< /.test(l))
    .join("\n")
    .trim()
  // JSON: truncate body aggressively
  if (stripped.startsWith("{") || stripped.startsWith("[")) {
    return savings(raw, truncate(stripped, 50))
  }
  return savings(raw, truncate(stripped, 60))
}

// ─── go build / mod filter ───────────────────────────────────────────────────

function filterGoBuild(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")
  const kept = lines(clean).filter(l => /\.go:\d+:\d+:|^#|^FAIL|^ok\s/.test(l))
  return savings(raw, kept.join("\n") || clean.split("\n").slice(-3).join("\n"))
}

function filterGoMod(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const kept = lines(clean).filter(l => /^go:|error|warning/i.test(l.trim()))
  return savings(raw, kept.join("\n") || (clean.length < 200 ? clean : "ok"))
}

// ─── gh CLI filter ───────────────────────────────────────────────────────────

function filterGhCli(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const ls = lines(clean)
  if (ls.length <= 10) return savings(raw, clean)
  // Normalize wide column padding, cap line length
  const result = ls.map(l => l.replace(/\s{3,}/g, "  ").slice(0, 120))
  return savings(raw, result.join("\n"))
}

// ─── xcodebuild / swift build filter ─────────────────────────────────────────

function filterXcode(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const kept = lines(clean).filter(l =>
    /error:|warning:|BUILD SUCCEEDED|BUILD FAILED|\*\* BUILD/i.test(l)
  )
  if (kept.length === 0) {
    return savings(raw, /BUILD SUCCEEDED/i.test(clean) ? "BUILD SUCCEEDED" : truncate(clean, 20))
  }
  return savings(raw, kept.slice(0, 40).join("\n"))
}

// ─── Generic fallback filter ──────────────────────────────────────────────────

function filterGeneric(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  const deduped = deduplicateLines(clean)
  const truncated = truncate(deduped, 80)
  return savings(raw, truncated)
}

// ─── Command router ───────────────────────────────────────────────────────────

/**
 * Parse the first 1-3 words of a command to determine the filter to apply.
 * e.g. "git status --short" → tokens: ["git", "status"]
 */
function parseCommand(command: string): string[] {
  return command.trim().split(/\s+/).slice(0, 4)
}

/**
 * Main entry point. Given a shell command string and its raw stdout+stderr output,
 * return a compressed version suitable for LLM consumption.
 */
export function filterBashOutput(command: string, rawOutput: string): FilterResult {
  if (!rawOutput || rawOutput.trim() === "") {
    return { output: rawOutput, savedPct: 0 }
  }

  const tokens = parseCommand(command)
  const [cmd, sub, sub2] = tokens

  // ── Git ──────────────────────────────────────────────────────────────────
  if (cmd === "git") {
    switch (sub) {
      case "status":                          return filterGitStatus(rawOutput)
      case "diff":                            return filterGitDiff(rawOutput)
      case "log":                             return filterGitLog(rawOutput)
      case "add":                             return filterGitWriteOp(rawOutput, "add")
      case "commit":                          return filterGitWriteOp(rawOutput, "commit")
      case "push":                            return filterGitWriteOp(rawOutput, "push")
      case "pull":                            return filterGitWriteOp(rawOutput, "pull")
      case "merge":                           return filterGitWriteOp(rawOutput, "merge")
      case "show":                            return filterGitDiff(rawOutput)
      default:                               return filterGeneric(rawOutput)
    }
  }

  // ── npm / yarn / pnpm run <script> ───────────────────────────────────────
  if (
    (cmd === "npm"  && sub === "run") ||
    (cmd === "yarn" && sub === "run") ||
    (cmd === "pnpm" && sub === "run")
  ) { return filterNpmRunScript(rawOutput) }

  // ── pnpm dlx — re-route by the actual executed package ───────────────────
  if (cmd === "pnpm" && sub === "dlx" && sub2) {
    return filterBashOutput(tokens.slice(2).join(" "), rawOutput)
  }

  // ── Test runners ──────────────────────────────────────────────────────────
  if (
    (cmd === "npm"   && sub === "test") ||
    (cmd === "npx"   && (sub === "jest" || sub === "vitest" || sub === "mocha")) ||
    (cmd === "yarn"  && sub === "test") ||
    (cmd === "pnpm"  && sub === "test") ||
    cmd === "jest" || cmd === "vitest" || cmd === "mocha"
  ) { return filterTestOutput(rawOutput) }

  if (cmd === "cargo" && (sub === "test" || (sub === "nextest" && sub2 === "run"))) {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "pytest" || cmd === "py.test") {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "go" && sub === "test") {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "go" && (sub === "build" || sub === "vet" || sub === "run")) {
    return filterGoBuild(rawOutput)
  }
  if (cmd === "go" && sub === "mod") {
    return filterGoMod(rawOutput)
  }
  if (cmd === "rake" && sub === "test") {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "rspec") {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "npx" && sub === "playwright") {
    return filterTestOutput(rawOutput)
  }

  // ── Linters / build ───────────────────────────────────────────────────────
  if (cmd === "eslint" || (cmd === "npx" && sub === "eslint")) {
    return filterEslint(rawOutput)
  }
  if (cmd === "tsc" || (cmd === "npx" && sub === "tsc")) {
    return filterTsc(rawOutput)
  }
  if (cmd === "ruff") {
    return filterRuff(rawOutput)
  }
  if (cmd === "cargo" && (sub === "build" || sub === "clippy" || sub === "check")) {
    return filterTestOutput(rawOutput) // reuse test filter — handles error extraction
  }
  if (cmd === "biome") {
    return filterEslint(rawOutput) // similar format
  }

  // ── Directory / search ────────────────────────────────────────────────────
  if (cmd === "ls" || cmd === "dir") {
    return filterLs(rawOutput)
  }
  if (cmd === "find") {
    return filterFind(rawOutput)
  }
  if (cmd === "grep" || cmd === "rg" || cmd === "ag") {
    return filterGrep(rawOutput)
  }
  if (cmd === "tree") {
    return filterFind(rawOutput) // similar structure
  }

  // ── Package managers ──────────────────────────────────────────────────────
  if (
    (cmd === "npm"  && (sub === "install" || sub === "i" || sub === "ci")) ||
    (cmd === "yarn" && (sub === "install" || sub === "")) ||
    (cmd === "pnpm" && (sub === "install" || sub === "i"))
  ) { return filterNpmInstall(rawOutput) }

  if (cmd === "pip" || cmd === "pip3" || cmd === "uv") {
    if (!sub || sub === "install" || sub === "sync" || sub === "add") return filterPipInstall(rawOutput)
  }

  // ── Build tools ───────────────────────────────────────────────────────────
  if (cmd === "brew") {
    return filterBrew(rawOutput)
  }
  if (cmd === "make") {
    if (sub === "test") return filterTestOutput(rawOutput)
    return filterMake(rawOutput)
  }
  if (cmd === "xcodebuild" || (cmd === "swift" && (sub === "build" || sub === "run" || sub === "test"))) {
    return filterXcode(rawOutput)
  }

  // ── HTTP clients ──────────────────────────────────────────────────────────
  if (cmd === "curl" || cmd === "wget" || cmd === "httpie" || cmd === "http") {
    return filterHttpOutput(rawOutput)
  }

  // ── GitHub CLI ────────────────────────────────────────────────────────────
  if (cmd === "gh") {
    if (sub === "pr" || sub === "issue" || sub === "repo" || sub === "run") return filterGhCli(rawOutput)
    return filterGeneric(rawOutput)
  }

  // ── cat / head / tail — file content reads via shell ─────────────────────
  // These produce raw file content — apply the generic deduplicator + truncate.
  if (cmd === "cat" || cmd === "head" || cmd === "tail") {
    return filterGeneric(rawOutput)
  }

  // ── Docker / Kubernetes ───────────────────────────────────────────────────
  if (cmd === "docker") {
    if (sub === "ps" || sub === "images") return filterDockerPs(rawOutput)
    if (sub === "logs")                   return filterDockerLogs(rawOutput)
    if (sub === "build") {
      // Docker build: keep only step headers, errors, and the final summary
      const clean = stripAnsi(rawOutput)
      const kept = lines(clean).filter(l =>
        /^Step\s+\d+/i.test(l) ||
        /^(ERROR|error|Successfully built|Successfully tagged|\[Error\])/i.test(l) ||
        /---> (Running|Using cache)/.test(l) ||
        /^Removing intermediate/.test(l)
      )
      return savings(rawOutput, kept.length ? kept.join("\n") : truncate(clean, 30))
    }
    return filterGeneric(rawOutput)
  }
  if (cmd === "docker-compose" || (cmd === "docker" && sub === "compose")) {
    return filterDockerPs(rawOutput)
  }
  if (cmd === "kubectl") {
    return filterKubectl(rawOutput)
  }

  // ── Generic fallback ──────────────────────────────────────────────────────
  return filterGeneric(rawOutput)
}
