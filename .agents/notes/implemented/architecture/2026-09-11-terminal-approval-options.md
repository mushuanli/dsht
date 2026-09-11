# Agent Note: Numbered approval options in the terminal

Status: implemented

## Problem

Approvals could only be answered by typing `/allow` or `/deny`, while every other pending interaction already offered a visible, selectable list. A user deciding whether to let a tool run saw the request body and a hint line, so the decision depended on recalling two commands, and a mistyped command was hard to distinguish from a deliberate rejection.

## Decision

An approval request renders three numbered choices: `1. Allow once`, `2. Deny`, `3. Stop turn`. Choices 1 and 2 are the host's `allowed-once` and `rejected` outcomes; choice 3 cancels the turn through `session/cancel` and sends no event result, exactly like `/cancel`. The `/allow`, `/deny` and `/cancel` commands remain available.

With an empty composer, digits 1–3 or the arrow keys select, and Enter confirms only once a choice is selected. The list starts unselected, so a stray Enter cannot answer a request, and an arrow from that state enters at the first choice rather than at `Stop turn`. Escape clears the highlight without answering. The selection is keyed by the interaction identity and cleared when the request goes away or the connection generation changes, so a request replayed after a reconnect starts unselected again.

The composer reserves digits 1–3 only while an approval owns the keyboard. A non-empty draft keeps normal typing, which the test pins through `/allow` plus `2` composing `/allow2`; the ordinary prompt path stays reachable.

The dialog exclusion shared by the approval selector, the question picker and input recall is now one predicate, so a new panel cannot silently leave the approval keys active.

## Alternatives considered

Preselecting `Allow once` would let a single Enter approve a tool call, which is the outcome a confirmation exists to prevent. Entering the list from the bottom on an upward arrow highlighted `Stop turn` first, which risked cancelling a running turn on a stray keystroke. Submitting on a digit alone would drop the confirm step that the question picker also keeps.

Reading the outcome set from the request payload was rejected because the host does not advertise it; the two outcomes plus the cancel action are fixed by the wire protocol. Routing the labels through locale-owned copy was not applied because this terminal renders every interface string in English while only the READMEs are bilingual.

## Consequences

The keyboard contract for questions, pickers and input recall is unchanged; only approvals gained a selector. `npm run typecheck` and `npm test` (133 tests) pass, including a case that pins the unselected start, the Escape reset, the replay reset and the absence of an event result before confirmation, and the golden file `tests/expected/approval-options.txt` pins the rendered list.

The README pair documents the selector and `README.i18n.yaml` records the reviewed hashes. The three labels stay hardcoded English like the rest of the interface; a locale-owned dictionary is deferred with interface translation as a whole.
