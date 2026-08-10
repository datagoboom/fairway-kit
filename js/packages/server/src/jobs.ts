/** Job registry: pub/sub fan-out over the write-ahead event log, replay-then-
 * tail SSE, terminal ordering, stop escalation, permission broker, startup
 * orphan sweep, and post-terminal compaction. Ports Python jobs.py.
 *
 * JS has no promise cancellation, so "hard cancel" is cooperative-plus-forced:
 * abort the signal (a well-behaved runner stops), and after a grace window
 * force the terminal event and mark the job finished so any still-running
 * runner's later emits become no-ops. Either way the job always reaches a
 * terminal event (PROTOCOL.md 4.4). */

import { foldAll, isTerminal } from "@fairway-kit/protocol";
import * as E from "./events.js";
import { finalText, Store } from "./store.js";
import type { Emit, Runner, StampedEvent, TurnContext } from "./types.js";

const HEARTBEAT_MS = 20_000;
const STOP_GRACE_MS = 5_000;
const FLUSH_INTERVAL_MS_DEFAULT = 0;

/** One SSE subscriber: push events in, pull them out with a heartbeat timeout. */
class Subscriber {
  private queued: StampedEvent[] = [];
  private waiter: ((v: StampedEvent | null) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  push(ev: StampedEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      if (this.timer) clearTimeout(this.timer);
      w(ev);
    } else {
      this.queued.push(ev);
    }
  }
  /** Resolves with the next event, or null after `timeoutMs` (a heartbeat). */
  next(timeoutMs: number): Promise<StampedEvent | null> {
    if (this.queued.length) return Promise.resolve(this.queued.shift()!);
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
    });
  }
}

class LiveJob {
  subscribers = new Set<Subscriber>();
  ctx: TurnContext | null = null;
  gracefulStop: (() => Promise<void>) | null = null;
  emitted: StampedEvent[] = [];
  pendingPermissions = new Map<string, (decision: string) => void>();
  abort = new AbortController();
  finished = false;
  constructor(public jobId: string) {}
}

export class JobRegistry {
  private live = new Map<string, LiveJob>();

  constructor(
    private store: Store,
    private opts: { stopGraceMs?: number; flushInterval?: number } = {},
  ) {}

  // -- startup sweep -------------------------------------------------------

  async startupSweep(): Promise<void> {
    for (const job of await this.store.orphanedRunningJobs()) {
      const jobId = job.id as string;
      const evs = await this.store.getEvents(jobId);
      const start = evs.find((e) => e.type === "message_start");
      let messageId: string | null = (start?.message_id as string) ?? null;
      if (messageId) {
        const items = foldAll(evs);
        const content = finalText(evs);
        if (content || items.some((i) => i.type === "tool")) {
          await this.store.finalizeAssistant(messageId, content, evs);
        } else {
          await this.store.deleteMessage(messageId);
          messageId = null;
        }
      }
      await this.store.setJobStatus(jobId, "error");
      await this.store.appendEvent(jobId, E.errorEvent("server restarted", messageId ?? undefined));
    }
  }

  // -- run -----------------------------------------------------------------

  start(ctx: TurnContext, runner: Runner): void {
    const live = new LiveJob(ctx.jobId);
    live.ctx = ctx;
    (ctx as { signal: AbortSignal }).signal = live.abort.signal;
    this.live.set(ctx.jobId, live);
    void this.run(live, ctx, runner);
  }

  private async run(live: LiveJob, ctx: TurnContext, runner: Runner): Promise<void> {
    const jobId = ctx.jobId;
    const flushInterval = this.opts.flushInterval ?? FLUSH_INTERVAL_MS_DEFAULT;
    let lastFlush = 0;

    const emit: Emit = async (ev) => {
      E.validate(ev);
      if (E.isTerminal(ev as never))
        throw new Error("runners must not emit terminal events; return TurnResult");
      const stamped = await this.store.appendEvent(jobId, ev as Record<string, unknown>);
      if (live.finished) return stamped; // forced-cancel already terminated the job
      live.emitted.push(stamped);
      const t = Date.now();
      if (flushInterval <= 0 || t - lastFlush >= flushInterval) {
        lastFlush = t;
        await this.store.flushAssistant(ctx.assistantMessageId, finalText(live.emitted), live.emitted);
      }
      this.fanOut(live, stamped);
      return stamped;
    };

    ctx.gracefulStop = undefined;
    ctx.newProviderSessionId = null;

    // Permission broker (PROTOCOL.md, Permissions).
    (ctx as unknown as { requestPermission: unknown }).requestPermission = async (opt: {
      tool: string;
      kind?: string;
      label?: string;
      detail?: string;
      input?: Record<string, unknown>;
    }): Promise<string> => {
      const allowed = await this.store.getAllowedTools(ctx.session.id as string);
      if (allowed.has(opt.tool)) return "allow";
      const requestId = randomId();
      const decision = new Promise<string>((resolve) => live.pendingPermissions.set(requestId, resolve));
      await emit(
        E.permissionRequest(requestId, opt.tool, opt.kind ?? "unknown", opt.label ?? opt.tool, opt.detail, opt.input),
      );
      const chosen = await decision; // indefinite hold
      live.pendingPermissions.delete(requestId);
      await emit(E.permissionResolved(requestId, chosen as never));
      if (chosen === "allow_session") await this.store.addAllowedTool(ctx.session.id as string, opt.tool);
      return chosen;
    };

    try {
      await emit(E.messageStart(ctx.assistantMessageId));
      const result = await runner(ctx, emit);
      await this.finish(live, ctx, E.done(ctx.assistantMessageId, result.reason), result.content || finalText(live.emitted), "done");
    } catch (err) {
      if (live.abort.signal.aborted) {
        await this.finish(live, ctx, E.cancelled(ctx.assistantMessageId), finalText(live.emitted), "cancelled");
      } else {
        await this.finish(live, ctx, E.errorEvent(String((err as Error)?.message ?? err), ctx.assistantMessageId), finalText(live.emitted), "error");
      }
    } finally {
      for (const resolve of live.pendingPermissions.values()) resolve("deny");
      live.pendingPermissions.clear();
      if (ctx.newProviderSessionId) await this.store.setProviderSessionId(ctx.session.id as string, ctx.newProviderSessionId);
      this.live.delete(jobId);
    }
  }

