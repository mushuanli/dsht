/** The dsh wire contract: every decoder dsht relies on, with the fields each one reads.
 *
 * Fixtures are shaped after `dsh 0.2.0-rc.2` (`packages/api/session-controller/src/types.ts` and
 * friends); the version and source paths are recorded in the contract file itself. A host upgrade
 * starts by changing this file and this test together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../../src/transport/dsh-contract.ts';
import { surfaceAppends, surfaceOpOf } from '../../src/transport/dsh-contract.ts';
import {
  accepted, archivedSessions, commandExecution, fileReferenceCandidates, followFrame, inboxInputs,
  modelCatalog, modelSelected, pageResult, presetRows, projectedTitle, searchResult, sessionCreated,
  sessionMetrics, sessionRow, sessionRows, workspaceBaseline, workspaceCreated, workspaceDeleted,
  workspaceRow,
} from '../../src/transport/dsh-contract.ts';

test('a session row decodes the identity, state and title the list shows', () => {
  const row = sessionRow({ sessionId: 's1', running: true, blank: false, updatedAt: 42, cwd: '/host/p',
    agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 7, values: { title: 'Readable' } } });
  assert.deepEqual(row, { sessionId: 's1', running: true, blank: false, updatedAt: 42, cwd: '/host/p',
    title: 'Readable', agentAvailable: true });
  // The title projection has carried both shapes; both resolve to the same label.
  assert.equal(sessionRow({ sessionId: 's', projections: { values: { title: { title: 'Block form' } } } }).title, 'Block form');
  assert.equal(projectedTitle({ title: { title: 'Block form' } }), 'Block form');
  // A row that lost `running`/`blank` degrades to idle rather than emptying the picker.
  assert.deepEqual(sessionRow({ sessionId: 's2' }), { sessionId: 's2', running: false, blank: false });
  assert.equal(sessionRow({ sessionId: 's3' }).agentAvailable, undefined);
  assert.deepEqual(sessionRows({ items: [{ sessionId: 'a' }, { sessionId: 'b' }] }).map(item => item.sessionId), ['a', 'b']);
  assert.deepEqual(sessionRows(undefined), []);
  assert.throws(() => sessionRow({}), /string/);
});

test('a workspace row and its baseline decode the registration and the archived set', () => {
  assert.deepEqual(workspaceRow({ workspaceId: 'w', path: '/w' }), { workspaceId: 'w', path: '/w', title: '/w', sessionIds: [] });
  assert.deepEqual(workspaceRow({ workspaceId: 'w', path: '/w', title: 'W', sessionIds: ['s1'], createdAt: 'a', updatedAt: 'b' }),
    { workspaceId: 'w', path: '/w', title: 'W', sessionIds: ['s1'], createdAt: 'a', updatedAt: 'b' });
  // 0.2 added `pinnedSessionIds` to the baseline; dsht does not pin, so it is ignored rather than carried.
  assert.deepEqual(workspaceBaseline({ items: [{ workspaceId: 'w', path: '/w' }], archivedSessionIds: ['s9'], pinnedSessionIds: ['s1'] }),
    { items: [{ workspaceId: 'w', path: '/w', title: '/w', sessionIds: [] }], archivedSessionIds: ['s9'] });
  assert.deepEqual(workspaceCreated({ workspace: { workspaceId: 'w', path: '/w' }, created: false }).workspaceId, 'w');
  assert.throws(() => workspaceCreated({ created: false }), /result/);
  assert.equal(workspaceDeleted({ deleted: true }), true);
  assert.throws(() => workspaceDeleted({ deleted: false }), /did not confirm/);
});

test('page, search and create results reject protocol drift loudly', () => {
  assert.deepEqual(pageResult({ records: [{ type: 'event' }], hasMore: false }), { records: [{ type: 'event' }], hasMore: false });
  assert.throws(() => pageResult({ records: [] }), /hasMore/);
  assert.deepEqual(searchResult({ items: [{ sessionId: 's', snippet: 'x' }], hasMore: true }),
    { items: [{ sessionId: 's', snippet: 'x' }], hasMore: true });
  assert.throws(() => searchResult({ items: [{ sessionId: 1, snippet: 'x' }], hasMore: false }), /Invalid session search item/);
  assert.throws(() => searchResult({ items: [], hasMore: 'no' }), /Invalid session search response/);
  assert.equal(sessionCreated({ sessionId: 's' }), 's');
  assert.deepEqual(archivedSessions({ archivedSessionIds: ['s1', 's2'] }), ['s1', 's2']);
  assert.deepEqual(modelSelected({ selected: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.equal(accepted({ accepted: true }, 'the prompt'), undefined);
  assert.throws(() => accepted({ accepted: false }, 'the prompt'), /did not accept the prompt/);
});

test('the model catalog decodes routes, reasoning efforts and provider failures', () => {
  const catalog = modelCatalog({
    default: { provider: 'p', model: 'm' },
    routableProviders: ['p'],
    groups: [{ id: 'p', name: 'Provider', models: [
      { id: 'm', name: 'Model', description: 'd', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High', description: 'h' }] } },
      { id: 'plain', name: 'Plain' },
    ] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'offline' }],
  });
  assert.deepEqual(catalog, { default: { provider: 'p', model: 'm' }, routableProviders: ['p'],
    groups: [{ id: 'p', name: 'Provider', models: [
      { id: 'm', name: 'Model', description: 'd', reasoningEfforts: [{ id: 'high', name: 'High', description: 'h' }], defaultEffort: 'high' },
      { id: 'plain', name: 'Plain', reasoningEfforts: [] },
    ] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'offline' }] });
});

test('the preset roster skips an unreadable row and keeps an older host\u2019s trust', () => {
  assert.deepEqual(presetRows({ presets: [{ id: 'standard', isDefault: true }, { name: 'nameless' }, { id: 'ptc', trust: 'system' }] }),
    [{ id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false, trust: 'system' }]);
  assert.deepEqual(presetRows(undefined), []);
});

test('command executions and file candidates decode their settled shapes', () => {
  assert.deepEqual(commandExecution({ commandId: 'c1', result: { kind: 'success', text: 'ok' } }),
    { commandId: 'c1', result: { kind: 'success', text: 'ok' } });
  assert.deepEqual(commandExecution({ result: { kind: 'error' } }), { result: { kind: 'error' } });
  assert.equal(commandExecution(undefined), undefined);
  assert.throws(() => commandExecution({ result: { kind: 'maybe' } }), /kind/);
  assert.deepEqual(fileReferenceCandidates([{ path: 'src', kind: 'directory' }]), [{ path: 'src', kind: 'directory' }]);
  assert.throws(() => fileReferenceCandidates({ items: [] }), /array/);
  assert.throws(() => fileReferenceCandidates([{ path: 'x', kind: 'socket' }]), /kind/);
});

test('a follow frame decodes its envelope and keeps the record bodies raw', () => {
  const snapshot = followFrame({ type: 'snapshot', cursor: 5, hasMore: true, header: { isSeeded: true },
    records: [{ type: 'event', event: { seq: 1 } }], projections: { asOfSeq: 2, values: {} },
    assistantStream: { revision: 3, activeAttempt: { attemptId: 'a', nextIndex: 1, stream: [{ type: 'chunk', chunk: {} }] } } });
  assert.deepEqual(snapshot, { kind: 'snapshot', snapshot: { cursor: 5, hasMore: true, headerSeeded: true,
    records: [{ type: 'event', event: { seq: 1 } }], projections: { asOfSeq: 2, values: {} },
    assistantStream: { revision: 3, activeAttempt: { attemptId: 'a', nextIndex: 1, stream: [{ type: 'chunk', chunk: {} }] } } } });
  const plain = followFrame({ type: 'snapshot', cursor: 0, hasMore: false, records: [] });
  assert.equal(plain.kind === 'snapshot' && plain.snapshot.headerSeeded, false);
  assert.equal(plain.kind === 'snapshot' && plain.snapshot.assistantStream, undefined);
  assert.deepEqual(followFrame({ type: 'event', event: { seq: 2 } }), { kind: 'record', record: { type: 'event', event: { seq: 2 } } });
  assert.deepEqual(followFrame({ type: 'chunks', event: { seq: 3 } }), { kind: 'record', record: { type: 'chunks', event: { seq: 3 } } });
  assert.deepEqual(followFrame({ type: 'assistant-stream', frame: { type: 'start', revision: 1, attemptId: 'a' } }),
    { kind: 'assistant', frame: { type: 'start', revision: 1, attemptId: 'a' } });
  assert.deepEqual(followFrame({ type: 'assistant-stream', frame: { type: 'chunk', revision: 2, attemptId: 'a', index: 0, chunk: { type: 'text-delta' } } }),
    { kind: 'assistant', frame: { type: 'chunk', revision: 2, attemptId: 'a', index: 0, chunk: { type: 'text-delta' } } });
  assert.deepEqual(followFrame({ type: 'assistant-stream', frame: { type: 'end', revision: 3, attemptId: 'a', index: 1 } }),
    { kind: 'assistant', frame: { type: 'end', revision: 3, attemptId: 'a', index: 1 } });
  // An unreadable envelope is loud: the caller reopens the generation instead of folding half a frame.
  assert.throws(() => followFrame({ type: 'snapshot', records: [] }), /cursor/);
  assert.throws(() => followFrame({ type: 'assistant-stream', frame: { type: 'chunk', revision: 2, attemptId: 'a' } }), /index/);
  assert.throws(() => followFrame({ type: 'unknown' }), /Unknown session follow frame/);
  assert.throws(() => followFrame(undefined), /JSON object/);
});

test('projection metrics decode the six capabilities dsht displays', () => {
  assert.deepEqual(sessionMetrics({
    title: 'Session', agentPreset: 'ptc',
    modelSelection: { lastUsed: { provider: 'p', model: 'a' }, next: null },
    contextPressure: { projectedTokens: 25, pressureTokens: 10, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
    sessionStats: { turns: 42 },
  }), {
    title: 'Session', agentPresetId: 'ptc',
    models: { lastUsed: { provider: 'p', model: 'a' } },
    context: { projectedTokens: 25, pressureTokens: 10, window: 100 },
    usage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
    turns: 42,
  });
  assert.deepEqual(sessionMetrics(undefined), { models: {} });
  // A negative or non-numeric count is unknown rather than trusted.
  assert.deepEqual(sessionMetrics({ tokenUsage: { outputTokens: -1, cacheReadTokens: 'many' } }), { models: {} });
  assert.deepEqual(sessionMetrics({ contextPressure: { contextWindow: 0 } }).context, { window: 0 });
});

test('pending input decodes from the durable inbox projection', () => {
  assert.deepEqual(inboxInputs({
    'next-step': [{ id: 'm1', content: [{ type: 'text', text: 'steer' }], source: { kind: 'user', rpcId: 'r1' } }],
    'next-turn': [{ id: 'm2', content: [{ type: 'text', text: 'later' }, { type: 'image' }], source: { kind: 'system-prompt' } }],
  }), [
    { id: 'm1', placement: 'steering', rpcId: 'r1', text: 'steer' },
    { id: 'm2', placement: 'queued', text: 'later [image]' },
  ]);
  assert.deepEqual(inboxInputs(undefined), []);
  assert.deepEqual(inboxInputs({ 'next-step': 'nope' }), []);
  assert.deepEqual(inboxInputs({ 'next-step': [null, {}, { id: 'ok' }] }), [{ id: 'ok', placement: 'steering', text: '' }]);
});

test('the contract surface is exactly the decoders the transport exposes', () => {
  // A new decoder is a new host-field dependency: this list forces the upgrade path to notice it
  // (and to give it a case above) instead of letting it arrive unnoticed with a feature change.
  const decoders = Object.entries(contract).filter(([, value]) => typeof value === 'function')
    .map(([name]) => name).sort();
  assert.deepEqual(decoders, [
    'accepted', 'archivedSessions', 'commandExecution', 'fileReferenceCandidates', 'followFrame',
    'inboxInputs', 'modelCatalog', 'modelSelected', 'modelSelection', 'pageResult', 'presetRows', 'projectedTitle',
    'searchResult', 'sessionCreated', 'sessionMetrics', 'sessionRow', 'sessionRows',
    'surfaceAppends', 'surfaceOpOf',
    'workspaceBaseline', 'workspaceCreated', 'workspaceDeleted', 'workspaceRow',
  ]);
});

test('a 0.2 surface rewrite is decoded as a replace op, not as a missing append', () => {
  // 0.1.x wrote the bare string; 0.2 rewrites history with `{op:'replace',startSeq,endSeq}`. Treating
  // the object as "not append" is what used to strip a record's data and break the whole session.
  assert.equal(surfaceAppends(undefined), true, 'a host that never wrote the field only appended');
  assert.equal(surfaceAppends('append'), true);
  assert.equal(surfaceAppends({ op: 'append' }), true);
  assert.equal(surfaceAppends({ op: 'replace', startSeq: 38, endSeq: 38 }), false);
  // The range travels with the op: a reader that wants it reads `surfaceOpOf`, and only the display
  // cares whether the record appends.
  assert.deepEqual(surfaceOpOf({ op: 'replace', startSeq: 38, endSeq: 40 }), { op: 'replace', startSeq: 38, endSeq: 40 });
  assert.equal(surfaceOpOf('append')?.op, 'append');
  // An op this client does not know is neither: its data is kept, the display skips it.
  assert.equal(surfaceAppends({ op: 'splice' }), false);
  assert.equal(surfaceOpOf({ op: 'splice' }), undefined);
  assert.equal(surfaceOpOf({ op: 'replace', startSeq: 1 }), undefined, 'a partial range is not a range');
});
