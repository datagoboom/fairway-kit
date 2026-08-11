/**
 * Manual smoke test for the Claude Code adapter — NOT run in CI.
 *
 * Drives one real turn against the Claude Agent SDK with your local credentials
 * and checks that the adapter maps it to a sane protocol-event sequence. This is
 * the "does it actually work against reality right now" signal we run by hand
 * before a release (creds never leave your machine).
 *
 *   FAIRWAY_AUTH=inherit  npm run smoke:claude -w @fairway-kit/agent
 *   FAIRWAY_AUTH=api      ANTHROPIC_API_KEY=... npm run smoke:claude -w @fairway-kit/agent
 *
 * Needs @anthropic-ai/claude-agent-sdk installed (a devDependency) and working
 * credentials (a `claude login`, or an API key with FAIRWAY_AUTH=api).
 */

import { claudeCodeRunner, type AuthMode } from "../src/adapters/claude-code.js";
import { drive } from "../test/harness.js";

const auth = (process.env.FAIRWAY_AUTH as AuthMode) || "inherit";
const model = process.env.FAIRWAY_MODEL || "claude-opus-4-8";

async function main() {
  console.log(`smoke: claude-code adapter — auth=${auth}, model=${model}`);
  const runner = claudeCodeRunner({ auth, model, maxTurns: 2, permissionMode: "bypassPermissions" });

  const { emitted, result, error } = await drive(runner, {
    userContent: "Reply with exactly: smoke ok",
  });

  console.log("emitted:", emitted.map((e) => e.type).join(" -> "));
  console.log("content:", JSON.stringify(result?.content));

  const problems: string[] = [];
  if (error) problems.push(`runner threw: ${error.message}`);
  if (!emitted.some((e) => e.type === "text" || e.type === "text_block"))
    problems.push("no text emitted");
  if (!result?.content) problems.push("empty result content");
  const seqs = emitted.map((e) => e.seq);
  if (seqs.some((s, i) => i > 0 && s <= seqs[i - 1])) problems.push("seq not monotonic");

  if (problems.length) {
    console.error("SMOKE FAILED:", problems.join("; "));
    process.exit(1);
  }
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e?.message ?? e);
  process.exit(1);
});
