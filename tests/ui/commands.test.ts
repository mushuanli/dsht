/** Slash-command syntax, plus the UI routing that decides what Enter means right now. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/slash/parse.ts';
import { COMMAND_HINTS, COMMAND_POLICY, COMMANDS, commandMatches, resolveCommand, suggestedCommands } from '../../src/slash/registry.ts';
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

test('a unique command prefix runs without being typed in full', () => {
  // The token resolves to the one command it names, and the arguments are kept.
  assert.deepEqual(parseCommand('/pro Add tests'), { kind: 'savePrompt', text: 'Add tests' });
  assert.deepEqual(parseCommand('/pro'), { kind: 'prompts' });
  assert.deepEqual(parseCommand('/hi needle'), { kind: 'history', query: 'needle' });
  assert.deepEqual(parseCommand('/th'), { kind: 'think', target: '' });
  assert.deepEqual(parseCommand('/mod x y'), { kind: 'models', args: ['x', 'y'] });
  // An exact command is untouched, and an unknown token still fails.
  assert.deepEqual(parseCommand('/history'), { kind: 'history', query: '' });
  assert.deepEqual(parseCommand('/promptx'), { kind: 'error', message: 'Unknown command. Use /help.' });
});

test('an ambiguous prefix names its candidates instead of running one', () => {
  assert.deepEqual(parseCommand('/co'), { kind: 'error', message: 'Ambiguous command. Matches: /copy /compact /coredump /cost' });
  assert.deepEqual(parseCommand('/q'), { kind: 'error', message: 'Ambiguous command. Matches: /queue /quit' });
  // A token that matches every command is not worth listing.
  assert.deepEqual(parseCommand('/'), { kind: 'error', message: 'Unknown command. Use /help.' });
});

test('commands that must be typed in full refuse a prefix', () => {
  assert.deepEqual(parseCommand('/quit'), { kind: 'quit' });
  assert.deepEqual(parseCommand('/qui'), { kind: 'error', message: 'Type the full command: /quit' });
  assert.deepEqual(parseCommand('/a'), { kind: 'error', message: 'Type the full command: /allow' });
  assert.deepEqual(parseCommand('/den'), { kind: 'error', message: 'Type the full command: /deny' });
});

test('the resolver reports one match, none, or the exact-only refusal', () => {
  assert.equal(resolveCommand('/prompt'), '/prompt');
  assert.equal(resolveCommand('/pro'), '/prompt');
  assert.equal(resolveCommand('/co'), undefined);
  assert.equal(resolveCommand('/qui'), undefined);
  assert.equal(resolveCommand('/nope'), undefined);
  assert.deepEqual(commandMatches('/ex'), ['/export', '/export-html']);
  assert.deepEqual(commandMatches('/nope'), []);
});

test('/loop takes a positional score and tries plus a free-form prompt', () => {
  assert.deepEqual(parseCommand('/loop 8 5 帮我优化这个函数'), {
    kind: 'loop', options: { score: 8, tries: 5 }, prompt: '帮我优化这个函数' });
  // A leading step range is optional; the two numbers and the rest of the line follow it.
  assert.deepEqual(parseCommand('/loop --from 2 --to 4 8.5 3 do the thing'), {
    kind: 'loop', options: { from: 2, to: 4, score: 8.5, tries: 3 }, prompt: 'do the thing' });
  // Line breaks inside the prompt survive, because only the leading tokens are numbers.
  const multiline = parseCommand('/loop 8 2 first line\nsecond line');
  assert.ok(multiline.kind === 'loop');
  assert.equal(multiline.prompt, 'first line\nsecond line');
  for (const line of ['/loop', '/loop 8', '/loop 8 5', '/loop abc 5 x', '/loop 11 5 x', '/loop 8 0 x',
    '/loop 8 20 x', '/loop --to 11 8 5 x', '/loop --nope 1 8 5 x']) {
    assert.deepEqual(parseCommand(line), { kind: 'error', message: 'Use /loop [--from N] [--to N] <score> <tries> <prompt>' }, line);
  }
  assert.deepEqual(COMMAND_POLICY.loop, { chatOnly: true, blockedByPending: true });
  // An ad-hoc loop is costly, so a prefix of it must be typed in full.
  assert.deepEqual(parseCommand('/lo 8 5 x'), { kind: 'error', message: 'Type the full command: /loop' });
  const hint = COMMAND_HINTS.find(item => item.command === '/loop');
  assert.equal(hint?.usage, '<score> <tries> <prompt>');
  assert.deepEqual(suggestedCommands('/loo'), ['/loop']);
});

test('/verify stores, inspects and clears the standard the next loop uses', () => {
  assert.deepEqual(parseCommand('/verify'), { kind: 'verify' });
  assert.deepEqual(parseCommand('/verify off'), { kind: 'verify', clear: true });
  assert.deepEqual(parseCommand('/verify 必须通过 npm test'), { kind: 'verify', criteria: '必须通过 npm test' });
  // Line breaks matter: the standard is a checklist the verifier reads verbatim.
  const multiline = parseCommand('/verify first\nsecond');
  assert.ok(multiline.kind === 'verify');
  assert.equal(multiline.criteria, 'first\nsecond');
  assert.deepEqual(COMMAND_POLICY.verify, { chatOnly: true });
  const hint = COMMAND_HINTS.find(item => item.command === '/verify');
  assert.equal(hint?.usage, '<criteria|off>');
  assert.deepEqual(suggestedCommands('/ver'), ['/verify']);
});

test('/design-review parses its four options and rejects a malformed line', () => {
  assert.deepEqual(parseCommand('/design-review'), { kind: 'designReview', options: {} });
  assert.deepEqual(parseCommand('/design-review --from 3 --to 5 --score 8.5 --tries 4'), {
    kind: 'designReview', options: { from: 3, to: 5, score: 8.5, tries: 4 } });
  // A non-number, an out-of-range value, a flag without a value and a stray word are all refused.
  for (const line of ['/design-review --from x', '/design-review --score 11', '/design-review --tries',
    '/design-review --from 0', '/design-review --from 3 extra', '/design-review --nope 1']) {
    assert.deepEqual(parseCommand(line), { kind: 'error', message: 'Use /design-review [--from N] [--to N] [--score X] [--tries N]' }, line);
  }
  // It sends a turn, so it needs a conversation and a settled answer; a costly run is typed in full.
  assert.deepEqual(COMMAND_POLICY.designReview, { chatOnly: true, blockedByPending: true });
  assert.deepEqual(parseCommand('/des'), { kind: 'error', message: 'Type the full command: /design-review' });
  const hint = COMMAND_HINTS.find(item => item.command === '/design-review');
  assert.equal(hint?.usage, '[options]');
  assert.deepEqual(suggestedCommands('/design'), ['/design-review']);
});
