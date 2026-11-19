import { Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { join } from "node:path"
import type { DiscoverOptions, EnsureOptions, StopOptions } from "../service.js"
import { contenderPool, spawnServiceContender } from "../service-contender.js"
import { defaultEnsureTiming, ensureTiming, type EnsureTiming } from "../service-timing.js"
import { matchesVersion } from "../service-version.js"
import { PtyHandoff } from "../pty-handoff.js"
import { decide, fallback, headers, probeResult, same, type LocalService } from "../service-probe.js"

export * from "../service.js"
export { headers }
/** Contents of the local service registration file. */
export type Info = typeof Info.Type

// Find, start, and stop the local opencode background service.
//
// The service daemon advertises itself through a registration file in the
// user's state directory: url, pid, version, and the private password, with
// 0600 permissions. That file is the complete discovery contract — reading it
// is all a client needs to connect. The daemon's own configuration (port,
// persisted password) is CLI-owned and never read here.

// Read-only lookup: registration file plus health check and version gate.
// Never spawns; escalation to ensure() is the caller's policy.
/** Discover a healthy, compatible local service without starting one. */
export const discover = Effect.fn("service.discover")(function* (options: DiscoverOptions = {}) {
  const found = (yield* registrations(options)).find(
    (entry) =>
      entry.service?.state === "ready" &&
      entry.service.compatible &&
      matchesVersion(entry.service.version, options),
  )?.service
  if (found === undefined) return undefined
  return found.endpoint
})

/** Recognize an authenticated compatible service bound to an expected URL, including while it starts or fails. */
export const incumbent = Effect.fn("service.incumbent")(function* (
  options: DiscoverOptions & { readonly url: string },
) {
  const info = yield* read(options.file)
  if (info === undefined) return undefined
  const found = (yield* Effect.promise(() => probeResult({ ...info, url: options.url }))).service
  if (!found?.compatible) return undefined
  if (!matchesVersion(found.version, options)) return undefined
  return { endpoint: found.endpoint, state: found.state }
})

// Idempotent ensure-running: reuses a healthy compatible server, replaces a
// version-mismatched one, and otherwise spawns small contenders until a server
// becomes discoverable. A contender is never killed merely for slow startup.
/** Ensure a healthy, compatible local service is running. */
export const ensure = Effect.fn("service.ensure")(function* (options: EnsureOptions = {}) {
  const timing = ensureTiming(options)
  const pool = contenderPool(timing)
  let timeouts: { readonly info: Info; readonly count: number } | undefined
  let announced = false
  // Persistent-terminal handoff tickets sit next to the registration that produced them, so spawning
  // must read the same channel-specific file this client last matched.
  let handoff = options.file ?? fallback()
  const announce = (reason: "missing" | "version-mismatch", previousVersion?: string) =>
    Effect.sync(() => {
      if (announced) return
      announced = true
      options.onStart?.(reason, previousVersion)
    })
  const spawnContender = Effect.gen(function* () {
    const [command, ...args] = options.command ?? ["opencode", "serve", "--service"]
    if (command === undefined) return yield* Effect.fail(new Error("Missing service command"))
    const env = yield* Effect.tryPromise(() => PtyHandoff.environment(handoff, options.env))
    return yield* Effect.try({
      try: () => {
        return spawnServiceContender(command, args, env)
      },
      catch: (cause) => new Error("Failed to start server", { cause }),
    })
  })
  const found = yield* Effect.gen(function* () {
    const registration = yield* registered(options, timing.requestTimeout)
    const file = registration.file ?? handoff
    if (registration.file !== undefined) handoff = registration.file
    const info = registration.info
    const service = registration.service
    if (registration.timedOut && info !== undefined) {
      timeouts = {
        info,
        count: timeouts !== undefined && same(timeouts.info, info) ? timeouts.count + 1 : 1,
      }
      if (timeouts.count >= 3) {
        yield* announce("missing")
        yield* Effect.logWarning("Background service is unresponsive; recovery cannot preserve persistent terminals")
        yield* Effect.tryPromise(() => PtyHandoff.clear(file))
        yield* terminate(info, { file }, timing)
        pool.evict(info.pid)
        pool.recruitNow()
        timeouts = undefined
      }
    } else timeouts = undefined
    if (service !== undefined) {
      pool.serviceAnswered()
      const decision = decide(service, options)
      if (decision._tag === "fail") return yield* Effect.fail(decision.error)
      if (decision._tag === "reuse") {
        yield* Effect.tryPromise(() => PtyHandoff.complete(file, service.info))
        return Option.some(service)
      }
      if (decision._tag === "replace") {
        yield* announce("version-mismatch", service.version)
        if (service.state !== "ready")
          yield* Effect.logWarning("Background service is not ready; replacement cannot preserve persistent terminals")
        yield* stop({ file: registration.file, pty: decision.pty }).pipe(Effect.ignore)
        pool.evict(service.info.pid)
      }
      return Option.none()
    }

    const failed = pool.reap()
    if (failed !== undefined) return yield* Effect.fail(failed)
    if (pool.shouldRecruit(info !== undefined)) {
      yield* announce("missing")
      pool.add(yield* spawnContender)
    }
    return Option.none()
  }).pipe(
    Effect.repeat({
      until: Option.isSome,
      // Probes run sequentially, so a slow probe stretches each iteration; bound the loop by wall clock
      // like the Promise variant rather than by attempt count.
      schedule: Schedule.spaced(timing.pollInterval).pipe(Schedule.upTo({ duration: timing.promiseTimeout })),
    }),
    Effect.ensuring(Effect.sync(() => pool.releaseAll())),
  )
  if (Option.isNone(found))
    return yield* Effect.fail(pool.failure() ?? new Error("Timed out waiting for the background service to start"))
  return found.value.endpoint
})

/** Stop the registered local service. */
export const stop = Effect.fn("service.stop")(function* (options: StopOptions = {}) {
  const info = yield* read(options.file)
  // Terminal handoff is best-effort; it must never keep the old service running.
  yield* Effect.tryPromise(() =>
    options.pty === "handoff" && info !== undefined
      ? PtyHandoff.prepare(options.file ?? fallback(), info, defaultEnsureTiming.requestTimeout)
      : PtyHandoff.clear(options.file ?? fallback()),
  ).pipe(Effect.catch((cause) => Effect.logWarning("Failed to prepare persistent terminals for replacement", cause)))
  if (info !== undefined) yield* terminate(info, options, ensureTiming(options))
})

/** Schema for the local service registration file. */
export const Info = Schema.Struct({
  id: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  url: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  password: Schema.optional(Schema.String),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Info))
// A missing or corrupt file means no valid info; callers treat both
// the same (the registering server self-evicts, clients rediscover).
const read = Effect.fnUntraced(function* (file?: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file ?? fallback()).pipe(Effect.option)
  if (Option.isNone(text)) return undefined
  return yield* decode(text.value).pipe(Effect.option, Effect.map(Option.getOrUndefined))
})

