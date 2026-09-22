/** Physical connection lifetime remains terminal after close and reusable after a peer disconnect. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { Client } from '../../src/transport/client.ts';
import { host, until } from '../support/host.ts';

test('closing a client prevents a later physical connection from opening', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token');
  await client.close();
  await assert.rejects(client.connect(), { name: 'AbortError' });
});

test('every concurrent close waits for the physical connection to close', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token'); await client.connect();
  let firstFinished = false;
  const first = client.close().then(() => { firstFinished = true; });
  await client.close();
  assert.equal(firstFinished, true);
  await first;
});

test('a rejected handshake can be retried with a restored cookie on the same live client', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await assert.rejects(client.connect(), /401/);
  client.restoreCookie('dsh-auth-fixture=valid');
  await client.connect();
  assert.equal((await client.listWorkspaces()).length, 1);
});

test('peer disconnection permits reconnecting without reviving cancelled subscriptions', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token'); await client.connect();
  let ended = 0;
  client.subscribe('$events', {}, { item() {}, end() { ended++; } });
  fixture.disconnect();
  await until(() => ended === 1);
  await client.connect();
  assert.equal((await client.listWorkspaces()).length, 1);
  assert.equal(ended, 1);
});

test('close interrupts a stalled WebSocket handshake and settles all waiters', async t => {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let accepted!: () => void;
  const upgrading = new Promise<void>(resolve => { accepted = resolve; });
  server.on('upgrade', (_request, socket) => {
    socket.resume(); socket.on('end', () => socket.end()); accepted();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  const client = new Client(`http://127.0.0.1:${address.port}`);
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, { name: 'AbortError' });
  await upgrading;
  await Promise.all([client.close(), client.close(), rejected]);
  await until(() => sockets.size === 0);
});
