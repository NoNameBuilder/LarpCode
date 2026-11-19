import { Loader } from "@opencode/ui/loader"
import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { authTokenFromCredentials } from "@/runtime/server/api"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { showToast } from "@/shell/notifications/toast"

// LarpCode free-route status pill. The opencode.ai free pool is shared by every
// install, so a refusal is not evidence that this user spent their own quota.
// The server exposes the routing state at /_larpcode/settings and emits
// `larpcode.fallback.used` when a reply is served by the fallback provider.
// This pill mirrors the TUI's Network rows: cooling offers a retry, and after
// the cooldown clears the last fallback stays visible as an explanation.

type FreeRouteFallback = "deepseek" | "pollinations"

type FreeRouteStatus = {
  cooling: boolean
  until?: number
  lastLimitAt?: number
  lastFallback?: { provider: FreeRouteFallback; at: number }
}

type State = {
  cooling: boolean
  until?: number
  lastFallback?: { provider: FreeRouteFallback; at: number }
  busy: boolean
}

const PROVIDER_LABEL: Record<FreeRouteFallback, string> = {
  deepseek: "DeepSeek",
  pollinations: "Pollinations",
}

const REFRESH_MS = 30_000

export function LarpcodeFreeRoutePill() {
  const servers = useServers()
  const global = useGlobal()
  const language = useLanguage()
  const [state, setState] = createStore<State>({ cooling: false, busy: false })

  const targets = createMemo(() =>
    servers.list.flatMap((conn) => {
      const http = ServerConnection.http(conn)

      return http?.url ? [{ conn, http }] : []
    }),
  )

  const headers = (http: ServerConnection.HttpBase) => {
    if (!http.password) return undefined

    return { authorization: `Basic ${authTokenFromCredentials({ password: http.password })}` }
  }

  const apply = (route: FreeRouteStatus | undefined) => {
    if (!route) return
    setState({
      cooling: route.cooling === true,
      until: route.until,
      lastFallback: route.lastFallback,
    })
  }

  const refresh = async () => {
    const list = targets()

    if (list.length === 0) return

    const results = await Promise.all(
      list.map(async ({ http }) => {
        try {
          const response = await fetch(new URL("/_larpcode/settings", http.url), { headers: headers(http) })

          if (!response.ok) return undefined
          // SAFETY: this app's sidecar publishes the free-route status this route returns.
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- see SAFETY above
          const body = (await response.json()) as { freeRoute?: FreeRouteStatus }

          return body.freeRoute
        } catch {
          // The sidecar may be restarting and hold a stale password for a moment.
          return undefined
        }
      }),
    )

    const routes = results.filter((route): route is FreeRouteStatus => route !== undefined)

    if (routes.length === 0) return
    // Prefer a cooling server: it is actionable. Otherwise show the most recent
    // fallback across the connected servers.
    const cooling = routes.find((route) => route.cooling)

    if (cooling) return apply(cooling)

    const recent = routes
      .filter((route) => route.lastFallback)
      .toSorted((a, b) => b.lastFallback!.at - a.lastFallback!.at)[0]

    apply(recent ?? { cooling: false })
  }

  // Subscribe to the side-channel event so the pill reacts to the reply that
  // triggered the fallback instead of waiting for the next poll.
  createEffect(() => {
    const cleanups = targets().flatMap(({ conn }) => {
      const ctx = global.serverCtx(ServerConnection.key(conn))

      if (!ctx) return []

      const off = ctx.sdk.event.on("larpcode.fallback.used", (event) => {
        setState({ lastFallback: { ...event.data } })
        void refresh()
      })

      return [off]
    })

    onCleanup(() => cleanups.forEach((off) => off()))
  })

  createEffect(() => {
    if (targets().length === 0) return
    void refresh()
  })

  // End the cooling state on time even between polls (the server clamps a
  // cooldown to 30s..5min).
  createEffect(() => {
    if (!state.cooling || !state.until) return
    const delay = state.until - Date.now() + 250

    if (delay <= 0) return
    const timer = setTimeout(() => void refresh(), delay)
    onCleanup(() => clearTimeout(timer))
  })

  onMount(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  const retry = async () => {
    if (state.busy) return
    setState("busy", true)

    try {
      for (const { http } of targets()) {
        const response = await fetch(new URL("/_larpcode/free-route/retry", http.url), {
          method: "POST",
          headers: headers(http),
        })

        // SAFETY: this app's sidecar returns its retry result, including the next routing state.
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- see SAFETY above
        const body = (await response.json().catch(() => undefined)) as
          | { ok?: boolean; error?: string; freeRoute?: FreeRouteStatus }
          | undefined

        if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${response.status}`)

        if (body?.freeRoute) apply(body.freeRoute)
      }

      showToast({
        variant: "success",
        title: language.t("larpcode.freeRoute.retried"),
        description: language.t("larpcode.freeRoute.retriedDescription"),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("larpcode.freeRoute.retryFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setState("busy", false)
    }
  }

  const provider = (value: FreeRouteFallback) => PROVIDER_LABEL[value]
  const until = () => new Date(state.until ?? Date.now()).toLocaleTimeString()

  const title = () => {
    if (state.cooling) {
      if (state.lastFallback)
        return language.t("larpcode.freeRoute.coolingTitle", {
          time: until(),
          provider: provider(state.lastFallback.provider),
        })

      return language.t("larpcode.freeRoute.coolingTitleNone", { time: until() })
    }

    if (!state.lastFallback) return undefined

    return language.t("larpcode.freeRoute.fallbackTitle", {
      provider: provider(state.lastFallback.provider),
      time: new Date(state.lastFallback.at).toLocaleTimeString(),
    })
  }

  const label = () =>
    state.cooling
      ? language.t("larpcode.freeRoute.cooling")
      : state.lastFallback
        ? language.t("larpcode.freeRoute.fallback", { provider: provider(state.lastFallback.provider) })
        : ""

  return (
    <Show when={state.cooling || state.lastFallback}>
      <button
        data-slot="larpcode-free-route-pill"
        type="button"
        onClick={() => (state.cooling ? void retry() : undefined)}
        disabled={state.busy || !state.cooling}
        aria-busy={state.busy}
        aria-label={
          state.cooling
            ? language.t("larpcode.freeRoute.coolingAria")
            : language.t("larpcode.freeRoute.fallbackAria", {
                provider: state.lastFallback ? provider(state.lastFallback.provider) : "",
              })
        }
        title={title()}
        class="group relative inline-flex h-8 items-center gap-1.5 rounded-full border bg-v2-background-bg-layer-02 px-3 text-[11px] leading-4 font-[530] text-v2-text-text-muted shadow-sm transition-[background-color,border-color,color] duration-150 ease-out hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus disabled:cursor-default motion-reduce:transition-none"
        classList={{
          "border-v2-state-fg-warning! text-v2-state-fg-warning!": state.cooling,
          "border-v2-border-border-muted": !state.cooling,
          "cursor-wait": state.busy,
        }}
      >
        <span class="flex h-4 w-4 shrink-0 items-center justify-center">
          <Show when={!state.busy} fallback={<Loader width={12} height={12} />}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <Show
                when={state.cooling}
                fallback={
                  <>
                    <path d="M2 5h9" />
                    <path d="M8.5 2.5 11 5 8.5 7.5" />
                    <path d="M14 11H5" />
                    <path d="M7.5 8.5 5 11l2.5 2.5" />
                  </>
                }
              >
                <circle cx="8" cy="8" r="5.5" />
                <path d="M8 4.75V8l2.25 1.5" />
              </Show>
            </svg>
          </Show>
        </span>
        <span class="whitespace-nowrap">{label()}</span>
      </button>
    </Show>
  )
}
