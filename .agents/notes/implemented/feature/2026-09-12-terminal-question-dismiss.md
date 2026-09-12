# Agent Note: Escape dismisses a pending question as a set

Status: implemented

## Problem

An `ask_user_question` request could only be settled by answering it. The dialog parks the composer, so `/cancel` cannot be typed while it is open, and `Esc` and `Ctrl+C` deliberately kept the request pending — the footer said so. A user who did not want to answer any of the options had no way out of the dialog short of picking an arbitrary option or restarting the client, even though the Web client offers a close button on the very same request.

## Decision

`Esc` on a pending question now settles the waterfall as a rejection, exactly as the Web client's close button does: `$events/result` carries `{ kind: 'rejected', error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' } }`. `SessionController.dismissQuestion` sends it and drops the retained interaction, so the host records a cancellation rather than an answer. A question batch is answered as one request, so dismissing also discards answers already collected for earlier questions of the same batch.

Two guards keep the key from doing more than the user asked. `Other answer` keeps its existing step back — the first `Esc` returns to the options and only the next one dismisses — so free text is never thrown away by a single keystroke. Approval is untouched: the Web client offers only Reject and Allow once, so the TUI keeps its explicit `1`/`2`/`3` list and `Esc` still only clears the highlight. `Ctrl+C` is unchanged on both dialogs: it clears a draft and otherwise leaves the request pending.

## Alternatives considered

Mapping `Esc` to `session/cancel` was rejected: it is one keystroke away from stopping a whole turn, the host would report an abort rather than a user cancellation, and the question dialog would behave differently from the Web client. Dismissing immediately from `Other answer` was rejected because the user is typing there, and a field that throws text away on `Esc` is worse than an extra keystroke. Leaving the dialog with no dismissal path was rejected because the only exit was to answer something the user did not mean.

## Consequences

`tests/ui/app.test.tsx` covers dismissal from the option list (asserting the rejected outcome on the wire, that no `session/cancel` is sent, and that the dialog leaves the frame), the two-step exit from `Other answer`, and that an approval still survives `Esc` untouched. The question footer now advertises `Esc dismisses`, and a free-text question's footer line names it too. `tui-design.md` and the bilingual README record the new semantics.
