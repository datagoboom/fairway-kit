/**
 * ChatInput — optional companion composer. Owns the send/streaming/stop state
 * machine; apps that want a custom composer use useChatContext() instead and
 * skip this entirely.
 *
 * Headless: layout-only inline styles, data-* attributes for CSS.
 */

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { useChatContext } from "./context";

export interface ChatInputProps {
  placeholder?: string;
  autoFocus?: boolean;
  /** Show a Stop button while a turn is streaming (default true). */
  stopButton?: boolean;
  /** Called after a successful send. */
  onSent?: (text: string) => void;
  /** Called when send throws (409s already trigger reattach internally). */
  onError?: (err: unknown) => void;
  sendLabel?: ReactNode;
  stopLabel?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function ChatInput({
  placeholder = "Message the agent",
  autoFocus,
  stopButton = true,
  onSent,
  onError,
  sendLabel = "Send",
  stopLabel = "Stop",
  className,
  style,
}: ChatInputProps) {
  const { send, stop, streaming } = useChatContext();
  const [text, setText] = useState("");
  const disabled = streaming;

  const submit = useCallback(() => {
    const t = text.trim();
    if (!t || disabled) return;
    setText("");
    void send(t)
      .then(() => onSent?.(t))
      .catch((err) => onError?.(err));
  }, [text, disabled, send, onSent, onError]);

  return (
    <div data-fairway-input="" className={className} style={{ display: "flex", width: "100%", ...style }}>
      <input
        data-fairway-input-field=""
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
        disabled={disabled}
        style={{ flex: 1, minWidth: 0 }}
      />
      {streaming && stopButton ? (
        <button type="button" data-fairway-stop="" onClick={() => void stop()}>
          {stopLabel}
        </button>
      ) : (
        <button type="button" data-fairway-send="" onClick={submit} disabled={disabled || !text.trim()}>
          {sendLabel}
        </button>
      )}
    </div>
  );
}
