# Agent Note: Workspace removal and session archival in the terminal

Status: implemented

## Problem

The workspace and session pickers only opened entries, leaving users without the web navigation's removal actions. Session archival also needed to survive picker refreshes rather than returning in the all-sessions list.

## Decision

`d` or Delete on a real picker row with an empty composer opens a confirmation with its exact name, ID, and workspace path where applicable. Slash navigation accepts `--delete` and session navigation also accepts `--archive`. Existing unambiguous target resolution applies before confirmation; confirming uses the captured ID. Cancel is the initial choice. Escape closes the dialog, and unrelated commands dismiss it. Synthetic navigation rows have no removal action. The composer reserves `d` only for the empty navigation picker; drafts retain ordinary typing. Raw Delete sequences are distinguished from Backspace before opening confirmation.

Use only the host's existing APIs: `workspace/delete` removes a workspace registration without deleting its directory or sessions; `workspace/archiveSession` hides a session without deleting its log or stopping tasks. The dialog states these effects. Workspace baselines supply `archivedSessionIds`, which filter both workspace-specific and all-session pickers. Exact-ID resume still opens archived history.

Successful archival of the selected session releases its transcript and row caches. Removing the selected workspace clears its workspace association while retaining an open session. API refusals preserve the confirmation and visible entries. List refresh errors after a successful mutation explicitly report that the removal completed.

Session removal refreshes the host list before deciding whether confirmation is needed. Explicitly blank, idle sessions with no known queued jobs or local pending prompt admission archive immediately. Loaded transcript size and titles are not evidence of emptiness. A stale picker row that has since become nonblank still opens confirmation. The API offers no atomic empty-session deletion: archival preserves the log and does not interrupt a task that starts concurrently.

## Alternatives considered

Deleting host files would bypass the supported API and could destroy session history. Treating archival as permanent deletion would misstate the available operation. Optimistic removal before a receipt would hide entries after a rejected request. Deleting directly on a key press would omit a review of the target and scope.

## Consequences

There is no permanent session-delete command because the current public API exposes only archival. Running tasks continue, and workspace files remain intact. Regression tests use an isolated HTTP fixture to verify cancellation, captured payloads, rejection and retry, archive filtering after refresh, history reopening, and selected-transcript release. Type checks, build, and the terminal suite pass.
