/**
 * Opt-in markdown Text renderer — subpath export so react-markdown is only
 * pulled in by apps that import "@fairway/client/react/markdown".
 *
 *   import { MarkdownText } from "@fairway/client/react/markdown";
 *   <ChatPanel components={{ Text: MarkdownText }} />
 *
 * Requires peer deps: react-markdown, remark-gfm.
 */

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ItemComponentProps } from "./ChatPanel";
import type { TextItem } from "../fold";

/** Memoized so streaming deltas only re-parse the item that's growing. */
export const MarkdownText = memo(function MarkdownText({ item }: ItemComponentProps<TextItem>) {
  return (
    <div data-fairway-item="text" data-markdown="">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
    </div>
  );
});
