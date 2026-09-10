# Agent Note: Mouse entry to frozen copying

Status: implemented

## Problem

Normal chat output and the Working clock redraw during reading. Copy mode freezes them, but entering it required a keyboard shortcut or command.

## Decision

An unmodified left-button press while mouse reporting is active enters the existing copy mode. It freezes the whole view and releases terminal mouse capture. The user then drags to select. Mouse release does not resume updates; Esc, Ctrl+S, or Ctrl+C does. Wheel scrolling and other mouse reports keep their existing behavior. Background reception continues without interrupting the remote task.

## Alternatives considered

Terminal-native Shift-selection often bypasses application mouse reports, so reliable automatic detection is unavailable. Ctrl+S remains the explicit entry for that case and for dialogs where reporting is already disabled. Resuming on button release would redraw before users finish copying.

## Consequences

Copying with the mouse uses a click followed by a selection gesture. Tests verify clock and transcript freezing, continued background reception, ignored right-click/motion/release reports, and explicit resume without cancellation. Existing copy-mode resizing behavior remains unchanged.
