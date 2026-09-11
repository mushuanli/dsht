# Agent Note: Composer history stays reachable beside a reading panel

Status: implemented

## Problem

Any open panel disabled the composer's recall keys, because the panel key gate covered `/status`, `/help` and `/cost` as well as the pickers. A reader who had just opened `/status` could not press `↑` to recall a prompt and had to close the panel first. Giving the status panel the arrows so it could scroll made this worse: the arrows now visibly belonged to the panel even when it fit the screen and had nothing to scroll at all.

## Decision

The panel reports whether it holds more lines than the view can show, and the arrows, `PgUp`/`PgDn` and the wheel belong to it only while that is true. Composer recall consults its own gate instead of the panel gate: the status panel appears in it only while it scrolls, so a fitting panel leaves `↑`/`↓` with the history exactly as before the panel existed. `Ctrl+P` and `Ctrl+N` bypass the gate entirely, which keeps history reachable from any panel, including one that does scroll. The pickers and the question and approval keys keep the original gate, so their own arrow and digit handling is unchanged.

## Alternatives considered

Closing the reading panel on `↑` was rejected because the reader asked to recall a prompt, not to dismiss what they were reading, and the panel may still be wanted afterwards. Always giving the panel the arrows was rejected as the cause of the report. Never giving it the arrows was rejected because a panel taller than the screen has to scroll, and a phone keyboard has no `PgUp`/`PgDn`.

## Consequences

`tests/ui/app.test.tsx` opens `/status` on a terminal where the compacted panel fits and asserts that `↑` recalls the last submitted value and that `Ctrl+P` reaches the older one. `tests/ui/status-panel.test.tsx` opens the same panel on a 40x12 terminal where it overflows and asserts that `↓` scrolls the panel without touching the composer, and that `Ctrl+P` still recalls.
