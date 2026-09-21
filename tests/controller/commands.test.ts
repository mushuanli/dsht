/** Application command policy: what a submitted line does, and which view intent it produces. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, ViewEffect } from '../../src/contracts.ts';
import { Controller, runCommand, type CommandPort, type ControllerOptions } from '../../src/controller/index.ts';
import { readTrace } from '../../src/controller/trace-log.ts';
import { interpret, normalize, parseCommand } from '../../src/slash/index.ts';
import { array, object } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** A port that runs nothing cancellable; none of the cases under test needs one. */
const port: CommandPort = { run: async () => undefined };

/** A port that runs what it is given under a fresh signal, like the startup runner's. */
const runner: CommandPort = { run: (_label, operation) => operation(new AbortController().signal) };

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

/** One accepted line: these effects, in this order, and the draft is used up. */
const done = (effects: ViewEffect[]): CommandResult => ({ disposition: 'consume', outcome: 'ok', effects });
/** A refusal the operator can read; the draft and any form stay, and the error is applied last.
 *
 * A refusal never rearranges the screen, so it carries no effects unless a case asks for them.
 */
const kept = (text: string, effects: ViewEffect[] = []): CommandResult =>
  ({ disposition: 'retain', outcome: 'rejected', effects: [...effects, { kind: 'error', text }] });

test('a command returns effects instead of the UI knowing the command', async t => {
  const { app } = await controller(t);
  // A panel command names the panel and carries its payload; it never names the command. The array
  // order is the contract, so every case below spells it out.
  assert.deepEqual(await run(app, '/history needle'), done([
    { kind: 'closePanels' }, { kind: 'history', history: { query: 'needle', contentSearch: false } }]));
  assert.deepEqual(await run(app, '/prompt'), done([{ kind: 'closePanels' }, { kind: 'open', panel: 'prompts' }]));
  // The three read panels toggle rather than open.
  assert.deepEqual(await run(app, '/help'), done([{ kind: 'closePanels' }, { kind: 'toggle', panel: 'help' }]));
  // `latest` releases the window, the pin and the folds in one result.
  assert.deepEqual(await run(app, '/latest'), done([
    { kind: 'closePanels' }, { kind: 'live' }, { kind: 'pinLive' }, { kind: 'resetFolds' }, { kind: 'scroll', position: 0 }]));
  // Copy mode deliberately leaves panels alone.
  assert.deepEqual(await run(app, '/copy'), done([{ kind: 'copy' }]));
});

test('a rejection keeps the draft and says why, while a thrown fault is not a result', async t => {
  const { app } = await controller(t);
  // A bad reasoning sequence is not something the UI can be told to show.
  await assert.rejects(() => run(app, '/think 99'), /message sequence/);
  // A parse error is a result the UI shows without running anything.
  assert.deepEqual(await run(app, '/nope'), kept('Unknown command. Use /help.'));
});

test('handoff clears the client file and asks for a live view with a notice', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-handoff-cmd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'HANDOFF.md');
  await writeFile(path, 'stale');
  const { app, fixture } = await controller(t, { localDirectory: directory });
  assert.deepEqual(await run(app, '/handoff'), done([{ kind: 'closePanels' }, { kind: 'live' },
    { kind: 'scroll', position: 0 }, { kind: 'notice', text: 'Handoff requested · local HANDOFF.md cleared' }]));
  await assert.rejects(() => stat(path), /ENOENT/);
  assert.ok(fixture.calls.some(call => call.method === 'session/prompt'));
});

test('/loop runs the named record, with its own defaults and vars', async t => {
  const { app, fixture } = await controller(t);
  // The record's own title, path and default budget come from loop.yaml, not from the command line.
  assert.deepEqual(await run(app, '/loop designdoc-review --to 2'), done([{ kind: 'closePanels' }, { kind: 'live' },
    { kind: 'scroll', position: 0 },
    { kind: 'notice', text: 'Designdoc review · tui-design.md started · steps 1–2 · pass 8 · ≤10 tries' }]));
  const call = fixture.calls.filter(entry => entry.method === 'session/prompt').at(-1)!;
  const text = String(object(array(object(object(object(call.payload).args).request).content)[0]).text);
  assert.match(text, /tui-design\.md/);
  assert.match(text, /"kind":"designdoc-review"/);
  assert.equal(app.queries.loop?.title, 'Designdoc review · tui-design.md');
  assert.equal(app.queries.loop?.stepLabel, '定位与范围');
});

