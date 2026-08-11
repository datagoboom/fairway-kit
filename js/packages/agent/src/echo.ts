/** Trivial reference runner for demos and tests: echoes the user message with
 * one fake tool call. Exercises the whole protocol path with no credentials —
 * the smallest possible example of the Runner contract. */

import type { Runner } from "./types.js";

export const EchoRunner: Runner = async (ctx, emit) => {
  await emit({ type: "tool_call", id: "echo-1", tool: "echo", kind: "system", label: "Echo", detail: ctx.userContent.slice(0, 60) });
  await emit({ type: "tool_result", id: "echo-1", ok: true, summary: "ok" });
  const reply = `You said: ${ctx.userContent}`;
  for (const word of reply.split(" ")) await emit({ type: "text", content: word + " " });
  await emit({ type: "text_block", content: reply });
  return { content: reply };
};
