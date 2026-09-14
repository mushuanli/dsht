# Agent Note: Recall keeps a session prompt index

Status: implemented

## Problem

↑/↓ recall was a bounded buffer (200 entries / 256 KiB) that held the session seed and every submission in one budget. The transcript window outlives that budget, so a submission that pushed the oldest entry out dropped a prompt the window still held, while boundary paging only fetched records strictly older than `transcript.beforeSeq` and so could not bring it back. In a long session, prompts the reader had already recalled became permanently unreachable through the arrows — exactly the case the feature exists for.

## Decision

Recall now reads a session-owned `PromptIndex` (`src/session/info.ts`) that `SessionController` keeps. Every entry carries the durable sequence it came from, so the budgets bound memory without deciding reachability:

- **Tail folding**: after each `session/follow` frame the controller calls `Transcript.promptsSince(through)`, which reads raw records newer than the last fold and extracts user prompts. Only the unseen tail is scanned, so streaming stays O(new) and the row projection is never rebuilt at a second width just to notice a prompt.
- **Reloadable eviction**: `trim()` drops the oldest entries past 2,000 entries / 512 KiB. A backward step at the oldest retained prompt first calls `refillRecall()`, which prepends whatever the loaded window still holds (`Transcript.promptsBefore(oldest)`), and only then pages through the existing `SessionController.older` path.
- **Local commands**: slash commands never become durable records, so they are retained in the same index marked non-durable; a durable echo of a locally recorded prompt upgrades that entry with its sequence instead of appending a second copy.
- The budgets are a memory balance, not a reachability rule: an evicted prompt is either still loaded or still on the host.

`InputHistory` and `ui/input/history.ts` are removed.

## Alternatives considered

Keeping the buffer and only adding a sequence field was rejected: the conflict is the single budget shared by session data and composer state, so the eviction line and the paging floor could disagree again. Preloading every prompt at session start (reusing the cost scan) was rejected for this step because it buys residency, not reachability, and adds a full-history traversal to the open path; the design keeps it as an optional deeper seed (`tui-design.md` 5.7.4). Folding the window into the index on every frame was rejected: it would re-scan the whole window per frame, which the previous implementation explicitly avoided.

## Consequences

`tests/session/info.test.ts` pins sequence upgrades, reloadable budgets, window scans in both directions, injected-context exclusion, and the fold watermark advancing on a frame that carries no prompt — without which every following frame of a turn would rescan it. `tests/ui/app.test.tsx` keeps the paging test and adds one that scrolls a page into the window and asserts recall recovers from it with no second `session/page`. The README pair, `tui-design.md` 2.6 / 4.3 / 5.3 / 5.5 / 5.7 and the appendix record the change. Deferred: `view` / `panels` / `answers` / `reference`, and unifying `record`.
