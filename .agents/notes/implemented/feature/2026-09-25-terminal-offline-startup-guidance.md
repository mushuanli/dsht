# Agent Note: Startup pickers explain an unreachable host

Status: implemented

## Problem

`dsht` deliberately never starts Harness, so an unreachable host is an operator problem with a known fix — but the startup screen did not say it. When the host could not be reached, the workspace picker stayed on screen with a disabled, empty list and the only explanation was the raw transport failure (`connect ECONNREFUSED 127.0.0.1:3080`) printed in red above the frame, under a `Reconnecting…` line. That answered neither "what is wrong" nor "what do I do next": the fact that `dsh web` must already be running, and that a first run exports the URL it prints, lived only in the README. On the very first attempt, before any failure existed, the screen already looked like a failure.

## Decision

Every offline state of a startup picker now renders a guidance block instead of the list. `src/ui/offline.ts` is a pure leaf that maps the published connection status to a title, a few short lines and an optional dim detail; `ui/dialogs/index.tsx` renders it as `OfflinePanel` and `ui/app.tsx` substitutes it for the picker while `screen` is `workspaces` or `sessions` and `online` is false. The three states are the three things the connection already publishes:

- `Connecting…` — the first attempt is still in flight, so the title says connecting rather than offline. A client that has not finished trying has not learned that anything is wrong, and claiming otherwise would be a guess.
- `Host offline` — a generation failed, so the block names `npx @deepseek-ai/dsh web` and the first-run `DSH_URL` export that the README documents.
- `Login required` — the host refused this client, so the block asks for the URL `dsh web` prints or for `DSH_TOKEN`, and repeats that tokens are never saved.

The raw transport failure is kept but demoted: it travels as `detail` and is rendered dim under the guidance instead of as the message. The block replaces the picker only on the two startup screens; a conversation keeps its transcript, the status bar keeps reporting `! Offline`, and the status/failure lines are suppressed only where the block already carries both.

## Alternatives considered

Parsing the transport error text for socket codes (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`) was rejected: the connection controller already separates `Login required` from every other failure, and "start the host" is the same instruction for a refusal, a timeout and an unknown host, so a second classification would add a brittle text dependency without changing the answer. Adding a structured fault field to `State` was rejected for the same reason — the published status is already the one distinction the guidance makes. Keeping the list and adding a hint line above it was rejected because an empty, disabled list is still what the reader sees first, and its rows (`+ Add workspace…`) cannot work offline anyway. Starting `dsh web` from within `dsht` was rejected as a product boundary the design states explicitly: the client never launches Harness.

## Consequences

`tests/ui/offline.test.ts` fixes the wording of the three states and the URL helper (`dshUrlLine`), and `tests/ui/app.test.tsx` renders the application against a closed port and asserts that the start command appears while `Choose workspace` is gone. The README pair and section 4.6 of `tui-design.md` record the behaviour. The README's first-run snippet, which named a package that does not exist, now says `npx @deepseek-ai/dsh web`, matching the command the client itself prints.
