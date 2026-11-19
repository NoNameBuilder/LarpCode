export * as LarpcodeEgress from "./larpcode-egress.js"

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Egress } from "@opencode/util/larpcode-settings"
import { resolved } from "@opencode/util/larpcode-settings"
import { installImpersonateFetchOverride, uninstallImpersonateFetchOverride } from "@opencode/util/larpcode-impersonate-fetch"
import { ensureWarpConnected, rotateWarpEgress } from "@opencode/util/larpcode-warp"
import { ensureTor, probeExitIp, signalNewNym } from "./larpcode-tor.js"
import {
  installGlobalFetchOverride,
  installTorRoutingDispatcher,
  recycleTorPool,
  uninstallGlobalFetchOverride,
} from "./larpcode-socks-dispatcher.js"

// One egress rotation entry point for both the automatic free-limit path and
// the manual reset. The selected route is the persisted `egress` setting:
//
//   warp: Cloudflare WARP carries the whole system; rotate its registration
//         and verify the tunnel is Connected afterwards.
//   tor:  only opencode.ai traffic is routed through the bundled Tor SOCKS
//         proxy; rotate a circuit and verify the exit address. Every other
//         app and every BYOK provider keeps the normal connection.
//
// The outcome is structured so the HTTP routes can return it as JSON and the
// UI can show the address transition (or the exact step that failed).

export type EgressOutcome =
  | { status: "rotated"; mode: Egress; ip_before: string | null; ip_after: string; steps: string[] }
  | { status: "same_ip"; mode: Egress; ip_before: string; ip_after: string; steps: string[] }
  | { status: "unverified"; mode: Egress; ip_before: string | null; ip_after: string | null; steps: string[] }
  | { status: "skipped"; mode: Egress; reason: string }
  | { status: "failed"; mode: Egress; step: string; error: string; ip_before?: string | null; steps: string[] }

function diagPath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "log", "larpcode-diag.log")
}

