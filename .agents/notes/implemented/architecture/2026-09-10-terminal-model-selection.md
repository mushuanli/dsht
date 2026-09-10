# Agent Note: Terminal model selection and agent-preset status

Status: implemented

## Problem

The terminal displayed model telemetry but offered no model selector. Users also could not see the session's named agent preset in the fixed header.

## Decision

Use the Session Controller's existing `session/modelCatalog` and `session/selectModel` endpoints. The catalog owns provider/model IDs and optional reasoning efforts. `/model` opens a model picker followed by an effort picker when supported, or accepts explicit provider, model, and optional effort IDs. Provider failures stay visible alongside healthy choices. The host validates and normalizes the selection, records it for subsequent requests, and attempts to save its deployment default. The selector explains that scope before selection. No host files are edited.

The model display remains driven by `modelSelection.next` and `lastUsed`, without fabricated projection sequence numbers or optimistic changes on failure. Catalog loads and mutation acknowledgements check the selected session generation before affecting the UI. The selector closes on session replacement, another command, or Escape.

The `agentPreset` projection supplies the current preset ID, matching the web AgentPresetLabel. `agentPresets/list` supplies trust and display metadata. Known system presets render Standard mode, PTC mode, Minimal mode, and Creator mode; custom metadata stays unchanged, and missing entries fall back to IDs. The optional roster loads once per connection when a selected session names a preset, with connection guards and teardown tracking shared with catalog tasks. Plan is independent and is not used as the mode label. Narrow terminals omit the mode from the header while `/status` retains it.

## Alternatives considered

Editing provider configuration or guessing a model-selection endpoint bypasses the host's selection validation and durable projection. Hardcoded effort levels would reject adapter-specific choices. Applying the new model to the current request would misrepresent the host's next-request behavior.

## Consequences

Model switching also attempts to update the host default; this API offers no session-only persistence flag. Current requests continue with their existing selection. The preset label is read-only, as on the web session header; a started conversation cannot change its agent composition. Type checks, build, terminal regression tests, and HTTP fixture assertions cover selection payloads, optional effort, provider failures, rejected mutations, and all four built-in mode names, custom names, unknown IDs, and roster request reuse.
