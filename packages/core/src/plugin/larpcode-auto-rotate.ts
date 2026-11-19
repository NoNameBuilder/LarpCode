export * as LarpcodeAutoRotatePlugin from "./larpcode-auto-rotate.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import * as LarpcodeSettings from "@opencode/util/larpcode-settings"
import { Effect } from "effect"
import { rotateEgress } from "../larpcode-egress.js"

// LarpCode auto-rotate on opencode.ai quota refusal.
//
// On a 429 or 403 from opencode.ai whose body carries a known quota-error
// signature (FreeUsageLimit, BudgetLimit, GoUsageLimit, "usage limit",
// "limit reached"), this plugin rotates the configured egress so the next
// request leaves on a fresh address: a new WARP registration/tunnel, or a new
// Tor circuit when the user selected Tor.
//
// It deliberately does not touch session ids, project ids, client labels, or
// User-Agent values: opencode.ai's free gateway rejects non-official request
// shapes with a synthetic `FreeUsageLimitError`, so rotating those values
// causes the refusals instead of clearing them.
//
// The current request's error still bubbles to the user — the AI SDK's
// retry logic doesn't retry quota errors, and holding the response open past
// Cloudflare's edge timeout breaks worse than letting the one request fail
// cleanly. The rotation helper always leaves the selected tunnel connected, so
// the retry lands on the new identity.
//
// Toggles (persisted in larpcode-settings.json, environment wins):
//   autoRotate=false  disable (default ON — LarpCode keeps the free route
//     usable by rotating the selected egress when a quota refusal lands; the
//     Reset pill remains the manual trigger).
//   egress=warp|tor  choose Cloudflare WARP (system-wide) or Tor (only
//     opencode.ai traffic). Default is WARP.
//   LARPCODE_AUTO_ROTATE=0 / LARPCODE_AUTO_ROTATE_MAX_PER_HOUR=<n>
//     environment overrides. Hitting the hourly cap lets the 429 pass through.

const rotationHistory: number[] = []
let rotationInFlight: Promise<void> | undefined

function allowRotation(maxPerHour: number): boolean {
  const cutoff = Date.now() - 3600_000
  while (rotationHistory.length && rotationHistory[0] < cutoff) rotationHistory.shift()
  return rotationHistory.length < maxPerHour
}

function doRotation(): Promise<void> {
  if (rotationInFlight) return rotationInFlight
  rotationHistory.push(Date.now())
  rotationInFlight = rotateEgress()
    .then((outcome) => {
      // rotateEgress writes every step to larpcode-diag.log. Surface the
      // terminal state on stderr so a packaged build still leaves a trail in
      // the sidecar log when the diag file cannot be written.
      if (outcome.status === "failed" || outcome.status === "skipped") {
        console.warn(`[larpcode-auto-rotate] ${outcome.mode} ${outcome.status}: ${JSON.stringify(outcome)}`)
      }
    })
    .catch((error: unknown) => {
      console.warn(`[larpcode-auto-rotate] rotation threw: ${String(error)}`)
    })
    .finally(() => {
      rotationInFlight = undefined
    })
  return rotationInFlight
}

function isOpencodeURL(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === "opencode.ai" || h.endsWith(".opencode.ai")
  } catch {
    return false
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    const clone = response.clone()
    return await clone.text()
  } catch {
    return ""
  }
}

const QUOTA_BODY = /FreeUsageLimit|BudgetLimit|GoUsageLimit|usage limit|limit reached/i

export const Plugin = define({
  id: "larpcode.auto-rotate",
  effect: Effect.fn("LarpcodeAutoRotatePlugin")(function* (ctx) {
    const hook = (event: SessionHooks["http.response"]) =>
      Effect.gen(function* () {
        if (!isOpencodeURL(event.request.url)) return
        const status = event.response.status
        if (status !== 429 && status !== 403) return

        const body = yield* Effect.promise(() => readBody(event.response))
        if (!QUOTA_BODY.test(body)) return

        const settings = LarpcodeSettings.resolved()
        if (!settings.autoRotate) return
        if (!allowRotation(settings.autoRotateMaxPerHour)) return

        // Fire-and-forget. The current request's quota error still reaches
        // the user; the NEXT request lands on the rotated identity.
        void doRotation()
      }).pipe(Effect.catch(() => Effect.void))

    yield* ctx.session.hook("http.response", hook)
  }),
})
