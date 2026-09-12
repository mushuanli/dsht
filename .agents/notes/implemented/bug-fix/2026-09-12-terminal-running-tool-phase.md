# Agent Note: The bar names the tool that is executing, paused or not

Status: implemented

## Problem

While a long command ran, the status bar showed nothing about it. The phase — the tool name and its age — was derived from the assistant stream, and it exists only while that stream is delivering deltas: the host ends the stream when the assistant message is committed and runs the tool afterwards, so the phase was already cleared exactly when the interesting part began. The bar could therefore name a tool only during the few seconds the model spent writing the call. A second defect hid the same information in the other state the bar can be in: a paused bar dropped the phase group entirely, so a user who selected text to copy it — which turns copy mode on — saw `⏸ copy` and no answer to what the client was doing, with no way to tell a paused clock from a stall.

## Decision

The transcript answers what is running by reading the open turn's unanswered tool call. The host's `tool/call` event is not retained, because only user-visible content is, so the call is read from the assistant message that carried the tool-call block and the results that answer it; a call with no matching result is the one in flight, and the oldest unanswered call is the one that has been waiting longest. Its age starts at the message's time, which the retention step now keeps for every displayed event: a number per event is the price of being able to say when anything happened.

`livePhase` returns the streamed phase while the assistant is writing, and falls through to the running tool when the stream has ended, so every consumer keeps one definition. The paused bar keeps the phase: the pause reason already explains why the clock is not moving, and dropping the running tool removes the one fact the bar exists to report.

## Alternatives considered

Retaining the host's `tool/call` event was rejected: it carries the raw tool arguments, which for a shell command or a file write is exactly the payload the retention policy exists to keep out of client memory. Timing the tool from the turn's start was rejected because it reports the whole turn's age as the command's age. Recording arrival time on the client was rejected because it invents a second clock and would be wrong for events loaded from history. Continuing to show only the streamed phase was rejected because a long command is the case the bar is read for.

## Consequences

`tests/session/transcript.test.ts` covers a call in flight, two calls with the first answered, the phase following them, and a turn that ends with a call unanswered — the cancelled-tool case that only the turn ending clears. `tests/ui/app.test.tsx` renders the bar with a running tool and asserts `◐ 0:08 · bash 5s · ^C`, then asserts that the same phase survives `copy`, `dialog` and `history` pauses behind their reason. A bar with no open turn and no streamed phase still shows no phase rather than guessing.
