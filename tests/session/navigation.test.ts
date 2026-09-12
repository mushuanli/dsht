/** Workspace and resume navigation retain explicit scope and long aliases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityAge, navigationCommand, sessionState, sessionStatus, SESSION_MARKERS, workspaceStatus } from '../../src/session/navigation.ts';

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

test('a session summary classifies into a marker without inferring a stall', () => {
  assert.equal(sessionState({ running: true }), 'running');
  assert.equal(sessionState({ running: true, blank: true }), 'running');
  assert.equal(sessionState({ running: false, blank: true }), 'blank');
  assert.equal(sessionState({ running: false }), 'idle');
  assert.equal(sessionState({}), 'idle');
  assert.deepEqual(SESSION_MARKERS, { running: '◐', idle: '●', blank: '○' });
});

test('activity ages stay coarse and never render a negative or missing duration', () => {
  const now = Date.parse('2026-09-12T12:00:00+08:00');
  assert.equal(activityAge(undefined, now), '');
  assert.equal(activityAge(Number.NaN, now), '');
  assert.equal(activityAge(now - 30_000, now), 'now');
  assert.equal(activityAge(now - 5 * 60_000, now), '5m');
  assert.equal(activityAge(now - 3 * 3600_000, now), '3h');
  assert.equal(activityAge(now - 2 * 86_400_000, now), '2d');
  assert.equal(activityAge(now + 60_000, now), 'now');
  assert.equal(sessionStatus({ running: true, updatedAt: now - 120_000 }, now), '◐ 2m');
  assert.equal(sessionStatus({ running: false }, now), '●');
  assert.equal(sessionStatus({ blank: true }, now), '○');
});

test('a workspace counts the sessions it accounts by the state each reports', () => {
  assert.equal(workspaceStatus([]), '');
  assert.equal(workspaceStatus([{ running: false }]), '● 1');
  assert.equal(workspaceStatus([{ running: true }, { running: true }, { blank: true }, { running: false }]), '◐ 2  ● 1  ○ 1');
  assert.equal(workspaceStatus([{ blank: true }, { blank: true }]), '○ 2');
});
