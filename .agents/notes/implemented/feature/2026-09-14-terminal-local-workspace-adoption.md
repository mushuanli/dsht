# Agent Note: Starting inside a workspace directory skips the workspace picker

Status: implemented

## Problem

The client always opened on the workspace picker, even when it was started from a directory the host already had registered. Running `dsht` in a project answered "which workspace?" with the current directory, so the first thing every session cost was one keystroke of confirmation, and the list could not be right when the same directory was registered under a different name.

## Decision

`SessionController.adoptLocalWorkspace(directory)` matches the client's working directory against the registered workspace paths and adopts the best one, and `Controller.ready()` calls it right after the first list fetch, before the reader would have to choose. The match is on whole path segments — the directory must equal a workspace path or start with it plus a separator, with backslashes normalized — so `/srv/app-old` cannot match `/srv/app`, and the longest matching path wins so a workspace nested inside another is preferred. Adopting calls the existing `pickWorkspace`, so the screen becomes the session list, the status line reads `Workspace from this directory · ← to switch`, and `←` in that list still returns to the workspace picker.

The shortcut only runs when the command line did not already name a session, so `--session` keeps opening directly. Nothing else changes: a host whose paths differ from the client's — the normal case for a remote host — matches nothing and the picker appears exactly as before, as does a directory that no workspace contains.

## Alternatives considered

Matching only the exact registered path was rejected because starting in a subdirectory of a project is at least as common as starting at its root, and the segment rule keeps that safe. Auto-opening the newest session as well was rejected: the reader asked to skip the workspace question, not the session one, and silently resuming a conversation would be a much larger surprise. Adding a flag to control the shortcut was rejected as unnecessary — `cd` decides it, and `←` undoes it in one keystroke.

## Consequences

`tests/ui/app.test.tsx` adds a case that starts with the client directory set to the fixture's registered workspace path and asserts the screen is the session list with `w1` selected, that the frame no longer offers the workspace picker, and that the status line explains why; a second case asserts an unrelated directory leaves the picker in place and that matching is by segment (`/host/project/src/deep` adopts `w1`, `/host/project-old` does not). `tui-design.md` 2.6 / 4.1 / 7.2 and the README pair record the behaviour. No new state, no new dependency, and no change for remote hosts.
