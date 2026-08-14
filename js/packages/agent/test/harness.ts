/** The conformance harness: the shared bar every runner is validated against -
 * the shipped claude-code adapter, the pump itself, and (by copying this file's
 * pattern) any recipe adapter. It builds a fake TurnContext + a capturing emit,
 * runs a runner, and hands back what it emitted so a test can assert ordering,
 * coalescing, the session round-trip, cancellation, and terminal behavior
 * without a real SDK, network, or credentials. */

import type { Emit, Runner, StampedEvent, TurnContext } from "../src/index.js";

/** A capturing emit: records every event a runner produces, stamping seq/ts the
 * way the store would. */
export function makeEmit(): { emit: Emit; emitted: StampedEvent[] } {
  const emitted: StampedEvent[] = [];
  let seq = 0;
  const emit: Emit = async (ev) => {
    const stamped = { ...ev, seq: ++seq, ts: "t" } as StampedEvent;
    emitted.push(stamped);
    return stamped;
  };
  return { emit, emitted };
}

/** A minimal TurnContext for driving a runner in tests. */
export function fakeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    session: { id: "s1" },
    messages: [],
    userContent: "hi",
    userMessageId: "u1",
    assistantMessageId: "a1",
    jobId: "j1",
    attachments: [],
    signal: new AbortController().signal,
    providerSessionId: null,
    ...overrides,
  };
}

/** Context + emit + the captured buffer, wired together. */
export function harness(overrides: Partial<TurnContext> = {}) {
  const { emit, emitted } = makeEmit();
  const ctx = fakeCtx(overrides);
  return { ctx, emit, emitted };
}

/** Run a runner to completion and capture the outcome - the one call a recipe's
 * test needs. Returns what was emitted plus the TurnResult (or the thrown
 * error), so a test asserts the contract without touching the framework. */
export async function drive(
  runner: Runner,
  overrides: Partial<TurnContext> = {},
): Promise<{
  ctx: TurnContext;
  emitted: StampedEvent[];
  result?: { content: string; reason?: string };
  error?: Error;
}> {
  const { ctx, emit, emitted } = harness(overrides);
  try {
    const result = await runner(ctx, emit);
    return { ctx, emitted, result };
  } catch (e) {
    return { ctx, emitted, error: e as Error };
  }
}
