/** Slash-command syntax, plus the UI routing that decides what Enter means right now. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/slash/parse.ts';
import { COMMAND_HINTS, COMMANDS, suggestedCommands } from '../../src/slash/registry.ts';
import { routeEnter, type RouteFacts } from '../../src/ui/routing.ts';

const CHAT: RouteFacts = { line: '', referenceOpen: false, copyMode: false, pending: false, question: false, screen: 'chat' };
const route = (line: string, extra: Partial<RouteFacts> = {}) => routeEnter({ ...CHAT, line, ...extra });

test('/coredump takes an optional tag and needs no session', () => {
  assert.deepEqual(parseCommand('/coredump'), { kind: 'coredump' });
  assert.deepEqual(parseCommand('/coredump point-A-baseline'), { kind: 'coredump', tag: 'point-A-baseline' });
  assert.deepEqual(parseCommand('/coredump "after stress"'), { kind: 'coredump', tag: 'after stress' });
  // The client's own heap is diagnosable from a picker, offline, or while a request is pending.
  assert.deepEqual(route('/coredump', { screen: 'sessions' }), { kind: 'coredump' });
  assert.deepEqual(route('/coredump leak', { pending: true }), { kind: 'coredump', tag: 'leak' });
  // A trailing tag never becomes the argument of a different command.
  assert.deepEqual(parseCommand('/coredumpx'), { kind: 'error', message: 'Unknown command. Use /help.' });
});

test('routing owns the UI modes while the parser owns the syntax', () => {
  // Enter means something else before the line is ever parsed.
  assert.deepEqual(route('anything', { referenceOpen: true }), { kind: 'reference' });
  assert.deepEqual(route('/help', { copyMode: true }), { kind: 'ignore' });
  assert.deepEqual(route('   '), { kind: 'ignore' });
  assert.deepEqual(route('free text', { question: true }), { kind: 'answer', text: 'free text' });
  assert.deepEqual(route('free text', { pending: true }), { kind: 'error', message: 'Answer the approval with /allow or /deny' });
  assert.deepEqual(route('some/path', { screen: 'path' }), { kind: 'path', value: 'some/path' });
  assert.deepEqual(route('hello'), { kind: 'prompt', text: 'hello' });
  assert.deepEqual(route('hello', { screen: 'workspaces' }), { kind: 'error', message: 'Choose a session or type /ws or /resume' });
  // A screen guard only decides whether a parsed command may run here.
  assert.deepEqual(route('/model', { screen: 'workspaces' }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/queue', { pending: true }), { kind: 'error', message: 'Answer the pending question or approval first' });
  assert.deepEqual(route('!ls', { screen: 'workspaces' }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/latest', { screen: 'workspaces' }), { kind: 'latest' });
});

test('/coredump is advertised with its optional tag', () => {
  const hint = COMMAND_HINTS.find(item => item.command === '/coredump');
  assert.equal(hint?.usage, '[tag]');
  assert.ok(hint && hint.description.length > 0);
  assert.ok(COMMANDS.includes('/coredump'));
  assert.deepEqual(suggestedCommands('/core'), ['/coredump']);
});
