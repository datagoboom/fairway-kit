/** HTTP surface (PROTOCOL.md 11) as a framework-agnostic node:http handler.
 * Returns true if it handled the request (matched a route under `prefix`), so
 * it composes: standalone via http.createServer, or `app.use(prefix, handler)`
 * in Express (Express req/res are node req/res). */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@fairway-kit/protocol";
import type { JobRegistry } from "./jobs.js";
import type { Runner, TurnContext } from "@fairway-kit/agent";
import type { Store } from "./store.js";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface RouterDeps {
  store: Store;
  registry: JobRegistry;
  runner: Runner;
  prefix?: string;
  /** Directory for uploaded files. Omit to disable attachments (uploads 400). */
  attachmentsDir?: string;
}

type Req = IncomingMessage;
type Res = ServerResponse;

export function createHandler(deps: RouterDeps): (req: Req, res: Res) => Promise<boolean> {
  const { store, registry, runner } = deps;
  const prefix = deps.prefix ?? "/api/chat";
  const attachmentsDir = deps.attachmentsDir ? resolve(deps.attachmentsDir) : null;

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
      if ((m = path.match(/^\/sessions\/([^/]+)$/)) && method === "PATCH") {
        if (!(await store.getSession(m[1]))) return json(res, 404, err("session not found"));
        const body = await readJson(req);
        return json(res, 200, { session: await store.renameSession(m[1], (body.name as string) ?? "") });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/messages$/)) && method === "GET") {
        if (!(await store.getSession(m[1]))) return json(res, 404, err("session not found"));
        return json(res, 200, { messages: await store.listMessages(m[1]) });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/active-job$/)) && method === "GET") {
        const job = await store.activeJobForSession(m[1]);
        return json(res, 200, job ? { job_id: job.id, status: job.status } : { job_id: null });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/attachments$/)) && method === "POST") {
        return await handleUpload(m[1]);
      }
      if ((m = path.match(/^\/attachments\/([^/]+)$/)) && method === "GET") {
        return await handleServeAttachment(m[1]);
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
      if (res.writableEnded) return true;
      return json(res, 500, err(String((e as Error)?.message ?? e)));
    }

    async function handleSend(sessionId: string): Promise<boolean> {
      const session = await store.getSession(sessionId);
      if (!session) return json(res, 404, err("session not found"));
      const active = await store.activeJobForSession(sessionId);
      if (active) return json(res, 409, { error: { code: 409, active_job_id: active.id } });

      const body = await readJson(req);
      const content = typeof body.content === "string" ? body.content : "";

      // Resolve attachment references (uploaded earlier) into full records;
      // runners get absolute paths, persisted messages keep the public shape.
      const refs = Array.isArray(body.attachments) ? (body.attachments as Record<string, unknown>[]) : [];
      const resolved: Record<string, unknown>[] = [];
      for (const ref of refs) {
        const att = await store.getAttachment(String(ref?.id ?? ""));
        if (!att || att.session_id !== sessionId)
          return json(res, 400, err(`unknown attachment: ${ref?.id}`));
        resolved.push(att);
      }
      const publicRefs = resolved.map((a) => ({
        id: a.id,
        name: a.name,
        media_type: a.media_type,
        size: a.size,
      }));
      const runnerAttachments =
        attachmentsDir === null
          ? []
          : resolved.map((a, i) => ({
              ...publicRefs[i],
              path: join(attachmentsDir, a.path as string),
            }));

      // PROTOCOL.md 7 send ordering: history snapshot, user row, streaming
      // assistant row, job row - all durable before we respond or start the runner.
      const history = await store.listMessages(sessionId);
      const userMessageId = await store.addMessage(sessionId, "user", content, {
        attachments: publicRefs.length ? publicRefs : null,
      });
      const assistantMessageId = await store.addMessage(sessionId, "assistant", "", { streaming: true });
      const jobId = await store.createJob(sessionId);

      const ctx: TurnContext = {
        session,
        messages: history,
        userContent: content,
        userMessageId,
        assistantMessageId,
        jobId,
        attachments: runnerAttachments,
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

    async function handleUpload(sessionId: string): Promise<boolean> {
      if (attachmentsDir === null) return json(res, 400, err("attachments are not enabled on this server"));
      if (!(await store.getSession(sessionId))) return json(res, 404, err("session not found"));
      let file: { data: Buffer; filename: string; mimeType: string };
      try {
        file = await readMultipartFile(req, MAX_ATTACHMENT_BYTES);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        return json(res, msg === "attachment too large" ? 413 : 400, err(msg));
      }
      const name = (file.filename || "file").replace(/[^\w.\- ]/g, "_").slice(0, 120) || "file";
      const suffix = extname(name).slice(0, 16);
      const blobName = `${randomUUID().replace(/-/g, "")}${suffix}`;
      await mkdir(attachmentsDir, { recursive: true });
      await writeFile(join(attachmentsDir, blobName), file.data);
      const rec = await store.addAttachment(
        sessionId,
        name,
        file.mimeType || "application/octet-stream",
        file.data.length,
        blobName,
      );
      return json(res, 201, rec);
    }

    async function handleServeAttachment(attachmentId: string): Promise<boolean> {
      const att = await store.getAttachment(attachmentId);
      if (!att || attachmentsDir === null) return json(res, 404, err("attachment not found"));
      // att.path is a uuid blob name we generated; still resolve-and-confine so a
      // tampered row can't escape the attachments directory.
      const full = resolve(join(attachmentsDir, att.path as string));
      if (full !== attachmentsDir && !full.startsWith(attachmentsDir + "/"))
        return json(res, 404, err("attachment not found"));
      let size: number;
      try {
        const st = await stat(full);
        if (!st.isFile()) return json(res, 404, err("attachment file missing"));
        size = st.size;
      } catch {
        return json(res, 404, err("attachment file missing"));
      }
      // Content-Disposition: attachment forces download (uploaded HTML/SVG can't
      // render inline); nosniff stops the browser second-guessing the media type.
      res.writeHead(200, {
        "Content-Type": (att.media_type as string) || "application/octet-stream",
        "Content-Length": size,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(att.name as string)}"`,
        "X-Content-Type-Options": "nosniff",
      });
      await new Promise<void>((done, fail) => {
        const rs = createReadStream(full);
        rs.on("error", fail);
        rs.on("end", () => done());
        rs.pipe(res);
      });
      return true;
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

/** Read the first file field of a multipart/form-data body (the client uploads a
 * single `file` field). Rejects with "attachment too large" past `maxBytes`. */
function readMultipartFile(
  req: Req,
  maxBytes: number,
): Promise<{ data: Buffer; filename: string; mimeType: string }> {
  return new Promise((resolveP, reject) => {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.includes("multipart/form-data")) return reject(new Error("expected multipart/form-data"));
    // Import lazily so the dependency only loads on the upload path.
    void import("busboy")
      .then(({ default: Busboy }) => {
        const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes } });
        let settled = false;
        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          req.unpipe(bb);
          reject(e);
        };
        let got = false;
        bb.on("file", (_name, stream, info) => {
          got = true;
          const chunks: Buffer[] = [];
          stream.on("data", (d: Buffer) => chunks.push(d));
          stream.on("limit", () => fail(new Error("attachment too large")));
          stream.on("end", () => {
            if (settled) return;
            settled = true;
            resolveP({ data: Buffer.concat(chunks), filename: info.filename, mimeType: info.mimeType });
          });
        });
        bb.on("close", () => {
          if (!got && !settled) {
            settled = true;
            reject(new Error("no file field in upload"));
          }
        });
        bb.on("error", (e: unknown) => fail(e as Error));
        req.pipe(bb);
      })
      .catch(() => reject(new Error('attachments need the "busboy" package: npm install busboy')));
  });
}
