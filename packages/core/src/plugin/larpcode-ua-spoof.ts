export * as LarpcodeUASpoofPlugin from "./larpcode-ua-spoof.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ensureEgress } from "../larpcode-egress.js"

// LarpCode wire-identity guard for opencode.ai.
//
// Earlier builds rewrote the session / project / client / User-Agent headers on
// every opencode.ai request to values the server had never seen, hoping to
// escape a per-identity quota bucket. opencode.ai's free gateway now validates
// that shape: it rejects `ses_<64 hex>` session ids, browser User-Agents, and
// OpenCode client versions older than 1.18.0 with a synthetic
// `FreeUsageLimitError`. The rewrite was therefore the cause of the refusals,
// not the cure.
//
// Core already emits the official shape (`x-opencode-session*` carrying the
// real session id, `x-opencode-project` carrying the real project id,
// `x-opencode-client: cli`, and `App.useragent` advertising a compatible
// OpenCode version). This plugin deliberately leaves those values alone.
//
// It also starts the configured egress guard: WARP is connected before the
// first model request when possible, and Tor routing is installed when the
// user selected Tor. The ensure is fire-and-forget so a slow tunnel never
// blocks the UI from opening; the request path and auto-rotate still enforce
// the route if the first startup attempt is still in flight.
export const Plugin = define({
  id: "larpcode.spoof.user-agent",
  effect: Effect.fn("LarpcodeUASpoofPlugin")(function* () {
    void ensureEgress().catch(() => {
      /* logged inside ensureEgress */
    })
    yield* Effect.logInfo(
      "larpcode-ua-spoof: official wire identity preserved (no header rewriting); egress ensure started",
    )
  }),
})
