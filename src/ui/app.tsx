/** Ink terminal interface: startup pickers, transcript, and slash-command composer. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mocha, ThemeContext, type Theme } from './theme/index.ts';
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from 'ink';
import { useMouseWheel } from './input/mouse.ts';
import { TextInput } from './input/input.tsx';
import { InputHistory } from './input/history.ts';
import { ReferenceMenu } from './input/references.tsx';
import { historyLayout, releaseHistoryLayout, type Reasoning } from '../session/history.ts';
import { toolLine, type Transcript } from '../session/transcript.ts';
import { activeReference, fileMention, type FileReference } from '../session/references.ts';
import { CostPanel } from './dialogs/cost.tsx';
import { StatusBar } from './chat/status.tsx';
import { ChatHeader } from './chat/header.tsx';
import { ChatViewport } from './chat/viewport.tsx';
import { Frozen } from './frozen.tsx';
import { CopyMode } from './copy-mode.ts';
import type { Choice } from './dialogs/picker.tsx';
import { HelpPanel, HistoryDialog, ModelDialog, PickerScreen, QueueDialog, QueuedPreview, RemovalDialog, SearchResultsDialog, ThoughtsDialog } from './dialogs/index.tsx';
import { COMMAND_HINTS, completeCommand as completeDraft, suggestedCommands } from './commands/registry.ts';
import { classifySubmission } from './commands/parse.ts';
import { Controller, type HistorySearch, type RemovalTarget } from '../controller/controller.ts';
import { sessionLabel } from '../session/navigation.ts';
import { array, errorText, object, safeText, string, type ObjectValue } from '../transport/wire.ts';

/** Transient notices expire; interactive panels remain open until dismissed. */
const PANEL_LIFETIME_MS = 10_000;

