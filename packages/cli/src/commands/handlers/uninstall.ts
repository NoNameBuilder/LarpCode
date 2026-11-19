import { confirm, intro, log, outro, spinner } from "@clack/prompts"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Schedule } from "effect"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { RetainedImage } from "../../services/retained-image"
import { Updater } from "../../services/updater"
import { handlePromptErrors, prompt, requireInteractive } from "../../ui/prompt"
import { errorMessage } from "../../util/error"

type StandaloneInstall = {
  root: string
  bin: string
  shim?: string
}

// The standalone installer owns one directory. Only treat this process as an
// installed standalone CLI when it runs from that exact location; a downloaded
// `larpcode.exe` in Downloads must never delete its own folder.
function standaloneInstall(home: string): StandaloneInstall | undefined {
  if (process.platform !== "win32") return undefined
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const root = path.resolve(local, "Programs", "LarpCode CLI")
  const executable = path.resolve(process.execPath)
  const bin = path.dirname(executable)
  if (path.basename(executable).toLowerCase() !== "larpcode.exe") return undefined
  if (bin.toLowerCase() !== path.resolve(root, "bin").toLowerCase()) return undefined
  const shim = path.join(home, ".local", "bin", "larpcode.cmd")
  return { root, bin, shim: isLarpcodeShim(shim) ? shim : undefined }
}

function isLarpcodeShim(file: string) {
  try {
    const content = readFileSync(file, "utf8")
    return /larpcode\.exe/i.test(content) && /(?:larpcode cli|%localappdata%)/i.test(content)
  } catch {
    return false
  }
}

function psQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function standaloneCleanupScript(install: StandaloneInstall) {
  const bin = psQuote(install.bin)
  const root = psQuote(install.root)
  const shim = install.shim ? psQuote(install.shim) : "''"
  return `
$ErrorActionPreference = 'SilentlyContinue'
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($path) {
  $target = ${bin}
  $entries = @($path -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $target.TrimEnd('\\') })
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}
$shim = ${shim}
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  if ($shim) { Remove-Item -LiteralPath $shim -Force }
  Remove-Item -LiteralPath ${root} -Recurse -Force
  if (-not (Test-Path -LiteralPath ${root}) -and (-not $shim -or -not (Test-Path -LiteralPath $shim))) { break }
  Start-Sleep -Milliseconds 250
}
`
}

// Windows cannot delete the running executable. PowerShell's Start-Process
// launches a hidden helper that outlives us, removes the PATH entry, and
// retries the shim and install folder until the running image is released.
// The launching shell exits immediately, so the uninstall command does not
// block.
function scheduleStandaloneRemoval(install: StandaloneInstall) {
  const encoded = Buffer.from(standaloneCleanupScript(install), "utf16le").toString("base64")
  const inner = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]
  const command = `Start-Process -FilePath powershell.exe -ArgumentList @(${inner.map(psQuote).join(", ")}) -WindowStyle Hidden`
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `PowerShell exited with ${result.status}`)
}

