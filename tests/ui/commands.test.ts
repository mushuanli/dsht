/** Slash-command syntax, plus the pipeline that decides what Enter means right now. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, loopNameQuery, validLoopOption } from '../../src/slash/parse.ts';
import { COMMAND_HINTS, COMMAND_POLICY, COMMANDS, argumentHint, commandMatches, resolveCommand, suggestedCommands } from '../../src/slash/registry.ts';
import { interpret, normalize, authorize, type LineCommand, type UiAction } from '../../src/slash/pipeline.ts';

/** Front-end and application facts a test may vary; the defaults describe a live chat screen. */
interface Facts {
  referenceOpen?: boolean; copyMode?: boolean;
  screen?: 'workspaces' | 'sessions' | 'chat' | 'path';
  question?: boolean; pending?: boolean; sessionSelected?: boolean;
  during?: 'idle' | 'turn' | 'loop';
  foreground?: boolean;
}
const chat: Required<Omit<Facts, 'screen'>> & { screen: 'workspaces' | 'sessions' | 'chat' | 'path' } = {
  referenceOpen: false, copyMode: false, screen: 'chat', question: false, pending: false, sessionSelected: true,
  during: 'idle', foreground: false,
};
/** The three stages in order: a line's mode, or the command (or refusal) it becomes. */
function stages(line: string, extra: Facts = {}) {
  const facts = { ...chat, ...extra };
  const submission = interpret({ line, referenceOpen: facts.referenceOpen, copyMode: facts.copyMode, screen: facts.screen });
  if (submission.kind === 'mode') return { submission };
  const command = normalize(submission, { sessionSelected: facts.sessionSelected, question: facts.question, pending: facts.pending });
  const verdict = authorize(command, { sessionSelected: facts.sessionSelected, pending: facts.pending,
    during: facts.during, foreground: facts.foreground });
  return { submission, command, verdict };
}
/** The command a line executes, or the error a refused line produces. */
const route = (line: string, extra: Facts = {}): LineCommand => {
  const { verdict } = stages(line, extra);
  assert.ok(verdict !== undefined, line);
  return verdict.allow ? verdict.command : verdict.error;
};
/** Why an accepted line is held rather than running now, when it is. */
const defer = (line: string, extra: Facts = {}) => {
  const { verdict } = stages(line, extra);
  return verdict?.allow === true ? verdict.defer : undefined;
};
/** The front-end action a line produces, when the front end handles it itself. */
const ui = (line: string, extra: Facts = {}): UiAction | undefined => {
  const { submission } = stages(line, extra);
  return submission.kind === 'mode' ? submission.action : undefined;
};

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

