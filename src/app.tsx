/** Ink terminal interface: startup pickers, transcript, and slash-command composer. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useMouseWheel } from './mouse.ts';
import { TextInput } from './input.tsx';
import { historyLayout, jumpTarget } from './history.ts';
import { toolLine } from './transcript.ts';
import { activeReference, fileMention, type FileReference } from './references.ts';
import { CostPanel } from './cost-view.tsx';
import { StatusBar } from './status.tsx';
import { Controller } from './controller.ts';
import { navigationCommand, sessionLabel } from './navigation.ts';
import { array, errorText, object, safeText, string, type ObjectValue } from './wire.ts';

const COMMANDS = ['/ws', '/s', '/new', '/older', '/history', '/jump', '/search', '/ssearch', '/wsearch', '/cancel', '/steer', '/allow', '/deny', '/status', '/cost', '/help', '/quit'];
const HELP = '/ws [name or ID] · /s [title or ID] · /s all · /new · /older · /history [text] · /jump <seq|first|last> · /search text · /ssearch text · /wsearch text · /cancel · /steer text · /allow · /deny · /status · /cost · /quit';
/** Longest common prefix of the candidate commands, so Tab can extend an ambiguous draft. */
export function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? '';
  for (const value of values) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index++;
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

/** A slash-command panel closes on the next command or after this long, whichever comes first. */
const PANEL_LIFETIME_MS = 10_000;

interface Choice { key: string; label: string; action(): void }

function Picker({ choices, enabled, canSelect }: { choices: Choice[]; enabled: boolean; canSelect(): boolean }) {
  const [selected, setSelected] = useState(0);
  const current = Math.min(selected, choices.length - 1);
  useInput((_input, key) => {
    if (!canSelect()) return;
    if (key.upArrow) setSelected(Math.max(0, current - 1));
    else if (key.downArrow) setSelected(Math.min(choices.length - 1, current + 1));
    else if (key.return) choices[current]?.action();
  }, { isActive: enabled });
  const start = Math.max(0, current - 7);
  return <Box flexDirection="column">
    {choices.slice(start, start + 12).map((choice, index) => <Text key={choice.key}
      color={start + index === current ? 'cyan' : undefined}>
      {start + index === current ? '❯ ' : '  '}{safeText(choice.label)}
    </Text>)}
    <Text dimColor>↑ ↓ select · Enter open · Ctrl+C stop / exit</Text>
  </Box>;
}

