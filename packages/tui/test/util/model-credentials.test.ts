import { describe, expect, test } from "bun:test"
import { missingModelCredentials } from "../../src/util/model-credentials"

const paid = { cost: [{ input: 1 }] }
const free = { cost: [{ input: 0 }] }
const provider = { integrationID: "openai", settings: {} }
const keyed = { methods: [{ type: "key" as const }], connections: [] }

describe("missingModelCredentials", () => {
  test("free models never need an account", () => {
    expect(missingModelCredentials({ model: free, provider, integration: keyed })).toBe(false)
  })

  test("a paid model with no connection or key needs credentials", () => {
    expect(missingModelCredentials({ model: paid, provider, integration: keyed })).toBe(true)
  })

  test("a stored connection, environment variable, or provider key satisfies the provider", () => {
    expect(
      missingModelCredentials({
        model: paid,
        provider,
        integration: { ...keyed, connections: [{ type: "credential" }] },
      }),
    ).toBe(false)
    expect(
      missingModelCredentials({
        model: paid,
        provider,
        integration: { ...keyed, connections: [{ type: "env" }] },
      }),
    ).toBe(false)
    expect(
      missingModelCredentials({
        model: paid,
        provider: { ...provider, settings: { apiKey: "sk-test" } },
        integration: keyed,
      }),
    ).toBe(false)
  })

  test("providers without a credential method, or without an integration, are left alone", () => {
    expect(
      missingModelCredentials({
        model: paid,
        provider,
        integration: { methods: [{ type: "env" }], connections: [] },
      }),
    ).toBe(false)
    expect(
      missingModelCredentials({
        model: paid,
        provider: { integrationID: undefined, settings: {} },
        integration: keyed,
      }),
    ).toBe(false)
    expect(missingModelCredentials({ model: paid, provider, integration: undefined })).toBe(false)
  })
})
