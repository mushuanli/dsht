# Agent Note: A seeded price file follows the shipped table

Status: implemented

## Problem

The Flash rates first published in `prices.json` charged three yuan per million input tokens and ten cents per million cached tokens, and an hour later the shipped defaults were corrected to the published two and four cents. The correction never reached any install: `prices.json` overrides the shipped table, it is created with an exclusive create that never replaces it, and the ledger seals each amount at decision time so a later table cannot move it. One user's ledger recorded ¥151.65 for three days that the published table prices at ¥91.18, every per-day subtotal was wrong by a different factor, and a second defect in the same file compounded it: the superseded file named only the old model aliases, so 5,310 requests whose model was reported as a later alias were left with no price at all. The overall figure happened to land near the truth, which is exactly why nobody noticed for two days.

## Decision

The seeded file is now tracked. `prices.seed.json` records a revision and the digest of the bytes the tool wrote, and `loadPrices` compares the two: while the file still hashes to the record the tool owns it and rewrites it from the table this build ships, and the first edit makes the file authoritative so no rate a user chose is ever overwritten. A file with no record predates it, so only an exact match to the superseded seed is replaced — anything else may be a table written by hand. Nothing is written when nothing changed, so an unchanged configuration needs no write at all and a read-only directory still starts.

`CostLedger.reprice()` decides every stored charge again from the sample it recorded, because a charge keeps the provider, model, time and tokens it was decided from, and `--reprice` runs it. That is the repair for an amount sealed under a table that was wrong, and the way a corrected table reaches amounts already recorded; without a terminal the repair is the whole run and prints how many charges moved.

The published table also keeps V4 Pro on its own rates past 2026-09-14, so the interval is open and the entry that billed Pro at Flash rates after that date is gone.

## Alternatives considered

Leaving the file authoritative and telling the user to edit it was rejected because the defect was ours and nothing in the panel said the rates came from a file at all. Refreshing the file on every start was rejected because it would erase a rate the user set. Deleting the file when it matches the superseded seed was rejected because the seed is the documented place to read and change rates, and rewriting it keeps that true. Repricing automatically whenever the table changes was rejected because it makes a recorded amount depend on when the process happened to run; the repair stays an explicit flag, and `/cost` now names a user-supplied table so a wrong one is visible rather than silent.

## Consequences

`tests/cost/config.test.ts` covers seeding, the refresh of an unedited file, an edited file surviving, the superseded seed being replaced, an unstamped table being left alone, the read-only case, and that repricing persists and leaves requests without usage untouched. `tests/cost/cost.test.ts` pins the rates to the published table, including the superseded model aliases that must still be priced. The pre-`from` requests of 2026-09-07 to 2026-09-09 stay unpriced and are counted as such, because no published rate covers them and guessing one would be worse than reporting it.
