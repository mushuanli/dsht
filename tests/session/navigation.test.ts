/** Workspace and resume navigation retain explicit scope and long aliases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityAge, navigationCommand, ROLLUP_LEGEND, sessionState, sessionStatus, SESSION_MARKERS, STATE_LABELS, workspaceCounts, workspaceDetail, workspaceStatus } from '../../src/session/navigation.ts';

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
  // An answer this client owes is the most actionable state, so it outranks the running flag.
  assert.equal(sessionState({ running: true }, true), 'needs');
  assert.equal(sessionState({ blank: true }, true), 'needs');
  assert.deepEqual(SESSION_MARKERS, { needs: '?', running: '◐', idle: '●', blank: '○' });
  assert.deepEqual(STATE_LABELS, { needs: 'needs you', running: 'working', idle: 'ready', blank: 'empty' });
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
  // The age beside an owed answer is how long that answer has been owed.
  assert.equal(sessionStatus({ running: true, updatedAt: now - 120_000 }, now, true), '? 2m');
});

test('a workspace rollup counts actionable states and leaves blank sessions out', () => {
  assert.deepEqual(workspaceCounts([]), []);
  assert.deepEqual(workspaceCounts([{ running: false }]), [{ state: 'idle', count: 1 }]);
  assert.deepEqual(workspaceCounts([{ running: true }, { running: true }, { blank: true }, { running: false }]),
    [{ state: 'running', count: 2 }, { state: 'idle', count: 1 }]);
  // A session that never sent a turn is the absence of activity, not a state the rollup reports.
  assert.deepEqual(workspaceCounts([{ blank: true }, { blank: true }]), []);
  // Order is the attention each state asks for, not the order the host reports its flags in.
  assert.deepEqual(workspaceCounts([{ sessionId: 'a', running: false }, { sessionId: 'b', running: true }, { sessionId: 'c', running: true }], new Set(['a'])),
    [{ state: 'needs', count: 1 }, { state: 'running', count: 2 }]);
});

test('a rollup spells its states out when there is room and keeps a key when there is not', () => {
  assert.equal(workspaceStatus([]), '');
  assert.equal(workspaceStatus(workspaceCounts([{ running: false }])), '● 1 ready');
  assert.equal(workspaceStatus([{ state: 'needs', count: 1 }, { state: 'running', count: 2 }, { state: 'idle', count: 6 }]),
    '? 1 needs you · ◐ 2 working · ● 6 ready');
  assert.equal(workspaceStatus([{ state: 'needs', count: 1 }, { state: 'idle', count: 1 }], 'badges'), '?1 ●1');
  assert.equal(ROLLUP_LEGEND, '● ready · ◐ working · ? needs you');
});

test('a workspace row shows the path its title does not already name', () => {
  assert.equal(workspaceDetail('/home/li/share/prj/deepseek-harness/tui', 'tui'), '/home/li/share/prj/deepseek-harness');
  assert.equal(workspaceDetail('/host/project', 'Project α'), '/host/project');
  assert.equal(workspaceDetail('/host/project/', 'project'), '/host');
  assert.equal(workspaceDetail('/', 'root'), '/');
  // A title that already names the last segment, and a path with nothing left, add no column.
  assert.equal(workspaceDetail('tui', 'tui'), '');
  assert.equal(workspaceDetail('', 'tui'), '');
});
