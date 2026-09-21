/** The session write gate: one admission at a time per session, control ahead of waiting normals. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionMutationGate, type MutationAdmission } from '../../src/session/mutation-gate.ts';

/** Let every already-queued microtask run, so a woken admission has dispatched. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('a section holds the gate until it returns, so a nested admission waits its turn', async () => {
  const gate = new SessionMutationGate();
  const order: string[] = [];
  // Re-entrancy is the observable case: without the gate the inner admission would decide in the
  // middle of the outer one, which is exactly the interleaving the gate exists to prevent.
  await gate.admit('s1', 'normal', () => {
    order.push('outer:in');
    void gate.admit('s1', 'normal', () => order.push('inner'));
    order.push('outer:out');
  });
  await settle();
  assert.deepEqual(order, ['outer:in', 'outer:out', 'inner']);
});

test('a control admission overtakes the waiting normal ones', async () => {
  const gate = new SessionMutationGate();
  const order: string[] = [];
  await gate.admit('s1', 'normal', () => {
    order.push('outer');
    void gate.admit('s1', 'normal', () => order.push('normal'));
    void gate.admit('s1', 'control', () => order.push('control'));
  });
  await settle();
  assert.deepEqual(order, ['outer', 'control', 'normal']);
});

test('the gate is released when the section returns, not when what it issued settles', async () => {
  const gate = new SessionMutationGate();
  const order: string[] = [];
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  // A section that returns an unsettled promise is the shape every production caller uses: the
  // request is issued, the host's answer is awaited outside. Holding the gate for it would make a
  // long `/compact` block the cancellation that exists to interrupt it.
  const issued = gate.admit('s1', 'normal', () => { order.push('issue'); return held; });
  await gate.admit('s1', 'normal', () => order.push('next'));
  assert.deepEqual(order, ['issue', 'next']);
  finish();
  await issued;
});

test('a session never blocks another session', async () => {
  const gate = new SessionMutationGate();
  const order: string[] = [];
  // If the gate were keyed on anything but the target session, this would deadlock: the outer section
  // awaits an admission of the other session from inside its own turn.
  await gate.admit('s1', 'normal', async () => {
    order.push('s1:in');
    await gate.admit('s2', 'normal', () => order.push('s2'));
    order.push('s1:out');
  });
  assert.deepEqual(order, ['s1:in', 's2', 's1:out']);
});

test('a section that throws still releases the gate', async () => {
  const gate = new SessionMutationGate();
  await assert.rejects(gate.admit('s1', 'normal', () => { throw new Error('nope'); }), /nope/);
  const order: string[] = [];
  await gate.admit('s1', 'normal', () => { order.push('after'); });
  assert.deepEqual(order, ['after']);
});

test('each admission is reported once, in dispatch order, with whether it waited', async () => {
  const seen: MutationAdmission[] = [];
  const gate = new SessionMutationGate(admission => seen.push(admission));
  const outer = gate.admit('s1', 'normal', () => {});
  const normal = gate.admit('s1', 'normal', () => {});
  const control = gate.admit('s1', 'control', () => {});
  const other = gate.admit('s2', 'normal', () => {});
  await Promise.all([outer, normal, control, other]);
  // Only one session's own order is asserted: the two sessions dispatch independently, so their
  // reports interleave by whatever the microtask queue does.
  assert.deepEqual(seen.filter(entry => entry.sessionId === 's1').map(entry => `${entry.lane}:${entry.waited}`),
    ['normal:false', 'control:true', 'normal:true']);
  assert.deepEqual(seen.filter(entry => entry.sessionId === 's2'), [{ sessionId: 's2', lane: 'normal', waited: false }]);
  assert.equal(seen.length, 4);
});
