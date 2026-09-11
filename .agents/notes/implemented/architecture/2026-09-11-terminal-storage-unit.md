# Agent Note: A storage unit owns every file operation

Status: implemented

## Problem

Filesystem code sat in four modules that had their own reasons to exist: the cookie store, the session export, the cost ledger files and the CLI price file. Each imported `node:fs` directly, so the private-permission checks, the temporary-file rename and the partial-file cleanup were written three times, and nothing stopped the next module from opening a file of its own. The cost module also carried a `storage.ts`, which read as a second storage layer.

## Decision

`src/storage/` now owns every filesystem operation. `files.ts` exposes `readText`, `readPrivateFile`, `writePrivateFile`, `createPrivateFile`, `writeExclusiveStream` and `removeFile`; `directories.ts` exposes `ensureDirectory`, `ensurePrivateDirectory` and `listEntries`; `index.ts` is the barrel every caller imports. Domains keep their own formats, validation and retention rules, while the unit owns the syscalls, the 0600 file and 0700 directory requirements (each error names the caller's label, so the messages stay unchanged) and the temporary-file rename that makes a write atomic.

Streaming export keeps its ordering through a source callback: `writeExclusiveStream` creates the destination exclusively first and only then asks for the byte stream, so an existing file fails before the host is contacted and any later failure removes the partial file. `cost/storage.ts` is renamed `cost/ledger-files.ts` so only one module is called storage.

The architecture test now rejects any `node:fs` or `node:fs/promises` import outside `storage/`, and the allowed-import table lists `storage` as a dependency of `transport`, `session`, `cost` and `cli`. `storage` itself may import nothing from the other units, which keeps it a leaf.

## Alternatives considered

Keeping the per-domain file code and sharing only small helpers was rejected because the permission, atomicity and cleanup rules are the parts that must not diverge. A generic named-store abstraction was rejected as speculative: every path here is origin- or session-scoped and computed by its domain, so a key-value layer would hide the naming rules instead of owning them. Moving the ledger file format, generation rules and cut pruning into `storage/` was rejected because those are cost-domain contracts, not filesystem mechanics.

## Consequences

Behaviour is preserved: the cookie and ledger error texts, the 0600/0700 modes, the exclusive-create-before-request ordering, the removal of partial downloads, the older-cut pruning and the CLI's create-if-absent price file all keep their previous semantics, and `npm run typecheck` with all 134 tests passes. A future file addition has one place to go, and a direct `node:fs` import anywhere else now fails the dependency gate.