  private async finish(
    live: LiveJob,
    ctx: TurnContext,
    terminalEv: Record<string, unknown>,
    content: string,
    status: string,
  ): Promise<void> {
    if (live.finished) return;
    live.finished = true;
    // Ordering (PROTOCOL.md 7): finalize row -> job status -> terminal event.
    await this.store.finalizeAssistant(ctx.assistantMessageId, content, live.emitted);
    await this.store.setJobStatus(ctx.jobId, status);
    // Compaction before the terminal event so every replay sees the same log.
    try {
      await this.store.deleteEventsBySeq(ctx.jobId, compactableDeltaSeqs(live.emitted));
    } catch {
      /* durable copy is events_json; safe to skip */
    }
    const stamped = await this.store.appendEvent(ctx.jobId, terminalEv);
    this.fanOut(live, stamped);
  }

  private fanOut(live: LiveJob, stamped: StampedEvent): void {
    for (const sub of live.subscribers) sub.push(stamped);
  }

  // -- streaming -----------------------------------------------------------

  async *stream(jobId: string, since = 0): AsyncGenerator<StampedEvent | null> {
    const live = this.live.get(jobId);
    const sub = live ? new Subscriber() : null;
    if (live && sub) live.subscribers.add(sub);
    try {
      let lastSeq = since;
      for (const ev of await this.store.getEvents(jobId, since)) {
        lastSeq = Math.max(lastSeq, ev.seq);
        yield ev;
        if (isTerminal(ev)) return;
      }
      if (!sub) return; // not live: the log already has the terminal (sweep/finish appended it)
      for (;;) {
        const ev = await sub.next(HEARTBEAT_MS);
        if (ev === null) {
          yield null; // heartbeat
          continue;
        }
        if (ev.seq <= lastSeq) continue; // already replayed
        lastSeq = ev.seq;
        yield ev;
        if (isTerminal(ev)) return;
      }
    } finally {
      if (live && sub) live.subscribers.delete(sub);
    }
  }

  // -- stop + permissions --------------------------------------------------

  async stop(jobId: string): Promise<string> {
    const live = this.live.get(jobId);
    if (!live) {
      const job = await this.store.getJob(jobId);
      return (job?.status as string) ?? "unknown";
    }
    for (const resolve of live.pendingPermissions.values()) resolve("deny");
    const graceful = live.gracefulStop ?? live.ctx?.gracefulStop;
    if (graceful) {
      try {
        await graceful();
      } catch {
        /* ignore */
      }
    }
    live.abort.abort();
    const grace = this.opts.stopGraceMs ?? STOP_GRACE_MS;
    setTimeout(() => {
      const l = this.live.get(jobId);
      if (l && !l.finished && l.ctx) {
        void this.finish(l, l.ctx, E.cancelled(l.ctx.assistantMessageId), finalText(l.emitted), "cancelled");
      }
    }, grace);
    return "stopping";
  }

  registerGracefulStop(jobId: string, fn: () => Promise<void>): void {
    const live = this.live.get(jobId);
    if (live) live.gracefulStop = fn;
  }

  resolvePermission(jobId: string, requestId: string, decision: string): boolean {
    const live = this.live.get(jobId);
    const resolve = live?.pendingPermissions.get(requestId);
    if (!resolve) return false;
    live!.pendingPermissions.delete(requestId);
    resolve(decision);
    return true;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Seqs of text deltas a text_block fully supersedes (PROTOCOL.md 6). Deleting
 * exactly these cannot change fold output. Ports Python compactable_delta_seqs. */
export function compactableDeltaSeqs(events: StampedEvent[]): number[] {
  const compactable: number[] = [];
  let run: number[] = [];
  const pendingPerms = new Set<string>();
  for (const ev of events) {
    const t = ev.type;
    if (t === "text") run.push(ev.seq);
    else if (t === "text_block") {
      compactable.push(...run);
      run = [];
    } else if (t === "message_start") continue;
    else if (t === "permission_resolved" && pendingPerms.has(ev.id as string)) {
      pendingPerms.delete(ev.id as string); // matched resolution keeps the run
    } else {
      if (t === "permission_request") pendingPerms.add(ev.id as string);
      run = [];
    }
  }
  return compactable;
}
