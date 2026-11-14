import { describe, expect, it } from "vitest"
import type { ModelMessage } from "ai"
import {
  KEEP_IMAGES,
  KEEP_PAGE_RESULTS,
  LoopGuard,
  MAX_IDENTICAL_CALLS,
  STOP_AFTER_MS,
  TurnBudget,
  UPDATE_AFTER_MS,
  WRAP_UP_AFTER_MS,
  MAX_TOOL_RESULT_CHARS,
  boundModelHistory,
  modelHistoryByteBudget,
  prepareModelHistory,
  shapeToolResults,
  stableJson,
} from "./guards"

describe("stableJson", () => {
  it("ignores key order and undefined values", () => {
    expect(stableJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe(
      stableJson({ a: [2, { d: 3 }], b: 1 })
    )
  })
})

describe("LoopGuard", () => {
  it("blocks only after the same call repeats too often", () => {
    const guard = new LoopGuard()
    for (let i = 0; i < MAX_IDENTICAL_CALLS; i++) {
      expect(guard.check("exec", { command: "ls" })).toBeNull()
    }
    expect(guard.check("exec", { command: "ls" })).toMatch(/Stop retrying/)
  })

  it("resets when any argument changes", () => {
    const guard = new LoopGuard()
    for (let i = 0; i < 20; i++) {
      expect(
        guard.check("browser_markdown", { url: `https://x.test/${i % 2}` })
      ).toBeNull()
    }
  })

  it("starts over after reset", () => {
    const guard = new LoopGuard()
    for (let i = 0; i <= MAX_IDENTICAL_CALLS; i++)
      guard.check("exec", { command: "ls" })
    guard.reset()
    expect(guard.check("exec", { command: "ls" })).toBeNull()
  })
})

function toolMessage(
  toolName: string,
  output: unknown,
  id: string
): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName, output } as never,
    ],
  }
}

function outputOf(message: ModelMessage) {
  return (message.content as { output: { type: string; value: unknown } }[])[0]
    .output
}

function user(text: string): ModelMessage {
  return { role: "user", content: text }
}

function toolCall(id: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "lookup",
        input: { id },
      },
    ],
  }
}

describe("boundModelHistory", () => {
  it("drops only older complete user turns", () => {
    const messages: ModelMessage[] = [
      user("old request ".repeat(500)),
      toolCall("old-call"),
      toolMessage("lookup", { type: "json", value: {} }, "old-call"),
      { role: "assistant", content: "old answer ".repeat(500) },
      user("recent request"),
      toolCall("recent-call"),
      toolMessage("lookup", { type: "json", value: {} }, "recent-call"),
      { role: "assistant", content: "recent answer" },
    ]

    const bounded = boundModelHistory(messages, 1_000)

    expect(bounded.messages).toEqual(messages.slice(4))
    expect(bounded.messages[0].role).toBe("user")
    expect(bounded.omittedMessages).toBe(4)
  })

  it("keeps an oversized newest turn whole so the caller can fail clearly", () => {
    const newestTurn: ModelMessage[] = [
      user("new request ".repeat(500)),
      toolCall("new-call"),
      toolMessage("lookup", { type: "json", value: {} }, "new-call"),
    ]
    const bounded = boundModelHistory(
      [user("old request ".repeat(500)), ...newestTurn],
      100
    )

    expect(bounded.messages).toEqual(newestTurn)
    expect(bounded.bytes).toBeGreaterThan(100)
    expect(bounded.omittedMessages).toBe(1)
  })
})

describe("modelHistoryByteBudget", () => {
  it("reserves provider headroom after counting the fixed prompt", () => {
    expect(modelHistoryByteBudget(200_000, 20_000)).toBe(160_000)
  })
})

describe("prepareModelHistory", () => {
  it("caps a huge newest tool result before deciding it is over budget", () => {
    const messages: ModelMessage[] = [
      user("read the generated report"),
      toolMessage(
        "exec",
        {
          type: "text",
          value: "x".repeat(1_000_000),
        },
        "large-result"
      ),
    ]

    const prepared = prepareModelHistory(messages, 20_000)

    expect(prepared.omittedMessages).toBe(0)
    expect(prepared.bytes).toBeLessThanOrEqual(20_000)
    expect(String(outputOf(prepared.messages[1]).value)).toMatch(/Truncated/)
  })
})

describe("shapeToolResults", () => {
  it("returns null when nothing needs changing", () => {
    expect(
      shapeToolResults([
        toolMessage("exec", { type: "text", value: "ok" }, "1"),
      ])
    ).toBeNull()
  })

  it("caps any single result", () => {
    const big = "x".repeat(MAX_TOOL_RESULT_CHARS + 500)
    const shaped = shapeToolResults([
      toolMessage("exec", { type: "text", value: big }, "1"),
    ])!
    const value = String(outputOf(shaped[0]).value)
    expect(value.length).toBeLessThan(big.length)
    expect(value).toMatch(/Truncated/)
  })

  it("keeps only the newest large page results whole", () => {
    const page = "p".repeat(2_000)
    const messages = Array.from({ length: KEEP_PAGE_RESULTS + 2 }, (_, i) =>
      toolMessage("browser_markdown", { type: "text", value: page }, String(i))
    )
    const shaped = shapeToolResults(messages)!
    const shortened = shaped.filter((m) =>
      /shortened after you read it/.test(String(outputOf(m).value))
    )
    expect(shortened).toHaveLength(2)
    // The newest ones are the ones left alone.
    expect(String(outputOf(shaped.at(-1)!).value)).toBe(page)
  })

  it("drops all but the newest screenshots", () => {
    const shot = (id: string) =>
      toolMessage(
        "browser_screenshot",
        {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "AAAA" },
            },
          ],
        },
        id
      )
    const messages = Array.from({ length: KEEP_IMAGES + 2 }, (_, i) =>
      shot(String(i))
    )
    const shaped = shapeToolResults(messages)!
    const kept = shaped.filter((m) => {
      const value = outputOf(m).value as { type: string }[]
      return value[0].type === "file"
    })
    expect(kept).toHaveLength(KEEP_IMAGES)
  })

  it("leaves non-tool messages untouched", () => {
    const user: ModelMessage = { role: "user", content: "x".repeat(50_000) }
    expect(shapeToolResults([user])).toBeNull()
  })
})

describe("TurnBudget", () => {
  it("asks for an update after a quiet minute, again after the next one", () => {
    const budget = new TurnBudget()
    budget.start(0)
    expect(budget.check(UPDATE_AFTER_MS - 1)).toBeNull()
    expect(budget.check(UPDATE_AFTER_MS)?.kind).toBe("update")
    expect(budget.check(UPDATE_AFTER_MS + 1)).toBeNull()
    budget.spoke(70_000)
    expect(budget.check(70_000 + UPDATE_AFTER_MS)?.kind).toBe("update")
  })

  it("winds the turn down, then switches tools off, once each", () => {
    const budget = new TurnBudget()
    budget.start(0)
    budget.spoke(WRAP_UP_AFTER_MS)
    expect(budget.check(WRAP_UP_AFTER_MS)?.kind).toBe("wrap_up")
    budget.spoke(STOP_AFTER_MS)
    expect(budget.check(STOP_AFTER_MS)?.kind).toBe("stop")
    expect(budget.check(STOP_AFTER_MS + 1)).toBeNull()
  })

  it("does nothing before a turn starts", () => {
    expect(new TurnBudget().check(STOP_AFTER_MS * 2)).toBeNull()
  })
})
