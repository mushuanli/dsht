/** Ink terminal interface: startup pickers, transcript, and slash-command composer. */
import { HistoryViewport } from './chat/history-view.tsx';
import { mocha, ThemeContext, useTheme, type Theme } from './theme/index.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, memo, createContext, useContext, type ReactNode } from 'react';
import { Box, Text, measureElement, useApp, useInput, useStdin, useStdout, type DOMElement } from 'ink';
import { useMouseWheel } from './input/mouse.ts';
import { TextInput } from './input/input.tsx';
import { InputHistory } from './input/history.ts';
import { historyLayout, releaseHistoryLayout, type Reasoning } from '../session/history.ts';
import { toolLine, type Transcript } from '../session/transcript.ts';
import { activeReference, fileMention, type FileReference } from '../session/references.ts';
import { CostPanel } from '../cost/view.tsx';
import { StatusBar } from './chat/status.tsx';
import { Controller, type HistorySearch, type RemovalTarget } from '../controller/controller.ts';
import { navigationCommand, sessionLabel } from '../session/navigation.ts';
import { array, errorText, object, safeText, string, type ObjectValue } from '../transport/wire.ts';

/** One slash command advertised by completion and `/help`. */
export interface CommandHint {
  /** Slash command as typed without arguments. */
  command: string;
  /** Argument hint shown after the command; absent when it takes none. */
  usage?: string;
  /** One-line action description shown by `/help`. */
  description: string;
}

/** Command discovery catalog shared by Tab completion and the `/help` panel. */
export const COMMAND_HINTS: readonly CommandHint[] = [
  { command: '/ws', usage: '[name or ID]', description: 'List/switch workspaces; --delete name removes registration' },
  { command: '/resume', usage: '[title or ID]', description: 'List/switch sessions; --delete ID archives with confirmation' },
  { command: '/model', usage: '[provider model [effort]]', description: 'Choose a model and reasoning effort for subsequent requests' },
  { command: '/new', description: 'Create a session in the selected workspace' },
  { command: '/copy', description: 'Freeze for native selection; Esc resumes (Ctrl+S shortcut)' },
  { command: '/latest', description: 'Return to the live conversation' },
  { command: '/older', description: 'Load earlier history' },
  { command: '/history', usage: '[text]', description: 'List your prompts, optionally filtered' },
  { command: '/search', usage: 'text', description: 'Search history page by page and open a match' },
  { command: '/ssearch', usage: 'text', description: 'Search sessions in the current workspace' },
  { command: '/wsearch', usage: 'text', description: 'Search sessions across all workspaces' },
  { command: '/compact', description: 'Compact older history while the session is idle' },
  { command: '/cancel', description: 'Cancel the active turn' },
  { command: '/queue', description: 'View and remove pending input' },
  { command: '/plan', usage: '[off|message]', description: 'Enter or leave host plan mode' },
  { command: '/goal', usage: '[action|objective]', description: 'View or manage the host task goal' },
  { command: '/permission', usage: '[preset]', description: 'View or switch the host permission preset' },
  { command: '/feedback', usage: 'text', description: 'Record feedback about the session' },
  { command: '/export', usage: '[local.zip]', description: 'Save the session log ZIP to a new local file' },
  { command: '/allow', description: 'Approve the pending request once' },
  { command: '/deny', description: 'Reject the pending request' },
  { command: '/status', description: 'Show full session status details' },
  { command: '/cost', description: 'Show cost estimates and refresh usage' },
  { command: '/think', usage: '[seq or live]', description: 'Inspect reasoning with user prompt summaries' },
  { command: '/help', description: 'Show this command list' },
  { command: '/quit', description: 'Exit dsht' },
];
const COMMANDS = COMMAND_HINTS.map(hint => hint.command);
/** Command column text per hint, aligned in the `/help` panel. */
const COMMAND_LABELS = COMMAND_HINTS.map(hint => hint.usage === undefined ? hint.command : `${hint.command} ${hint.usage}`);
/** Widest command column, so descriptions start on one column. */
const COMMAND_LABEL_WIDTH = Math.max(...COMMAND_LABELS.map(label => label.length)) + 2;
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

/** Transient notices expire; interactive panels remain open until dismissed. */
const PANEL_LIFETIME_MS = 10_000;

const CopyMode = createContext(false);
/** Retain rendered children while frozen; local dialog interactions remain outside this wrapper. */
const Frozen = memo(function Frozen({ children }: { children: ReactNode; frozen: boolean; identity: string }) {
  return <>{children}</>;
}, (previous, next) => previous.frozen && next.frozen && previous.identity === next.identity);

interface Choice { key: string; label: string; action(): void; remove?(): void }

