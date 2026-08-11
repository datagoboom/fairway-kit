# fairway recipes

Copy-paste adapter recipes for [`@fairway-kit/agent`](../packages/agent). These
are **honest starting points, not shipped adapters** — fairway ships and
guarantees exactly one runner (the dogfooded `claude-code` adapter). Everything
else lives here: copy a recipe into your app, wire it to your provider, and
verify it against a real model.

Each recipe is:
- **~30 lines** — a `mapPart`/`start` that turns a framework's stream into the
  normalized `AgentEvent` union; `runnerFromStream` does the rest.
- **type-checked in CI** against the framework's real types (so field names are
  correct for the pinned version), and
- **mapping-tested** with a self-contained harness (no live model, no network) —
  the same conformance pattern that tests the shipped adapter.

What CI *can't* do is call the real provider for you. That's the one check you
own when you copy a recipe — which is exactly why these are recipes and not
shipped adapters (see [CONTRIBUTING](../../CONTRIBUTING.md): *ship = dogfood*).

## Recipes

| Recipe | Covers | Notes |
|---|---|---|
| [`ai-sdk`](./ai-sdk/ai-sdk.ts) | Vercel AI SDK → every provider it supports (Anthropic, OpenAI, Google, Mistral, Bedrock, Groq, Ollama, …) | Stateless: fairway feeds history each turn. Typed against `ai@5`. |

## Using one

```ts
// 1. install: npm i @fairway-kit/agent ai @ai-sdk/anthropic
// 2. copy recipes/ai-sdk/ai-sdk.ts into your project
import { anthropic } from "@ai-sdk/anthropic";
import { createAgentChat } from "@fairway-kit/server";
import { aiSdkRunner } from "./ai-sdk.js";

const chat = createAgentChat({
  dbUrl: "./chat.db",
  runner: aiSdkRunner({ model: anthropic("claude-opus-4-8") }),
});
```

Then run it against your provider and confirm the stream looks right. If a
future SDK version renames a field, the recipe's typecheck fails loudly — re-map
and you're done.
