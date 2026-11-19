import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, Info, EnsureOptions, StopOptions } from "../service.js"
import { contenderPool, spawnServiceContender } from "../service-contender.js"
import { defaultEnsureTiming, ensureTiming, type EnsureTiming } from "../service-timing.js"
import { matchesVersion } from "../service-version.js"
import { PtyHandoff } from "../pty-handoff.js"
import { decide, fallback, headers, probeResult, same, type LocalService } from "../service-probe.js"

export * from "../service.js"
export { fallback, headers }

// Find, start, and stop the local opencode background service.
//
// The registration file is the complete discovery contract. This module is
// intentionally implemented with Node APIs so Promise clients do not need
// Effect or @effect/platform-node at runtime.

/** Discover a healthy, compatible local service without starting one. */
export async function discover(options: DiscoverOptions = {}) {
  const found = (await registrations(options)).find(
    (entry) =>
      entry.service?.state === "ready" &&
      entry.service.compatible &&
      matchesVersion(entry.service.version, options),
  )?.service
  if (found === undefined) return undefined
  return found.endpoint
}

/** Ensure a healthy, compatible local service is running. */
export async function ensure(options: EnsureOptions = {}): Promise<Endpoint> {
  const timing = ensureTiming(options)
  const deadline = Date.now() + timing.promiseTimeout
  const pool = contenderPool(timing)
  let timeouts: { readonly info: Info; readonly count: number } | undefined
  let announced = false
  // Persistent-terminal handoff tickets sit next to the registration that produced them, so spawning
  // must read the same channel-specific file this client last matched.
  let handoff = options.file ?? fallback()

  const announce = (reason: "missing" | "version-mismatch", previousVersion?: string) => {
    if (announced) return
    announced = true
    options.onStart?.(reason, previousVersion)
  }
  const spawnContender = async () => {
    const [command, ...args] = options.command ?? ["opencode", "serve", "--service"]
    if (command === undefined) throw new Error("Missing service command")
    try {
      return spawnServiceContender(command, args, await PtyHandoff.environment(handoff, options.env))
    } catch (cause) {
      throw new Error("Failed to start server", { cause })
    }
  }

  try {
    while (true) {
      if (Date.now() >= deadline)
        throw pool.failure() ?? new Error("Timed out waiting for the background service to start")
      const registration = await registered(options, timing.requestTimeout)
      const file = registration.file ?? handoff
      if (registration.file !== undefined) handoff = registration.file
      if (registration.timedOut && registration.info !== undefined) {
        timeouts = {
          info: registration.info,
          count: timeouts !== undefined && same(timeouts.info, registration.info) ? timeouts.count + 1 : 1,
        }
        if (timeouts.count >= 3) {
          announce("missing")
          console.warn("Background service is unresponsive; recovery cannot preserve persistent terminals")
          await PtyHandoff.clear(file)
          await terminate(registration.info, { file }, timing)
          pool.evict(registration.info.pid)
          pool.recruitNow()
          timeouts = undefined
        }
      } else timeouts = undefined

      if (registration.service !== undefined) {
        pool.serviceAnswered()
        const service = registration.service
        const decision = decide(service, options)
        if (decision._tag === "fail") throw decision.error
        if (decision._tag === "reuse") {
          await PtyHandoff.complete(file, service.info)
          return service.endpoint
        }
        if (decision._tag === "replace") {
          announce("version-mismatch", service.version)
          if (service.state !== "ready")
            console.warn("Background service is not ready; replacement cannot preserve persistent terminals")
          await stop({ file: registration.file, pty: decision.pty }).catch(() => undefined)
          pool.evict(service.info.pid)
        }
      } else {
        const failed = pool.reap()
        if (failed !== undefined) throw failed
        if (pool.shouldRecruit(registration.info !== undefined)) {
          announce("missing")
          pool.add(await spawnContender())
        }
      }
      await delay(timing.pollInterval)
    }
  } finally {
    pool.releaseAll()
  }
}

