import { LarpcodeAbliterated } from "@opencode/core/larpcode-abliterated"
import { ensureEgress } from "@opencode/core/larpcode-egress"
import * as LarpcodeImpersonateFetch from "@opencode/util/larpcode-impersonate-fetch"
import { inspect } from "@opencode/util/larpcode-dependencies"
import * as LarpcodeSettings from "@opencode/util/larpcode-settings"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { larpcodePreflight } from "./larpcode-reset"

function payload(model?: LarpcodeAbliterated.ModelRef) {
  const report = inspect()
  return {
    ok: true,
    settings: LarpcodeSettings.resolved(),
    sources: LarpcodeSettings.sources(),
    settingsPath: LarpcodeSettings.filePath(),
    autoJb: {
      enabled: LarpcodeAbliterated.enabled(),
      custom: LarpcodeAbliterated.custom(),
      selection: LarpcodeAbliterated.selection(),
      profiles: LarpcodeAbliterated.profiles(),
      active: LarpcodeAbliterated.activeProfile(model),
      length: LarpcodeAbliterated.content(model).length,
      defaultLength: LarpcodeAbliterated.DefaultContent.length,
      max: LarpcodeAbliterated.MaxContentLength,
    },
    dependencies: report.dependencies,
    proxy: report.proxy,
    missing: report.missing,
    freeRoute: LarpcodeImpersonateFetch.freeRouteStatus(),
  }
}

function queryModel(url: URL) {
  return LarpcodeAbliterated.modelRef(url.searchParams.get("provider"), url.searchParams.get("model"))
}

export const LarpcodeSettingsLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("OPTIONS", "/_larpcode/settings", larpcodePreflight)
    yield* router.add(
      "GET",
      "/_larpcode/settings",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        return HttpServerResponse.jsonUnsafe(payload(queryModel(url)))
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/settings",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const parsed = yield* Effect.result(request.json)
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })

        const body = parsed.success
        if (body === null || typeof body !== "object" || Array.isArray(body))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "JSON object required" }, { status: 400 })

        const input = body as Record<string, unknown>
        const patch: LarpcodeSettings.Patch = {}
        for (const key of ["autoRotate", "freeFallback", "forceTor"] as const) {
          if (!(key in input)) continue
          if (typeof input[key] !== "boolean")
            return HttpServerResponse.jsonUnsafe({ ok: false, error: `${key} must be a boolean` }, { status: 400 })
          patch[key] = input[key]
        }
        if ("autoRotateMaxPerHour" in input) {
          if (typeof input.autoRotateMaxPerHour !== "number" || !Number.isFinite(input.autoRotateMaxPerHour))
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "autoRotateMaxPerHour must be a number" },
              { status: 400 },
            )
          patch.autoRotateMaxPerHour = input.autoRotateMaxPerHour
        }
        if ("egress" in input) {
          if (input.egress !== "warp" && input.egress !== "tor")
            return HttpServerResponse.jsonUnsafe({ ok: false, error: "egress must be warp or tor" }, { status: 400 })
          patch.egress = input.egress
        }
        if (Object.keys(patch).length === 0)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "no settings supplied" }, { status: 400 })

        const result = yield* Effect.result(
          Effect.try({
            try: () => LarpcodeSettings.set(patch),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write settings: ${String(result.failure)}` },
            { status: 500 },
          )

        // Apply the new route without waiting for a restart. `ensureEgress`
        // removes the Tor fetch router immediately when WARP is selected and
        // starts Tor when Tor is selected; the response does not block on a
        // cold Tor start. Failures are already written to larpcode-diag.log.
        if (patch.egress !== undefined)
          void ensureEgress().catch((error: unknown) => {
            console.warn(`[larpcode-settings] egress apply failed: ${String(error)}`)
          })

        return HttpServerResponse.jsonUnsafe(payload())
      }),
    )
  }),
)
