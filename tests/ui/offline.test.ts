/** Startup guidance names the connection state and the one command that resolves it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_COMMAND, dshUrlLine, offlineGuidance } from '../../src/ui/offline.ts';

/** The three published states that leave a startup picker with nothing to show. */
const BASE = 'http://127.0.0.1:3080/';

test('a refused connection says the host is offline and how to start it', () => {
  const guidance = offlineGuidance({ status: 'Reconnecting…', base: BASE, lastFailure: 'connect ECONNREFUSED 127.0.0.1:3080' });
  assert.equal(guidance.title, `Host offline · ${BASE}`);
  assert.ok(guidance.lines.some(line => line.trim() === HOST_COMMAND));
  assert.ok(guidance.lines.some(line => line.includes(`export DSH_URL='${BASE}?token=<token>'`)));
  // The raw failure stays visible, but as a dim diagnostic rather than as the message.
  assert.equal(guidance.detail, 'connect ECONNREFUSED 127.0.0.1:3080');
});

test('the first attempt is named as connecting, never as offline', () => {
  const guidance = offlineGuidance({ status: 'Connecting…', base: BASE });
  assert.equal(guidance.title, `Connecting… · ${BASE}`);
  assert.equal(guidance.detail, undefined);
  assert.ok(guidance.lines.some(line => line.trim() === HOST_COMMAND));
});

test('a refused credential asks for the printed URL or DSH_TOKEN', () => {
  const guidance = offlineGuidance({ status: 'Login required', base: 'http://host:3080/', lastFailure: '401 unauthorized' });
  assert.equal(guidance.title, 'Login required · http://host:3080/');
  assert.ok(guidance.lines.some(line => line.includes('DSH_TOKEN')));
  assert.equal(guidance.detail, '401 unauthorized');
});

test('a host URL keeps its own separator and gains the trailing slash a token URL needs', () => {
  assert.equal(dshUrlLine('http://host:3080'), "export DSH_URL='http://host:3080/?token=<token>'");
  assert.equal(dshUrlLine('http://host:3080/?x=1'), "export DSH_URL='http://host:3080/?x=1&token=<token>'");
});
