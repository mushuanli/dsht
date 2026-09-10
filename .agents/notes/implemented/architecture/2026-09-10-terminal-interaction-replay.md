# Agent Note: Restore pending terminal interactions after reconnect

Status: implemented

## Problem

The gateway replays unresolved interactions immediately after its event-stream ready frame. The terminal previously declined any question or approval before the matching session was selected and released pending requests when opening a picker. The host could then settle the question with no answerer, turning a recoverable disconnect into a failed tool call.

## Decision

Retain recognized question and approval frames by event ID for the connection. Derive the visible pending list from the selected chat session, independently of frame arrival order. Navigation hides another session's dialog without answering or declining it. Explicit answers and host cancellation remove entries; connection teardown clears the transient map so the next gateway replay is authoritative. Unrecognized events retain their next-handler behavior.

## Alternatives considered

Persisting an event ID and dialog locally cannot revive a server-side promise after cancellation, tool failure, or host restart. Reconstructing a pending question from historical tool text would make a completed call appear answerable. Deferring only startup frames would leave the picker-navigation failure intact.

## Consequences

Recovery requires the original host and question to remain live. Normal TUI shutdown still cancels a running turn; client crashes do not preserve partial unsubmitted answers. A failed ask_user_question requires a new request, not replaying an old answer. The isolated gateway fixture replays an event before session selection and again after reconnect; tests also verify navigation does not send next, and explicit answering removes the dialog. Type checks, build, and terminal tests pass.
