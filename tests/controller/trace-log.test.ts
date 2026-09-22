/** The transition trace records why the client changed screens, and stays a bounded private file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/controller/index.ts';
import { TraceLog, compactCut, readTrace } from '../../src/controller/trace-log.ts';
import { host, until, workspace } from '../support/host.ts';

/** One trace line as the compactor sees it: a JSON object, or a header the compactor ignores. */
const line = (event: Record<string, unknown>): string => JSON.stringify(event);

test('a compacting cut never keeps a close whose begin was dropped', () => {
  // A span opened before the cut and closed after it: the cut must move past the close.
  const spanning = [
    line({ event: 'command', phase: 'begin', commandId: 'C1' }),
    line({ event: 'state', screen: 'chat' }),
    line({ event: 'command', phase: 'end', commandId: 'C1' }),
    line({ event: 'state', screen: 'sessions' }),
  ];
  assert.equal(compactCut(spanning, 2), 3);
  // Nothing to move when the cut already falls between two whole spans.
  assert.equal(compactCut(spanning, 1), 3);
  // A span whose close never came cannot be split: the begin stays and the cut does not move.
  const crashed = [line({ event: 'loop', phase: 'begin', runId: 'R1' }), line({ event: 'state' })];
  assert.equal(compactCut(crashed, 1), 1);
  // Moving the cut can expose a second split span, so the check repeats.
  const nested = [
    line({ event: 'command', phase: 'begin', commandId: 'C1' }),
    line({ event: 'loop', phase: 'begin', runId: 'R1' }),
    line({ event: 'command', phase: 'end', commandId: 'C1' }),
    line({ event: 'loop', phase: 'end', runId: 'R1' }),
    line({ event: 'state' }),
  ];
  assert.equal(compactCut(nested, 3), 4);
  // An event outside a known span never moves the cut, and neither does a non-span phase.
  const ordinary = [line({ event: 'verify', phase: 'begin', runId: 'R1' }), line({ event: 'loop', phase: 'form' })];
  assert.equal(compactCut(ordinary, 1), 1);
  // A generation carries no id, so it pairs by event name: one is open at a time.
  const generation = [
    line({ event: 'generation', phase: 'begin', session: 's1' }),
    line({ event: 'state' }),
    line({ event: 'generation', phase: 'ended' }),
    line({ event: 'state' }),
  ];
  assert.equal(compactCut(generation, 2), 3);
});

/** Parse every recorded event, dropping the format header. */
async function events(path: string): Promise<Record<string, unknown>[]> {
  return (await readTrace(path)).filter(line => !line.startsWith('#')).map(line => JSON.parse(line) as Record<string, unknown>);
}

test('the trace seeds a header, appends JSON events and stays owner-only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-trace-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // A nested path also proves the log creates its own directory before the first append.
  const path = join(directory, 'nested', 'trace.log');
  const log = new TraceLog(path);
  log.record({ event: 'one', screen: 'chat' });
  log.record({ event: 'two' });
  await log.settle();
  const lines = await readTrace(path);
  assert.match(lines[0]!, /^# dsht trace/);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]!).event, 'one');
  assert.equal(JSON.parse(lines[1]!).screen, 'chat');
  assert.equal(typeof JSON.parse(lines[1]!).time, 'string');
  assert.equal(JSON.parse(lines[2]!).event, 'two');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('the reconnect trace refreshes navigation and restores the selected session without a screen change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-trace-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const fixture = await host(); t.after(() => fixture.close());
  // Startup adopts this workspace once; reconnect must not adopt it again and drop the session.
  fixture.baseline = [{ ...workspace, path: process.cwd() }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', tracePath: path });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.connectionSettled
    && controller.state.screen === 'sessions' && controller.state.workspaceId === 'w1', 15_000);

  await controller.actions.selectSession('s1');
  await until(() => controller.state.screen === 'chat' && controller.queries.record.ready, 15_000);
  await controller.trace!.settle();
  const before = (await events(path)).length;

  // A dropped generation is the trigger a reader never asks for: no key was pressed.
  fixture.disconnect();
  await until(() => !controller.state.online, 15_000);
  await until(() => controller.state.online && controller.queries.connectionSettled, 15_000);
  await controller.trace!.settle();
  const after = (await events(path)).slice(before);

  // The generation marker separates the reconnect's story from every action before it.
  const begin = after.findIndex(event => event.event === 'generation' && event.phase === 'begin');
  assert.ok(begin >= 0, 'the reconnect must record a generation begin');
  const reconnect = after.slice(begin);
  assert.ok(reconnect.some(event => event.event === 'navigation-refresh' && event.screen === 'chat'));
  assert.equal(reconnect.some(event => event.event === 'adopt'), false);
  assert.equal(reconnect.some(event => event.event === 'state' && (event.screen || event.session)), false,
    'refreshing a connection must not navigate or transiently clear the selection');
  const resolve = reconnect.filter(event => event.event === 'resolve').at(-1)!;
  assert.equal(resolve.session, 's1');
  assert.equal(resolve.reselect, true);
  assert.equal(controller.state.screen, 'chat');
  assert.equal(controller.state.sessionId, 's1');
  await until(() => controller.queries.record.ready);

});
