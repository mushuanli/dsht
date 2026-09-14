# Agent Note: Opening a session folds the whole prompt history

Status: implemented

## Problem

The recall index was seeded from the opening follow snapshot, which the host caps at the newest eighty records, plus whatever arrived later. Older prompts were reachable — a backward step at the boundary refilled from the loaded window and then paged — but they were not in the array. In a long agent session that meant the reader had to press ↑ through pages of tool and assistant records to reach the beginning, and a press that scanned its whole page allowance without finding a prompt looked like a dead key. The prompt list a reader expects on session open is the session's, not the window's.

## Decision

`selectSession` now starts `SessionController.backfillPrompts` after subscribing. It walks `session/page` backwards from the opening window, parses each page into a temporary `Transcript`, extracts only user prompts through `Transcript.promptsSince`, and `prepend`s them, until the host reports `hasMore === false`. Each temporary transcript is disposed immediately, so the live record, its memory window and the row cache never grow — the walk costs network and prompt-sized memory only. It is bounded to 200 pages, cancelled by the next selection or release, and swallows cancellation, disconnect and unavailable history, leaving the lazy backward step in charge.

When the walk ends because the host said "no more", `PromptIndex.markComplete()` records that the index is exhaustive, and `recallHasOlder` then stops offering a page request that could only return nothing. A walk stopped by the page bound leaves the flag clear and the lazy step still applies. A completed walk also calls `PromptIndex.settle()`, which trims the bulk it just added down to the 2,000-entry / 512 KiB budgets; the trimmed prefix stays reloadable through the lazy path, which is the same rule the budgets already followed.

## Alternatives considered

Seeding from the cost scan was rejected for this step: the scan is owned by the billing domain, runs for every session on a timer, and correlating its page stream with the selected session's index would couple billing to recall for no user-visible gain. A host endpoint that returns only `user/message` pages was rejected as out of scope here, though it is the right end state — it would remove the duplication where the backfill and the cost scan each read the same log at eighty records a page. Triggering the walk on the first boundary press instead of on open was rejected because the reader asked for the list, not for a page fetch behind the key.

## Consequences

`tests/ui/app.test.tsx` adds a case whose history spans four pages: it asserts the index holds all eight prompts oldest-first right after opening, that walking back to the first prompt spends no page request, and that one further press reports the end instead of paging. Two existing tests that counted `session/page` requests now wait for the backfill and assert on the delta, because opening a session legitimately reads history. `tui-design.md` 4.3 / 5.3 / 5.5 / 5.7 and the appendix record the change, and the README pair documents the background walk.
