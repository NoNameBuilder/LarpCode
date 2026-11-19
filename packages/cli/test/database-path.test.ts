import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { databasePath } from "../src/database-path"

const entry = pathToFileURL(path.join(import.meta.dir, "../src/database-path.ts")).href
const data = path.join(import.meta.dir, "data")
const saved = {
  OPENCODE_DB: process.env.OPENCODE_DB,
  OPENCODE_DISABLE_CHANNEL_DB: process.env.OPENCODE_DISABLE_CHANNEL_DB,
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function run(defines: Record<string, string>, env: Record<string, string> = {}) {
  const merged = { ...process.env, ...env }
  delete merged.OPENCODE_DB
  delete merged.OPENCODE_DISABLE_CHANNEL_DB
  Object.assign(merged, env)
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      ...Object.entries(defines).flatMap(([key, value]) => ["--define", `${key}=${JSON.stringify(value)}`]),
      "-e",
      `const { databasePath } = await import(${JSON.stringify(entry)}); console.log(databasePath(${JSON.stringify(data)}))`,
    ],
    env: merged,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return result.stdout.toString().trim()
}

describe("database path", () => {
  test("channel builds keep their channel database", () => {
    delete process.env.OPENCODE_DB
    delete process.env.OPENCODE_DISABLE_CHANNEL_DB
    expect(databasePath(data)).toBe(path.resolve(data, "opencode-local.db"))
  })

  test(
    "release channels, OPENCODE_DISABLE_CHANNEL_DB and OPENCODE_DB use the channel-less database",
    () => {
      delete process.env.OPENCODE_DB
      process.env.OPENCODE_DISABLE_CHANNEL_DB = "1"
      expect(databasePath(data)).toBe(path.resolve(data, "opencode.db"))
      expect(run({ OPENCODE_CHANNEL: "prod" })).toBe(path.resolve(data, "opencode.db"))
      expect(run({ OPENCODE_CHANNEL: "main" }, { OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(
        path.resolve(data, "opencode.db"),
      )
      expect(run({ OPENCODE_CHANNEL: "main" }, { OPENCODE_DB: path.join(data, "custom.db") })).toBe(
        path.join(data, "custom.db"),
      )
    },
    30_000,
  )

  test(
    "standalone distributions share the desktop's database",
    () => {
      expect(run({ LARPCODE_CLI_DISTRIBUTION: "1", OPENCODE_CHANNEL: "main" })).toBe(
        path.resolve(data, "opencode.db"),
      )
      expect(run({ OPENCODE_CHANNEL: "main" })).toBe(path.resolve(data, "opencode-main.db"))
    },
    30_000,
  )
})
