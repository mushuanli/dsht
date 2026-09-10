# Agent Note: Terminal input recall

Status: implemented

## Problem

The composer had no input history, so repeating a prompt or slash command required typing it again.

## Decision

The App owns bounded process-local input recall: up/down and Ctrl+P/N fill the composer without submitting. Returning past the latest entry restores the unsent draft; editing ends traversal. Question options, completion menus, and empty navigation lists retain their arrow handling. Ctrl+P/N recalls from navigation lists. Modal panels disable recall.

Opening or restoring a session seeds recall once from its already-loaded User messages, excluding Context entries and joining newlines for the single-line composer. Session switches release the old buffer. Initialization does not run on stream ticks or arrow presses.

History retains at most 200 entries and approximately 256 KiB of UTF-16 text, merges adjacent duplicates, and skips oversized entries. It includes submitted prompts and commands, including failed attempts, but excludes pending interaction answers. Exiting discards the buffer; reopening rebuilds it from the loaded session. No additional history-page requests or disk writes are needed.

## Alternatives considered

Fetching all older prompts adds paging and retention costs; only already-loaded messages seed recall. Persistent command history requires a separate storage and privacy policy. Neither is needed for recall during the current process.

## Consequences

Users can edit and resend earlier input while keeping an unfinished draft. Memory use remains bounded independently of conversation length. Prompts outside the loaded window and commands from previous processes are unavailable. Unit tests cover traversal and eviction; rendered composer tests cover keyboard recall, draft restoration, editing, and absence of automatic submission.
