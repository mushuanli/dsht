/** The wire → semantic boundary: DSH field names must not survive into a HostEvent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlFrame, hostEvent, inboxInputs, projectionSnapshot } from '../../src/transport/events.ts';

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
  assert.deepEqual(controlFrame({ type: 'jobs', sessionId: 's1', jobs: [{ status: 'stopping' }, { status: 'completed' }] }),
    { kind: 'jobs', sessionId: 's1', count: 1 });
  // The host names the rows `jobs`; an `items` frame from an older fixture still counts.
  assert.deepEqual(controlFrame({ type: 'jobs', sessionId: 's1', items: [{ status: 'running' }] }),
    { kind: 'jobs', sessionId: 's1', count: 1 });

  assert.throws(() => controlFrame({ type: 'projection', sessionId: 's1', key: 'x', seq: 1 }), /Missing projection value/);
  assert.throws(() => controlFrame({ type: 'nope' }), /Unknown session control frame/);
  assert.throws(() => projectionSnapshot({ asOfSeq: 'bad', values: {} }), /watermark/);
  assert.equal(projectionSnapshot(undefined), undefined);
});

test('a baseline without a queue or job section still yields its projections', () => {
  // The installed host reports projections only: it has no queue or job stream, and a client that
  // demanded the three-section shape threw the whole baseline away, leaving live metrics degraded.
  const baseline = controlFrame({ type: 'baseline', value: {
    projections: { s1: { asOfSeq: 7, values: { title: 'T' } } } } });
  assert.equal(baseline.kind, 'baseline');
  if (baseline.kind !== 'baseline') return;
  assert.deepEqual(baseline.projections.get('s1'), { asOfSeq: 7, values: { title: 'T' } });
  assert.equal(baseline.queues.size, 0);
  assert.equal(baseline.jobs.size, 0);
  // A section that is present but not an object is still malformed, not absent.
  assert.throws(() => controlFrame({ type: 'baseline', value: { projections: {}, queues: 'nope' } }), /Expected a JSON object/);
});

test('the durable inbox projection flattens into the pending inputs a host holds', () => {
  const inputs = inboxInputs({
    'next-step': [{ id: 'm2', content: [{ type: 'text', text: 'steer this' }], source: { kind: 'user', rpcId: 'r2' } }],
    'next-turn': [
      { id: 'm3', content: [{ type: 'text', text: 'later' }, { type: 'image' }], source: { kind: 'user', rpcId: 'r3' } },
      // An injected occurrence has no submission identity and must not retire anyone's local row.
      { id: 'm4', content: [{ type: 'text', text: 'context' }], source: { kind: 'system-prompt' } },
    ],
  });
  assert.deepEqual(inputs, [
    { id: 'm2', placement: 'steering', rpcId: 'r2', text: 'steer this' },
    { id: 'm3', placement: 'queued', rpcId: 'r3', text: 'later [image]' },
    { id: 'm4', placement: 'queued', text: 'context' },
  ]);
  assert.deepEqual(inboxInputs(undefined), []);
  assert.deepEqual(inboxInputs({ 'next-step': 'not a list' }), []);
  // A row this client cannot read is skipped rather than failing the whole control stream.
  assert.deepEqual(inboxInputs({ 'next-step': [null, {}, { id: 'ok' }] }), [{ id: 'ok', placement: 'steering', text: '' }]);
});
