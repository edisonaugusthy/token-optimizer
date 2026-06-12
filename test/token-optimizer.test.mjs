import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import server, {
  compactBrowserOutput,
  compactMcpOutput,
  compressTaskOutput,
  compressWebfetch,
} from "../dist/src/plugin.js"
import { filterBashOutput } from "../dist/src/filters/bash.js"
import { filterReadOutput } from "../dist/src/filters/read.js"
import { cleanSchemaDescriptions } from "../dist/src/schema-slim.js"

test("bash filters route modern noisy CLIs without dropping errors", () => {
  const out = filterBashOutput("bun test", "spinner 10ms\nError: failed assertion\n1 failing\n")
  assert.match(out.output, /Error: failed assertion/)
  assert.match(out.output, /1 failing/)

  const uv = filterBashOutput("uv run pytest -q", "0.01s\nFAILED tests/test_app.py::test_app\n")
  assert.match(uv.output, /FAILED tests\/test_app.py::test_app/)

  const wrapped = filterBashOutput("cd api && NODE_ENV=test npm exec vitest", "> api@ test\n0.01s\nFAIL src/app.test.ts\n")
  assert.match(wrapped.output, /FAIL src\/app.test.ts/)

  const jvm = filterBashOutput("./gradlew test", "> Task :test\n1 test failed\n")
  assert.match(jvm.output, /1 test failed/)

  const dotnet = filterBashOutput("dotnet test", "Passed!  - Failed: 0, Passed: 12, Skipped: 0\n")
  assert.match(dotnet.output, /Passed/)

  const php = filterBashOutput("composer test", "PHPUnit 11\nThere was 1 failure\n")
  assert.match(php.output, /failure/)
})

test("read filter keeps file content while removing wrappers", () => {
  const raw = [
    "<path>/Users/edisonaugusthy/Documents/Projects/token-optimizer/src/example.ts</path>",
    "<type>file</type>",
    "<content>",
    "export const value = 1",
    "</content>",
    "(End of file - total 1 lines)",
  ].join("\n")
  const out = filterReadOutput(raw, "/Users/edisonaugusthy/Documents/Projects/token-optimizer")
  assert.match(out.output, /export const value = 1/)
  assert.doesNotMatch(out.output, /<content>/)
})

test("plugin compactors remove duplicate boilerplate without hard capping", () => {
  const web = compressWebfetch([
    "Navigation",
    "Useful paragraph.",
    "",
    "Useful paragraph.",
    "",
    "[Home](https://example.com)",
    "Second useful paragraph.",
  ].join("\n"))
  assert.equal(web.match(/Useful paragraph/g)?.length, 1)
  assert.match(web, /Second useful paragraph/)

  const task = compressTaskOutput("<task><task_result>\n[System: hidden]\nActual result\n</task_result></task>")
  assert.equal(task, "Actual result")

  const browser = compactBrowserOutput([
    ...Array(12).fill("console.error boom at app.bundle.js:123"),
    ...Array(12).fill("request failed /api/orders status 500"),
  ].join("\n"))
  assert.equal(browser.match(/console\.error boom/g)?.length, 1)
  assert.match(browser, /request failed \/api/)

  const mcp = compactMcpOutput("search_graph", "{\"id\":\"1\",\"file_path\":\"src/a.ts\",\"fp\":\"x\",\"embedding\":[1,2],\"rank\":-1.2}")
  assert.match(mcp, /"id":"1"/)
  assert.match(mcp, /"file_path":"src\/a.ts"/)
  assert.doesNotMatch(mcp, /embedding|fp|rank/)
})

test("schema slimming preserves structural fields", () => {
  const schema = {
    type: "object",
    required: ["mode"],
    properties: {
      mode: {
        type: "string",
        enum: ["fast", "safe"],
        description: "Choose the execution mode. For example: use safe for validation-heavy runs with lots of additional prose that should not be sent every time.",
        examples: ["safe"],
      },
    },
  }

  cleanSchemaDescriptions(schema)
  assert.deepEqual(schema.required, ["mode"])
  assert.deepEqual(schema.properties.mode.enum, ["fast", "safe"])
  assert.equal(schema.properties.mode.type, "string")
  assert.ok(schema.properties.mode.description.length < 90)
  assert.equal("examples" in schema.properties.mode, false)
})

test("raw/full/verbose bypass leaves current output unfiltered", async () => {
  const plugin = await server({
    directory: process.cwd(),
    client: {
      app: { log: async () => undefined },
      tui: { showToast: async () => undefined },
    },
  })

  const output = { output: "Navigation\n\nImportant body\n\nNavigation\n" }
  await plugin["tool.execute.after"]({ tool: "webfetch", args: { raw: true } }, output)
  assert.equal(output.output, "Navigation\n\nImportant body\n\nNavigation\n")
})

test("duplicate history trimming keeps the newest full output", async () => {
  const plugin = await server({
    directory: process.cwd(),
    client: {
      app: { log: async () => undefined },
      tui: { showToast: async () => undefined },
    },
  })

  const duplicate = "same completed tool output ".repeat(10)
  const messages = [
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", args: { command: "ls" }, state: { status: "completed", output: duplicate } }] },
    { info: { role: "assistant" }, parts: [{ type: "text" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", args: { command: "pwd" }, state: { status: "completed", output: "unique output" } }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", args: { command: "ls" }, state: { status: "completed", output: duplicate } }] },
    { info: { role: "assistant" }, parts: [{ type: "text" }] },
  ]

  await plugin["experimental.chat.messages.transform"]({}, { messages })
  assert.match(messages[0].parts[0].state.output, /duplicate trimmed from history/)
  assert.equal(messages[3].parts[0].state.output, duplicate)
})

test("plugin source has no current-output or response hard caps", async () => {
  const source = await readFile(new URL("../src/plugin.ts", import.meta.url), "utf8")
  const forbidden = ["maxOutputTokens", "GENERIC_CAP_CHARS", "MAX_CHARS", "capText", "session" + "Memory", "session" + " memory", "Token Optimizer " + "Session Memory"]
  for (const text of forbidden) {
    assert.equal(source.includes(text), false)
  }
})

test("MCP wrapper routes bash command and output in the right order", async () => {
  const child = spawn(process.execPath, ["dist/src/mcp-server.js"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  })

  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for MCP response")), 5000)
    child.stdout.once("data", chunk => {
      clearTimeout(timeout)
      resolve(JSON.parse(String(chunk)))
    })
    child.once("error", reject)
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "filter_output",
        arguments: {
          type: "bash",
          command: "git status",
          output: "On branch main\nChanges not staged for commit:\n\tmodified: src/a.ts\n",
        },
      },
    }) + "\n")
  }).finally(() => {
    child.kill()
  })

  const text = response.result.content[0].text
  assert.match(text, /modified/)
  assert.doesNotMatch(text, /On branch main/)
})

test("setup CLI defaults to status", async () => {
  const child = spawn(process.execPath, ["dist/scripts/setup.js"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  })

  const output = await new Promise((resolve, reject) => {
    let text = ""
    child.stdout.on("data", chunk => { text += String(chunk) })
    child.stderr.on("data", chunk => { text += String(chunk) })
    child.once("error", reject)
    child.once("close", code => {
      if (code === 0) resolve(text)
      else reject(new Error(`setup CLI exited ${code}: ${text}`))
    })
  })

  assert.match(output, /token-optimizer .* status/)
  assert.match(output, /Optimization totals/)
})
