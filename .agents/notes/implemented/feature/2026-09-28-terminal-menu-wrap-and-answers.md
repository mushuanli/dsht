# Agent Note: Menus wrap, numbers answer, and textless panels park the composer

Status: implemented

## Problem

Three keyboard defects made the menus feel broken even though each key was documented.

- **No menu wrapped.** `Picker`, the `/loop` record list, the `@` completion list, the question option ring, the approval list and the loop parameter form all clamped at their edges (`Math.max(0, …)` / `Math.min(length - 1, …)`), so the arrows became dead keys at the top and bottom and the reader had to reverse direction to cross the list.
- **Numbers only highlighted.** Approvals and single-choice questions advertised `1–3` / `1–9`, but a digit only moved the highlight and a second Enter was still required. The design already called a digit an explicit answer, so implementation and document disagreed.
- **Textless menus left the composer live.** Modal panels (`/model`, `/prompts`, `/queue`, `/history`, `/think`, the removal confirmations) took the arrows but not the text: a keystroke aimed at the list became a draft, and because every picker disables itself while the draft is non-empty (`enabled={!input}`, `canSelect={() => !input && …}`), that draft silently killed the menu it was typed at.

## Decision

- `cycle(index, delta, length)` in `src/ui/dialogs/picker.tsx` is the one wrap rule, shared by the `Picker`, the `/loop` record list, the `@` list, the question option ring (one stop longer than the options because `Other answer` is a row), the approval ring and the loop parameter form. First row `↑` lands on the last, last row `↓` returns to the first, and an empty ring stays at 0.
- **A number is an answer, not a highlight.** Approval `1`/`2`/`3` posts `allowed-once` / `rejected` or cancels the turn immediately; the highlight is still set first, so a failed action leaves a visible selection. A single-choice question's digit answers that question outright, so a batch advances without a second keypress. A multi-choice digit still toggles, because one label is not the whole answer. Only the fixed options are numbered: `Other answer` is an input row, so it carries no number and is reached with the arrows and Enter.
- `usePanels` grows a `parksComposer` trait for the panels that read no free text. `ui/app.tsx` derives `panelParksComposer` from it and turns the composer's `focus` off while such a panel is open, exactly as the approval and question dialogs already parked theirs. `/help`, `/cost` and `/status` keep the composer — the key-routing tests depend on recalling history from them — and the startup workspace/session pickers keep it because they accept slash commands.

## Alternatives considered

- Wrapping only in the visible `Picker` and leaving the inline menus clamped was rejected: one `cycle` rule makes "the menu wraps" a single predictable promise instead of a per-surface accident.
- Making a single-choice digit only move the highlight was rejected: the request asked for direct selection, and the design already treated the number as the answer.
- Making a multi-choice digit submit a one-label answer was rejected: it would turn the first digit of a multi-select into a premature submission.
- Closing the panel when text arrives at a menu that reads none was rejected as the opposite of the request; parking the composer keeps the keystroke in the menu and says so by dimming the prompt.
- Parking the composer on the startup pickers was rejected because the README documents slash commands in pickers and those screens have no other way to type one.

## Consequences

`tests/ui/app.test.tsx` covers the picker wrap, the `@` list wrap, the question ring wrap through the typing row, direct approval answers (including `Stop turn` cancelling rather than posting a result), direct single-choice answers, the unnumbered `Other answer` row, the record-list wrap and the parked composer; `tests/ui/loop-form.test.tsx` covers the form wrap. `tests/expected/approval-options.txt` records the new `1–3 answer · ↑ ↓ select · Enter confirm` footer. The bilingual README pair and sections 2.5 and 4.3 of `tui-design.md` describe the behaviour, and implementation and design now agree that a digit is an answer.
