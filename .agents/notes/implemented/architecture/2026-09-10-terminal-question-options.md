# Agent Note: Keyboard selection for user questions

Status: implemented

## Problem

The terminal rendered question options as a single text line and sent every answer as custom text. It lacked the web question composer's option selection and multi-select behavior.

## Decision

Render question progress, headings, numbered options, descriptions, and multi-select checkboxes. Arrow keys move the highlighted choice. Digits 1–9 select a single choice or toggle a multi-select choice; Enter explicitly confirms. Space toggles the highlighted multi-select choice. An Other entry returns input ownership to the composer, allowing numeric custom text. Shortcuts only own an empty composer and do not run inside copy mode or another panel.

Answer state is keyed by interaction and question position. Selected labels use the existing `{ id, selected, custom? }` protocol; all answers are sent together after the final question. Multi-select answers may combine selected labels and custom text. Failed submission retains the current choice and draft. Explicit keyboard confirmation never infers approval from recommendation text. Esc and Ctrl+C preserve a pending interaction; `/cancel` remains explicit cancellation.

Pending questions and approvals replace the history viewport. Their container and option rows cannot shrink, so a taller subsequent question does not compress its title or labels to zero height against frozen history. The option window uses terminal height and follows the highlighted row. Regression coverage replays a long session, advances from a short first question to a second with descriptions, and then shrinks the terminal while checking the selected labels and confirmation hint.

## Alternatives considered

Submitting on a digit alone makes accidental selection harder to correct. Encoding option numbers as custom text loses the host's structured answer labels. Reserving digits while typing would prevent numeric answers. Loading option state from transcript text would confuse completed and live interactions.

## Consequences

The first nine options have direct digit shortcuts; longer lists use arrows and a bounded visible option window. Partial answers remain local until the final submission and are not persisted across process exits. Tests verify single selection, multi-selection, descriptions, numeric custom answers, exact structured payloads, and failed-submission retry. Type checks, build, and the focused terminal tests pass.
