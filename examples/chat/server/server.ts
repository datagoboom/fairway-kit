/**
 * Fairway example chat server — Node edition.
 *
 * The all-Node counterpart to server.py: the same protocol stack behind a real
 * agent, with a small settings API (GET/PUT /api/settings) that rebuilds the
 * runner live — a demonstration that a fairway runner is just a swappable async
 * callable. Uses @fairway-kit/server and its Claude adapter.
 *
 *   FAIRWAY_RUNNER=echo   start in offline echo mode (no credentials)
 *   FAIRWAY_AUTH=...       initial auth mode (inherit|subscription|api)
 *   FAIRWAY_MODEL=...      initial model
 *   FAIRWAY_DB=...         SQLite path or postgresql:// / mysql:// URL
 *   PORT=8500
 *
 *   npm install && FAIRWAY_RUNNER=echo npm run dev
 */

import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentChat, type Runner } from "@fairway-kit/server";
import { EchoRunner } from "@fairway-kit/agent";
import { claudeCodeRunner } from "@fairway-kit/agent/claude-code";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = process.env.FAIRWAY_SETTINGS ?? join(HERE, "fairway-example-settings.json");

const KNOWN_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch"];

const DEFAULT_SYSTEM_PROMPT =
  "You are Fairway's demo assistant. Be concise. You may read files in " +
  "your working directory and search the web when asked.";

interface Settings {
  runner: "claude" | "echo";
  model: string;
  auth: "inherit" | "subscription" | "api";
  permission_mode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  tools: string[];
  allowed_tools: string[];
  system_prompt: string;
  max_turns: number;
}

function defaults(): Settings {
  const s: Settings = {
    runner: "claude",
    model: "claude-opus-4-8",
    auth: "inherit",
    permission_mode: "default",
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    allowed_tools: ["Read", "Glob", "Grep"],
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    max_turns: 30,
  };
  if (process.env.FAIRWAY_RUNNER === "echo") s.runner = "echo";
  const auth = process.env.FAIRWAY_AUTH;
  if (auth === "inherit" || auth === "subscription" || auth === "api") s.auth = auth;
  if (process.env.FAIRWAY_MODEL) s.model = process.env.FAIRWAY_MODEL;
  return s;
}

/** Clamp/whitelist a settings object, dropping unknown tools and keeping the
 * pre-approved set a subset of the available set. */
function normalize(raw: Partial<Settings>): Settings {
  const merged = { ...defaults(), ...raw };
  const tools = (merged.tools ?? []).filter((t) => KNOWN_TOOLS.includes(t));
  return {
    ...merged,
    tools,
    allowed_tools: (merged.allowed_tools ?? []).filter((t) => tools.includes(t)),
    max_turns: Math.max(1, Math.min(300, Math.floor(merged.max_turns) || 30)),
  };
}

function loadSettings(): Settings {
  if (existsSync(SETTINGS_PATH)) {
    try {
      return normalize(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
    } catch {
      /* fall through to defaults on a corrupt file */
    }
  }
  return defaults();
}

function buildRunner(s: Settings): Runner {
  if (s.runner === "echo") return EchoRunner;
  return claudeCodeRunner({
    model: s.model,
    auth: s.auth,
    permissionMode: s.permission_mode,
    // Pre-approved tools run without asking; anything else in the available set
    // pauses on the inline gate; tools outside it are blocked entirely.
    allowedTools: s.allowed_tools,
    disallowedTools: KNOWN_TOOLS.filter((t) => !s.tools.includes(t)),
    maxTurns: s.max_turns,
    cwd: HERE,
    systemPrompt: () => s.system_prompt,
  });
}

// A fairway runner is just a function, so live reconfiguration is one swap.
// In-flight turns keep the runner they started with.
let settings = loadSettings();
let current = buildRunner(settings);
const runner: Runner = (ctx, emit) => current(ctx, emit);

const chat = createAgentChat({
  // FAIRWAY_DB accepts a SQLite path or a postgresql:// / mysql:// URL.
  dbUrl: process.env.FAIRWAY_DB ?? join(HERE, "fairway-example.db"),
  attachmentsDir: join(HERE, "fairway-example-attachments"),
  runner,
});

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // fairway owns /api/chat/*; it returns false for everything else.
  if (await chat.handler(req, res)) return;

  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/settings" && req.method === "GET") {
    return sendJson(res, 200, { settings, known_tools: KNOWN_TOOLS });
  }
  if (url.pathname === "/api/settings" && req.method === "PUT") {
    try {
      settings = normalize(JSON.parse(await readBody(req)));
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
      current = buildRunner(settings);
      return sendJson(res, 200, { settings, known_tools: KNOWN_TOOLS });
    } catch (e) {
      return sendJson(res, 400, { error: String((e as Error)?.message ?? e) });
    }
  }
  sendJson(res, 404, { error: { message: "not found" } });
});

await chat.start(); // opens the store, runs the startup orphan sweep
const port = Number(process.env.PORT ?? 8500);
server.listen(port, () => {
  const mode = settings.runner === "echo" ? "echo (offline)" : `claude (${settings.model})`;
  console.log(`fairway example server on http://localhost:${port} — runner: ${mode}`);
});