export default Runtime.handler(
  Commands.commands.uninstall,
  Effect.fn("cli.uninstall")(function* (input) {
    intro("Uninstall LarpCode")
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    const updater = yield* Updater.Service
    const method = yield* updater.method()
    const removal = method ? updater.removal(method) : undefined
    // Data, config, and state hold sessions, credentials, settings, and prompt history; uninstall only removes the cache.
    // All channels share the cache. Stop background services before deleting it.
    // Read registrations directly: ServiceConfig.options() can migrate files even during a dry run.
    const services = (yield* fs.exists(global.state))
      ? (yield* fs.readDirectory(global.state)).filter((name) => /^service(?:-.*)?\.json$/.test(name))
      : []
    const shell = method === "curl" ? yield* shellConfigs(global.home) : []
    const standalone = method === "standalone" ? standaloneInstall(global.home) : undefined

    log.info(`Installation method: ${method ?? "unknown"}`)
    log.message("The following global files will be removed (shared by LarpCode versions and channels):")
    if (yield* fs.exists(global.cache)) log.info(`  Cache: ${global.cache}`)
    services.forEach((name) =>
      log.info(`  Stop background service and persistent terminals: ${path.join(global.state, name)}`),
    )
    shell.forEach((file) => log.info(`  Shell PATH: ${file}`))
    if (removal) log.info(`  Package: ${removal.command.join(" ")}`)
    if (standalone) {
      log.info(`  CLI install: ${standalone.root}`)
      log.info(`  User PATH entry: ${standalone.bin}`)
      if (standalone.shim) log.info(`  Command shim: ${standalone.shim}`)
    } else if (method === "curl" || method === "standalone") {
      log.info(`  Binary (manual removal): ${process.execPath}`)
    }
    if (!method) log.warn("Could not detect the installation method. Remove the installation manually after cleanup.")

    if (input.dryRun) {
      log.warn("Dry run - no changes made")
      outro("Done")
      return
    }
    if (!input.force) {
      yield* requireInteractive("Use --force to uninstall without an interactive terminal, or --dry-run to preview.")
      const accepted = yield* prompt(() =>
        confirm({ message: "Are you sure you want to uninstall?", initialValue: false }),
      )
      if (!accepted) {
        outro("Cancelled")
        return
      }
    }

    const progress = spinner()
    if (services.length) {
      progress.start("Stopping background services...")
      yield* Effect.forEach(services, (name) =>
        Effect.gen(function* () {
          const options = { file: path.join(global.state, name) }
          yield* ServerConnection.shutdownPersistentPty(options).pipe(Effect.ignore)
          yield* Service.stop(options)
        }),
      ).pipe(
        Effect.tap(() => Effect.sync(() => progress.stop("Background services stopped"))),
        Effect.tapCause(() => Effect.sync(() => progress.stop("Failed to stop background services", 1))),
      )
    }

    // Links that keep an older LarpCode replaceable may still run; move them so the cache can go.
    if (process.platform === "win32") yield* RetainedImage.relocate(global.cache, global.tmp)
    const errors: string[] = []
    progress.start("Removing Cache...")
    yield* fs.remove(global.cache, { recursive: true, force: true }).pipe(
      // Windows reports a terminated service as gone before it releases its file handles,
      // so the first removal can race that teardown.
      Effect.retry({
        while: (error) => process.platform === "win32" && error.reason._tag === "Busy",
        schedule: Schedule.max([Schedule.spaced("250 millis"), Schedule.recurs(40)]),
      }),
      Effect.tap(() => Effect.sync(() => progress.stop("Removed Cache"))),
      Effect.catch((error) =>
        Effect.sync(() => {
          progress.stop("Failed to remove Cache", 1)
          errors.push(`Cache: ${errorMessage(error)}`)
        }),
      ),
    )
    yield* Effect.forEach(shell, (file) =>
      fs.readFileString(file).pipe(
        Effect.flatMap((content) => fs.writeFileString(file, cleanShellConfig(content))),
        Effect.catch((error) => Effect.sync(() => errors.push(`Shell config ${file}: ${errorMessage(error)}`))),
      ),
    )
    if (removal) {
      progress.start(`Running ${removal.command.join(" ")}...`)
      yield* removal.run.pipe(
        Effect.tap(() => Effect.sync(() => progress.stop("Package removed"))),
        Effect.catch((error) =>
          Effect.sync(() => {
            progress.stop("Package manager uninstall failed", 1)
            errors.push(errorMessage(error))
            log.warn(`Run manually: ${removal.command.join(" ")}`)
          }),
        ),
      )
    }
    if (method === "curl") {
      log.message("To finish removing the binary, run:")
      log.info(`  rm '${process.execPath.replaceAll("'", "'\\''")}'`)
    }
    if (method === "standalone" && standalone) {
      const removalError = yield* Effect.try({
        try: () => scheduleStandaloneRemoval(standalone),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) => errorMessage(cause),
          onSuccess: () => undefined,
        }),
      )
      if (removalError === undefined) {
        log.info("The CLI, its PATH entry, and its command shim will be removed when this process exits.")
      } else {
        errors.push(`CLI removal: ${removalError}`)
        log.message("Close every LarpCode window, then remove the CLI manually:")
        log.info(`  Remove-Item -LiteralPath ${psQuote(standalone.root)} -Recurse -Force`)
        log.info(`  Remove-Item -LiteralPath ${psQuote(standalone.bin)} -Force`)
      }
    } else if (method === "standalone") {
      log.message("This standalone binary was not installed by install-cli.ps1. Remove it manually:")
      log.info(`  Remove-Item -LiteralPath ${psQuote(process.execPath)} -Force`)
    }
    if (errors.length) yield* Effect.fail(new Error(errors.join("\n")))
    outro("Done")
  }, handlePromptErrors),
)

const shellConfigs = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const bin = path.dirname(process.execPath)
  // V1 and V2 curl installs share a PATH entry; retain it while another binary uses it.
  if ((yield* fs.readDirectory(bin)).some((name) => name !== path.basename(process.execPath))) return []
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  const zsh = process.env.ZDOTDIR || home
  const candidates: Record<string, string[]> = {
    fish: [path.join(home, ".config/fish/config.fish"), path.join(xdg, "fish/config.fish")],
    zsh: [
      path.join(zsh, ".zshrc"),
      path.join(zsh, ".zshenv"),
      path.join(xdg, "zsh/.zshrc"),
      path.join(xdg, "zsh/.zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdg, "bash/.bashrc"),
      path.join(xdg, "bash/.bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".ashrc"), path.join(home, ".profile")],
  }
  const files = [...new Set(candidates[path.basename(process.env.SHELL || "bash")] ?? candidates.bash)]
  return yield* Effect.filter(files, (file) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => cleanShellConfig(content) !== content),
      Effect.orElseSucceed(() => false),
    ),
  )
})

function cleanShellConfig(content: string) {
  const lines = content.split("\n")
  const entry = (line: string) =>
    /^(?:export PATH=|fish_add_path\s)/.test(line.trim()) && line.includes(".opencode/bin")
  return lines
    .filter((line, index) => !entry(line) && !(line.trim() === "# opencode" && entry(lines[index + 1] ?? "")))
    .join("\n")
}
