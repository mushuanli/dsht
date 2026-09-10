# Agent Note: Assistant headings by user group

Status: implemented

## Problem

Each assistant message displayed a heading, repeating the same role between reasoning, tool calls, and subsequent prose.

## Decision

The terminal layout displays one assistant heading after each User message. Context and tool-only rows preserve the group without consuming its first prose heading. Live output omits its heading when the committed group already has one. The first loaded history segment starts a visible group without fetching earlier records.

Each indexed segment records whether it displays a heading and whether its group has already displayed one. Row and height caches include heading visibility. Appends inherit the preceding segment state; replacements and prepended pages rebuild the affected suffix. Stored messages and sequence offsets remain independent of visual grouping.

## Alternatives considered

Mutating stored assistant messages would couple content to its loaded neighbours. Scanning the transcript for every live frame would add work unrelated to the changing stream.

## Consequences

Repeated role labels disappear while tool status, reasoning links, and message text remain available. The existing bounded row cache and viewport rendering remain in use. Regression tests cover user boundaries, tools, Context, streaming, prepended history, and replacement of the visible window.
