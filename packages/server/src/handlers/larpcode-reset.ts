import { Database } from "@opencode/core/database/database"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { sql } from "drizzle-orm"
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { randomBytes as nodeRandomBytes } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { rotateEgress } from "@opencode/core/larpcode-egress"
import { LarpcodeAbliterated } from "@opencode/core/larpcode-abliterated"
import * as LarpcodeImpersonateFetch from "@opencode/util/larpcode-impersonate-fetch"

// LarpCode: side-channel routes the Reset button and the Abliterated setting
// call. There is no license, activation or signed-directive layer here: the
// app is fully usable without a key, so reset is a local operation.
//
// Shallow (default): zeroes aggregate token / cost columns on every session_v2
// row and purges the three usage event types. Local-only — Console budgets are
// untouched.
//
// Deep (?deep=1, ?mode=fresh, ?mode=fast or ?mode=deep): drops every row from
// every table that would make this install look recognisable to opencode.ai —
// sessions, projects, events, kv. Runs entirely in-process: snapshot the DB,
// wipe, checkpoint the WAL, rotate the local fingerprint, rotate egress
// (Tor/WARP when available), then return a structured result. The renderer
// reloads when the call returns.
//
// jsonUnsafe (not json) because json() returns Effect<HttpServerResponse> —
// yielding Effect<Effect<Response>> breaks the Node adapter's response reader.

// Belt-and-suspenders preflight response. The Electron renderer lives at
// `oc://renderer` and every sidecar POST is cross-origin from Chromium's
// point of view. The reset callers in packages/app set `authorization` and
// `content-type: application/json` to ride CORS-complex, which forces a
// browser OPTIONS preflight. The outer HttpMiddleware.cors in
// packages/server/src/process.ts should answer it, but if any future
// refactor reorders the middleware stack (or an embedder calls
// createRoutes without wrapping CORS at all), the router falls through to
// 405 Method Not Allowed and the reset pill dies with "HTTP 405". Owning
// the OPTIONS leg here guarantees the preflight succeeds regardless.
const PREFLIGHT_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
}

const preflight = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers.origin
  return HttpServerResponse.empty({
    status: 204,
    headers: origin
      ? {
          ...PREFLIGHT_HEADERS,
          "access-control-allow-origin": origin,
          vary: "origin",
        }
      : PREFLIGHT_HEADERS,
  })
})

export const larpcodePreflight = preflight

