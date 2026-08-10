/**
 * ChatPanel — the messages viewport, and only that. Fills its containing
 * element (100% width/height), scrolls internally, sticks to the bottom while
 * streaming unless the user scrolls up, and renders the merged row list with
 * per-item-type components that can be overridden or nulled out.
 *
 * Headless: no visual styling beyond layout; every element carries stable
 * data-* attributes for CSS. Import "@fairway/client/react/styles.css" for a
 * ready-made look, or style [data-fairway-*] yourself.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { ChatEvent } from "../events";
import type { ErrorItem, StreamItem, TextItem, ToolItem } from "../fold";
import { useChatContext, useChatRows, type ChatRow } from "./context";

export interface ItemComponentProps<I extends StreamItem = StreamItem> {
  item: I;
  row: ChatRow;
}

/** Override map, keyed by fold item type — plus extension/unknown event types
 * (the `x_*` namespace), keyed by the opaque event's own `type`. `null` hides
 * that item type entirely. */
export interface ChatComponents {
  Text?: ComponentType<ItemComponentProps<TextItem>> | null;
  Thinking?: ComponentType<ItemComponentProps<TextItem>> | null;
  Tool?: ComponentType<ItemComponentProps<ToolItem>> | null;
  Error?: ComponentType<ItemComponentProps<ErrorItem>> | null;
  /** Working indicator shown while row.typing (default: bouncing dots). */
  Typing?: ComponentType<{ row: ChatRow }> | null;
  /** Renderers for opaque items, keyed by event type (e.g. "x_sync_hint").
   * (ComponentType<any> so the named keys above can have narrower props.) */
  [extensionEventType: string]: ComponentType<any> | null | undefined;
}

export interface ChatPanelProps {
  components?: ChatComponents;
  /** Render prop over merged rows; omit for the default message rendering. */
  children?: (row: ChatRow) => ReactNode;
  /** px from the bottom still counted as "at the bottom" (default 40). */
  stickThreshold?: number;
  /** Content of the jump-to-latest button (default "New messages"). */
  jumpLabel?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function ChatPanel({
  components,
  children,
  stickThreshold = 40,
  jumpLabel = "New messages",
  className,
  style,
}: ChatPanelProps) {
  const rows = useChatRows();
  const { streaming } = useChatContext();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  const [unseen, setUnseen] = useState(false);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= stickThreshold;
    stuckRef.current = atBottom;
    if (atBottom) setUnseen(false);
  }, [stickThreshold]);

  // Follow the stream while stuck; flag new content while scrolled up.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (stuckRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setUnseen(true);
    }
  }, [rows]);

  const jumpToLatest = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setUnseen(false);
  }, []);

  return (
    <div
      data-fairway-panel=""
      data-streaming={streaming || undefined}
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, ...style }}
    >
      <div
        ref={viewportRef}
        onScroll={onScroll}
        data-fairway-viewport=""
        style={{ width: "100%", height: "100%", overflowY: "auto" }}
      >
        {rows.map((row) =>
          children ? (
            <div key={row.id} style={{ display: "contents" }}>{children(row)}</div>
          ) : (
            <ChatMessage key={row.id} row={row} components={components} />
          )
        )}
      </div>
      {unseen && (
        <button
          type="button"
          data-fairway-jump=""
          onClick={jumpToLatest}
          style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}
        >
          {jumpLabel}
        </button>
      )}
    </div>
  );
}

// -- default message + item rendering -----------------------------------------

export const ChatMessage = memo(function ChatMessage({
  row,
  components,
}: {
  row: ChatRow;
  components?: ChatComponents;
}) {
  return (
    <div data-fairway-message="" data-role={row.role} data-live={row.live || undefined}>
      <div data-fairway-bubble="">
        {row.items.map((item, i) => (
          <ChatItem key={i} item={item} row={row} components={components} />
        ))}
        {row.typing && (() => {
          const C = pick(components?.Typing, TypingIndicator);
          return C && <C row={row} />;
        })()}
      </div>
    </div>
  );
});

export function ChatItem({
  item,
  row,
  components,
}: {
  item: StreamItem;
  row: ChatRow;
  components?: ChatComponents;
}) {
  switch (item.type) {
    case "text": {
      const C = pick(components?.Text, DefaultText);
      return C && <C item={item} row={row} />;
    }
    case "thinking": {
      const C = pick(components?.Thinking, DefaultThinking);
      return C && <C item={item} row={row} />;
    }
    case "tool": {
      const C = pick(components?.Tool, DefaultTool);
      return C && <C item={item} row={row} />;
    }
    case "error": {
      const C = pick(components?.Error, DefaultError);
      return C && <C item={item} row={row} />;
    }
    case "opaque": {
      const ev = item.event as ChatEvent;
      const C = components?.[ev.type];
      return C ? <C item={item} row={row} /> : null; // unknown types hidden by default
    }
  }
}

/** undefined -> default renderer; null -> hidden. */
function pick<P>(override: ComponentType<P> | null | undefined, fallback: ComponentType<P>) {
  return override === undefined ? fallback : override;
}

function DefaultText({ item }: ItemComponentProps<TextItem>) {
  return <div data-fairway-item="text" style={{ whiteSpace: "pre-wrap" }}>{item.content}</div>;
}

function DefaultThinking({ item }: ItemComponentProps<TextItem>) {
  return <div data-fairway-item="thinking" style={{ whiteSpace: "pre-wrap" }}>{item.content}</div>;
}

function DefaultTool({ item }: ItemComponentProps<ToolItem>) {
  return (
    <span data-fairway-item="tool" data-status={item.status} data-kind={item.kind}>
      <span data-fairway-tool-label="">{item.label ?? item.tool ?? item.id}</span>
      {item.detail && <span data-fairway-tool-detail="">{item.detail}</span>}
      {item.summary && <span data-fairway-tool-summary="">{item.summary}</span>}
    </span>
  );
}

function DefaultError({ item }: ItemComponentProps<ErrorItem>) {
  return <div data-fairway-item="error">{item.message}</div>;
}

/** Classic bouncing-dots working indicator; animation lives in styles.css
 * (or style [data-fairway-item="typing"] span yourself). Exported for reuse
 * inside custom bubbles. */
export function TypingIndicator(_props: { row: ChatRow }) {
  return (
    <div data-fairway-item="typing" aria-label="Assistant is working">
      <span />
      <span />
      <span />
    </div>
  );
}
