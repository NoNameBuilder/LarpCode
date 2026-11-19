import { isConflictError, type CredentialCreateInput } from "@opencode/client"
import type { OpenCodeCredential } from "../shared/ipc-rpc/credentials"
import type { CredentialImportResult } from "./credential-import-machine"

/** A credential value as the create endpoint accepts it; used to compare saved values. */
type CredentialValue = CredentialCreateInput["value"]

/**
 * Copies discovered OpenCode credentials through the server API. Destination
 * selections are preserved: an imported credential only becomes active when its
 * integration has no credential selected yet.
 */
export async function importOpenCodeCredentials(input: {
  readonly credentials: readonly OpenCodeCredential[]
  readonly existing: readonly {
    readonly id: string
    readonly integrationID: string
    readonly active?: boolean | undefined
    readonly value: CredentialValue
  }[]
  // SAFETY: the import only awaits creation and never reads the server's reply.
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see SAFETY above
  readonly create: (credential: CredentialCreateInput) => Promise<unknown>
}): Promise<CredentialImportResult> {
  const ids = new Set(input.existing.map((credential) => credential.id))

  const values = new Set(
    input.existing.map((credential) => credentialValueKey(credential.integrationID, credential.value)),
  )

  const selected = new Set(
    input.existing.filter((credential) => credential.active).map((credential) => credential.integrationID),
  )

  const importedIntegrations = new Set<string>()
  const errors: string[] = []
  let imported = 0
  let skipped = 0

  for (const credential of input.credentials) {
    // SAFETY: the main process decoded this value with `CredentialLegacy.Value`, so its shape is the
    // stored credential contract; the generated client spells the same fields with plain JSON types.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- see SAFETY above
    const value = credential.value as CredentialValue
    const key = credentialValueKey(credential.integrationID, value)

    if (ids.has(credential.id) || values.has(key)) {
      skipped++
      continue
    }

    try {
      await input.create({
        id: credential.id,
        integrationID: credential.integrationID,
        label: credential.label,
        value,
        activate: credential.active && !selected.has(credential.integrationID),
      })
      imported++
      importedIntegrations.add(credential.integrationID)
      ids.add(credential.id)
      values.add(key)

      if (credential.active) selected.add(credential.integrationID)
    } catch (error) {
      if (isConflictError(error)) {
        skipped++
        continue
      }

      errors.push(`${credential.label}: ${message(error)}`)
    }
  }

  return { imported, skipped, errors, integrations: [...importedIntegrations] }
}

function credentialValueKey(integrationID: string, value: CredentialValue) {
  return JSON.stringify([integrationID, value])
}

// SAFETY: caught values are arbitrary throws; the toast only shows an Error's message.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
