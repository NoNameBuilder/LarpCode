import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { findWarp } from "./larpcode-dependencies.js"

// Cloudflare WARP control used by both the automatic free-limit rotation and
// the manual Reset action.
//
// The previous automatic path deleted the registration and created a new one
// without ever reconnecting. WARP therefore stayed down, every request left on
// the raw ISP address, and the rotation looked like it did nothing. This module
// treats "connected" as the contract: every path either leaves WARP connected
// or reports the exact step that failed.
//
// The sequence is deliberately ordered:
//   1. make sure WARP is connected before measuring the "before" address;
//   2. disconnect fully and wait for the daemon to report it;
//   3. replace the free registration (or rotate tunnel keys when the account is
//      not a free consumer registration);
//   4. connect again and poll until the daemon reports Connected;
//   5. probe the egress address and report whether it actually changed.
//
// `warp-cli connect` returns before the tunnel is usable, so every wait is a
// poll on `warp-cli status`, never a fixed sleep.

export type WarpState = "connected" | "connecting" | "disconnected" | "unknown"

export type WarpCycleOutcome =
  | { status: "rotated"; ip_before: string; ip_after: string; steps: string[] }
  | { status: "same_ip"; ip: string; ip_before: string; ip_after: string; steps: string[] }
  | { status: "unverified"; ip_before: string | null; ip_after: string | null; steps: string[] }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string; ip_before?: string | null; steps: string[] }

export type WarpRotationOptions = {
  /** Diagnostic sink. Defaults to <data>/opencode/log/larpcode-diag.log. */
  log?: (line: string) => void
  /** How long to wait for `warp-cli status` to report Connected. */
  connectTimeoutMs?: number
  /** How long to retry the egress probe after the tunnel reports Connected. */
  probeTimeoutMs?: number
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
  error?: string
}

const CONNECT_TIMEOUT_MS = 45_000
const PROBE_TIMEOUT_MS = 20_000
const STATUS_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 25_000
const ANSI = /\u001b\[[0-9;]*m/g

function diagPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
  return path.join(data, "opencode", "log", "larpcode-diag.log")
}

