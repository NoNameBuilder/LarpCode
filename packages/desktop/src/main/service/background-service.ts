import { app } from "electron"
import { createServer } from "node:net"
import type { Endpoint } from "@opencode/client/service"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SidecarChanged } from "../../shared/ipc-rpc/events"
import { CHANNEL } from "../constants"
import { emitIpcEvent } from "../ipc-events"
import { getMainWindows } from "../windows"
import { BackgroundServiceMachine } from "./background-service-machine"
import { cleanStages } from "./cli-stages"
import { keptStages, serviceVersion, shouldRetryEnsure } from "./cli-version"
import { DesktopCli } from "./desktop-cli"
import { SidecarCredentials } from "./sidecar-credentials"
import { takeSidecarProbe } from "./sidecar-probe"

export * as BackgroundService from "./background-service"

const RegisteredService = Schema.Struct({ version: Schema.optional(Schema.String), url: Schema.String })

const PREFERRED_SERVICE_PORT = 0x0c0d

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

async function chooseServicePort(): Promise<number> {
  if (await canBind(PREFERRED_SERVICE_PORT)) return PREFERRED_SERVICE_PORT

  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      // SAFETY: Node reports `AddressInfo` for a listening TCP server, or null after close; a null address has no port.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see SAFETY above
      const port = address && typeof address === "object" ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("no free service port"))))
    })
  })
}

export interface Interface {
  readonly connection: Effect.Effect<SidecarCredentials.Data>
  readonly reconnect: Effect.Effect<SidecarCredentials.Data>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | DesktopCli.Service>()

    return Service.of(
      yield* BackgroundServiceMachine.make({
        probe: probe().pipe(Effect.provide(context)),
        ensure: (mode) => ensure(mode).pipe(Effect.provide(context)),
        publish: (data) => {
          SidecarCredentials.set(data)
          // Every window moves its requests and event stream to the new origin, not only the one that reconnected.
          const event = new SidecarChanged({ url: data.url })
          getMainWindows().forEach((win) => emitIpcEvent(win.webContents, event))
        },
      }),
    )
  }),
)

// A compatible service the entry module already found is adopted at once; the machine still verifies it with
// `ensure("initial")` (which also completes a terminal handoff), off the renderer's path.
const probe = Effect.fn("BackgroundService.probe")(function* () {
  const service = yield* Effect.promise(takeSidecarProbe)

  if (!service) return undefined
  const setup = yield* prepare("initial")

  return (yield* adopt(setup, service, true)).credentials
})

const ensure = Effect.fn("BackgroundService.ensure")(function* (mode: BackgroundServiceMachine.ConnectMode) {
  const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>())
  const setup = yield* prepare(mode)
  const environment = setup.stateHome === undefined ? undefined : { XDG_STATE_HOME: setup.stateHome }

  const run = (version = setup.version) =>
    setup.client.Service.ensure({
      file: setup.file,
      // Scan the state directory too: the bundled CLI and the desktop can disagree on the channel
      // name, so the service may register under `service-prod.json` (or another channel file) while
      // the desktop waits on `service-local.json`. Without this the desktop polls a file the CLI
      // never writes and times out while a healthy service is already running.
      directory: setup.directory,
      version,
      // The CLI chooses its registration path from XDG_STATE_HOME; ensure() only reads `file`.
      // Pass the same state root so the child writes where this process probes.
      env: environment,
      // A fixed port makes a second contender fail to bind and back off; port 0 never collides, so two
      // services could boot against the same database. local/dev (LarpCode) gets its own port and
      // state root so the upstream OpenCode desktop can run at the same time.
      command: [
        ...setup.cli.command,
        "serve",
        "--service",
        ...(setup.isolated
          ? ["--hostname", "0.0.0.0", "--port", String(0x0c0c)]
          : setup.port
            ? ["--hostname", "127.0.0.1", "--port", String(setup.port)]
            : []),
      ],
      onStart: (reason, previousVersion) =>
        runFork(Effect.logInfo("v2 CLI background service starting", { reason, previousVersion })),
    })

  const service = yield* Effect.tryPromise(() =>
    run().catch((error) => {
      if (!shouldRetryEnsure(setup.version, error instanceof Error ? error.message : String(error))) throw error

      return run(setup.cli.version)
    }),
  )

  const ready = yield* adopt(setup, service, false)

  // Only packaged and isolated builds run a staged copy; any other binary sits in the source tree.
  // Keep both the bundled stage and the running server's stage so its executable stays on disk. This runs only
  // once `Service.ensure` settled which server runs, never for a probed one it may still replace.
  if (mode === "initial" && (app.isPackaged || setup.isolated) && setup.cli.binary && ready.runningVersion)
    runFork(
      cleanStages(setup.cli.binary, { keep: keptStages(setup.cli.version, ready.runningVersion) }).pipe(
        Effect.catch((error) => Effect.logError("failed to clean staged v2 CLIs", { error })),
      ),
    )

  return ready.credentials
})