/** The caller owns starting and stopping the controller around the Ink render lifetime. */
export function App({ controller, panelLifetimeMs = PANEL_LIFETIME_MS }: { controller: Controller; panelLifetimeMs?: number }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, updateInput] = useState('');
  const draft = useRef('');
  const [cursor, setCursor] = useState(0);
  // Input callbacks may run before Ink refreshes the controlled field's listener.
  const setInput = (value: string) => { draft.current = value; updateInput(value); setCursor(value.length); };
  const [scroll, setScroll] = useState(0);
  const [historyQuery, setHistoryQuery] = useState<string>();
  const [contentSearch, setContentSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<{ query: string; items: ObjectValue[]; hasMore: boolean }>();
  const historyAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => historyAbort.current?.abort(), []);
  const [costExpanded, setCostExpanded] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [help, setHelp] = useState(false);
  const [answers, setAnswers] = useState<Record<string, ObjectValue[]>>({});
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [dismissedReference, dismissReference] = useState<string>();
  const [lookup, setLookup] = useState<{ draft: string; sessionId: string; items: FileReference[]; error?: string }>();
  // A slash-command panel is temporary: the next command or its lifetime closes it.
  useEffect(() => {
    if (!help && !costExpanded && !statusExpanded) return;
    const timer = setTimeout(() => { setHelp(false); setCostExpanded(false); setStatusExpanded(false); }, panelLifetimeMs);
    return () => clearTimeout(timer);
  }, [help, costExpanded, statusExpanded, panelLifetimeMs]);
  const pending = state.pending[0];
  const token = state.screen === 'chat' && state.online && !state.busy && !pending
    && (!input.startsWith('/') || input.startsWith('/steer ')) && dismissedReference !== input && cursor === input.length
    ? activeReference(input) : undefined;
  const referenceOpen = token !== undefined;
  const matches = referenceOpen && lookup?.draft === input && lookup.sessionId === state.sessionId ? lookup : undefined;
  useEffect(() => {
    if (!referenceOpen) return;
    const abort = new AbortController();
    setLookup(undefined);
    setReferenceIndex(0);
    void controller.references(activeReference(input)!.query, abort.signal).then(items => {
      if (!abort.signal.aborted) setLookup({ draft: input, sessionId: state.sessionId!, items });
    }, error => {
      if (!abort.signal.aborted) setLookup({ draft: input, sessionId: state.sessionId!, items: [], error: errorText(error) });
    });
    return () => abort.abort();
  }, [controller, input, state.sessionId, referenceOpen]);
  const pickReference = () => {
    const candidate = matches?.items[referenceIndex];
    if (!candidate || !token || draft.current !== input) return;
    const mention = fileMention(candidate, token.quoted)!;
    setInput(input.slice(0, -token.prefix.length) + mention + (candidate.kind === 'file' ? ' ' : ''));
  };
  /** Complete the leading slash command; an ambiguous draft extends to the shared prefix. */
  const completeCommand = () => {
    if (!input.startsWith('/') || input.includes(' ')) return;
    const matches = COMMANDS.filter(command => command.startsWith(input));
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) { setInput(`${only} `); return; }
    const prefix = commonPrefix(matches);
    if (prefix.length > input.length) setInput(prefix);
  };
  const questions = pending?.event === 'user-questions/request' ? array(object(pending.request).questions).map(object) : [];
  const eventId = pending ? string(pending.eventId) : '';
  const answered = answers[eventId] ?? [];
  const question = questions[answered.length];
  const operate = (fn: () => Promise<void>) => { void controller.perform(fn); };
  useInput((_value, key) => {
    if ((key.escape || key.ctrl && _value === 'c') && historyAbort.current) { historyAbort.current.abort(); return; }
    if (key.escape && searchResults) { setSearchResults(undefined); if (controller.running) void controller.interrupt(true); return; }
    if (key.escape && historyQuery !== undefined) { setHistoryQuery(undefined); if (controller.running) void controller.interrupt(true); return; }
    if (key.ctrl && _value === 'c') {
      void controller.interrupt().then(shouldExit => { if (shouldExit) exit(); });
      return;
    }
    if (referenceOpen) {
      if (key.escape) { dismissReference(input); if (controller.running) void controller.interrupt(true); }
      else if (key.tab) pickReference();
      else if (key.upArrow) setReferenceIndex(value => Math.max(0, value - 1));
      else if (key.downArrow) setReferenceIndex(value => Math.max(0, Math.min((matches?.items.length ?? 1) - 1, value + 1)));
      return;
    }
    if (key.tab) { completeCommand(); return; }
    if (key.escape && state.screen === 'chat') { void controller.interrupt(true); }
    if (key.pageUp) scrollHistory(10);
    if (key.pageDown) scrollHistory(-10);
  });

  const submit = async (raw: string) => {
    if (referenceOpen) { pickReference(); return; }
    const value = raw.trim();
    if (!value) return;
    // Each panel belongs to the command that opened it, so any other command closes it.
    if (value !== '/help') setHelp(false);
    if (value !== '/cost') setCostExpanded(false);
    if (value !== '/status') setStatusExpanded(false);
    if (value === '/quit') { exit(); return; }
    if (value === '/cost') {
      setCostExpanded(value => !value); setInput('');
      if (!costExpanded) void controller.perform(() => historyOperation(signal => controller.refreshCosts(signal)));
      return;
    }
    if (value === '/status') { setStatusExpanded(value => !value); setInput(''); return; }
    if (value === '/help') { setHelp(value => !value); setInput(''); return; }
    const accepted = await controller.perform(async () => {
      const navigation = navigationCommand(value);
      if (navigation) {
        setHistoryQuery(undefined);
        setSearchResults(undefined);
        if (navigation.kind === 'workspace') await controller.switchWorkspace(navigation.query);
        else await controller.switchSession(navigation.query);
        setScroll(0);
      }
      else if (state.screen === 'path') await controller.createWorkspace(value);
      else if (value === '/new') await controller.createSession();
      else if (value === '/history' || value.startsWith('/history ')) {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        setSearchResults(undefined); setContentSearch(false); setHistoryQuery(value.slice(8).trim());
      }
      else if (/^\/(?:search|ssearch|wsearch)(?: |$)/.test(value)) {
        const [command, ...words] = value.split(' ');
        const query = words.join(' ').trim();
        if (!query) throw new Error(`Use ${command} <text>`);
        await historyOperation(async signal => {
          if (command === '/search') {
            await controller.historyThrough('first', signal);
            setSearchResults(undefined); setContentSearch(true); setHistoryQuery(query);
          } else {
            const result = await controller.searchSessions(query, command === '/ssearch', signal);
            setHistoryQuery(undefined); setSearchResults({ query, ...result });
          }
        });
      }
      else if (value === '/jump' || value.startsWith('/jump ')) await jumpHistory(jumpTarget(value.slice(5).trim()));
      else if (value === '/older') { await controller.older(); setScroll(value => value + 10); }
      else if (value === '/cancel') await controller.cancelTurn();
      else if (value === '/allow') await controller.approve(true);
      else if (value === '/deny') await controller.approve(false);
      else if (value.startsWith('/steer ')) await controller.prompt(value.slice(7), 'steer');
      else if (question) {
        const answer = { id: string(question.id), selected: [], custom: value };
        const next = [...answered, answer];
        if (next.length === questions.length) await controller.answer({ answers: next });
        setAnswers(previous => ({ ...previous, [eventId]: next }));
      } else if (pending) throw new Error('Answer the approval with /allow or /deny');
      else if (value.startsWith('/')) throw new Error('Unknown command. Use /help.');
      else if (state.screen !== 'chat') throw new Error('Choose a session or type /ws or /s');
      else { await controller.prompt(value); setScroll(0); }
    });
    if (accepted) setInput('');
  };

  const choices: Choice[] = state.screen === 'workspaces' ? [
    ...state.workspaces.map(workspace => ({ key: string(workspace.workspaceId),
      label: `${string(workspace.title)}  ${string(workspace.path)}`,
      action: () => controller.pickWorkspace(string(workspace.workspaceId)) })),
    { key: '@all', label: 'All sessions', action: () => operate(() => controller.switchSession('all')) },
    { key: '@new', label: '+ Add workspace (host directory)', action: () => controller.enterPath() },
  ] : [
    ...(state.workspaceId && !state.showAllSessions ? [{ key: '@new', label: '+ New session', action: () => operate(() => controller.createSession()) }] : []),
    ...controller.visibleSessions.map(session => ({ key: string(session.sessionId),
      label: `${session.running ? '● ' : ''}${sessionLabel(session)}  ${session.sessionId}`,
      action: () => { setScroll(0); operate(() => controller.selectSession(string(session.sessionId))); } })),
    { key: '@back', label: '← Workspaces', action: () => operate(() => controller.showPicker('workspaces')) },
  ];
  const width = Math.max(10, (stdout.columns ?? 80) - 2);
  const layout = useMemo(() => historyLayout(state.transcript, width), [state.transcript, state.transcript.version, width]);
  const { lines, first } = layout;
  const pageSize = Math.max(5, (stdout.rows ?? 30) - (pending ? 17 : 12) - (statusExpanded ? 9 : 0));
  const previousView = useRef({ transcript: state.transcript, count: lines.length, first });
  const previous = previousView.current;
  const prepended = previous.first !== undefined && first !== undefined && first < previous.first;
  const adjustedScroll = previous.transcript !== state.transcript ? 0
    : scroll > 0 && !prepended ? Math.max(0, scroll + lines.length - previous.count) : scroll;
  const maxScroll = Math.max(0, lines.length - pageSize);
  const position = Math.min(adjustedScroll, maxScroll);
  useLayoutEffect(() => {
    previousView.current = { transcript: state.transcript, count: lines.length, first };
    if (position !== scroll) setScroll(position);
  }, [state.transcript, lines, position, scroll]);
  const scrollPosition = useRef(position);
  scrollPosition.current = position;
  const loadingPage = useRef(false);
  const scrollIntent = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function scrollHistory(delta: number): void {
    if (state.screen !== 'chat' || historyQuery !== undefined || searchResults !== undefined) return;
    const intent = ++scrollIntent.current;
    const next = Math.max(0, Math.min(maxScroll, scrollPosition.current + delta));
    scrollPosition.current = next;
    setScroll(next);
    if (delta <= 0 || next < maxScroll || loadingPage.current || state.busy || !state.online || !state.transcript.ready || !state.transcript.hasMore) return;
    loadingPage.current = true;
    const transcript = state.transcript;
    void controller.perform(() => historyOperation(signal => controller.older(signal))).then(accepted => {
      if (accepted && mounted.current && controller.state.transcript === transcript && scrollIntent.current === intent) {
        setScroll(value => value + delta);
      }
    }).finally(() => { loadingPage.current = false; });
  }
  async function historyOperation(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const abort = new AbortController();
    historyAbort.current = abort;
    try { await operation(abort.signal); }
    finally { if (historyAbort.current === abort) historyAbort.current = undefined; }
  }
  async function openSearchSession(sessionId: string, query: string): Promise<void> {
    await historyOperation(async signal => {
      await controller.selectSession(sessionId);
      await controller.waitForHistory(signal);
      await controller.historyThrough('first', signal);
      setSearchResults(undefined); setContentSearch(true); setHistoryQuery(query);
    });
  }
  async function jumpHistory(target: number | 'first' | 'last'): Promise<void> {
    if (state.screen !== 'chat') throw new Error('Select a session first');
    ++scrollIntent.current;
    if (target === 'last') { setHistoryQuery(undefined); setScroll(0); return; }
    const abort = new AbortController();
    historyAbort.current = abort;
    try {
      await controller.historyThrough(target, abort.signal);
      abort.signal.throwIfAborted();
      const current = historyLayout(controller.state.transcript, width);
      const seq = target === 'first' ? current.messages[0]?.seq : target;
      const row = seq === undefined ? undefined : current.offsets.get(seq);
      if (row === undefined) throw new Error('No visible message at this sequence; use /history to choose a record');
      setHistoryQuery(undefined);
      setScroll(Math.max(0, current.lines.length - pageSize - row));
    } finally { if (historyAbort.current === abort) historyAbort.current = undefined; }
  }
  useMouseWheel(direction => scrollHistory(direction * 3));
  const end = Math.max(pageSize, lines.length - position);
  const visible = lines.slice(Math.max(0, end - pageSize), end);
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  return <Box flexDirection="column" paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">DeepSeek Harness · HTTP TUI</Text>
      <Text dimColor>{controller.base} · {state.status}{state.busy ? ' · Working…' : ''}</Text>
      <Text wrap="truncate-end">{toolLine(`${workspace ? string(workspace.title) : 'All workspaces'}${state.sessionId ? ` / ${controller.sessionName}` : ''}`, Math.max(1, width - 4))}</Text>
    </Box>
    {state.error && <Text color="red">{state.error}</Text>}
    {searchResults ? <Box flexDirection="column" marginY={1}>
      <Text bold>Session search · {safeText(searchResults.query)}</Text>
      {searchResults.hasMore && <Text color="yellow">Host returned only the first 20 global matches; workspace results may be incomplete. Refine your query.</Text>}
      {!searchResults.items.length && <Text>No sessions in the returned results</Text>}
      <Picker choices={[...searchResults.items.map(item => ({ key: string(item.sessionId),
        label: toolLine(`${item.sessionId} · ${item.snippet}`, width - 2),
        action: () => operate(() => openSearchSession(string(item.sessionId), searchResults.query)),
      })), { key: 'close', label: '← Back', action: () => setSearchResults(undefined) }]}
        enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy} />
    </Box> : state.screen === 'workspaces' || state.screen === 'sessions' ? <Box flexDirection="column" marginY={1}>
      <Text bold>{state.screen === 'workspaces' ? 'Choose workspace' : state.showAllSessions ? 'Choose session · All workspaces' : 'Choose session'}</Text>
      <Picker key={`${state.screen}:${state.workspaceId ?? ''}`} choices={choices} enabled={state.online && !state.busy && !input}
        canSelect={() => !draft.current && controller.state.online && !controller.state.busy} />
    </Box> : <>
      {state.screen === 'chat' && historyQuery === undefined && !searchResults && <Box flexDirection="column" marginY={1}>
        <Text>{visible.length ? visible.join('\n') : 'Start a conversation with the host agent.'}</Text>
        {state.transcript.hasMore && <Text dimColor>Scroll up or /older to load earlier history</Text>}
      </Box>}
      {state.screen === 'chat' && historyQuery !== undefined && <Box flexDirection="column" marginY={1}>
        <Text bold>{contentSearch ? 'Search · session history' : 'History · loaded records'} · Esc close</Text>
        <Picker key={`history:${historyQuery}`} choices={[
          ...layout.messages.filter(message => (contentSearch
            ? message.role !== 'Tool' && message.text.toLowerCase().includes(historyQuery.toLowerCase())
            : message.role === 'You' && `${message.seq} ${message.text}`.toLowerCase().includes(historyQuery.toLowerCase()))).map(message => ({
            key: String(message.seq), label: toolLine(`#${message.seq} ${message.role} · ${message.text}`, width - 2),
            action: () => operate(() => jumpHistory(message.seq)),
          })),
          { key: 'close', label: '← Back to conversation', action: () => setHistoryQuery(undefined) },
        ]} enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy} />
      </Box>}
      {pending && <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
        <Text bold color="yellow">{question ? 'Question' : 'Approval required'}</Text>
        <Text>{safeText(question ? string(question.question) : JSON.stringify(pending.request, null, 2))}</Text>
        {question?.detail && <Text>{safeText(string(question.detail))}</Text>}
        {question?.options && <Text>{array(question.options).map(option => string(object(option).label)).join(' · ')}</Text>}
        <Text dimColor>{question ? 'Type your answer below' : '/allow approves once · /deny rejects'}</Text>
      </Box>}
    </>}
      <Box borderStyle="round" borderColor={state.online ? 'cyan' : 'gray'} paddingX={1}>
        <Text color="cyan">❯ </Text>
        <TextInput value={input} onChange={setInput} onCursorChange={setCursor} onSubmit={() => { void submit(draft.current); }}
          focus={state.online && !state.busy} placeholder={state.screen === 'path' ? 'Absolute directory path on host' : 'Message, @host-file, or /help'} />
      </Box>
      {referenceOpen && <Box flexDirection="column">
        <Text dimColor>Host files · ↑ ↓ select · Tab/Enter insert · Esc close</Text>
        {!matches ? <Text dimColor>Searching…</Text> : matches.error ? <Text color="red">{matches.error}</Text>
          : matches.items.length === 0 ? <Text dimColor>No matching host files</Text>
          : matches.items.slice(Math.max(0, referenceIndex - 5), Math.max(0, referenceIndex - 5) + 6).map((item, index) =>
            <Text key={`${item.kind}:${item.path}`} color={index + Math.max(0, referenceIndex - 5) === referenceIndex ? 'cyan' : undefined}>
              {index + Math.max(0, referenceIndex - 5) === referenceIndex ? '❯ ' : '  '}{item.path}{item.kind === 'directory' ? '/' : ''}
            </Text>)}
      </Box>}
      <Text dimColor>Enter send · Tab complete · Esc cancel · Wheel/PgUp/PgDn scroll · Ctrl+C stop / exit</Text>
      {input.startsWith('/') && !input.includes(' ') && <Text dimColor>{COMMANDS.filter(command => command.startsWith(input)).join('  ')}</Text>}
      {help && <><Text dimColor>{HELP}</Text><Text dimColor>Editing: Ctrl+A/E start/end · Ctrl+K/U kill right/left · Ctrl+W kill word · Ctrl+Y restore</Text></>}
      {costExpanded && <CostPanel controller={controller} />}
      <StatusBar controller={controller} expanded={statusExpanded} revision={state.version} />
  </Box>;
}
