/**
 * SSE stream client (PROTOCOL.md sections 6, 11).
 *
 * fetch() + ReadableStream (not EventSource) for AbortController support.
 * Tracks the highest seq seen and auto-reconnects with ?since= — dedupe is
 * inherent (server only sends seq > since). One bad frame is skipped, never fatal.
 */

import { type ChatEvent, isTerminal } from "@fairway-kit/protocol";

export interface StreamOptions {
  since?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Reconnect on network drop until a terminal event arrives. Default true. */
  reconnect?: boolean;
  maxReconnectDelayMs?: number;
  /** Liveness watchdog: if no bytes (data or heartbeat) arrive for this long,
   * the connection is presumed dead and torn down for a reconnect. The server
   * heartbeats every 20s, so the default (45s) tolerates one lost beat.
   * Guards against half-open sockets that never EOF (dev proxies, sleep/wake,
   * NAT timeouts) — without it a killed server can hang the reader forever. */
  staleMs?: number;
  onEvent: (ev: ChatEvent) => void;
  onConnectionChange?: (state: "connecting" | "open" | "reconnecting" | "closed") => void;
}

export interface StreamHandle {
  /** Resolves with the terminal event, or null if aborted before one arrived. */
  done: Promise<ChatEvent | null>;
  abort: () => void;
}

export function streamJob(baseUrl: string, jobId: string, opts: StreamOptions): StreamHandle {
  const controller = new AbortController();
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const fetchFn: typeof fetch = opts.fetchFn ?? ((...args) => fetch(...args));
  const reconnect = opts.reconnect ?? true;
  const maxDelay = opts.maxReconnectDelayMs ?? 15_000;
  const staleMs = opts.staleMs ?? 45_000;

  let lastSeq = opts.since ?? 0;

  const done = (async (): Promise<ChatEvent | null> => {
    let attempt = 0;
    for (;;) {
      opts.onConnectionChange?.(attempt === 0 ? "connecting" : "reconnecting");
      // Per-attempt controller so the staleness watchdog can kill one dead
      // connection without ending the whole stream.
      const attemptCtrl = new AbortController();
      const onOuterAbort = () => attemptCtrl.abort();
      controller.signal.addEventListener("abort", onOuterAbort, { once: true });
      let lastByteAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > staleMs) attemptCtrl.abort();
      }, Math.min(5_000, staleMs));
      try {
        const resp = await fetchFn(`${baseUrl}/jobs/${jobId}/stream?since=${lastSeq}`, {
          signal: attemptCtrl.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);
        opts.onConnectionChange?.("open");
        attempt = 0;

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          lastByteAt = Date.now(); // heartbeats count — that's their job
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseFrame(frame);
            if (!ev) continue; // heartbeat comment or malformed frame
            if (ev.seq <= lastSeq) continue;
            lastSeq = ev.seq;
            opts.onEvent(ev);
            if (isTerminal(ev)) {
              attemptCtrl.abort(); // release the connection
              opts.onConnectionChange?.("closed");
              return ev;
            }
          }
        }
        // Server closed without a terminal event (e.g. deploy) — reconnect.
        throw new Error("stream ended without terminal event");
      } catch (err) {
        if (controller.signal.aborted) {
          opts.onConnectionChange?.("closed");
          return null;
        }
        if (!reconnect) {
          opts.onConnectionChange?.("closed");
          throw err;
        }
        attempt += 1;
        const delay = Math.min(maxDelay, 500 * 2 ** Math.min(attempt, 5));
        await sleep(delay, controller.signal);
        if (controller.signal.aborted) {
          opts.onConnectionChange?.("closed");
          return null;
        }
      } finally {
        clearInterval(watchdog);
        controller.signal.removeEventListener("abort", onOuterAbort);
      }
    }
  })();

  return { done, abort: () => controller.abort() };
}

/** Exported for tests. Returns null for comments/blank/malformed frames. */
export function parseFrame(frame: string): ChatEvent | null {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try {
    const ev = JSON.parse(data) as ChatEvent;
    return typeof ev.seq === "number" && typeof ev.type === "string" ? ev : null;
  } catch {
    return null; // skip the frame, never kill the connection
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}
