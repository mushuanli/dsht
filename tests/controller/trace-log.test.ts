/** The transition trace records why the client changed screens, and stays a bounded private file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/controller/index.ts';
import { TraceLog, readTrace } from '../../src/controller/trace-log.ts';
import { host, until, workspace } from '../support/host.ts';

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

test('the trace names the reconnect that adopted the local workspace and dropped the session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-trace-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const fixture = await host(); t.after(() => fixture.close());
  // Registering the client's own directory as a workspace is what makes a reconnect adopt it.
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
  assert.ok(reconnect.some(event => event.event === 'picker' && event.requested === 'workspaces'),
    'the reconnect asked for the workspace picker');
  assert.ok(reconnect.some(event => event.event === 'adopt' && event.workspace === 'w1' && event.directory === process.cwd()),
    'the reconnect adopted the client directory as a workspace');
  // No action event ran: this jump was not a key or a command.
  assert.equal(reconnect.some(event => event.event === 'action'), false, 'no user action explains the jump');

  const screens = reconnect.filter(event => event.event === 'state').map(event => event.screen);
  assert.ok(screens.includes('chat -> workspaces'), `the picker replaced the conversation: ${String(screens)}`);
  assert.ok(reconnect.some(event => event.event === 'state'
    && event.screen === 'workspaces -> sessions' && event.session === 's1 -> none'),
    'adopting the workspace landed on /resume and dropped the selection');
  const resolve = reconnect.filter(event => event.event === 'resolve').at(-1)!;
  assert.equal(resolve.session, 'none');
  assert.equal(resolve.reselect, false, 'nothing re-selected the session the reader was in');
  assert.equal(controller.state.screen, 'sessions');
  assert.equal(controller.state.sessionId, undefined);
});
