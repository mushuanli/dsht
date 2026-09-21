/** Diagnostic text hygiene: what may leave the machine inside a pasted log. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTraceText } from '../../src/text.ts';

test('a diagnostic line loses absolute paths and credentials before it is quoted', () => {
  assert.equal(sanitizeTraceText('Error: /home/li/prj/deepseek-harness/tui/loop.yaml is invalid'),
    'Error: <path> is invalid');
  assert.equal(sanitizeTraceText('C:\\Users\\li\\project\\config.yaml: ENOENT'), '<path> ENOENT');
  // Both the header name and the value go: either one alone would name the credential.
  assert.equal(sanitizeTraceText('auth failed: Authorization=Bearer sk-abcdefghijklmnop'),
    'auth failed: <redacted> <redacted>');
  assert.equal(sanitizeTraceText('key=9f8e7d6c5b4a39281706f5e4d3c2b1a0'), 'key=<redacted>');
  // A URL keeps its origin — that is the diagnosable part — while the path inside it goes.
  assert.equal(sanitizeTraceText('GET http://127.0.0.1:3080/api/session/list failed'),
    'GET http://127.0.0.1:3080<path> failed');
});

test('an identifier that merely contains a slash survives', () => {
  assert.equal(sanitizeTraceText('session/agent-busy'), 'session/agent-busy');
  assert.equal(sanitizeTraceText('verifier wrote no verdict (exit 3)'), 'verifier wrote no verdict (exit 3)');
});

test('a long or multi-line capture stays one bounded field', () => {
  assert.equal(sanitizeTraceText('first\nsecond\tthird'), 'first second third');
  const long = sanitizeTraceText('x'.repeat(500), 20);
  assert.equal(long.length, 21);
  assert.match(long, /…$/u);
});