test('/loop takes an optional positional score and tries over the record defaults', async t => {
  const { app } = await controller(t);
  assert.deepEqual(await run(app, '/loop design-review 9 3'), done([{ kind: 'closePanels' }, { kind: 'live' },
    { kind: 'scroll', position: 0 },
    { kind: 'notice', text: 'Design review started · steps 1–10 · pass 9 · ≤3 tries' }]));
  assert.equal(app.queries.loop?.score, 9);
  assert.equal(app.queries.loop?.tries, 3);
});

test('/loop names the records it knows when the name is wrong', async t => {
  const { app } = await controller(t);
  assert.deepEqual(await run(app, '/loop nope'),
    kept('Unknown loop record: nope · available: design-review, designdoc-review'));
});

test('/loop refuses a reversed range before anything is sent', async t => {
  const { app, fixture } = await controller(t);
  const before = fixture.calls.filter(entry => entry.method === 'session/prompt').length;
  assert.deepEqual(await run(app, '/loop designdoc-review --from 5 --to 1'),
    kept('Use /loop <name> [score] [tries] [--from N] [--to N] [--score X] [--tries N]'));
  assert.equal(fixture.calls.filter(entry => entry.method === 'session/prompt').length, before);
});

test('/loop confirms a named record in a form when the caller can show one', async t => {
  const { app, fixture } = await controller(t);
  const interactive: CommandPort = { interactive: true, run: async () => undefined };
  const before = fixture.calls.filter(entry => entry.method === 'session/prompt').length;
  // A known record with no flags leaves every default open, so the form is what the caller gets.
  assert.deepEqual(await runCommand(app, parseCommand('/loop design-review'), interactive),
    done([{ kind: 'closePanels' }, { kind: 'loop', loop: { name: 'design-review' } }]));
  const started = app.queries.loop;
  assert.equal(started, undefined);
  assert.equal(fixture.calls.filter(entry => entry.method === 'session/prompt').length, before);
  // A typed flag is already a decision, so the same caller runs it without another step.
  assert.deepEqual(await runCommand(app, parseCommand('/loop design-review 9'), interactive),
    done([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'scroll', position: 0 },
      { kind: 'notice', text: 'Design review started · steps 1–10 · pass 9 · ≤10 tries' }]));
  assert.equal(app.queries.loop?.score, 9);
});

test('a scripted caller runs a named record directly and cannot ask for a list', async t => {
  const { app } = await controller(t);
  // The default port has no surface, so the record's own defaults are applied without a form.
  assert.deepEqual(await run(app, '/loop design-review'), done([{ kind: 'closePanels' }, { kind: 'live' },
    { kind: 'scroll', position: 0 },
    { kind: 'notice', text: 'Design review started · steps 1–10 · pass 8 · ≤10 tries' }]));
  assert.equal(app.queries.loop?.score, 8);
  // Bare `/loop` has no operator to choose, so it is told how to name a record.
  assert.deepEqual(await run(app, '/loop'), kept('Use /loop <name> · available: design-review, designdoc-review'));
});

test('a record variable the form confirmed retargets the run without editing loop.yaml', async t => {
  const { app, fixture } = await controller(t);
  // This is exactly the command the parameter form sends once the operator edits its path row.
  assert.deepEqual(await runCommand(app, { kind: 'loop', name: 'designdoc-review',
    options: { from: 1, to: 2, score: 8, tries: 2, vars: { path: 'docs/other.md' } } },
    { interactive: true, run: async () => undefined }), done([{ kind: 'closePanels' }, { kind: 'live' },
    { kind: 'scroll', position: 0 },
    { kind: 'notice', text: 'Designdoc review · docs/other.md started · steps 1–2 · pass 8 · ≤2 tries' }]));
  const call = fixture.calls.filter(entry => entry.method === 'session/prompt').at(-1)!;
  const text = String(object(array(object(object(object(call.payload).args).request).content)[0]).text);
  assert.match(text, /docs\/other\.md/);
  assert.doesNotMatch(text, /tui-design\.md/);
  assert.equal(app.queries.loop?.title, 'Designdoc review · docs/other.md');
});

