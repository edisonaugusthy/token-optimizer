/**
 * Tool schema compression + line-range edit expansion.
 *
 * Two techniques:
 *
 * 1. SLIM DESCRIPTIONS
 *    Tool descriptions are sent with every API call. Replacing verbose multi-sentence
 *    descriptions with short one-liners saves 15-25% per request — multiplicatively
 *    across every step in a session.
 *
 * 2. LINE-RANGE EDIT EXPANSION
 *    Normally, `edit` requires oldString to be the exact file content to match.
 *    With this hook, the model can write oldString as a line range like "55-64"
 *    and we expand it to the actual file content before the edit runs.
 *    This eliminates the need for the model to copy/paste lines verbatim.
 *
 * Based on: OpenSlimedit (ASidorenkoCode) — Apache 2.0
 * Extended with additional tools and parameter description stripping.
 */

import * as fs from "fs"
import * as path from "path"

// ─── Slim tool descriptions ───────────────────────────────────────────────────

/**
 * Minimal one-liner descriptions for all built-in OpenCode tools.
 * These replace the default verbose descriptions that are sent on every API call.
 */
export const SLIM_DESCRIPTIONS: Record<string, string> = {
  // File I/O
  read:         "Read file content.",
  write:        "Write file.",
  edit:         "Edit file. oldString can be line range '55-64' instead of full content.",
  apply_patch:  "Apply a patch to files.",
  multiedit:    "Apply multiple edits to a file.",

  // Shell
  bash:         "Run shell command.",

  // Search
  glob:         "Find files by pattern.",
  grep:         "Search file contents.",
  list:         "List directory contents.",

  // Web
  fetch:        "Fetch a URL.",
  webfetch:     "Fetch URL and return content.",

  // Task management
  todowrite:    "Write todo list.",
  todoread:     "Read todo list.",
  task:         "Launch subagent. Args: description, prompt, subagent_type.",

  // Thinking
  think:        "Think through a problem.",

  // UI / interaction
  question:     "Ask user a question with choices.",
  lsp:          "Query LSP: diagnostics, hover, completions.",

  // codebase-memory-mcp
  search_graph:       "Search code graph for functions/classes/routes.",
  trace_path:         "Trace callers/callees through code graph.",
  get_code_snippet:   "Read source for a function/class by qualified name.",
  query_graph:        "Run Cypher query against code knowledge graph.",
  get_architecture:   "Get high-level architecture overview.",
  index_repository:   "Index a repository into the knowledge graph.",
  search_code:        "Graph-augmented grep with structural ranking.",
  index_status:       "Get indexing status of a project.",
  detect_changes:     "Detect code changes and their impact.",
  manage_adr:         "Create or update Architecture Decision Records.",
  get_graph_schema:   "Get knowledge graph schema.",
  list_projects:      "List all indexed projects.",
  ingest_traces:      "Ingest runtime traces into knowledge graph.",
  delete_project:     "Delete a project from the index.",

  // Figma
  figma_get_design_context:       "Get design context for a Figma node.",
  figma_get_metadata:             "Get Figma node metadata (structure/IDs).",
  figma_get_screenshot:           "Get screenshot of a Figma node.",
  figma_use_figma:                "Create/edit designs in Figma via Plugin API.",
  figma_search_design_system:     "Search design system components/variables.",
  figma_get_libraries:            "Get design libraries for a Figma file.",
  figma_generate_figma_design:    "Capture a web page into Figma.",
  figma_generate_diagram:         "Create a Mermaid diagram in FigJam.",
  figma_create_new_file:          "Create a new Figma file.",
  figma_upload_assets:            "Upload images into a Figma file.",
  figma_whoami:                   "Get authenticated Figma user info.",

  // GitHub
  "github-search_code":           "Search code across GitHub repos.",
  "github-list_issues":           "List issues in a GitHub repo.",
  "github-list_pull_requests":    "List pull requests in a GitHub repo.",
  "github-get_file_contents":     "Get file contents from GitHub repo.",
  "github-list_commits":          "List commits in a GitHub repo.",
  "github-search_repositories":   "Search GitHub repositories.",
  "github-pull_request_read":     "Read pull request details/diff/reviews.",
  "github-issue_read":            "Read issue details/comments.",
  "github-search_issues":         "Search issues across GitHub.",
  "github-search_pull_requests":  "Search pull requests across GitHub.",
  "github-get_commit":            "Get details for a GitHub commit.",
  "github-list_branches":         "List branches in a GitHub repo.",
  "github-get_latest_release":    "Get latest release of a GitHub repo.",

  // Jira
  "jira-jira_get_issue":          "Get Jira issue details.",
  "jira-jira_search":             "Search Jira issues with JQL.",
  "jira-jira_get_project_issues": "Get all issues for a Jira project.",
  "jira-jira_get_transitions":    "Get available status transitions.",
  "jira-jira_get_sprints_from_board": "Get sprints from a Jira board.",
  "jira-jira_get_sprint_issues":  "Get issues from a Jira sprint.",
  "jira-jira_get_all_projects":   "Get all accessible Jira projects.",

  // Slack
  "slack-slack_read_channel":     "Read messages from a Slack channel.",
  "slack-slack_search_public":    "Search public Slack messages.",
  "slack-slack_read_thread":      "Read a Slack thread.",
  "slack-slack_search_channels":  "Search Slack channels by name.",
  "slack-slack_search_users":     "Search Slack users.",
}

