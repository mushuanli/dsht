# Agent Note: Automatic terminal steering and host commands

Status: implemented

## Problem

Terminal users need follow-up input to affect the active task without choosing a delivery mode. Pending input needs a visible, removable representation. The host also provides plan, goal, permission, feedback, and archive features that the terminal cannot expose through ordinary model prompts.

## Decision

Ordinary input uses `session/prompt` with `steer` while the selected agent is running and `queue` while idle. The host owns next-step admission and consumption; the terminal maintains no second pending-message queue. `session/control` retains pending item identities, placement, and text previews. The composer shows pending user input, and `/queue` opens a picker whose explicit delete action calls `session/updateQueue`. A claimed item produces the host's not-found error instead of being resubmitted. Context-only injections are excluded from user deletion. Reconnect baselines replace the observed pending list.

Questions and approvals supersede the queue picker, including its reserved keys. Queue callbacks check the current pending-interaction state before dispatch, and prompt admission rejects while an interaction is pending. Answers still use the event-result API. Closing the queue picker with Escape does not cancel the agent.

`/plan`, `/goal`, `/permission`, and `/feedback` use the same direct command execution path as `/compact`; host plugins own arguments, availability, and busy rules. Successful results may omit text. Feedback is excluded from input recall. The command list is explicit, and paginated help keeps its later entries accessible on short terminals. `/export` consumes the authenticated session archive route directly because the web command itself only announces a browser download. Local files are opened exclusively, written as streams, and removed if incomplete; an existing destination is never replaced.

## Alternatives considered

A local steering queue would duplicate the host's durable pending items and create reconnect and double-send ambiguity. Waiting for the entire turn would delay steering beyond the next available step. Sending slash commands as model prompts would bypass their registered handlers. Running the web export command without downloading its archive would report success without creating a file.

## Consequences

Pending previews and deletion require the host control stream and queue API. The terminal can delete but cannot edit pending text. Already claimed input cannot be withdrawn. Host command results remain local notices rather than durable terminal conversation cards. Tests use authenticated HTTP/WS fixtures to cover automatic delivery modes, deletion races, interaction precedence, command outcomes, paginated help, and archive bytes, exclusive creation, and cancellation cleanup; an expected-output fixture pins composer previews.
