# Agent Note: A bounded transition trace for connection, screen and selection

Status: implemented

## Problem

The client changes screens from code the reader never typed: a reconnect runs `ready()`, which reloads the pickers and may adopt the local workspace and re-resolve the selected session. When one of those transitions ends somewhere unexpected, nothing in the process says which transition did it. The memory log records `screen` and `session`, but only as one sample every 30 seconds, so it shows the state after a jump and not the event that caused it, and it cannot distinguish "the reader pressed Escape" from "a reconnect landed on the picker". The concrete report that motivated this was the client periodically returning to the session list — the screen `/resume` opens — in the middle of a conversation.

## Decision

The interactive client enables a bounded transition trace by default at `<state>/trace.log`. `TraceLog` appends one JSON event per line and records, at the point each decision is made, a `generation` event (`begin`, `ready`, `ended`, `settled`), the `picker` it asked for, the `adopt` match of the client directory against the registered workspaces, the session `resolve` including whether it re-selects and why, and an `action` event for every screen-changing entry point the UI drives. In addition, `Controller.update()` records a `state` event whenever `screen`, `sessionId`, `workspaceId` or `online` changes, carrying the previous and new value (`"chat -> sessions"`, `"s1 -> none"`), so a transition that had no matching cause event is still visible instead of silently skipped.

The file is bounded by construction and the writes never block a state update: `record()` chains its append behind the previous one, reaching 2,000 appended lines rewrites the file atomically with a header and the newest 2,000 lines, and a write failure is remembered and reported on the log while the client keeps running. Events contain identifiers and screen names only — never prompt, tool, reasoning or session text.

`--trace <path>` and `DSHT_TRACE` replace the path, `--no-trace` and `DSHT_TRACE=off` disable it, an empty `--trace` value fails at startup instead of silently falling back, and a library consumer that constructs `Controller` without a path gets no trace. The memory log and the trace share one path resolver so the two diagnostics cannot drift apart.

## Alternatives considered

Extending the memory sample with a rolling list of transitions was rejected: the list would still be written only on the 30-second tick, so the events around a jump could be lost, and the sample already carries the layout, cache and scan counters that make it expensive to take eagerly. Logging to stderr was rejected because it would corrupt the Ink frame. Logging every state patch was rejected as noise: the trace only writes when one of the four fields that decide what the reader sees actually changes. Making the trace opt-in was rejected because the report it exists to explain is intermittent, and a diagnostic that is off until the next reproduction is usually off.

## Consequences

The trace made the reported jump explainable without a debugger: on a reconnect taken while the client is reading a session, `ready()` still calls `adoptLocalWorkspace` because its guard only excludes the `sessions` screen, so the client directory is adopted, `pickWorkspace` clears the selection, and the `resolve` event records `session: "none", reselect: false` after a `state` event `"workspaces -> sessions"` and `"s1 -> none"`. Whether `ready()` should adopt at all while the captured screen is `chat` is a separate behavior decision; the trace records the chain either way. Two tests cover the file (header, append, private mode, directory creation) and the reconnect chain above. `README.md`, `README.zh.md` and the design document's CLI, storage and file tables record the flags, the defaults and the fact that no message text is written.
