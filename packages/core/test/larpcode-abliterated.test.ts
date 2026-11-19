import { describe, expect, test } from "bun:test"
import { LarpcodeAbliterated } from "@opencode/core/larpcode-abliterated"

describe("LarpCode Auto JB profiles", () => {
  test("automatic uses a model-specific profile only when the model matches", () => {
    expect(LarpcodeAbliterated.resolveProfile("auto", { providerID: "deepseek", modelID: "deepseek-v4.1" }).id).toBe(
      "deepseek",
    )
    expect(
      LarpcodeAbliterated.resolveProfile("auto", { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1" }).id,
    ).toBe("deepseek")
    expect(LarpcodeAbliterated.resolveProfile("auto", { providerID: "anthropic", modelID: "claude-sonnet-4" }).id).toBe(
      "universal",
    )
    expect(LarpcodeAbliterated.resolveProfile("auto").id).toBe("universal")
  })

  test("an explicit profile selection wins even when the model does not match", () => {
    expect(
      LarpcodeAbliterated.resolveProfile("bigpickle", { providerID: "deepseek", modelID: "deepseek-v4.1" }).id,
    ).toBe("bigpickle")
    expect(LarpcodeAbliterated.resolveProfile("deepseek", { providerID: "anthropic", modelID: "claude" }).id).toBe(
      "deepseek",
    )
    expect(LarpcodeAbliterated.resolveProfile("missing", { providerID: "deepseek", modelID: "deepseek-v4.1" }).id).toBe(
      "deepseek",
    )
  })

  test("profile metadata exposes the built-in sets and their sizes", () => {
    const profiles = LarpcodeAbliterated.profiles()
    expect(profiles.map((profile) => profile.id)).toEqual(["universal", "bigpickle", "deepseek"])
    expect(profiles.map((profile) => profile.scope)).toEqual(["universal", "universal", "model"])
    for (const profile of profiles) expect(profile.length).toBeGreaterThan(0)
    expect(LarpcodeAbliterated.DefaultContent.length).toBe(profiles[0]!.length)
  })
})
