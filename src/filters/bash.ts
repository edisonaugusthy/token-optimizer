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

/** Remove excessive blank lines (3+ consecutive → 1) */
function deduplicateBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim()
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

const IMPORTANT_LINE_RE =
  /\b(error|failed|failure|fatal|panic|exception|traceback|warning|warn|denied|forbidden|unauthorized|timeout|timed out|not found|cannot|can't|conflict|rejected|invalid|vulnerabilit|deprecated|npm ERR!|npm error|ERR!)\b/i

function uniquePush(target: string[], seen: Set<string>, line: string): void {
  if (!line || seen.has(line)) return
  target.push(line)
  seen.add(line)
}

function extractImportantLines(ls: string[], maxLines: number): string[] {
  const important = ls.filter(line => IMPORTANT_LINE_RE.test(line)).slice(0, maxLines)
  return important
}

function truncateImportant(text: string, maxLines: number): string {
  const ls = lines(text)
  if (ls.length <= maxLines) return text

  const kept: string[] = []
  const seen = new Set<string>()
  const important = extractImportantLines(ls, Math.max(4, Math.floor(maxLines * 0.35)))

  for (const line of ls.slice(0, Math.ceil(maxLines * 0.4))) uniquePush(kept, seen, line)
  for (const line of important) uniquePush(kept, seen, line)
  for (const line of ls.slice(-Math.ceil(maxLines * 0.25))) uniquePush(kept, seen, line)

  const compact = kept.slice(0, maxLines - 1)
  compact.push(`... (${ls.length - compact.length} lines omitted; kept head/tail/errors)`)
  return compact.join("\n")
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

  if (cmd === "fetch") {
    const refs = lines(clean).filter(l => l.includes("->") || l.includes("new commit"))
    return savings(raw, refs.length ? refs.join("\n") : "ok")
  }

  return savings(raw, clean || "ok")
}

// ─── Directory listing filters ────────────────────────────────────────────────

function filterLs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
}

function filterFind(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
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
  return savings(raw, deduplicateBlankLines(clean))
}

// ─── Test runner filters (keep ALL output, strip only progress/spinners) ──────

function filterTestOutput(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no output)")

  // Keep all test output, only strip progress bars/spinners and dedup blank lines
  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip progress bars, spinners, timing noise
    if (/^\s*(\d+(\.\d+)?s|\d+ms)\s*$/.test(t)) return false
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^\s*PASS\s+\d+\s+FAIL\s+\d+/.test(t)) return true
    if (/^\s*\d+\s+passing|\d+\s+failing|\d+\s+pending/.test(t)) return true
    return true
  })

  const joined = lines.join("\n")
  if (!joined.trim()) return savings(raw, "(no test output)")
  return savings(raw, deduplicateBlankLines(joined))
}

// ─── Linter / build filters (keep ALL output, strip only progress/spinners) ──────

function filterEslint(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no output)")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip progress: "Checking...", "Linting..."
    if (/^(Checking|Linting|Running).*\.\.\.$/.test(t)) return false
    if (/^\s*\d+\/(\d+)/.test(t)) return false
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

function filterTsc(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no output)")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip "Found X errors" summary
    if (/^Found \d+ errors?$/.test(t)) return false
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

function filterRuff(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no output)")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^\s*(\d+)?\s*files?\s+checked/.test(t)) return true
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

function filterDockerBuild(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip CACHED step indicators
    if (t === "CACHED") return false
    if (/^#\d+\s+\d+\.\d+/.test(t)) return false  // BuildKit step numbers
    if (/^ ---> Using cache/.test(t)) return false
    return true  // keep all build output, errors, warnings
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── Docker / Kubernetes filters ─────────────────────────────────────────────

function filterDockerPs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
}

function filterDockerLogs(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
}

function filterKubectl(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
}

// ─── Package manager filters ──────────────────────────────────────────────────

function filterNpmInstall(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  // Keep all output, only strip progress bars
  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip npm progress bars
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^>\s/.test(t)) return false  // pacote progress
    if (/^npm (http|WARN) fetch/.test(t)) return false
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

function filterPackageMetadata(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no output)")

  // Try to parse JSON if it looks like package metadata
  const jsonStart = clean.search(/[\[{]/)
  const jsonEnd = Math.max(clean.lastIndexOf("]"), clean.lastIndexOf("}"))
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1))
      const pretty = JSON.stringify(parsed, null, 2)
      return savings(raw, deduplicateBlankLines(pretty))
    } catch {
      // Not valid JSON, fall through
    }
  }

  // Keep all content, dedup blank lines
  return savings(raw, deduplicateBlankLines(clean))
}

