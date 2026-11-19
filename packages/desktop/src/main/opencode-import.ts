import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CredentialLegacy } from "@opencode/schema/credential-legacy"
import { Schema } from "effect"

/**
 * Reads the sign-ins an installed OpenCode keeps in its own SQLite database.
 *
 * LarpCode stores its state under its own application id, so these databases
 * belong to OpenCode and are opened read-only. Importing copies a credential
 * into LarpCode through the server API and never writes, migrates, or deletes
 * OpenCode data.
 */

export type OpenCodeCredential = {
  /** The OpenCode database this credential was read from. */
  readonly database: string
  readonly id: string
  readonly integrationID: string
  readonly label: string
  readonly active: boolean
  readonly value: Schema.Schema.Type<typeof CredentialLegacy.Value>
}

export type OpenCodeCredentialList = {
  readonly databases: readonly string[]
  readonly credentials: readonly OpenCodeCredential[]
  readonly errors: readonly string[]
}

const databaseName = /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/i

const decodeCredential = Schema.decodeUnknownSync(CredentialLegacy.Value)

/** OpenCode databases, most explicit source first. Tests and advanced users can point these at a copied profile. */
export function findOpenCodeDatabases(options: { readonly home?: string } = {}) {
  const explicit = process.env.LARPCODE_OPENCODE_DB
  const explicitData = process.env.LARPCODE_OPENCODE_DATA
  const home = options.home ?? os.homedir()
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
  const candidates: string[] = []

  const excluded = [process.env.XDG_DATA_HOME, process.env.LARPCODE_DESKTOP_XDG_ROOT, process.env.OPENCODE_DB].flatMap(
    (value) => (value ? [resolve(value)] : []),
  )

  const addFile = (file: string) => {
    if (!existsSync(file) || !isFile(file)) return

    if (!databaseName.test(path.basename(file)) && resolve(file) !== resolve(explicit ?? "")) return

    if (excluded.some((root) => isInside(file, root))) return
    candidates.push(resolve(file))
  }

  const addDirectory = (directory: string | undefined) => {
    if (!directory || !existsSync(directory)) return
    let names: string[]

    try {
      names = readdirSync(directory)
    } catch {
      return
    }

    for (const name of names) if (databaseName.test(name)) addFile(path.join(directory, name))
  }

  if (explicit) addFile(explicit)
  addDirectory(explicitData)
  addDirectory(path.join(home, ".local", "share", "opencode"))

  if (process.platform === "win32") addDirectory(path.join(appData, "ai.opencode.desktop", "xdg", "data", "opencode"))

  if (process.platform === "darwin")
    addDirectory(path.join(home, "Library", "Application Support", "ai.opencode.desktop", "xdg", "data", "opencode"))

  if (process.platform === "linux")
    addDirectory(
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        "ai.opencode.desktop",
        "xdg",
        "data",
        "opencode",
      ),
    )

  // A custom XDG data home is where OpenCode's CLI keeps its database when the
  // user overrides it. LarpCode's own XDG root is in `excluded`.
  if (process.env.XDG_DATA_HOME) addDirectory(path.join(process.env.XDG_DATA_HOME, "opencode"))

  const seen = new Set<string>()

  return candidates.filter((file) => {
    const key = canonical(file).toLowerCase()

    if (seen.has(key)) return false
    seen.add(key)

    return true
  })
}

/** Lists credentials saved by an installed OpenCode, read-only and deduplicated across profiles. */
export function listOpenCodeCredentials(options: { readonly home?: string } = {}): OpenCodeCredentialList {
  const databases = findOpenCodeDatabases(options)
  const credentials = new Map<string, OpenCodeCredential>()
  const errors: string[] = []
  const readable: string[] = []

  for (const database of databases) {
    try {
      const result = listDatabaseCredentials(database)
      readable.push(database)
      errors.push(...result.errors)

      for (const credential of result.credentials) {
        const previous = credentials.get(credential.id)

        if (!previous || (!previous.active && credential.active)) credentials.set(credential.id, credential)
      }
    } catch (error) {
      errors.push(`${path.basename(database)}: ${message(error)}`)
    }
  }

  return { databases: readable, credentials: [...credentials.values()], errors }
}

function emptyResult() {
  const credentials: OpenCodeCredential[] = []
  const errors: string[] = []

  return { credentials, errors }
}

function listDatabaseCredentials(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })

  try {
    const tables = tableNames(db)

    if (!tables.has("credential")) return emptyResult()
    const columns = tableColumns(db, "credential")

    if (!columns.has("integration_id")) return emptyResult()

    const order = columns.has("time_created") ? "time_created ASC, id ASC" : "id ASC"

    const rows = all(
      db,
      `SELECT id, integration_id, label, active, value FROM credential WHERE integration_id IS NOT NULL ORDER BY ${order}`,
    )

    const credentials: OpenCodeCredential[] = []
    const errors: string[] = []

    for (const row of rows) {
      const id = text(row.id)
      const integrationID = text(row.integration_id)
      const raw = text(row.value)

      if (!id || !integrationID) continue

      if (!raw) {
        errors.push(`${path.basename(database)}: ${id} has no stored value`)
        continue
      }

      try {
        credentials.push({
          database,
          id,
          integrationID,
          label: text(row.label)?.trim() || integrationID,
          active: row.active === 1 || row.active === true || row.active === "1",
          value: decodeCredential(JSON.parse(raw)),
        })
      } catch (error) {
        errors.push(`${path.basename(database)}: ${id}: ${message(error)}`)
      }
    }

    return { credentials, errors }
  } finally {
    db.close()
  }
}

function tableNames(db: DatabaseSync) {
  return new Set(
    all(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => text(row.name))
      .filter((name): name is string => name !== undefined),
  )
}

function tableColumns(db: DatabaseSync, table: string) {
  return new Set(
    all(db, `PRAGMA table_info(${table})`)
      .map((row) => text(row.name))
      .filter((name): name is string => name !== undefined),
  )
}

// SAFETY: node:sqlite returns one dictionary per row; callers read columns by name and `text` narrows each cell.
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- see SAFETY above */
function all(db: DatabaseSync, sql: string) {
  return db.prepare(sql).all() as Record<string, unknown>[]
}
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */

// SAFETY: SQLite cells are untrusted storage; a column is a string only when its value is one.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- see SAFETY above */
function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

// SAFETY: caught values are arbitrary throws; import errors only report an Error's message.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function resolve(file: string) {
  return path.resolve(file)
}

function canonical(file: string) {
  try {
    return realpathSync.native(file)
  } catch {
    return resolve(file)
  }
}

function isFile(file: string) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isInside(file: string, root: string) {
  const target = resolve(file).toLowerCase()
  const base = resolve(root).toLowerCase()

  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}
