/**
 * ChatInput - optional companion composer. Owns the send/streaming/stop state
 * machine and (optionally) file attachments; apps that want a custom composer
 * use useChatContext() instead and skip this entirely.
 *
 * Headless: layout-only inline styles, data-* attributes for CSS.
 */

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useChatContext } from "./context.js";

export interface ChatInputProps {
  placeholder?: string;
  autoFocus?: boolean;
  /** Show a Stop button while a turn is streaming (default true). */
  stopButton?: boolean;
  /** Enable the file-attach button (default true; requires server support). */
  attachments?: boolean;
  /** Called after a successful send. */
  onSent?: (text: string) => void;
  /** Called when send/upload throws (409s already trigger reattach internally). */
  onError?: (err: unknown) => void;
  sendLabel?: ReactNode;
  stopLabel?: ReactNode;
  attachLabel?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function ChatInput({
  placeholder = "Message the agent",
  autoFocus,
  stopButton = true,
  attachments = true,
  onSent,
  onError,
  sendLabel = "Send",
  stopLabel = "Stop",
  attachLabel = "Attach",
  className,
  style,
}: ChatInputProps) {
  const { client, sessionId, send, stop, streaming } = useChatContext();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const disabled = streaming || busy;

  const submit = useCallback(() => {
    const t = text.trim();
    if ((!t && files.length === 0) || disabled || !client || !sessionId) return;
    const pending = files;
    setText("");
    setFiles([]);
    setBusy(true);
    void (async () => {
      const refs = [];
      for (const f of pending) {
        refs.push(await client.uploadAttachment(sessionId, f));
      }
      await send(t, refs.length > 0 ? refs : undefined);
      onSent?.(t);
    })()
      .catch((err) => {
        setText(t);
        setFiles(pending);
        onError?.(err);
      })
      .finally(() => setBusy(false));
  }, [text, files, disabled, sessionId, client, send, onSent, onError]);

  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list)]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div data-fairway-input="" className={className} style={{ display: "flex", flexDirection: "column", width: "100%", ...style }}>
      {files.length > 0 && (
        <div data-fairway-pending-attachments="">
          {files.map((f, i) => (
            <span key={i} data-fairway-pending-attachment="">
              {f.name}
              <button
                type="button"
                data-fairway-remove-attachment=""
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
              >
                remove
              </button>
            </span>
          ))}
        </div>
      )}
      <div data-fairway-input-row="" style={{ display: "flex", width: "100%" }}>
        {attachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => pickFiles(e.target.files)}
            />
            <button
              type="button"
              data-fairway-attach=""
              disabled={disabled || !sessionId}
              onClick={() => fileInputRef.current?.click()}
            >
              {attachLabel}
            </button>
          </>
        )}
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
          <button
            type="button"
            data-fairway-send=""
            onClick={submit}
            disabled={disabled || (!text.trim() && files.length === 0)}
          >
            {sendLabel}
          </button>
        )}
      </div>
    </div>
  );
}
