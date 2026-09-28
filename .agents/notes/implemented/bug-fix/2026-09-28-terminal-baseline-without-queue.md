# Agent Note: A baseline without a queue section is still a baseline

Status: implemented

## Problem

The installed host (`dsh` 0.1.7-rc.2) sends a `session/control` baseline of `{ projections }` only — it has no queue or job stream — while `controlFrame()` demanded `baseline.queues` and `baseline.jobs` as objects. `object(undefined)` threw "Expected a JSON object from the server", so the whole baseline was discarded: `Telemetry.ready` stayed false, every later projection frame reported "Session control update before baseline", and the status bar showed `⚠ Metrics` with `Context`/`tok`/`turns` frozen at whatever the `session/follow` snapshot carried. The failure looked like a broken host when the client was simply refusing a capability that host never claimed.

## Decision

The three baseline sections are capabilities, not a fixed schema. `controlFrame()` reads each through `optionalRows()`: an absent section is an empty map, a present section that is not an object is still a protocol error, and `projections` remains the one section a baseline must carry because there is nothing to apply without it. A projections-only baseline now sets `ready` and the projection frames that follow apply, so the bar returns to `● Ready`; `Queued ?` and `Jobs ?` stay unknown because that host reports no queue, which is the honest reading rather than a claim of "none".

## Alternatives considered

Treating the missing sections as an error was the status quo and is what this fixes: it discarded the projections the host did send, so a capability the client does not need (a queue stream) disabled one it does. Making the host always send the sections was rejected: the host is released separately, the client must tolerate a host that predates the queue stream, and `dsht` connects to whatever `dsh` is installed. Buffering the updates until a baseline arrives was rejected as unnecessary: the baseline supersedes them, and accepting the snapshot is what makes the stream usable.

## Consequences

`tests/transport/events.test.ts` fixes the projections-only baseline and the present-but-malformed section, and `tests/ui/status.test.ts` asserts that such a baseline starts telemetry with unknown queue and job counts. The README pair is unchanged, because the wire shape is not user-facing, and section 3.2.1 of `tui-design.md` marks `queues` and `jobs` optional.
