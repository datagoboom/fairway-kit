/**
 * ChatProvider — the invisible glue between ChatPanel, ChatInput, and any
 * custom components. Renders nothing; runs useAgentChat (or adopts a
 * caller-supplied instance) and shares it via context.
 *
 *   <ChatProvider client={client} sessionId={id}>
 *     <ChatPanel />
 *     <ChatInput />
 *   </ChatProvider>
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AgentChatClient, Message } from "../client.js";
import { foldAll, type StreamItem } from "../fold.js";
import { useAgentChat, type UseAgentChatOptions } from "./useAgentChat.js";

export type ChatInstance = ReturnType<typeof useAgentChat>;

const ChatContext = createContext<ChatInstance | null>(null);

export interface ChatProviderProps extends UseAgentChatOptions {
  client?: AgentChatClient;
  sessionId?: string | null;
  /** Controlled mode: pass your own useAgentChat result instead of client/sessionId. */
  chat?: ChatInstance;
  children: ReactNode;
}

export function ChatProvider({ client, sessionId, chat, children, ...opts }: ChatProviderProps) {
  if (!chat && !client) {
    throw new Error("ChatProvider needs either `chat` (controlled) or `client` + `sessionId`");
  }
  // Branch is stable for the life of the provider (controlled vs uncontrolled),
  // so the conditional hook call is safe in practice; the null client path is
  // never taken when `chat` is absent (guarded above).
  const owned = useAgentChat(client!, chat ? null : (sessionId ?? null), opts);
  const value = chat ?? owned;
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatInstance {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used inside <ChatProvider>");
  return ctx;
}

// -- rows: the unified render model -------------------------------------------

/** One rendered row: a persisted message or the in-flight live overlay, already
 * reduced to fold items so consumers never touch raw events. */
export interface ChatRow {
  id: string;
  role: "user" | "assistant";
  items: StreamItem[];
  /** True only for the in-flight overlay row (replaced atomically on done). */
  live: boolean;
  /** True while the assistant is working without visibly typing — turn just
   * started, or a tool is running, or the model is between text runs. Render a
   * typing indicator after the items. */
  typing?: boolean;
  /** The persisted message, absent on the live row. */
  message?: Message;
}

/** Pure merge of the two render tracks — exported for tests and non-React use. */
export function buildRows(
  messages: Message[],
  liveItems: StreamItem[],
  streaming = false
): ChatRow[] {
  const rows: ChatRow[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    live: false,
    message: m,
    items:
      m.role === "assistant" && m.events
        ? foldAll(m.events)
        : [{ type: "text", content: m.content, open: false }],
  }));
  if (liveItems.length > 0 || streaming) {
    const last = liveItems[liveItems.length - 1];
    const activelyTyping =
      last !== undefined && (last.type === "text" || last.type === "thinking") && last.open;
    rows.push({
      id: "__live__",
      role: "assistant",
      live: true,
      items: liveItems,
      typing: streaming && !activelyTyping,
    });
  }
  return rows;
}

/** The merged, fold-reduced row list — persisted history plus the live overlay
 * (which appears as soon as a turn starts, before the first event arrives). */
export function useChatRows(): ChatRow[] {
  const { messages, liveItems, streaming } = useChatContext();
  return useMemo(() => buildRows(messages, liveItems, streaming), [messages, liveItems, streaming]);
}