test('a variable the record does not declare is refused before anything starts', async t => {
  const { app, fixture } = await controller(t);
  const before = fixture.calls.filter(entry => entry.method === 'session/prompt').length;
  assert.deepEqual(await runCommand(app, { kind: 'loop', name: 'design-review',
    options: { vars: { path: 'x.md' } } }, port),
    kept('Unknown loop variable: path · design-review accepts: none'));
  const started = app.queries.loop;
  assert.equal(started, undefined);
  assert.equal(fixture.calls.filter(entry => entry.method === 'session/prompt').length, before);
});

/** Loop events only, in order, so a start that stalls is legible from the trace. */
async function loopPhases(path: string): Promise<(string | undefined)[]> {
  const events = (await readTrace(path)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; phase?: string });
  return events.filter(entry => entry.event === 'loop' || entry.event === 'loop-ui').map(entry => entry.phase);
}

test('a loop start is traceable from the command through to the prompt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-loop-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const { app } = await controller(t, { tracePath: path });
  await run(app, '/loop design-review 9');
  await app.trace?.settle();
  assert.deepEqual(await loopPhases(path), ['command', 'begin', 'sent']);
});

test('the form path and its rejections are traceable before any run starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-loop-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const { app } = await controller(t, { tracePath: path });
  const interactive: CommandPort = { interactive: true, run: async () => undefined };
  // A bare known record opens the form: the trace says so without a run having started.
  await runCommand(app, parseCommand('/loop design-review'), interactive);
  // A name no record has is rejected for a reason the trace keeps.
  await runCommand(app, parseCommand('/loop nope'), interactive);
  await app.trace?.settle();
  assert.deepEqual(await loopPhases(path), ['command', 'form', 'command', 'rejected']);
});

test('the controller owns what the status bar calls busy', async t => {
  const { app } = await controller(t);
  // Nothing in flight: no turn, no loop, so the bar has nothing to report.
  const idle = app.queries.activity;
  assert.equal(idle, undefined);
  await run(app, '/loop design-review 9');
  // The work is the reviewed session's own turn, or the loop waiting for it; either way the answer is
  // assembled here, so a view never has to merge a turn and a loop itself.
  const activity = app.queries.activity;
  assert.ok(activity !== undefined);
  assert.ok(activity.kind === 'turn' || (activity.kind === 'loop' && activity.activity === 'turn'));
  app.actions.stopLoop();
  await until(() => app.queries.activity === undefined);
});

/** Every completed `command` event's kind, in order: the pipeline's own record of what was executed. */
async function commandKinds(path: string): Promise<(string | undefined)[]> {
  const events = (await readTrace(path)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; kind?: string; phase?: string });
  return events.filter(entry => entry.event === 'command' && entry.phase === 'end').map(entry => entry.kind);
}

test('every executed line is recorded once, and its arguments are never written', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-command-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const { app } = await controller(t, { tracePath: path });
  await run(app, '/help');
  await run(app, '/nope');
  await run(app, '/prompt Review for bugs');
  await app.trace?.settle();
  // One completed event per executed line, naming the kind only: the text a command carried stays out
  // of a log that may be pasted into a bug report.
  assert.deepEqual(await commandKinds(path), ['panel', 'error', 'savePrompt']);
  const raw = (await readTrace(path)).join('\n');
  assert.doesNotMatch(raw, /Review for bugs/);
});

