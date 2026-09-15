# Agent Note: Layered boundaries and a plain UI contract

Status: implemented

## Problem

The modular split of 2026-09-11 left five couplings that the directory layout could not express, and every one of them had already produced a real defect or a near-miss:

1. **The UI knew the application.** `StatusBar` and `CostPanel` took the whole `Controller`, and `app.tsx` reached 232 controller call sites. A leaf component therefore had access to switching sessions, deleting workspaces and selecting models.
2. **The UI imported the transport domain.** `safeText` lived in `transport/wire.ts`, so `session/`, `ui/` and `cli/` all imported the wire to clean text, and the rule "the UI must not call the transport client" was one rename away from being decorative.
3. **`session` parsed the wire.** `SessionController.waterfall(frame: ObjectValue)` read `frame.event` and `frame.request` itself, and `ConnectionController` owned `Telemetry`, `runningUpdates` and `observedRunningAt`, so a host field rename or a socket change reached the session domain directly.
4. **One class held three lifetimes.** `SessionInfo` carried business data (`record`, `prompts`, `interaction`), reading state (`view.scroll`, `view.folds`, `view.liveReasoning`) and pure keyboard state (`composer.cursor`, `reference.index`, `panels.*`), reset by one `reset()` whose behaviour depended on call order.
5. **The facade was a second god object.** `Controller` exposed about seventy methods, of which a large share were getters, formatters and one-line domain passthroughs, and `perform(operation)` let a caller hand the application a closure to orchestrate.

## Decision

The application is described by forbidden edges rather than by layer numbers, because the real graph branches: `ui → controller`, `ui → contracts`, `controller → features`, `features → infrastructure`. `tests/architecture/dependencies.test.ts` enforces nine of them, with one synthetic rejection case per edge and **no exemptions**:

| # | Forbidden | Why |
| --- | --- | --- |
| B1 | `ui/*` → `controller` except `ui/app.tsx` and `ui/mount.tsx` | a leaf receives props and callbacks, never a capability |
| B2 | `ui` → `transport` | the wire is not a presentation dependency |
| B3 | `ui` → any feature | types and view models are read through `contracts.ts` and `src/*.ts` leaves |
| B4 | feature → `ui` | the domain does not know a screen exists |
| B5 | `controller` → `ui` | there is no `UiControl`: the UI owns its own mechanisms |
| B6 | feature → feature, including `import type` | cross-feature work is orchestrated by the application |
| B7 | feature → `controller` | the domain does not depend on orchestration |
| B8 | `transport`/`storage` → anything above | infrastructure never learns an upper-layer name |
| B9 | `slash` → anything but itself | the command syntax is a pure leaf |

Supporting decisions:

- **Wire decoding has one home.** `transport/events.ts` turns `$events` frames into `HostEvent` and `session/control` frames into `ControlFrame`. `connection` decodes and calls `listener.event(event)`; `Controller.event` routes to `session`, `catalog` or `cost`. `connection` therefore names no session concept, and `session` reads no host field name. An unrecognized waterfall becomes `waterfall-delegate`, which keeps the "reply `{kind:'next'}` or the host's event chain blocks" invariant that returning `undefined` would have dropped.
- **State belongs to its owner, and `AppState` only composes it.** `connection`/`session`/`cost`/`catalog`/`shell` each own their own state object; `State` holds `operation` (the application's busy/error envelope), the feature snapshots and `session`. `Telemetry` and `runningUpdates` moved into `session/runtime.ts`, shrinking `ConnectionView` from six members to `fail` and `reply`.
- **State sits as close to its user as possible.** `SessionInfo` keeps only `sessionId`, `record`, `prompts`, `window` and `interaction`. The composer (draft, caret, parked draft), the `@` menu highlight, the five panel flags and the reading view (scroll, folds, live-reasoning mode) are component state in `ui/app.tsx`, cleared on a session switch by one effect, which reproduces the previous "a draft never follows the reader" behaviour without a second owner. `pinned` became a private flag on `SessionController`, because it is an input to reclamation rather than session data.
- **Commands split three ways.** `slash/parse.ts` answers "what does this line mean" with no UI facts; `ui/routing.ts` answers "what does Enter mean right now" and applies the screen/pending guards; the application answers "may this run now".
- **The controller exposes three surfaces.** Lifecycle (`start`/`stop`/`shutdown`), `actions` (mutating, each owning the busy/error envelope and reporting completion) and `queries` (read-only). The remaining fifty-odd implementation methods are private and `perform` is gone: `runAction`/`runActionValue` are private, so a caller no longer supplies orchestration.
- **The UI reads plain data.** `contracts.ts` is a types-only module (mechanically checked to contain no `const`, `function` or `class`); `StatusSource` and `CostSource` replaced the controller arguments of `StatusBar` and `CostPanel`; `Queries.render` returns `SessionRender` so the projection engine is not imported by the UI. Presentation that used to live in features moved next to its components: the session/workspace list vocabulary to `ui/chat/navigation-model.ts`, `costText` to `ui/status/model.ts` and `plainRows` to `ui/chat/shell-view.ts`. Functions needed by both a feature and the UI live in dependency-free leaves instead: `json.ts`, `text.ts` (`safeText`, `errorText`, `toolLine`), `session-title.ts` and `references.ts`.

## Alternatives considered

- **A `stat/` store module owning `AppState` and `SessionInfo`.** Rejected: state that lives in one technical module depends on every feature it describes, so it becomes the next coupling centre rather than a base layer.
- **A `UiControl` owned by the controller** (so session switches could close dialogs). Rejected: it makes business code aware of modals, notices and copy mode, and every future front end would inherit that knowledge. The UI closes its own surfaces from `state.sessionId`.
- **A `slash/` domain with a `SlashHost { session, navigation, cost, ui }` and its own executor.** Rejected: it would know both the UI and the business actions, which is the application's job; only the syntax earns a leaf.
- **View models in `stat/selectors/`.** Rejected: a status bar changing its column order would then edit the state layer. They live beside the component, and only cross-feature composition is an application concern.
- **Keeping `ObjectValue` in a `core/types.ts` to dodge the state → transport rule.** Rejected as relocating the coupling; host rows are read through `json.ts` readers until typed summaries land.
- **Feature-to-feature type imports allowed "because they are only types".** Rejected: a type dependency is still a change dependency.

## Consequences

`npm run typecheck`, `npm test` (265 tests) and `npm run test:terminal` pass, and the terminal golden files are byte-identical, so no user-visible behaviour changed. The intentional semantic changes are internal: an action reports failure by returning `false`/`undefined` and writing `operation.error` instead of throwing, so the dialogs, the answer flow and the composer now guard explicitly where they previously relied on an exception skipping the following statements.

`SessionController` and the facade lost sixteen session-state methods, `ConnectionView` lost three, and the facade's public surface is lifecycle plus two named contracts. The gate rejects each forbidden direction with a synthetic case, so a regression fails with the rule it broke rather than as a rendering surprise.

Still open, and deliberately recorded rather than silently dropped: the UI still passes `Transcript` values (`Queries.render`, `older`, `historyAt`, `setViewWindow`) where a `SessionSnapshot` and a `HistoryPage` were planned; host list rows are still `ObjectValue` until typed summaries land; and `operation.error` still carries connection, session and action failures in one line because splitting them changes what the UI shows. `tui-design.md` and the README pair were refreshed in the same change.
