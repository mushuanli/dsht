# Agent Note: The status bar keeps groups by value

Status: implemented

## Problem

The single-row bar described columns rather than answers. At 46 columns it spent fifteen characters on `Ctrl+C Stop`, printed a context percentage directly beside the money so `~¥2.49/~¥113.25* ███░ ~30%` read as a budget and its usage, and dropped the cost — one of the few numbers the bar exists to give — before the context share and the model name. `Working` was spelled out although the glyph and the running clock already said it. A paused clock froze without saying why, and because the clock freezes in three different situations (copy mode, an open dialog, reading older history) a frozen number was indistinguishable from a stall.

## Decision

Groups are packed by value. In keep order the bar holds the state cluster (`◐ 6:18` while running, `● Ready`, `⏸ <reason>`, `! Offline`, `⚠ Error`), the live phase, the stop hint `^C`, this session's cost `S¥2.49*`, the context share `ctx 30%`, today's total, the model, its effort, the turn count and the token total. When the width runs out the least valuable group is dropped first; the cost is never dropped but moves to the second row, and the state cluster gives up the phase and the stop hint only below about twenty columns.

The phase is a fact, not an inference: `Transcript` records when a phase began, so a delta for reasoning reads `think 28s`, a tool reads `<name> 1:08`, and streamed answer text reads `write 12s`. Nothing is derived from silence, because a long reasoning step and a quiet tool are both normal and the protocol carries no stall signal at all. `app.tsx` passes the pause reason (`copy`, `dialog`, `history`) so a frozen clock names itself, and the bar reports its own row count so the `/status` panel's page budget shrinks when the bar takes two rows.

## Alternatives considered

Keeping the columns and only reordering the drops was rejected because the activity column's padding is exactly the width a narrow terminal cannot spare. Inferring a stall from a quiet period was rejected earlier and again here: it would cry wolf on long reasoning, and the host publishes no per-turn liveness signal. Colouring a tool by how long it has run was rejected because the client cannot see a tool's `timeoutMs` and normal runtimes differ by orders of magnitude. Dropping today's total from the bar entirely was rejected once scope letters (`S`/`D`) removed the ambiguity that made it worth dropping.

## Consequences

`tests/ui/status.test.ts` asserts the ladder at eleven widths, that nothing overflows with a wide-character model name, that remote text cannot smuggle a control character or a line break in, and the exact clock and phase formats. `tests/ui/app.test.tsx` asserts the fitting panel, the freeze reasons, and the reconnect case where the bar drops a group it can no longer support. Only the phase start needs a timestamp, written when a phase changes rather than per frame, so the bar costs nothing per delta.
