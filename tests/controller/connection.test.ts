/** Connection startup and stop share cancellation at each asynchronous boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../../src/transport/client.ts';
import { ConnectionController } from '../../src/controller/connection.ts';
import { initialState, type ControllerStore } from '../../src/state.ts';
import { until } from '../support/host.ts';

function store(): ControllerStore {
  return { state: initialState(), update(patch) { Object.assign(this.state, patch); },
    selection: () => 0, bumpSelection() {}, busy: () => false };
}

test('stop during authentication never starts the next connection phase', async () => {
  const client = new Client('http://localhost');
  let release!: () => void;
  const authentication = new Promise<void>(resolve => { release = resolve; });
  let connects = 0;
  client.connect = async () => { connects++; throw new Error('Unexpected handshake'); };
  const connection = new ConnectionController(store(), {
    base: client.base.origin, token: undefined, initialSession: undefined, makeClient: () => client,
    authenticate: () => authentication,
  }, { begin() {}, ready: async () => {}, ended: async () => {}, event: () => true });
  connection.start();
  const stopping = connection.stop();
  release(); await stopping;
  assert.equal(connects, 0);
});

test('event failure while waiting for control ends startup promptly', async t => {
  const client = new Client('http://localhost', 500);
  client.connect = async () => {};
  let event!: Parameters<Client['subscribe']>[2];
  let waiting = false;
  client.subscribe = (endpoint, _args, listener) => {
    if (endpoint === '$events') { event = listener; listener.item({ type: 'ready', clientId: 'test' }); }
    else waiting = true;
    return { cancel() {} };
  };
  const state = store();
  let ended = false;
  const connection = new ConnectionController(state, {
    base: client.base.origin, token: undefined, initialSession: undefined, makeClient: () => client,
    authenticate: async () => {},
  }, { begin() {}, ready: async () => { throw new Error('Unexpected readiness'); },
    ended: async () => { ended = true; }, event: () => true });
  t.after(() => connection.stop());
  connection.start(); await until(() => waiting);
  event.end(new Error('Event subscription lost'));
  await until(() => ended, 100);
  assert.match(state.state.lastFailure, /Event subscription lost/);
});
