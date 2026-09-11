# Agent Note: The status bar carries a fuller reading of two groups

Status: implemented

## Problem

Removing the context bar made the share harder to read than the bar it replaced, and the two cost columns (`S¥2.49*`, `D¥113.25*`) spent characters on scope letters while the bar never showed what the account had cost in total. The pane also could not say both things at once, because one field list decided the reading order and the drop order together: a group was displayed exactly where it was kept, so a fuller rendering of the cost had nowhere to sit except the position of the session column.

## Decision

Two groups carry a second reading of the same value. The context share draws as `ctx: ███░░░░░░░ ~30%`, ten cells resolving tenths, beside the plain `ctx 30%`. The cost draws as `¥: 3.00 (13.00)` — today's cost with the all-time total in parentheses, since `CostLedger.total()` sums every charge when neither a session nor a day range restricts it — beside the plain `S¥3.00*`, which keeps the session scope.

A fuller reading replaces the group it belongs to only where the fully fitted row still holds it, so neither reading ever takes a group that fits: at 109 columns the widest row holds the bar and the two-scope cost, and each gives way to its plain form at its own width instead of displacing the model or the turns. A row that has dropped every group but the cost is the compact layout, and it keeps the session scope, so the day total with the all-time total is what a wide bar shows and a narrow one still answers for the session it is driving. The bar has one cost slot, filled from the session slice where the ledger has one and from the day total where it does not, so a session with no cached slice still reports a cost.

Display order is now independent of keep order. The row reads the state cluster, the model, its effort, the context share, the cost, the turns and the tokens, while the cost, the share, the model, the effort, the turns and the tokens are the order in which width is given up. The cost therefore sits after the share it is read beside, and it is still the last group to be dropped, moving to the second row rather than disappearing.

## Alternatives considered

Letting a fuller reading displace a group that fits was rejected because the bar would trade the model or the turn count for a wider rendering of a number already on the row. Choosing the cost scope by a width threshold was rejected because the threshold would have to follow the model name, the token total and the terminal font. Keeping the scope letters as their own columns was rejected because the day total and the all-time total answer more between them than two session-and-day labels, and they cost no extra group once the pair replaces one column. Shortening the bar to fewer cells to make it fit more often was rejected because ten cells read at a glance and five do not separate a third from a half.

## Consequences

`tests/ui/status.test.ts` pins both readings at their own widths, asserts that the bar's row still contains the token total where the plain form is shown, and asserts that the compact layout keeps the session scope. `tests/expected/status-compact.txt` records the widest row, and `tests/ui/app.test.tsx` covers a session without a cached slice. The all-time total is one more key in the ledger's memoized totals, so the extra reading costs one cache lookup per render, not a second scan.
