# Contributing

Thanks for your interest. A few things to know before opening a PR.

## Scope

fairway is deliberately a dev kit for local, single-user, agent-backed apps.
Features that push it toward production chat infrastructure (multi-tenant
auth, horizontal scaling, external databases) are out of scope and will be
declined kindly. Bug fixes, protocol implementations in new languages, adapter
improvements, and UI component work are all welcome.

## Layout

```
protocol/         JSON Schema for the event union + shared fold conformance vectors
python/           fairway-kit on PyPI (import fairway): FastAPI backend
js/packages/
  protocol/       @fairway-kit/protocol - wire events + fold (shared with the client)
  agent/          @fairway-kit/agent - Runner contract, the adapter toolkit, shipped adapters
  server/         @fairway-kit/server - durable event log, job registry, HTTP handler
  client/         @fairway-kit/client - SSE/REST client + React components
js/recipes/       copy-paste adapter recipes (not published; CI-typechecked)
examples/         full example app used for live verification
```

The wire protocol is the spine. Both language implementations are pinned by
`protocol/fold-vectors.json`, which both test suites run. If you change fold
behavior, change the vectors and both implementations together.

## Developing

```sh
# backend
cd python && uv sync && uv run pytest

# frontend
cd js && npm install && npm test && npm run typecheck

# example app (consumes the libraries from source)
cd examples/chat && cat README.md
```

CI runs both suites, both typechecks, the dist build, the recipe typechecks +
mapping tests, and an example typecheck. Please make sure all of it passes
locally before opening a PR.

## Adapters: ship = dogfood

fairway is agent-agnostic through one seam - the `Runner`
(`(ctx, emit) => TurnResult`). `@fairway-kit/agent` is the toolkit for building
runners; adapters map a framework's stream onto the normalized `AgentEvent`
union and hand it to `runnerFromStream`.

We deliberately ship **very few** adapters, because a shipped adapter is a
standing promise of correctness that only live use can keep - and no one can
maintain live, credentialed CI across every framework. So the rule is:

> **Ship an adapter only if a maintainer dogfoods it.** Dogfooding is the
> sustainable substitute for a live test suite: if you *run* it, you *are* the
> reality check. Everything else is a recipe.

Concretely:
- **Shipped** (in `js/packages/agent`): the Claude Code adapter. Mapping-tested
  with a fake stream, plus a manual `npm run smoke:claude -w @fairway-kit/agent`
  you run against the real SDK before a release.
- **Recipe** (in `js/recipes`): everything else - a copy-paste file, typechecked
  against the framework's real types and mapping-tested with a self-contained
  harness, but *not* a guarantee. The copier verifies it against their provider.

A PR that adds `@fairway-kit/agent/<your-framework>` will be redirected to a
recipe unless a maintainer commits to running it. This isn't a knock on the
adapter - it's how we keep every shipped promise honest.

## Invariants

The README lists the guarantees the libraries make (write-ahead event logs,
single durability class, fold idempotence, restart safety). Changes that
weaken one of these need a very good argument and a protocol version bump, not
just passing tests.
