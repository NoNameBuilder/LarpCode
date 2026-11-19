import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@opencode/app/desktop"
import type { OpenCodeCredentialList } from "../shared/ipc-rpc/credentials"

/**
 * First-run offer to copy the sign-ins an installed OpenCode already saved.
 * The source databases stay read-only; importing copies credentials into
 * LarpCode and leaves any account LarpCode already selected in place.
 */
export function CredentialImportDialog(props: {
  readonly list: OpenCodeCredentialList
  readonly busy: boolean
  readonly onImport: () => void
  readonly onManual: () => void
}) {
  const language = useLanguage()
  const credentials = createMemo(() => props.list.credentials)
  const integrations = createMemo(() => [...new Set(credentials().map((credential) => credential.integrationID))])

  return (
    <Dialog preventBackdropDismiss={props.busy} fit>
      <DialogHeader hideClose={props.busy}>
        <DialogTitleGroup
          title={language.t("larpcode.credentialImport.title")}
          description={language.t("larpcode.credentialImport.description")}
        />
      </DialogHeader>
      <DialogBody class="gap-3 px-4 pb-1">
        <div class="flex flex-col gap-1">
          <span class="text-[13px] leading-5 font-[530] text-v2-text-text-base">
            {language.plural("larpcode.credentialImport.summary", credentials().length)}
          </span>
          <span class="text-[13px] leading-5 text-v2-text-text-muted">
            {language.plural("larpcode.credentialImport.profiles", props.list.databases.length)}
          </span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <For each={integrations()}>
            {(integration) => (
              <span class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 py-0.5 text-[11px] leading-4 text-v2-text-text-muted">
                {integration}
              </span>
            )}
          </For>
        </div>
        <Show when={props.list.errors.length > 0}>
          <div class="rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-3 py-2 text-[12px] leading-4 text-v2-text-text-muted">
            {language.plural("larpcode.credentialImport.skippedSources", props.list.errors.length, {
              error: props.list.errors[0] ?? "",
            })}
          </div>
        </Show>
        <Show when={props.busy}>
          <div class="flex items-center gap-2 text-[13px] leading-5 text-v2-text-text-muted">
            <Loader />
            <span>{language.t("larpcode.credentialImport.importing")}</span>
          </div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <div class="flex w-full items-center justify-end gap-2">
          <Button
            variant="neutral"
            disabled={props.busy}
            title={language.t("larpcode.credentialImport.manualDescription")}
            onClick={props.onManual}
          >
            {language.t("larpcode.credentialImport.manual")}
          </Button>
          <div class="flex items-center gap-2">
            <span class="text-[11px] leading-4 font-[530] text-v2-state-fg-success">
              {language.t("larpcode.credentialImport.recommended")}
            </span>
            <Button variant="contrast" disabled={props.busy || credentials().length === 0} onClick={props.onImport}>
              {language.t("larpcode.credentialImport.import")}
            </Button>
          </div>
        </div>
      </DialogFooter>
    </Dialog>
  )
}
