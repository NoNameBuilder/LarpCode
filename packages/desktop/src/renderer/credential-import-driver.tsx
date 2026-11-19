import { DialogConnectProvider, ServerConnection, useGlobal, useLanguage, type Platform } from "@opencode/app/desktop"
import { useDialog } from "@opencode/ui/context/dialog"
import { showToast } from "@opencode/ui/toast"
import { createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import type { ElectronAPI } from "./api-types"
import type { OpenCodeCredential } from "../shared/ipc-rpc/credentials"
import { importOpenCodeCredentials } from "./credential-import"
import { CredentialImportDialog } from "./credential-import-dialog"
import {
  transitionCredentialImport,
  type CredentialDecision,
  type CredentialImportEffect,
  type CredentialImportEvent,
  type CredentialImportState,
} from "./credential-import-machine"

const DECISION_KEY = "opencode-credential-import"

const DECISION_STORAGE = "larpcode.dat"

/**
 * Offers to copy the sign-ins an installed OpenCode already saved, once per
 * install. The source databases are read-only and the answer is recorded in the
 * same SQLite-backed store as the rest of the desktop's window state.
 */
export function DesktopCredentialImport(props: {
  readonly api: ElectronAPI
  readonly platform: Platform
  /** False while first-launch onboarding still owns the window. */
  readonly onboardingSettled: boolean
}) {
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const sidecar = ServerConnection.Key.make("sidecar")
  const offerID = "larpcode-credential-import"

  const [state, setState] = createSignal<CredentialImportState>({ status: "waiting" })
  const [decided, setDecided] = createSignal<boolean>()

  const storage = props.platform.storage?.(DECISION_STORAGE) ?? null
  // Events an effect raises wait until every effect of the event before them ran.
  const queue: CredentialImportEvent[] = []

  const dispatch = (event: CredentialImportEvent) => {
    queue.push(event)

    if (queue.length === 1) drain()
  }

  const drain = () => {
    const event = queue[0]

    if (!event) return

    try {
      const next = transitionCredentialImport(untrack(state), event)
      setState(next.state)
      // Each effect runs on its own, so one that throws cannot keep the rest from running.
      next.effects.forEach((effect) =>
        Promise.try(() => run(effect)).catch((error) =>
          console.error("[credential-import] effect failed", { effect: effect.type, error }),
        ),
      )
    } finally {
      queue.shift()
    }

    drain()
  }

  const run = (effect: CredentialImportEffect) => {
    switch (effect.type) {
      case "check":
        return void check()

      case "open-offer":
        // A dialog that opened while the credentials were read keeps priority. Leave no decision recorded so the
        // offer returns on the next start instead of replacing what the user is already doing.
        if (dialog.active) return dispatch({ type: "postponed" })

        return void dialog.show(
          () => (
            <CredentialImportDialog
              list={effect.list}
              busy={state().status === "importing"}
              onImport={() => dispatch({ type: "accepted" })}
              onManual={() => dispatch({ type: "declined" })}
            />
          ),
          () => dispatch({ type: "dismissed" }),
          offerID,
        )

      case "import":
        return void runImport(effect.list.credentials)

      case "close-offer":
        return dialog.close(offerID)

      case "open-manual":
        return void dialog.show(() => <DialogConnectProvider defaultLocation />)

      case "record":
        return record(effect.decision)

      case "check-error":
        return showToast({
          variant: "error",
          title: language.t("larpcode.credentialImport.checkFailed"),
          description: message(effect.error),
          duration: 8_000,
        })

      case "import-result":
        return report(effect.result)

      case "import-error":
        return showToast({
          variant: "error",
          title: language.t("larpcode.credentialImport.importFailed"),
          description: message(effect.error),
          duration: 8_000,
        })

      case "refresh":
        return void refresh()
    }
  }

  const server = () => global.serverCtx(sidecar)

  /** Reads both sides before offering: an existing LarpCode sign-in wins over the prompt. */
  const check = async () => {
    try {
      const ctx = server()

      if (!ctx) throw new Error(language.t("larpcode.credentialImport.serverUnavailable"))
      const existing = await ctx.sdk.api.credential.list()
      const list = await props.api.listOpenCodeCredentials()
      dispatch({ type: "checked", existing: existing.length, list })
    } catch (error) {
      dispatch({ type: "check.failed", error })
    }
  }

  const runImport = async (list: readonly OpenCodeCredential[]) => {
    try {
      const ctx = server()

      if (!ctx) throw new Error(language.t("larpcode.credentialImport.serverUnavailable"))
      const existing = await ctx.sdk.api.credential.list()

      const result = await importOpenCodeCredentials({
        credentials: list,
        existing,
        create: (credential) => ctx.sdk.api.credential.create(credential),
      })

      dispatch({ type: "imported", result })
    } catch (error) {
      dispatch({ type: "import.failed", error })
    }
  }

  const report = (result: Awaited<ReturnType<typeof importOpenCodeCredentials>>) => {
    if (result.imported > 0) {
      showToast({
        variant: result.errors.length > 0 ? "error" : "success",
        title: language.t("larpcode.credentialImport.importedTitle"),
        description:
          result.skipped > 0
            ? language.plural("larpcode.credentialImport.importedWithSkipped", result.imported, {
                skipped: result.skipped,
              })
            : language.plural("larpcode.credentialImport.imported", result.imported),
        duration: 5_000,
      })

      if (result.errors.length > 0)
        showToast({
          variant: "error",
          title: language.t("larpcode.credentialImport.partialTitle"),
          description: result.errors[0],
          duration: 8_000,
        })

      return
    }

    if (result.errors.length > 0)
      return showToast({
        variant: "error",
        title: language.t("larpcode.credentialImport.errorTitle"),
        description: result.errors[0],
        duration: 8_000,
      })

    showToast({
      title: language.t("larpcode.credentialImport.noneTitle"),
      description: language.plural("larpcode.credentialImport.none", result.skipped),
      duration: 4_000,
    })
  }

  const refresh = async () => {
    const ctx = server()

    if (!ctx) return
    const location = ctx.data.location.default()
    ctx.data.location.integration.invalidate(location)
    ctx.data.location.provider.invalidate(location)
    ctx.data.location.model.invalidate(location)
    await Promise.all([
      ctx.data.location.integration.sync(location),
      ctx.data.location.provider.sync(location),
      ctx.data.location.model.sync(location),
    ]).catch((error) => console.error("[credential-import] failed to refresh providers", error))
  }

  const record = (decision: CredentialDecision) => {
    if (!storage) return
    void Promise.resolve(
      storage.setItem(DECISION_KEY, JSON.stringify({ decided: true, result: decision, at: Date.now() })),
    )
      .then(() => storage.flush())
      .catch((error) => console.error("[credential-import] failed to record decision", error))
  }

  onMount(() => {
    if (!storage) {
      setDecided(false)

      return
    }

    void Promise.resolve(storage.getItem(DECISION_KEY)).then(
      (raw) => setDecided(decidedValue(raw)),
      () => setDecided(false),
    )
  })

  createEffect(() => {
    const prior = decided()

    if (prior === undefined) return

    if (state().status !== "waiting") return

    if (prior) return dispatch({ type: "skipped" })

    if (!props.onboardingSettled) return

    if (server()?.sdk.connection.status() !== "connected") return
    dispatch({ type: "ready" })
  })

  onCleanup(() => {
    const status = untrack(state).status
    dispatch({ type: "disposed" })

    if (status === "offer" || status === "importing") dialog.close(offerID)
  })

  return null
}

function decidedValue(raw: string | null) {
  if (!raw) return false

  try {
    const value: unknown = JSON.parse(raw)

    // SAFETY: JSON can hold any value; a recorded decision only counts when it is an object with `decided: true`.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see SAFETY above
    if (typeof value !== "object" || value === null) return false

    return "decided" in value && value.decided === true
  } catch {
    return false
  }
}

// SAFETY: caught values are arbitrary throws; the toast only shows an Error's message.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