function Picker({ choices, enabled, canSelect, pageSize = 12, hint }: { choices: Choice[]; enabled: boolean; canSelect(): boolean; pageSize?: number; hint?: string }) {
  const theme = useTheme();
  const copyMode = useContext(CopyMode);
  const [selected, setSelected] = useState(0);
  const current = Math.min(selected, choices.length - 1);
  const { internal_eventEmitter } = useStdin();
  const rawKey = useRef('');
  useEffect(() => {
    const remember = (raw: string) => { rawKey.current = raw; };
    internal_eventEmitter.prependListener('input', remember);
    return () => { internal_eventEmitter.removeListener('input', remember); };
  }, [internal_eventEmitter]);
  useInput((_input, key) => {
    if (!canSelect() || key.eventType === 'release') return;
    if (key.upArrow) setSelected(Math.max(0, current - 1));
    else if (key.downArrow) setSelected(Math.min(choices.length - 1, current + 1));
    else if (_input === 'd' && !key.ctrl && !key.meta || key.delete && /^\x1b\[3(?:;\d+)?~$/.test(rawKey.current)) choices[current]?.remove?.();
    else if (key.return) choices[current]?.action();
  }, { isActive: enabled && !copyMode });
  const start = Math.max(0, current - Math.max(0, pageSize - 1));
  return <Box flexDirection="column">
    {choices.slice(start, start + pageSize).map((choice, index) => <Text key={choice.key}
      color={start + index === current ? theme.accent : undefined}>
      {start + index === current ? '❯ ' : '  '}{safeText(choice.label)}
    </Text>)}
    <Text dimColor>{hint ?? `↑ ↓ select · Enter open${choices.some(choice => choice.remove) ? ' · d/Delete remove / archive' : ''} · Ctrl+C stop / exit`}</Text>
  </Box>;
}

/** The caller owns starting and stopping the controller around the Ink render lifetime. */
export function App({ controller, panelLifetimeMs = PANEL_LIFETIME_MS, theme = mocha }: { controller: Controller; panelLifetimeMs?: number; theme?: Theme }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const presetId = controller.telemetry.view(state.sessionId).values.agentPreset;
  useEffect(() => { if (typeof presetId === 'string') controller.loadPresetNames(); }, [controller, state.online, presetId]);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [copyMode, setCopyMode] = useState(false);
  const [input, updateInput] = useState('');
  const draft = useRef('');
  const inputHistory = useRef(new InputHistory());
  useLayoutEffect(() => {
    const history = new InputHistory();
    inputHistory.current = history;
    if (!state.transcript.ready) return;
    const messages = state.transcript.messagesForWidth(Math.max(20, (stdout.columns ?? 100) - 2));
    // Seed once per loaded session, never scan historical messages on stream ticks or arrow presses.
    const prompts = messages.filter(message => message.role === 'You').slice(-200);
    for (const message of prompts) history.record(message.text.replace(/\r?\n/g, ' ').trim());
  }, [state.sessionId, state.transcript, state.transcript.ready]);
  const [cursor, setCursor] = useState(0);
  // Input callbacks may run before Ink refreshes the controlled field's listener.
  const setInput = (value: string, recalled = false) => {
    if (!recalled) inputHistory.current.reset();
    draft.current = value; updateInput(value); setCursor(value.length);
  };
  const [historyWindow, setHistoryWindow] = useState<Transcript>();
  const [historyLoading, setHistoryLoading] = useState<string>();
  const [historyMatches, setHistoryMatches] = useState<HistorySearch>();
  const displayTranscript = historyWindow ?? state.transcript;
  const displayRef = useRef(displayTranscript); displayRef.current = displayTranscript;
  useEffect(() => () => { if (historyWindow) { releaseHistoryLayout(historyWindow); historyWindow.dispose(); } }, [historyWindow]);
  const conversationBox = useRef<DOMElement>(null);
  const [conversationRows, setConversationRows] = useState(20);
  useLayoutEffect(() => {
    if (conversationBox.current) {
      const height = Math.floor(measureElement(conversationBox.current).height);
      if (height !== conversationRows) setConversationRows(height);
    }
  });
  const [scroll, setScroll] = useState(0);
  const [liveReasoning, setLiveReasoning] = useState<Reasoning>('row');
  const [removal, setRemoval] = useState<RemovalTarget>();
  const [models, setModels] = useState<{ catalog: ObjectValue; provider?: string; model?: ObjectValue }>();
  const [thoughtList, setThoughtList] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState<string>();
  const [contentSearch, setContentSearch] = useState(false);
  const [searchResults, setSearchResults] = useState<{ query: string; items: ObjectValue[]; hasMore: boolean }>();
  const historyAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => historyAbort.current?.abort(), []);
  const [costExpanded, setCostExpanded] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [reasoningOverrides, setReasoningOverrides] = useState<ReadonlySet<number>>(new Set());
  const reasoning: Reasoning = 'row';
  useEffect(() => { setReasoningOverrides(new Set()); setModels(undefined); setThoughtList(false); setHistoryWindow(undefined); setHistoryMatches(undefined); }, [state.transcript]);
  useEffect(() => { setLiveReasoning('row'); }, [state.transcript, state.transcript.liveAttemptKey]);
  const [notice, setNotice] = useState<string>();
  const [help, setHelp] = useState(false);
  const [helpPage, setHelpPage] = useState(0);
  const helpPageSize = Math.max(1, (stdout.rows ?? 30) - 12);
  const helpPages = Math.ceil(COMMAND_HINTS.length / helpPageSize);
  const currentHelpPage = Math.min(helpPage, helpPages - 1);
  const [answers, setAnswers] = useState<Record<string, ObjectValue[]>>({});
  const [optionState, setOptionState] = useState<{ key: string; cursor: number; selected: string[]; custom: boolean }>();
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [dismissedReference, dismissReference] = useState<string>();
  const [lookup, setLookup] = useState<{ draft: string; sessionId: string; items: FileReference[]; error?: string }>();
  // Interactive panels remain stable while read; only transient notices expire.
  useEffect(() => {
    if (copyMode) return;
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), panelLifetimeMs);
    return () => clearTimeout(timer);
  }, [notice, panelLifetimeMs, copyMode]);
  const pending = state.pending[0];
  const queued = controller.telemetry.pending(state.sessionId).filter(item => item.placement !== 'context');
  useEffect(() => { setQueueOpen(false); }, [state.sessionId, pending?.eventId]);
  const token = state.screen === 'chat' && state.online && !state.busy && !pending
    && !input.startsWith('/') && dismissedReference !== input && cursor === input.length
    ? activeReference(input) : undefined;
  const referenceOpen = token !== undefined;
  const dialogOpen = !!(queueOpen || removal || models || thoughtList || historyQuery !== undefined || searchResults || costExpanded || statusExpanded || help || pending || referenceOpen || state.screen !== 'chat');
  const displayPaused = copyMode || dialogOpen;
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
  const optionKey = `${eventId}:${answered.length}`;
  const options = question ? array(question.options ?? []).map(object) : [];
  const choiceState = optionState?.key === optionKey ? optionState : { key: optionKey, cursor: 0, selected: [], custom: false };
  const optionCursor = Math.min(choiceState.cursor, options.length);
  // Reserve the header, composer and question instructions; each choice may have a description.
  const optionPageSize = Math.max(1, Math.min(6, Math.floor(((stdout.rows ?? 30) - 16) / 2)));
  const optionStart = Math.max(0, optionCursor - optionPageSize + 1);
  const questionKeysActive = !!question && options.length > 0 && !choiceState.custom && !copyMode
    && !removal && !models && !thoughtList && historyQuery === undefined && !searchResults && !help && !costExpanded && !statusExpanded;
  const answerQuestion = async (selected: string[], custom?: string) => {
    if (controller.state.pending[0]?.eventId !== eventId) throw new Error('The pending question has changed');
    const answer = { id: string(question!.id), selected, ...(custom ? { custom } : {}) };
    const next = [...answered, answer];
    if (next.length === questions.length) {
      await controller.answer({ answers: next });
      setAnswers(previous => { const rest = { ...previous }; delete rest[eventId]; return rest; });
    } else setAnswers(previous => ({ ...previous, [eventId]: next }));
    setOptionState(undefined);
  };

  const operate = (fn: () => Promise<void>) => { void controller.perform(fn); };
  const requestRemoval = async (kind: 'workspace' | 'session', query: string) => {
    const target = await controller.removalTarget(kind, query);
    if (target.kind === 'session' && target.empty) await controller.removeTarget(target);
    else setRemoval(target);
  };
  useInput((_value, key) => {
    if (key.eventType === 'release') return;
    if (copyMode) {
      if (key.escape || key.ctrl && (_value === 's' || _value === 'c')) setCopyMode(false);
      return;
    }
    if (key.ctrl && _value === 's') { setCopyMode(true); return; }
    if ((key.escape || key.ctrl && _value === 'c') && historyAbort.current) { historyAbort.current.abort(); return; }
    if ((key.escape || key.ctrl && _value === 'c') && controller.state.pending.length) {
      if (key.ctrl && draft.current) setInput('');
      if (key.escape) {
        setOptionState({ ...choiceState, custom: false });
        setRemoval(undefined); setModels(undefined); setThoughtList(false); setSearchResults(undefined);
        setHistoryQuery(undefined); setHistoryMatches(undefined); setHelp(false); setCostExpanded(false); setStatusExpanded(false);
      }
      return;
    }
    if (questionKeysActive && !draft.current && !controller.state.busy && !key.ctrl && !key.meta) {
      const digit = /^[1-9]$/.test(_value) ? Number(_value) - 1 : -1;
      if (key.upArrow || key.downArrow) {
        setOptionState({ ...choiceState, cursor: Math.max(0, Math.min(options.length, optionCursor + (key.upArrow ? -1 : 1))) }); return;
      }
      if (digit >= 0 && digit <= options.length || _value === ' ' && question!.multiSelect === true && optionCursor < options.length) {
        const index = digit >= 0 ? digit : optionCursor;
        const label = index < options.length ? string(options[index]!.label) : undefined;
        const selected = question!.multiSelect === true && label
          ? choiceState.selected.includes(label) ? choiceState.selected.filter(item => item !== label) : [...choiceState.selected, label]
          : choiceState.selected;
        setOptionState({ ...choiceState, cursor: index, selected }); return;
      }
      if (key.return) {
        if (optionCursor === options.length) { setOptionState({ ...choiceState, custom: true }); return; }
        const selected = question!.multiSelect === true ? choiceState.selected : [string(options[optionCursor]!.label)];
        if (!selected.length) { setNotice('Select at least one option with Space or a number'); return; }
        operate(() => answerQuestion(selected)); return;
      }
    }
    if (help && (key.pageUp || key.pageDown)) {
      setHelpPage(Math.max(0, Math.min(helpPages - 1, currentHelpPage + (key.pageUp ? -1 : 1)))); return;
    }
    if (key.pageUp || key.pageDown) { scrollHistory(key.pageUp ? 10 : -10); return; }
    if (key.escape && queueOpen) { setQueueOpen(false); return; }
    if (key.escape && removal) { setRemoval(undefined); return; }
    if (key.escape && models) { setModels(undefined); return; }
    if (key.escape && thoughtList) { setThoughtList(false); if (controller.running) void controller.interrupt(true); return; }
    if (key.escape && searchResults) { setSearchResults(undefined); if (controller.running) void controller.interrupt(true); return; }
    if (key.escape && historyQuery !== undefined) { setHistoryQuery(undefined); setHistoryMatches(undefined); if (controller.running) void controller.interrupt(true); return; }
    if (key.ctrl && _value === 'c') {
      // A draft clears first, exactly like a shell prompt; an empty draft still stops or exits.
      if (input !== '') { setInput(''); return; }
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
    const recallPrevious = key.upArrow || key.ctrl && _value === 'p';
    const recallNext = key.downArrow || key.ctrl && _value === 'n';
    if ((recallPrevious || recallNext) && state.online && !controller.state.busy && !pending
      && !queueOpen && !removal && !models && !thoughtList && historyQuery === undefined && !searchResults && !help && !costExpanded && !statusExpanded
      && (state.screen === 'chat' || draft.current !== '' || key.ctrl)) {
      setInput(inputHistory.current.move(recallPrevious ? -1 : 1, draft.current), true); return;
    }
    if (key.tab) { completeCommand(); return; }
    if (key.escape && (help || costExpanded || statusExpanded || notice !== undefined)) {
      setHelp(false); setCostExpanded(false); setStatusExpanded(false); setNotice(undefined);
      if (controller.running) void controller.interrupt(true);
      return;
    }
    if (key.escape && state.screen === 'chat') { void controller.interrupt(true); }
  });

  const submit = async (raw: string) => {
    if (referenceOpen) { pickReference(); return; }
    if (copyMode) return;
    const value = raw.trim();
    if (!value) return;
    if (!pending && !/^\/feedback(?:\s|$)/.test(value)) inputHistory.current.record(value);
    if (value === '/copy') { setInput(''); setCopyMode(true); return; }
    setRemoval(undefined);
    if (value !== '/queue') setQueueOpen(false);
    // Each panel belongs to the command that opened it, so any other command closes it.
    if (!/^\/model(?: |$)/.test(value)) setModels(undefined);
    if (value !== '/help') setHelp(false);
    if (value !== '/cost') setCostExpanded(false);
    if (value !== '/status') setStatusExpanded(false);
    if (!/^\/think(?: |$)/.test(value)) setThoughtList(false);
    if (value === '/quit') { exit(); return; }
    if (value === '/cost') {
      setCostExpanded(value => !value); setInput('');
      if (!costExpanded) void controller.perform(() => historyOperation(signal => controller.refreshCosts(signal)));
      return;
    }
    if (value === '/status') { setStatusExpanded(value => !value); setInput(''); return; }
    if (value === '/help') { setHelp(value => !value); setHelpPage(0); setInput(''); return; }
    const accepted = await controller.perform(async () => {
      const navigation = navigationCommand(value);
      if (navigation && /^--(?:delete|archive)(?:\s|$)/.test(navigation.query ?? '')) {
        const query = navigation.query!.replace(/^--(?:delete|archive)\s*/, '');
        if (!query) throw new Error('Specify the name or ID to remove');
        await requestRemoval(navigation.kind, query);
      }
      else if (navigation) {
        setHistoryQuery(undefined);
        setSearchResults(undefined);
        if (navigation.kind === 'workspace') await controller.switchWorkspace(navigation.query);
        else await controller.switchSession(navigation.query);
        setScroll(0);
      }
      else if (state.screen === 'path') await controller.createWorkspace(value);
      else if (value === '/latest') {
        setHistoryWindow(undefined); setHistoryMatches(undefined); setHistoryQuery(undefined); setSearchResults(undefined);
        setReasoningOverrides(new Set()); setScroll(0); controller.pinHistory(false);
      }
      else if (/^\/model(?: |$)/.test(value)) {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        const args = value.split(/\s+/).slice(1);
        if (!args.length) { setHistoryQuery(undefined); setSearchResults(undefined); setModels({ catalog: await controller.modelCatalog() }); }
        else {
          if (args.length < 2 || args.length > 3) throw new Error('Use /model [provider model [effort]]');
          await controller.selectModel(args[0]!, args[1]!, args[2]); setModels(undefined);
        }
      }
      else if (value === '/queue') {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        if (pending) throw new Error('Answer the pending question or approval first');
        setQueueOpen(true);
      }
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
            setHistoryMatches(await controller.searchHistory(query, signal));
            setSearchResults(undefined); setContentSearch(true); setHistoryQuery(query);
          } else {
            const result = await controller.searchSessions(query, command === '/ssearch', signal);
            setHistoryQuery(undefined); setSearchResults({ query, ...result });
          }
        });
      }
      else if (/^\/think(?: |$)/.test(value)) {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        const target = value.slice(6).trim();
        if (target === 'live') {
          setLiveReasoning(value => value === 'row' ? 'full' : 'row'); setThoughtList(false); setScroll(0);
        } else if (target) {
          const seq = Number(target);
          if (!Number.isSafeInteger(seq) || !displayTranscript.thoughts.some(entry => entry.seq === seq)) throw new Error('Use /think <message sequence> for a loaded reasoning block');
          const next = new Set(reasoningOverrides);
          if (next.delete(seq)) { setReasoningOverrides(next); return; }
          next.add(seq); setReasoningOverrides(next);
          await jumpHistory(seq, next);
        } else {
          setHistoryQuery(undefined); setSearchResults(undefined); setThoughtList(true);
        }
      }
      else if (value === '/older') { await controller.older(undefined, displayTranscript); setScroll(value => value + 10); }
      else if (/^\/compact(?: |$)/.test(value)) {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        if (value !== '/compact') throw new Error('Use /compact (no arguments)');
        setNotice(undefined);
        await historyOperation(async signal => { setNotice(await controller.command('/compact', signal)); }, 'Compacting history…');
      }
      else if (value === '/cancel') await controller.cancelTurn();
      else if (value === '/allow') await controller.approve(true);
      else if (value === '/deny') await controller.approve(false);
      else if (/^\/(?:plan|goal|permission|feedback)(?:\s|$)/.test(value)) {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        if (pending) throw new Error('Answer the pending question or approval first');
        setNotice(undefined);
        await historyOperation(async signal => { setNotice(await controller.command(value, signal)); }, 'Running command…');
      }
      else if (/^\/export(?:\s|$)/.test(value)) {
        if (state.screen !== 'chat') throw new Error('Select a session first');
        const destination = value.slice(7).trim().replace(/^(["'])(.*)\1$/, '$2');
        await historyOperation(async signal => { setNotice(`Saved session log: ${await controller.exportLog(destination || undefined, signal)}`); }, 'Exporting session log…');
      }
      else if (question) await answerQuestion(question.multiSelect === true ? choiceState.selected : [], value); else if (pending) throw new Error('Answer the approval with /allow or /deny');
      else if (value.startsWith('/')) throw new Error('Unknown command. Use /help.');
      else if (state.screen !== 'chat') throw new Error('Choose a session or type /ws or /resume');
      else { await controller.prompt(value); setHistoryWindow(undefined); setScroll(0); }
    });
    if (accepted) setInput('');
  };

  const choices: Choice[] = state.screen === 'workspaces' ? [
    ...state.workspaces.map(workspace => ({ key: string(workspace.workspaceId),
      label: `${string(workspace.title)}  ${string(workspace.path)}`,
      remove: () => setRemoval({ kind: 'workspace', id: string(workspace.workspaceId), name: string(workspace.title), path: string(workspace.path) }),
      action: () => controller.pickWorkspace(string(workspace.workspaceId)) })),
    { key: '@all', label: 'All sessions', action: () => operate(() => controller.switchSession('all')) },
    { key: '@new', label: '+ Add workspace (host directory)', action: () => controller.enterPath() },
  ] : [
    ...(state.workspaceId && !state.showAllSessions ? [{ key: '@new', label: '+ New session', action: () => operate(() => controller.createSession()) }] : []),
    ...controller.visibleSessions.map(session => ({ key: string(session.sessionId),
      label: `${session.running ? '● ' : ''}${sessionLabel(session)}  ${session.sessionId}`,
      remove: () => operate(() => requestRemoval('session', string(session.sessionId))),
      action: () => { setScroll(0); operate(() => controller.selectSession(string(session.sessionId))); } })),
    { key: '@back', label: '← Workspaces', action: () => operate(() => controller.showPicker('workspaces')) },
  ];
  const width = Math.max(10, (stdout.columns ?? 80) - 2);
  const layout = useMemo(() => historyLayout(displayTranscript, width, reasoning, reasoningOverrides, liveReasoning),
    [displayTranscript, displayTranscript.version, width, reasoning, reasoningOverrides, liveReasoning]);
  const { length, first } = layout;
  const statusNotice = !['Connected', 'Idle', 'Running…', 'Responding…'].includes(state.status);
  const showHistoryHint = dialogOpen || displayTranscript.hasMore || !!historyWindow;
  const pageSize = Math.max(1, conversationRows - (showHistoryHint ? 1 : 0));
  const previousView = useRef({ transcript: displayTranscript, session: state.transcript, count: length, first, folds: reasoningOverrides, liveReasoning });
  const previous = previousView.current;
  const prepended = previous.first !== undefined && first !== undefined && first < previous.first;
  const adjustedScroll = previous.session !== state.transcript ? 0
    : scroll > 0 && previous.transcript === displayTranscript && !prepended && previous.folds === reasoningOverrides && previous.liveReasoning === liveReasoning ? Math.max(0, scroll + length - previous.count) : scroll;
  const maxScroll = Math.max(0, length - pageSize);
  const position = Math.min(adjustedScroll, maxScroll);
  useLayoutEffect(() => {
    previousView.current = { transcript: displayTranscript, session: state.transcript, count: length, first, folds: reasoningOverrides, liveReasoning };
    if (position !== scroll) setScroll(position);
  }, [state.transcript, displayTranscript, length, position, scroll, reasoningOverrides, liveReasoning]);
  useLayoutEffect(() => {
    controller.pinHistory(!historyWindow && (position > 0 || thoughtList || historyQuery !== undefined && !contentSearch));
  }, [controller, historyWindow, position, thoughtList, historyQuery, contentSearch, state.transcript]);
  useEffect(() => {
    const first = displayTranscript.beforeSeq;
    if (first !== undefined) setReasoningOverrides(previous => {
      const next = new Set([...previous].filter(seq => seq >= first));
      return next.size === previous.size ? previous : next;
    });
  }, [displayTranscript, displayTranscript.memoryRevision]);
  const scrollPosition = useRef(position);
  scrollPosition.current = position;
  const loadingPage = useRef(false);
  const scrollIntent = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function scrollHistory(delta: number): void {
    if (copyMode || state.screen !== 'chat') return;
    const intent = ++scrollIntent.current;
    const next = Math.max(0, Math.min(maxScroll, scrollPosition.current + delta));
    scrollPosition.current = next;
    setScroll(next);
    if (delta <= 0 || next < maxScroll || loadingPage.current || state.busy || !state.online || !displayTranscript.ready || !displayTranscript.hasMore) return;
    loadingPage.current = true;
    const transcript = displayTranscript;
    void controller.perform(() => historyOperation(signal => controller.older(signal, transcript))).then(accepted => {
      if (accepted && mounted.current && displayRef.current === transcript && scrollIntent.current === intent) {
        setScroll(value => value + delta);
      }
    }).finally(() => { loadingPage.current = false; });
  }
  async function historyOperation(operation: (signal: AbortSignal) => Promise<void>, label = 'Loading history…'): Promise<void> {
    const abort = new AbortController();
    historyAbort.current = abort; setHistoryLoading(label);
    try { await operation(abort.signal); }
    finally { if (historyAbort.current === abort) { historyAbort.current = undefined; setHistoryLoading(undefined); } }
  }
  async function openSearchSession(sessionId: string, query: string): Promise<void> {
    await historyOperation(async signal => {
      await controller.selectSession(sessionId);
      await controller.waitForHistory(signal);
      setHistoryMatches(await controller.searchHistory(query, signal));
      setSearchResults(undefined); setContentSearch(true); setHistoryQuery(query);
    });
  }
  async function jumpHistory(target: number, folds = reasoningOverrides): Promise<void> {
    if (state.screen !== 'chat') throw new Error('Select a session first');
    ++scrollIntent.current;
    const abort = new AbortController();
    historyAbort.current = abort;
    try {
      const transcript = displayTranscript.messages.some(message => message.seq === target) ? displayTranscript
        : state.transcript.messages.some(message => message.seq === target) ? state.transcript
        : await controller.historyAt(target, abort.signal);
      abort.signal.throwIfAborted();
      const current = historyLayout(transcript, width, reasoning, folds, liveReasoning);
      const row = current.offsets.get(target);
      if (row === undefined) throw new Error('No visible message at this sequence; use /history to choose a record');
      setHistoryWindow(transcript === state.transcript ? undefined : transcript);
      setHistoryQuery(undefined); setHistoryMatches(undefined); setThoughtList(false);
      setScroll(Math.max(0, current.length - pageSize - row));
    } finally { if (historyAbort.current === abort) historyAbort.current = undefined; }
  }
  useMouseWheel(direction => scrollHistory(direction * 3), !copyMode && state.screen === 'chat', () => { if (!dialogOpen) setCopyMode(true); });
  const trailingGap = dialogOpen && length > 0 && layout.viewport(length - 1, length)[0]?.text === '' ? 1 : 0;
  const end = Math.max(pageSize, length - position - trailingGap);
  const visible = useMemo(() => layout.viewport(Math.max(0, end - pageSize), end), [layout, end, pageSize]);
  const liveThought = thoughtList && !historyWindow ? state.transcript.liveParts(width).find(part => part.kind === 'reasoning') : undefined;
  const thoughtEntries = thoughtList ? displayTranscript.thoughts : undefined;
  const thoughtChoices = useMemo(() => [...(thoughtEntries ?? [])].reverse().map(entry => ({
    key: String(entry.seq), label: `${toolLine(`#${entry.seq} User · ${entry.prompt}`, width - 2)}\n  ${toolLine(`◇ ${entry.preview}`, width - 4)}`,
    action: () => operate(async () => { const next = new Set(reasoningOverrides); next.add(entry.seq); setReasoningOverrides(next); await jumpHistory(entry.seq, next); }),
  })), [thoughtEntries, width, pageSize, reasoningOverrides, liveReasoning, displayTranscript]);
  const thoughtOptions = useMemo(() => [
          ...(liveThought ? [{ key: 'live', label: `${toolLine(`Now · User · ${state.transcript.latestPrompt}`, width - 2)}\n  ${toolLine(liveThought.text, width - 4)}`,
            action: () => { setLiveReasoning('full'); setThoughtList(false); const expanded = historyLayout(state.transcript, width, reasoning, reasoningOverrides, 'full'); setScroll(Math.max(0, expanded.length - pageSize - expanded.liveOffset)); } }] : []),
          ...thoughtChoices,
          ...(displayTranscript.hasMore ? [{ key: 'older', label: '↑ Load older reasoning', action: () => operate(() => historyOperation(signal => controller.older(signal, displayTranscript))) }] : []),
          { key: 'close', label: '← Back to conversation', action: () => setThoughtList(false) },
        ], [liveThought, thoughtChoices, displayTranscript, displayTranscript.hasMore, width, pageSize, reasoningOverrides]);
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  const workspaceName = workspace ? string(workspace.title) || string(workspace.path) : state.workspaceId;
  const headerTitle = controller.sessionName
    ? [controller.sessionName, width >= 60 ? workspaceName : undefined].filter(Boolean).join(' · ')
    : workspaceName || 'All workspaces';
  return <ThemeContext.Provider value={theme}><CopyMode.Provider value={copyMode}><Frozen frozen={copyMode} identity={`${width}:${stdout.rows}`}><Box flexDirection="column" paddingX={1} height={Math.max(1, (stdout.rows ?? 30) - 1)} overflowY="hidden">
    {copyMode && <Text color={theme.accent}>Copy mode · drag to select · Esc / Ctrl+S resumes</Text>}
    <Frozen frozen={displayPaused} identity={`${width}:${state.sessionId}`}><Box flexDirection="column" flexShrink={0}>
    <Box width={width}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}><Text bold color={theme.accent} wrap="truncate-end">{toolLine(headerTitle, width)}</Text></Box>
      {width >= 60 && controller.sessionMode && <Box flexShrink={0} marginLeft={2}><Text color={theme.accent}>{toolLine(controller.sessionMode, Math.min(24, Math.floor(width / 3)))}</Text></Box>}
    </Box>
    <Text dimColor>{'─'.repeat(width)}</Text>
    </Box></Frozen>
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden">
    {historyLoading && <Text dimColor>{historyLoading} · Esc / Ctrl+C cancel</Text>}
    <Frozen frozen={displayPaused} identity={state.sessionId ?? ""}>{statusNotice && <Text dimColor wrap="truncate-end">{safeText(state.status)}</Text>}</Frozen>
    {state.error && <Text color={theme.colors.error}>{state.error}</Text>}
      {state.screen === 'chat' && <Box ref={conversationBox} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" marginY={dialogOpen ? 0 : 1}>
        {visible.length ? <Frozen frozen={displayPaused} identity={`${width}:${state.sessionId}:${position}:${pageSize}`}><HistoryViewport rows={visible} /></Frozen> : <Text color={theme.colors.muted}>Start a conversation with the host agent.</Text>}
        {showHistoryHint && <Text dimColor wrap="truncate-end">{dialogOpen ? 'Wheel/PgUp/PgDn · Scroll history' : historyWindow ? 'Earlier history · /latest returns to live conversation' : 'Scroll up or /older to load earlier history'}</Text>}
      </Box>}
    </Box>
    <Box flexDirection="column" flexShrink={0}>
      {notice && <Text dimColor>{safeText(notice)}</Text>}
      <Box borderStyle="round" borderColor={pending ? theme.colors.context : state.online ? theme.accent : theme.border} paddingX={1} flexDirection="column" flexShrink={1} minHeight={3}>
        <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
    {queueOpen && !pending ? <Box flexDirection="column">
      <Text bold>Pending input · Esc close</Text>
      {!queued.length && <Text dimColor>{state.controlError ? 'Host queue unavailable' : 'No pending input'}</Text>}
      <Picker choices={queued.map(item => ({
        key: item.id, label: toolLine(item.text, width - 6),
        action: () => operate(() => controller.removeQueued(item.id)),
        remove: () => operate(() => controller.removeQueued(item.id)),
      }))} pageSize={Math.max(1, Math.min(6, (stdout.rows ?? 30) - 12))}
        hint="↑ ↓ select · Enter / d / Delete remove · Esc close"
        enabled={!input && !state.busy && state.online}
        canSelect={() => !draft.current && !controller.state.busy && controller.state.online && !controller.state.pending.length} />
    </Box> : removal ? <Box flexDirection="column" marginY={1}>
      <Text bold color={theme.colors.context}>{removal.kind === 'workspace' ? 'Remove workspace registration?' : 'Archive session?'}</Text>
      <Text wrap="truncate-end">{safeText(removal.name)}</Text>
      <Text wrap="truncate-end">ID: {safeText(removal.id)}</Text>
      {removal.path && <Text wrap="truncate-end">Path: {safeText(removal.path)}</Text>}
      <Text>{removal.kind === 'workspace' ? 'Removes the workspace from the list. Directory and sessions are kept.' : 'Hides the session from lists. History is kept; /resume ID can reopen it.'}</Text>
      <Text dimColor>Running tasks continue. Esc cancels this dialog.</Text>
      <Picker key={`${removal.kind}:${removal.id}`} choices={[
        { key: 'cancel', label: 'Cancel', action: () => setRemoval(undefined) },
        { key: 'confirm', label: removal.kind === 'workspace' ? 'Remove workspace' : 'Archive session',
          action: () => operate(async () => { await controller.removeTarget(removal); setRemoval(undefined); }) },
      ]} enabled={!input && !state.busy && state.online} canSelect={() => !draft.current && !controller.state.busy && controller.state.online} />
    </Box> : models ? <Box flexDirection="column" marginY={1}>
      <Text bold>{models.model ? 'Choose reasoning effort' : 'Choose model'}</Text>
      <Text dimColor>Applies to subsequent requests; host also saves the default.</Text>
      {array(models.catalog.failures).map(object).map(failure => <Text key={string(failure.id)} color={theme.colors.error}>{safeText(`${failure.name}: ${failure.message}`)}</Text>)}
      <Picker key={models.model ? `${models.provider}:${models.model.id}` : 'models'} pageSize={Math.max(1, Math.min(8, (stdout.rows ?? 30) - 15))}
        choices={models.model ? [
          { key: 'default', label: `Default effort${object(models.model.reasoning).defaultEffort ? ` · ${string(object(models.model.reasoning).defaultEffort)}` : ''}`,
            action: () => operate(async () => { await controller.selectModel(models.provider!, string(models.model!.id)); setModels(undefined); }) },
          ...array(object(models.model.reasoning).efforts).map(object).map(effort => ({ key: string(effort.id), label: toolLine(`${effort.name} (${effort.id})${effort.description ? ` · ${effort.description}` : ''}`, width - 2),
            action: () => operate(async () => { await controller.selectModel(models.provider!, string(models.model!.id), string(effort.id)); setModels(undefined); }) })),
          { key: 'back', label: '← Models', action: () => setModels({ catalog: models.catalog }) },
        ] : [
          ...array(models.catalog.groups).map(object).flatMap(group => array(group.models).map(object).map(model => ({
            key: `${group.id}:${model.id}`, label: toolLine(`${group.name} · ${model.name} (${model.id})`, width - 2),
            action: () => { if (array(object(model.reasoning ?? { efforts: [] }).efforts).length) setModels({ catalog: models.catalog, provider: string(group.id), model });
              else operate(async () => { await controller.selectModel(string(group.id), string(model.id)); setModels(undefined); }); },
          }))),
          { key: 'close', label: '← Back to conversation', action: () => setModels(undefined) },
        ]} enabled={!input && !state.busy && state.online} canSelect={() => !draft.current && !controller.state.busy && controller.state.online} />
    </Box> : searchResults ? <Box flexDirection="column" marginY={1}>
      <Text bold>Session search · {safeText(searchResults.query)}</Text>
      {searchResults.hasMore && <Text color={theme.colors.context}>Host returned only the first 20 global matches; workspace results may be incomplete. Refine your query.</Text>}
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
      {thoughtList && <Box flexDirection="column" marginY={1}>
        <Text bold color={theme.colors.reasoning}>Reasoning history · User prompts · Esc close</Text>
        {!thoughtEntries?.length && !liveThought && <Text dimColor>No reasoning in loaded history</Text>}
        <Picker key={`thoughts:${state.sessionId}`} choices={thoughtOptions} pageSize={Math.max(1, Math.min(6, Math.floor(((stdout.rows ?? 30) - 14) / 2)))}
          enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy} />
      </Box>}
      {state.screen === 'chat' && historyQuery !== undefined && <Box flexDirection="column" marginY={1}>
        <Text bold>{contentSearch ? 'Search · session history' : 'History · loaded records'} · Esc close</Text>
        {contentSearch && historyMatches?.truncated && <Text color={theme.colors.context}>Showing the first 200 matches · Refine your search</Text>}
        <Picker key={`history:${historyQuery}`} choices={[
          ...(contentSearch && historyMatches ? historyMatches.items.map(message => ({
            key: String(message.seq), label: toolLine(`#${message.seq} ${message.role} · ${message.preview}`, width - 2),
            action: () => operate(() => jumpHistory(message.seq)),
          })) : layout.messages.filter(message => message.role === 'You' && `${message.seq} ${message.text}`.toLowerCase().includes(historyQuery.toLowerCase())).map(message => ({
            key: String(message.seq), label: toolLine(`#${message.seq} ${message.role} · ${message.text}`, width - 2),
            action: () => operate(() => jumpHistory(message.seq)),
          }))),
          { key: 'close', label: '← Back to conversation', action: () => { setHistoryQuery(undefined); setHistoryMatches(undefined); } },
        ]} enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy} />
      </Box>}
      {pending && <Box flexShrink={0} flexDirection="column">
        <Text bold color={theme.colors.context}>{question ? `Question ${answered.length + 1}/${questions.length}${question.header ? ` · ${safeText(string(question.header))}` : ''}` : 'Approval required'}</Text>
        <Text>{safeText(question ? string(question.question) : JSON.stringify(pending.request, null, 2))}</Text>
        {question?.detail && <Text>{safeText(string(question.detail))}</Text>}
        {options.length > 0 && <Box flexDirection="column" flexShrink={0}>
          {[...options, { label: 'Other answer — type below' }].map((option, index) => ({ option, index }))
            .slice(optionStart, optionStart + optionPageSize).map(({ option, index }) => <Box key={index} flexDirection="column" flexShrink={0}>
              <Text color={index === optionCursor ? theme.accent : undefined} wrap="truncate-end">{index === optionCursor ? '❯ ' : '  '}{index + 1}. {question?.multiSelect === true && index < options.length ? choiceState.selected.includes(string(option.label)) ? '[x] ' : '[ ] ' : ''}{safeText(string(option.label))}</Text>
              {option.description && <Text dimColor wrap="truncate-end">{'     '}{safeText(string(option.description))}</Text>}
            </Box>)}
          <Text dimColor>{choiceState.custom ? 'Type your answer below · Esc returns to options' : question?.multiSelect === true
            ? '↑ ↓ move · Space / 1–9 toggle · Enter confirm' : '↑ ↓ / 1–9 select · Enter confirm'}</Text>
        </Box>}
        <Text dimColor>{question ? 'Text answers supported · Ctrl+C clears · /cancel stops' : '/allow approves once · /deny rejects · /cancel stops'}</Text>
      </Box>}
    </>}
        </Box>
        {!queueOpen && !pending && state.screen === 'chat' && queued.length > 0 && <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>Waiting: {queued.length} · /queue to remove</Text>
          {queued.slice(0, 2).map(item => <Text key={item.id} dimColor wrap="truncate-end">{item.placement === 'steering' ? '↳ ' : '· '}{safeText(toolLine(item.text, width - 6))}</Text>)}
        </Box>}
        <Box flexShrink={0}>
        <Text color={theme.accent}>❯ </Text>
        <TextInput value={input} onChange={setInput} onCursorChange={setCursor} onSubmit={() => { void submit(draft.current); }}
          reservedKeys={queueOpen && !pending ? ['d'] : questionKeysActive ? ['1','2','3','4','5','6','7','8','9', ...(question?.multiSelect === true ? [' '] : [])] : !removal && !models && !searchResults && (state.screen === 'workspaces' || state.screen === 'sessions') ? ['d'] : undefined}
          focus={state.online && !state.busy && !copyMode} placeholder={state.screen === 'path' ? 'Absolute directory path on host' : 'Message, @host-file, or /help'} />
        </Box>
      {referenceOpen && <Box flexDirection="column">
        <Text dimColor>Host files · ↑ ↓ select · Tab/Enter insert · Esc close</Text>
        {!matches ? <Text dimColor>Searching…</Text> : matches.error ? <Text color={theme.colors.error}>{matches.error}</Text>
          : matches.items.length === 0 ? <Text dimColor>No matching host files</Text>
          : matches.items.slice(Math.max(0, referenceIndex - 5), Math.max(0, referenceIndex - 5) + 6).map((item, index) =>
            <Text key={`${item.kind}:${item.path}`} color={index + Math.max(0, referenceIndex - 5) === referenceIndex ? theme.accent : undefined}>
              {index + Math.max(0, referenceIndex - 5) === referenceIndex ? '❯ ' : '  '}{item.path}{item.kind === 'directory' ? '/' : ''}
            </Text>)}
      </Box>}
      </Box>
      {input.startsWith('/') && !input.includes(' ') && <Text dimColor>{COMMANDS.filter(command => command.startsWith(input)).join('  ')}</Text>}
      {help && <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
        {COMMAND_HINTS.slice(currentHelpPage * helpPageSize, (currentHelpPage + 1) * helpPageSize).map((hint, index) => <Text key={hint.command} dimColor wrap="truncate-end">
          <Text color={theme.accent}>{COMMAND_LABELS[currentHelpPage * helpPageSize + index]!.padEnd(COMMAND_LABEL_WIDTH)}</Text>{hint.description}
        </Text>)}
        <Text dimColor>Help {currentHelpPage + 1}/{helpPages} · PgUp/PgDn pages · Esc close</Text>
        <Text dimColor>Enter send · Tab complete · Esc cancel · Wheel/PgUp/PgDn scroll · Ctrl+C clear / stop / exit</Text>
        <Text dimColor>History: ↑/↓ or Ctrl+P/N recall · Editing: Ctrl+A/E start/end · Ctrl+K/U kill right/left · Ctrl+W kill word · Ctrl+Y restore</Text>
      </Box>}
      {costExpanded && <CostPanel controller={controller} />}
      <Frozen frozen={displayPaused || position > 0} identity={`${width}:${state.sessionId}:${statusExpanded}`}><StatusBar controller={controller} width={width} expanded={statusExpanded} revision={state.version} paused={displayPaused || position > 0} /></Frozen>
    </Box>
  </Box></Frozen></CopyMode.Provider></ThemeContext.Provider>;
}
