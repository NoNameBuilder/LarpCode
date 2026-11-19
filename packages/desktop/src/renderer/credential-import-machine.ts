import type { OpenCodeCredentialList } from "../shared/ipc-rpc/credentials"

/**
 * First-run offer to copy OpenCode sign-ins into LarpCode. The source databases
 * are owned by OpenCode, so the reader never writes them; this flow only records
 * the user's decision and, when accepted, copies credentials through the server.
 */
export type CredentialDecision = "imported" | "declined" | "dismissed" | "already-connected" | "no-source"

export type CredentialImportResult = {
  readonly imported: number
  readonly skipped: number
  readonly errors: readonly string[]
  readonly integrations: readonly string[]
}

export type CredentialImportState =
  | { readonly status: "waiting" }
  | { readonly status: "checking" }
  | { readonly status: "offer"; readonly list: OpenCodeCredentialList }
  | { readonly status: "importing"; readonly list: OpenCodeCredentialList }
  | { readonly status: "done"; readonly decision?: CredentialDecision }
  | { readonly status: "disposed" }

export type CredentialImportEvent =
  | { readonly type: "ready" }
  /** A prior decision means this install has already answered the offer. */
  | { readonly type: "skipped" }
  | { readonly type: "checked"; readonly existing: number; readonly list: OpenCodeCredentialList }
  | { readonly type: "check.failed"; readonly error: unknown }
  | { readonly type: "accepted" }
  | { readonly type: "imported"; readonly result: CredentialImportResult }
  | { readonly type: "import.failed"; readonly error: unknown }
  | { readonly type: "declined" }
  | { readonly type: "dismissed" }
  /** Another dialog owns the screen; leave no decision so the offer returns on the next start. */
  | { readonly type: "postponed" }
  | { readonly type: "disposed" }

export type CredentialImportEffect =
  | { readonly type: "check" }
  | { readonly type: "open-offer"; readonly list: OpenCodeCredentialList }
  | { readonly type: "import"; readonly list: OpenCodeCredentialList }
  | { readonly type: "close-offer" }
  | { readonly type: "open-manual" }
  | { readonly type: "record"; readonly decision: CredentialDecision }
  | { readonly type: "check-error"; readonly error: unknown }
  | { readonly type: "import-result"; readonly result: CredentialImportResult }
  | { readonly type: "import-error"; readonly error: unknown }
  | { readonly type: "refresh" }

export type CredentialImportTransition = {
  readonly state: CredentialImportState
  readonly effects: readonly CredentialImportEffect[]
}

const DONE: CredentialImportState = Object.freeze({ status: "done" })

const DISPOSED: CredentialImportState = Object.freeze({ status: "disposed" })

const unchanged = (state: CredentialImportState): CredentialImportTransition => ({ state, effects: [] })

export function transitionCredentialImport(
  state: CredentialImportState,
  event: CredentialImportEvent,
): CredentialImportTransition {
  if (state.status === "disposed") return unchanged(state)

  if (event.type === "disposed") return { state: DISPOSED, effects: [] }

  switch (event.type) {
    case "ready":
      if (state.status !== "waiting") return unchanged(state)

      return { state: { status: "checking" }, effects: [{ type: "check" }] }

    case "skipped":
      if (state.status !== "waiting") return unchanged(state)

      return { state: DONE, effects: [] }

    case "checked":
      if (state.status !== "checking") return unchanged(state)

      if (event.existing > 0) return done("already-connected")

      if (event.list.credentials.length === 0) return done("no-source")

      return {
        state: { status: "offer", list: event.list },
        effects: [{ type: "open-offer", list: event.list }],
      }

    case "check.failed":
      if (state.status !== "checking") return unchanged(state)

      // Leave no decision recorded so the offer returns on the next start.
      return { state: DONE, effects: [{ type: "check-error", error: event.error }] }

    case "accepted":
      if (state.status !== "offer") return unchanged(state)

      return {
        state: { status: "importing", list: state.list },
        effects: [{ type: "import", list: state.list }],
      }

    case "imported":
      if (state.status !== "importing") return unchanged(state)

      return {
        state: { status: "done", decision: "imported" },
        effects: [
          { type: "close-offer" },
          { type: "record", decision: "imported" },
          { type: "import-result", result: event.result },
          { type: "refresh" },
        ],
      }

    case "import.failed":
      if (state.status !== "importing") return unchanged(state)

      return {
        state: { status: "offer", list: state.list },
        effects: [{ type: "import-error", error: event.error }],
      }

    case "declined":
      if (state.status !== "offer") return unchanged(state)

      return {
        state: { status: "done", decision: "declined" },
        effects: [{ type: "close-offer" }, { type: "open-manual" }, { type: "record", decision: "declined" }],
      }

    case "dismissed":
      if (state.status !== "offer") return unchanged(state)

      return { state: { status: "done", decision: "dismissed" }, effects: [{ type: "record", decision: "dismissed" }] }

    case "postponed":
      if (state.status !== "offer") return unchanged(state)

      return { state: DONE, effects: [] }
  }
}

function done(decision: CredentialDecision): CredentialImportTransition {
  return {
    state: { status: "done", decision },
    effects: [{ type: "record", decision }],
  }
}
