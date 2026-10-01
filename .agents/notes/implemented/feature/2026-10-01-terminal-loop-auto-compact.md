# Agent Note: auto-compaction as a limit a `/loop` run confirms

Status: implemented

## Problem

A scored run is the longest thing this client does. Ten rounds of briefs, replies and verifier
verdicts are all written into one session, so the context grows monotonically while the operator is
not watching it — and the failure is the worst kind: the host starts refusing or silently truncating
the round that matters, minutes into a run that had been passing. `/compact` existed, but only as a
line the operator has to remember to type between rounds, which is exactly when they are not looking.

## Decision

Auto-compaction is a **limit of one run**, not a client setting, and it is confirmed in the same
parameter form that confirms the rounds and the score. The form gains a fifth shared number,
`Auto compact`, measured in thousands of tokens. The score keeps its scale everywhere it is read — `pass 8/10` in the record list and in the lines that announce a run, `8 / 10` in the form — and every row writes the unit it counts — `1 round`, `8 / 10`, `10 per round`, and `off · K tokens` / `150K tokens` for the threshold — so no value is a bare number whose meaning has to be remembered; `0` — the default — never compacts, so nothing
changes for a run that did not ask for it.

The threshold is compared against the host's own projection of the next request's context
(`contextPressure`, the number the status bar shows), never against a client-side estimate of the
transcript: `LoopHost.historyTokens(sessionId)` reads it, and `LoopCoordinator.compactDue` decides.
The check happens where the prompt is already waiting and the client is otherwise ready to send —
`flushLoop`, and the opening send in `startLoop` — so a compaction can never interleave with a
round: the round that follows is the first thing written into the compacted history. Compaction
itself is `LoopHost.compact`, which is the host's `/compact` through the same session layer an
operator's line uses, run under the run's own `AbortController` so `/loop stop`, a session switch,
the deadline or a replacing run cancels it.

Three details that are the difference between a feature and a trap. A host that publishes no context
metric cannot be judged, so the run sends anyway and traces `compact-skip` rather than guessing. A
compaction that fails is a note on the progress line, not a verdict: the round is still worth
running. And because the decision is synchronous when there is nothing to do (`compactDue` returns
undefined), the default path keeps exactly the send ordering it had — an `await` inserted there
would have been long enough for a second `/loop` to take the session. While a compaction runs the
run's activity is the new `LoopActivity` `compact`, so the status bar says `Compacting` instead of
`Agent` for what can be minutes.

The command line still has no flag for it. Like a record's `vars`, the value is a per-run decision
about *this* session's history, and the form is where it is visible before it is spent; `LoopOptions`
carries it back to the application exactly the way `vars` does.

## Alternatives considered

A client-wide setting (`--auto-compact`, an environment variable) was rejected: the right threshold
depends on the run — a ten-round review over a small document is not a three-round retry — and a
global default would either be off for everyone or surprise the runs that did not need it. Using the
transcript's own byte or message count instead of the host projection was rejected because the host
already measures what it is about to send, and two measurements of one thing eventually disagree.
Compacting from a timer was rejected: it would rewrite history under a round that is mid-flight.
Judging the threshold inside `LoopHost` was rejected so the comparison, the note and the trace event
live in one place, next to the run that owns the number. Compacting before the opening send inside
the caller's `Starting loop…` envelope is deliberate and documented: the alternative is sending round
one into a history the run just refused to work with.

## Consequences

`LoopLimits` and `LoopProgress` carry `autoCompactK` (0 = off), `validLoopOption('autoCompactK', …)`
is the one rule the form and the command line share, and `ScoredLoop.compacting()` is the new
sub-state. `tests/controller/loop-coordinator.test.ts` fixes the decision (no metric, under, over,
and a failed compaction that still sends); `tests/controller/loop-run.test.ts` fixes the wiring end
to end — a host projecting 150k makes the run issue `commands/execute /compact` *before* its first
`session/prompt` and note `auto compact · 150k tokens · …`; `tests/ui/loop-form.test.tsx` fixes the
row (`off · K tokens`, `150K tokens`, `0` accepted, a fraction refused); `tests/ui/loop-status.test.tsx` fixes the
`auto 150K tok` suffix (the bar's own short spelling, next to `1K tok`). `loop.md` §4.6, `slash.md` §2.4, `tui-design.md` §3.2 and the README pair
document the field and the missing flag. Version 0.6.18.
