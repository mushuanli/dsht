# Agent Note: History rows render as sibling text nodes

Status: implemented

## Problem

Ink measures and caches a text node's dimensions in module-level caches inside `measure-text.js` and `wrap-text.js` that never evict. Instrumenting both caches on a running client showed the wrap cache stays at zero entries while the measure cache grows by one entry per streamed frame, because the viewport rendered every visible row inside a single text node and the measured key was therefore the whole visible text. That key is re-created whenever the live tail changes, so a long session retains one full-viewport string per frame: 148 KB for two hundred streamed deltas, about 735 bytes per frame, held for the life of the process. Restarting the process discarded it, which is why memory fell on restart while the transcript, ledger and layout counters stayed in the megabyte range.

## Decision

`HistoryViewport` renders a column of sibling text nodes, one per already wrapped row, instead of one text node containing the rows. The measured key becomes the single changed row, so unchanged rows hit the cache and only the growing live row adds an entry — the same entry count at about 50 bytes per frame, a fifteen-fold reduction in retained key bytes. Spans keep rendering as nested text nodes inside their row. An empty row renders a single space because Ink gives an empty text node no height, and a probe confirmed the frames are byte-identical to the nested rendering; the existing golden and terminal suites pass unchanged.

## Alternatives considered

Rendering one text node and bounding Ink's caches was rejected because the caches are module-private, so the only bound available to us is how much text we hand over per node. Pre-splitting the live tail was rejected because it changes wrapping and therefore the visible output. Bumping Ink was rejected after checking 7.1.1, whose caches are equally unbounded, so the growth per node is the property to fix here and the missing eviction belongs upstream.

## Consequences

Residual growth is one small cache entry per streamed frame, so it is bounded by frames rather than by frames times viewport size. The node count rises to the visible row count, which Ink reconciles by row; the memory probe, the full test suite and `test:terminal` were rerun against the change. `src/ui/chat/history-view.tsx` carries the rationale, since the empty-row space and the sibling layout are only meaningful together.
