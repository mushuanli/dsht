/** Cancellation boundaries of a shared scan, independent of the host's agent turn. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CostController } from '../../src/cost/controller.ts';
import { CostLedger } from '../../src/cost/ledger.ts';
import { sessionCostHistory } from '../../src/cost/scanner.ts';
import { Client } from '../../src/transport/client.ts';

function scanning(publish?: (cost: CostController) => void) {
  const client = new Client('http://localhost');
  const lifetime = new AbortController();
  const releases: (() => void)[] = [];
  let calls = 0;
  let signal: AbortSignal | undefined;
  client.call = async (_method, _args, requestSignal) => new Promise((resolve, reject) => {
    calls++;
    signal = requestSignal;
    releases.push(() => resolve({ items: [] }));
    requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
  });
  const ledger = new CostLedger();
  const cost = new CostController(ledger, { client: () => client, online: () => true, signal: () => lifetime.signal, publish: () => publish?.(cost) });
  return { cost, ledger, release: () => releases.forEach(release => release()), signal: () => signal, calls: () => calls };
}

test('an already cancelled caller cannot join or cancel the active billing scan', async () => {
  const setup = scanning();
  const active = setup.cost.refresh();
  await Promise.resolve();
  const aborted = AbortSignal.abort();
  let outcome = 'pending';
  const joined = setup.cost.refresh(aborted).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.equal(outcome, 'rejected');
    assert.equal(setup.signal()?.aborted, false);
  } finally { setup.release(); await active; await joined; }
});

test('stopping billing aborts its active request before waiting for cleanup', async () => {
  const setup = scanning();
  const active = setup.cost.refresh();
  await Promise.resolve();
  const stopping = setup.cost.stop();
  try { assert.equal(setup.signal()?.aborted, true); }
  finally { setup.release(); await active; await stopping; }
  assert.equal(setup.ledger.scanning, false);
});

test('a subscriber joins the reserved scan instead of starting another one', async () => {
  let joined: Promise<void> | undefined;
  let joining = false;
  const setup = scanning(cost => {
    if (joining) return;
    joining = true;
    joined = cost.refresh();
  });
  const active = setup.cost.refresh();
  await Promise.resolve();
  try { assert.equal(setup.calls(), 1); }
  finally { setup.release(); await active; await joined; }
});

test('a subscriber can stop a newly announced scan before any request starts', async () => {
  let stopping: Promise<void> | undefined;
  const setup = scanning(cost => { stopping ??= cost.stop(); });
  await setup.cost.refresh();
  await stopping;
  assert.equal(setup.calls(), 0);
  assert.equal(setup.ledger.scanning, false);
});

test('an already cancelled history scan never opens a subscription', async () => {
  const client = new Client('http://localhost');
  let opened = false;
  client.subscribe = () => { opened = true; throw new Error('Subscription must not start'); };
  await assert.rejects(sessionCostHistory(client, { sessionId: 's1' }, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(opened, false);
});
