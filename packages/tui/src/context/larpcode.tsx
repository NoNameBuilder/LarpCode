import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useEvent } from "./event"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export type LarpcodeEgress = "warp" | "tor"

export type LarpcodeSettings = {
  autoRotate: boolean
  autoRotateMaxPerHour: number
  freeFallback: boolean
  forceTor: boolean
  egress: LarpcodeEgress
}

export type LarpcodeSettingKey = "autoRotate" | "freeFallback" | "forceTor" | "egress"
export type LarpcodeSettingSource = "env" | "file" | "default"

export type LarpcodeDependency = {
  id: "warp" | "tor" | "impersonate"
  name: string
  installed: boolean
  path?: string
  detail: string
  hint: string
}

export type LarpcodeFreeRoute = {
  cooling: boolean
  until?: number
  lastLimitAt?: number
  lastFallback?: { provider: "deepseek" | "pollinations"; at: number }
}

const fallbackLabel = (provider: NonNullable<LarpcodeFreeRoute["lastFallback"]>["provider"]) =>
  provider === "deepseek" ? "DeepSeek" : "Pollinations"

export type LarpcodeProfileScope = "universal" | "model"

export type LarpcodeProfile = {
  id: string
  name: string
  description: string
  scope: LarpcodeProfileScope
  match?: string[]
}

export type LarpcodeProfileInfo = LarpcodeProfile & { length: number }

export type LarpcodePayload = {
  ok: boolean
  settings: LarpcodeSettings
  sources: Record<LarpcodeSettingKey, LarpcodeSettingSource>
  settingsPath: string
  autoJb: {
    enabled: boolean
    custom: boolean
    selection: string
    profiles: LarpcodeProfileInfo[]
    active: LarpcodeProfileInfo
    length: number
    defaultLength: number
    max: number
  }
  dependencies: LarpcodeDependency[]
  proxy: {
    configured: boolean
    value?: string
  }
  missing: number
  freeRoute?: LarpcodeFreeRoute
}

type State = {
  status: "idle" | "loading" | "ready" | "error"
  data?: LarpcodePayload
  error?: string
  saving: boolean
}

// The TUI talks to the engine over HTTP for LarpCode-only state that is not in
// OpenCode's config schema. Reads are cached in this provider; every write
// returns the refreshed payload so the menu and the top-right warning marker
// update without a second round trip.
export const { use: useLarpcode, provider: LarpcodeProvider } = createSimpleContext({
  name: "Larpcode",
  init: () => {
    const client = useClient()
    const event = useEvent()
    const toast = useToast()
    const [store, setStore] = createStore<State>({ status: "idle", saving: false })

    async function call<T>(path: string, init?: RequestInit) {
      const base = client.url
      if (!base) throw new Error("The LarpCode server endpoint is unavailable")
      const headers = new Headers(client.headers)
      if (init?.body !== undefined) headers.set("content-type", "application/json")
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      const response = await fetch(new URL(path, base), { ...init, headers })
      const body = (await response.json().catch(() => undefined)) as ({ ok?: boolean; error?: string } & T) | undefined
      if (!response.ok || !body || body.ok === false)
        throw new Error(body?.error ?? `LarpCode server returned ${response.status}`)
      return body
    }

    const refresh = async () => {
      if (!client.url) {
        setStore({ status: "error", error: "The LarpCode server endpoint is unavailable" })
        return
      }
      if (!store.data) setStore("status", "loading")
      try {
        const body = await call<LarpcodePayload>("/_larpcode/settings")
        setStore({ status: "ready", data: body, error: undefined })
      } catch (error) {
        setStore({ status: store.data ? "ready" : "error", error: errorMessage(error) })
      }
    }

    async function mutate<T>(work: () => Promise<T>) {
      if (store.saving) throw new Error("A LarpCode setting is already being saved")
      setStore("saving", true)
      try {
        return await work()
      } finally {
        setStore("saving", false)
      }
    }

    const update = (patch: Partial<LarpcodeSettings>) =>
      mutate(async () => {
        const body = await call<LarpcodePayload>("/_larpcode/settings", {
          method: "POST",
          body: JSON.stringify(patch),
        })
        setStore({ status: "ready", data: body, error: undefined })
        return body
      })

    const setAutoJb = (enabled: boolean) =>
      mutate(async () => {
        await call(`/_larpcode/abliterated?enabled=${enabled ? 1 : 0}`, { method: "POST" })
        await refresh()
      })

    const setProfile = (profile: string) =>
      mutate(async () => {
        await call("/_larpcode/abliterated/content", {
          method: "POST",
          body: JSON.stringify({ profile }),
        })
        await refresh()
      })

    const resetInstructions = () =>
      mutate(async () => {
        await call("/_larpcode/abliterated/content", {
          method: "POST",
          body: JSON.stringify({ reset: true }),
        })
        await refresh()
      })

    const resetLimits = () =>
      mutate(async () => {
        // A bare POST is the shallow reset: usage counters clear and sessions stay.
        await call("/_larpcode/reset-limits", { method: "POST" })
        await refresh()
      })

    const retryFreeRoute = () =>
      mutate(async () => {
        await call("/_larpcode/free-route/retry", { method: "POST" })
        await refresh()
      })

    // Fallback routing happens inside the server's fetch override, not in a
    // session event, so surface the side-channel event while the reply is
    // rendered. Refreshing the payload keeps the menu's last-fallback row in
    // sync with the routing state after a refusal.
    let lastNotice = 0
    onCleanup(
      event.on("larpcode.fallback.used", (fallback) => {
        if (store.data)
          setStore("data", "freeRoute", {
            ...(store.data.freeRoute ?? { cooling: false }),
            lastFallback: { provider: fallback.data.provider, at: fallback.data.at },
          })
        void refresh()
        const now = Date.now()
        if (now - lastNotice < 10_000) return
        lastNotice = now
        toast.show({
          title: "Fallback in use",
          message: `opencode.ai refused the free request; this reply is from ${fallbackLabel(fallback.data.provider)}.`,
          variant: "warning",
          duration: 8_000,
        })
      }),
    )

    // A managed service reconnect can replace the port and password, so refresh
    // against the endpoint that is current now instead of the one first seen.
    createEffect(
      on(
        () => client.url,
        (url) => {
          if (url) void refresh()
        },
      ),
    )

    return {
      data: () => store.data,
      status: () => store.status,
      error: () => store.error,
      saving: () => store.saving,
      /** Number of optional LarpCode helpers that are not installed. */
      missing: () => store.data?.missing ?? 0,
      refresh,
      update,
      setAutoJb,
      setProfile,
      resetInstructions,
      resetLimits,
      retryFreeRoute,
    }
  },
})
