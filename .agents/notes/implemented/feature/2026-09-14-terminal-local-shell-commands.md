# Agent Note: `!` runs on the client, and its output is a local block

Status: implemented

## Problem

A reader at the terminal has no way to run a local command without leaving it. The agent's `bash` tool runs on the host, inside the session, costs tokens and can be interrupted by the approval flow — all wrong for `pwd`, `git status`, or a quick look at a file on the machine the reader is actually sitting at. The client is a wire-protocol consumer with no host shell channel, so this could only ever be a local facility.

## Decision

A composer line starting with `!` runs on the machine this client runs on. `Submission` gained a `shell` kind in `ui/commands/parse.ts`; the shell domain is `src/shell/`, which is the only unit allowed to import `node:child_process` — `tests/architecture/dependencies.test.ts` now carries a `shell` unit and a `PROCESS_MODULES` rule shaped like the existing filesystem rule, so a `spawn` anywhere else fails the gate.

`runner.ts` spawns `$SHELL -c` (falling back to `/bin/sh`) with `detached: true`, so the child owns a process group: cancellation signals the group, which is what makes Ctrl+C behave like a terminal instead of leaving pipelines and background children holding the pipes. stdout and stderr merge into one line stream; a line longer than 8 KiB is emitted once, truncated with `…`, and the rest of that line is discarded, so a command that never emits a newline cannot grow memory. SIGTERM has a two-second grace before SIGKILL.

`ShellController` owns at most twenty blocks, each capped at 200 lines and 64 KiB with the dropped count recorded, and runs one command at a time — a second `!` is refused rather than queued. Either Esc or Ctrl+C, with an empty prompt and no dialog holding the keyboard, stops the running command by killing its process group before those keys mean anything else. Output publishes on an 80 ms cadence; a status change publishes immediately.

The block is rendered **inline, at the point in the conversation where it happened**. Each block records the durable sequence that was newest when the command started, and `mergeShellRuns` (`ui/chat/shell-view.ts`) splices it in front of the first message newer than that anchor, so a message arriving afterwards appears below the block and the block scrolls away with the history instead of sitting pinned to the bottom of the screen. Equal anchors keep creation order; an anchor older than a block already placed is clamped after it, so paging history in behind the reader keeps the merged stream ordered. The merged total replaces `layout.length` in the scroll arithmetic, and the merged viewport reads alternating host-row and block-row segments, asking `layout.viewport` only for the visible host range, so the host record's offsets and reclamation stay untouched. The command line carries `HistoryRow.highlight` (drawn on the theme's `shell` bar so it reads as this machine rather than the agent). Wrapping happens before the `  ⎿  ` gutter is added, so a wrapped line stays inside the block and the row count matches what the viewport scrolls.

## Alternatives considered

A dedicated panel above the composer was rejected after the first design pass: it separates the command from where the reader is looking, and the reader asked for the inline form Claude Code uses. Putting the block inside `Transcript` was rejected because a local command has no durable sequence and would have to pretend to be a host message — the client would then persist it, count it against the history budget, and offer it to `/export`. Sending the output to the model was rejected as a default: it costs tokens and can carry paths and secrets out of the operator's machine; a reader who wants that can copy the output. Recording `!` in the prompt recall index was rejected by the reader: it is a command, not a prompt.

## Consequences

`tests/shell/runner.test.ts` pins line streaming, ordering across both pipes, exit codes, the over-long-line truncation, and that cancellation kills the process group. `tests/ui/app.test.tsx` pins that `! echo …` prints inline, reaches no `session/prompt`, that a block stays above a message which arrives after it, that Esc stops a running command without cancelling the agent turn, and that a client constructed with shell disabled refuses the prefix. `tui-design.md` 2.6 / 4.8 / 5.3 / 7.2 / 7.6 and the appendix record the domain, the bounds and the flag. The README pair documents `!` — what it runs on, the caps, and `--no-shell` / `DSHT_NO_SHELL=1` — and the pairing record was rehashed. The output is deliberately read-only: copy mode is the path to the model, and the client offers no shortcut that pours a command's output into the composer. Known limits: the child gets no TTY, and there is no run list.
