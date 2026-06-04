#!/usr/bin/env node
/**
 * token-optimizer MCP server
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0 over stdio) and exposes
 * one tool: `filter_output`.  Agents that support MCP (OpenCode, Cursor,
 * Claude Desktop, Windsurf, …) can register this server and then call the
 * tool to compress noisy command/file output before it is written into the
 * context window.
 *
 * Start manually:
 *   node dist/src/mcp-server.js
 *
 * Or let the installer wire it into each agent's MCP config automatically.
 */

import { filterBashOutput } from "./filters/bash.js";
import { filterReadOutput, filterEditOutput } from "./filters/read.js";
import * as readline from "node:readline";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "filter_output",
    description:
      "Compress verbose command/file output to reduce token usage. " +
      "Pass the raw stdout/stderr from any shell command or file-read result. " +
      "Returns a compressed version with noise stripped (passing tests, progress bars, " +
      "duplicate lines, binary diffs, boilerplate) while preserving all errors and failures. " +
      "Achieves 60-75% token reduction on typical CI/test/lint output.",
    inputSchema: {
      type: "object",
      properties: {
        output: {
          type: "string",
          description: "Raw command or file output to compress.",
        },
        type: {
          type: "string",
          enum: ["bash", "read", "edit"],
          description:
            'Kind of output. "bash" for shell commands (default), "read" for file content, "edit" for file edit results.',
        },
        command: {
          type: "string",
          description:
            'Optional: the command that produced the output (e.g. "npm test"). Used to apply command-specific filters.',
        },
      },
      required: ["output"],
    },
  },
];

// ─── Handler ──────────────────────────────────────────────────────────────────

function handleFilterOutput(params: Record<string, unknown>): string {
  const raw = String(params.output ?? "");
  const type = String(params.type ?? "bash");
  const command = String(params.command ?? "");

  if (type === "read") {
    const r = filterReadOutput(raw, command || "read");
    return r.output;
  }

  if (type === "edit") {
    return filterEditOutput(raw);
  }

  // bash (default)
  const r = filterBashOutput(raw, command);
  return r.output;
}

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────────

function dispatch(req: JsonRpcRequest): JsonRpcResponse {
  const respond = (result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: req.id ?? null,
    result,
  });

  const error = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: req.id ?? null,
    error: { code, message },
  });

  switch (req.method) {
    // ── MCP lifecycle ──────────────────────────────────────────────────────
    case "initialize":
      return respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "token-optimizer", version: "0.1.0" },
      });

    case "initialized":
      // notification, no response needed but we send empty result
      return respond({});

    case "ping":
      return respond({});

    // ── Tool discovery ─────────────────────────────────────────────────────
    case "tools/list":
      return respond({ tools: TOOLS });

    // ── Tool invocation ────────────────────────────────────────────────────
    case "tools/call": {
      const p = (req.params ?? {}) as Record<string, unknown>;
      const name = String(p.name ?? "");
      const args = (p.arguments ?? {}) as Record<string, unknown>;

      if (name === "filter_output") {
        try {
          const compressed = handleFilterOutput(args);
          return respond({
            content: [{ type: "text", text: compressed }],
          });
        } catch (e) {
          return error(-32603, String(e));
        }
      }

      return error(-32601, `Unknown tool: ${name}`);
    }

    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}

// ─── stdio transport ──────────────────────────────────────────────────────────

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  // For notifications (no id), dispatch but don't send if it was "initialized"
  const res = dispatch(req);
  if (req.method !== "initialized") {
    send(res);
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Keep process alive
process.stdin.resume();
