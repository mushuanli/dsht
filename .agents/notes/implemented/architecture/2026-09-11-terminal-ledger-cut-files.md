# Agent Note: One fixed ledger file per session

Status: implemented

## Problem

Each session's ledger was persisted as `<sha256(sessionId)>-<cut>.json`, so the cut lived in the name and retention was decided by listing the directory and deleting names with a smaller number. Three files of the previous generation (0.91 MB, 2,810 charges) sat in the live directory unread and undeleted, because loading ignores another generation while nothing owned its removal. The name also allowed one session to hold two files at once: a process writing a lower cut recreates a file the newer cut had already replaced, and its cleanup only removes smaller cuts. The three same-session pairs in that directory turned out to be generation-1 files beside their generation-2 successors rather than that race, but the naming permits it.

## Decision

The name is now fixed at `<sha256(sessionId)>.json` and the cut lives in the file. A write reads the existing file first and proceeds only when its cut is not higher, so a scan that opened an older snapshot cannot replace a newer one; `saveLedger` reports whether it wrote, and `CostLedger.replace` leaves its in-memory slice untouched when it did not, keeping memory and disk on the same slice.

Loading normalises the directory to one fixed file per session. A file of another generation, a file whose shape does not parse, and a file under the replaced name are all work the next scan rebuilds, so loading deletes them; when a replaced name holds the newest cut, that slice is rewritten under the fixed name before the old file is removed. Names this unit does not own are left alone.

## Alternatives considered

Keeping the cut in the name and repairing the cleanup was rejected because that naming is what makes two files per session possible, and it forces every save to list the whole directory. Treating the directory as pure cache and clearing it at startup was rejected because the cut and the sealed amounts are the only cross-process record; discarding them re-prices history from the current table. Replacing the files with one SQLite row per session was rejected at this scale: it buys the same structural win and adds a database file plus a schema-migration surface.

## Consequences

`tests/cost/ledger-files.test.ts` covers a refused older write, migration from the replaced name, removal of unusable and superseded files, foreign files left in place, and two ledger instances racing on one directory. Migrating the live directory moved 49 files and 3.10 MB to 46 files and 2.14 MB, with every session's slice byte-identical and the totals unchanged. An older client still writes the replaced name; the next start migrates it, and because loading keeps the highest cut in either name no direction loses data.