function defaultLog(line: string): void {
  try {
    const file = diagPath()
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch {
    /* diagnostics must never break rotation */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clean(value: string): string {
  return value.replace(ANSI, "").trim()
}

function oneLine(value: string): string {
  const text = clean(value).replace(/\r?\n/g, " | ")
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

function runWarp(warp: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      warp,
      ["--accept-tos", ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : 1
        resolve({
          code,
          stdout: clean(String(stdout ?? "")),
          stderr: clean(String(stderr ?? "")),
          error: error?.message,
        })
      },
    )
  })
}

function parseStatus(raw: string): WarpState {
  const text = clean(raw)
  if (/Status update:\s*Connected/i.test(text) && !/Connecting/i.test(text)) return "connected"
  if (/Status update:\s*Connecting/i.test(text) || /Performing connectivity checks/i.test(text)) return "connecting"
  if (/Status update:\s*Disconnected/i.test(text)) return "disconnected"
  return "unknown"
}

export type WarpStatus = {
  state: WarpState
  raw: string
}

export async function readWarpStatus(): Promise<WarpStatus | undefined> {
  const warp = findWarp()
  if (!warp) return undefined
  const result = await runWarp(warp, ["status"], STATUS_TIMEOUT_MS)
  const raw = result.stdout || result.stderr
  return { state: parseStatus(raw), raw: oneLine(raw) }
}

async function readStatus(warp: string): Promise<WarpStatus> {
  const result = await runWarp(warp, ["status"], STATUS_TIMEOUT_MS)
  const raw = result.stdout || result.stderr
  return { state: parseStatus(raw), raw: oneLine(raw) }
}

async function waitForState(warp: string, wanted: WarpState, timeoutMs: number): Promise<WarpStatus> {
  const deadline = Date.now() + timeoutMs
  let status = await readStatus(warp)
  while (status.state !== wanted && Date.now() < deadline) {
    await sleep(750)
    status = await readStatus(warp)
  }
  return status
}

// Probe the address the outside world sees. 1.1.1.1's trace endpoint is the
// most reliable through WARP, with the other two as fallbacks for networks
// that block the anycast address.
async function probeEgressIp(timeoutMs: number): Promise<string | null> {
  const urls = [
    "https://1.1.1.1/cdn-cgi/trace",
    "https://www.cloudflare.com/cdn-cgi/trace",
    "https://api.ipify.org",
  ]
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "cache-control": "no-cache" },
      })
      if (!response.ok) continue
      const text = (await response.text()).trim()
      if (url.endsWith("api.ipify.org")) {
        if (/^[0-9a-fA-F:.]+$/.test(text)) return text
        continue
      }
      const match = /(?:^|\n)ip=([^\r\n]+)/.exec(text)
      if (match) return match[1].trim()
    } catch {
      /* try the next probe */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

async function registrationMissing(warp: string): Promise<boolean> {
  const result = await runWarp(warp, ["registration", "show"], STATUS_TIMEOUT_MS)
  return result.code !== 0 && /missing registration/i.test(`${result.stdout}\n${result.stderr}`)
}

async function ensureConnected(
  warp: string,
  log: (line: string) => void,
  steps: string[],
  timeoutMs: number,
): Promise<WarpStatus> {
  const current = await readStatus(warp)
  steps.push(`status before connect=${current.state}`)
  if (current.state === "connected") return current

  if (await registrationMissing(warp)) {
    const created = await runWarp(warp, ["registration", "new"], 35_000)
    steps.push(`registration new (bootstrap) code=${created.code} out=${oneLine(created.stdout || created.stderr)}`)
    log(`[warp] bootstrap registration code=${created.code}`)
  }

  const connected = await runWarp(warp, ["connect"], 20_000)
  steps.push(`connect code=${connected.code} out=${oneLine(connected.stdout || connected.stderr)}`)
  log(`[warp] connect code=${connected.code}`)

  const status = await waitForState(warp, "connected", timeoutMs)
  steps.push(`status after connect=${status.state}`)
  log(`[warp] status after connect=${status.state}`)
  return status
}

export type WarpEnsureOutcome =
  | { status: "connected"; wasConnected: boolean; raw: string }
  | { status: "failed"; reason: string; raw: string }
  | { status: "skipped"; reason: string }

// Idempotent "make sure WARP is actually carrying traffic" used at sidecar
// startup and before a rotation. It never deletes the registration.
export async function ensureWarpConnected(log = defaultLog): Promise<WarpEnsureOutcome> {
  const warp = findWarp()
  if (!warp) {
    log("[warp] ensure skipped: warp-cli not installed")
    return { status: "skipped", reason: "warp-cli not installed" }
  }
  const steps: string[] = []
  try {
    const before = await readStatus(warp)
    const status = await ensureConnected(warp, log, steps, CONNECT_TIMEOUT_MS)
    if (status.state === "connected") {
      log(`[warp] ensure connected was=${before.state}`)
      return { status: "connected", wasConnected: before.state === "connected", raw: status.raw }
    }
    log(`[warp] ensure failed was=${before.state} now=${status.state}`)
    return { status: "failed", reason: `WARP status is ${status.state}`, raw: status.raw }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[warp] ensure threw: ${message}`)
    return { status: "failed", reason: message, raw: steps.join(" | ") }
  }
}

// Rotate the WARP identity and leave the tunnel connected. Returns a structured
// outcome instead of throwing so callers can report it without failing the
// surrounding request or reset.
export async function rotateWarpEgress(options: WarpRotationOptions = {}): Promise<WarpCycleOutcome> {
  const warp = findWarp()
  const log = options.log ?? defaultLog
  if (!warp) {
    log("[warp] rotation skipped: warp-cli not installed")
    return { status: "skipped", reason: "warp-cli not installed" }
  }

  const steps: string[] = []
  const step = (line: string) => {
    steps.push(line)
    log(`[warp] ${line}`)
  }
  const connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const probeTimeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS

  let ipBefore: string | null = null
  let lastStep = "prepare"

  try {
    // Measure only after WARP is up. If it was disconnected, the "before"
    // address would be the raw ISP address and a successful WARP connect would
    // look like a rotation even though no identity changed.
    const initial = await ensureConnected(warp, log, steps, connectTimeout)
    step(`initial status=${initial.state}`)
    if (initial.state !== "connected") {
      return {
        status: "failed",
        step: "connect",
        error: `WARP did not reach Connected (status: ${initial.state})`,
        steps,
      }
    }

    ipBefore = await probeEgressIp(8_000)
    step(`ip_before=${ipBefore ?? "unknown"}`)

    // Disconnect fully. `warp-cli` accepts commands while the tunnel is still
    // tearing down, and deleting a registration before the daemon notices is
    // exactly how the old code produced "Old registration is still around".
    lastStep = "disconnect"
    await runWarp(warp, ["disconnect"], 15_000)
    const down = await waitForState(warp, "disconnected", 15_000)
    step(`disconnected status=${down.state}`)

    lastStep = "registration"
    const show = await runWarp(warp, ["registration", "show"], STATUS_TIMEOUT_MS)
    const freeAccount = /Account type:\s*Free/i.test(`${show.stdout}\n${show.stderr}`)
    let registrationRotated = false

    if (!freeAccount) {
      // Deleting a Zero Trust registration would remove the user's
      // organization binding. Rotate tunnel keys instead and leave the
      // registration untouched.
      step("registration keep: account is not a free consumer registration")
    } else {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const deleted = await runWarp(warp, ["registration", "delete"], 20_000)
        step(
          `registration delete attempt=${attempt} code=${deleted.code} out=${oneLine(deleted.stdout || deleted.stderr)}`,
        )
        if (await registrationMissing(warp)) {
          registrationRotated = true
          break
        }
        await sleep(1_000)
      }

      if (registrationRotated) {
        const created = await runWarp(warp, ["registration", "new"], 35_000)
        step(`registration new code=${created.code} out=${oneLine(created.stdout || created.stderr)}`)
        if (created.code !== 0 && !/already/i.test(`${created.stdout}\n${created.stderr}`)) {
          registrationRotated = false
        }
      }
    }

    if (!registrationRotated) {
      lastStep = "rotate-keys"
      const rotated = await runWarp(warp, ["tunnel", "rotate-keys"], 20_000)
      step(`rotate-keys code=${rotated.code} out=${oneLine(rotated.stdout || rotated.stderr)}`)
      if (rotated.code !== 0) {
        // The delete may have succeeded while `registration new` failed. Do
        // not return with WARP down: recreate a registration, then reconnect
        // below. The egress probe still decides whether the identity moved.
        step("rotate-keys failed; attempting registration recovery")
        if (await registrationMissing(warp)) {
          const recovered = await runWarp(warp, ["registration", "new"], 35_000)
          step(`registration recovery code=${recovered.code} out=${oneLine(recovered.stdout || recovered.stderr)}`)
        }
      }
    }

    lastStep = "connect"
    const connected = await runWarp(warp, ["connect"], 20_000)
    step(`connect code=${connected.code} out=${oneLine(connected.stdout || connected.stderr)}`)
    let up = await waitForState(warp, "connected", connectTimeout)

    if (up.state !== "connected") {
      // One bounded retry. A protocol handshake can lose the first attempt
      // without leaving the daemon in a bad state.
      await runWarp(warp, ["disconnect"], 10_000)
      await runWarp(warp, ["connect"], 20_000)
      up = await waitForState(warp, "connected", connectTimeout)
      step(`retry status=${up.state}`)
    }

    if (up.state !== "connected") {
      // Never return with WARP down. Leave the daemon trying even when the
      // rotation is reported as failed.
      await runWarp(warp, ["connect"], 10_000)
      return {
        status: "failed",
        step: "connect",
        error: `WARP status is ${up.state} after reconnect`,
        ip_before: ipBefore,
        steps,
      }
    }

    // The tunnel reports Connected before the egress route always settles.
    let ipAfter: string | null = null
    const deadline = Date.now() + probeTimeout
    while (Date.now() < deadline) {
      ipAfter = await probeEgressIp(6_000)
      if (ipAfter) break
      await sleep(1_500)
    }
    step(`ip_after=${ipAfter ?? "unknown"}`)

    if (!ipAfter) return { status: "unverified", ip_before: ipBefore, ip_after: null, steps }
    if (!ipBefore) return { status: "unverified", ip_before: null, ip_after: ipAfter, steps }
    if (ipBefore === ipAfter) {
      return { status: "same_ip", ip: ipAfter, ip_before: ipBefore, ip_after: ipAfter, steps }
    }
    return { status: "rotated", ip_before: ipBefore, ip_after: ipAfter, steps }
  } catch (error) {
    // A thrown step (spawn failure, timeout, unexpected output) must not leave
    // the machine unprotected. Try one last connect before reporting.
    const message = error instanceof Error ? error.message : String(error)
    step(`exception step=${lastStep} error=${message}`)
    try {
      await runWarp(warp, ["connect"], 10_000)
    } catch {
      /* best effort */
    }
    return { status: "failed", step: lastStep, error: message, ip_before: ipBefore, steps }
  }
}
