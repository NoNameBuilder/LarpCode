/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { DialogCredentialImport, type CredentialDecision } from "../../../src/component/dialog-credential-import"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { OpenCodeCredentialList } from "../../../src/util/opencode-import"

const list = {
  databases: ["C:/Users/test/.local/share/opencode/opencode.db"],
  errors: [],
  credentials: [
    {
      database: "C:/Users/test/.local/share/opencode/opencode.db",
      id: "cred_opencode",
      integrationID: "opencode",
      label: "Personal",
      active: true,
      value: {
        type: "oauth" as const,
        methodID: "device",
        refresh: "rt_test",
        access: "st_test",
        expires: 100,
      },
    },
    {
      database: "C:/Users/test/.local/share/opencode/opencode.db",
      id: "cred_openai",
      integrationID: "openai",
      label: "Work",
      active: true,
      value: { type: "key" as const, key: "sk-test" },
    },
  ],
} as OpenCodeCredentialList

test("offers importing OpenCode credentials with Yes first and recommended", async () => {
  const fixture = await renderDialog()
  try {
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("Import OpenCode credentials?")
    expect(frame).toContain("Yes, import from OpenCode")
    expect(frame).toContain("recommended")
    expect(frame).toContain("No, I'll connect manually")
    expect(frame.indexOf("Yes, import")).toBeLessThan(frame.indexOf("No, I'll connect"))
    expect(frame).toContain("2 credentials")
    expect(frame).toContain("Found in 1 profile: opencode, openai")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("imports every discovered credential and records the decision", async () => {
  const fixture = await renderDialog()
  try {
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.decisions.includes("imported"))
    await fixture.app.waitForFrame((frame) => !frame.includes("Import OpenCode credentials?"))

    expect(fixture.created).toEqual([
      {
        id: "cred_opencode",
        integrationID: "opencode",
        label: "Personal",
        value: { type: "oauth", methodID: "device", refresh: "rt_test", access: "st_test", expires: 100 },
        activate: true,
      },
      {
        id: "cred_openai",
        integrationID: "openai",
        label: "Work",
        value: { type: "key", key: "sk-test" },
        activate: true,
      },
    ])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("dismissing records the decision and keeps the dialog closed", async () => {
  const fixture = await renderDialog()
  try {
    fixture.app.mockInput.pressEscape()
    await fixture.app.waitFor(() => fixture.decisions.includes("dismissed"))
    await fixture.app.waitForFrame((frame) => !frame.includes("Import OpenCode credentials?"))
    expect(fixture.created).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

async function renderDialog() {
  const events = createEventStream()
  const decisions: CredentialDecision[] = []
  const created: unknown[] = []
  const location = {
    directory: process.cwd(),
    project: { id: "proj_test", directory: process.cwd(), canonical: process.cwd() },
  }
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/credential" && request.method === "GET") return json({ data: [] })
    if (url.pathname === "/api/credential" && request.method === "POST") {
      const body = (await request.json()) as {
        id: string
        integrationID: string
        label: string
        value: unknown
        activate: boolean
      }
      created.push(body)
      return json({ data: { ...body, active: body.activate } })
    }
    if (["/api/integration", "/api/model", "/api/provider"].includes(url.pathname)) return json({ location, data: [] })
    return undefined
  }, events)

  function Probe() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => <DialogCredentialImport list={list} onDecided={(decision) => decisions.push(decision)} />),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <LocationProvider>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <DialogProvider>
                        <Probe />
                      </DialogProvider>
                    </ThemeProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Import OpenCode credentials?"))
  return { app, decisions, created }
}
