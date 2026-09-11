# Agent Note: A new draft returns to the live end

Status: implemented

## Problem

Reading back through a long conversation left the viewport wherever it had been scrolled. Writing a message while there meant finding the live end again before sending, which took one wheel or `PgUp` press per few rows, or the `/latest` command. Nothing tied the start of a draft to the position of the view.

## Decision

`setInput` returns the viewport to the live end when the draft becomes non-empty, the screen is the conversation, and the first character is not `/`. The condition is the transition from an empty draft, not the draft being non-empty: a reader who has a draft and scrolls away keeps their place while editing it, so checking something in history does not fight the composer. A slash command is not a message, so typing one leaves the viewport alone — `/search` and `/think` exist to move through history, and dragging the reader to the bottom while they are typed would undo that.

## Alternatives considered

Returning to the live end whenever the draft is non-empty was rejected: every later keystroke would drag back a reader who deliberately scrolled away with a draft in hand. Dropping a loaded history window as well, as `/latest` does, was rejected because typing a character must not discard the search results or earlier page the reader opened; sending already clears that window. Adding a hint to the composer was rejected because the behaviour needs no instruction: it only ever removes a scroll.

## Consequences

`tests/ui/app.test.tsx` scrolls a forty-record conversation away from the live end, asserts that typing `/` leaves it there, that starting a message returns to the live end with the draft intact, and that scrolling away with a draft and typing more keeps the reader's place. The `useLayoutEffect` that derives the viewport position and the history pinning already react to the scroll value, so no new state was needed.
