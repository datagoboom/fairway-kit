/**
 * @fairway-kit/server - the Node backend for the Agent Chat Protocol.
 *
 *   import { createAgentChat, EchoRunner } from "@fairway-kit/server";
 *   const chat = createAgentChat({ dbUrl: "./chat.db", runner: EchoRunner });
 *   await chat.start();                       // opens the store, runs the sweep
 *   http.createServer(chat.handler).listen(8500);   // or chat.listen(8500)
 *   // Express:  app.use(async (req, res, next) => { if (!await chat.handler(req, res)) next(); })
 *
 * Single-writer, SQLite by default; Postgres (postgres://, needs `pg`) and
 * MySQL (mysql://, needs `mysql2`) are drop-in via the db URL. A runner is any
 * async (ctx, emit) => TurnResult - build one with @fairway-kit/agent (or use
 * its claudeCodeRunner adapter), or drive it with any agent you like.
 */

import http from "node:http";
import { dirname, join, resolve } from "node:path";
import type { Runner } from "@fairway-kit/agent";
import { createHandler } from "./router.js";
import { JobRegistry } from "./jobs.js";
import { Store } from "./store.js";
import type { Backend } from "./types.js";

export interface CreateAgentChatOptions {
  runner: Runner;
  /** Database URL or SQLite path. Defaults to "./fairway.db". */
  dbUrl?: string;
  dbPath?: string;
  backend?: Backend;
  prefix?: string;
  /** On start, drop event logs of terminal jobs older than this (days). */
  retentionDays?: number | null;
  /** Min ms between mid-turn assistant-row flushes (0 = every event). */
  flushInterval?: number;
  /** Where uploaded files land (always local disk, independent of the database).
   * Defaults next to a SQLite file, else ./fairway-attachments. `null` disables
   * uploads entirely. */
  attachmentsDir?: string | null;
}

export interface AgentChat {
  store: Store;
  registry: JobRegistry;
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  start(): Promise<void>;
  close(): Promise<void>;
  listen(port: number, host?: string): Promise<http.Server>;
}

export function createAgentChat(opts: CreateAgentChatOptions): AgentChat {
  const target = opts.backend ?? opts.dbUrl ?? opts.dbPath ?? "./fairway.db";
  const store = new Store(target);
  const registry = new JobRegistry(store, { flushInterval: opts.flushInterval });
  const attachmentsDir =
    opts.attachmentsDir === undefined
      ? defaultAttachmentsDir(opts.dbUrl ?? opts.dbPath)
      : opts.attachmentsDir ?? undefined;
  const handler = createHandler({
    store,
    registry,
    runner: opts.runner,
    prefix: opts.prefix,
    attachmentsDir,
  });
  const retentionDays = opts.retentionDays === undefined ? 7 : opts.retentionDays;

  return {
    store,
    registry,
    handler,
    async start() {
      await store.open();
      await registry.startupSweep();
      if (retentionDays != null) await store.pruneTerminalEventLogs(retentionDays);
    },
    async close() {
      await store.close();
    },
    listen(port, host) {
      return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          void handler(req, res).then((handled) => {
            if (!handled && !res.writableEnded) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: "not found" } }));
            }
          });
        });
        server.listen(port, host, () => resolve(server));
      });
    },
  };
}

/** Uploads land on local disk regardless of the database. Default next to a
 * SQLite file (./chat.db -> ./chat-attachments), else ./fairway-attachments. */
function defaultAttachmentsDir(dbTarget: string | undefined): string {
  if (dbTarget && !dbTarget.includes("://")) {
    const dir = dirname(resolve(dbTarget));
    const stem = dbTarget.replace(/^.*\//, "").replace(/\.[^.]*$/, "") || "fairway";
    return join(dir, `${stem}-attachments`);
  }
  return resolve("fairway-attachments");
}

export { Store } from "./store.js";
export { JobRegistry, compactableDeltaSeqs } from "./jobs.js";
export { SQLiteBackend, PostgresBackend, MySQLBackend, backendFromUrl } from "./backends/index.js";
export type { Backend } from "./types.js";

// The Runner contract, event constructors, and the reference EchoRunner live in
// @fairway-kit/agent; re-export the essentials so a server user has them without
// a second import. Build runners (or reach for an adapter) from there.
export { EchoRunner, events } from "@fairway-kit/agent";
export type {
  Runner,
  TurnContext,
  TurnResult,
  Emit,
  Message,
  StampedEvent,
  PermissionRequest,
  PermissionOutcome,
} from "@fairway-kit/agent";
