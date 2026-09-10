# Agent Note: Indexed terminal history and reasoning navigation

Status: implemented

## Problem

Long sessions retain raw tool bodies and completed streaming chunks while formatting duplicate full and folded strings. Rebuilding a flat array of every historical terminal row on each stream frame makes display cost grow with history. A global reasoning toggle gives users no prompt-based way to locate a particular thought.

## Decision

The host remains the durable log owner. The client retains semantic message blocks and unfinished legacy chunks, releases unused tool-result bodies and finished chunks, and keeps paging and active-turn markers independently. Full-text joining is lazy. Fold state is separate from message content. Prompt and thought summaries have a cached sequence index that is unaffected by stream deltas; older pages refresh associations with the preceding loaded user prompt.

History keeps message row counts and offsets, a 2,048-row LRU, and a viewport reader. Unchanged stream frames reuse the committed index. Closed live reasoning folds when its block ends or answer/tool output begins. `/think` presents loaded summaries and the active attempt, loads earlier pages only on request, and expands a selected message at its original position. Keyboard selection uses arrows and Enter; mouse click selection is not implemented.

The header and composer surround a measured conversation viewport. One terminal row is reserved to avoid Ink's full-height clear-and-redraw path. General keyboard instructions appear in `/help`. Catppuccin Mocha is an independent semantic theme; ANSI styling is applied only after remote text sanitation. Tool calls retain a description and the first command line indented by two spaces without copying nested tool results into display storage.

Tool results update the original call status by call ID, retaining its description and indented command without a duplicate result row. Orphan results remain visible until the call page is loaded. Projection cache keys include the relevant call outcomes, so unrelated messages retain their cached parts; ordinary stream frames reuse the complete projection.

## Alternatives considered

**A local SQLite or file archive.** Disk-backed bodies can impose a hard memory limit and support offline history, but require asynchronous body loading, cache invalidation across snapshots, and a separate data lifecycle. They do not remove whole-history layout work. The client currently uses the host's existing paging API and optimizes the measured display path.

**Retaining every wrapped row.** It simplifies scroll lookup but keeps width-dependent copies of long sessions. Bounded row caching trades occasional rewrapping for lower retained display memory.

**Expanding all reasoning.** It changes the entire conversation height and gives no user-prompt locator. The list opens individual thoughts and preserves all other fold states.

## Consequences

The live transcript has configurable soft budgets of 2,000 records or 16 MiB of estimated payload, with reclamation to 75% and a protected recent tail. Eviction preserves paging cursors, preceding prompt summaries, and tool-call labels. Switching sessions disposes old content and layouts. Reading older history protects that window; `/latest` releases a separate search window and resumes live-tail reclamation. Offline history and unfinished streams remain protected. `/search` scans 80-message pages independently, releases temporary transcripts, and retains at most 200 detached short summaries. Target navigation loads a separate page while the main transcript continues following. Rare or absent matches still cost a full HTTP scan; a server-side index is deferred. Initial layout, resizing, and very large expanded blocks still require wrapping their content; there is no hard bound on total client memory or an offline disk archive. The reasoning list initially indexes loaded history, not every server record. The original tool-result body remains available only from the host log.

The keyless terminal suite additionally verifies budget reclamation, reload cursors, session disposal, bounded search, and return to live output. It covers viewport eviction, legacy chunk release and older-page replay, reasoning selection and lazy paging, command previews, role colors, and fixed-header scrolling. `npm run typecheck`, `npm run build`, and `npm run test:terminal` pass. `npm run bench:history` measures local layout plus a 25-row viewport without network or model work. On the same 10,000-message synthetic input, median frame time changes from 2.224 ms to 0.334 ms and P95 from 14.083 ms to 0.590 ms; process heap readings are not a controlled memory benchmark.