test('each executed line has one begin and one end carrying the same commandId', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-command-span-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const { app } = await controller(t, { tracePath: path });
  await run(app, '/help');
  await run(app, '/nope');
  await app.trace?.settle();
  const events = (await readTrace(path)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; phase?: string; commandId?: string; outcome?: string; disposition?: string; error?: string });
  const commands = events.filter(entry => entry.event === 'command');
  // A begin is written before the effect and an end after it, and both name the same line.
  assert.deepEqual(commands.map(entry => entry.phase), ['begin', 'end', 'begin', 'end']);
  for (let index = 0; index < commands.length; index += 2) {
    assert.ok(commands[index]!.commandId !== undefined);
    assert.equal(commands[index + 1]!.commandId, commands[index]!.commandId);
  }
  assert.notEqual(commands[0]!.commandId, commands[2]!.commandId);
  // The end is the same fact the reader is shown: the outcome, whether the draft was consumed, and
  // the failure text when there was one.
  assert.equal(commands[1]!.outcome, 'ok');
  assert.equal(commands[1]!.disposition, 'consume');
  assert.equal(commands[3]!.outcome, 'rejected');
  assert.equal(commands[3]!.disposition, 'retain');
  assert.equal(commands[3]!.error, 'Unknown command. Use /help.');
});

test('/loop stop ends the running run and reports when there was none', async t => {
  const { app } = await controller(t);
  // Nothing is running, so the answer is a fact rather than an error: the operator is not told off
  // for a race they cannot see.
  assert.deepEqual(await run(app, '/loop stop'), done([{ kind: 'closePanels' }, { kind: 'notice', text: 'No loop is running' }]));
  await run(app, '/loop design-review 9');
  assert.equal(app.queries.loop?.active, true);
  const result = await run(app, '/loop stop');
  const notice = result?.effects.find(effect => effect.kind === 'notice');
  assert.match(String(notice?.kind === 'notice' ? notice.text : ''), /^Loop stopped/);
  assert.equal(app.queries.loop?.active, false);
  assert.equal(app.queries.loop?.terminalReason, 'user-cancelled');
});

test('a typed answer completes the question inside runCommand, not in the front end', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [{ type: 'waterfall', event: 'user-questions/request', eventId: 'q1', agentId: 's1', request: { questions: [
    { id: 'one', question: 'Choose a target', options: [{ label: 'First' }, { label: 'Second' }] },
  ] } }];
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await app.stop(); });
  app.start();
  await until(() => app.state.pending.length === 1);
  // Free text typed while a question waits is a line like any other: the pipeline classifies it, and
  // the *application* completes the waterfall, so no front end calls `answer` on the operator's behalf.
  const submission = interpret({ line: 'typed answer', referenceOpen: false, copyMode: false, screen: 'chat' });
  assert.equal(submission.kind, 'line');
  const command = normalize(submission as Extract<typeof submission, { kind: 'line' }>,
    { sessionSelected: true, question: true, pending: false });
  assert.deepEqual(command, { kind: 'answer', text: 'typed answer' });
  assert.deepEqual(await runCommand(app, command, port), done([{ kind: 'closePanels' }]));
  await until(() => app.state.pending.length === 0);
  const reply = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.deepEqual(object(reply.outcome).value,
    { answers: [{ id: 'one', selected: [], custom: 'typed answer' }] });
});

test('/cost starts its own refresh inside runCommand, not in a front end', async t => {
  const { app } = await controller(t);
  let refreshes = 0;
  app.actions.refreshCosts = async () => { refreshes += 1; return true; };
  // The port stands in for the UI's cancellable envelope; there is no UI in this test, so a refresh
  // that happens can only have been started by the command itself.
  assert.deepEqual(await runCommand(app, parseCommand('/cost'), runner),
    done([{ kind: 'closePanels' }, { kind: 'toggle', panel: 'cost' }]));
  await until(() => refreshes === 1);
  assert.equal(refreshes, 1);
});

test('a refused line reports its reason once, not again in the action envelope', async t => {
  const { app, fixture } = await controller(t);
  // A busy host is the action envelope's failure; the line turns it into a result the reader can see,
  // and 13.2-D2 says the same fact must not then sit in the status bar as a second copy.
  fixture.businessError = true;
  const result = await run(app, '/loop design-review 9');
  assert.equal(result?.outcome, 'rejected');
  const failure = result?.effects.find(effect => effect.kind === 'error');
  assert.match(String(failure?.kind === 'error' ? failure.text : ''), /Loop did not start: .*session\/agent-busy/);
  assert.equal(app.state.lastFailure, '');
});