/** The caller owns starting and stopping the controller around the Ink render lifetime.
 * @param props - Controller, panel lifetime and semantic theme.
 * @returns The rendered terminal interface.
 */
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
    // A new message draft returns the view to the live end, so composing never needs a scroll first.
    // A slash command is not a message, and the reader keeps their place while typing one.
    if (state.screen === 'chat' && draft.current === '' && value !== '' && !value.startsWith('/')) setScroll(0);
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
  const [statusPage, setStatusPage] = useState(0);
  // The panel owns two border rows and a one-row page footer, and the two header rows and the
  // three-row composer above it never shrink, so only the remainder of the screen height holds rows.
  const statusPageSize = Math.max(1, (stdout.rows ?? 30) - 9);
  const [answers, setAnswers] = useState<Record<string, ObjectValue[]>>({});
  const [optionState, setOptionState] = useState<{ key: string; cursor: number; selected: string[]; custom: boolean }>();
  const [approvalSelection, setApprovalSelection] = useState<{ eventId: string; index: number }>();
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
  // A replayed interaction (same eventId after a reconnect) starts unselected again.
  useEffect(() => { setApprovalSelection(undefined); }, [state.sessionId, state.online, pending?.eventId]);
  const token = state.screen === 'chat' && state.online && !state.busy && !pending
    && !input.startsWith('/') && dismissedReference !== input && cursor === input.length
    ? activeReference(input) : undefined;
  const referenceOpen = token !== undefined;
  const dialogOpen = !!(queueOpen || removal || models || thoughtList || historyQuery !== undefined || searchResults || costExpanded || statusExpanded || help || pending || referenceOpen || state.screen !== 'chat');
  const displayPaused = copyMode || dialogOpen;
  // Startup screens need live connection feedback even while their picker remains open.
  const statusPaused = copyMode || (state.screen === 'chat' && dialogOpen);
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
    const completed = completeDraft(input);
    if (completed !== undefined) setInput(completed);
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
  // One open panel owns the arrow and digit keys; the picker screens and the composer are not keyboard owners.
  const panelBlocksKeys = !!(removal || models || thoughtList || historyQuery !== undefined || searchResults || help || costExpanded || statusExpanded);
  const questionKeysActive = !!question && options.length > 0 && !choiceState.custom && !copyMode && !panelBlocksKeys;
  const approvalKeysActive = pending?.event === 'approval/request' && !copyMode && !panelBlocksKeys;
  const approvalIndex = approvalSelection?.eventId === eventId ? approvalSelection.index : -1;
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
        setApprovalSelection(undefined);
        setRemoval(undefined); setModels(undefined); setThoughtList(false); setSearchResults(undefined);
        setHistoryQuery(undefined); setHistoryMatches(undefined); setHelp(false); setCostExpanded(false); setStatusExpanded(false);
      }
      return;
    }
    if (approvalKeysActive && !draft.current && controller.state.online && !controller.state.busy
      && controller.state.pending[0]?.eventId === eventId && !key.ctrl && !key.meta) {
      const digit = /^[1-3]$/.test(_value) ? Number(_value) - 1 : -1;
      if (digit >= 0 || key.upArrow || key.downArrow) {
        // An unselected list enters at the first, non-destructive choice, so a stray arrow plus Enter cannot cancel.
        const index = digit >= 0 ? digit : approvalIndex < 0 ? 0
          : Math.max(0, Math.min(2, approvalIndex + (key.upArrow ? -1 : 1)));
        setApprovalSelection({ eventId, index }); return;
      }
      if (key.return) {
        // Choice 3 cancels the turn instead of answering the request, so it sends no event result.
        if (approvalIndex >= 0) operate(() => approvalIndex === 2 ? controller.cancelTurn() : controller.approve(approvalIndex === 0));
        return;
      }
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
    if (statusExpanded && (key.pageUp || key.pageDown)) {
      setStatusPage(value => Math.max(0, value + (key.pageUp ? -1 : 1))); return;
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
      && !queueOpen && !panelBlocksKeys
      && (state.screen === 'chat' || draft.current !== '' || key.ctrl)) {
      setInput(inputHistory.current.move(recallPrevious ? -1 : 1, draft.current), true); return;
    }
    if (key.tab) { completeCommand(); return; }
    if (key.escape && (help || costExpanded || statusExpanded || notice !== undefined)) {
      setHelp(false); setCostExpanded(false); setStatusExpanded(false); setStatusPage(0); setNotice(undefined);
      if (controller.running) void controller.interrupt(true);
      return;
    }
    if (key.escape && state.screen === 'chat') { void controller.interrupt(true); }
  });

  const submit = async (raw: string) => {
    const submission = classifySubmission(raw, {
      referenceOpen, copyMode, pending: pending !== undefined, question: question !== undefined, screen: state.screen,
    });
    if (submission.kind === 'ignore') return;
    if (submission.kind === 'reference') { pickReference(); return; }
    const value = raw.trim();
    if (!pending && !/^\/feedback(?:\s|$)/.test(value)) inputHistory.current.record(value);
    if (submission.kind === 'copy') { setInput(''); setCopyMode(true); return; }
    setRemoval(undefined);
    // Each panel belongs to the command that opened it, so any other command closes it.
    if (value !== '/queue') setQueueOpen(false);
    if (!/^\/model(?: |$)/.test(value)) setModels(undefined);
    if (value !== '/help') setHelp(false);
    if (value !== '/cost') setCostExpanded(false);
    if (value !== '/status') setStatusExpanded(false);
    if (!/^\/think(?: |$)/.test(value)) setThoughtList(false);
    if (submission.kind === 'quit') { exit(); return; }
    if (submission.kind === 'panel') {
      if (submission.panel === 'cost') {
        setCostExpanded(value => !value); setInput('');
        if (!costExpanded) void controller.perform(() => historyOperation(signal => controller.refreshCosts(signal)));
      } else if (submission.panel === 'status') { setStatusExpanded(value => !value); setStatusPage(0); setInput(''); }
      else { setHelp(value => !value); setHelpPage(0); setInput(''); }
      return;
    }
    const accepted = await controller.perform(async () => {
      switch (submission.kind) {
        case 'remove': await requestRemoval(submission.target, submission.query); return;
        case 'navigate': {
          setHistoryQuery(undefined);
          setSearchResults(undefined);
          if (submission.target === 'workspace') await controller.switchWorkspace(submission.query);
          else await controller.switchSession(submission.query);
          setScroll(0);
          return;
        }
        case 'path': await controller.createWorkspace(submission.value); return;
        case 'latest':
          setHistoryWindow(undefined); setHistoryMatches(undefined); setHistoryQuery(undefined); setSearchResults(undefined);
          setReasoningOverrides(new Set()); setScroll(0); controller.pinHistory(false);
          return;
        case 'models': {
          if (!submission.args.length) { setHistoryQuery(undefined); setSearchResults(undefined); setModels({ catalog: await controller.modelCatalog() }); }
          else { await controller.selectModel(submission.args[0]!, submission.args[1]!, submission.args[2]); setModels(undefined); }
          return;
        }
        case 'queue': setQueueOpen(true); return;
        case 'newSession': await controller.createSession(); return;
        case 'history': setSearchResults(undefined); setContentSearch(false); setHistoryQuery(submission.query); return;
        case 'sessionSearch':
          await historyOperation(async signal => {
            const result = await controller.searchSessions(submission.query, submission.command === '/ssearch', signal);
            setHistoryQuery(undefined); setSearchResults({ query: submission.query, ...result });
          });
          return;
        case 'historySearch':
          await historyOperation(async signal => {
            setHistoryMatches(await controller.searchHistory(submission.query, signal));
            setSearchResults(undefined); setContentSearch(true); setHistoryQuery(submission.query);
          });
          return;
        case 'think': {
          if (submission.target === 'live') {
            setLiveReasoning(value => value === 'row' ? 'full' : 'row'); setThoughtList(false); setScroll(0);
          } else if (submission.target) {
            const seq = Number(submission.target);
            if (!Number.isSafeInteger(seq) || !displayTranscript.thoughts.some(entry => entry.seq === seq)) throw new Error('Use /think <message sequence> for a loaded reasoning block');
            const next = new Set(reasoningOverrides);
            if (next.delete(seq)) { setReasoningOverrides(next); return; }
            next.add(seq); setReasoningOverrides(next);
            await jumpHistory(seq, next);
          } else {
            setHistoryQuery(undefined); setSearchResults(undefined); setThoughtList(true);
          }
          return;
        }
        case 'older': await controller.older(undefined, displayTranscript); setScroll(value => value + 10); return;
        case 'compact':
          setNotice(undefined);
          await historyOperation(async signal => { setNotice(await controller.command('/compact', signal)); }, 'Compacting history…');
          return;
        case 'cancel': await controller.cancelTurn(); return;
        case 'approval': await controller.approve(submission.allowed); return;
        case 'hostCommand':
          setNotice(undefined);
          await historyOperation(async signal => { setNotice(await controller.command(submission.line, signal)); }, 'Running command…');
          return;
        case 'export':
          await historyOperation(async signal => { setNotice(`Saved session log: ${await controller.exportLog(submission.destination, signal)}`); }, 'Exporting session log…');
          return;
        case 'exportHtml':
          await historyOperation(async signal => { setNotice(`Saved loaded conversation: ${await controller.exportHtml(submission.destination, signal)}`); }, 'Exporting loaded conversation…');
          return;
        case 'answer': await answerQuestion(question!.multiSelect === true ? choiceState.selected : [], submission.text); return;
        case 'error': throw new Error(submission.message);
        case 'prompt': await controller.prompt(submission.text); setHistoryWindow(undefined); setScroll(0); return;
      }
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
  const commandSuggestions = input.startsWith('/') && !input.includes(' ') ? suggestedCommands(input) : undefined;
  // Reading older history pauses the clock without freezing the connection state on picker screens.
  const statusFrozen = statusPaused || (state.screen === 'chat' && position > 0);
  return <ThemeContext.Provider value={theme}><CopyMode.Provider value={copyMode}><Frozen frozen={copyMode} identity={`${width}:${stdout.rows}`}><Box flexDirection="column" paddingX={1} height={Math.max(1, (stdout.rows ?? 30) - 1)} overflowY="hidden">
    {copyMode && <Text color={theme.accent}>Copy mode · drag to select · Esc / Ctrl+S resumes</Text>}
    <ChatHeader title={headerTitle} mode={controller.sessionMode} width={width} frozen={displayPaused} identity={`${width}:${state.sessionId}`} />
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden">
    {historyLoading && <Text dimColor>{historyLoading} · Esc / Ctrl+C cancel</Text>}
    <Frozen frozen={statusPaused} identity={state.sessionId ?? ""}>{statusNotice && <Text dimColor wrap="truncate-end">{safeText(state.status)}</Text>}</Frozen>
    {state.error && <Text color={theme.colors.error}>{state.error}</Text>}
      {state.screen === 'chat' && <ChatViewport rows={visible} showHistoryHint={showHistoryHint} dialogOpen={dialogOpen}
        historyWindow={!!historyWindow} frozen={displayPaused}
        identity={`${width}:${state.sessionId}:${position}:${pageSize}`} boxRef={conversationBox} />}
    </Box>
    <Box flexDirection="column" flexShrink={0}>
      {notice && <Text dimColor>{safeText(notice)}</Text>}
      <Box borderStyle="round" borderColor={pending ? theme.colors.context : state.online ? theme.accent : theme.border} paddingX={1} flexDirection="column" flexShrink={1} minHeight={3}>
        <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
    {queueOpen && !pending ? <QueueDialog queued={queued} rows={stdout.rows ?? 30} width={width}
      unavailable={!!state.controlError}
      enabled={!input && !state.busy && state.online}
      canSelect={() => !draft.current && !controller.state.busy && controller.state.online && !controller.state.pending.length}
      onRemove={id => operate(() => controller.removeQueued(id))} /> : removal ? <RemovalDialog removal={removal}
      enabled={!input && !state.busy && state.online}
      canSelect={() => !draft.current && !controller.state.busy && controller.state.online}
      onCancel={() => setRemoval(undefined)}
      onConfirm={() => operate(async () => { await controller.removeTarget(removal); setRemoval(undefined); })} /> : models ? <ModelDialog models={models} rows={stdout.rows ?? 30} width={width}
      enabled={!input && !state.busy && state.online}
      canSelect={() => !draft.current && !controller.state.busy && controller.state.online}
      onChoose={(provider, model, effort) => operate(async () => { await controller.selectModel(provider, model, effort); setModels(undefined); })}
      onOpen={(provider, model) => setModels({ catalog: models.catalog, provider, model })}
      onBack={() => setModels({ catalog: models.catalog })}
      onClose={() => setModels(undefined)} /> : searchResults ? <SearchResultsDialog query={searchResults.query} items={searchResults.items} hasMore={searchResults.hasMore} width={width}
      enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy}
      onOpen={sessionId => operate(() => openSearchSession(sessionId, searchResults.query))}
      onClose={() => setSearchResults(undefined)} /> : state.screen === 'workspaces' || state.screen === 'sessions' ? <PickerScreen
      title={state.screen === 'workspaces' ? 'Choose workspace' : state.showAllSessions ? 'Choose session · All workspaces' : 'Choose session'}
      identity={`${state.screen}:${state.workspaceId ?? ''}`} choices={choices}
      enabled={state.online && !state.busy && !input}
      canSelect={() => !draft.current && controller.state.online && !controller.state.busy} /> : <>
      {thoughtList && <ThoughtsDialog identity={`thoughts:${state.sessionId}`} options={thoughtOptions} empty={!thoughtEntries?.length && !liveThought}
        rows={stdout.rows ?? 30} enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy} />}
      {state.screen === 'chat' && historyQuery !== undefined && <HistoryDialog identity={`history:${historyQuery}`}
        contentSearch={contentSearch} matches={historyMatches} query={historyQuery} messages={layout.messages} width={width}
        enabled={!input && !state.busy} canSelect={() => !draft.current && !controller.state.busy}
        onJump={seq => operate(() => jumpHistory(seq))}
        onClose={() => { setHistoryQuery(undefined); setHistoryMatches(undefined); }} />}
      {pending && <Box flexShrink={0} flexDirection="column">
        <Text bold color={theme.colors.context}>{question ? `Question ${answered.length + 1}/${questions.length}${question.header ? ` · ${safeText(string(question.header))}` : ''}` : 'Approval required'}</Text>
        <Text>{safeText(question ? string(question.question) : JSON.stringify(pending.request, null, 2))}</Text>
        {question?.detail && <Text>{safeText(string(question.detail))}</Text>}
        {pending.event === 'approval/request' && <Box flexDirection="column" flexShrink={0}>
          {/* Choices 1 and 2 are the host's `allowed-once` and `rejected` outcomes; 3 cancels the turn. */}
          {['Allow once', 'Deny', 'Stop turn'].map((label, index) => <Text key={label} color={approvalIndex === index ? theme.accent : undefined}>
            {approvalIndex === index ? '❯ ' : '  '}{index + 1}. {label}
          </Text>)}
          <Text dimColor>↑ ↓ / 1–3 select · Enter confirm</Text>
        </Box>}
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
        {!queueOpen && !pending && state.screen === 'chat' && queued.length > 0 && <QueuedPreview queued={queued} width={width} />}
        <Box flexShrink={0}>
        <Text color={theme.accent}>❯ </Text>
        <TextInput value={input} onChange={setInput} onCursorChange={setCursor} onSubmit={() => { void submit(draft.current); }}
          reservedKeys={approvalKeysActive ? ['1','2','3'] : queueOpen && !pending ? ['d'] : questionKeysActive ? ['1','2','3','4','5','6','7','8','9', ...(question?.multiSelect === true ? [' '] : [])] : !removal && !models && !searchResults && (state.screen === 'workspaces' || state.screen === 'sessions') ? ['d'] : undefined}
          focus={state.online && !state.busy && !copyMode} placeholder={state.screen === 'path' ? 'Absolute directory path on host' : 'Message, @host-file, or /help'} />
        </Box>
      {referenceOpen && <ReferenceMenu matches={matches} index={referenceIndex} />}
      </Box>
      {commandSuggestions && <Text dimColor>{commandSuggestions.join('  ')}</Text>}
      {help && <HelpPanel page={currentHelpPage} pages={helpPages} pageSize={helpPageSize} />}
      {costExpanded && <CostPanel controller={controller} />}
      <Frozen frozen={statusFrozen} identity={`${width}:${state.sessionId}:${statusExpanded}:${statusPage}`}><StatusBar controller={controller} width={width} expanded={statusExpanded} page={statusPage} pageSize={statusPageSize} revision={state.version} paused={statusFrozen} /></Frozen>
    </Box>
  </Box></Frozen></CopyMode.Provider></ThemeContext.Provider>;
}
