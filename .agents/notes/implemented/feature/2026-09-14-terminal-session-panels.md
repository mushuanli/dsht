# Agent Note: Panels belong to their session

Status: implemented

Superseded in part by `architecture/2026-09-15-layered-boundaries-and-plain-ui-contract`: panel visibility is component state in `ui/app.tsx` again, cleared on a session switch, so the modal surfaces are no longer session data.

## Problem

Six panel flags lived in `ui/app.tsx` as `useState`: the reasoning panel, the queue panel, the model dialog step, and the history/search query, mode and matches. They were reset by three different effects keyed on the record, the session id and the pending event, so which panel survived a session switch depended on which effect happened to run. The rows those panels show always came from the record, so these flags were the only session-scoped state left outside `SessionInfo`.

## Decision

`SessionInfo.panels` holds `{ thoughts, queue, model?, history?, search? }`, written only through `SessionController` (`openThoughts`, `openQueue`, `setModelPanel`, `setHistoryPanel`, `setSearchPanel`) and cleared by `SessionInfo.reset()`, which removed the three reset effects. `ModelState` moved into the session domain (`src/session/info.ts`) and the dialogs re-export it, so the model dialog's step shape has one definition.

The panel row cursor still lives in `Picker` and still resets through `key={identity}`: it is focus, not session data, and lifting it would re-render the whole tree on every arrow key.

## Alternatives considered

Leaving the flags in the component was rejected once the record and the rest of the session had one owner: there is no reason for panel visibility to be the exception, and the scattered resets were the visible symptom. Putting the panel cursors in `SessionInfo` as well was rejected for the same reason as the interaction state — focus inside a modal should not drive a full re-render per keypress.

## Consequences

`tests/ui/app.test.tsx` adds a case that opens the queue panel through `/queue`, sets the remaining panel fields, switches to `s2`, and asserts every field is cleared and the panel is gone from the frame. `tui-design.md` 5.3 / 5.5 / 5.7 and the appendix record the new owner, and §5.7.5 marks all six migration steps complete. No user-visible behaviour changed, so the README pair is untouched.
