/** The reconnect policy: bounded jittered backoff, and the rule that decides when it starts over. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECONNECT_STABLE_MS, nextReconnectAttempt, reconnectDelayMs } from '../../src/controller/reconnect.ts';

test('the reconnect delay doubles from 500 ms, caps at 10 s, and stays jittered', () => {
  const middle = () => 0.5;
  const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 0.001, `${value} ≠ ${expected}`);
  near(reconnectDelayMs(0, middle), 500);
  near(reconnectDelayMs(1, middle), 1_000);
  near(reconnectDelayMs(4, middle), 8_000);
  near(reconnectDelayMs(9, middle), 10_000);
  // Jitter spans ±20%, so many clients do not return in lockstep; the bounds are the contract.
  near(reconnectDelayMs(1, () => 0), 800);
  near(reconnectDelayMs(1, () => 1), 1_200);
  near(reconnectDelayMs(-1, middle), 500);
});

test('the count starts over only after a generation was stable, not merely ready', () => {
  // The rule that used to be wrong: a host that accepted every stream and then failed on the first
  // session frame reset the counter every time, which re-listed every session twice a second.
  assert.equal(nextReconnectAttempt(0, 0), 1, 'never ready keeps counting');
  assert.equal(nextReconnectAttempt(3, 1_000), 4, 'a generation that died soon after ready keeps counting');
  assert.equal(nextReconnectAttempt(3, RECONNECT_STABLE_MS - 1), 4);
  assert.equal(nextReconnectAttempt(3, RECONNECT_STABLE_MS), 0, 'a stable generation earns a fresh start');
  assert.equal(nextReconnectAttempt(7, 60_000), 0);
  // The consequence an operator feels: a repeating post-ready failure backs off instead of spinning.
  let attempt = 0;
  const waits: number[] = [];
  for (let round = 0; round < 6; round++) {
    waits.push(reconnectDelayMs(attempt, () => 0.5));
    attempt = nextReconnectAttempt(attempt, 2_000);
  }
  assert.deepEqual(waits.map(wait => Math.round(wait)), [500, 1_000, 2_000, 4_000, 8_000, 10_000]);
});