/**
 * Apply slim description to a tool definition.
 * Called from tool.definition hook.
 */
export function applySlimDescription(toolID: string, currentDescription: string): string | null {
  const slim = SLIM_DESCRIPTIONS[toolID]
  if (!slim) return null  // no override — leave as-is
  // Don't shrink if the current description is already shorter
  if (currentDescription && currentDescription.length <= slim.length) return null
  return slim
}

function cleanDescription(description: string): string {
  let text = description.replace(/\s+/g, " ").trim()
  text = text.replace(/\b(?:for example|example|examples|e\.g\.)[:\s].*$/i, "").trim()
  text = text.replace(/\bdefaults? to\b.*$/i, "").trim()
  text = text.replace(/\bif omitted\b.*$/i, "").trim()
  text = text.replace(/\bthis parameter\b/gi, "parameter")
  text = text.replace(/[`*_>#|]/g, "")
  if (text.length <= 90) return text
  const sentenceEnd = text.slice(0, 90).lastIndexOf(".")
  if (sentenceEnd > 24) return text.slice(0, sentenceEnd + 1)
  const wordEnd = text.slice(0, 72).lastIndexOf(" ")
  return wordEnd > 24 ? text.slice(0, wordEnd) : text.slice(0, 72)
}

export function cleanSchemaDescriptions(value: unknown): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) cleanSchemaDescriptions(item)
    return
  }

  const obj = value as Record<string, unknown>
  if (typeof obj.description === "string") {
    const cleaned = cleanDescription(obj.description)
    if (cleaned && cleaned.length < obj.description.length) {
      obj.description = cleaned
    }
  }
  if (typeof obj.title === "string" && obj.title.length > 80) {
    delete obj.title
  }
  if (typeof obj.examples !== "undefined") {
    delete obj.examples
  }

  for (const child of Object.values(obj)) {
    cleanSchemaDescriptions(child)
  }
}

// ─── Line-range edit expansion ────────────────────────────────────────────────

/** Matches "55" or "55-64" or "55 - 64" */
const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

export interface EditArgs {
  filePath?: string
  oldString?: string
  newString?: string
  [key: string]: unknown
}

/**
 * Expand a line-range oldString to actual file content.
 *
 * Algorithm:
 *   1. If oldString already exists verbatim in the file → no-op (exact match, safe)
 *   2. If oldString matches LINE_RANGE_RE → read those lines from file, replace oldString
 *   3. Otherwise → no-op
 *
 * This is non-destructive: if the range is out of bounds or the file can't be read,
 * we leave args unchanged and let the edit tool fail with its own error.
 */
export function expandLineRange(
  args: EditArgs,
  workingDirectory: string
): EditArgs {
  if (!args.oldString || !args.filePath) return args

  // Resolve path
  let filePath: string
  try {
    filePath = path.isAbsolute(args.filePath)
      ? path.normalize(args.filePath)
      : path.resolve(workingDirectory, args.filePath)
  } catch {
    return args
  }

  // Read file content
  let content: string
  try {
    content = fs.readFileSync(filePath, "utf-8")
  } catch {
    return args  // file not readable — leave args alone
  }

  // Step 1: Check for exact match — no expansion needed
  if (content.includes(args.oldString)) return args

  // Step 2: Try line-range expansion
  const trimmed = args.oldString.trim()
  const match = trimmed.match(LINE_RANGE_RE)
  if (!match) return args  // not a line range — pass through

  const startLine = parseInt(match[1], 10)
  const endLine = match[2] ? parseInt(match[2], 10) : startLine

  const fileLines = content.split("\n")
  const maxLine = fileLines.length

  // Validate range bounds
  if (
    startLine < 1 ||
    endLine < startLine ||
    startLine > maxLine ||
    endLine > maxLine
  ) {
    return args  // out of bounds — leave alone
  }

  // Extract lines (1-indexed, inclusive)
  const extracted = fileLines.slice(startLine - 1, endLine).join("\n")

  return {
    ...args,
    oldString: extracted,
  }
}
