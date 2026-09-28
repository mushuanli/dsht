# Agent Note: A degraded status bar names the subsystem it lost

Status: implemented

## Problem

The single-row status bar collapsed every client-side metadata failure into `⚠ Error`. Three different loads can set it — the `session/control` live-metrics stream (`controlError`), the `session/modelCatalog` read (`modelError`) and the preset roster (`presetError`) — and two of them had no expiry. `controlError` was cleared only by the next connection generation, so one undecodable control frame marked the whole connection broken, and `modelError` was cleared only by a successful `catalog.refresh()` (a reconnect, a catalog-invalidation event or a model selection). A reader whose session was idle and whose model route worked fine therefore saw a permanent `⚠ Error` and could not tell which subsystem it meant without opening `/status`. `presetError` did not even raise the token, so the bar could hide a broken preset roster while the panel reported it.

## Decision

The collapsed token names the subsystem instead of saying "Error": `⚠ Metrics`, `⚠ Models`, `⚠ Presets`, in that precedence, and the expanded `/status` panel keeps the full message. The control stream now clears its own degradation: `ConnectionStreams` remembers that a frame failed to decode and, when the next frame decodes, publishes `degraded(undefined)` once, so a transient malformed frame does not outlive the condition. Only the first failure of an episode is published, so a baseline this client could not apply is not buried under the "before baseline" errors the following updates would raise. "Live metrics unavailable on this host" stays, because no frame can arrive to disprove it. `presetError` now raises the token like the other two, so the bar and the panel agree about what is degraded.

## Alternatives considered

Keeping the generic `⚠ Error` was rejected: it answers "something is wrong" while the reader's question is "which part", and the answer lived only in a panel they had to know to open. Keeping `controlError` sticky for the generation was rejected: the degradation exists to keep a running conversation readable, not to accuse a recovered stream. Clearing the error on every decoded frame without the guard was rejected because it would publish a second state update per control frame; the one-shot flag clears only when there was something to clear. Retrying `modelError` on a timer was left out: the catalog already refreshes on reconnect, on a catalog invalidation event and after a model selection, and a retry loop would add a request cadence the host does not need.

## Consequences

`tests/controller/connection-streams.test.ts` fixes the one-shot report and the recovery, `tests/controller/loop-run.test.ts` asserts that the malformed-`jobs` degradation clears once a well-formed control frame arrives, and `tests/ui/status-panel.test.tsx` fixes the three collapsed tokens and their precedence. The README pair and sections 3.2.1 and 5.2.5 of `tui-design.md` record the named degradations and the recovery rule.
