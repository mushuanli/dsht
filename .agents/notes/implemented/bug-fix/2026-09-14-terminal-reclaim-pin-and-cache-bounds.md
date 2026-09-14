# Agent Note: Reclaim protection clears, and both prompt stores stay inside their budgets

Status: implemented

## Problem

Reviewing the session container for retained memory found three bounds that were documented but not actually enforced.

`SessionController.older` set `view.pinned` whenever it extended the live record. The pin had no clearing edge of its own: only the view-derived `pinHistory` call could clear it, and that effect runs when the viewport position or an open panel changes. A reader who paged once from the live end — a recall step at the boundary, `/older`, or `/think` loading older reasoning — therefore left the transcript permanently pinned, so `reclaimHistory` returned zero on every following frame and the 2,000-record / 16 MiB budget silently stopped applying while each further page kept adding records.

`adoptCachedPrompts` seeded the index from the process-level `PromptCache` and called `markComplete()` without `settle()`. The cache-hit path was the one path that skipped the index budget, so the selected session could retain the whole cached list in the index *and* in the cache, while claiming to be exhaustive.

`PromptCache.put` only evicted whole sessions and always kept at least one. A single session holding more prompt text than the whole budget was stored in full and kept, because eviction stops at one entry.

## Decision

`older` no longer pins. Everything that must survive is already covered by the view: scrolling back sets a scroll position, `/think` opens a panel, and a page fetched for recall has its prompts folded into the index before the call resolves. Anything else is reloadable by construction — `trimHistory` advances the reload cutoff and leaves `hasMore` true — so dropping the pin costs nothing a reader can see and restores the budget.

`adoptCachedPrompts` now settles the index before marking it complete, exactly like the backfill it replaces; `markComplete` already refuses an index that shed a prefix, so the lazy backward step stays available for whatever was shed.

`PromptCache.put` truncates a single oversized session to the newest prompts that fit the byte budget and records the entry as incomplete, so an open still fetches the older part instead of trusting a list with a hole at the front. `drop` — written for exactly one caller and never wired — now runs after a successful `/compact`, because compaction rewrites the host log the cached prompts were read from.

## Alternatives considered

Keeping the forced pin and giving it a clearing edge (for example clearing it on the next fold) was rejected: the pin's only justification was the fetched page, and that page is either already folded into the index or already protected by the view, so the extra state had no job left. Capping the cache by dropping an oversized session entirely was rejected: a long session would then never be cached and would re-walk on every open, which is the cost the cache exists to remove.

## Consequences

`tests/session/memory.test.ts` pins that paging history leaves `view.pinned` false and that the following frames still reclaim. `tests/session/info.test.ts` covers the oversized-entry truncation and its incomplete flag. `tui-design.md` 5.7.3 / 5.7.4 / 5.7.5 / 5.7.7 record the single writer and the settled budget. No user-visible behaviour changed, so the README pair is untouched.
