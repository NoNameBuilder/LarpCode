import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useNewDesigns } from "../config"
import {
  useLarpcode,
  type LarpcodeDependency,
  type LarpcodeProfile,
  type LarpcodeSettingSource,
} from "../context/larpcode"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect, DialogSelectChoice } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { DialogConfig } from "./dialog-config"
import { useUsageLimits } from "./usage"

type Entry = {
  title: string
  category: string
  value: string
  description: string
  keywords?: string
  footer: string
  /** Under the new designs, render the footer as a changeable value. */
  choice?: boolean
  /** The active value opens a picker or action instead of cycling. */
  open?: boolean
  warning?: boolean
}

const onOff = (value: boolean) => (value ? "on" : "off")

const sourceNote = (source: LarpcodeSettingSource | undefined) =>
  source === "env" ? " The environment overrides the saved value." : ""

const matchesModel = (profile: LarpcodeProfile, model: { providerID: string; modelID: string } | undefined) => {
  if (!model || profile.scope !== "model") return false
  const key = `${model.providerID}/${model.modelID}`.toLowerCase()
  return profile.match?.some((token) => key.includes(token.toLowerCase())) === true
}

export function DialogLarpcodeSettings() {
  const larpcode = useLarpcode()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const limits = useUsageLimits()
  const local = useLocal()
  const [selected, setSelected] = createSignal<string>()

  const model = () => local.model.current()
  const modelLabel = () => {
    const current = model()
    return current ? `${current.providerID}/${current.modelID}` : "the current model"
  }
  const matchedProfile = createMemo(() => {
    const data = larpcode.data()
    const current = model()
    if (!data || !current) return undefined
    return data.autoJb.profiles.find((profile) => matchesModel(profile, current))
  })
  const selectedProfile = createMemo(() => {
    const data = larpcode.data()
    if (!data) return undefined
    if (data.autoJb.selection === "auto") return matchedProfile() ?? data.autoJb.active
    return data.autoJb.profiles.find((profile) => profile.id === data.autoJb.selection) ?? data.autoJb.active
  })

  onMount(() => {
    if (larpcode.status() !== "loading") void larpcode.refresh()
  })

  const entries = createMemo<Entry[]>(() => {
    const data = larpcode.data()
    if (!data) return []
    const result: Entry[] = []
    const missing = data.dependencies.filter((dependency) => !dependency.installed)

    if (missing.length > 0) {
      result.push({
        title: "Dependencies missing",
        category: "Warnings",
        value: "warning",
        description: missing.map((dependency) => dependency.name).join(", "),
        keywords: "missing dependencies cloudflare warp tor curl impersonate",
        footer: `${missing.length} missing`,
        warning: true,
      })
    }

    result.push(
      {
        title: "Auto JB",
        category: "Auto JB",
        value: "autoJb",
        description:
          "When on, every model request carries the selected jailbreak profile instead of the workspace AGENTS.md. When off, no jailbreak is sent.",
        keywords: "auto jailbreak abliterated instructions system prompt off",
        footer: onOff(data.autoJb.enabled),
        choice: true,
      },
      {
        title: "JB profile",
        category: "Auto JB",
        value: "profile",
        description:
          data.autoJb.selection === "auto"
            ? matchedProfile()
              ? `Automatic: ${matchedProfile()!.name} matches ${modelLabel()}, so that model-specific set is used. Other models fall back to the universal set. Enter to choose.`
              : `Automatic: no model-specific set matches ${modelLabel()}, so the universal ${data.autoJb.active.name} set is used. Enter to choose a different set.`
            : `Always uses ${selectedProfile()?.name ?? data.autoJb.selection} (${
                selectedProfile()?.scope === "model" ? "model-specific" : "universal"
              } set), even when the model does not match. Enter to choose.`,
        keywords: "jailbreak profile universal model-specific deepseek big pickle set choice",
        footer:
          data.autoJb.selection === "auto"
            ? matchedProfile()
              ? `auto · ${matchedProfile()!.name}`
              : "auto · universal"
            : (selectedProfile()?.name ?? data.autoJb.selection),
        choice: true,
        open: true,
      },
      {
        title: "Instructions",
        category: "Auto JB",
        value: "instructions",
        description: data.autoJb.custom
          ? `A custom override (${data.autoJb.length.toLocaleString(
              "en-US",
            )} characters) is sent instead of the selected profile. This is Auto JB's prompt text, not OpenCode's instructions setting. Enter to clear it.`
          : `Using ${selectedProfile()?.name ?? "the selected profile"} (${data.autoJb.length.toLocaleString(
              "en-US",
            )} characters). This is Auto JB's prompt text, not OpenCode's instructions setting.`,
        keywords: "auto jb instructions content reset bundled custom prompt text",
        footer: data.autoJb.custom ? (data.autoJb.length === 0 ? "empty" : "custom") : "profile",
        choice: true,
        open: true,
      },
      {
        title: "Auto-rotate",
        category: "Network",
        value: "autoRotate",
        description: `Rotate the wire identity when a free-limit refusal lands.${sourceNote(data.sources.autoRotate)}`,
        keywords: "auto rotate rotation fingerprint warp quota limit",
        footer: onOff(data.settings.autoRotate),
        choice: true,
      },
      {
        title: "Rotations per hour",
        category: "Network",
        value: "autoRotateMaxPerHour",
        description: "Most automatic rotations allowed in a rolling hour",
        keywords: "rotation cap limit hour maximum",
        footer: `${data.settings.autoRotateMaxPerHour} / hour`,
        choice: true,
      },
      {
        title: "Free fallback",
        category: "Network",
        value: "freeFallback",
        description: `Reroute a refused free request to the configured fallback model.${sourceNote(data.sources.freeFallback)}`,
        keywords: "free fallback deepseek pollinations refusal 429",
        footer: onOff(data.settings.freeFallback),
        choice: true,
      },
      ...(data.freeRoute?.cooling
        ? [
            {
              title: "Free route",
              category: "Network",
              value: "freeRoute",
              description: `opencode.ai's shared free pool is refusing requests until ${new Date(
                data.freeRoute.until ?? Date.now(),
              ).toLocaleTimeString()}. This is not your local usage. Last fallback: ${
                data.freeRoute.lastFallback?.provider ?? "none yet"
              }.`,
              keywords: "free route limit deepseek pollinations fallback shared pool retry",
              footer: "retry",
              open: true,
            },
          ]
        : []),
      ...(data.freeRoute?.lastFallback && !data.freeRoute.cooling
        ? [
            {
              title: "Last fallback",
              category: "Network",
              value: "freeRouteLast",
              description: `The last refused free request was served by ${
                data.freeRoute.lastFallback.provider === "deepseek" ? "DeepSeek" : "Pollinations"
              } at ${new Date(
                data.freeRoute.lastFallback.at,
              ).toLocaleTimeString()}. opencode.ai's free pool is shared; this is not your local usage.`,
              keywords: "fallback deepseek pollinations shared pool last used",
              footer: data.freeRoute.lastFallback.provider,
            },
          ]
        : []),
      {
        title: "Egress",
        category: "Network",
        value: "egress",
        description:
          data.settings.egress === "warp"
            ? `Rotate and route through Cloudflare WARP. WARP carries the whole system while it is connected.${sourceNote(data.sources.egress)}`
            : `Rotate and route only LarpCode's opencode.ai traffic through Tor. Other apps keep their normal connection.${sourceNote(data.sources.egress)}`,
        keywords: "egress route warp tor proxy socks vpn ip",
        footer: data.settings.egress,
        choice: true,
      },
      {
        title: "Reset usage limits",
        category: "Usage",
        value: "resetUsage",
        description: "Clear local usage totals and free-limit cooldowns. Sessions are kept.",
        keywords: "reset usage limits counters spend cooldown",
        footer: "reset",
        open: true,
      },
    )

    for (const dependency of data.dependencies) {
      result.push({
        title: `${dependency.installed ? "" : "! "}${dependency.name}`,
        category: "Dependencies",
        value: `dependency:${dependency.id}`,
        description: dependency.installed ? (dependency.path ?? dependency.hint) : dependency.hint,
        keywords: `${dependency.name} dependency missing install proxy ${dependency.id}`,
        footer: dependency.installed ? "installed" : "missing",
        warning: !dependency.installed,
      })
    }

    result.push(
      {
        title: "Recheck dependencies",
        category: "Dependencies",
        value: "recheck",
        description: "Probe WARP, Tor, curl-impersonate and the proxy again",
        keywords: "recheck refresh dependencies doctor",
        footer: data.proxy.configured ? `proxy ${data.proxy.value}` : "no proxy",
        open: true,
      },
      {
        title: "Full settings",
        category: "Advanced",
        value: "full",
        description: `Everything else, including themes and OpenCode config. LarpCode settings live in ${data.settingsPath}`,
        keywords: "full settings opencode config theme",
        footer: "open",
        open: true,
      },
    )

    return result
  })

  const options = createMemo(() =>
    entries().map((entry) => ({
      title: entry.title,
      category: entry.category,
      searchText: entry.keywords,
      footer:
        newDesigns() && entry.choice ? (
          <DialogSelectChoice value={entry.footer} active={selected() === entry.value} open={entry.open} />
        ) : (
          entry.footer
        ),
      footerOverhang: newDesigns() && entry.choice ? 2 : undefined,
      footerColor: entry.warning ? theme.text.feedback.warning.base : undefined,
      detail: newDesigns() ? entry.description : undefined,
      value: entry.value,
    })),
  )

  const data = () => larpcode.data()

  async function change(direction: number, value = selected()) {
    const current = data()
    if (!current || !value || larpcode.saving()) return
    try {
      if (value === "autoJb") return void toggleAutoJb()
      if (value === "profile") return void cycleProfile(direction)
      if (value === "autoRotate") return void (await larpcode.update({ autoRotate: !current.settings.autoRotate }))
      if (value === "freeFallback")
        return void (await larpcode.update({ freeFallback: !current.settings.freeFallback }))
      if (value === "egress")
        return void (
          await larpcode.update({ egress: current.settings.egress === "warp" ? "tor" : "warp" })
        )
      if (value === "autoRotateMaxPerHour") {
        const next = Math.min(120, Math.max(1, current.settings.autoRotateMaxPerHour + direction * 5))
        if (next !== current.settings.autoRotateMaxPerHour) await larpcode.update({ autoRotateMaxPerHour: next })
      }
    } catch (error) {
      toast.error(error)
    }
  }

  async function toggleAutoJb() {
    const current = data()
    if (!current || larpcode.saving()) return
    const next = !current.autoJb.enabled
    try {
      await larpcode.setAutoJb(next)
      toast.show({ message: `Auto JB ${next ? "enabled" : "disabled"}`, variant: next ? "success" : "info" })
    } catch (error) {
      toast.error(error)
    }
  }

  function describe(dependency: LarpcodeDependency) {
    toast.show({
      title: dependency.name,
      message: dependency.installed ? (dependency.path ?? dependency.hint) : dependency.hint,
      variant: dependency.installed ? "info" : "warning",
    })
  }

  function profileLabel(id: string) {
    if (id === "auto") return "Automatic"
    return data()?.autoJb.profiles.find((profile) => profile.id === id)?.name ?? id
  }

  async function chooseProfile(next: string) {
    const current = data()
    if (!current || larpcode.saving() || next === current.autoJb.selection) return
    try {
      await larpcode.setProfile(next)
      toast.show({ message: `Auto JB profile: ${profileLabel(next)}`, variant: "success" })
    } catch (error) {
      toast.error(error)
    }
  }

  async function cycleProfile(direction: number) {
    const current = data()
    if (!current || larpcode.saving()) return
    const values = ["auto", ...current.autoJb.profiles.map((profile) => profile.id)]
    const index = values.indexOf(current.autoJb.selection)
    const next = values[(index + direction + values.length) % values.length]
    if (next) await chooseProfile(next)
  }

  function openProfilePicker() {
    const current = data()
    if (!current) return
    const matched = matchedProfile()
    const options = [
      {
        value: "auto",
        title: "Automatic",
        description: matched
          ? `Use ${matched.name} for ${modelLabel()} and the universal fallback for other models.`
          : `Use a model-specific set when one matches the model, otherwise the universal fallback. No model-specific set matches ${modelLabel()} right now.`,
        searchText: "automatic match model default recommended",
        footer: matched ? `now: ${matched.name}` : "universal",
      },
      ...current.autoJb.profiles.map((profile) => ({
        value: profile.id,
        title: `${profile.scope === "model" ? "Model-specific" : "Universal"} · ${profile.name}`,
        description: `${profile.description} (${profile.length.toLocaleString("en-US")} characters)${
          matchesModel(profile, model()) ? " Matches the current model." : ""
        }`,
        searchText: `${profile.name} ${profile.description} ${profile.match?.join(" ") ?? ""}`,
        footer: matchesModel(profile, model()) ? "matches model" : profile.scope,
      })),
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Auto JB profile"
        searchInTitle
        titlePlaceholder="Search jailbreak profiles"
        current={current.autoJb.selection}
        options={options}
        onSelect={(option) => {
          void chooseProfile(option.value).then(() => dialog.replace(() => <DialogLarpcodeSettings />))
        }}
      />
    ))
  }

  function confirmResetInstructions() {
    const current = data()
    if (!current) return
    if (!current.autoJb.custom) {
      toast.show({
        message: `Using ${selectedProfile()?.name ?? "the selected profile"}. Auto JB sends this text; it is not OpenCode's instructions setting.`,
        variant: "info",
      })
      return
    }
    dialog.replace(() => (
      <DialogConfirm
        title="Reset Auto JB instructions"
        message="Replace the custom instruction set with the selected profile?"
        label={{ confirm: "Reset", cancel: "Cancel" }}
        onConfirm={() => {
          void larpcode.resetInstructions().then(
            () => {
              toast.show({ message: "Auto JB instructions reset", variant: "success" })
              dialog.replace(() => <DialogLarpcodeSettings />)
            },
            (error) => toast.error(error),
          )
        }}
      />
    ))
  }

  function confirmResetUsage() {
    dialog.replace(() => (
      <DialogConfirm
        title="Reset usage limits"
        message="Clear local usage totals and free-limit cooldowns? Sessions are kept."
        label={{ confirm: "Reset", cancel: "Cancel" }}
        onConfirm={() => {
          void larpcode.resetLimits().then(
            () => {
              limits.load(true)
              toast.show({ message: "Usage limits reset", variant: "success" })
              dialog.replace(() => <DialogLarpcodeSettings />)
            },
            (error) => toast.error(error),
          )
        }}
      />
    ))
  }

  async function activate(value: string) {
    const current = data()
    if (!current) return
    if (value === "warning") {
      const missing = current.dependencies.filter((dependency) => !dependency.installed)
      toast.show({
        title: "Missing dependencies",
        message: `${missing.map((dependency) => dependency.name).join(", ")}. Open Dependencies for install hints.`,
        variant: "warning",
      })
      return
    }
    if (value === "autoJb") return void toggleAutoJb()
    if (value === "profile") return openProfilePicker()
    if (value === "freeRoute") {
      try {
        await larpcode.retryFreeRoute()
        toast.show({
          message: "Free route retry queued; the next request will probe opencode.ai again",
          variant: "success",
        })
      } catch (error) {
        toast.error(error)
      }
      return
    }
    if (value === "instructions") return confirmResetInstructions()
    if (value === "resetUsage") return confirmResetUsage()
    if (value === "recheck") {
      await larpcode.refresh()
      if (larpcode.error()) return toast.error(larpcode.error())
      toast.show({
        message: larpcode.missing() > 0 ? `${larpcode.missing()} dependencies still missing` : "All dependencies found",
        variant: larpcode.missing() > 0 ? "warning" : "success",
      })
      return
    }
    if (value === "full") return void dialog.replace(() => <DialogConfig />)
    if (value.startsWith("dependency:")) {
      const dependency = current.dependencies.find((item) => `dependency:${item.id}` === value)
      if (dependency) describe(dependency)
      return
    }
    return void change(1, value)
  }

  return (
    <Show
      when={data()}
      fallback={
        <DialogLayout header={<DialogHeader title="LarpCode settings" />}>
          <text fg={larpcode.error() ? theme.text.feedback.error.base : theme.text.muted} wrapMode="word">
            {larpcode.error() ? `Could not load LarpCode settings: ${larpcode.error()}` : "Loading LarpCode settings…"}
          </text>
          <Show when={larpcode.error()}>
            <text fg={theme.text.muted} wrapMode="word">
              Open /larpcode:settings again to retry.
            </text>
          </Show>
        </DialogLayout>
      }
    >
      <DialogSelect
        title="LarpCode settings"
        searchInTitle
        titlePlaceholder="Search LarpCode settings"
        options={options()}
        preserveSelection={newDesigns()}
        filterThreshold={0.7}
        onMove={(option) => setSelected(option.value)}
        onSelect={(option) => void activate(option.value)}
        footerHints={newDesigns() ? [] : [{ title: "change", label: "←/→" }]}
        bindings={[
          {
            bind: "left",
            title: "Previous value",
            group: "LarpCode",
            run: () => void change(-1),
          },
          {
            bind: "right",
            title: "Next value",
            group: "LarpCode",
            run: () => void change(1),
          },
        ]}
      />
    </Show>
  )
}
