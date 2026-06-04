import { spawnSync } from "node:child_process"
import * as path from "node:path"

function toGitPath(filePath: string, workingDirectory: string): string | null {
  const trimmed = filePath.trim()
  if (!trimmed) return null

  const withoutPrefix = trimmed.replace(/^\.\//, "")
  const relative = path.isAbsolute(withoutPrefix)
    ? path.relative(workingDirectory, withoutPrefix)
    : withoutPrefix

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

export function ignoredPathSet(paths: string[], workingDirectory: string): Set<string> {
  const normalized = paths
    .map(filePath => toGitPath(filePath, workingDirectory))
    .filter((filePath): filePath is string => Boolean(filePath))

  if (normalized.length === 0) return new Set()

  const result = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: workingDirectory,
    input: normalized.join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.status !== 0 || !result.stdout) return new Set()
  return new Set(result.stdout.split("\n").map(line => line.trim()).filter(Boolean))
}

export function filterGitIgnoredPaths(paths: string[], workingDirectory: string): string[] {
  const ignored = ignoredPathSet(paths, workingDirectory)
  if (ignored.size === 0) return paths

  return paths.filter(filePath => {
    const normalized = toGitPath(filePath, workingDirectory)
    return !normalized || !ignored.has(normalized)
  })
}
