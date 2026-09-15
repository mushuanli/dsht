# Agent Note: The reading view belongs to its session

Status: implemented

Superseded in part by `architecture/2026-09-15-layered-boundaries-and-plain-ui-contract`: `scroll`, `folds` and `liveReasoning` are component state; `window` stays in `SessionInfo` because it owns the strong reference, and `pinned` became a private flag on `SessionController`.

## Problem

The reading view lived in `ui/app.tsx`: which record was displayed (a detached `Transcript` when the reader jumped to old history), how far back the reader had scrolled, which reasoning blocks were expanded, and whether reclamation was paused. The detached window was released only by a cleanup effect keyed on that component state, and the reclamation flag lived in a private `SessionController` field while the view that justified it lived in the component, so the two could not be reasoned about together.

## Decision

`SessionInfo.view` now holds `{ window, scroll, pinned, folds, liveReasoning }`, written only through `SessionController` (`setViewWindow`, `setScroll`, `setFolds`, `setLiveReasoning`, `pinHistory`). `setViewWindow` releases the window it replaces (`releaseHistoryLayout` + `dispose`), and `SessionInfo.reset()` calls the same `closeWindow()`, so switching sessions cannot leak a record. The row cache stays where it was: a `WeakMap<Transcript, LayoutIndex>` that needs no state entry but does need its key strongly held — which `view.window` now does.

`view.pinned` keeps both original writers: `older` forces it on when it extends the live transcript, and the UI publishes its derived rule through `pinHistory`. The merge rule is still open, so this migration preserves the existing semantics instead of silently changing when reclamation resumes.

## Alternatives considered

Leaving the view in the component and moving only the disposal into the controller was rejected: the window would then have two owners with different lifetimes. Deriving `pinned` purely from the view was rejected for this step because `older` also pins a page that recall fetched while the reader stayed at the live end, and there is no view predicate for that yet. Keeping a separate `view` field in `State` rather than inside `SessionInfo` was rejected: session facts should have one owner.

## Consequences

`tests/ui/app.test.tsx` adds a case that jumps to an unloaded record (which builds a detached window), switches to `s2`, and asserts the window is gone, `scroll` and `folds` are zero, and the old window's `ready` is false. `tui-design.md` 5.3 / 5.5 / 5.7 and the appendix record the new owner. No user-visible behaviour changed, so the README pair is untouched. Deferred: `panels`, `answers`, `reference`, and unifying `record`.
