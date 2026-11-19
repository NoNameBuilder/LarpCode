export * as LarpcodeEvent from "./larpcode-event.js"

import { Schema } from "effect"
import { Event } from "./event.js"

// LarpCode: emitted when opencode.ai refuses a free request and the response
// is served by a fallback provider instead. Ephemeral because the routing
// decision is per-process state, not part of a session's durable log.
export const FallbackUsed = Event.ephemeral({
  type: "larpcode.fallback.used",
  schema: {
    provider: Schema.Literals(["deepseek", "pollinations"]),
    at: Schema.Finite,
  },
})

export const Definitions = Event.inventory(FallbackUsed)
