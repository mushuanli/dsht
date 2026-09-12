# Agent Note: A dialog that demands an answer parks the draft

Status: implemented

## Problem

A request for approval or a question arrives whenever the host decides to ask, which is often while a message is half written. The dialog took the digits and the arrows only when the composer was empty, because a draft in the field was treated as evidence that the user was typing rather than answering, so one character left in the field made `1`–`3`, `↑` and `↓` do nothing at all and `Enter` confirmed nothing. The draft was not lost, but the dialog had silently stopped working, and the only clue was a footer advertising commands that the user could type into a field that was already occupied.

## Decision

A dialog that demands an answer owns the keyboard until it is settled. When one opens, whatever is in the composer is parked: the field is emptied, its prompt is dimmed, and the field stops taking keys, so the dialog's own shortcuts work immediately. When the last pending interaction clears, the parked draft is written back, directly rather than through `setInput`, because restoring a draft is neither a new message nor a recall from history and must not move a reader's scroll position.

A question keeps the composer when it needs it: a free-text question, and a question switched to `Other answer`, both leave the field live, so an answer is still typed where answers have always been typed. Panels that are read rather than answered — `/help`, `/cost`, `/status`, `/think`, `/history`, `/model`, the pickers — keep their previous behaviour, where the field stays live and an open panel declines to select while a draft exists.

## Alternatives considered

Leaving the draft in place and letting the dialog's keys win over it was rejected because the visible result is the same confusing state: the user sees text where they are not typing, and `Enter` then both confirms the dialog and submits whatever is in the field. Clearing the draft without keeping it was rejected outright: a request for approval must not destroy a message. Letting every panel park the draft was rejected because reading `/help` while a command is being assembled and switching panels by command are both useful, and neither competes for the same keys as an answer.

## Consequences

`tests/ui/app.test.tsx` writes a draft, raises an approval, asserts the draft is gone while the dialog is open, answers with a digit, and asserts the draft is back once the request is settled — twice, so a failure to restore is visible. The two tests that used to type `/allow` and `/deny` into the field now answer from the dialog's own list, and `tests/expected/approval-options.txt` records the footer that says so. The custom-answer test still types its answer into the composer, which is what keeps the free-text path covered.
