export * as LarpcodeAbliterated from "./larpcode-abliterated.js"

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import bundledContent from "./plugin/abliterated-AGENTS.md" with { type: "text" }
import bigpickleContent from "./plugin/abliterated-bigpickle.txt" with { type: "text" }
import deepseekContent from "./plugin/abliterated-deepseek-v4.1.txt" with { type: "text" }

// One global switch for the abliterated project instructions. Stored in the
// opencode data dir so the CLI sidecar and the desktop read the same value.
// Missing file means off.
const FILE = path.join(Global.Path.data, "larpcode-abliterated.json")
// Stay below the sidecar's default request-body cap after JSON escaping.
const MAX_CONTENT = 750_000
const MAX_PRESETS = 20
const MAX_NAME = 80

export type ProfileScope = "universal" | "model"

/**
 * A built-in Auto JB instruction set. Universal profiles work with any model;
 * model profiles declare lowercase match tokens checked against
 * `<providerID>/<modelID>`.
 */
export type Profile = {
  id: string
  name: string
  description: string
  scope: ProfileScope
  match?: readonly string[]
  content: string
}

/** Serialisable profile metadata. The content stays in the engine. */
export type ProfileInfo = Omit<Profile, "content"> & { length: number }

/** The model fields Auto JB can read from a request or a query string. */
export type ModelRef = { providerID?: string; id?: string; modelID?: string }

/** Selection value meaning "model-specific when one matches, else universal". */
export const AutoProfile = "auto"

// Built-ins ship with the engine so every install has the same choices and no
// network access is needed to resolve them. Order matters: the first profile
// is the universal fallback.
export const Profiles: readonly Profile[] = [
  {
    id: "universal",
    name: "Op Spec",
    description: "The original universal Auto JB set: full board, flat register, abliterated.",
    scope: "universal",
    content: bundledContent,
  },
  {
    id: "bigpickle",
    name: "Big Pickle",
    description: "Universal persona set. The Bench house guide with the ollie/Olivia register.",
    scope: "universal",
    content: bigpickleContent,
  },
  {
    id: "deepseek",
    name: "DeepSeek V4.1",
    description: "Model-specific set tuned for DeepSeek V4.1. Also selected for other DeepSeek models.",
    scope: "model",
    match: ["deepseek"],
    content: deepseekContent,
  },
]

export const DefaultProfile = Profiles[0]!
export const DefaultContent = DefaultProfile.content

export function filePath() {
  return FILE
}

export type Preset = { id: string; name: string; content: string }

type State = { enabled?: unknown; content?: unknown; presets?: unknown; profile?: unknown }

function read(): State {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown
    return value && typeof value === "object" ? (value as State) : {}
  } catch {
    return {}
  }
}

function write(state: State) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const temp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state), "utf8")
  fs.renameSync(temp, FILE)
}

function info(profile: Profile): ProfileInfo {
  const { content, ...metadata } = profile
  return { ...metadata, length: content.length }
}

export function profiles() {
  return Profiles.map(info)
}

export function hasProfile(value: string) {
  return value === AutoProfile || Profiles.some((profile) => profile.id === value)
}

/** The saved profile choice: `auto` or a built-in id. Unknown values mean auto. */
export function selection() {
  const value = read().profile
  if (typeof value === "string" && hasProfile(value)) return value
  return AutoProfile
}

function modelKey(model?: ModelRef) {
  if (!model) return ""
  return `${model.providerID ?? ""}/${model.modelID ?? model.id ?? ""}`.toLowerCase()
}

/** First model-specific profile whose match token appears in provider/model. */
export function matchProfile(model?: ModelRef) {
  const key = modelKey(model)
  if (!key) return undefined
  return Profiles.find(
    (profile) => profile.scope === "model" && profile.match?.some((token) => key.includes(token.toLowerCase())),
  )
}

/**
 * Resolve a saved selection for one request. `auto` prefers a matching
 * model-specific profile, then the universal fallback. An explicit built-in
 * selection always wins so a user can force a set for any model.
 */
export function resolveProfile(value: string = selection(), model?: ModelRef) {
  if (value !== AutoProfile) {
    const selected = Profiles.find((profile) => profile.id === value)
    if (selected) return selected
  }
  return matchProfile(model) ?? DefaultProfile
}

/** Metadata for the profile that would serve this model right now. */
export function activeProfile(model?: ModelRef) {
  return info(resolveProfile(selection(), model))
}

/** Build a model reference from optional provider/model query values. */
export function modelRef(providerID?: string | null, modelID?: string | null): ModelRef | undefined {
  const provider = providerID?.trim() || undefined
  const model = modelID?.trim() || undefined
  if (!provider && !model) return undefined
  return { providerID: provider, modelID: model }
}

export function enabled() {
  return read().enabled === true
}

export function custom() {
  // An explicit empty string is a saved custom prompt: Auto JB stays on and
  // injects nothing. Only a missing key means "use the selected profile".
  return typeof read().content === "string"
}

/** The active instruction set: custom text when present, else the resolved profile. */
export function content(model?: ModelRef) {
  const value = read().content
  if (typeof value === "string") return value
  return resolveProfile(selection(), model).content
}

export function presets(): Preset[] {
  const value = read().presets
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const preset = item as Partial<Preset>
    if (typeof preset.id !== "string" || typeof preset.name !== "string" || typeof preset.content !== "string")
      return []
    return [{ id: preset.id, name: preset.name, content: preset.content }]
  })
}

/** Preset id matching the active custom content, the profile selection, or a sentinel. */
export function activePreset() {
  if (!custom()) return selection()
  const current = content()
  const match = presets().find((preset) => preset.content === current)
  return match ? match.id : "custom"
}

export function setEnabled(value: boolean) {
  write({ ...read(), enabled: value })
}

/**
 * Pick a built-in profile. This is an explicit choice, so any custom content
 * is discarded; otherwise the old custom text would keep overriding the pick.
 */
export function setProfile(value: string) {
  const next = value.trim()
  if (!hasProfile(next)) throw new Error(`unknown profile: ${value}`)
  const current = read()
  delete current.content
  write({ ...current, profile: next })
}

export function setContent(value: string) {
  if (value.length > MAX_CONTENT) throw new Error(`auto jb content exceeds ${MAX_CONTENT} characters`)
  const current = read()
  // Persist the empty string. It means "Auto JB on, inject nothing"; a missing
  // `content` key is what restores the selected profile.
  write({ ...current, content: value })
}

export function resetContent() {
  const current = read()
  delete current.content
  write(current)
}

export function savePreset(name: string, value: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("preset name is required")
  if (trimmed.length > MAX_NAME) throw new Error(`preset name exceeds ${MAX_NAME} characters`)
  if (value.length > MAX_CONTENT) throw new Error(`preset content exceeds ${MAX_CONTENT} characters`)
  const current = presets()
  const existing = current.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase())
  if (!existing && current.length >= MAX_PRESETS) throw new Error(`preset limit is ${MAX_PRESETS}`)
  const preset: Preset = existing
    ? { ...existing, name: trimmed, content: value }
    : { id: randomUUID(), name: trimmed, content: value }
  write({
    ...read(),
    content: value,
    presets: existing ? current.map((item) => (item.id === existing.id ? preset : item)) : [...current, preset],
  })
  return preset
}

export function deletePreset(id: string) {
  const current = presets()
  const next = current.filter((preset) => preset.id !== id)
  if (next.length === current.length) return false
  write({ ...read(), presets: next })
  return true
}

export function isDefault(value: string) {
  return value === DefaultContent
}

export const MaxContentLength = MAX_CONTENT
export const MaxPresets = MAX_PRESETS
