import { describe, expect, test } from "bun:test"
import type { OpenCodeCredentialList } from "../shared/ipc-rpc/credentials"
import {
  transitionCredentialImport,
  type CredentialDecision,
  type CredentialImportEffect,
  type CredentialImportEvent,
  type CredentialImportResult,
  type CredentialImportState,
} from "./credential-import-machine"

const list: OpenCodeCredentialList = {
  databases: ["/home/me/.local/share/opencode/opencode.db"],
  credentials: [
    {
      database: "/home/me/.local/share/opencode/opencode.db",
      id: "cred_1",
      integrationID: "anthropic",
      label: "Anthropic",
      active: true,
      value: { type: "key", key: "sk-ant" },
    },
  ],
  errors: [],
}

const imported: CredentialImportResult = {
  imported: 1,
  skipped: 0,
  errors: [],
  integrations: ["anthropic"],
}

const error = new Error("database is locked")

// Folds events through the machine and keeps the effects of each step.
function replay(events: readonly CredentialImportEvent[], from: CredentialImportState = { status: "waiting" }) {
  return events.reduce<{ state: CredentialImportState; effects: (readonly CredentialImportEffect[])[] }>(
    (result, event) => {
      const next = transitionCredentialImport(result.state, event)

      return { state: next.state, effects: [...result.effects, next.effects] }
    },
    { state: from, effects: [] },
  )
}

const offered = replay([{ type: "ready" }, { type: "checked", existing: 0, list }]).state

describe("OpenCode credential import", () => {
  test("a recorded decision skips the check on later starts", () => {
    const run = replay([{ type: "skipped" }])

    expect(run.state).toEqual({ status: "done" })
    expect(run.effects.flat()).toEqual([])
  })

  test.each([
    ["LarpCode already has a sign-in", { existing: 1, list }, "already-connected"],
    ["OpenCode saved none", { existing: 0, list: { ...list, credentials: [] } }, "no-source"],
  ] satisfies [string, { existing: number; list: OpenCodeCredentialList }, CredentialDecision][])(
    "records %s without opening the offer",
    (_name, checked, decision) => {
      const run = replay([{ type: "ready" }, { type: "checked", ...checked }])

      expect(run.state).toEqual({ status: "done", decision })
      expect(run.effects).toEqual([[{ type: "check" }], [{ type: "record", decision }]])
    },
  )

  test("copies the offered credentials and reports the result", () => {
    const run = replay([
      { type: "ready" },
      { type: "checked", existing: 0, list },
      { type: "accepted" },
      { type: "imported", result: imported },
    ])

    expect(run.state).toEqual({ status: "done", decision: "imported" })
    expect(run.effects).toEqual([
      [{ type: "check" }],
      [{ type: "open-offer", list }],
      [{ type: "import", list }],
      [
        { type: "close-offer" },
        { type: "record", decision: "imported" },
        { type: "import-result", result: imported },
        { type: "refresh" },
      ],
    ])
  })

  test("a failed import returns to the offer without recording a decision", () => {
    const importing = replay([{ type: "ready" }, { type: "checked", existing: 0, list }, { type: "accepted" }]).state

    const next = transitionCredentialImport(importing, { type: "import.failed", error })

    expect(next.state).toEqual({ status: "offer", list })
    expect(next.effects).toEqual([{ type: "import-error", error }])
  })

  test("a failed check reports the error without recording a decision", () => {
    const checking = replay([{ type: "ready" }]).state

    const next = transitionCredentialImport(checking, { type: "check.failed", error })

    expect(next.state).toEqual({ status: "done" })
    expect(next.effects).toEqual([{ type: "check-error", error }])
  })

  test("connecting manually closes the offer and records the decline", () => {
    const next = transitionCredentialImport(offered, { type: "declined" })

    expect(next.state).toEqual({ status: "done", decision: "declined" })
    expect(next.effects).toEqual([
      { type: "close-offer" },
      { type: "open-manual" },
      { type: "record", decision: "declined" },
    ])
  })

  test("closing the offer records the dismissal", () => {
    const next = transitionCredentialImport(offered, { type: "dismissed" })

    expect(next.state).toEqual({ status: "done", decision: "dismissed" })
    expect(next.effects).toEqual([{ type: "record", decision: "dismissed" }])
  })

  test("another dialog postpones the offer without recording a decision", () => {
    const next = transitionCredentialImport(offered, { type: "postponed" })

    // Recording anything here would suppress the offer forever instead of returning on the next start.
    expect(next.state).toEqual({ status: "done" })
    expect(next.effects).toEqual([])
  })

  test("ignores results for a phase it already left", () => {
    for (const event of [
      { type: "ready" },
      { type: "checked", existing: 0, list },
      { type: "check.failed", error },
      { type: "imported", result: imported },
      { type: "import.failed", error },
    ] satisfies CredentialImportEvent[]) {
      const next = transitionCredentialImport(offered, event)

      expect(next.state).toBe(offered)
      expect(next.effects).toEqual([])
    }
  })

  test.each([
    ["waiting", { status: "waiting" }],
    ["checking", { status: "checking" }],
    ["offer", { status: "offer", list }],
    ["importing", { status: "importing", list }],
    ["done", { status: "done", decision: "dismissed" }],
  ] satisfies [string, CredentialImportState][])("disposing while %s ignores every late result", (_name, phase) => {
    const disposed = transitionCredentialImport(phase, { type: "disposed" })

    expect(disposed.state).toEqual({ status: "disposed" })
    expect(disposed.effects).toEqual([])

    for (const event of [
      { type: "ready" },
      { type: "checked", existing: 0, list },
      { type: "check.failed", error },
      { type: "accepted" },
      { type: "imported", result: imported },
      { type: "import.failed", error },
      { type: "declined" },
      { type: "dismissed" },
    ] satisfies CredentialImportEvent[]) {
      const next = transitionCredentialImport(disposed.state, event)

      expect(next.state).toBe(disposed.state)
      expect(next.effects).toEqual([])
    }
  })
})
