/** Short navigation commands retain explicit scope and long aliases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationCommand } from '../src/navigation.ts';

test('short and long navigation commands resolve to the same actions', () => {
  for (const name of ['ws', 'workspace', 'workspaces']) {
    assert.deepEqual(navigationCommand(`/${name}`), { kind: 'workspace', query: undefined });
    assert.deepEqual(navigationCommand(`/${name} Project α`), { kind: 'workspace', query: 'Project α' });
  }
  for (const name of ['s', 'session', 'sessions']) {
    assert.deepEqual(navigationCommand(`/${name} all`), { kind: 'session', query: 'all' });
    assert.deepEqual(navigationCommand(`/${name} "all"`), { kind: 'session', query: '"all"' });
  }
  assert.equal(navigationCommand('/steer hello'), undefined);
  assert.equal(navigationCommand('/wsuffix'), undefined);
});