const prepare = Effect.fn("BackgroundService.prepare")(function* (mode: BackgroundServiceMachine.ConnectMode) {
  yield* Effect.logInfo("starting v2 background service")
  const path = yield* Path.Path
  const desktopCli = yield* DesktopCli.Service
  const isolated = !app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1"
  const cli = yield* desktopCli.resolve
  const version = serviceVersion({ channel: CHANNEL, isolated, mode, version: cli.version })

  // Every LarpCode build keeps its own registration, separate from an installed
  // OpenCode. configureApplication sets these roots; the fallback covers callers
  // that build this service without running the entry module.
  //
  // The CLI writes <XDG_STATE_HOME>/opencode/service.json, not the path passed
  // to ensure(), so the registration only stays private if the child's state
  // root moves with it. Keep both sides on the same value.
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(app.getPath("userData"), "xdg", "state")

  process.env.XDG_STATE_HOME = stateHome
  const client = yield* Effect.promise(() => import("@opencode/client/service"))

  // The CLI names its registration file by channel: local writes service-local.json so it can run
  // beside upstream OpenCode; other channels write service.json or service-<channel>.json. The
  // directory scan in Service.ensure adopts whichever name the spawned CLI actually chose.
  const directory = path.join(stateHome, "opencode")
  const file = path.join(directory, CHANNEL === "local" ? "service-local.json" : "service.json")

  // A fixed port makes a second contender fail to bind and back off; port 0
  // never collides, so two services could boot against the same database.
  // LarpCode uses its own port so an installed OpenCode can run at the same
  // time. Isolated development still gets its separate fixed port below.
  const port = isolated ? undefined : yield* Effect.promise(chooseServicePort)

  if (port !== undefined && port !== PREFERRED_SERVICE_PORT)
    yield* Effect.logWarning("preferred service port unavailable; using a free port", {
      preferred: PREFERRED_SERVICE_PORT,
      port,
    })

  return { cli, client, file, directory, isolated, version, stateHome, port }
})

const adopt = Effect.fn("BackgroundService.adopt")(function* (
  setup: Effect.Success<ReturnType<typeof prepare>>,
  service: Endpoint,
  probed: boolean,
) {
  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")
  const url = new URL(service.url)

  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"

  const runningVersion = (yield* registration(setup, url.origin))?.version

  yield* Effect.logInfo("v2 CLI background service ready", {
    version: setup.version,
    runningVersion,
    probed,
    ...endpoint(url.origin),
  })

  return {
    credentials: { url: url.origin, password: service.auth.password } satisfies SidecarCredentials.Data,
    runningVersion,
  }
})

// The service can register under any channel name; report the version from the file that actually
// advertised this endpoint rather than from the file the desktop expected.
const registration = Effect.fnUntraced(function* (setup: Effect.Success<ReturnType<typeof prepare>>, origin: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const names = yield* fs.readDirectory(setup.directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

  const files = [setup.file]

  for (const name of names) {
    if (!name.startsWith("service") || !name.endsWith(".json")) continue
    const file = path.join(setup.directory, name)

    if (!files.includes(file)) files.push(file)
  }

  const matches = yield* Effect.forEach(
    files,
    (file) =>
      fs.readFileString(file).pipe(
        Effect.map((text) =>
          Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(RegisteredService))(text)),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    { concurrency: "unbounded" },
  )

  return matches.find((entry) => entry !== undefined && sameOrigin(entry.url, origin))
})

function sameOrigin(left: string, right: string) {
  const normalize = (value: string) => {
    if (!URL.canParse(value)) return undefined
    const url = new URL(value)

    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"

    return url.origin
  }

  const origin = normalize(left)

  return origin !== undefined && origin === normalize(right)
}

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)

  return { url, hostname: parsed.hostname, port: parsed.port }
}
