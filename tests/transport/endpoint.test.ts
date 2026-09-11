/** The startup URL accepts the token form that dsh web prints. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint } from '../../src/transport/endpoint.ts';

test('splits the token query parameter and keeps a bare URL', () => {
  assert.deepEqual(endpoint('http://127.0.0.1:3080/?token=abc', undefined), { url: 'http://127.0.0.1:3080/', token: 'abc' });
  assert.deepEqual(endpoint('http://127.0.0.1:3080', undefined), { url: 'http://127.0.0.1:3080/', token: undefined });
});

test('DSH_TOKEN takes precedence and blank values never become a token', () => {
  assert.equal(endpoint('http://host/?token=from-url', 'from-env').token, 'from-env');
  assert.equal(endpoint('http://host/?token=from-url', '').token, 'from-url');
  assert.deepEqual(endpoint('http://host/?token=', undefined), { url: 'http://host/', token: undefined });
  assert.deepEqual(endpoint('http://host/?token=', ''), { url: 'http://host/', token: undefined });
});

test('rejects a URL that carries more than the token parameter', () => {
  assert.equal(endpoint('http://host/?token=abc&x=1', undefined).url, 'http://host/?x=1');
});
