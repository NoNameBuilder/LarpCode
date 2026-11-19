import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_larpcode",
  title: "LarpCode session",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function payload(autoJb: boolean, selection: string) {
  const active =
    selection === "auto" ? profiles[0]! : (profiles.find((profile) => profile.id === selection) ?? profiles[0]!)
  return {
    ok: true,
    settings: {
      autoRotate: true,
      autoRotateMaxPerHour: 30,
      freeFallback: true,
      forceTor: false,
      egress: "warp",
    },
    sources: { autoRotate: "default", freeFallback: "default", forceTor: "default", egress: "default" },
    settingsPath: "C:\\data\\larpcode-settings.json",
    autoJb: {
      enabled: autoJb,
      custom: false,
      selection,
      profiles,
      active,
      length: active.length,
      defaultLength: profiles[0]!.length,
      max: 750000,
    },
    dependencies: [
      {
        id: "warp",
        name: "Cloudflare WARP",
        installed: false,
        detail: "You don't have Cloudflare WARP installed (warp-cli.exe not found).",
        hint: "Install it from https://1.1.1.1/.",
      },
      { id: "tor", name: "Tor", installed: true, path: "C:\\tor\\tor.exe", detail: "installed", hint: "Optional." },
      {
        id: "impersonate",
        name: "curl-impersonate",
        installed: false,
        detail: "Bundled curl-impersonate was not found.",
        hint: "Optional.",
      },
    ],
    proxy: { configured: false },
    missing: 2,
  }
}

const profiles = [
  {
    id: "universal",
    name: "Op Spec",
    description: "The original universal Auto JB set.",
    scope: "universal" as const,
    length: 123231,
  },
  {
    id: "bigpickle",
    name: "Big Pickle",
    description: "Universal persona set.",
    scope: "universal" as const,
    length: 94427,
  },
  {
    id: "deepseek",
    name: "DeepSeek V4.1",
    description: "Model-specific set for DeepSeek.",
    scope: "model" as const,
    match: ["deepseek"],
    length: 73231,
  },
]

async function render(state: string) {
  let autoJb = false
  let selection = "auto"
  let freeRoute: unknown
  const toggles: string[] = []
  const resets: string[] = []
  const profilesSaved: Array<Record<string, unknown>> = []
  return createAppFixture({
    state,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "on" } },
    fetch: async (url, request) => {
      if (url.pathname === "/_larpcode/settings")
        return json({ ...payload(autoJb, selection), ...(freeRoute ? { freeRoute } : {}) })
      if (url.pathname === "/_larpcode/abliterated") {
        toggles.push(url.search)
        autoJb = url.searchParams.get("enabled") === "1"
        return json({ ok: true, enabled: autoJb })
      }
      if (url.pathname === "/_larpcode/abliterated/content" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>
        profilesSaved.push(body)
        if (typeof body.profile === "string") selection = body.profile
        return json({ ok: true, custom: false, selection, length: 0 })
      }
      if (url.pathname === "/_larpcode/reset-limits") {
        resets.push(url.search)
        return json({ ok: true, deep: false })
      }
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
        })
      return undefined
    },
  }).then((setup) => ({
    setup,
    toggles,
    resets,
    profilesSaved,
    setFreeRoute(value: unknown) {
      freeRoute = value
    },
  }))
}

