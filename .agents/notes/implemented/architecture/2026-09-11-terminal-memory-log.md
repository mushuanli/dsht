# Agent Note: A bounded runtime memory log

Status: implemented

## Problem

A long-running terminal session shows a rising resident set, and nothing in the client said whether that was retained content or the V8 high-water mark that never returns pages to the operating system. The retained window, the pin state and the ledger size were only visible through a debugger or a test harness, so a report of "memory keeps growing" could not be answered from the running process.

## Decision

The interactive client enables a memory log by default at `<state>/memory.log`. Every 30 seconds it appends one JSON line with the process counters (`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`), the controller state that decides reclamation (`online`, `screen`, `session`, `pinned`, `pending`), the retained content (`records`, `retainedBytes`, `beforeSeq`, `hasMore`, `live`) and, when a ledger exists, its session, charge and unpriced counts. Samples contain counts and sizes only: no prompt, tool, reasoning or session text ever reaches the file.

The file is bounded by construction. Samples append through `storage.appendPrivateFile`, and reaching 1,000 appended lines rewrites the file atomically with a header and the newest 1,000 lines, so it never exceeds twice that between rewrites and never grows without limit. A write failure records the reason on the log, clears its timer and leaves the client running; diagnostics must not become a failure mode of the terminal.

`--memory-log <path>` and `DSHT_MEMORY_LOG` replace the path, `--no-memory-log` and `DSHT_MEMORY_LOG=off` disable it, and an empty `--memory-log` value fails at startup instead of silently falling back. The list subcommands never open it, and a library consumer that constructs `Controller` without a path gets no log.

## Alternatives considered

Calling `global.gc()` on a timer was rejected: measurement shows it drops the live heap while the resident set stays at its high-water mark, so it would add CPU cost without reducing what users observe. Capping the heap with `--max-old-space-size` was rejected as the default because it turns a diagnostic into a tuning decision the deployment should make. Reusing the WeakMap caches was not applicable: the growth that matters is deliberate retention (a pinned window and the ledger history), which weak references cannot release. Logging to stdout was rejected because it would corrupt the Ink frame.

## Consequences

The README pair documents the default path, the option, the environment variable and the fact that it is enabled by default, and the design document records it in the CLI, storage and privacy sections. Three tests cover the sample fields and file mode, the bounded rewrite, and both the absent-path case and a failed write. The cost is one small append every 30 seconds and one 1000-line rewrite per file lifetime; the benefit is that a growth report can be answered by reading a file instead of reproducing it.