const registered = Effect.fnUntraced(function* (options: DiscoverOptions, timeout?: number) {
  const found = yield* registrations(options, timeout)
  if (found.length === 0) return { file: undefined, info: undefined, service: undefined, timedOut: false }
  return found.reduce((best, entry) => (rank(entry, options) > rank(best, options) ? entry : best))
})

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
const registrations = Effect.fnUntraced(function* (options: DiscoverOptions, timeout?: number) {
  const files = yield* candidateFiles(options)
  const decoded = (
    yield* Effect.forEach(
      files,
      (file) =>
        read(file).pipe(Effect.map((info) => (info === undefined ? undefined : { file, info }))),
      { concurrency: "unbounded" },
    )
  ).filter((entry): entry is { file: string; info: Info } => entry !== undefined)

  return yield* Effect.forEach(
    decoded,
    (entry): Effect.Effect<Registration> =>
      Effect.promise(() => probeResult(entry.info, timeout)).pipe(Effect.map((result) => ({ ...entry, ...result }))),
    { concurrency: "unbounded" },
  )
})

const candidateFiles = Effect.fnUntraced(function* (options: DiscoverOptions) {
  const fs = yield* FileSystem.FileSystem
  const file = options.file ?? fallback()
  if (options.directory === undefined) return [file]
  const entries = yield* fs
    .readDirectory(options.directory)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
  const files = [file]
  for (const entry of [...entries].sort()) {
    if (!entry.startsWith("service") || !entry.endsWith(".json")) continue
    const candidate = join(options.directory, entry)
    if (!files.includes(candidate)) files.push(candidate)
  }
  return files
})

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

// 50ms cadence bounded at ~5s, shared by stop escalation and each ensure
// discovery window.
const poll = (timing: EnsureTiming) =>
  Schedule.max([Schedule.spaced(timing.stopPollInterval), Schedule.recurs(timing.stopPollAttempts)])

const signal = (pid: number, name: NodeJS.Signals) =>
  Effect.try({ try: () => process.kill(pid, name), catch: (cause) => cause }).pipe(Effect.ignore)

const stopped = Effect.fnUntraced(function* (pid: number) {
  const running = yield* Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(
    Effect.orElseSucceed(() => false),
  )
  if (!running) return true
  return yield* Effect.fail(new Error(`Server process ${pid} is still running`))
})

const terminate = Effect.fnUntraced(function* (info: Info, options: { readonly file?: string }, timing: EnsureTiming) {
  const current = yield* read(options.file)
  if (current === undefined || !same(current, info)) return
  yield* signal(info.pid, "SIGTERM")
  const done = yield* stopped(info.pid).pipe(Effect.retry(poll(timing)), Effect.option)
  // The registration can disappear or change hands before this process exits. Only the PID we
  // signalled can tell us whether it has stopped, so escalate based on that process.
  if (Option.isNone(done)) {
    yield* signal(info.pid, "SIGKILL")
    yield* stopped(info.pid).pipe(Effect.retry(poll(timing)))
  }
  const latest = yield* read(options.file)
  if (latest === undefined || !same(latest, info)) return
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(options.file ?? fallback()).pipe(Effect.ignore)
})

/** Effect-based local service lifecycle operations. */
export const Service = { discover, incumbent, ensure, stop, headers, Info }
