# Agent Note: Memory samples name the structures that can grow

Status: implemented

## Problem

The runtime memory log recorded the process counters, the retained transcript and the ledger, and on a long run it showed a heap of 2.3 GB while the transcript held 1.7 MB and the ledger about 2 MB. Nothing in the sample covered the structures that grow with rendered content — the layout row cache, its expanded-reasoning rows and the bounded math and diagram cache — and nothing recorded how much history the minute cost scan re-read. Measuring the render path in isolation showed it does not retain memory: four hundred rich documents moved the post-GC floor by 3 MiB and four hundred distinct MathJax renders moved it not at all, so the next run had to say which of the remaining structures grows rather than repeat the guess.

## Decision

A sample now also records the layout row cache (`layoutRows`, `layoutCacheBytes`, `layoutSpans`, `layoutSpanChars`), its incremental live-tail state, the math and diagram cache (`markdownEntries`, `markdownChars`, `markdownHits`, `markdownMisses`), the live character count, the reasoning entry count, and the sessions, pages and events of the last completed scan. `layoutStats` reports the cache of one transcript and `markdownCacheStats` the render cache, so the numbers come from the structures themselves instead of a second estimate.

When the runtime exposes `global.gc`, a sample first collects and records `heapUsedAfterGc` and `gcMs`, which separates retained state from garbage V8 has not collected; otherwise the fields are absent. `npm run start:profile` creates `.diagnostics/` and starts the client with `--expose-gc --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=.diagnostics`, so `kill -USR2 <pid>` writes a heap snapshot at the plateau into that directory — a snapshot directory that does not exist would crash the process on the signal — and `--max-old-space-size` can bound a run that is already at 3 GB.

## Alternatives considered

Sampling more often was rejected: the log already had 159 samples over eighty minutes and the missing information was the cause, not the resolution. Collecting on every sample without a flag was rejected because a full collection on a multi-gigabyte heap stalls the terminal for as long as `gcMs` reports, so it stays behind an explicit runtime flag. A dedicated profiler build was rejected because Node writes a snapshot on a signal, which needs no build and leaves the shipped code untouched.

## Consequences

Samples stay counts and sizes only, never prompt, tool or session text. `tests/controller/memory-log.test.ts` asserts the new fields are present, that a built layout is visible as `layoutRows` above zero, and that the forced-collection fields appear exactly when the runtime offers a collection. The counters are read once per sample from structures that are already bounded, so sampling cost does not grow with the conversation.
