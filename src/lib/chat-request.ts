import type { UIMessage } from "ai"

/**
 * The server already owns the saved transcript. A normal submit only needs its
 * newest user turn; older history is reconciled against Durable Object storage.
 *
 * Keep a trailing run of user messages because the client can queue more than
 * one. Regenerations and assistant-ended requests are left untouched: their
 * exact server rows must remain available to the reconciler.
 */
export function boundedChatRequestMessages(
  messages: UIMessage[],
  trigger: "submit-message" | "regenerate-message"
): UIMessage[] {
  const last = messages.at(-1)
  if (trigger !== "submit-message" || last?.role !== "user") return messages

  let start = messages.length - 1
  while (start > 0 && messages[start - 1].role === "user") start--

  return messages.slice(start)
}
