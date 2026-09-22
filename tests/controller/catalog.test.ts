/** Model operations share foreground cancellation; background metadata belongs to one generation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/controller.ts';
import { host, until } from '../support/host.ts';

for (const select of [false, true]) test(`cancelling model ${select ? 'selection' : 'loading'} aborts its request`, async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  let release = () => {};
  t.after(async () => { release(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.connectionSettled && controller.queries.record.ready);
  await controller.catalog.settle();
  const client = controller.connection.require();
  const call = client.call.bind(client);
  let requestSignal: AbortSignal | undefined;
  let started = false;
  client.call = (method, args, signal) => {
    if (method !== (select ? 'session/selectModel' : 'session/modelCatalog')) return call(method, args, signal);
    requestSignal = signal; started = true;
    return new Promise((resolve, reject) => {
      release = () => resolve({ selected: { provider: 'fixture', model: 'example' } });
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const loading = select ? controller.actions.selectModel('fixture', 'example') : controller.actions.modelCatalog();
  await until(() => started);
  controller.actions.cancelForeground();
  assert.equal(requestSignal?.aborted, true);
  await loading;
  assert.equal(controller.queries.foreground, undefined);
  assert.equal(controller.state.status.includes('Next request:'), false);
});

for (const presets of [false, true]) test(`catalog reset discards a late ${presets ? 'preset' : 'default model'} response from the same client`, async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  let release = () => {};
  t.after(async () => { release(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.connectionSettled);
  await controller.catalog.settle();
  const client = controller.connection.require();
  const call = client.call.bind(client);
  client.call = (method, args, signal) => {
    if (method !== (presets ? 'agentPresets/list' : 'session/modelCatalog')) return call(method, args, signal);
    // Ignore cancellation deliberately: a late adapter result must still be invalidated.
    return new Promise(resolve => { release = () => resolve({ default: { model: 'stale' }, presets: [{ id: 'stale' }] }); });
  };
  if (presets) controller.catalog.loadPresetNames(); else controller.catalog.refresh();
  controller.catalog.reset();
  release(); await controller.catalog.settle();
  assert.equal(controller.state.defaultModel, undefined);
  assert.equal(controller.state.presets, undefined);
});