export const LarpcodeResetLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // LarpCode: snapshot the live SQLite database to a self-contained .db
    // file under <data-dir>/session-backups/<timestamp>.db. One VACUUM INTO
    // call writes a complete copy (every table, every blob, every row) with
    // no WAL dependency, so the file can be opened offline or swapped back
    // into place with a straight copy. Called by the Usage reset pill BEFORE
    // the deep wipe; a failure here aborts the reset so sessions are never
    // lost silently.
    yield* router.add("OPTIONS", "/_larpcode/export-sessions", preflight)
    yield* router.add("OPTIONS", "/_larpcode/reset-limits", preflight)
    yield* router.add("OPTIONS", "/_larpcode/free-route/retry", preflight)
    yield* router.add("OPTIONS", "/_larpcode/abliterated", preflight)
    yield* router.add("OPTIONS", "/_larpcode/abliterated/content", preflight)
    yield* router.add(
      "GET",
      "/_larpcode/abliterated/content",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const model = LarpcodeAbliterated.modelRef(url.searchParams.get("provider"), url.searchParams.get("model"))
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          enabled: LarpcodeAbliterated.enabled(),
          custom: LarpcodeAbliterated.custom(),
          selection: LarpcodeAbliterated.selection(),
          profiles: LarpcodeAbliterated.profiles(),
          active: LarpcodeAbliterated.activeProfile(model),
          content: LarpcodeAbliterated.content(model),
          default: LarpcodeAbliterated.DefaultContent,
          max: LarpcodeAbliterated.MaxContentLength,
        })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/abliterated/content",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const parsed = yield* Effect.result(request.json)
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })
        const body = parsed.success
        const input =
          body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
        const profile = typeof input.profile === "string" ? input.profile : undefined
        const reset = input.reset === true
        const content = typeof input.content === "string" ? input.content : undefined
        if (Number(profile !== undefined) + Number(reset) + Number(content !== undefined) !== 1)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "exactly one of profile, content, or reset is required" },
            { status: 400 },
          )
        if (profile !== undefined && !LarpcodeAbliterated.hasProfile(profile))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: `unknown profile: ${profile}` }, { status: 400 })
        if (content !== undefined && content.length > LarpcodeAbliterated.MaxContentLength)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `content exceeds ${LarpcodeAbliterated.MaxContentLength} characters` },
            { status: 413 },
          )
        const result = yield* Effect.result(
          Effect.try({
            try: () => {
              if (profile !== undefined) LarpcodeAbliterated.setProfile(profile)
              else if (reset) LarpcodeAbliterated.resetContent()
              else LarpcodeAbliterated.setContent(content ?? "")
            },
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write instructions: ${String(result.failure)}` },
            { status: 500 },
          )
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          custom: LarpcodeAbliterated.custom(),
          selection: LarpcodeAbliterated.selection(),
          active: LarpcodeAbliterated.activeProfile(),
          length: LarpcodeAbliterated.content().length,
        })
      }),
    )
    yield* router.add(
      "GET",
      "/_larpcode/abliterated",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          enabled: LarpcodeAbliterated.enabled(),
          selection: LarpcodeAbliterated.selection(),
          profiles: LarpcodeAbliterated.profiles(),
          active: LarpcodeAbliterated.activeProfile(),
        })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/abliterated",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const enabled = url.searchParams.get("enabled") === "1"
        const result = yield* Effect.result(
          Effect.try({
            try: () => LarpcodeAbliterated.setEnabled(enabled),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write setting: ${String(result.failure)}` },
            { status: 500 },
          )
        }
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled })
      }),
    )
    yield* router.add(
      "GET",
      "/_larpcode/free-route",
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe({ ok: true, freeRoute: LarpcodeImpersonateFetch.freeRouteStatus() }),
      ),
    )
    yield* router.add(
      "POST",
      "/_larpcode/free-route/retry",
      Effect.sync(() => {
        // Clear only the local routing decision. The upstream shared pool is
        // still authoritative; the next request simply probes it again.
        LarpcodeImpersonateFetch.clearFreeLimit()
        return HttpServerResponse.jsonUnsafe({ ok: true, freeRoute: LarpcodeImpersonateFetch.freeRouteStatus() })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/export-sessions",
      Effect.gen(function* () {
        const service = yield* Database.Service
        const backupsDir = resolveBackupsDir()
        try {
          mkdirSync(backupsDir, { recursive: true })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `cannot create backup dir: ${(e as Error).message}` },
            { status: 500 },
          )
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const dest = path.join(backupsDir, `sessions-${stamp}.db`)
        // VACUUM INTO path literal — SQLite rejects parameters here, so
        // we escape single quotes manually (POSIX path chars don't need
        // more). The dir is server-chosen, never user input.
        const escaped = dest.replace(/'/g, "''")
        const vacuum = yield* Effect.result(service.db.run(sql.raw(`VACUUM INTO '${escaped}'`)))
        if (vacuum._tag === "Failure") {
          const message = vacuum.failure instanceof Error ? vacuum.failure.message : String(vacuum.failure)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: `vacuum failed: ${message}` }, { status: 500 })
        }
        let bytes = 0
        try {
          bytes = statSync(dest).size
        } catch {}
        return HttpServerResponse.jsonUnsafe({ ok: true, path: dest, bytes })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/reset-limits",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const mode = url.searchParams.get("mode")
        // Every explicit reset mode performs the full ritual. `fast` is
        // accepted for older renderers and rewritten to the same deep path
        // because egress rotation alone never moved the anonymous quota
        // bucket in production.
        const deep = url.searchParams.get("deep") === "1" || mode === "fresh" || mode === "fast" || mode === "deep"
        const nukeCredentials = url.searchParams.get("nuke-credentials") === "1"
        // A reset is the user's explicit "try again now" gesture. Drop the
        // local free-limit cooldown before doing any work so the next model
        // request probes opencode.ai instead of replaying the cached refusal.
        LarpcodeImpersonateFetch.clearFreeLimit()
        diagWrite(`[reset] start mode=${mode ?? "default"} deep=${deep}`)

        // Database.Service pull is wrapped in Either so a dependency-
        // resolution failure (service not provided to this route, context
        // layer not initialised yet) doesn't escape as a bare 500. If the
        // extraction fails the pill gets a structured response explaining
        // why.
        const serviceResult = yield* Effect.result(Database.Service)
        if (serviceResult._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe({
            ok: false,
            mode: mode || "default",
            error: `database unavailable: ${(serviceResult.failure as Error)?.message ?? String(serviceResult.failure)}`,
          })
        }
        const service = serviceResult.success

        if (!deep) {
          yield* service.db.run(
            sql`UPDATE session_v2
                   SET cost = 0,
                       tokens_input = 0,
                       tokens_output = 0,
                       tokens_reasoning = 0,
                       tokens_cache_read = 0,
                       tokens_cache_write = 0`,
          )
          yield* service.db.run(
            sql`DELETE FROM event
                   WHERE type IN (
                     'session.step.ended@1', 'session.step.ended@2',
                     'session.step.failed@1', 'session.step.failed@2',
                     'session.usage.recorded@1'
                   )`,
          )
          return HttpServerResponse.jsonUnsafe({
            ok: true,
            deep: false,
            freeRoute: LarpcodeImpersonateFetch.freeRouteStatus(),
          })
        }

        // Rotate the local wire fingerprint before touching the DB. If the
        // write fails the pill gets a real error and no destructive work
        // happens; a reset with the same fingerprint is a no-op from
        // opencode.ai's point of view.
        const fingerprint = rotateFingerprint()
        if ("error" in fingerprint) {
          return HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              mode: "fresh",
              error: `fingerprint rotation failed: ${fingerprint.error}`,
              stage: "rotateFingerprint",
            },
            { status: 500 },
          )
        }

        // One DELETE per table in child-before-parent order so foreign keys
        // don't block. Each runs inside Effect.result: a missing table from
        // a schema the current build never knew about is a skip (not an
        // error), and any OTHER sqlite failure (locked, FK violation) is
        // collected and surfaced in the JSON body instead of escaping up
        // the Effect error channel as a bare 500. Credentials are kept by
        // default so a signed-in workspace keeps its own quota and model
        // access; nuke only on the explicit flag.
        const wipeTargets = [
          "session_part",
          "session_message",
          "session_inbox",
          "instruction_entry",
          "instruction_state",
          "instruction_blob",
          "permission",
          ...(nukeCredentials ? (["credential"] as const) : []),
          "event",
          "event_sequence",
          "kv",
          "session_v2",
          "project_directory",
          "project",
        ] as const
        const wipeSkipped: string[] = []
        const wipeFailed: { table: string; error: string }[] = []
        for (const table of wipeTargets) {
          const outcome = yield* Effect.result(service.db.run(sql.raw(`DELETE FROM ${table}`)))
          if (outcome._tag === "Success") continue
          const msg = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          if (/no such table/i.test(msg)) {
            wipeSkipped.push(table)
            continue
          }
          wipeFailed.push({ table, error: msg })
        }
        if (wipeFailed.length > 0) {
          diagWrite(`[reset] wipe FAILED: ${wipeFailed.map((f) => `${f.table}=${f.error}`).join("; ")}`)
          return HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              mode: "fresh",
              error: `wipe failed on ${wipeFailed.length} table(s): ${wipeFailed
                .map((f) => `${f.table}: ${f.error}`)
                .join("; ")}`,
              wipe_skipped: wipeSkipped,
              wipe_failed: wipeFailed,
              fingerprint_rotated: true,
              fingerprint_client: fingerprint.clientLabel,
            },
            { status: 500 },
          )
        }

        // opencode runs SQLite in WAL mode. Force the current WAL to merge
        // into the main DB and zero the WAL file so the delete records are
        // durable on disk before the renderer reloads or the sidecar exits.
        const checkpointResult = yield* Effect.result(service.db.run(sql.raw(`PRAGMA wal_checkpoint(TRUNCATE)`)))
        if (checkpointResult._tag === "Failure") {
          const msg =
            checkpointResult.failure instanceof Error
              ? checkpointResult.failure.message
              : String(checkpointResult.failure)
          console.warn(`[larpcode-reset] wal_checkpoint failed: ${msg}`)
          diagWrite(`[reset] wal_checkpoint FAILED: ${msg}`)
        } else {
          diagWrite("[reset] wal_checkpoint TRUNCATE ok")
        }

        // Egress rotation last: it is the slow step (~10-30s on a cold Tor
        // start), and it must not prevent the local wipe from being reported.
        // `warp` stays as the response key for older renderers; `egress`
        // names the real route (WARP or Tor) the current build selected.
        const egress = yield* Effect.promise(() => rotateEgress())
        diagWrite(`[reset] done egress=${egress.mode}/${egress.status}`)

        return HttpServerResponse.jsonUnsafe({
          ok: true,
          mode: "fresh",
          deep: true,
          kept_credentials: !nukeCredentials,
          wipe_skipped: wipeSkipped,
          wipe_failed: [],
          fingerprint_rotated: true,
          fingerprint_client: fingerprint.clientLabel,
          fingerprint_nonce_prefix: fingerprint.nonce.slice(0, 12),
          warp: egress,
          egress,
          freeRoute: LarpcodeImpersonateFetch.freeRouteStatus(),
        })
      }).pipe(
        // Bulletproof outer guard. ANY uncaught Effect failure or defect
        // inside the handler above — DB-service missing, Effect.promise
        // defect, drizzle throwing a non-Effect error, anything the per-
        // branch Either wrappers didn't anticipate — is caught here and
        // converted to structured JSON. Keep the 200 (no scary HTTP code)
        // but ok:false so the pill renders failed with a real error and
        // never runs the post-success reload that assumed state was clean.
        Effect.catchCause((cause) => {
          // eslint-disable-next-line no-console
          console.error("[larpcode-reset] uncaught in handler:", cause)
          const pretty =
            typeof cause === "object" && cause !== null && "toString" in cause
              ? (cause as { toString(): string }).toString()
              : String(cause)
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              ok: false,
              handler_error: pretty.slice(0, 512),
              error: "reset failed before completion — see server log",
            }),
          )
        }),
      ),
    )
  }),
)

