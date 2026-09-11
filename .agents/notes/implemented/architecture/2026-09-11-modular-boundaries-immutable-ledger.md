# Agent Note: Modular boundaries and an immutable cost ledger

Status: implemented

## Problem

This repository concentrated unrelated responsibilities in three files: `controller.ts` (854 lines) mixed connection lifecycle, session history, model metadata and billing; `app.tsx` (717 lines) mixed command knowledge, presentation and the UI state machine; and `cost.ts` (285 lines) mixed price tables, record folding, persistence and summary. Billing also re-priced every stored request from the currently loaded `prices.json` on each scan, so editing the table rewrote amounts the user had already been shown.

## Decision

Source is organised by business domain under `src/`. `transport/` owns the host wire protocol and authentication, `session/` the transcript, layout, telemetry, navigation and interactions, `cost/` pricing, record folding, storage, the ledger, the scanner and its controller, `catalog/` model routes and presets, `controller/` the application facade, `ui/` everything React and Ink, and `cli/` the composition root. `state.ts` holds the shared `State` and `ControllerStore` contract, `transport/host.ts` the `HostAccess` contract, and `session/connection-view.ts` the connection facts the session domain reads.

`Controller` is now a facade over `ConnectionController`, `SessionController`, `CatalogController` and `CostController`. It keeps the constructor and every public method the UI and tests already used, delegates each one, and owns only state publication, the selector generation and lifecycle. Connection generations, reconnect backoff, `$events` and `session/control` belong to `ConnectionController`; the selected session, follow stream, history and interactions belong to `SessionController`; model and preset loads belong to `CatalogController`; the background scan belongs to `CostController` and the per-session read lives in `cost/scanner.ts`.

The cost ledger is immutable. Each charge records the `priceId` and `amount` decided when the request was first evaluated, and a later scan reuses that decision instead of re-pricing from the current table. Only a sample with no usable usage stays open, because that request has not finished reporting tokens; every other decision — priced, estimated or unpriced — is final. The persisted file is generation 2, stores no embedded price version, and a file of another generation is ignored and rebuilt by the next scan instead of migrated.

`app.tsx` keeps the UI state machine and keyboard routing, while presentation and command knowledge moved out: `ui/commands/registry.ts` owns the command catalog, completion and suggestions, `ui/commands/parse.ts` classifies one submission into an action, `ui/dialogs/` owns the picker, the panels and the cost panel, `ui/chat/` owns the header, viewport and status bar, `ui/input/` owns the composer, recall, mouse and reference menu, and `ui/mount.tsx` is the only module that renders through Ink.

`tests/architecture/dependencies.test.ts` enforces the boundary: each unit may import only the units listed for it, React and Ink may appear only under `ui/`, and `ui/` may not call the transport client directly. The package surface is decoupled from the layout through `src/index.ts`, with `@itookit/dsht` resolving to `dist/index.js`, `@itookit/dsht/auth` to `dist/transport/auth.js`, and the `dsht` bin to `dist/cli/index.js`.

## Alternatives considered

Splitting `Controller` per operation into `PromptService`, `QueueService` and similar units was rejected: the original problem is four domains, not many small services, and a service per method would spread one state machine across files that always change together. Keeping re-pricing but adding an invalidation key was rejected because the displayed amount would still move after the fact. Migrating generation-1 cache files was rejected because the cache is disposable and the next scan rebuilds it from host history.

Moving the cost panel under `cost/` was rejected because it renders React; keeping command classification inside `app.tsx` was rejected because completion, help and submission would keep three copies of the command list. Extracting the submission dispatcher into a further `ui/commands/execute.ts` was deferred: it needs a context of roughly twenty React setters, so it would relocate code without reducing coupling.

## Consequences

Behaviour is unchanged for the wire protocol, slash commands, CLI arguments, event semantics and terminal output; the only intentional change is that a decided charge no longer follows `prices.json`. `npm run typecheck`, `npm test` (129 tests), `npm run test:terminal` and `npm run test:package` pass. Tests now mirror the modules, two new cost tests pin immutability, and one new case proves the dependency gate rejects a forbidden direction.

The `README.md` and `README.zh.md` pair documents the immutable ledger and the module layout, and `README.i18n.yaml` records the re-reviewed hashes. `app.tsx` remains around 540 lines: it is the single UI state machine, and its remaining size is cohesive state and routing rather than mixed responsibilities. The cost cache is local state, not configuration, so discarding an older generation costs one rescan and no user data.
