# Agent Note: One history read feeds billing and recall

Status: implemented

## Problem

Opening a session walked the host history backwards to fold every user prompt into the recall index, and the billing scan walked the same history, at the same eighty records a page, on connect and every minute. For the session a reader opens right after startup the log was read twice, and the second read existed only because two domains each owned a reader.

## Decision

The cost scanner now hands each page it already has to the session domain: `sessionCostHistory` takes an optional `onRecords(records)` callback, `CostController` forwards it through `CostHost.scanPage` / `scanDone`, and the facade connects those to `SessionController.rememberScanPage` / `rememberScanDone`. The session side parses pages with the transcript's own `recordPrompts`, so a prompt read straight from a wire record is identical to one folded from the live stream, and folds them into a process-lifetime `PromptCache`.

`selectSession` then adopts a complete cached entry (`adoptCachedPrompts`) instead of walking, so an open that follows a scan costs zero requests; a miss falls back to the existing bounded backfill, which now also writes the cache when it reaches the beginning. The cache is keyed by session id, bounded by bytes with least-recently-used eviction that keeps at least one entry, and only complete entries are usable — a scan cancelled halfway leaves an incomplete entry that an open ignores, because what it is missing is the oldest prefix.

## Alternatives considered

Putting per-session cost into `SessionInfo` was rejected: the ledger is cross-session, persisted and re-folded by every scan, and `CostLedger.replace` installs a new object each time, so a stored copy or reference would be stale by the next scan. The UI instead reads through `Controller.sessionCostText`, which also replaces the expression duplicated in two places in the status bar. Letting the session domain own the shared traversal was rejected: billing needs every session, recall needs the open one, and the domain that already walks everything is the scanner.

## Consequences

An index that shed a prefix through its budget no longer claims to be exhaustive (`PromptIndex.trimmed`, and `markComplete` refuses), because the dropped prompts are older than the live window and the lazy step could not recover them — the cache and the completeness flag would otherwise advertise a list with a hole. `tests/ui/app.test.tsx` asserts that a scan warms the cache and a later open adds no `session/page` request; `tests/session/info.test.ts` covers page ordering, completion, byte eviction and the shed guard. `tui-design.md` 4.3 / 4.5 / 5.1 / 5.3 / 5.5 / 5.7 and the appendix record the change. No user-visible behaviour changed, so the README pair is untouched.
