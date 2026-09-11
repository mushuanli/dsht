# Agent Note: Incremental wrapping of the live tail

Status: implemented

## Problem

`historyLayout` wrapped every live part in full whenever the layout was rebuilt, and every streaming frame rebuilds it. The cost therefore grew with the accumulated answer length multiplied by the number of frames: an answer of 36,000 characters arriving in 1,500 frames spent 20.8 s wrapping text whose earlier rows could not change any more. Folded live reasoning had the same cost in a smaller form, because the single displayed row was built from the whole reasoning text.

## Decision

A live part now carries a stable `key` (`<attempt>:<block index>`), and each layout keeps a `liveWraps` map from that key to `{width, reasoning, kind, length, rows, carry}`. `rows` holds the rows whose text can no longer change and `carry` holds the raw source of the one row that still can; an arriving delta is appended to `carry`, and only that remainder is wrapped again. Every row before the last non-empty one is final, because a growing text never re-flows it.

Recovering `carry` needs the row's offset in the source, and `wrap-ansi` trims both ends of every row, so a rendered row is not a contiguous slice of that source. `rawStart` matches the row backwards while skipping source whitespace and stops after a bounded scan. A failed match, or a carry longer than `width * 4 + 64`, re-anchors from the whole text; a failed re-anchor returns to the one-shot wrap and records no state. Folding bounds its own input with `foldedSource`, which grows a prefix until the folded line fills the width.

`liveWraps` is cleared by `dispose` with the rest of the index, so the state cannot outlive the layout that owns it.

## Alternatives considered

Reimplementing the wrap was rejected because `wrap-ansi` owns the hard-break, trim and East-Asian width rules this terminal already renders with. Caching rendered rows by text was rejected because every frame produces a new text, so the cache would never hit. Skipping the wrap when a delta looks harmless was rejected because equal output could not be proven for it. Keeping the whole text in the state and slicing it per frame keeps the memory the change exists to avoid.

## Consequences

The rendered rows are identical to a whole-text wrap for every delta. `tests/session/live-wrap.test.ts` streams deterministic random text, including whitespace-only and newline deltas, over widths from 16 to 100, compares the layout against a one-shot wrap after each frame, and fails if a live part loses the identity the incremental path needs. The same measured stream takes 20.8 s when wrapped whole and 268 ms incrementally. Retained state stays bounded by the finalized rows the layout already cached plus one carried row.
