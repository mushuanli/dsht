/** The wire → semantic boundary: DSH field names must not survive into a HostEvent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlFrame, hostEvent, projectionSnapshot } from '../../src/transport/events.ts';

test('the ready handshake and unrecognized frames are not domain events', () => {
  assert.equal(hostEvent({ type: 'ready', clientId: 'c1' }), undefined);
  assert.equal(hostEvent({ type: 'emit', event: 'something/else', args: [] }), undefined);
  assert.equal(hostEvent({ type: 'emit', event: 'api-session/status', args: ['s1', 'yes'] }), undefined);
  assert.equal(hostEvent({}), undefined);
});

test('an approval waterfall becomes a description, never the raw request', () => {
  const event = hostEvent({ type: 'waterfall', event: 'approval/request', eventId: 'a1', agentId: 's1',
    request: { description: 'Confirm', toolName: 'bash' } });
  assert.deepEqual(event, { kind: 'approval-request', eventId: 'a1', sessionId: 's1',
    description: JSON.stringify({ description: 'Confirm', toolName: 'bash' }, null, 2) });
  assert.equal(JSON.stringify(event).includes('"request"'), false);
});

test('a question waterfall flattens to named fields and omits absent ones', () => {
  const event = hostEvent({ type: 'waterfall', event: 'user-questions/request', eventId: 'q1', agentId: 's2',
    request: { questions: [
      { id: 'one', header: 'Destination', question: 'Choose a target', detail: 'More',
        options: [{ label: 'First', description: 'First description' }, { label: 'Second' }] },
      { id: 'many', question: 'Choose features', multiSelect: true, options: [{ label: 'A' }] },
    ] } });
  assert.deepEqual(event, { kind: 'question-request', eventId: 'q1', sessionId: 's2', questions: [
    { id: 'one', header: 'Destination', question: 'Choose a target', detail: 'More', multiSelect: false,
      options: [{ label: 'First', description: 'First description' }, { label: 'Second' }] },
    { id: 'many', question: 'Choose features', multiSelect: true, options: [{ label: 'A' }] },
  ] });
});

test('an unrecognized or malformed waterfall still asks the host to move on', () => {
  assert.deepEqual(hostEvent({ type: 'waterfall', event: 'other/request', eventId: 'w1', agentId: 's1' }),
    { kind: 'waterfall-delegate', eventId: 'w1' });
  assert.deepEqual(hostEvent({ type: 'waterfall', event: 'user-questions/request', eventId: 'w2', agentId: 's1',
    request: { questions: [{ id: 'broken' }] } }), { kind: 'waterfall-delegate', eventId: 'w2' });
});

test('cancellation, running state, catalog changes and errors decode without raw payloads', () => {
  assert.deepEqual(hostEvent({ type: 'cancel', eventId: 'c1' }), { kind: 'cancel', eventId: 'c1' });
  assert.deepEqual(hostEvent({ type: 'emit', event: 'api-session/status', args: ['s1', true] }),
    { kind: 'agent-status', sessionId: 's1', running: true });
  assert.deepEqual(hostEvent({ type: 'emit', event: 'settings/document-updated', args: [] }), { kind: 'catalog-invalidated' });
  assert.deepEqual(hostEvent({ type: 'emit', event: 'api-session/error', args: ['s1', 'boom'] }),
    { kind: 'session-error', sessionId: 's1', error: 'boom' });
});

test('session/control frames decode to named fields, not DSH shapes', () => {
  const baseline = controlFrame({ type: 'baseline', value: {
    projections: { s1: { asOfSeq: 3, values: { title: 'T' } } },
    queues: { s1: [{ id: 'q', placement: 'steering', message: { id: 'q', content: [{ type: 'text', text: 'hi' }] } }] },
    jobs: { s1: [{ status: 'running' }, { status: 'completed' }] } } });
  assert.equal(baseline.kind, 'baseline');
  if (baseline.kind !== 'baseline') return;
  assert.deepEqual(baseline.projections.get('s1'), { asOfSeq: 3, values: { title: 'T' } });
  assert.deepEqual(baseline.queues.get('s1'), [{ id: 'q', placement: 'steering', text: 'hi' }]);
  assert.equal(baseline.jobs.get('s1'), 1);

  assert.deepEqual(controlFrame({ type: 'projection', sessionId: 's1', key: 'title', seq: 4, value: 'X' }),
    { kind: 'projection', sessionId: 's1', key: 'title', seq: 4, value: 'X' });
  assert.deepEqual(controlFrame({ type: 'jobs', sessionId: 's1', items: [{ status: 'stopping' }] }),
    { kind: 'jobs', sessionId: 's1', count: 1 });

  assert.throws(() => controlFrame({ type: 'projection', sessionId: 's1', key: 'x', seq: 1 }), /Missing projection value/);
  assert.throws(() => controlFrame({ type: 'nope' }), /Unknown session control frame/);
  assert.throws(() => projectionSnapshot({ asOfSeq: 'bad', values: {} }), /watermark/);
  assert.equal(projectionSnapshot(undefined), undefined);
});
