export * as App from "./app.js"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export class Service extends Context.Service<Service, Info>()("@opencode/App") {}

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

// opencode.ai only serves the free models to an official OpenCode client whose
// User-Agent advertises version 1.18.0 or newer. LarpCode's own release version
// (1.0.0) is older than that gate, so the wire UA reports the upstream protocol
// version this tree implements instead of the product version. Keep this in
// sync with the upstream version LarpCode is rebased onto.
const WIRE_VERSION = "2.3.0"
const MIN_WIRE_MINOR = 18

function wireVersion(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version)
  if (!match) return WIRE_VERSION
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 1 || (major === 1 && minor >= MIN_WIRE_MINOR)) return version
  return WIRE_VERSION
}

export function useragent(app: Info) {
  return `opencode/${app.channel}/${wireVersion(app.version)}/${app.name}`
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Service, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Service, layer: layer(input), deps: [] })

export const node = configured()
