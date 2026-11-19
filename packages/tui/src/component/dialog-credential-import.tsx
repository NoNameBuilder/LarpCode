import type { LocationRef } from "@opencode/client"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import {
  importOpenCodeCredentials,
  type OpenCodeCredential,
  type OpenCodeCredentialList,
} from "../util/opencode-import"
import { DialogIntegration } from "./dialog-integration"
import { Spinner } from "./spinner"

export type CredentialDecision = "imported" | "declined" | "dismissed"

/**
 * Offers to copy the sign-ins an installed OpenCode already saved. The source database is read-only and the
 * destination keeps any account it has selected already.
 */
export function DialogCredentialImport(props: {
  list: OpenCodeCredentialList
  /** Scopes the manual-connect fallback to the integration whose model needs credentials. */
  integrationID?: string
  onDecided?: (decision: CredentialDecision) => void
}) {
  const client = useClient()
  const data = useData()
  const currentLocation = useLocation()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const [busy, setBusy] = createSignal(false)

  const credentials = createMemo(() => props.list.credentials)
  const count = createMemo(() => credentials().length)
  const integrations = createMemo(() => new Set(credentials().map((credential) => credential.integrationID)))

  function decide(decision: CredentialDecision) {
    props.onDecided?.(decision)
  }

  function manual() {
    if (busy()) return
    decide("declined")
    dialog.replace(() => <DialogIntegration integrationID={props.integrationID} />)
  }

  function dismiss() {
    if (busy()) return
    decide("dismissed")
    dialog.clear()
  }

  async function start() {
    if (busy() || count() === 0) return
    setBusy(true)
    try {
      const existing = await client.api.credential.list()
      const result = await importOpenCodeCredentials({
        credentials: credentials(),
        existing,
        create: (input) => client.api.credential.create(input),
      })
      await refresh(data, currentLocation.ref ?? data.location.default())
      decide("imported")
      dialog.clear()
      if (result.imported > 0) {
        toast.show({
          title: "OpenCode credentials imported",
          message:
            `Imported ${result.imported} ${result.imported === 1 ? "credential" : "credentials"}` +
            (result.skipped > 0 ? `, skipped ${result.skipped} already present` : ""),
          variant: result.errors.length > 0 ? "warning" : "success",
          duration: 5000,
        })
      } else if (result.errors.length > 0) {
        toast.show({
          title: "Credentials could not be imported",
          message: result.errors[0],
          variant: "error",
          duration: 5000,
        })
      } else {
        toast.show({
          title: "No new credentials",
          message: `All ${result.skipped} OpenCode ${result.skipped === 1 ? "credential is" : "credentials are"} already present`,
          variant: "info",
          duration: 4000,
        })
      }
      if (result.errors.length > 0 && result.imported > 0)
        toast.show({
          title: "Some credentials were not imported",
          message: result.errors[0],
          variant: "warning",
          duration: 5000,
        })
    } catch (error) {
      toast.show({
        title: "Import failed",
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy(false)
    }
  }

  onMount(() => dialog.setSize("medium"))

  return (
    <DialogSelect<"import" | "manual">
      title="Import OpenCode credentials?"
      description="LarpCode found saved sign-ins from OpenCode on this computer. Importing copies them here; OpenCode's own data is never changed."
      options={[
        {
          value: "import",
          title: "Yes, import from OpenCode",
          description: summary(credentials()),
          details: [
            `Found in ${props.list.databases.length} ${props.list.databases.length === 1 ? "profile" : "profiles"}: ${[...integrations()].join(", ")}`,
          ],
          footer: "recommended",
          footerColor: theme.text.feedback.success.base,
          disabled: count() === 0,
          onSelect: () => void start(),
        },
        {
          value: "manual",
          title: "No, I'll connect manually",
          description: "Choose an integration and sign in yourself",
          onSelect: () => manual(),
        },
      ]}
      locked={busy()}
      footer={
        <Show when={busy()}>
          <Spinner shimmer={theme.text.base}>Importing credentials…</Spinner>
        </Show>
      }
      onCancel={dismiss}
    />
  )
}

function summary(credentials: readonly OpenCodeCredential[]) {
  const integrations = new Set(credentials.map((credential) => credential.integrationID))
  return `${credentials.length} ${credentials.length === 1 ? "credential" : "credentials"} for ${integrations.size} ${integrations.size === 1 ? "integration" : "integrations"}`
}

async function refresh(data: ReturnType<typeof useData>, location: LocationRef) {
  data.location.integration.invalidate(location)
  data.location.model.invalidate(location)
  data.location.provider.invalidate(location)
  await Promise.all([
    data.location.integration.sync(location),
    data.location.model.sync(location),
    data.location.provider.sync(location),
  ])
}
