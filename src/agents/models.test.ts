import { describe, expect, it } from "vitest"
import { modelContextTokens } from "./models"

const env = {
  AI: {} as never,
  AI_GATEWAY_ID: "default",
  MODEL: "dynamic/command-code",
  BACKGROUND_MODEL: null,
  FALLBACK_MODEL: "@cf/openai/gpt-oss-120b",
} as const

describe("modelContextTokens", () => {
  it("uses the fallback model's smaller context window", () => {
    expect(
      modelContextTokens(env, "dynamic/command-code", {
        chat: null,
        background: null,
        fallback: true,
      })
    ).toBe(128_000)
  })

  it("ignores the fallback when it is disabled", () => {
    expect(
      modelContextTokens(env, "dynamic/command-code", {
        chat: null,
        background: null,
        fallback: false,
      })
    ).toBe(1_000_000)
  })
})
