# Agent Note: The record has one owner

Status: implemented

## Problem

The selected session's `Transcript` lived in `State.transcript` as its own field while the rest of the session — prompt index, composer, reading view, interaction state — had moved into `State.session`. Two entry points for one session meant that "switch session" had to remember both, and `selectSession`, `pickWorkspace` and the release path each constructed or disposed a transcript themselves.

## Decision

`SessionInfo.record` is now the only strong reference to a session's `Transcript`. `SessionInfo.reset()` releases the old record (`releaseHistoryLayout` + `dispose`), builds a fresh one, and closes any detached history window, so every caller that used to swap the record now just resets the session. `State.transcript` is removed; `Controller.record` is the read accessor for code that only needs the transcript, and `ui/app.tsx` reads `state.session.record`.

The record stays the single source for everything derived from it: the prompt index folds from it, the reading view points at it or at a detached window, and the layout cache is still a `WeakMap` keyed by it — which now has a guaranteed strong key.

## Alternatives considered

Keeping `State.transcript` as an alias and adding `SessionInfo.record` beside it was rejected: two properties holding the same object is still two entry points, and because `update()` spreads the state, an alias getter would silently become a snapshot. Rewriting the transcript in place (`record.accept(snapshot)`) instead of replacing the object on a session switch was rejected because the layout cache, the folded prompt index and the detached-window checks all key on identity.

## Consequences

`tests/ui/app.test.tsx` adds a case asserting `controller.record === controller.state.session.record`, that a session switch replaces the object, and that the previous record's `ready` is false. The 88 test references to `controller.state.transcript` became `controller.record`, and the input benchmark now swaps `state.session.record`. `tui-design.md` 2.5 / 5.3 / 5.5 / 5.7 and the appendix record the change. No user-visible behaviour changed, so the README pair is untouched. Remaining: the optional `panels` visibility.
