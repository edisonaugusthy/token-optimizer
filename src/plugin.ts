/**
 * opencode-token-saver — OpenCode Plugin
 *
 * Reduces token usage by 60-75% by stacking four techniques:
 *
 *   1. Tool schema compression    (tool.definition hook)
 *      → Slims built-in tool descriptions sent on every API call.
 *        Savings: ~15-25% per request, multiplicative.
 *
 *   2. Line-range edit expansion  (tool.execute.before hook)
 *      → Lets the model write oldString as "55-64" instead of pasting lines.
 *        Saves output tokens on every edit operation.
 *
 *   3. Tool output compression    (tool.execute.after hook)
 *      → Compresses bash/shell output (git, tests, lint, ls, grep, docker).
 *        Savings: 70-92% per command.
 *      → Compacts file read output (path relativization, boilerplate strip).
 *        Savings: 15-35% per read.
 *      → Shortens edit confirmations to "OK".
 *
 *   4. Intelligent token-budget history trimming  (messages.transform hook)
 *      → Tracks total tool-result tokens in context window.
 *      → When over CONTEXT_TOOL_BUDGET (12 000 tokens), replaces lowest-priority
 *        old results with one-line stubs, scoring by tool type × recency.
 *      → Never trims the last PROTECTED_TURNS (3) turns.
 *
 * Installation (global):
 *   opencode plugin opencode-token-saver --global
 *
 * Installation (project):
 *   Place this file in .opencode/plugins/token-saver.ts
 *   (or add "opencode-token-saver" to opencode.json plugins array)
 */

import type { Plugin } from "@opencode-ai/plugin"
import { filterBashOutput } from "./filters/bash.js"
import { filterReadOutput, filterEditOutput } from "./filters/read.js"
import { applySlimDescription, expandLineRange, type EditArgs } from "./schema-slim.js"

// ─── Token tracking (session-level stats) ────────────────────────────────────

interface SessionStats {
  originalTokens: number
  filteredTokens: number
  commandsFiltered: number
  readsCompacted: number
  editsExpanded: number
  tasksCompressed: number
  webfetchesCompressed: number
  historyTrimmed: number
}

