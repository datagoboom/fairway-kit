/**
 * React hook implementing the client behaviors of PROTOCOL.md sections 6-7:
 * history load, active-job reattach on mount, optimistic send, live fold overlay,
 * deterministic done-handoff (fetch by message_id — no retry loops), stop.
 *
 * Rendering is the app's job: `messages` (persisted) + `liveItems` (in-flight
 * overlay) are the two tracks, concatenated in that order.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentChatClient, ConflictError, type Attachment, type Message } from "../client.js";
import { fold, type StreamItem } from "@fairway-kit/protocol";
import { streamJob } from "../stream.js";
import { isTerminal, type ChatEvent, type PermissionDecision } from "@fairway-kit/protocol";

export interface UseAgentChatOptions {
  /** Handler for x_* / unknown events (sync hints, viewer commands, ...). */
  onExtensionEvent?: (ev: ChatEvent) => void;
  onError?: (message: string) => void;
}

export function useAgentChat(
  client: AgentChatClient,
  sessionId: string | null,
  opts: UseAgentChatOptions = {}
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveItems, setLiveItems] = useState<StreamItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [connection, setConnection] = useState<
    "idle" | "connecting" | "open" | "reconnecting" | "closed"
  >("idle");

  const abortRef = useRef<(() => void) | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const CORE = new Set([
    "message_start",
    "text",
    "text_block",
    "thinking",
    "tool_call",
    "tool_result",
    "done",
    "error",
    "cancelled",
  ]);

  const attach = useCallback(
    (jobId: string, since = 0) => {
      abortRef.current?.();
      setActiveJobId(jobId);
      setStreaming(true);
      setLiveItems([]);
      const handle = streamJob(client.baseUrl, jobId, {
        since,
        onConnectionChange: setConnection,
        onEvent: (ev) => {
          if (!CORE.has(ev.type)) optsRef.current.onExtensionEvent?.(ev);
          setLiveItems((cur) => fold(cur, ev));
          if (isTerminal(ev)) {
            void handleTerminal(ev);
          }
        },
      });
      abortRef.current = handle.abort;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client]
  );

  const handleTerminal = useCallback(
    async (ev: ChatEvent) => {
      setStreaming(false);
      setActiveJobId(null);
      const messageId = (ev as { message_id?: string }).message_id;
      if (ev.type === "error") {
        optsRef.current.onError?.((ev as { message: string }).message);
      }
      // Deterministic handoff: PROTOCOL.md 7 guarantees the row is committed
      // before the terminal event, so one fetch suffices — retrying is a server bug.
      const sid = sessionRef.current;
      if (sid) {
        const { messages: fresh } = await client.listMessages(sid);
        if (sessionRef.current !== sid) return; // session switched mid-fetch
        if (messageId && !fresh.some((m) => m.id === messageId)) {
          optsRef.current.onError?.(
            `protocol violation: terminal event's message ${messageId} not readable`
          );
        }
        setMessages(fresh);
      }
      setLiveItems([]);
    },
    [client]
  );

  // One-time (per client) protocol handshake: warn on version skew.
  useEffect(() => {
    void client.checkProtocol().then((warning) => {
      if (warning) console.warn(warning);
    });
  }, [client]);

  // Mount / session switch: load history, then reattach to any running job.
  useEffect(() => {
    abortRef.current?.();
    setMessages([]);
    setLiveItems([]);
    setStreaming(false);
    setActiveJobId(null);
    if (!sessionId) return;
    let stale = false;
    void (async () => {
      const { messages: hist } = await client.listMessages(sessionId);
      if (stale) return;
      setMessages(hist);
      const { job_id } = await client.activeJob(sessionId);
      if (stale) return;
      if (job_id) attach(job_id); // full replay (since=0) folds from empty — idempotent
    })();
    return () => {
      stale = true;
      abortRef.current?.();
    };
  }, [client, sessionId, attach]);

  const send = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      if (!sessionId) throw new Error("no session selected");
      // Optimistic user message; replaced by the persisted row on terminal handoff.
      const optimistic: Message = {
        id: `optimistic-${Math.random().toString(36).slice(2)}`,
        session_id: sessionId,
        role: "user",
        content,
        events: null,
        streaming: false,
        attachments: attachments ?? null,
        created_at: new Date().toISOString(),
      };
      setMessages((cur) => [...cur, optimistic]);
      try {
        const res = await client.send(sessionId, content, attachments);
        attach(res.job_id);
        return res;
      } catch (err) {
        setMessages((cur) => cur.filter((m) => m.id !== optimistic.id));
        if (err instanceof ConflictError) {
          // Session already has a running job (another tab?) — reattach to it.
          if (err.activeJobId) attach(err.activeJobId);
        }
        throw err;
      }
    },
    [client, sessionId, attach]
  );

  const stop = useCallback(async () => {
    if (activeJobId) await client.stop(activeJobId);
    // No client-side force-unlock timer: PROTOCOL.md 9 guarantees a terminal
    // event within stop_grace, which unlocks via handleTerminal.
  }, [client, activeJobId]);

  const respondPermission = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      if (!activeJobId) throw new Error("no active job to resolve a permission for");
      await client.resolvePermission(activeJobId, requestId, decision);
    },
    [client, activeJobId]
  );

  return {
    client,
    sessionId,
    messages,
    liveItems,
    streaming,
    connection,
    activeJobId,
    send,
    stop,
    respondPermission,
  };
}
