import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test("first launch offers to import OpenCode credentials", async () => {
  await using state = await tmpdir()
  const created: unknown[] = []
  await using setup = await createAppFixture({
    state: state.path,
    channel: "local",
    seedHome: (home) => {
      const directory = path.join(home, ".local", "share", "opencode")
      mkdirSync(directory, { recursive: true })
      const db = new Database(path.join(directory, "opencode.db"))
      db.exec(`
        CREATE TABLE credential (
          id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL,
          connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL
        );
      `)
      db.query(
        "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "cred_opencode",
        "opencode",
        "Personal",
        JSON.stringify({
          type: "oauth",
          methodID: "device",
          refresh: "rt_test",
          access: "st_test",
          expires: 100,
        }),
        1,
        1,
        2,
      )
      db.close()
    },
    fetch: async (url, request) => {
      if (url.pathname === "/api/credential" && request.method === "GET") return json({ data: [] })
      if (url.pathname === "/api/credential" && request.method === "POST") {
        const body = (await request.json()) as { id: string; integrationID: string; label: string; value: unknown }
        created.push(body)
        return json({ data: { ...body, active: true } })
      }
    },
  })

  await setup.ready
  const frame = await setup.waitForFrame(
    (value) => value.includes("Import OpenCode credentials?") && value.includes("Yes, import from OpenCode"),
  )
  expect(frame).toContain("No, I'll connect manually")

  setup.mockInput.pressEnter()
  await setup.waitFor(() => created.length === 1)
  await setup.waitForFrame((value) => !value.includes("Import OpenCode credentials?"))

  expect(created[0]).toMatchObject({
    id: "cred_opencode",
    integrationID: "opencode",
    label: "Personal",
    value: { type: "oauth", access: "st_test" },
    activate: true,
  })
})

test("a paid model without credentials warns and offers the matching import", async () => {
  await using state = await tmpdir()
  const directory = process.cwd()
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const session = {
    id: "ses_paid",
    title: "Paid model",
    projectID: "proj_test",
    location: { directory },
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  let submitted = false
  await using setup = await createAppFixture({
    state: state.path,
    args: { sessionID: session.id },
    seedHome: (home) => {
      const data = path.join(home, ".local", "share", "opencode")
      mkdirSync(data, { recursive: true })
      const db = new Database(path.join(data, "opencode.db"))
      db.exec(`
        CREATE TABLE credential (
          id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL,
          connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL
        );
      `)
      db.query(
        "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("cred_openai", "openai", "Work", JSON.stringify({ type: "key", key: "sk-test" }), 1, 1, 2)
      db.close()
    },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session" && request.method === "GET") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        submitted = true
        return json({ data: {} })
      }
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "gpt-5",
              modelID: "gpt-5",
              providerID: "openai",
              name: "GPT-5",
              cost: [{ input: 4, output: 8 }],
              variants: [],
            },
          ],
        })
      if (url.pathname === "/api/provider")
        return json({ location, data: [{ id: "openai", integrationID: "openai", name: "OpenAI" }] })
      if (url.pathname === "/api/integration")
        return json({
          location,
          data: [
            {
              id: "openai",
              name: "OpenAI",
              methods: [{ type: "key", label: "API key" }],
              connections: [],
            },
          ],
        })
    },
  })

  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · GPT-5 OpenAI"))
  setup.mockInput.typeText("hello")
  setup.mockInput.pressEnter()

  const frame = await setup.waitForFrame(
    (value) => value.includes("Import OpenCode credentials?") && value.includes("Yes, import from OpenCode"),
  )
  expect(frame).toContain("1 credential")
  expect(frame).toContain("openai")
  expect(submitted).toBe(false)
})
