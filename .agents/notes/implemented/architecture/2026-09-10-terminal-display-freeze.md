# Agent Note: Stable terminal copying and dialog backgrounds

Status: implemented

## Problem

Streaming output and the one-second Working clock can disturb native terminal selection. Mouse reporting diverts drag events, and timed panel dismissal interrupts reading.

## Decision

`/copy` and Ctrl+S freeze the rendered view, disable composer and picker actions, stop the display clock, and restore native mouse behavior. Esc, Ctrl+S, or Ctrl+C exits this mode without cancelling the agent. Frozen React subtrees retain the rendered view while background reception and normal cache reclamation continue. Resizing is an explicit redraw exception.

Dialogs and pickers freeze their background header, conversation, and status subtrees while preserving dialog interactions. The status clock also pauses during history scrolling. Help, status, and cost panels require dismissal rather than expiring. Mouse-report effects restore terminal flags when disabled and on teardown.

## Alternatives considered

Reducing the clock refresh frequency still interrupts selection. Pausing transport risks gaps and stale host control state. Disabling all updates during a dialog would also prevent its asynchronous results and errors from appearing.

## Consequences

Copy mode requires explicit exit to observe new output. Interactive dialogs can still redraw in response to user actions, results, or errors; copy mode freezes the complete view. Native selection behavior depends on the terminal. Tests cover unchanged frames across clock ticks and background events, continued data reception, recovery on exit, dialog persistence, and paused status snapshots. Type checks, build, and the terminal suite pass.