/** Stop the registered local service. */
export async function stop(options: StopOptions = {}) {
  const info = await read(options.file)
  // Terminal handoff is best-effort; it must never keep the old service running.
  await (
    options.pty === "handoff" && info !== undefined
      ? PtyHandoff.prepare(options.file ?? fallback(), info, defaultEnsureTiming.requestTimeout)
      : PtyHandoff.clear(options.file ?? fallback())
  ).catch((cause: unknown) => console.warn("Failed to prepare persistent terminals for replacement", cause))
  if (info !== undefined) await terminate(info, options, ensureTiming(options))
}

async function read(file?: string) {
  const text = await readFile(file ?? fallback(), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Info
  } catch {
    return undefined
  }
}

async function registered(options: DiscoverOptions, timeout?: number) {
  const found = await registrations(options, timeout)
  if (found.length === 0) return { file: undefined, info: undefined, service: undefined, timedOut: false }
  const best = found.reduce((best, entry) => (rank(entry, options) > rank(best, options) ? entry : best))
  return best
}

type Registration = {
  readonly file: string
  readonly info: Info
  readonly timedOut: boolean
  readonly service?: LocalService
}

/**
 * Registrations behind every channel-specific name in the directory. A service started by a build
 * whose channel differs from the client's uses another file (`service-prod.json` versus
 * `service-local.json`), so the starter must adopt the file that actually appeared.
 */
async function registrations(options: DiscoverOptions, timeout?: number) {
  const files = await candidateFiles(options)
  const decoded = (
    await Promise.all(
      files.map(async (file) => {
        const info = await read(file)
        return info === undefined ? undefined : { file, info }
      }),
    )
  ).filter((entry): entry is { file: string; info: Info } => entry !== undefined)

  return (
    await Promise.all(
      decoded.map(async (entry): Promise<Registration> => {
        const result = await probeResult(entry.info, timeout)
        return { ...entry, ...result }
      }),
    )
  )
}

async function candidateFiles(options: DiscoverOptions) {
  const file = options.file ?? fallback()
  if (options.directory === undefined) return [file]
  const entries = await readdir(options.directory).catch(() => [] as string[])
  const files = [file]
  for (const entry of entries.sort()) {
    if (!entry.startsWith("service") || !entry.endsWith(".json")) continue
    const candidate = join(options.directory, entry)
    if (!files.includes(candidate)) files.push(candidate)
  }
  return files
}

/**
 * Prefer a service that can be reused, then one that must be replaced, then one that is still
 * starting, and only finally a registration that cannot answer at all.
 */
function rank(entry: Registration, options: DiscoverOptions) {
  if (entry.service === undefined) return 0
  const { service } = entry
  if (!service.compatible) return service.state === "ready" ? 1 : 0
  const matches = matchesVersion(service.version, options)
  if (service.state === "ready") return matches ? 6 : 5
  if (service.state === "waiting") return matches ? 4 : 3
  return matches ? 2 : 1
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

function stopped(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function waitUntilStopped(pid: number, timing: EnsureTiming) {
  for (let attempt = 0; attempt <= timing.stopPollAttempts; attempt++) {
    if (stopped(pid)) return true
    if (attempt < timing.stopPollAttempts) await delay(timing.stopPollInterval)
  }
  return false
}

async function terminate(info: Info, options: { readonly file?: string }, timing: EnsureTiming) {
  const current = await read(options.file)
  if (current === undefined || !same(current, info)) return
  signal(info.pid, "SIGTERM")
  // The registration can disappear or change hands before this process exits. Only the PID we
  // signalled can tell us whether it has stopped, so escalate based on that process.
  if (!(await waitUntilStopped(info.pid, timing))) {
    signal(info.pid, "SIGKILL")
    if (!(await waitUntilStopped(info.pid, timing))) throw new Error(`Server process ${info.pid} is still running`)
  }
  const latest = await read(options.file)
  if (latest === undefined || !same(latest, info)) return
  await rm(options.file ?? fallback(), { force: true })
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

/** Promise-based local service lifecycle operations. */
export const Service = { discover, ensure, stop, headers }
