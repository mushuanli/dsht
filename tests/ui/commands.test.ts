/** Slash-command syntax, plus the UI routing that decides what Enter means right now. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/slash/parse.ts';
import { COMMAND_HINTS, COMMAND_POLICY, COMMANDS, suggestedCommands } from '../../src/slash/registry.ts';
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

test('/prompt opens the saved list or saves the trailing text verbatim', () => {
  assert.deepEqual(parseCommand('/prompt'), { kind: 'prompts' });
  assert.deepEqual(parseCommand('/prompt   '), { kind: 'prompts' });
  assert.deepEqual(parseCommand('/prompt Fix this bug and add tests'), { kind: 'savePrompt', text: 'Fix this bug and add tests' });
  // The saved text is what will be sent, so quoting is content rather than syntax.
  assert.deepEqual(parseCommand('/prompt "Review this code"'), { kind: 'savePrompt', text: '"Review this code"' });
  assert.deepEqual(parseCommand('/promptx'), { kind: 'error', message: 'Unknown command. Use /help.' });
  // Listing needs a conversation the composer belongs to; saving works from any screen and offline.
  assert.deepEqual(route('/prompt', { screen: 'workspaces' }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/prompt Review for bugs', { screen: 'workspaces' }), { kind: 'savePrompt', text: 'Review for bugs' });
  assert.deepEqual(route('/prompt Review for bugs', { pending: true }), { kind: 'savePrompt', text: 'Review for bugs' });
});

test('/prompt is advertised in the command catalog', () => {
  const hint = COMMAND_HINTS.find(item => item.command === '/prompt');
  assert.equal(hint?.usage, '[text]');
  assert.ok(hint && hint.description.length > 0);
  assert.deepEqual(suggestedCommands('/pro'), ['/prompt']);
});

test('routing constraints live on the command, so the router enumerates no kinds', () => {
  // A command declares its own constraints; the router only reads this table.
  assert.deepEqual(COMMAND_POLICY.prompts, { chatOnly: true });
  assert.deepEqual(COMMAND_POLICY.queue, { chatOnly: true, blockedByPending: true });
  assert.deepEqual(COMMAND_POLICY.hostCommand, { chatOnly: true, blockedByPending: true });
  // A kind with no policy runs anywhere, even while an answer is pending.
  assert.equal(COMMAND_POLICY.savePrompt, undefined);
  assert.equal(COMMAND_POLICY.coredump, undefined);
});

test('/handoff takes no arguments and waits for a pending answer', () => {
  assert.deepEqual(parseCommand('/handoff'), { kind: 'handoff' });
  assert.deepEqual(parseCommand('/handoff now'), { kind: 'error', message: 'Use /handoff (no arguments)' });
  assert.deepEqual(parseCommand('/handoffx'), { kind: 'error', message: 'Unknown command. Use /help.' });
  assert.deepEqual(COMMAND_POLICY.handoff, { chatOnly: true, blockedByPending: true });
  // It sends a turn, so it needs a conversation and a settled approval or question.
  assert.deepEqual(route('/handoff', { screen: 'workspaces' }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/handoff', { pending: true }), { kind: 'error', message: 'Answer the pending question or approval first' });
  const hint = COMMAND_HINTS.find(item => item.command === '/handoff');
  assert.ok(hint && hint.description.length > 0);
  assert.deepEqual(suggestedCommands('/han'), ['/handoff']);
});
