# Agent Note: The status panel scrolls instead of paging

Status: implemented

## Problem

The expanded `/status` panel moved between fixed pages on `PgUp` and `PgDn`, and a phone keyboard has arrows but no page keys, so on a handset the only content past the first page was unreachable. Paging also cut the panel at arbitrary boundaries: a value that wrapped across the break appeared half at the bottom of one page and half at the top of the next, and the footer counted pages rather than the lines on screen, so a reader could not tell what they had already read.

## Decision

The panel now holds a line offset instead of a page index. `↑` and `↓` move one line, `PgUp` and `PgDn` move one view, and the wheel scrolls the panel rather than the conversation behind it while it is open. The footer names the visible range and the total and advertises the arrows, so a terminal without page keys still says how to move. A scroll past either end settles on the nearest view and reports the settled offset back to the app through `onScroll`, which keeps app state and display in step instead of letting a hidden offset accumulate.

The panel is now its own component. It is the only branch that scrolls, and it needs an effect to settle the offset, so keeping it inside the memoized bar would have put a hook behind the collapsed branch's early return and changed the hook order between the two states.

## Alternatives considered

Keeping pages and adding arrows was rejected because the page boundary still splits wrapped values and the reader still cannot see how far a page reaches. Letting the panel overflow the screen was rejected earlier, because rows past the height are dropped rather than shown. Making `/status` a full-screen dialog like `/help` was rejected as a larger change than the report needs: the panel deliberately shares the screen with the composer so `/status` can be read while typing.

## Consequences

`tests/ui/status-panel.test.tsx` walks every line of a scrollable panel and asserts that no detail line is dropped and no value gains an ellipsis, that the footer names the visible range, and that a scroll past the end settles on the last view and reports it back. It also drives `↓`, `↑`, `PgUp`, `PgDn` and Escape through the running application on a 40x12 terminal. A separate app test pins what a phone paste does: the whole snippet arrives as one input burst, newlines and tabs collapse to spaces, and no prompt is sent, so pasting a multi-line block cannot submit by accident.