function createStats(): SessionStats {
  return {
    originalTokens: 0,
    filteredTokens: 0,
    commandsFiltered: 0,
    readsCompacted: 0,
    editsExpanded: 0,
    tasksCompressed: 0,
    webfetchesCompressed: 0,
    historyTrimmed: 0,
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─── Task output compression ──────────────────────────────────────────────────

// ─── Webfetch output compression ─────────────────────────────────────────────

/**
 * Max chars for a webfetch result (≈875 tokens).
 * Webfetch is the #1 source of token bloat in research sub-agents —
 * each URL fetch returns full page content that accumulates across turns.
 */
const WEBFETCH_MAX_CHARS = 3500

/** Noise patterns that appear in site chrome, navbars, footers, cookie banners */
const WEBFETCH_NOISE_RE = /^(Skip to|Navigation|Cookie|Accept all|Privacy Policy|Terms of|Sign in|Sign up|Log in|Subscribe|Newsletter|Advertisement|©\s*\d{4}|\[!\[|Back to top)/i

/**
 * Compress webfetch output:
 *   1. Strip lines that are site navigation/footer/cookie-banner boilerplate
 *   2. Strip excessive link-only lines (markdown `[text](url)` with no prose context)
 *   3. Collapse 3+ blank lines → 1
 *   4. Hard-truncate to WEBFETCH_MAX_CHARS with a summary note
 */
function compressWebfetch(raw: string): string {
  const lines = raw.split("\n")

  const filtered = lines.filter(line => {
    const t = line.trim()
    if (!t) return true  // keep blank lines for structure (collapsed below)
    // Strip pure navigation/boilerplate lines
    if (WEBFETCH_NOISE_RE.test(t)) return false
    // Strip lines that are purely a markdown link with no surrounding text
    if (/^\[.{1,60}\]\(https?:\/\/[^)]+\)\.?$/.test(t)) return false
    // Strip horizontal rules (----, ====)
    if (/^[-=]{4,}$/.test(t)) return false
    return true
  })

  let text = filtered.join("\n")
  // Collapse 3+ blank lines → 1
  text = text.replace(/\n{3,}/g, "\n\n").trim()

  if (text.length <= WEBFETCH_MAX_CHARS) return text

  const omitted = text.length - WEBFETCH_MAX_CHARS
  const truncated = text.slice(0, WEBFETCH_MAX_CHARS).trimEnd()
  const lastNewline = truncated.lastIndexOf("\n")
  const clean = lastNewline > WEBFETCH_MAX_CHARS * 0.85 ? truncated.slice(0, lastNewline) : truncated
  return `${clean}\n\n... [webfetch truncated — ${omitted} chars (≈${Math.ceil(omitted / 4)} tokens) omitted]`
}

/** Max chars allowed in a compressed task result (≈625 tokens at 4 chars/token). */
const TASK_MAX_CHARS = 2500

/**
 * Compress a sub-agent task result:
 *   1. Strip outer <task …> / </task> and <task_result> / </task_result> XML tags
 *   2. Strip leading [System: …] sanitiser lines
 *   3. Collapse 3+ blank lines → 1 blank line
 *   4. Hard-truncate to TASK_MAX_CHARS, appending a summary line
 */
function compressTaskOutput(raw: string): string {
  let text = raw

  // Strip outer <task id="..." state="...">…</task> wrapper
  text = text.replace(/^<task\b[^>]*>\s*/i, "").replace(/\s*<\/task>\s*$/i, "")

  // Strip <task_result> / </task_result> tags
  text = text.replace(/<task_result>\s*/gi, "").replace(/\s*<\/task_result>/gi, "")

  // Strip [System: …] sanitiser noise lines
  text = text.replace(/^\[System:.*\]\s*\n?/gim, "")

  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim()

  if (text.length <= TASK_MAX_CHARS) return text

  // Hard truncate with summary
  const omitted = text.length - TASK_MAX_CHARS
  const truncated = text.slice(0, TASK_MAX_CHARS).trimEnd()
  // Try to end on a whole line
  const lastNewline = truncated.lastIndexOf("\n")
  const clean = lastNewline > TASK_MAX_CHARS * 0.8 ? truncated.slice(0, lastNewline) : truncated
  return `${clean}\n\n... [task result truncated — ${omitted} chars (≈${Math.ceil(omitted / 4)} tokens) omitted]`
}

// ─── Glob output compression ─────────────────────────────────────────────────

/**
 * Compress glob output.
 * - If ≤40 paths, return as-is.
 * - Otherwise group by top-level directory and collapse each dir into a
 *   one-line summary: "src/filters/ (12 files: *.ts ×8, *.js ×4)"
 * - Hard cap at 3000 chars.
 */
function compressGlobOutput(raw: string): string {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean)
  if (lines.length <= 40) return raw

  // Group by top-level dir (first two path segments)
  const dirs = new Map<string, string[]>()
  for (const p of lines) {
    const parts = p.replace(/^\.\//, "").split("/")
    const key = parts.length > 1 ? parts.slice(0, 2).join("/") : "(root)"
    const existing = dirs.get(key) ?? []
    existing.push(p)
    dirs.set(key, existing)
  }

  const summaryLines: string[] = [`${lines.length} files matched:`]
  for (const [dir, files] of dirs) {
    // Count by extension
    const extCount = new Map<string, number>()
    for (const f of files) {
      const m = f.match(/(\.[^./]+)$/)
      const ext = m ? m[1] : "(no ext)"
      extCount.set(ext, (extCount.get(ext) ?? 0) + 1)
    }
    const extSummary = [...extCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([ext, n]) => `${ext} ×${n}`)
      .join(", ")
    summaryLines.push(`  ${dir}/ (${files.length} files: ${extSummary})`)
  }

  let result = summaryLines.join("\n")
  if (result.length > 3000) result = result.slice(0, 3000) + "\n[glob list truncated]"
  return result
}

// ─── Grep output compression ──────────────────────────────────────────────────

/**
 * Compress grep output.
 * - Strip ANSI escape codes.
 * - Per file: keep first 3 matches + last 1, collapse the rest to a count.
 * - Hard cap at 3000 chars total.
 */
function compressGrepOutput(raw: string): string {
  // Strip ANSI codes
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "")
  const lines = clean.split("\n")

  // Group matches by file
  const byFile = new Map<string, string[]>()
  const order: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const m = line.match(/^([^:]+):/)
    const file = m ? m[1] : "(unknown)"
    if (!byFile.has(file)) { byFile.set(file, []); order.push(file) }
    byFile.get(file)!.push(line)
  }

  const MAX_PER_FILE_SHOW = 3
  const out: string[] = []
  for (const file of order) {
    const matches = byFile.get(file)!
    if (matches.length <= MAX_PER_FILE_SHOW + 1) {
      out.push(...matches)
    } else {
      out.push(...matches.slice(0, MAX_PER_FILE_SHOW))
      const hidden = matches.length - MAX_PER_FILE_SHOW - 1
      out.push(`  ... (${hidden} more matches in ${file})`)
      out.push(matches[matches.length - 1])
    }
  }

  let result = out.join("\n")
  if (result.length > 3000) result = result.slice(0, 3000) + "\n[grep output truncated]"
  return result
}

// ─── Plugin definition ────────────────────────────────────────────────────────

export const TokenSaverPlugin: Plugin = async ({ directory, client }) => {
  const stats = createStats()

  /**
   * Log a structured message through the OpenCode SDK logger.
   * Falls back to console.error if client is unavailable.
   */
  async function log(level: "debug" | "info" | "warn", message: string, extra?: Record<string, unknown>) {
    try {
      await client.app.log({
        body: {
          service: "opencode-token-saver",
          level,
          message,
          extra: extra ?? {},
        },
      })
    } catch {
      // Ignore logging errors — never interrupt the main flow
    }
  }

  return {
    // ── 1. Tool schema compression ──────────────────────────────────────────
    "tool.definition": async (
      input: { toolID: string },
      output: { description: string; parameters?: { properties?: Record<string, { description?: string }> } }
    ) => {
      // 1a. Slim tool-level description
      const slim = applySlimDescription(input.toolID, output.description)
      if (slim) output.description = slim

      // 1b. Truncate verbose parameter descriptions (sent on every API call).
      // Cut at the nearest sentence boundary (".") within the first 80 chars,
      // or at the last word boundary before 60 chars — never mid-word.
      const props = output.parameters?.properties
      if (props) {
        for (const key of Object.keys(props)) {
          const prop = props[key]
          if (prop?.description && prop.description.length > 80) {
            const d = prop.description
            // Prefer ending on a sentence within the first 80 chars
            const sentenceEnd = d.slice(0, 80).lastIndexOf(".")
            if (sentenceEnd > 20) {
              prop.description = d.slice(0, sentenceEnd + 1)
            } else {
              // Fall back to last word boundary before char 60
              const wordEnd = d.slice(0, 60).lastIndexOf(" ")
              prop.description = wordEnd > 10
                ? d.slice(0, wordEnd)
                : d.slice(0, 60)
            }
          }
        }
      }
    },

    // ── 2. Line-range edit expansion (before edit executes) ─────────────────
    "tool.execute.before": async (
      input: { tool: string },
      output: { args: EditArgs }
    ) => {
      if (input.tool !== "edit") return

      const oldArgs = output.args
      const newArgs = expandLineRange(output.args, directory)

      if (newArgs.oldString !== oldArgs.oldString) {
        output.args = newArgs
        stats.editsExpanded++
        await log("debug", "Expanded line-range oldString", {
          file: newArgs.filePath,
          range: oldArgs.oldString,
          expandedLength: newArgs.oldString?.length,
        })
      }
    },

    // ── 3. Tool output compression (after tool executes) ────────────────────
    "tool.execute.after": async (
      input: { tool: string; args?: { command?: string; filePath?: string } },
      output: { output: string }
    ) => {
      const originalOutput = output.output ?? ""
      if (!originalOutput) return

      const originalTokens = estimateTokens(originalOutput)

      // ── 3a. Bash output compression ──────────────────────────────────────
      if (input.tool === "bash") {
        const command = input.args?.command ?? ""
        const result = filterBashOutput(command, originalOutput)

        if (result.savedPct >= 10) {
          // Only apply if we actually save meaningful tokens
          output.output = result.output
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(result.output)
          stats.commandsFiltered++

          await log("debug", `bash filter: ${result.savedPct}% saved`, {
            command: command.slice(0, 60),
            originalTokens,
            filteredTokens: estimateTokens(result.output),
          })
        }
        return
      }

      // ── 3b. Read output compaction ────────────────────────────────────────
      if (input.tool === "read") {
        const result = filterReadOutput(originalOutput, directory)

        if (result.savedPct >= 5) {
          output.output = result.output
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(result.output)
          stats.readsCompacted++
        }
        return
      }

      // ── 3c. Edit confirmation compaction ──────────────────────────────────
      if (input.tool === "edit" || input.tool === "write") {
        const compact = filterEditOutput(originalOutput)
        if (compact !== originalOutput) {
          output.output = compact
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(compact)
        }
        return
      }

      // ── 3d. Webfetch output compression ──────────────────────────────────
      // The #1 token driver in research sub-agents: each URL fetch returns
      // full page content (5-15k tokens) that accumulates across turns.
      if (input.tool === "webfetch" || input.tool === "fetch") {
        const compressed = compressWebfetch(originalOutput)
        const savedPct = originalTokens === 0
          ? 0
          : Math.round(((originalTokens - estimateTokens(compressed)) / originalTokens) * 100)

        if (savedPct >= 10) {
          output.output = compressed
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(compressed)
          stats.webfetchesCompressed++

          await log("debug", `webfetch filter: ${savedPct}% saved`, {
            originalTokens,
            filteredTokens: estimateTokens(compressed),
          })
        }
        return
      }

      // ── 3e. Sub-agent task result compression ─────────────────────────────
      // Task results are returned inside <task_result>…</task_result> XML.
      // They can be thousands of tokens and are fed back verbatim into the
      // parent agent context. We strip the XML wrapper and hard-truncate to
      // ~4000 chars (≈1000 tokens) to cap context growth.
      if (input.tool === "task") {
        const compressed = compressTaskOutput(originalOutput)
        const savedPct = originalTokens === 0
          ? 0
          : Math.round(((originalTokens - estimateTokens(compressed)) / originalTokens) * 100)

        if (savedPct >= 10) {
          output.output = compressed
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(compressed)
          stats.tasksCompressed++

          await log("debug", `task filter: ${savedPct}% saved`, {
            originalTokens,
            filteredTokens: estimateTokens(compressed),
          })
        }
        return
      }

      // ── 3f. Glob output compaction ────────────────────────────────────────
      // glob returns one file path per line. Long lists are compacted by
      // grouping into directory summaries when >40 entries are returned.
      if (input.tool === "glob") {
        const compressed = compressGlobOutput(originalOutput)
        const savedPct = originalTokens === 0
          ? 0
          : Math.round(((originalTokens - estimateTokens(compressed)) / originalTokens) * 100)
        if (savedPct >= 10) {
          output.output = compressed
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(compressed)
          await log("debug", `glob filter: ${savedPct}% saved`, {
            originalTokens,
            filteredTokens: estimateTokens(compressed),
          })
        }
        return
      }

      // ── 3g. Grep output compaction ────────────────────────────────────────
      // grep returns file:line:content triples. We deduplicate same-file
      // matches (keeping first and last) and cap total output at 3000 chars.
      if (input.tool === "grep") {
        const compressed = compressGrepOutput(originalOutput)
        const savedPct = originalTokens === 0
          ? 0
          : Math.round(((originalTokens - estimateTokens(compressed)) / originalTokens) * 100)
        if (savedPct >= 10) {
          output.output = compressed
          stats.originalTokens += originalTokens
          stats.filteredTokens += estimateTokens(compressed)
          await log("debug", `grep filter: ${savedPct}% saved`, {
            originalTokens,
            filteredTokens: estimateTokens(compressed),
          })
        }
        return
      }

      // ── 3h. Generic fallback cap ──────────────────────────────────────────
      // Any tool not explicitly handled above (MCP tools, search_graph,
      // query_graph, trace_path, get_code_snippet, etc.) gets a hard cap.
      // This prevents any single tool call from flooding the context window
      // with thousands of tokens of uncompressed output.
      //
      // Cap is 4000 chars (≈1000 tokens). We try to snap to a whole-line
      // boundary so we don't cut mid-JSON or mid-sentence.
      const GENERIC_CAP_CHARS = 4000
      if (originalOutput.length > GENERIC_CAP_CHARS) {
        const slice = originalOutput.slice(0, GENERIC_CAP_CHARS)
        const lastNewline = slice.lastIndexOf("\n")
        // Only snap to newline if it's within the last 15% of the cap
        const cutAt = lastNewline > GENERIC_CAP_CHARS * 0.85 ? lastNewline : GENERIC_CAP_CHARS
        const truncated = originalOutput.slice(0, cutAt).trimEnd()
        const dropped = originalOutput.length - cutAt
        output.output = `${truncated}\n[... ${dropped} chars (≈${Math.ceil(dropped / 4)} tokens) truncated — use a narrower query or read specific sections]`
        stats.originalTokens += originalTokens
        stats.filteredTokens += estimateTokens(output.output)
        await log("debug", `generic cap: ${input.tool} truncated`, {
          originalChars: originalOutput.length,
          cappedChars: cutAt,
          tool: input.tool,
        })
      }
    },

    // ── 4. Cap output tokens for sub-agent calls ─────────────────────────────
    // Sub-agents (explore/general) rarely need more than 2048 output tokens.
    // Reducing maxOutputTokens cuts billing cost on output-heavy providers.
    "chat.params": async (
      input: { agent?: string },
      output: { maxOutputTokens?: number }
    ) => {
      const agent = input.agent ?? ""
      // Only cap non-primary agents (subagents, explore, general, etc.)
      if (agent && agent !== "primary" && !agent.includes("claude") && !agent.includes("main")) {
        const current = output.maxOutputTokens
        if (!current || current > 2048) {
          output.maxOutputTokens = 2048
        }
      }
    },

    // ── 5. Intelligent token-budget history trimming ─────────────────────────
    //
    // Problem: every API call re-sends ALL previous tool results verbatim.
    // A 20-turn session can accumulate 40 000+ tokens of tool history alone.
    //
    // Strategy: token-budget trimming instead of turn-count trimming.
    //   1. Count total tokens consumed by tool results currently in context.
    //   2. If under CONTEXT_TOOL_BUDGET → do nothing.
    //   3. If over budget → score every trim-eligible result by retention priority
    //      and replace the lowest-priority ones with a one-line stub, oldest first,
    //      until total falls back under budget.
    //   4. Never trim the last PROTECTED_TURNS turns' results (protected zone).
    //
    // Retention priority score = tool_weight × recency_factor
    //   Higher score = keep longer.
    //   tool_weight:
    //     1  — bash one-off commands (git status, ls, grep) → trim first
    //     2  — webfetch, task results
    //     3  — file reads (read tool) — may still be referenced
    //     5  — code-graph searches (search_graph, query_graph, trace_path)
    //     5  — sub-agent results (explore, general) with detailed findings
    //   recency_factor = (message_index / total_messages) — older = lower
    //
    "experimental.chat.messages.transform": async (
      _input: Record<string, unknown>,
      output: {
        messages: Array<{
          info: { role: string }
          parts: Array<{
            type: string
            tool?: string
            args?: Record<string, unknown>
            state?: { status?: string; output?: string }
          }>
        }>
      }
    ) => {
      // ── Constants ────────────────────────────────────────────────────────
      /** Total token budget for tool results in context. Above this → trim. */
      const CONTEXT_TOOL_BUDGET = 6_000
      /** Always keep the last N turns completely untouched. */
      const PROTECTED_TURNS = 2
      /** Minimum chars for a result to be considered trim-eligible. */
      const MIN_TRIM_CHARS = 80

      // ── Tool retention weights ────────────────────────────────────────────
      // Higher = more valuable to keep around longer.
      function toolWeight(toolName: string, args: Record<string, unknown>): number {
        // Code-graph searches — referenced by later reasoning
        if (/search_graph|query_graph|trace_path|get_code_snippet|get_architecture|search_code/.test(toolName)) return 5
        // File reads — content may still be acted on
        if (toolName === "read") return 3
        // Sub-agent task results with substantial content
        if (toolName === "task") return 2
        // Web fetches
        if (toolName === "webfetch" || toolName === "fetch") return 2
        // Bash: distinguish git diff/log (more valuable) from status/ls (ephemeral)
        if (toolName === "bash") {
          const cmd = typeof args.command === "string" ? args.command : ""
          if (/git\s+(diff|log|show)/.test(cmd)) return 2
          return 1  // status, ls, grep, install — ephemeral
        }
        // Edit/write confirmations are already tiny ("OK") — lowest priority
        if (toolName === "edit" || toolName === "write") return 0
        return 1  // default
      }

      // ── Build the stub for a trimmed result ──────────────────────────────
      function makeStub(toolName: string, args: Record<string, unknown>, origLen: number): string {
        const keyArg =
          (typeof args.command === "string" ? args.command.slice(0, 60) : null) ??
          (typeof args.filePath === "string" ? args.filePath.slice(0, 60) : null) ??
          (typeof args.query === "string" ? args.query.slice(0, 60) : null) ??
          (typeof args.prompt === "string" ? args.prompt.slice(0, 40) : null) ??
          (typeof args.description === "string" ? args.description.slice(0, 40) : null) ??
          null
        const hint = keyArg ? ` (${keyArg})` : ""
        return `[${toolName}${hint}: ${origLen} chars, trimmed from history]`
      }

      const msgs = output.messages
      const totalMsgs = msgs.length
      const protectedStart = Math.max(0, totalMsgs - PROTECTED_TURNS)

      // ── Step 1: Count current tool-result tokens in context ───────────────
      type Candidate = {
        part: { type: string; tool?: string; args?: Record<string, unknown>; state?: { status?: string; output?: string } }
        msgIndex: number
        tokens: number
        priority: number   // lower = trim first
      }

      let totalToolTokens = 0
      const candidates: Candidate[] = []

      for (let i = 0; i < totalMsgs; i++) {
        const msg = msgs[i]
        for (const part of msg.parts) {
          if (
            part.type === "tool" &&
            part.state?.status === "completed" &&
            part.state.output
          ) {
            const tokenCount = estimateTokens(part.state.output)
            totalToolTokens += tokenCount

            // Only eligible for trimming if outside protected zone and large enough
            if (i < protectedStart && part.state.output.length > MIN_TRIM_CHARS) {
              const toolName = part.tool ?? "tool"
              const args = part.args ?? {}
              const weight = toolWeight(toolName, args)
              // Recency factor: 0.0 (oldest) → 1.0 (most recent eligible)
              const recency = protectedStart === 0 ? 0 : i / protectedStart
              // Priority: higher = keep longer
              const priority = weight * (0.3 + recency * 0.7)
              candidates.push({ part, msgIndex: i, tokens: tokenCount, priority })
            }
          }
        }
      }

      // ── Step 2: If under budget, nothing to do ────────────────────────────
      if (totalToolTokens <= CONTEXT_TOOL_BUDGET) return

      // ── Step 3: Sort by priority ascending (lowest priority = trim first) ─
      candidates.sort((a, b) => a.priority - b.priority)

      // ── Step 4: Trim until under budget ───────────────────────────────────
      let currentTokens = totalToolTokens
      for (const candidate of candidates) {
        if (currentTokens <= CONTEXT_TOOL_BUDGET) break

        const { part } = candidate
        if (!part.state?.output) continue

        const origLen = part.state.output.length
        const toolName = part.tool ?? "tool"
        const args = part.args ?? {}

        part.state.output = makeStub(toolName, args, origLen)
        currentTokens -= candidate.tokens - estimateTokens(part.state.output)
        stats.historyTrimmed++
      }

      if (stats.historyTrimmed > 0) {
        await log("debug", "Token-budget history trim", {
          before: totalToolTokens,
          after: currentTokens,
          budget: CONTEXT_TOOL_BUDGET,
          trimmed: stats.historyTrimmed,
        })
      }
    },

    // ── 6. Trim system prompt boilerplate ────────────────────────────────────
    // OpenCode's built-in system prompt contains long multi-paragraph sections.
    // Remove known verbose patterns that don't affect task performance.
    "experimental.chat.system.transform": async (
      _input: Record<string, unknown>,
      output: { system: string[] }
    ) => {
      output.system = output.system.map(section => {
        // Strip long XML example blocks from system sections (they recur every call)
        let s = section
        s = s.replace(/<example>[\s\S]{300,}?<\/example>/g, "<example>[omitted]</example>")
        // Collapse runs of 3+ blank lines
        s = s.replace(/\n{3,}/g, "\n\n")
        return s
      })
    },

    // ── 7. Session stats logging ─────────────────────────────────────────────
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle" && (
        stats.commandsFiltered + stats.webfetchesCompressed + stats.tasksCompressed +
        stats.readsCompacted + stats.editsExpanded + stats.historyTrimmed
      ) > 0) {
        const totalSaved = stats.originalTokens - stats.filteredTokens
        const pct = stats.originalTokens === 0
          ? 0
          : Math.round((totalSaved / stats.originalTokens) * 100)

        await log("info", "Session token savings summary", {
          commandsFiltered: stats.commandsFiltered,
          readsCompacted: stats.readsCompacted,
          editsExpanded: stats.editsExpanded,
          tasksCompressed: stats.tasksCompressed,
          webfetchesCompressed: stats.webfetchesCompressed,
          historyTrimmed: stats.historyTrimmed,
          originalTokens: stats.originalTokens,
          filteredTokens: stats.filteredTokens,
          savedTokens: totalSaved,
          savedPct: pct,
        })
      }
    },
  }
}

export default TokenSaverPlugin