function diag(line: string): void {
  try {
    const file = diagPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch {
    /* diagnostics must never break rotation */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Switch the process-level fetch path without restarting the sidecar. Installing
// the Tor router after the TLS-impersonation wrapper makes opencode.ai hosts go
// through torFetch. Removing it restores the wrapper's own saved native fetch,
// so the order matters: drop the Tor router first, then the impersonation
// wrapper, then install a clean wrapper over the real native fetch.
async function setTorRouting(enabled: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (!enabled) {
    uninstallGlobalFetchOverride()
    uninstallImpersonateFetchOverride()
    installImpersonateFetchOverride()
    diag("[egress] tor routing disabled")
    return { ok: true }
  }
  const installed = await installTorRoutingDispatcher()
  if (!installed.installed) {
    return { ok: false, reason: installed.reason ?? "tor dispatcher unavailable" }
  }
  installGlobalFetchOverride()
  diag("[egress] tor routing enabled")
  return { ok: true }
}

async function rotateTor(): Promise<EgressOutcome> {
  const steps: string[] = []
  const step = (line: string) => {
    steps.push(line)
    diag(`[egress:tor] ${line}`)
  }

  const ensured = await ensureTor()
  step(`ensureTor=${ensured.status}${ensured.status === "ready" ? "" : ` reason=${ensured.reason}`}`)
  if (ensured.status !== "ready") {
    return { status: "skipped", mode: "tor", reason: `tor not ready: ${ensured.reason}` }
  }

  const routed = await setTorRouting(true)
  step(`routing=${routed.ok ? "tor" : `failed:${routed.reason ?? "unknown"}`}`)
  if (!routed.ok) {
    return {
      status: "failed",
      mode: "tor",
      step: "dispatcher",
      error: routed.reason ?? "tor dispatcher unavailable",
      steps,
    }
  }

  const ipBefore = await probeExitIp(15_000)
  step(`ip_before=${ipBefore ?? "unknown"}`)

  const nym = await signalNewNym()
  step(`newnym=${nym.ok ? "ok" : nym.response}`)
  if (!nym.ok) {
    return { status: "failed", mode: "tor", step: "newnym", error: nym.response, ip_before: ipBefore, steps }
  }

  // SIGNAL NEWNYM queues a circuit. Dropping keep-alive sockets makes the next
  // probe open a fresh tunnel instead of reusing the old exit.
  await sleep(8_000)
  await recycleTorPool()

  let ipAfter = await probeExitIp(15_000)
  for (let attempt = 0; attempt < 2 && ipAfter && ipBefore && ipAfter === ipBefore; attempt++) {
    const retry = await signalNewNym()
    if (!retry.ok) break
    await sleep(8_000)
    await recycleTorPool()
    ipAfter = await probeExitIp(15_000)
  }
  step(`ip_after=${ipAfter ?? "unknown"}`)

  if (!ipAfter) {
    return { status: "failed", mode: "tor", step: "probe-after", error: "could not read tor exit IP", ip_before: ipBefore, steps }
  }
  if (!ipBefore) {
    return { status: "unverified", mode: "tor", ip_before: null, ip_after: ipAfter, steps }
  }
  if (ipBefore === ipAfter) {
    return { status: "same_ip", mode: "tor", ip_before: ipBefore, ip_after: ipAfter, steps }
  }
  return { status: "rotated", mode: "tor", ip_before: ipBefore, ip_after: ipAfter, steps }
}

// Rotate the configured egress and return the real address transition. Never
// throws: a failed rotation is an outcome the caller can render.
export async function rotateEgress(mode?: Egress): Promise<EgressOutcome> {
  const selected = mode ?? resolved().egress
  if (selected === "tor") return rotateTor()

  // A previous run may have selected Tor. Remove its fetch router before a
  // WARP rotation so the next request really leaves through WARP.
  await setTorRouting(false)
  const outcome = await rotateWarpEgress({ log: diag })
  switch (outcome.status) {
    case "rotated":
      return { status: "rotated", mode: "warp", ip_before: outcome.ip_before, ip_after: outcome.ip_after, steps: outcome.steps }
    case "same_ip":
      return {
        status: "same_ip",
        mode: "warp",
        ip_before: outcome.ip_before,
        ip_after: outcome.ip_after,
        steps: outcome.steps,
      }
    case "unverified":
      return { status: "unverified", mode: "warp", ip_before: outcome.ip_before, ip_after: outcome.ip_after, steps: outcome.steps }
    case "skipped":
      return { status: "skipped", mode: "warp", reason: outcome.reason }
    case "failed":
      return {
        status: "failed",
        mode: "warp",
        step: outcome.step,
        error: outcome.error,
        ip_before: outcome.ip_before,
        steps: outcome.steps,
      }
  }
}

// Ensure the configured route is actually carrying traffic. Called when the
// sidecar starts, before any model request has a chance to miss the tunnel.
export async function ensureEgress(log = diag): Promise<{ mode: Egress; ok: boolean; detail: string }> {
  const mode = resolved().egress
  if (mode === "tor") {
    const ensured = await ensureTor()
    if (ensured.status !== "ready") {
      log(`[egress] tor ensure failed: ${ensured.reason}`)
      return { mode, ok: false, detail: ensured.reason }
    }
    const routed = await setTorRouting(true)
    log(`[egress] tor ensure routing=${routed.ok ? "ok" : routed.reason}`)
    return { mode, ok: routed.ok, detail: routed.ok ? "tor routing active" : (routed.reason ?? "tor routing failed") }
  }
  await setTorRouting(false)
  const ensured = await ensureWarpConnected(log)
  log(`[egress] warp ensure=${ensured.status}`)
  return {
    mode,
    ok: ensured.status === "connected",
    detail: ensured.status === "connected" ? "WARP connected" : ensured.status === "skipped" ? ensured.reason : ensured.reason,
  }
}