function filterNpmRunScript(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  // Keep all build output, only strip spinners/progress
  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^>\s/.test(t)) return false
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── pip / uv install filter ─────────────────────────────────────────────────

function filterPipInstall(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip pip progress bars
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^Collecting\s+/.test(t) && t.length < 30) return false
    if (/^Downloading\s+/.test(t)) return false
    if (/^Installing collected packages/.test(t)) return false
    return true  // keep errors, warnings, "Successfully installed", "Requirement already satisfied"
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── brew filter ─────────────────────────────────────────────────────────────

function filterBrew(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    if (/^==> Downloading/.test(t)) return false
    if (/^==> Pouring/.test(t)) return false
    if (/^==> Caveats/.test(t)) return true
    if (/^==> Summary/.test(t)) return true
    if (/^Error:/.test(t)) return true
    if (/^Warning:/.test(t)) return true
    if (/already installed/.test(t)) return true
    if (/🍺/.test(t)) return true
    if (/\binstalled\b/.test(t)) return true
    if (/\bpoured\b/.test(t)) return true
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── make filter ─────────────────────────────────────────────────────────────

function filterMake(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip "Building X", "Scanning deps", progress, directory enter/leave
    if (/^\[\s*\d+%\s*\]\s+(Building|Scanning|Linking)/.test(t)) return false
    if (/^make\[\d+\]: (Entering|Leaving) directory/.test(t)) return false
    return true  // keep all errors, warnings, "make[1]: *** [target] Error", commands
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── curl / wget filter ──────────────────────────────────────────────────────

function filterHttpOutput(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "(no output)")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip curl/wget progress bars and spinners
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^\s*(\d+(\.\d+)?[KM]?B\/s|ETA|\d+%\s*$)/.test(t)) return false
    if (/^[>*]\s/.test(t)) return false  // curl verbose > request, < response
    return true  // keep status line, headers, body
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── go build / mod filter ───────────────────────────────────────────────────

function filterGoBuild(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    if (/^\s*[\/\\|]\s*\d+%?\s*$/.test(t)) return false
    if (/^go: (downloading|verifying|extracting)/.test(t)) return false
    return true  // keep all errors, warnings, file:line output
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

function filterGoMod(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    if (/^go: (downloading|verifying|extracting)/.test(t)) return false
    return true
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── xcodebuild / swift build filter ─────────────────────────────────────────

function filterXcode(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  if (!clean) return savings(raw, "ok")

  const lines = clean.split("\n").filter(l => {
    const t = l.trim()
    // Strip "Compiling", "Linking", progress bars
    if (/^\[\s*\d+\/\d+\]/.test(t)) return false
    if (/^\s*(Compile|Link|Copy|Process|Generate|Sign|Touch)\s+/.test(t)) return false
    return true  // keep all errors, warnings, build status
  })

  return savings(raw, deduplicateBlankLines(lines.join("\n")))
}

// ─── Generic fallback filter ──────────────────────────────────────────────────

function filterGeneric(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
}

// ─── gh CLI filter ───────────────────────────────────────────────────────────

function filterGhCli(raw: string): FilterResult {
  const clean = stripAnsi(raw).trim()
  return savings(raw, deduplicateBlankLines(clean))
}

// ─── Command router ───────────────────────────────────────────────────────────

/**
 * Parse the first 1-3 words of a command to determine the filter to apply.
 * e.g. "git status --short" → tokens: ["git", "status"]
 */
function parseCommand(command: string): string[] {
  const segments = command.trim().split(/\s+(?:&&|\|\||;)\s+/)
  const active = segments[segments.length - 1] ?? command
  const tokens = active.trim().split(/\s+/).filter(Boolean)
  while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0] ?? "")) tokens.shift()
  if (tokens[0] === "env") {
    tokens.shift()
    while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0] ?? "")) tokens.shift()
  }
  if (tokens[0] === "time" || tokens[0] === "command" || tokens[0] === "noglob") tokens.shift()
  return tokens.slice(0, 8)
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

  if ((cmd === "bun" && sub === "run") || (cmd === "deno" && sub === "task")) {
    return filterNpmRunScript(rawOutput)
  }
  if (cmd === "turbo" || cmd === "nx" || cmd === "vite" || cmd === "next") {
    return filterNpmRunScript(rawOutput)
  }

  if (
    (cmd === "npm" && ["pack", "publish", "view", "info", "show", "version"].includes(sub ?? "")) ||
    (cmd === "yarn" && ["pack", "publish", "info", "npm"].includes(sub ?? "")) ||
    (cmd === "pnpm" && ["pack", "publish", "view", "info"].includes(sub ?? ""))
  ) { return filterPackageMetadata(rawOutput) }

  // ── pnpm dlx — re-route by the actual executed package ───────────────────
  if (cmd === "pnpm" && sub === "dlx" && sub2) {
    return filterBashOutput(tokens.slice(2).join(" "), rawOutput)
  }
  if ((cmd === "npx" || cmd === "bunx" || cmd === "uvx") && sub) {
    return filterBashOutput(tokens.slice(1).join(" "), rawOutput)
  }
  if ((cmd === "npm" && sub === "exec" && sub2) || (cmd === "pnpm" && sub === "exec" && sub2) || (cmd === "yarn" && sub === "dlx" && sub2)) {
    return filterBashOutput(tokens.slice(2).join(" "), rawOutput)
  }
  if (cmd === "uv" && sub === "run" && sub2) {
    return filterBashOutput(tokens.slice(2).join(" "), rawOutput)
  }
  if ((cmd === "poetry" && sub === "run" && sub2) || (cmd === "pipenv" && sub === "run" && sub2) || (cmd === "bundle" && sub === "exec" && sub2)) {
    return filterBashOutput(tokens.slice(2).join(" "), rawOutput)
  }

  // ── Test runners ──────────────────────────────────────────────────────────
  if (
    (cmd === "npm"   && sub === "test") ||
    (cmd === "npx"   && (sub === "jest" || sub === "vitest" || sub === "mocha")) ||
    (cmd === "yarn"  && sub === "test") ||
    (cmd === "pnpm"  && sub === "test") ||
    (cmd === "bun"   && sub === "test") ||
    (cmd === "deno"  && sub === "test") ||
    cmd === "jest" || cmd === "vitest" || cmd === "mocha" ||
    cmd === "tox" || cmd === "nox" || cmd === "phpunit" || cmd === "pest"
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
  if (cmd === "playwright" || (cmd === "npx" && sub === "playwright")) {
    return filterTestOutput(rawOutput)
  }
  if ((cmd === "mvn" || cmd === "mvnw" || cmd === "./mvnw") && ["test", "verify", "package", "install"].includes(sub ?? "")) {
    return filterTestOutput(rawOutput)
  }
  if ((cmd === "gradle" || cmd === "gradlew" || cmd === "./gradlew") && /test|check|build/i.test(sub ?? "")) {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "dotnet" && ["test", "build", "run"].includes(sub ?? "")) {
    return filterTestOutput(rawOutput)
  }
  if (cmd === "mix" && (sub === "test" || sub === "compile")) {
    return sub === "test" ? filterTestOutput(rawOutput) : filterGeneric(rawOutput)
  }
  if (cmd === "composer" && ["test", "phpunit"].includes(sub ?? "")) {
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
  if (cmd === "mypy" || cmd === "pyright" || cmd === "pylint") {
    return filterTestOutput(rawOutput)
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
  if (cmd === "cmake" || cmd === "ninja" || cmd === "meson") {
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
    if (sub === "build") return filterDockerBuild(rawOutput)
    return filterGeneric(rawOutput)
  }
  if (cmd === "docker-compose" || (cmd === "docker" && sub === "compose")) {
    return filterDockerPs(rawOutput)
  }
  if (cmd === "kubectl") {
    return filterKubectl(rawOutput)
  }
  if (cmd === "helm" || cmd === "terraform") {
    return filterGeneric(rawOutput)
  }

  // ── Generic fallback ──────────────────────────────────────────────────────
  return filterGeneric(rawOutput)
}
