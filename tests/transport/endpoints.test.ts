/** The capability table is the only list of host endpoints, and every name in it is real.
 *
 * `slash.md` §10 makes the transport dimension a checklist item: a new host capability is one facade
 * function plus one contract/endpoint row. This test is what makes that mechanical — the source may not
 * reach an endpoint the table does not know, the table may not name an endpoint nothing calls, and a
 * row may not name a reader the module does not export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_ENDPOINTS, HOST_ENDPOINT_NAMES } from '../../src/transport/endpoints.ts';
import * as contract from '../../src/transport/dsh-contract.ts';
import * as events from '../../src/transport/events.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Every TypeScript source file under src, as paths relative to `src`. */
function sourceFiles(directory: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) out.push(...sourceFiles(absolute));
    else if (/\.tsx?$/.test(entry)) out.push({ path: relative(SRC, absolute).split(sep).join('/'), source: readFileSync(absolute, 'utf8') });
  }
  return out;
}

/** Every endpoint the source can reach: RPC calls, subscriptions, and the one raw HTTP path. */
function reachedEndpoints(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const match of file.source.matchAll(/\.(?:call|subscribe)\((['"])([^'"]+)\1/g)) found.add(match[2]!);
    for (const match of file.source.matchAll(/\/api\/(session\.[a-zA-Z]+)/g)) found.add(match[1]!);
  }
  return found;
}

test('the source and the capability table name exactly the same endpoints', () => {
  const found = reachedEndpoints();
  assert.ok(found.size > 5, `expected the transport calls, found ${found.size}`);
  assert.deepEqual([...found].filter(endpoint => !HOST_ENDPOINT_NAMES.has(endpoint)).sort(), [],
    'a host call must have a row in transport/endpoints.ts (slash.md §10)');
  // A row nothing reaches is how a removed capability keeps looking supported.
  assert.deepEqual([...HOST_ENDPOINT_NAMES].filter(endpoint => !found.has(endpoint)).sort(), [],
    'this capability is no longer called; drop its row and its contract section');
});

test('every row names readers that exist, and every endpoint is listed once', () => {
  const seen = new Set<string>();
  for (const row of HOST_ENDPOINTS) {
    assert.equal(seen.has(row.endpoint), false, `${row.endpoint} is listed twice`);
    seen.add(row.endpoint);
    const owner = row.owner === 'contract' ? contract : row.owner === 'events' ? events : undefined;
    // A renamed decoder must fail here rather than rot in a comment: the row is the upgrade's map.
    if (owner === undefined) {
      assert.deepEqual([...row.readers], [], `${row.endpoint} declares no owner, so it cannot name readers`);
      continue;
    }
    assert.ok(row.readers.length > 0, `${row.endpoint} names an owner but no reader`);
    for (const reader of row.readers) {
      assert.equal(typeof (owner as Record<string, unknown>)[reader], 'function',
        `${row.endpoint} names ${reader}, which ${row.owner} does not export`);
    }
    // A stream row reads items one at a time; every other row reads the value the call returned.
    assert.equal(row.posture === 'raw' || row.posture === 'void',
      row.readers.length === 0 || row.posture === 'void', `${row.endpoint}: a ${row.posture} value has readers`);
  }
  // The one non-RPC capability is named for its path, because that is what the source reaches.
  assert.equal(HOST_ENDPOINT_NAMES.has('session.export'), true);
  assert.equal(HOST_ENDPOINT_NAMES.has('session/export'), false);
});
