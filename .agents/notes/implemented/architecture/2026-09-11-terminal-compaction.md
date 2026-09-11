# Agent Note: Terminal compaction and narrow-screen reasoning

Status: implemented

## Problem

Terminal users need manual context compaction without submitting command text to the prompt queue. Active reasoning can occupy most of a narrow terminal before its completed block folds.

## Decision

`/compact` invokes `commands/execute` with the selected `agentId`, the exact command line, and empty `submittedAttachments`. The host owns idle checks and compaction. The terminal displays progress and the returned text; unknown commands, malformed replies, and error outcomes preserve the draft. The request has no ordinary RPC deadline because compaction can require a long model call. Caller cancellation and client close still abort the request. The client never retries the mutation automatically; a lost response leaves the host outcome uncertain.

Below 60 content columns (62 terminal columns), row-mode reasoning folds even while streaming. Explicit `/think live` expansion overrides this default until toggled or the assistant attempt changes. Wider terminals retain active expansion and completion folding. Width is already part of the history row cache identity, so resizing recomputes the display without changing retained reasoning text.

## Alternatives considered

Sending `/compact` as a prompt would enqueue model input instead of invoking the human command. Applying the ordinary 15-second timeout can lose a successful long-running command response. Expanding active reasoning at every width competes with the answer and input on mobile terminals.

## Consequences

The terminal needs the host command plugin and reports its absence. Command results are local feedback; durable command lifecycle cards are not yet rendered in terminal history. HTTP fixture tests cover outcomes, cancellation, and timeout overrides; history and UI tests cover width transitions and manual expansion. Mobile SSH rendering still requires device verification.
