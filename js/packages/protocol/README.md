# @fairway-kit/protocol

The Agent Chat Protocol shared by [fairway](https://github.com/datagoboom/fairway-kit)
clients and servers: the event type union and the normative `fold` that reduces
an event stream into rendered chat items.

```ts
import { fold, foldAll, isTerminal, type ChatEvent, type StreamItem } from "@fairway-kit/protocol";

// The same fold is used for live streaming and for replaying a persisted turn,
// so what you render after a reconnect matches what you saw live.
const items: StreamItem[] = foldAll(events);
```

Pure and dependency-free - no React, no DOM, no HTTP. The fold is pinned by a
cross-language conformance vector set that both the TypeScript and Python
implementations run, so every client and server that builds on it renders
identically. Most apps get this transitively via
[`@fairway-kit/client`](https://www.npmjs.com/package/@fairway-kit/client); depend
on it directly when writing a server or a non-React frontend.

Full docs and the wire protocol live in the
[repository](https://github.com/datagoboom/fairway-kit).
