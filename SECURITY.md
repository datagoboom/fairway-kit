# Security

fairway is a dev kit for locally run, single-user applications. It has no
authentication layer by design and should never be exposed to the public
internet. The threat model worth caring about is the agent itself: a local
agent runs with your filesystem and credentials, so read the "Running
write-capable agents on your own machine" section of the README before
enabling write tools.

## Reporting a vulnerability

If you find a security issue (for example: a way for the agent or a chat
participant to escape the configured tool boundary, path traversal in the
attachment endpoints, or a way to bypass the permission gate), please open a
GitHub security advisory on this repository rather than a public issue:

https://github.com/datagoboom/fairway-kit/security/advisories/new

Include steps to reproduce and the versions of both packages. You should hear
back within a week.