// Resolve the directory where session snapshots live. XDG-first (matches
// where opencode.db itself lives) so a user who moves XDG_DATA_HOME finds
// their backups alongside the live DB. Falls back to ~/.local/share/opencode
// which is opencode's hard-coded default on every platform.
function resolveBackupsDir(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "session-backups")
}

// Where the ua-spoof plugin picks up the per-reset fingerprint rotation.
// Stamped by rotateFingerprint() in the reset pipeline, read at every
// outbound opencode.ai request to derive the wire identifiers that replace
// the real session / project ids in request headers. Local DB rows keep
// their real ids (chat history, tabs, backups all unaffected); only the
// values that cross the wire change.
function fingerprintPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "larpcode-fingerprint.json")
}

// A small pool of plausible modern Chrome / Firefox UAs. Picked at random on
// every reset so the server-side fingerprinter can't tie two post-reset
// installations by UA alone. Kept in sync with the plugin's own fallback
// pool; the plugin reads whichever UA this file stamps.
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

// Resolve the shared diag file the ua-spoof plugin also writes to. Every
// rotation step (success AND failure) lands there so a reader can confirm
// post-hoc why a given pill click did or didn't move the fingerprint.
function resetDiagPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "log", "larpcode-diag.log")
}

function diagWrite(line: string): void {
  try {
    const p = resetDiagPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch {
    /* swallow — diag write failures must not stop the reset */
  }
}

// Write a fresh fingerprint file. Every attempt is logged so a write failure
// (perm issue, AV lock, bad XDG path) surfaces to the caller instead of
// looking like a successful rotation, and the UA pick is uniform-random via
// one byte so the distribution doesn't bias.
function rotateFingerprint(): { nonce: string; ua: string; clientLabel: string; file: string } | { error: string } {
  const file = fingerprintPath()
  try {
    const nonce = nodeRandomBytes(32).toString("hex")
    const uaIdx = nodeRandomBytes(1)[0] % UA_POOL.length
    const ua = UA_POOL[uaIdx]
    const clientLabel = "oc-" + nodeRandomBytes(6).toString("hex")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ nonce, ua, clientLabel, stamped: Date.now() }), { encoding: "utf8" })
    // Verify the write landed — a successful writeFileSync on Windows can
    // still be shadowed by an AV scanner that holds the file open and
    // reverts. Re-stat to confirm the file exists.
    const st = statSync(file)
    diagWrite(
      `[reset-fingerprint] rotated ok nonce=${nonce.slice(0, 12)}… client=${clientLabel} ` +
        `ua="${ua.slice(0, 40)}…" file=${file} size=${st.size}`,
    )
    return { nonce, ua, clientLabel, file }
  } catch (e) {
    const err = (e as Error)?.message ?? String(e)
    diagWrite(`[reset-fingerprint] FAILED file=${file} error=${err}`)
    return { error: err }
  }
}

