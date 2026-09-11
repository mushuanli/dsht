# Agent Note: The status panel fits one screen

Status: implemented

## Problem

The expanded `/status` panel gave several short values a row of their own — host, session id, mode, turns, queued and active jobs each had a label — and spelled out every unit. At 46 columns that needed 28 rows, which is two views on a phone, even though most of those rows used less than half the width. The panel could be scrolled, but the reader had to scroll to see information that would have fit.

## Decision

Related values share a row and the labels and units are the short forms: the connection, status and activity are one row, the session id carries its mode, the three metric rows read `Context ~40% (400,644/1,000,000) · 229,270,604 tok` and `In 476,510 · Out 794,094 · Cache 228,000,000/0`, and the cost row carries the turn count so queue and job counts take the last row. Errors keep a row each, because they appear only when something is wrong and their text is the reason the panel was opened. Wrapping and the scroll offset remain: a value still wraps at the terminal width, and a terminal too short for the compacted panel still scrolls rather than truncating.

## Alternatives considered

Dropping fields was rejected because those values are the panel's purpose. Shortening the session id or the workspace path with an ellipsis was rejected earlier for losing information the reader may need to copy. A two-column layout on wide terminals was rejected because it does nothing for the narrow terminal that motivated the change; the wide terminal already fits the compacted rows.

## Consequences

Measured with a long session id and one long error row, the panel needs 14 rows at 46 columns and 12 at 80, against 28 content lines before. A 20-row terminal has exactly the rows the panel needs after the header and composer, and a 24-row terminal has room to spare; a 12-row terminal still scrolls, because the information cannot fit there at any layout. `tests/expected/status-bar.txt` and the app assertions name the compact rows, and `metricLines` reports the short labels with its test asserting them.
