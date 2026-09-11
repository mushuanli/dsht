/** Workspace and resume navigation retain explicit scope and long aliases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationCommand } from '../../src/session/navigation.ts';

test('workspace and resume commands resolve with their aliases', () => {
  for (const name of ['ws', 'workspace', 'workspaces']) {
    assert.deepEqual(navigationCommand(`/${name}`), { kind: 'workspace', query: undefined });
    assert.deepEqual(navigationCommand(`/${name} Project α`), { kind: 'workspace', query: 'Project α' });
  }
  for (const name of ['resume', 'session', 'sessions']) {
    assert.deepEqual(navigationCommand(`/${name} all`), { kind: 'session', query: 'all' });
    assert.deepEqual(navigationCommand(`/${name} "all"`), { kind: 'session', query: '"all"' });
  }
  assert.equal(navigationCommand('/s all'), undefined);
  assert.equal(navigationCommand('/steer hello'), undefined);
  assert.equal(navigationCommand('/wsuffix'), undefined);
});
