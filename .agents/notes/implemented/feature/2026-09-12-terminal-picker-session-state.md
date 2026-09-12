# Agent Note: The pickers show what a session is doing

Status: implemented

## Problem

`/ws` and `/resume` described their rows with a title and an identifier, and the only activity they showed was a single `●` before a running session's title. A workspaces row said nothing at all about its sessions, so choosing between two workspaces meant opening both to see which one had work in flight, and a session that had never run a turn looked exactly like one that had finished a long conversation hours ago.

## Decision

Both pickers read the state the session list already carries, without loading any session's history. A session row leads with a marker and the age of its last activity: `◐ 2m` while its agent works, `● 5m` after it has run a turn, and `○` before its first one. A workspace row leads with the same markers counted over the sessions the workspace accounts to, running first, so `◐ 1  ● 1  ○ 1  Project α  /host/project` answers which workspace is busy before it is opened.

`sessionState`, `SESSION_MARKERS`, `activityAge`, `sessionStatus` and `workspaceStatus` in `session/navigation.ts` hold the classification so both pickers and their tests share one definition. The classification reads only `running` and `blank` from the host summary and never infers a stall from silence: the age is the host's `updatedAt`, and a session with no reported activity shows its marker alone. Ages stay coarse — `now`, minutes, hours, days — so a row does not change while the user reads it.

## Alternatives considered

Deriving a "waiting for you" state from a running session whose `updatedAt` has stopped advancing was rejected because a long tool run is indistinguishable from a blocked prompt, and the host publishes no signal that separates them: the approval audit pair (`approval/asked`, `approval/decided`) is durable in the session log but no list projection exposes it. Showing that state needs a host-side projection, which is a separate change. Sorting waiting sessions first was rejected for the same reason. Loading each session's tail to inspect it was rejected because reading a tail requires following the session, which would subscribe to every session in the list.

## Consequences

`tests/session/navigation.test.ts` covers the classification, the coarse ages, the negative-duration clamp, and the workspace counts. `tests/ui/app.test.tsx` renders both pickers from a fixed list and asserts the markers, the ages and the rollup. A workspace with no sessions shows no marker rather than a zero count, and a session whose activity age is unknown keeps its marker alone.
