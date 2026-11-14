import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { WebSocketChatTransport } from "agents/chat/transport"
import { reconcileMessages } from "agents/chat"
import type { UIMessage } from "ai"
import { boundedChatRequestMessages } from "./chat-request"

const LIMIT = 32 * 1024 * 1024

function textMessage(id: string, role: UIMessage["role"], text: string) {
  return { id, role, parts: [{ type: "text", text }] } satisfies UIMessage
}

describe("boundedChatRequestMessages", () => {
  it("keeps queued trailing user messages", () => {
    const messages = [
      textMessage("old-user", "user", "old"),
      textMessage("old-reply", "assistant", "reply"),
      textMessage("queued-1", "user", "one"),
      textMessage("queued-2", "user", "two"),
    ]

    expect(
      boundedChatRequestMessages(messages, "submit-message").map((m) => m.id)
    ).toEqual(["queued-1", "queued-2"])
  })

  it("does not shrink an assistant-ended continuation", () => {
    const messages = [
      textMessage("old-user", "user", "old"),
      textMessage("old-reply", "assistant", "reply"),
      textMessage("current-user", "user", "send it"),
      {
        id: "approval",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "send_email",
            toolCallId: "call-1",
            state: "approval-requested",
            input: { to: "a@example.com" },
            approval: { id: "approval-1" },
          },
        ],
      },
    ] satisfies UIMessage[]

    expect(boundedChatRequestMessages(messages, "submit-message")).toBe(
      messages
    )
  })

  it("does not shrink a regeneration even when it ends in a user message", () => {
    const messages = [
      textMessage("old-user", "user", "old"),
      textMessage("old-reply", "assistant", "reply"),
      textMessage("target-user", "user", "answer this again"),
    ]

    expect(boundedChatRequestMessages(messages, "regenerate-message")).toBe(
      messages
    )
  })
})

describe("SDK reconcile with bounded payloads", () => {
  const replied = [
    textMessage("old-user", "user", "old"),
    textMessage("old-reply", "assistant", "reply"),
  ]
  const server = [...replied, textMessage("target-user", "user", "target")]

  it("returns only the new user row for an append", () => {
    const incoming = [...replied, textMessage("new-user", "user", "hi")]
    const selected = boundedChatRequestMessages(incoming, "submit-message")

    expect(
      reconcileMessages(selected, replied, (message) => message).map(
        (message) => message.id
      )
    ).toEqual(["new-user"])
  })

  it("returns only the edited user row, not the saved history", () => {
    const edited = textMessage("target-user", "user", "edited")
    const selected = boundedChatRequestMessages(
      [...server, edited],
      "submit-message"
    )

    const reconciled = reconcileMessages(selected, server, (message) => message)

    expect(reconciled.length).toBeGreaterThan(0)
    expect(new Set(reconciled.map((message) => message.id))).toEqual(
      new Set(["target-user"])
    )
  })

  it("keeps the full regeneration transcript unchanged", () => {
    const selected = boundedChatRequestMessages(server, "regenerate-message")
    const reconciled = reconcileMessages(selected, server, (message) => message)

    expect(reconciled.map((message) => message.id)).toEqual([
      "old-user",
      "old-reply",
      "target-user",
    ])
    expect(server.map((message) => message.id)).toEqual([
      "old-user",
      "old-reply",
      "target-user",
    ])
  })
})

describe("bounded chat request transport", () => {
  let mf: Miniflare
  let baseUrl: URL

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        script: `addEventListener("fetch", (event) => {
  if (event.request.headers.get("Upgrade") !== "websocket") {
    event.respondWith(new Response("ok"));
    return;
  }
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].addEventListener("message", (message) => {
    const frame = JSON.parse(message.data);
    const body = JSON.parse(frame.init.body);
    pair[1].send(JSON.stringify({
      type: "cf_agent_use_chat_response",
      id: frame.id,
      body: JSON.stringify({
        type: "data-request",
        data: {
          bytes: new TextEncoder().encode(message.data).byteLength,
          ids: body.messages.map((message) => message.id),
          parts: body.messages.map((message) =>
            message.parts.map((part) => part.type)
          ),
        },
      }),
      done: false,
    }));
    pair[1].send(JSON.stringify({
      type: "cf_agent_use_chat_response",
      id: frame.id,
      body: "",
      done: true,
    }));
  });
  event.respondWith(new Response(null, { status: 101, webSocket: pair[0] }));
});`,
      })
    )
    baseUrl = await mf.ready
  })

  afterAll(async () => {
    await mf.dispose()
  })

  async function send(
    messages: UIMessage[],
    trigger: "submit-message" | "regenerate-message" = "submit-message"
  ) {
    const socket = new WebSocket(baseUrl.toString().replace(/^http/, "ws"))
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener(
        "error",
        () => reject(new Error("socket error")),
        {
          once: true,
        }
      )
    })
    const transport = new WebSocketChatTransport({
      agent: socket,
      prepareBody: async ({ messages: sent, trigger }) => ({
        messages: boundedChatRequestMessages(sent, trigger),
      }),
    })
    const stream = await transport.sendMessages({
      chatId: "test",
      trigger,
      messages,
      abortSignal: new AbortController().signal,
    })
    const chunks: unknown[] = []
    for await (const chunk of stream) chunks.push(chunk)
    socket.close()

    const received = chunks.find(
      (chunk) =>
        typeof chunk === "object" &&
        chunk !== null &&
        "type" in chunk &&
        chunk.type === "data-request"
    ) as
      | {
          type: "data-request"
          data: { bytes: number; ids: string[]; parts: string[][] }
        }
      | undefined
    return { received, chunks }
  }

  it("sends only the recent turn instead of a synthetic oversized transcript", async () => {
    const messages = [
      textMessage("old-user", "user", "old request"),
      textMessage("old-reply", "assistant", "x".repeat(LIMIT + 1_024)),
      textMessage("queued-1", "user", "first"),
      textMessage("hi", "user", "hi"),
    ]

    expect(JSON.stringify(messages).length).toBeGreaterThan(LIMIT)

    const result = await send(messages)

    expect(result.received?.data.bytes).toBeLessThan(LIMIT)
    expect(result.received?.data.ids).toEqual(["queued-1", "hi"])
  })

  it("keeps an assistant-ended approval request intact", async () => {
    const messages = [
      textMessage("current-user", "user", "send it"),
      {
        id: "approval",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "send_email",
            toolCallId: "call-1",
            state: "approval-requested",
            input: { to: "a@example.com" },
            approval: { id: "approval-1" },
          },
        ],
      },
    ] satisfies UIMessage[]

    const result = await send(messages)

    expect(result.received?.data.bytes).toBeLessThan(LIMIT)
    expect(result.received?.data.ids).toEqual(["current-user", "approval"])
    expect(result.received?.data.parts).toEqual([["text"], ["dynamic-tool"]])
  })

  it("sends the full original regeneration payload", async () => {
    const messages = [
      textMessage("old-user", "user", "old request"),
      textMessage("old-reply", "assistant", "reply"),
      textMessage("target-user", "user", "answer this again"),
    ]

    const result = await send(messages, "regenerate-message")

    expect(result.received?.data.bytes).toBeLessThan(LIMIT)
    expect(result.received?.data.ids).toEqual([
      "old-user",
      "old-reply",
      "target-user",
    ])
  })
})