test("the LarpCode menu opens from the top-right control and toggles Auto JB", async () => {
  await using state = await tmpdir()
  const rendered = await render(state.path)
  await using setup = rendered.setup

  await setup.waitForFrame((frame) => frame.includes("LarpCode session"))
  const marked = await setup.waitForFrame((frame) => frame.includes("⚙!"))
  const row = marked.split("\n").findIndex((line) => line.includes("⚙!"))
  const column = marked.split("\n")[row]!.indexOf("⚙!") + 1
  expect(row).toBe(0)

  await setup.mockMouse.click(column, row)
  const opened = await setup.waitForFrame((frame) => frame.includes("Dependencies missing"))
  expect(opened).toContain("2 missing")
  expect(opened).toContain("LarpCode settings")

  await setup.mockInput.typeText("Auto JB")
  await setup.waitForFrame((frame) => frame.includes("Auto JB") && !frame.includes("Dependencies missing"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => rendered.toggles.length === 1)
  expect(rendered.toggles).toEqual(["?enabled=1"])
  await setup.waitForFrame((frame) => frame.split("\n").some((line) => /Auto JB\s+on$/.test(line.trimEnd())))

  setup.mockInput.pressArrow("left")
  await setup.waitFor(() => rendered.toggles.length === 2)
  expect(rendered.toggles.at(-1)).toBe("?enabled=0")
  await setup.waitForFrame((frame) => frame.split("\n").some((line) => /Auto JB\s+off$/.test(line.trimEnd())))

  setup.mockInput.pressArrow("right")
  await setup.waitFor(() => rendered.toggles.length === 3)
  expect(rendered.toggles.at(-1)).toBe("?enabled=1")
  await setup.waitForFrame((frame) => frame.split("\n").some((line) => /Auto JB\s+on$/.test(line.trimEnd())))

  setup.mockInput.pressEscape()
  await setup.mockInput.typeText("/larpcode:settings")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Dependencies missing"))

  await setup.mockInput.typeText("Reset usage")
  await setup.waitForFrame((frame) => frame.includes("Reset usage limits"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Sessions are kept"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => rendered.resets.length === 1)
  expect(rendered.resets).toEqual([""])
}, 30_000)

test("an explicit model-specific Auto JB profile is saved and shown in the menu", async () => {
  await using state = await tmpdir()
  const rendered = await render(state.path)
  await using setup = rendered.setup

  await setup.waitForFrame((frame) => frame.includes("LarpCode session"))
  const marked = await setup.waitForFrame((frame) => frame.includes("⚙!"))
  const row = marked.split("\n").findIndex((line) => line.includes("⚙!"))
  const column = marked.split("\n")[row]!.indexOf("⚙!") + 1
  await setup.mockMouse.click(column, row)

  await setup.waitForFrame((frame) => frame.includes("Dependencies missing"))
  await setup.mockInput.typeText("JB profile")
  await setup.waitForFrame((frame) => frame.includes("JB profile"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Auto JB profile"))

  await setup.mockInput.typeText("DeepSeek")
  await setup.waitForFrame((frame) => frame.includes("Model-specific · DeepSeek V4.1"))
  setup.mockInput.pressEnter()

  await setup.waitFor(() => rendered.profilesSaved.length === 1)
  expect(rendered.profilesSaved).toEqual([{ profile: "deepseek" }])
  await setup.waitForFrame((frame) =>
    frame.split("\n").some((line) => /JB profile\s+DeepSeek V4\.1$/.test(line.trimEnd())),
  )
}, 30_000)

test("a fallback event shows the provider notice and records the last fallback", async () => {
  await using state = await tmpdir()
  const rendered = await render(state.path)
  await using setup = rendered.setup

  await setup.waitForFrame((frame) => frame.includes("LarpCode session"))
  const at = Date.now()
  rendered.setFreeRoute({ cooling: false, lastFallback: { provider: "pollinations", at } })
  setup.events.emit({
    id: "evt_larpcode_fallback",
    created: at,
    type: "larpcode.fallback.used",
    data: { provider: "pollinations", at },
  })

  await setup.waitForFrame((frame) => frame.includes("Fallback in use") && frame.includes("Pollinations"))

  const marked = await setup.waitForFrame((frame) => frame.includes("⚙!"))
  const row = marked.split("\n").findIndex((line) => line.includes("⚙!"))
  const column = marked.split("\n")[row]!.indexOf("⚙!") + 1
  await setup.mockMouse.click(column, row)
  await setup.waitForFrame((frame) => frame.includes("LarpCode settings"))
  await setup.mockInput.typeText("Last fallback")
  await setup.waitForFrame((frame) => frame.includes("Last fallback") && frame.includes("pollinations"))
}, 30_000)
