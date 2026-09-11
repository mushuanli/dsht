# Agent Note: Markdown in indexed terminal history

Status: implemented

## Problem

Conversation rows wrapped Markdown source literally. Tables lost column alignment, and Mermaid and TeX remained unreadable source. Rendering rich content only in the React viewport would make measured history offsets disagree with the displayed row count.

## Decision

The session layout uses Marked to parse text parts before indexing their terminal rows. Headings, inline emphasis, links, lists, quotes, fenced code and GFM tables produce plain row text plus local style spans. Ink applies those styles after layout; remote controls are removed before parsing and after entity decoding. Reasoning and tool parts retain their existing presentation. The transcript keeps source for search and host-log export.

Tables allocate widths in terminal columns and wrap each cell. When columns cannot retain twelve content columns on average, rows become labeled vertical records. Beautiful Mermaid renders closed supported diagrams as Unicode grids. Wide Chinese characters reserve extra grid cells because the dependency measures code units. Incomplete, unsupported and oversized diagrams display source instead of broken grids.

MathJax compiles base and AMS TeX without extension autoloads or shared macro state. Unicode terminal formulas preserve grouping for fractions, roots, scripts and matrices. Unsupported terminal MathML nodes retain TeX. HTML exports use MathJax-generated MathML and Mermaid SVG image documents, with escaped raw HTML and no executable scripts or remote assets. The export contains only the retained conversation and live tail; tool rows remain summaries. Exclusive writes preserve existing files and remove incomplete output on cancellation.

The incremental plain-text wrap remains active until Markdown syntax appears. Rich live text is reparsed because later table delimiters, references and closing fences can change earlier rows. Immutable part caching avoids repeating work on unchanged frames. Expensive diagram and formula text is cached with limits of 128 entries and 256 KiB of source plus result characters; expressions and diagrams above 16 KiB retain source. Per-layout live state is removed when its part disappears.

## Alternatives considered

**Viewport-only Markdown components.** These would change row geometry after the history index had measured it, breaking scroll offsets and pagination.

**Browser-only rendering.** It would leave tables and ordinary formatting unreadable over SSH. The terminal renders supported content directly, with offline HTML for complete mathematical typesetting.

**Freezing earlier rich rows during streaming.** Markdown can reinterpret earlier text when later delimiters arrive. Plain-text incremental wrapping remains available, while rich parts are reparsed for correctness.

## Consequences

Rich streaming work grows with the active text part, unlike the plain-text fast path. Mermaid supports the dependency's diagram families rather than every Mermaid grammar; formulas approximate mathematical layout in the terminal. The browser export is a view of retained history, not an archive replacement. Keyless transcript snapshots at 32 and 100 columns cover Chinese tables, styles, code, diagrams and mathematics. Delta replay compares streaming with complete parsing, and UI tests cover ANSI geometry and the local HTML export command.
