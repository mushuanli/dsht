# Agent Note: The composer keeps pasted text whole and never swallows the conversation

Status: implemented

## Problem

The composer was one logical line. Insertion ran `[\r\n\t]+` through a single space, so a pasted log was rewritten before it was ever sent: the flagship phone workflow — paste a failing log, ask for the root cause — handed the model a different string than the user pasted, with every line break and indentation destroyed. The same field had no height bound. Measured at 44x16, a 120-character draft already owned six rows and a 500-character draft owned thirteen of fifteen: the conversation was squeezed to zero rows, the closing border left the frame and the status bar disappeared. The two faults compounded, because the flattened paste was exactly the long logical line that wrapped hardest. The existing tests pinned the flattening as intended, so nothing reported it.

## Decision

Keep the bytes; bound the display. Insertion normalizes `CRLF`/`CR` to `LF`, keeps tabs, and strips only the remaining control characters. The wire is untouched: `session/prompt` already carries `content: [{ type: 'text', text }]`, and the transcript already wraps newlines through `wrap-ansi`, so a multiline draft renders and sends correctly.

A new pure module `src/ui/input/viewport.ts` derives layout from the text on every render: grapheme-aware wrapping with hard breaks, tab expansion to four-column stops, the cursor's row and column, a cursor-following row window, and the source range of a folded block. Nothing is stored, so no edit — including a kill, a recall or a parked-draft restore — has to rebase a span.

`app.tsx` budgets the window from terminal rows alone: `body = rows - root frame - header - status bar - one transient line`, content rows `clamp(floor(body / 3), 2, 5)` further bounded by `body - 7` so at least four conversation rows survive. Columns never buy height, so landscape and a wide desktop only wrap less. A multiline draft whose unfolded height exceeds the window folds its interior lines behind `[N lines · X KB]`, leaving the first and last lines visible; the decision reads the unfolded height, so folding can never feed back into itself and oscillate.

A folded range is one object to `editInput`: `←`/`→` cross it in one step, Backspace at its trailing edge and Delete at its leading edge remove the whole range, and word or character motion snaps out of a range instead of parking inside it. Explicit kills (`Ctrl+K`, `Ctrl+U`) still work by character and the fold is simply recomputed. No key changes: Enter submits, Esc keeps its cancel meanings and `↑`/`↓` still recall history.

Planning is kept cheap because it runs on every keystroke. When the logical line count alone already exceeds the window the interior is never wrapped — only the first and last lines are laid out — which takes a 394 KB / 5000-line draft from roughly 66 ms to 0.14 ms per plan.

## Alternatives considered

Opening a full-screen editor on the fifth line was rejected. The trigger is unreachable while newlines are collapsed, Esc is the established cancel gesture in this client, and swapping the whole frame mid-typing hides the conversation the user is reading.

A paste-detection heuristic was rejected for this phase. Without bracketed paste nothing distinguishes a paste from fast typing, and Ink 6 does not parse `ESC[200~`/`ESC[201~` — it delivers them as literal text — so a wrong guess would be worse than a neutral label. Storing paste spans was rejected for the same reason plus a second: a derived fold needs no rebasing, while a stored span must be rebuilt on history recall, parked-draft restore and every edit.

A byte threshold (40 B, or a 512 B fallback) was rejected: bytes are not screen size, and 40 B is already an ordinary English sentence while a dozen Chinese characters exceed it. Visual occupancy is the first criterion, and a long single-line prompt scrolls instead of turning into an object.

Converting tabs to spaces was rejected because it corrupts Makefile-style content. The tab stays in the draft and is expanded only for display, so the viewport's width math and the terminal agree without changing what is sent.

Turning `↑`/`↓` into in-draft row movement was rejected for this phase: the arrow-ownership matrix is pinned by `tests/ui/key-routing.test.tsx`, and a folded block is fully navigable with `←`/`→` alone.

## Consequences

`tests/ui/input-viewport.test.ts` pins wrapping, tab stops, cursor placement, windowing and the fold decision, including that a long single line never folds, that the decision cannot oscillate, and both planning paths — logical lines already over the window, and logical lines that only exceed it by wrapping — so they cannot drift. `tests/ui/input.test.ts` pins line-ending normalization, tab preservation, control stripping and the folded-block gestures. `tests/ui/app.test.tsx` replaces the "paste becomes one line" test with two: line breaks and tabs are displayed and sent verbatim, and a tall block folds while Enter still sends the full text. `tests/ui/composer-layout.test.tsx` mounts at 44x16 and 80x12 and asserts that a 500-character draft leaves the conversation, the closing border and the status bar in place, and that the window follows body rows rather than columns.

Bracketed paste, a `View paste`/`Edit paste` panel, per-line cursor movement and a height budget for the `@` reference menu and dialogs remain future work; the composer itself is now bounded.
