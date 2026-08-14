/**
 * @fairway-kit/agent - the agent integration layer for fairway.
 *
 * Two things live here: the **Runner contract** (what you implement to drive a
 * turn) and the **adapter toolkit** (helpers that turn any agent's stream into
 * durable protocol events). @fairway-kit/server consumes a Runner; it never
 * dictates how one is built, so you can plug in any agent.
 *
 * Build one from a normalized stream:
 *
 *   import { runnerFromStream } from "@fairway-kit/agent";
 *   const runner = runnerFromStream({
 *     start: async function* (ctx, signal) {
 *       for await (const part of myAgent(ctx.userContent, { signal }))
 *         yield { type: "text-delta", text: part };
 *     },
 *   });
 *
 * Or use a bundled adapter (subpath, optional peer dep):
 *
 *   import { claudeCodeRunner } from "@fairway-kit/agent/claude-code";
 */

// The Runner contract.
export type {
  Runner,
  TurnContext,
  TurnResult,
  Emit,
  Message,
  StampedEvent,
  EmitEvent,
  PermissionRequest,
  PermissionOutcome,
  RunnerCapabilities,
} from "./types.js";

// The adapter toolkit.
export {
  runnerFromStream,
  Coalescer,
  DEFAULT_TOOL_META,
  resolveToolMeta,
  stripMcpPrefix,
  requestToolPermission,
  gateTool,
} from "./toolkit.js";
export type { AgentEvent, ToolMeta, RunnerFromStreamOptions } from "./toolkit.js";

// Event constructors + validation (the emit side).
export * as events from "./events.js";

// Reference runner.
export { EchoRunner } from "./echo.js";
