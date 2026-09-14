# Agent Note: Answers and menu highlights belong to their session

Status: implemented

## Problem

Three pieces of state around pending host waterfalls and the `@` reference menu lived in `ui/app.tsx`: the partly collected question answers keyed by event id, the highlighted option or approval row, and the reference menu's row index plus the draft that dismissed it. The waterfall itself is already derived per session by `SessionController.pendingFor`, so the local selection could outlive the request it belonged to: switching sessions kept a highlight and a half-finished answer set for a session the reader had left.

## Decision

`SessionInfo.interaction` holds `{ answers, option, approval }` and `SessionInfo.reference` holds `{ index, dismissed }`, written only through `SessionController` (`setAnswers`, `setOption`, `setApproval`, `setReferenceIndex`, `setReferenceDismissed`) and cleared by `SessionInfo.reset()`. The `@` menu's fetched items stay out: `lookup` is recomputed from the current draft and its session id, so storing it would only add a cache to invalidate.

The two state shapes have opposite lifetimes on purpose, and the design keeps them that way: a picker row cursor lives inside `Picker` and resets through `key={identity}` because it is focus, while the answer selection is lifted because it has to survive the `pending` event changing underneath it.

## Alternatives considered

Keeping the answers in the component and clearing them from one more `useEffect` on `state.sessionId` was rejected: the reset would still be scattered, and the `pending` event id can change without a session change. Moving `lookup` in as well was rejected because it is a derived query result, not session state. Giving `interaction` its own `State` field rather than nesting it in `SessionInfo` was rejected: session facts should have one owner.

## Consequences

`tests/ui/app.test.tsx` adds a case that opens the `@` menu, moves the highlight, sets a partial answer, an option selection and an approval highlight, then switches to `s2` and asserts all of them are cleared and the menu does not follow. `tui-design.md` 5.3 / 5.5 / 5.7 and the appendix record the new owner. No user-visible behaviour changed, so the README pair is untouched. Deferred: `panels` and unifying `record`.
