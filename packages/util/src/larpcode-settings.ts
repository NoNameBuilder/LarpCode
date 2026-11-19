import fs from "node:fs"
import path from "node:path"
import { roots } from "#global-roots"

// Persistent LarpCode switches that are not part of OpenCode's config schema.
// Environment variables win when set, so existing launch scripts keep working;
// otherwise the file lets the desktop and TUI change behavior without a
// restart. Missing file means the defaults below.
const FILE = path.join(roots("opencode").data, "larpcode-settings.json")

export type Egress = "warp" | "tor"
export type Key = "autoRotate" | "freeFallback" | "forceTor" | "egress"
export type Source = "env" | "file" | "default"

export type Stored = {
  autoRotate?: boolean
  autoRotateMaxPerHour?: number
  freeFallback?: boolean
  forceTor?: boolean
  egress?: Egress
}

export type Resolved = {
  autoRotate: boolean
  autoRotateMaxPerHour: number
  freeFallback: boolean
  forceTor: boolean
  egress: Egress
}

export type Patch = Partial<Resolved>

export const Defaults: Resolved = {
  autoRotate: true,
  autoRotateMaxPerHour: 30,
  freeFallback: true,
  forceTor: false,
  egress: "warp",
}

export function filePath() {
  return FILE
}

function read(): Stored {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown
    return value && typeof value === "object" ? (value as Stored) : {}
  } catch {
    return {}
  }
}

function write(state: Stored) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const temp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8")
  fs.renameSync(temp, FILE)
}

function envBool(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return undefined
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  return undefined
}

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

function envEgress(name: string): Egress | undefined {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "warp" || value === "tor" ? value : undefined
}

function storedBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function storedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

function storedEgress(value: unknown): Egress | undefined {
  return value === "warp" || value === "tor" ? value : undefined
}

export function resolved(): Resolved {
  const state = read()
  // `egress` is the public choice. `forceTor` stays as a compatibility alias
  // because the bootstrap and Tor dispatcher installed before this setting
  // existed, and older larpcode-settings.json files only carry forceTor.
  const forced = envBool("LARPCODE_FORCE_TOR")
  const egress =
    envEgress("LARPCODE_EGRESS") ??
    (forced === true ? "tor" : forced === false ? "warp" : undefined) ??
    storedEgress(state.egress) ??
    (storedBool(state.forceTor) === true ? "tor" : Defaults.egress)
  return {
    autoRotate: envBool("LARPCODE_AUTO_ROTATE") ?? storedBool(state.autoRotate) ?? Defaults.autoRotate,
    autoRotateMaxPerHour:
      envNumber("LARPCODE_AUTO_ROTATE_MAX_PER_HOUR") ??
      storedNumber(state.autoRotateMaxPerHour) ??
      Defaults.autoRotateMaxPerHour,
    freeFallback: envBool("LARPCODE_FREE_FALLBACK") ?? storedBool(state.freeFallback) ?? Defaults.freeFallback,
    forceTor: egress === "tor",
    egress,
  }
}

export function sources(): Record<Key, Source> {
  const state = read()
  const source = (env: string, value: unknown): Source =>
    envBool(env) !== undefined ? "env" : storedBool(value) !== undefined ? "file" : "default"
  const egressSource: Source =
    envEgress("LARPCODE_EGRESS") !== undefined || envBool("LARPCODE_FORCE_TOR") !== undefined
      ? "env"
      : storedEgress(state.egress) !== undefined || storedBool(state.forceTor) !== undefined
        ? "file"
        : "default"
  return {
    autoRotate: source("LARPCODE_AUTO_ROTATE", state.autoRotate),
    freeFallback: source("LARPCODE_FREE_FALLBACK", state.freeFallback),
    forceTor: egressSource,
    egress: egressSource,
  }
}

export function set(patch: Patch): Resolved {
  const current = read()
  const next: Stored = { ...current }
  if (patch.autoRotate !== undefined) next.autoRotate = Boolean(patch.autoRotate)
  if (patch.freeFallback !== undefined) next.freeFallback = Boolean(patch.freeFallback)
  if (patch.egress !== undefined) {
    if (patch.egress !== "warp" && patch.egress !== "tor") throw new Error("egress must be warp or tor")
    next.egress = patch.egress
    next.forceTor = patch.egress === "tor"
  } else if (patch.forceTor !== undefined) {
    next.forceTor = Boolean(patch.forceTor)
    next.egress = patch.forceTor ? "tor" : "warp"
  }
  if (patch.autoRotateMaxPerHour !== undefined) {
    const value = Number(patch.autoRotateMaxPerHour)
    if (!Number.isFinite(value) || value < 1) throw new Error("autoRotateMaxPerHour must be at least 1")
    next.autoRotateMaxPerHour = Math.floor(value)
  }
  write(next)
  return resolved()
}
