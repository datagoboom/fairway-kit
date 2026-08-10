/** HTTP surface (PROTOCOL.md 11) as a framework-agnostic node:http handler.
 * Returns true if it handled the request (matched a route under `prefix`), so
 * it composes: standalone via http.createServer, or `app.use(prefix, handler)`
 * in Express (Express req/res are node req/res). */

import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_VERSION } from "@fairway-kit/protocol";
import type { JobRegistry } from "./jobs.js";
import type { Runner, TurnContext } from "./types.js";
import type { Store } from "./store.js";

export interface RouterDeps {
  store: Store;
  registry: JobRegistry;
  runner: Runner;
  prefix?: string;
}

type Req = IncomingMessage;
type Res = ServerResponse;

export function createHandler(deps: RouterDeps): (req: Req, res: Res) => Promise<boolean> {
  const { store, registry, runner } = deps;
  const prefix = deps.prefix ?? "/api/chat";

  return async function handle(req, res): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    let path = url.pathname;
    if (!path.startsWith(prefix)) return false;
    path = path.slice(prefix.length) || "/";
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/meta")
        return json(res, 200, { protocol_version: PROTOCOL_VERSION, extensions: [] });

      if (method === "POST" && path === "/sessions") {
        const body = await readJson(req);
        return json(res, 201, { session: await store.createSession((body.name as string) ?? null) });
      }
      if (method === "GET" && path === "/sessions")
        return json(res, 200, { sessions: await store.listSessions() });

      let m: RegExpMatchArray | null;
      if ((m = path.match(/^\/sessions\/([^/]+)$/)) && method === "DELETE") {
        await store.deleteSession(m[1]);
        res.writeHead(204).end();
        return true;
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/messages$/)) && method === "GET") {
        if (!(await store.getSession(m[1]))) return json(res, 404, err("session not found"));
        return json(res, 200, { messages: await store.listMessages(m[1]) });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/active-job$/)) && method === "GET") {
        const job = await store.activeJobForSession(m[1]);
        return json(res, 200, job ? { job_id: job.id, status: job.status } : { job_id: null });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/send$/)) && method === "POST") {
        return await handleSend(m[1]);
      }
      if ((m = path.match(/^\/jobs\/([^/]+)\/stream$/)) && method === "GET") {
        return await handleStream(m[1], Number(url.searchParams.get("since") ?? 0));
      }
      if ((m = path.match(/^\/jobs\/([^/]+)\/events$/)) && method === "GET") {
        const job = await store.getJob(m[1]);
        if (!job) return json(res, 404, err("job not found"));
        const evs = await store.getEvents(m[1], Number(url.searchParams.get("since") ?? 0));
        return json(res, 200, { events: evs, terminal: job.status !== "running" });
      }
      if ((m = path.match(/^\/jobs\/([^/]+)\/stop$/)) && method === "POST") {
        if (!(await store.getJob(m[1]))) return json(res, 404, err("job not found"));
        return json(res, 202, { status: await registry.stop(m[1]) });
      }
      if ((m = path.match(/^\/jobs\/([^/]+)\/permission$/)) && method === "POST") {
        if (!(await store.getJob(m[1]))) return json(res, 404, err("job not found"));
        const body = await readJson(req);
        if (!registry.resolvePermission(m[1], String(body.request_id), String(body.decision)))
          return json(res, 409, err("no such pending permission request"));
        return json(res, 200, { status: "resolved" });
      }
      return json(res, 404, err("not found"));
    } catch (e) {
      return json(res, 500, err(String((e as Error)?.message ?? e)));
    }

    async function handleSend(sessionId: string): Promise<boolean> {
      const session = await store.getSession(sessionId);
      if (!session) return json(res, 404, err("session not found"));
      const active = await store.activeJobForSession(sessionId);
      if (active) return json(res, 409, { error: { code: 409, active_job_id: active.id } });

      const body = await readJson(req);
      const content = typeof body.content === "string" ? body.content : "";
      const history = await store.listMessages(sessionId);
      const userMessageId = await store.addMessage(sessionId, "user", content);
      const assistantMessageId = await store.addMessage(sessionId, "assistant", "", { streaming: true });
      const jobId = await store.createJob(sessionId);

      const ctx: TurnContext = {
        session,
        messages: history,
        userContent: content,
        userMessageId,
        assistantMessageId,
        jobId,
        attachments: [],
        signal: new AbortController().signal, // replaced by registry.start
        providerSessionId: (session.provider_session_id as string) ?? null,
      };
      registry.start(ctx, runner);
      return json(res, 202, {
        job_id: jobId,
        user_message_id: userMessageId,
        assistant_message_id: assistantMessageId,
      });
    }

    async function handleStream(jobId: string, since: number): Promise<boolean> {
      if (!(await store.getJob(jobId))) return json(res, 404, err("job not found"));
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      for await (const ev of registry.stream(jobId, since)) {
        if (res.writableEnded) break;
        res.write(ev === null ? ": hb\n\n" : `data: ${JSON.stringify(ev)}\n\n`);
      }
      res.end();
      return true;
    }
  };
}

function json(res: Res, status: number, body: unknown): true {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
  return true;
}

function err(message: string) {
  return { error: { message } };
}

function readJson(req: Req): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
