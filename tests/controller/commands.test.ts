/** Application command policy: what a submitted line does, and which view intent it produces. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, runCommand, type CommandPort, type ControllerOptions } from '../../src/controller/index.ts';
import { parseCommand } from '../../src/slash/index.ts';
import { host, until } from '../support/host.ts';

/** A port that runs nothing cancellable; none of the cases under test needs one. */
const port: CommandPort = { run: async () => undefined };

/** Start a controller on `s1`; the caller owns the fixture through `t.after`. */
async function controller(t: Parameters<typeof test>[0] extends never ? never : { after(fn: () => void | Promise<void>): void },
  options: Partial<ControllerOptions> = {}) {
  const fixture = await host();
  t.after(() => fixture.close());
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', ...options });
  t.after(async () => { await app.stop(); });
  app.start();
  await until(() => app.queries.record.ready);
  return { fixture, app };
}

const run = (app: Controller, line: string) => runCommand(app, parseCommand(line), port);

test('a command returns a view intent instead of the UI knowing the command', async t => {
  const { app } = await controller(t);
  // A panel command names the panel and carries its payload; it never names the command.
  assert.deepEqual(await run(app, '/history needle'), {
    closePanels: true, history: { query: 'needle', contentSearch: false } });
  assert.deepEqual(await run(app, '/prompt'), { closePanels: true, open: 'prompts' });
  // The three read panels toggle rather than open.
  assert.deepEqual(await run(app, '/help'), { closePanels: true, toggle: 'help' });
  // `latest` releases the window, the pin and the folds in one intent.
  assert.deepEqual(await run(app, '/latest'), {
    closePanels: true, live: true, pinLive: true, resetFolds: true, scroll: 0 });
  // Copy mode deliberately leaves panels alone.
  assert.deepEqual(await run(app, '/copy'), { copy: true });
});

test('a rejected command reports failure instead of an intent', async t => {
  const { app } = await controller(t);
  // A bad reasoning sequence is not something the UI can be told to show.
  await assert.rejects(() => run(app, '/think 99'), /message sequence/);
  // A parse error is an intent the UI shows without running anything.
  assert.deepEqual(await run(app, '/nope'), { closePanels: true, error: 'Unknown command. Use /help.' });
});

test('handoff clears the client file and asks for a live view with a notice', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-handoff-cmd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'HANDOFF.md');
  await writeFile(path, 'stale');
  const { app, fixture } = await controller(t, { localDirectory: directory });
  assert.deepEqual(await run(app, '/handoff'), {
    closePanels: true, live: true, scroll: 0, notice: 'Handoff requested · local HANDOFF.md cleared' });
  await assert.rejects(() => stat(path), /ENOENT/);
  assert.ok(fixture.calls.some(call => call.method === 'session/prompt'));
});
