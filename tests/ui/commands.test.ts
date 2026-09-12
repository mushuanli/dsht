/** Classification and catalog entry for the local `/coredump` diagnostic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySubmission, type SubmissionContext } from '../../src/ui/commands/parse.ts';
import { COMMAND_HINTS, COMMANDS, suggestedCommands } from '../../src/ui/commands/registry.ts';

const CHAT: SubmissionContext = { referenceOpen: false, copyMode: false, pending: false, question: false, screen: 'chat' };

test('/coredump takes an optional tag and needs no session', () => {
  assert.deepEqual(classifySubmission('/coredump', CHAT), { kind: 'coredump' });
  assert.deepEqual(classifySubmission('/coredump point-A-baseline', CHAT), { kind: 'coredump', tag: 'point-A-baseline' });
  assert.deepEqual(classifySubmission('/coredump "after stress"', CHAT), { kind: 'coredump', tag: 'after stress' });
  // The client's own heap is diagnosable from a picker, offline, or while a request is pending.
  assert.deepEqual(classifySubmission('/coredump', { ...CHAT, screen: 'sessions' }), { kind: 'coredump' });
  assert.deepEqual(classifySubmission('/coredump leak', { ...CHAT, pending: true }), { kind: 'coredump', tag: 'leak' });
  // A trailing tag never becomes the argument of a different command.
  assert.deepEqual(classifySubmission('/coredumpx', CHAT), { kind: 'error', message: 'Unknown command. Use /help.' });
});

test('/coredump is advertised with its optional tag', () => {
  const hint = COMMAND_HINTS.find(item => item.command === '/coredump');
  assert.equal(hint?.usage, '[tag]');
  assert.ok(hint && hint.description.length > 0);
  assert.ok(COMMANDS.includes('/coredump'));
  assert.deepEqual(suggestedCommands('/core'), ['/coredump']);
});
