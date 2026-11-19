import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { listOpenCodeCredentials } from "./opencode-import"

const ENVIRONMENT = [
  "LARPCODE_OPENCODE_DB",
  "LARPCODE_OPENCODE_DATA",
  "APPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_DB",
] as const

const saved = new Map<string, string | undefined>()

const roots: string[] = []

beforeEach(() => {
  for (const key of ENVIRONMENT) saved.set(key, process.env[key])
})

// Bun's node:sqlite shim can retain file handles on Windows after close; only these owned test directories are removed.
afterEach(async () => {
  for (const key of ENVIRONMENT) {
    const value = saved.get(key)

    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  saved.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

/** An isolated home and OpenCode data directory, so the reader only sees this test's databases. */
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-import-"))
  roots.push(root)
  const data = path.join(root, "data")
  const home = path.join(root, "home")
  const appData = path.join(root, "appdata")

  await Promise.all([
    mkdir(data, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(appData, { recursive: true }),
  ])
  process.env.LARPCODE_OPENCODE_DATA = data
  process.env.APPDATA = appData
  process.env.XDG_DATA_HOME = path.join(root, "xdg-data")
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg-config")
  delete process.env.LARPCODE_OPENCODE_DB
  delete process.env.OPENCODE_DB

  return { data, home }
}

type Row = {
  readonly id: string
  readonly integrationID: string
  readonly label?: string | null
  readonly active?: boolean
  readonly value: string | null
}

function createDatabase(file: string, rows: readonly Row[]) {
  const db = new DatabaseSync(file)

  try {
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, active INTEGER NOT NULL DEFAULT 0, value TEXT, time_created INTEGER NOT NULL DEFAULT 0)",
    )

    const insert = db.prepare(
      "INSERT INTO credential (id, integration_id, label, active, value, time_created) VALUES (?, ?, ?, ?, ?, ?)",
    )

    for (const row of rows) insert.run(row.id, row.integrationID, row.label ?? null, row.active ? 1 : 0, row.value, 0)
  } finally {
    db.close()
  }
}

describe("OpenCode credential reader", () => {
  test("reads legacy key credentials without touching the source database", async () => {
    const { data, home } = await workspace()
    const file = path.join(data, "opencode.db")

    createDatabase(file, [
      {
        id: "cred_1",
        integrationID: "anthropic",
        label: "Work",
        active: true,
        // Before v2.1 key credentials kept their setup-form answers in `configuration`.
        value: JSON.stringify({ type: "key", key: "sk-ant", configuration: { account: "work" } }),
      },
    ])

    const before = await readFile(file)
    const entriesBefore = await readdir(data)

    const result = listOpenCodeCredentials({ home })

    expect(result.databases).toEqual([file])
    expect(result.credentials).toEqual([
      {
        database: file,
        id: "cred_1",
        integrationID: "anthropic",
        label: "Work",
        active: true,
        value: { type: "key", key: "sk-ant", metadata: { account: "work" } },
      },
    ])
    expect(result.errors).toEqual([])
    // The source belongs to OpenCode: reading leaves the file and its directory unchanged.
    expect(await readFile(file)).toEqual(before)
    expect(await readdir(data)).toEqual(entriesBefore)
  })

  test("deduplicates a credential across profiles, keeping the active copy", async () => {
    const { data, home } = await workspace()
    const inactive = path.join(data, "opencode-one.db")
    const active = path.join(data, "opencode-two.db")
    const value = JSON.stringify({ type: "key", key: "sk-shared" })

    createDatabase(inactive, [{ id: "cred_shared", integrationID: "anthropic", label: "Older", active: false, value }])
    createDatabase(active, [{ id: "cred_shared", integrationID: "anthropic", label: "Current", active: true, value }])

    const result = listOpenCodeCredentials({ home })

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      database: active,
      id: "cred_shared",
      label: "Current",
      active: true,
    })
  })

  test("reports a corrupt profile and a bad row without losing readable credentials", async () => {
    const { data, home } = await workspace()
    const valid = path.join(data, "opencode.db")

    createDatabase(valid, [
      {
        id: "cred_good",
        integrationID: "anthropic",
        label: "Work",
        value: JSON.stringify({ type: "key", key: "sk-ant" }),
      },
      { id: "cred_bad", integrationID: "openai", label: "Personal", value: "{not json" },
      { id: "cred_empty", integrationID: "openai", label: null, value: null },
    ])
    await Bun.write(path.join(data, "opencode-broken.db"), "not a SQLite database")

    const result = listOpenCodeCredentials({ home })

    expect(result.databases).toEqual([valid])
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({ id: "cred_good", integrationID: "anthropic" })
    expect(result.errors).toHaveLength(3)
    expect(result.errors.some((error) => error.startsWith("opencode-broken.db: "))).toBe(true)
    expect(result.errors.some((error) => error.startsWith("opencode.db: cred_bad: "))).toBe(true)
    expect(result.errors).toContain("opencode.db: cred_empty has no stored value")
  })
})
