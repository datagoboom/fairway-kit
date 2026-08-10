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
protocol/   JSON Schema for the event union + shared fold conformance vectors
python/     fairway-kit on PyPI (import fairway): FastAPI backend
js/         fairway-kit on npm: TypeScript client + React components
examples/   full example app used for live verification
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

CI runs both suites, both typechecks, the dist build, and an example
typecheck. Please make sure all of it passes locally before opening a PR.

## Invariants

The README lists the guarantees the libraries make (write-ahead event logs,
single durability class, fold idempotence, restart safety). Changes that
weaken one of these need a very good argument and a protocol version bump, not
just passing tests.
