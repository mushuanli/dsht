# Agent Note: Recall pages back to the start of the session

Status: implemented

## Problem

↑/↓ recall was seeded from the transcript window the client loaded when it opened the session, and the oldest seeded prompt was treated as the end of recall. In a session that began before this client connected, everything earlier was unreachable: the arrows silently stopped at the window boundary, which has nothing to do with where the conversation began. The README documented that as intentional ("It does not fetch older pages"), but the user-visible result is a history key that answers "no more" while the host still holds more.

## Decision

Stepping past the oldest retained entry now pages the retained window back first. `app.tsx` calls the same `SessionController.older` the reader's own scrolling uses, takes the floor from `transcript.beforeSeq` captured before the load, folds only User messages strictly older than that floor through a new `InputHistory.prepend`, and then applies the step the key asked for. A page holding no User message is skipped inside one bounded loop (at most five pages), so a tool-only page cannot stall the key, while `historyPaging` keeps a single request in flight and `controller.perform` keeps repeated presses from queueing behind it.

`prepend` deliberately does not evict. The 200-entry / 256 KiB budgets still bound what a session seeds and what submissions retain, and the next `record` trims the buffer back to them, so walking back is bounded by what the reader actually asked to see rather than by the window the session happened to open with. Because the page lands in the live transcript, the recalled neighbour is also readable by scrolling above the composer, and history reclamation resumes once the reader returns to the live end.

## Alternatives considered

A dedicated read-only prompt pager (a temporary `Transcript` like `searchHistory` builds) was rejected as a second paging implementation: the transcript already is the pager, its pinning and reclamation already describe reading away from the live end, and a fetched page is useful in the conversation rather than only in the composer. Loading the whole session up front was rejected because it defeats the memory window the transcript exists to enforce and pays for history the reader may never recall. Making `prepend` evict down to the budgets was rejected because the eviction would drop exactly the older entries the reader just asked for; letting the cursor keep its place is also what keeps the key semantics "one step back".

## Consequences

`tests/ui/input-history.test.ts` pins prepend order, cursor preservation, skipping empty or oversized prompts, and draft restoration after paging back. `tests/ui/app.test.tsx` walks a fixture whose snapshot starts at seq 2 with `hasMore`, asserts one `session/page` request carrying `beforeSeq: 2`, reaches prompt 1 and prompt 0, and asserts the session's oldest prompt ends recall without a further request or a leftover loading label. The README pair and `tui-design.md` record the paging behaviour.
