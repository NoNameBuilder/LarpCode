import { Select } from "@opencode/ui/select"
import { createEffect, createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { authTokenFromCredentials } from "@/runtime/server/api"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"

// LarpCode egress choice in the desktop settings. WARP is system-wide; Tor is
// scoped to LarpCode's opencode.ai traffic by the sidecar's SOCKS dispatcher,
// so selecting Tor here never changes the connection used by other apps.
type Egress = "warp" | "tor"

type SettingsBody = {
  settings?: {
    egress?: Egress
  }
}

type State = {
  status: "loading" | "ready" | "error"
  egress?: Egress
  saving: boolean
  error?: string
}

export function LarpcodeEgressSection() {
  const language = useLanguage()
  const servers = useServers()
  const [state, setState] = createStore<State>({ status: "loading", saving: false })

  const targets = createMemo(() =>
    servers.list.flatMap((conn) => {
      const http = ServerConnection.http(conn)

      return http?.url ? [{ http }] : []
    }),
  )

  const headers = (http: ServerConnection.HttpBase) => {
    if (!http.password) return undefined

    return { authorization: `Basic ${authTokenFromCredentials({ password: http.password })}` }
  }

  const refresh = async () => {
    const first = targets()[0]

    if (!first) {
      setState({ status: "error", error: language.t("settings.larpcode.egress.unavailable") })

      return
    }

    try {
      const response = await fetch(new URL("/_larpcode/settings", first.http.url), {
        headers: headers(first.http),
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      // SAFETY: this app's sidecar publishes the egress setting this route returns.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- see SAFETY above
      const body = (await response.json()) as SettingsBody
      const egress = body.settings?.egress

      if (egress !== "warp" && egress !== "tor") throw new Error("missing egress setting")
      setState({ status: "ready", egress, error: undefined })
    } catch (error) {
      setState({
        status: "error",
        error: `${language.t("settings.larpcode.egress.unavailable")} ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  const update = async (egress: Egress) => {
    if (state.saving || egress === state.egress) return

    setState("saving", true)

    try {
      await Promise.all(
        targets().map(async ({ http }) => {
          const response = await fetch(new URL("/_larpcode/settings", http.url), {
            method: "POST",
            headers: { ...headers(http), "content-type": "application/json" },
            body: JSON.stringify({ egress }),
          })

          if (!response.ok) throw new Error(`HTTP ${response.status}`)
        }),
      )

      setState({ status: "ready", egress, saving: false, error: undefined })
    } catch (error) {
      setState({
        saving: false,
        error: `${language.t("settings.larpcode.egress.unavailable")} ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  createEffect(() => {
    if (targets().length === 0) return

    void refresh()
  })

  const options = createMemo((): { value: Egress; label: string }[] => [
    { value: "warp", label: language.t("settings.larpcode.egress.warp") },
    { value: "tor", label: language.t("settings.larpcode.egress.tor") },
  ])

  return (
    <Show when={state.egress}>
      <section class="settings-section" aria-label={language.t("settings.larpcode.section")}>
        <h3 class="settings-section-title">{language.t("settings.larpcode.section")}</h3>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.larpcode.egress.title")}
            description={
              state.error ??
              (state.egress === "tor"
                ? language.t("settings.larpcode.egress.description.tor")
                : language.t("settings.larpcode.egress.description.warp"))
            }
          >
            <Select
              data-action="settings-larpcode-egress"
              aria-label={language.t("settings.larpcode.egress.title")}
              options={options()}
              current={options().find((option) => option.value === state.egress)}
              value={(option) => option.value}
              label={(option) => option.label}
              placement="bottom-end"
              gutter={6}
              onSelect={(option) => option && void update(option.value)}
            />
          </SettingsRow>
        </SettingsList>
      </section>
    </Show>
  )
}
