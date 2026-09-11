# Agent Note: A narrow status panel wraps and pages

Status: implemented

## Problem

The expanded `/status` panel drew its host and workspace rows with `truncate-end`, so a long URL, host status or workspace path lost its tail on a narrow terminal. The panel also shares the screen with two header rows and the three-row composer, which never shrink, so a panel taller than what remained was clipped: at 24 rows a handful of long values was already enough to lose rows, and a short terminal lost the top of the panel and the bottom border.

## Decision

Each detail line is a plain text row, wrapped to the panel's inner width with hard breaks before it reaches Ink, so no value is truncated and no row needs a second wrap. The app passes a page size of `rows - 9`: two border rows and one footer row belong to the panel, and the two header rows and the three composer rows above it never shrink. Wrapping is measured again for the footer, because the page hint itself wraps on a narrow terminal and the lines it takes cannot hold detail. `PgUp`/`PgDn` move between pages, opening the panel and Escape both return to the first page, and the frozen identity carries the page so paging redraws a paused display.

## Alternatives considered

Keeping `truncate-end` and accepting the loss was rejected because complete information is the point of the panel. Letting Ink wrap the rows without paging was rejected because rows past the screen height are clipped rather than shown. Marking the cut with a `more` counter was rejected for the same reason. Measuring the composer to derive the budget exactly was deferred: the constant matches how `/help` already sizes its pages.

## Consequences

`tests/ui/status-panel.test.tsx` renders the panel at 44, 32 and 24 columns and asserts that no ellipsis appears and that the whole workspace path and host status survive; it walks every page and asserts that no detail line is dropped, that the footer names the page, and that an out-of-range page stays on the last one; and it drives `PgUp`, `PgDn` and Escape through the running application at a 40×12 terminal. `tests/support/tty.ts` mounts a component on a terminal of a chosen size, because `ink-testing-library` fixes the output at 100 columns and no height.
