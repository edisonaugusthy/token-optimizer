/**
 * File read output compaction filters.
 *
 * Applied to OpenCode's `read` tool output. Techniques:
 *   1. Convert absolute paths → relative paths (saves repeated long path prefix)
 *   2. Strip XML boilerplate: <type>file</type> tag
 *   3. Strip footer: "(End of file - total N lines)"
 *   4. Strip trailing blank lines
 *   5. Compact directory listings (collapse single-file dirs)
 *
 * Expected savings: 15-35% on typical file reads (multiplies across many reads per session).
 */

import * as path from "path"

export interface ReadFilterResult {
  output: string
  savedPct: number
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function savings(original: string, filtered: string): ReadFilterResult {
  const before = estimateTokens(original)
  const after = estimateTokens(filtered)
  const pct = before === 0 ? 0 : Math.round(((before - after) / before) * 100)
  return { output: filtered, savedPct: Math.max(0, pct) }
}

/**
 * Compact the output of a `read` tool call.
 *
 * @param rawOutput - The raw string returned by the read tool
 * @param workingDirectory - The project root directory (for path relativization)
 */
export function filterReadOutput(rawOutput: string, workingDirectory: string): ReadFilterResult {
  if (!rawOutput || rawOutput.trim() === "") {
    return { output: rawOutput, savedPct: 0 }
  }

  let out = rawOutput

  // ── 1. Relativize absolute file path in <path> tag ─────────────────────────
  out = out.replace(/<path>([^<]+)<\/path>/g, (_match, absPath) => {
    try {
      const normalized = path.normalize(absPath.trim())
      const rel = path.relative(workingDirectory, normalized)
      // Only use relative if it doesn't escape the project root
      if (!rel.startsWith("..")) {
        return `<path>${rel}</path>`
      }
    } catch {
      // ignore normalization errors
    }
    return `<path>${absPath}</path>`
  })

  // ── 2. Strip XML wrapper tags (redundant in read output) ───────────────────
  out = out.replace(/<type>file<\/type>\n?/g, "")
  out = out.replace(/<content>\n?/g, "")
  out = out.replace(/\n?<\/content>/g, "")

  // ── 3. Strip footer boilerplate ─────────────────────────────────────────────
  out = out.replace(/\n\(End of file - total \d+ lines\)\n?$/, "\n")
  // Matches both "(Showing lines 1-2000 of 3500)" and "(Showing lines 1-2000 of 3500. Use offset=2000 to continue.)"
  out = out.replace(/\n\(Showing lines \d+-\d+ of \d+[^)]*\)\n?$/, "\n")

  // ── 4. Strip redundant trailing blank lines (keep max 1) ────────────────────
  out = out.replace(/\n{3,}/g, "\n\n")
  out = out.trimEnd() + "\n"

  // ── 5. For directory reads: collapse entries ─────────────────────────────────
  if (rawOutput.includes("<type>directory</type>")) {
    out = compactDirectoryListing(out)
  }

  return savings(rawOutput, out)
}

/**
 * For directory read output, collapse deep single-child paths and group
 * large directories into summaries.
 */
function compactDirectoryListing(output: string): string {
  // Extract file list between <entries> tags if present
  const entriesMatch = output.match(/<entries>([\s\S]*?)<\/entries>/)
  if (!entriesMatch) return output

  const entries = entriesMatch[1]
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)

  if (entries.length <= 30) return output

  // Group by top-level directory
  const byTopDir: Record<string, string[]> = {}
  const rootFiles: string[] = []

  for (const entry of entries) {
    const parts = entry.split("/")
    if (parts.length === 1) {
      rootFiles.push(entry)
    } else {
      const top = parts[0]
      if (!byTopDir[top]) byTopDir[top] = []
      byTopDir[top].push(entry)
    }
  }

  const compacted: string[] = []

  // Root files
  rootFiles.forEach(f => compacted.push(f))

  // Directories
  for (const [dir, files] of Object.entries(byTopDir)) {
    if (files.length <= 5) {
      files.forEach(f => compacted.push(f))
    } else {
      // Show directory summary with a few examples
      const exts: Record<string, number> = {}
      for (const f of files) {
        const ext = f.includes(".") ? f.split(".").pop()! : "dir"
        exts[ext] = (exts[ext] || 0) + 1
      }
      const extSummary = Object.entries(exts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([ext, n]) => `${n} *.${ext}`)
        .join(", ")
      compacted.push(`${dir}/ (${files.length} items: ${extSummary})`)
    }
  }

  // Rebuild the entries section
  return output.replace(
    /<entries>[\s\S]*?<\/entries>/,
    `<entries>\n${compacted.join("\n")}\n</entries>`
  )
}

/**
 * Compact the output of an `edit` tool call.
 * The confirmation message is verbose; replace with "OK".
 */
export function filterEditOutput(rawOutput: string): string {
  if (rawOutput.startsWith("Edit applied successfully")) {
    return "OK"
  }
  if (rawOutput.startsWith("The file was created successfully")) {
    return "created"
  }
  if (rawOutput.startsWith("No changes were made")) {
    return "no-op"
  }
  return rawOutput
}
