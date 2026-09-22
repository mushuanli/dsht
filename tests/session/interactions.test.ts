/** An interaction identity owns one response, even across dispatch and host acknowledgement. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/controller.ts';
import { host, until } from '../support/host.ts';

async function mount(t: { after(fn: () => void | Promise<void>): void }) {
  const fixture = await host(); t.after(() => fixture.close());
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(() => app.stop()); app.start();
  await until(() => app.queries.record.ready);
  const ask = (description: string) => app.session.accept({ kind: 'approval-request', eventId: 'p', sessionId: 's1', description });
  ask('Original approval');
  return { app, ask };
}

test('concurrent answers to one approval share a single response', async t => {
  const { app } = await mount(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let calls = 0;
  app.connection.reply = async () => { calls++; await gate; };
  const first = app.session.approve(true);
  const second = app.session.approve(false);
  await until(() => calls > 0);
  release(); await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(app.state.pending.length, 0);
});

test('host cancellation before admission prevents the obsolete response from being sent', async t => {
  const { app } = await mount(t);
  let calls = 0;
  app.connection.reply = async () => { calls++; };
  const response = app.session.approve(true);
  app.session.cancelled('p');
  await assert.rejects(response, /no longer pending/);
  assert.equal(calls, 0);
});

test('an old response acknowledgement cannot delete a replacement interaction', async t => {
  const { app, ask } = await mount(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let sent = false;
  app.connection.reply = async () => { sent = true; await gate; };
  const response = app.session.approve(true);
  await until(() => sent);
  app.session.cancelled('p'); ask('Replacement approval');
  release(); await response;
  const pending = app.state.pending[0];
  assert.equal(pending?.kind === 'approval' ? pending.description : undefined, 'Replacement approval');
});

test('a failed acknowledgement leaves the interaction available for an explicit retry', async t => {
  const { app } = await mount(t);
  let calls = 0;
  app.connection.reply = async () => { if (++calls === 1) throw new Error('Temporary failure'); };
  await assert.rejects(app.session.approve(true), /Temporary failure/);
  assert.equal(app.state.pending.length, 1);
  await app.session.approve(true);
  assert.equal(calls, 2);
  assert.equal(app.state.pending.length, 0);
});
