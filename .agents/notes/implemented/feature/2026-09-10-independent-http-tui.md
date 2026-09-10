# Agent Note: Independent HTTP terminal client

Status: implemented

## Problem

Terminal users need to select existing host workspaces and sessions without launching another agent process or coupling the client to Harness workspace packages.

## Decision

This repository owns a Node.js/Ink executable and a reusable HTTP client. The host remains a separately launched service. Workspace listing consumes the first mux baseline; session listing uses the unary endpoint. Host parameter names remain explicit in every request. A reconnect replaces baseline state and never replays a user mutation.

## Alternatives considered

Reusing Cordis client services couples installation and startup to Harness composition. Rust improves native distribution but duplicates more protocol and terminal integration work. Python adds a runtime ecosystem that the requested Node.js implementation does not need. A separate Git repository keeps dependency installation and release history independent.

## Consequences

The adapter must track pre-stable host wire changes. Cookies exist only in memory, and unknown waterfalls delegate rather than blocking the host. The tests cover local HTTP/WS transport, user selection, command subprocesses, and recorded transcript projection; they do not claim live model-provider coverage. No existing decision record in this independent repository is superseded.
