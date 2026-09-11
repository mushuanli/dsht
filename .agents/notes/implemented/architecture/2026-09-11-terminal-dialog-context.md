# Agent Note: Conversation context above terminal dialogs

Status: implemented

## Problem

Hiding conversation history while a question, approval, or picker is open removes information needed to make the decision. A frozen viewport can also retain the wrong row count when the composer grows.

## Decision

Keep the selected conversation mounted above the composer during dialogs. Its measured height determines visible history rows; viewport height joins the frozen renderer identity so dialog layout changes show the appropriate recent context. Dialogs remove the history's extra vertical margins and exclude its trailing separator from the visible tail.

Mouse wheel and PgUp/PgDn scroll conversation history while dialogs remain open. Arrow keys, numbers, and Enter retain their selection and confirmation roles. Help uses PgUp/PgDn for its own pages. Mouse clicks in dialogs do not activate copy mode; Ctrl+S explicitly freezes the entire display and releases mouse capture. Automatic background updates remain paused until the dialog closes or the user explicitly scrolls or resizes its viewport.

Approval dialogs expose numbered Allow once, Deny, and Stop turn actions. Numbers and arrows change selection; Enter confirms. A new event ID starts without a selection so an Enter carried over from a previous interaction cannot approve the next request. Existing drafts, copy mode, offline state, and busy operations disable approval shortcuts. Commands remain available. This keeps the two-key question interaction consistent without enabling single-key authorization or mouse capture for buttons. UI tests cover fresh-request Enter, numeric approval, arrow rejection, stopping, draft typing, and the rendered option text.

## Alternatives considered

Unmounting history guarantees space for choices but removes decision context. Freezing a viewport without its height in the render identity can leave only blank or clipped rows after resizing. Routing wheel input to the choice picker would change the current answer when the user intends to read context.

## Consequences

The composer retains its existing option pagination and input ownership. Available terminal height limits the amount of history shown. UI tests cover recent context in question, approval, and model dialogs, a 20-row resize, wheel and keyboard history navigation without selection changes, and normal confirmation after scrolling. Copy-mode and background-freeze regressions remain covered.
