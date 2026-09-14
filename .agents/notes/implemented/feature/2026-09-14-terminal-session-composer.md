# Agent Note: The composer belongs to its session

Status: implemented

## Problem

The composer lived in `ui/app.tsx` as React state plus a `draft` ref mirror. Nothing reset it when another session opened: `selectSession` created a new `Transcript` and reset the recall index, but the draft, its caret and the draft parked by a blocking dialog survived, so a half-written prompt for one conversation appeared in the next one. The ref mirror existed only because an Ink input callback can run before the controlled listener is refreshed, which left two sources for the same value.

## Decision

The composer is now part of `SessionInfo` (`src/session/info.ts`), the session-owned container the controller exposes as `State.session`. `SessionController` writes it through `setComposer`, `setComposerCursor`, `parkComposer` and `restoreComposer`, and `releaseTranscript()` resets the whole session — prompt index and composer together — whenever another session is opened or the current one is released. `setComposer` publishes only when the text or the caret actually changed, so a keystroke that changes nothing costs no render.

`ui/app.tsx` keeps one helper, `setInput`, for the two side effects that are not session state — returning the viewport to the live end when a message draft starts, and leaving recall navigation when the composer is edited — and reads `controller.composer` inside callbacks instead of a `draft` ref. Controller state is always current, so the ref mirror, `updateInput` and `setCursor` are gone.

## Alternatives considered

Keeping the draft in React state and adding a reset effect on `state.sessionId` was rejected: the value would still live in two places and the fix would add one more scattered reset, which is the pattern the container exists to remove. Publishing the composer through a separate `State` field rather than `state.session` was rejected because session facts should have one owner. Keeping the composer in the UI and only clearing it on a session switch was rejected because the caret and the parked draft share the same lifetime and would keep needing their own rules.

## Consequences

`tests/ui/app.test.tsx` adds a case that types a draft, switches to `s2`, and asserts the composer is empty and the draft is gone from the frame. The README pair records that switching sessions clears an unsent draft. `tui-design.md` 5.3 / 5.5 / 5.7 and the appendix record the new owner. Deferred: `view`, `panels`, `answers`, `reference`, and unifying `record`.
