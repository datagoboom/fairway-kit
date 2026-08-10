# fairway-kit

The TypeScript half of [fairway](https://github.com/datagoboom/fairway-kit) — a
dev kit for building local, agent-backed applications with durable, resumable
chat.

```tsx
import { AgentChatClient } from "fairway-kit";
import { ChatProvider, ChatPanel, ChatInput } from "fairway-kit/react";
import "fairway-kit/react/styles.css"; // optional default look

const client = new AgentChatClient("/api/chat");

export function Chat({ sessionId }: { sessionId: string }) {
  return (
    <ChatProvider client={client} sessionId={sessionId}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel />
      </div>
      <ChatInput />
    </ChatProvider>
  );
}
```

Out of the box: token-level streaming, tool-call pills, inline tool-approval
cards, a typing indicator, stick-to-bottom scrolling, optimistic sends,
automatic reattach to in-flight responses on refresh, and stop. Headless
(stable `data-fairway-*` attributes, optional stylesheet), with per-item-type
render overrides and a framework-free core (`fold`, SSE stream client, REST
client). React is an optional peer dependency.

Pairs with the `fairway-kit` Python package (`import fairway`) on the backend.
Full docs, the wire protocol, and a complete example app live in the
[repository](https://github.com/datagoboom/fairway-kit).