test('the pipeline owns the front-end modes while the parser owns the syntax', () => {
  // Enter means something else before the line is ever parsed.
  assert.deepEqual(ui('anything', { referenceOpen: true }), { kind: 'reference' });
  assert.deepEqual(ui('/help', { copyMode: true }), { kind: 'ignore' });
  assert.deepEqual(ui('   '), { kind: 'ignore' });
  assert.deepEqual(route('free text', { question: true }), { kind: 'answer', text: 'free text' });
  assert.deepEqual(route('free text', { pending: true }), { kind: 'error', message: 'Answer the approval with /allow or /deny' });
  assert.deepEqual(route('some/path', { screen: 'path' }), { kind: 'path', value: 'some/path' });
  assert.deepEqual(route('hello'), { kind: 'prompt', text: 'hello' });
  assert.deepEqual(route('hello', { sessionSelected: false }), { kind: 'error', message: 'Choose a session or type /ws or /resume' });
  // A screen never decides policy: only the command's own constraint and the application facts do.
  assert.deepEqual(route('/model', { sessionSelected: false }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/queue', { pending: true }), { kind: 'error', message: 'Answer the pending question or approval first' });
  assert.deepEqual(route('!ls', { sessionSelected: false }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/latest', { sessionSelected: false }), { kind: 'latest' });
});

test('a running turn or loop queues the operator\'s own writes and refuses the rest', () => {
  // A compaction, a handoff and a review start are the operator saying "do this next": they are
  // accepted and held until the turn (or the loop) ends, not refused.
  for (const during of ['turn', 'loop'] as const) {
    assert.deepEqual(route('/compact', { during }), { kind: 'compact' });
    assert.equal(defer('/compact', { during }), during);
    assert.deepEqual(route('/handoff', { during }), { kind: 'handoff' });
    assert.equal(defer('/handoff', { during }), during);
    assert.deepEqual(route('/loop design-review 9', { during }), { kind: 'loop', name: 'design-review', options: { score: 9 } });
    assert.equal(defer('/loop design-review 9', { during }), during);
    // A record list is a surface for the draft being typed, so offering it later would be noise.
    assert.deepEqual(route('/loop', { during }), { kind: 'error',
      message: during === 'loop' ? 'Stop the running loop first' : 'Wait for the running turn to finish' });
    // Answering, cancelling, reading and view changes keep working while the agent works.
    assert.equal(defer('/cancel', { during }), undefined);
    assert.deepEqual(route('/cancel', { during }), { kind: 'cancel' });
    assert.deepEqual(route('/help', { during }), { kind: 'panel', panel: 'help' });
    assert.deepEqual(route('/allow', { during }), { kind: 'approval', allowed: true });
    assert.deepEqual(route('/latest', { during }), { kind: 'latest' });
    assert.deepEqual(route('/history', { during }), { kind: 'history', query: '' });
    // The host owns the busy rules of its own registered commands.
    assert.deepEqual(route('/plan off', { during }), { kind: 'hostCommand', line: '/plan off' });
    assert.deepEqual(route('/model', { during }), { kind: 'models', args: [] });
  }
  // A pending interaction is the more actionable reason, so it wins over the running turn.
  assert.deepEqual(route('/handoff', { pending: true, during: 'turn' }),
    { kind: 'error', message: 'Answer the pending question or approval first' });
});

test('the foreground slot is authorize\'s business, with a reason and one control exception', () => {
  // A second line while something owns the slot is refused with a reason instead of being dropped in
  // silence by whichever front end noticed first.
  assert.deepEqual(route('/compact', { foreground: true }),
    { kind: 'error', message: 'Wait for the running operation to finish' });
  assert.deepEqual(route('/help', { foreground: true }),
    { kind: 'error', message: 'Wait for the running operation to finish' });
  assert.deepEqual(route('hello', { foreground: true }),
    { kind: 'error', message: 'Wait for the running operation to finish' });
  // The commands that answer the operator or the host are admitted through: they exist to interrupt
  // or settle what owns the slot, and waiting for an export before stopping the agent would be absurd.
  assert.deepEqual(route('/loop stop', { foreground: true }), { kind: 'loopStop' });
  assert.deepEqual(route('/cancel', { foreground: true }), { kind: 'cancel' });
  assert.deepEqual(route('/allow', { foreground: true }), { kind: 'approval', allowed: true });
  // A line the policy queues behind a turn is decided by that fact: the slot being busy right now says
  // nothing about whether it should run, and the held line waits for both.
  assert.equal(defer('/compact', { during: 'turn', foreground: true }), 'turn');
  // A fact the policy refuses is refused whoever else is busy; the message names what to stop.
  assert.deepEqual(route('/loop', { during: 'loop', foreground: true }),
    { kind: 'error', message: 'Stop the running loop first' });
  assert.deepEqual(route('/loop stop', { during: 'loop', foreground: true }), { kind: 'loopStop' });
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
  // Listing needs a conversation the composer belongs to; saving works without one.
  assert.deepEqual(route('/prompt', { sessionSelected: false }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/prompt Review for bugs', { sessionSelected: false }), { kind: 'savePrompt', text: 'Review for bugs' });
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
  assert.deepEqual(COMMAND_POLICY.prompts, { requiresSession: true });
  assert.deepEqual(COMMAND_POLICY.queue, { requiresSession: true, requiresNoInteraction: true });
  assert.deepEqual(COMMAND_POLICY.hostCommand, { requiresSession: true, requiresNoInteraction: true });
  // A turn or a loop in flight refuses only the commands that would write to the same conversation,
  // and the host keeps deciding for its own registered commands.
  assert.deepEqual(COMMAND_POLICY.compact, { requiresSession: true, duringTurn: 'queue', duringLoop: 'queue' });
  assert.deepEqual(COMMAND_POLICY.models, { requiresSession: true });
  assert.deepEqual(COMMAND_POLICY.cancel, { duringTurn: 'run', duringLoop: 'run', whileBusy: 'run' });
  // A kind with no policy runs anywhere, even while an answer is pending.
  assert.equal(COMMAND_POLICY.savePrompt, undefined);
  assert.equal(COMMAND_POLICY.coredump, undefined);
});

test('/handoff takes no arguments and waits for a pending answer', () => {
  assert.deepEqual(parseCommand('/handoff'), { kind: 'handoff' });
  assert.deepEqual(parseCommand('/handoff now'), { kind: 'error', message: 'Use /handoff (no arguments)' });
  assert.deepEqual(parseCommand('/handoffx'), { kind: 'error', message: 'Unknown command. Use /help.' });
  assert.deepEqual(COMMAND_POLICY.handoff, { requiresSession: true, requiresNoInteraction: true,
    duringTurn: 'queue', duringLoop: 'queue' });
  // It sends a turn, so it needs a conversation and a settled approval or question.
  assert.deepEqual(route('/handoff', { sessionSelected: false }), { kind: 'error', message: 'Select a session first' });
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

test('/loop takes a record name, an optional positional score and tries, and the shared flags', () => {
  assert.deepEqual(parseCommand('/loop design-review'), { kind: 'loop', name: 'design-review', options: {} });
  assert.deepEqual(parseCommand('/loop designdoc-review 8.5 3 --from 2 --to 4'), {
    kind: 'loop', name: 'designdoc-review', options: { from: 2, to: 4, score: 8.5, tries: 3 } });
  // Flags and positional values are interchangeable, and the last one written wins.
  assert.deepEqual(parseCommand('/loop design-review --score 9 7'), {
    kind: 'loop', name: 'design-review', options: { score: 7 } });
  for (const line of ['/loop --from 2', '/loop design-review abc', '/loop design-review 11',
    '/loop design-review 8 0', '/loop design-review 8 3 extra', '/loop design-review --score 11', '/loop design-review --nope 1']) {
    assert.deepEqual(parseCommand(line), { kind: 'error', message: 'Use /loop <name> [score] [tries] [--from N] [--to N] [--score X] [--tries N]' }, line);
  }
  // The name is looked up at execution time, so the syntax layer accepts any non-flag token.
  assert.deepEqual(parseCommand('/loop nope'), { kind: 'loop', name: 'nope', options: {} });
  // `stop` is `/loop`'s own subcommand, so it is never read as a record name.
  assert.deepEqual(parseCommand('/loop stop'), { kind: 'loopStop' });
  assert.deepEqual(parseCommand('/loop stop 9'), { kind: 'error', message: 'Use /loop stop (no arguments)' });
  assert.deepEqual(parseCommand('/loop stop --to 3'), { kind: 'error', message: 'Use /loop stop (no arguments)' });
  assert.deepEqual(COMMAND_POLICY.loopStop, { requiresSession: true, control: true,
    whileBusy: 'run', duringTurn: 'run', duringLoop: 'run' });
  // The control lane is what lets `/loop stop` reach the application while the run owns the composer.
  // The control lane is data on the command: `authorize` is what reads it (see the busy case below).
  assert.equal(COMMAND_POLICY.loopStop?.control, true);
  assert.equal(COMMAND_POLICY.loop?.control, undefined);
  assert.deepEqual(COMMAND_POLICY.loop, { requiresSession: true, requiresNoInteraction: true,
    duringTurn: 'queue', duringLoop: 'queue' });
  // A costly run is typed in full.
  assert.deepEqual(parseCommand('/lo design-review'), { kind: 'error', message: 'Type the full command: /loop' });
  const hint = COMMAND_HINTS.find(item => item.command === '/loop');
  assert.equal(hint?.usage, '[name|stop] [score] [tries]');
  assert.deepEqual(suggestedCommands('/loo'), ['/loop']);
});

test('/loop with no name asks for the record list instead of being a syntax error', () => {
  assert.deepEqual(parseCommand('/loop'), { kind: 'loops' });
  assert.deepEqual(parseCommand('/loop   '), { kind: 'loops' });
  assert.deepEqual(COMMAND_POLICY.loops, { requiresSession: true, requiresNoInteraction: true,
    duringTurn: 'deny', duringLoop: 'deny' });
  // The list needs a conversation and a settled approval or question, exactly like the run itself.
  assert.deepEqual(route('/loop', { sessionSelected: false }), { kind: 'error', message: 'Select a session first' });
  assert.deepEqual(route('/loop', { pending: true }), { kind: 'error', message: 'Answer the pending question or approval first' });
});

test('routing leaves the decision to run or confirm to the application', () => {
  // A named record is one command; whether it opens its form depends on the caller's port, not here.
  assert.deepEqual(route('/loop design-review'), { kind: 'loop', name: 'design-review', options: {} });
  assert.deepEqual(route('/loop design-review 9'), { kind: 'loop', name: 'design-review', options: { score: 9 } });
  assert.deepEqual(route('/loop design-review --to 3'), { kind: 'loop', name: 'design-review', options: { to: 3 } });
  assert.deepEqual(route('/loop nope'), { kind: 'loop', name: 'nope', options: {} });
});

test('the loop-name menu appears only while the draft is still one name', () => {
  assert.equal(loopNameQuery('/loop'), '');
  assert.equal(loopNameQuery('/loop '), '');
  assert.equal(loopNameQuery('/loop des'), 'des');
  // The subcommands are not records, so the menu never filters by one.
  assert.equal(loopNameQuery('/loop stop'), undefined);
  assert.equal(loopNameQuery('/loop abort'), undefined);
  assert.equal(loopNameQuery('/loop answer'), undefined);
  // A trailing space after a complete name still confirms it rather than hiding the menu.
  assert.equal(loopNameQuery('/loop design-review '), 'design-review');
  // A second word means the operator moved on to the flags.
  assert.equal(loopNameQuery('/loop design-review 9'), undefined);
  assert.equal(loopNameQuery('/loop design-review --to'), undefined);
  assert.equal(loopNameQuery('/loopx'), undefined);
  assert.equal(loopNameQuery('/other des'), undefined);
  assert.equal(loopNameQuery('hello'), undefined);
});

test('the form validates a value with the same rule the command line uses', () => {
  assert.equal(validLoopOption('from', 1), true);
  assert.equal(validLoopOption('from', 0), false);
  assert.equal(validLoopOption('to', 3), true);
  assert.equal(validLoopOption('score', 8.5), true);
  assert.equal(validLoopOption('score', 11), false);
  assert.equal(validLoopOption('tries', 0), false);
  assert.equal(validLoopOption('tries', 2), true);
});

test('once arguments begin, the composer can name what the command takes', () => {
  assert.equal(argumentHint('/think ')?.command, '/think');
  assert.equal(argumentHint('/think 3')?.usage, '[seq or live]');
  // A unique prefix already runs the command, so its arguments are hinted too.
  assert.equal(argumentHint('/pro Add tests')?.command, '/prompt');
  assert.equal(argumentHint('/loop ')?.command, '/loop');
  // Still completing a name, naming no single command, or not a command at all: no hint.
  assert.equal(argumentHint('/think'), undefined);
  assert.equal(argumentHint('/co x'), undefined);
  assert.equal(argumentHint('/nope x'), undefined);
  assert.equal(argumentHint('hello'), undefined);
});

test('the commands that /loop replaced are gone', () => {
  for (const line of ['/design-review', '/designdoc-review x.md', '/verify off']) {
    assert.deepEqual(parseCommand(line), { kind: 'error', message: 'Unknown command. Use /help.' }, line);
  }
  assert.equal(COMMAND_HINTS.some(item => item.command === '/design-review'), false);
  assert.equal(COMMAND_HINTS.some(item => item.command === '/verify'), false);
});
