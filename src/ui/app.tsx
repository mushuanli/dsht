/** Ink terminal interface: startup pickers, transcript, and slash-command composer. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mocha, ThemeContext, type Theme } from './theme/index.ts';
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from 'ink';
import { useMouseWheel } from './input/mouse.ts';
import { TextInput } from './input/input.tsx';
import { ReferenceMenu } from './input/references.tsx';
import { historyLayout, type Reasoning } from '../session/history.ts';
import { toolLine } from '../session/transcript.ts';
import { activeReference, fileMention, type FileReference } from '../session/references.ts';
import { CostPanel } from './dialogs/cost.tsx';
import { StatusBar } from './chat/status.tsx';
import { ChatHeader } from './chat/header.tsx';
import { ChatViewport } from './chat/viewport.tsx';
import { mergeShellRuns } from './chat/shell-view.ts';
import { Frozen } from './frozen.tsx';
import { CopyMode } from './copy-mode.ts';
import type { Choice } from './dialogs/picker.tsx';
import { HelpPanel, HistoryDialog, ModelDialog, PickerScreen, QueueDialog, QueuedPreview, RemovalDialog, SearchResultsDialog, ThoughtsDialog } from './dialogs/index.tsx';
import { COMMAND_HINTS, completeCommand as completeDraft, suggestedCommands } from './commands/registry.ts';
import { classifySubmission } from './commands/parse.ts';
import { Controller, type HistorySearch, type RemovalTarget } from '../controller/controller.ts';
import { ROLLUP_LEGEND, sessionLabel, sessionStatus, workspaceCounts, workspaceDetail, workspaceSegments, workspaceStatus, type RollupState, type RollupStyle } from '../session/navigation.ts';
import { array, errorText, object, safeText, string, type ObjectValue } from '../transport/wire.ts';

/** Transient notices expire; interactive panels remain open until dismissed. */
const PANEL_LIFETIME_MS = 10_000;

/** Pages one boundary recall press may walk before it reports that nothing older holds a prompt. */
const RECALL_PAGE_SCAN = 20;

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
  // The composer belongs to the selected session: it resets when another session opens, and every
  // callback reads the controller rather than a render closure Ink may not have refreshed yet.
  const { draft: input, cursor } = state.session.composer;
  const historyPaging = useRef(false);
  const setInput = (value: string, recalled = false) => {
    if (!recalled) controller.resetRecall();
    // A new message draft returns the view to the live end, so composing never needs a scroll first.
    // A slash command is not a message, and the reader keeps their place while typing one.
    if (state.screen === 'chat' && controller.composer.draft === '' && value !== '' && !value.startsWith('/')) controller.setScroll(0);
    controller.setComposer(value);
  };
  // The reading view is session-owned too: which record is shown, where the reader is, and what is
  // expanded. `SessionInfo` releases the detached window, so the composer and this view reset together.
  const { window: historyWindow, scroll, folds: reasoningOverrides, liveReasoning } = state.session.view;
  const [historyLoading, setHistoryLoading] = useState<string>();
  const displayTranscript = historyWindow ?? state.session.record;
  const displayRef = useRef(displayTranscript); displayRef.current = displayTranscript;
  const conversationBox = useRef<DOMElement>(null);
  const [conversationRows, setConversationRows] = useState(20);
  useLayoutEffect(() => {
    if (conversationBox.current) {
      const height = Math.floor(measureElement(conversationBox.current).height);
      if (height !== conversationRows) setConversationRows(height);
    }
  });
  const [removal, setRemoval] = useState<RemovalTarget>();
  // Session-owned panels: visibility and query text only, because every row comes from the record.
  const { thoughts: thoughtList, queue: queueOpen, model: models, history, search: searchResults } = state.session.panels;
  const historyQuery = history?.query;
  const contentSearch = history?.contentSearch === true;
  const historyMatches = history?.matches;
  const historyAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => historyAbort.current?.abort(), []);
  const [costExpanded, setCostExpanded] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const reasoning: Reasoning = 'row';
  useEffect(() => { controller.setLiveReasoning('row'); }, [state.session.record, state.session.record.liveAttemptKey]);
  const [notice, setNotice] = useState<string>();
  const [help, setHelp] = useState(false);
  const [helpPage, setHelpPage] = useState(0);
  const helpPageSize = Math.max(1, (stdout.rows ?? 30) - 12);
  const helpPages = Math.ceil(COMMAND_HINTS.length / helpPageSize);
  const currentHelpPage = Math.min(helpPage, helpPages - 1);
  const [statusScroll, setStatusScroll] = useState(0);
  const [statusOverflow, setStatusOverflow] = useState(false);
  // The panel owns two border rows and a one-row footer, and the two header rows and the
  // three-row composer above it never shrink, so only the remainder of the screen height shows rows.
  const [statusBarRows, setStatusBarRows] = useState(1);
  const statusViewRows = Math.max(1, (stdout.rows ?? 30) - 9 - (statusBarRows - 1));
  // Answers and menu highlights are session-owned too: the waterfall itself is derived per session
  // by the controller, so only the local selection is kept here.
  const { answers, option: optionState, approval: approvalSelection } = state.session.interaction;
  const { index: referenceIndex, dismissed: dismissedReference } = state.session.reference;
  const [lookup, setLookup] = useState<{ draft: string; sessionId: string; items: FileReference[]; error?: string }>();
  // Interactive panels remain stable while read; only transient notices expire.
  useEffect(() => {
    if (copyMode) return;
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), panelLifetimeMs);
    return () => clearTimeout(timer);
  }, [notice, panelLifetimeMs, copyMode]);
  // `/history` is a lookup rather than a panel to read, so it expires with the notice lifetime;
  // Esc closes it sooner, and its own content search stays open until the reader leaves it.
  useEffect(() => {
    if (copyMode || contentSearch || historyQuery === undefined) return;
    const timer = setTimeout(() => { controller.setHistoryPanel(undefined); }, panelLifetimeMs);
    return () => clearTimeout(timer);
  }, [historyQuery, contentSearch, panelLifetimeMs, copyMode]);
  const pending = state.pending[0];
  const queued = controller.telemetry.pending(state.sessionId).filter(item => item.placement !== 'context');
  useEffect(() => { controller.openQueue(false); }, [state.sessionId, pending?.eventId]);
  // A replayed interaction (same eventId after a reconnect) starts unselected again.
  useEffect(() => { controller.setApproval(undefined); }, [state.sessionId, state.online, pending?.eventId]);
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
    controller.setReferenceIndex(0);
    void controller.references(activeReference(input)!.query, abort.signal).then(items => {
      if (!abort.signal.aborted) setLookup({ draft: input, sessionId: state.sessionId!, items });
    }, error => {
      if (!abort.signal.aborted) setLookup({ draft: input, sessionId: state.sessionId!, items: [], error: errorText(error) });
    });
    return () => abort.abort();
  }, [controller, input, state.sessionId, referenceOpen]);
  const pickReference = () => {
    const candidate = matches?.items[referenceIndex];
    if (!candidate || !token || controller.composer.draft !== input) return;
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
  // Composer recall yields only to a surface that uses the arrows itself: the pickers, and a status
  // panel with more lines than the view holds. The help and cost panels and a fitting status panel
  // leave the arrows with the history, and Ctrl+P/N reach it from every surface.
  const recallBlocked = !!(removal || models || thoughtList || historyQuery !== undefined || searchResults || (statusExpanded && statusOverflow));
  const questionKeysActive = !!question && options.length > 0 && !choiceState.custom && !copyMode && !panelBlocksKeys;
  // A dialog that demands an answer owns the keyboard until it is settled: the draft being written is
  // parked rather than typed into, and comes back when the last one closes. A question switches to
  // the composer itself for a free-text or "Other" answer, so it keeps the keys then.
  const answerPending = !!pending && (pending.event === 'approval/request' || options.length > 0 && !choiceState.custom);
  useEffect(() => {
    if (answerPending) { controller.parkComposer(); return; }
    if (pending) return;
    // Restoring writes the draft directly: it was neither recalled from history nor a new message,
    // so it must not move a reader's scroll position.
    controller.restoreComposer();
  }, [answerPending, pending]);
  const approvalKeysActive = pending?.event === 'approval/request' && !copyMode && !panelBlocksKeys;
  const approvalIndex = approvalSelection?.eventId === eventId ? approvalSelection.index : -1;
  const answerQuestion = async (selected: string[], custom?: string) => {
    if (controller.state.pending[0]?.eventId !== eventId) throw new Error('The pending question has changed');
    const answer = { id: string(question!.id), selected, ...(custom ? { custom } : {}) };
    const next = [...answered, answer];
    if (next.length === questions.length) {
      await controller.answer({ answers: next });
      const rest = { ...controller.interaction.answers }; delete rest[eventId]; controller.setAnswers(rest);
    } else controller.setAnswers({ ...controller.interaction.answers, [eventId]: next });
    controller.setOption(undefined);
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
    if ((key.escape || key.ctrl && _value === 'c') && historyAbort.current) {
      historyAbort.current.abort();
      // Esc also leaves a history list that was already on screen when the load was aborted.
      if (key.escape && historyQuery !== undefined) { controller.setHistoryPanel(undefined); }
      return;
    }
    if ((key.escape || key.ctrl && _value === 'c') && controller.state.pending.length) {
      if (key.ctrl && controller.composer.draft) setInput('');
      if (key.escape) {
        controller.setApproval(undefined);
        setRemoval(undefined); controller.setModelPanel(undefined); controller.openThoughts(false); controller.setSearchPanel(undefined);
        controller.setHistoryPanel(undefined); setHelp(false); setCostExpanded(false); setStatusExpanded(false);
        // A question batch is one request, so Esc leaves the whole set the way the Web client's
        // close button does. The free-text row keeps its own step back: its first Esc returns to
        // the options, and only the next one dismisses. Approval keeps every choice explicit.
        if (pending?.event === 'user-questions/request' && !choiceState.custom) {
          if (controller.state.online && !controller.state.busy && controller.state.pending[0]?.eventId === eventId) {
            controller.setOption(undefined);
            const rest = { ...controller.interaction.answers }; delete rest[eventId]; controller.setAnswers(rest);
            operate(() => controller.dismissQuestion());
          }
          return;
        }
        controller.setOption({ ...choiceState, custom: false });
      }
      return;
    }
    if (approvalKeysActive && !controller.composer.draft && controller.state.online && !controller.state.busy
      && controller.state.pending[0]?.eventId === eventId && !key.ctrl && !key.meta) {
      const digit = /^[1-3]$/.test(_value) ? Number(_value) - 1 : -1;
      if (digit >= 0 || key.upArrow || key.downArrow) {
        // An unselected list enters at the first, non-destructive choice, so a stray arrow plus Enter cannot cancel.
        const index = digit >= 0 ? digit : approvalIndex < 0 ? 0
          : Math.max(0, Math.min(2, approvalIndex + (key.upArrow ? -1 : 1)));
        controller.setApproval({ eventId, index }); return;
      }
      if (key.return) {
        // Choice 3 cancels the turn instead of answering the request, so it sends no event result.
        if (approvalIndex >= 0) operate(() => approvalIndex === 2 ? controller.cancelTurn() : controller.approve(approvalIndex === 0));
        return;
      }
    }
    if (questionKeysActive && !controller.composer.draft && !controller.state.busy && !key.ctrl && !key.meta) {
      const digit = /^[1-9]$/.test(_value) ? Number(_value) - 1 : -1;
      if (key.upArrow || key.downArrow) {
        controller.setOption({ ...choiceState, cursor: Math.max(0, Math.min(options.length, optionCursor + (key.upArrow ? -1 : 1))) }); return;
      }
      if (digit >= 0 && digit <= options.length || _value === ' ' && question!.multiSelect === true && optionCursor < options.length) {
        const index = digit >= 0 ? digit : optionCursor;
        const label = index < options.length ? string(options[index]!.label) : undefined;
        const selected = question!.multiSelect === true && label
          ? choiceState.selected.includes(label) ? choiceState.selected.filter(item => item !== label) : [...choiceState.selected, label]
          : choiceState.selected;
        controller.setOption({ ...choiceState, cursor: index, selected }); return;
      }
      if (key.return) {
        if (optionCursor === options.length) { controller.setOption({ ...choiceState, custom: true }); return; }
        const selected = question!.multiSelect === true ? choiceState.selected : [string(options[optionCursor]!.label)];
        if (!selected.length) { setNotice('Select at least one option with Space or a number'); return; }
        operate(() => answerQuestion(selected)); return;
      }
    }
    if (help && (key.pageUp || key.pageDown)) {
      setHelpPage(Math.max(0, Math.min(helpPages - 1, currentHelpPage + (key.pageUp ? -1 : 1)))); return;
    }
    if (statusExpanded && statusOverflow && (key.upArrow || key.downArrow)) {
      setStatusScroll(value => Math.max(0, value + (key.upArrow ? -1 : 1))); return;
    }
    if (statusExpanded && statusOverflow && (key.pageUp || key.pageDown)) {
      setStatusScroll(value => Math.max(0, value + (key.pageUp ? -statusViewRows : statusViewRows))); return;
    }
    if (key.pageUp || key.pageDown) { scrollHistory(key.pageUp ? 10 : -10); return; }
    if (key.escape && queueOpen) { controller.openQueue(false); return; }
    if (key.escape && removal) { setRemoval(undefined); return; }
    if (key.escape && models) { controller.setModelPanel(undefined); return; }
    if (key.escape && thoughtList) { controller.openThoughts(false); if (controller.running) void controller.interrupt(true); return; }
    if (key.escape && searchResults) { controller.setSearchPanel(undefined); if (controller.running) void controller.interrupt(true); return; }
    if (key.escape && historyQuery !== undefined) { controller.setHistoryPanel(undefined); if (controller.running) void controller.interrupt(true); return; }
    // The typed host path is a screen of its own, so Esc has to leave it: the picker behind it is
    // disabled while a draft exists, so a leftover path would leave no way back at all.
    if (key.escape && state.screen === 'path') { setInput(''); operate(() => controller.showPicker('workspaces')); return; }
    if (key.ctrl && _value === 'c' && input === '' && controller.shell.running) {
      // A local command in the transcript is the most immediate thing Ctrl+C can stop.
      controller.shell.cancel(); return;
    }
    if (key.ctrl && _value === 'c') {
      // A draft clears first, exactly like a shell prompt; an empty draft still stops or exits.
      if (input !== '') { setInput(''); return; }
      void controller.interrupt().then(shouldExit => { if (shouldExit) exit(); });
      return;
    }
    if (referenceOpen) {
      if (key.escape) { controller.setReferenceDismissed(input); if (controller.running) void controller.interrupt(true); }
      else if (key.tab) pickReference();
      else if (key.upArrow) controller.setReferenceIndex(Math.max(0, controller.reference.index - 1));
      else if (key.downArrow) controller.setReferenceIndex(Math.max(0, Math.min((matches?.items.length ?? 1) - 1, controller.reference.index + 1)));
      return;
    }
    const recallPrevious = key.upArrow || key.ctrl && _value === 'p';
    const recallNext = key.downArrow || key.ctrl && _value === 'n';
    if ((recallPrevious || recallNext) && state.online && !controller.state.busy && !pending
      && !queueOpen && (!recallBlocked || key.ctrl)
      && (state.screen === 'chat' || controller.composer.draft !== '' || key.ctrl)) {
      // The oldest seeded entry is where the session happened to open, not where it began: stepping
      // past it fetches the page before the retained window, and the step is applied once the page
      // lands, so recall covers prompts from before this client connected. Paging stays with the
      // conversation: on a picker screen the arrows only ever walked what was already retained.
      if (recallPrevious && state.screen === 'chat' && !historyPaging.current
        && (controller.recallAtOldest || controller.recallLength === 0)
        && state.session.record.ready && controller.recallHasOlder) { void recallOlderPrompts(); return; }
      setInput(controller.recall(recallPrevious ? -1 : 1, controller.composer.draft), true); return;
    }
    if (key.tab) { completeCommand(); return; }
    if (key.escape && (help || costExpanded || statusExpanded || notice !== undefined)) {
      setHelp(false); setCostExpanded(false); setStatusExpanded(false); setStatusScroll(0); setNotice(undefined);
      if (controller.running) void controller.interrupt(true);
      return;
    }
    if (key.escape && controller.shell.running && input === '' && !panelBlocksKeys && !pending && state.screen === 'chat') {
      // The local command is the most immediate thing Esc can stop; the next press interrupts the agent.
      controller.shell.cancel(); return;
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
    if (!pending && !/^\/feedback(?:\s|$)/.test(value)) controller.recordRecall(value);
    if (submission.kind === 'copy') { setInput(''); setCopyMode(true); return; }
    setRemoval(undefined);
    // Each panel belongs to the command that opened it, so any other command closes it.
    if (value !== '/queue') controller.openQueue(false);
    if (!/^\/model(?: |$)/.test(value)) controller.setModelPanel(undefined);
    if (value !== '/help') setHelp(false);
    if (value !== '/cost') setCostExpanded(false);
    if (value !== '/status') setStatusExpanded(false);
    if (!/^\/think(?: |$)/.test(value)) controller.openThoughts(false);
    if (submission.kind === 'quit') { exit(); return; }
    if (submission.kind === 'panel') {
      if (submission.panel === 'cost') {
        setCostExpanded(value => !value); setInput('');
        if (!costExpanded) void controller.perform(() => historyOperation(signal => controller.refreshCosts(signal)));
      } else if (submission.panel === 'status') { setStatusExpanded(value => !value); setStatusScroll(0); setInput(''); }
      else { setHelp(value => !value); setHelpPage(0); setInput(''); }
      return;
    }
    const accepted = await controller.perform(async () => {
      switch (submission.kind) {
        case 'remove': await requestRemoval(submission.target, submission.query); return;
        case 'navigate': {
          controller.setHistoryPanel(undefined);
          controller.setSearchPanel(undefined);
          if (submission.target === 'workspace') await controller.switchWorkspace(submission.query);
          else await controller.switchSession(submission.query);
          controller.setScroll(0);
          return;
        }
        case 'path': await controller.createWorkspace(submission.value); return;
        case 'latest':
          controller.setViewWindow(undefined); controller.setHistoryPanel(undefined); controller.setSearchPanel(undefined);
          controller.setFolds(new Set()); controller.setScroll(0); controller.pinHistory(false);
          return;
        case 'models': {
          if (!submission.args.length) { controller.setHistoryPanel(undefined); controller.setSearchPanel(undefined); controller.setModelPanel({ catalog: await controller.modelCatalog() }); }
          else { await controller.selectModel(submission.args[0]!, submission.args[1]!, submission.args[2]); controller.setModelPanel(undefined); }
          return;
        }
        case 'queue': controller.openQueue(true); return;
        case 'shell': controller.shell.start(submission.command); controller.setScroll(0); return;
        case 'newSession': await controller.createSession(); return;
        case 'history': controller.setSearchPanel(undefined); controller.setHistoryPanel({ query: submission.query, contentSearch: false }); return;
        case 'sessionSearch':
          await historyOperation(async signal => {
            const result = await controller.searchSessions(submission.query, submission.command === '/ssearch', signal);
            controller.setHistoryPanel(undefined); controller.setSearchPanel({ query: submission.query, ...result });
          });
          return;
        case 'historySearch':
          await historyOperation(async signal => {
            controller.setHistoryPanel({ query: submission.query, contentSearch: true,
              matches: await controller.searchHistory(submission.query, signal) });
            controller.setSearchPanel(undefined);
          });
          return;
        case 'think': {
          if (submission.target === 'live') {
            controller.setLiveReasoning(controller.view.liveReasoning === 'row' ? 'full' : 'row'); controller.openThoughts(false); controller.setScroll(0);
          } else if (submission.target) {
            const seq = Number(submission.target);
            if (!Number.isSafeInteger(seq) || !displayTranscript.thoughts.some(entry => entry.seq === seq)) throw new Error('Use /think <message sequence> for a loaded reasoning block');
            const next = new Set(reasoningOverrides);
            if (next.delete(seq)) { controller.setFolds(next); return; }
            next.add(seq); controller.setFolds(next);
            await jumpHistory(seq, next);
          } else {
            controller.setHistoryPanel(undefined); controller.setSearchPanel(undefined); controller.openThoughts(true);
          }
          return;
        }
        case 'older': await controller.older(undefined, displayTranscript); controller.setScroll(controller.view.scroll + 10); return;
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
        case 'coredump':
          // V8 serializes the heap synchronously, so the client stalls until the file is written;
          // the path is reported afterwards so the snapshot can be opened in DevTools.
          await historyOperation(async () => {
            setNotice(`Heap snapshot saved: ${controller.heapSnapshot(submission.tag)}`);
          }, 'Writing heap snapshot…');
          return;
        case 'answer': await answerQuestion(question!.multiSelect === true ? choiceState.selected : [], submission.text); return;
        case 'error': throw new Error(submission.message);
        case 'prompt': await controller.prompt(submission.text); controller.setViewWindow(undefined); controller.setScroll(0); return;
      }
    });
    if (accepted) setInput('');
  };

  const width = Math.max(10, (stdout.columns ?? 80) - 2);
  // The composer never trades the conversation away for input. Its window grows with the body and
  // is clamped so a few conversation rows always survive; width never buys height, so landscape and
  // a wide desktop only wrap less instead of showing more input rows. The budget subtracts the one
  // row the frame, the header, the status bar and a transient notice/suggestion line may each take.
  const bodyRows = Math.max(4, (stdout.rows ?? 30) - 4 - statusBarRows);
  const composerRows = Math.max(1, Math.min(Math.min(5, Math.max(2, Math.floor(bodyRows / 3))), bodyRows - 7));
  const draftWidth = Math.max(1, width - 6);
  // Session activity is a list-level fact, so both pickers read it without loading any history.
  const listAge = Date.now();
  // Unanswered interactions are held per session already; a list only has to read the counts.
  const pendingCounts = controller.pendingCounts();
  const isPending = (session: ObjectValue): boolean => (pendingCounts.get(string(session.sessionId)) ?? 0) > 0;
  const sessionsOf = (workspace: ObjectValue): ObjectValue[] => {
    const ids = new Set(array(workspace.sessionIds).map(string));
    return state.sessions.filter(session => ids.has(string(session.sessionId)));
  };
  // `width` counts only the frame's outer padding, so the list subtracts the composer border and
  // padding it renders inside; measured against the wider value a long row would still wrap.
  const pickerWidth = Math.max(16, width - 4);
  // Words explain themselves. Badges fit a narrow terminal but need the marker key beside them.
  const rollupStyle: RollupStyle = pickerWidth >= 80 ? 'words' : 'badges';
  // Needs-you is the one state that asks for action, so it outranks working; ready stays quiet.
  const stateColor: Record<RollupState, string> = { needs: theme.status.critical, running: theme.status.working, idle: theme.colors.muted };
  const choices: Choice[] = state.screen === 'workspaces' ? [
    ...state.workspaces.map(workspace => {
      const counts = workspaceCounts(sessionsOf(workspace), new Set(pendingCounts.keys()));
      const name = string(workspace.title);
      const title = name || string(workspace.path);
      // A path only earns a column when words are affordable and the title does not already say it.
      const detail = rollupStyle === 'words' && name ? workspaceDetail(string(workspace.path), name) : '';
      return { key: string(workspace.workspaceId),
        label: [workspaceStatus(counts, rollupStyle), title].filter(Boolean).join('  '), title,
        cells: workspaceSegments(counts, rollupStyle).map(segment => ({ text: segment.text, color: stateColor[segment.state] })),
        ...(detail ? { detail } : {}),
        remove: () => setRemoval({ kind: 'workspace', id: string(workspace.workspaceId), name: string(workspace.title), path: string(workspace.path) }),
        action: () => controller.pickWorkspace(string(workspace.workspaceId)) };
    }),
    { key: '@all', label: 'All sessions', action: () => operate(() => controller.switchSession('all')) },
    // The directory this client runs in is the one case where no path has to be typed, and offering
    // it only while the host has not registered it keeps the row from repeating itself.
    ...(state.workspaces.some(workspace => string(workspace.path) === controller.localDirectory) ? []
      : [{ key: '@here', label: `+ Add workspace (this directory)  ${controller.localDirectory}`,
        action: () => operate(() => controller.createWorkspace(controller.localDirectory)) }]),
    { key: '@new', label: '+ Add workspace (host directory)', action: () => controller.enterPath() },
  ] : [
    ...(state.workspaceId && !state.showAllSessions ? [{ key: '@new', label: '+ New session', action: () => operate(() => controller.createSession()) }] : []),
    ...controller.visibleSessions.map(session => ({ key: string(session.sessionId),
      label: `${sessionStatus(session, listAge, isPending(session))} ${sessionLabel(session)}  ${session.sessionId}`,
      remove: () => operate(() => requestRemoval('session', string(session.sessionId))),
      action: () => { controller.setScroll(0); operate(() => controller.selectSession(string(session.sessionId))); } })),
    { key: '@back', label: '← Workspaces', action: () => operate(() => controller.showPicker('workspaces')) },
  ];
  const layout = useMemo(() => historyLayout(displayTranscript, width, reasoning, reasoningOverrides, liveReasoning),
    [displayTranscript, displayTranscript.version, width, reasoning, reasoningOverrides, liveReasoning]);
  const { length, first } = layout;
  // Local `!` blocks live at the end of the transcript: not host records, not persisted, but they
  // scroll with the conversation and are counted into its total so the viewport math stays honest.
  const merged = useMemo(() => mergeShellRuns(layout, controller.shell.runs, width),
    [layout, controller, state.version, width]);
  const totalRows = merged.total;
  const statusNotice = !['Connected', 'Idle', 'Running…', 'Responding…'].includes(state.status);
  const showHistoryHint = dialogOpen || displayTranscript.hasMore || !!historyWindow;
  const pageSize = Math.max(1, conversationRows - (showHistoryHint ? 1 : 0));
  const previousView = useRef({ transcript: displayTranscript, session: state.session.record, count: totalRows, first, folds: reasoningOverrides, liveReasoning });
  const previous = previousView.current;
  const prepended = previous.first !== undefined && first !== undefined && first < previous.first;
  const adjustedScroll = previous.session !== state.session.record ? 0
    : scroll > 0 && previous.transcript === displayTranscript && !prepended && previous.folds === reasoningOverrides && previous.liveReasoning === liveReasoning ? Math.max(0, scroll + totalRows - previous.count) : scroll;
  const maxScroll = Math.max(0, totalRows - pageSize);
  const position = Math.min(adjustedScroll, maxScroll);
  useLayoutEffect(() => {
    previousView.current = { transcript: displayTranscript, session: state.session.record, count: totalRows, first, folds: reasoningOverrides, liveReasoning };
    if (position !== scroll) controller.setScroll(position);
  }, [state.session.record, displayTranscript, totalRows, position, scroll, reasoningOverrides, liveReasoning]);
  useLayoutEffect(() => {
    controller.pinHistory(!historyWindow && (position > 0 || thoughtList || historyQuery !== undefined && !contentSearch));
  }, [controller, historyWindow, position, thoughtList, historyQuery, contentSearch, state.session.record]);
  useEffect(() => {
    const first = displayTranscript.beforeSeq;
    if (first === undefined) return;
    const previous = controller.view.folds;
    const next = new Set([...previous].filter(seq => seq >= first));
    if (next.size !== previous.size) controller.setFolds(next);
  }, [displayTranscript, displayTranscript.memoryRevision]);
  const loadingPage = useRef(false);
  const scrollIntent = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function scrollHistory(delta: number): void {
    if (copyMode || state.screen !== 'chat') return;
    const intent = ++scrollIntent.current;
    const next = Math.max(0, Math.min(maxScroll, controller.view.scroll + delta));
    controller.setScroll(next);
    if (delta <= 0 || next < maxScroll || loadingPage.current || state.busy || !state.online || !displayTranscript.ready || !displayTranscript.hasMore) return;
    loadingPage.current = true;
    const transcript = displayTranscript;
    void controller.perform(() => historyOperation(signal => controller.older(signal, transcript))).then(accepted => {
      if (accepted && mounted.current && displayRef.current === transcript && scrollIntent.current === intent) {
        controller.setScroll(controller.view.scroll + delta);
      }
    }).finally(() => { loadingPage.current = false; });
  }
  async function historyOperation(operation: (signal: AbortSignal) => Promise<void>, label = 'Loading history…'): Promise<void> {
    const abort = new AbortController();
    historyAbort.current = abort; setHistoryLoading(label);
    try { await operation(abort.signal); }
    finally { if (historyAbort.current === abort) { historyAbort.current = undefined; setHistoryLoading(undefined); } }
  }

  /** Reach one prompt older than the index's boundary, from memory first and the host second.
   *
   * The transcript window outlives the prompt index's budgets, so an evicted prompt is usually still
   * loaded: refilling from it costs nothing and keeps the key immediate. Only when the window itself
   * is exhausted does this page back, skipping tool-only pages inside one bounded request loop; the
   * fetched page stays readable in the conversation above the composer.
   */
  async function recallOlderPrompts(): Promise<void> {
    if (historyPaging.current) return;
    const transcript = state.session.record;
    const sessionId = state.sessionId;
    // Recover from the loaded window first: no request, no focus change, no loading label.
    if (controller.refillRecall() || !transcript.hasMore) { setInput(controller.recall(-1, controller.composer.draft), true); return; }
    historyPaging.current = true;
    try {
      const accepted = await controller.perform(() => historyOperation(async signal => {
        // A prompt can be many pages back in an agent session, so scan a healthy stretch before
        // giving up; the loading label stays visible and Esc cancels the scan.
        for (let page = 0; page < RECALL_PAGE_SCAN; page++) {
          if (transcript.beforeSeq === undefined || !transcript.hasMore) break;
          await controller.older(signal, transcript);
          signal.throwIfAborted();
          if (controller.refillRecall()) return;
        }
      }, 'Loading older prompts…'));
      if (accepted && mounted.current && controller.state.sessionId === sessionId) {
        setInput(controller.recall(-1, controller.composer.draft), true);
      }
    } finally { historyPaging.current = false; }
  }
  async function openSearchSession(sessionId: string, query: string): Promise<void> {
    await historyOperation(async signal => {
      await controller.selectSession(sessionId);
      await controller.waitForHistory(signal);
      controller.setHistoryPanel({ query, contentSearch: true, matches: await controller.searchHistory(query, signal) });
      controller.setSearchPanel(undefined);
    });
  }
  async function jumpHistory(target: number, folds = reasoningOverrides): Promise<void> {
    if (state.screen !== 'chat') throw new Error('Select a session first');
    ++scrollIntent.current;
    const abort = new AbortController();
    historyAbort.current = abort;
    try {
      const transcript = displayTranscript.messages.some(message => message.seq === target) ? displayTranscript
        : state.session.record.messages.some(message => message.seq === target) ? state.session.record
        : await controller.historyAt(target, abort.signal);
      abort.signal.throwIfAborted();
      const current = historyLayout(transcript, width, reasoning, folds, liveReasoning);
      const row = current.offsets.get(target);
      if (row === undefined) throw new Error('No visible message at this sequence; use /history to choose a record');
      controller.setViewWindow(transcript === state.session.record ? undefined : transcript);
      controller.setHistoryPanel(undefined); controller.openThoughts(false);
      controller.setScroll(Math.max(0, current.length - pageSize - row));
    } finally { if (historyAbort.current === abort) historyAbort.current = undefined; }
  }
  useMouseWheel(direction => { if (statusExpanded && statusOverflow) setStatusScroll(value => Math.max(0, value - direction * 3)); else scrollHistory(direction * 3); }, !copyMode && state.screen === 'chat', () => { if (!dialogOpen) setCopyMode(true); });
  const trailingGap = dialogOpen && length > 0 && layout.viewport(length - 1, length)[0]?.text === '' ? 1 : 0;
  const end = Math.max(pageSize, totalRows - position - trailingGap);
  const visible = useMemo(() => merged.viewport(Math.max(0, end - pageSize), end), [merged, end, pageSize]);
  const liveThought = thoughtList && !historyWindow ? state.session.record.liveParts(width).find(part => part.kind === 'reasoning') : undefined;
  const thoughtEntries = thoughtList ? displayTranscript.thoughts : undefined;
  const thoughtChoices = useMemo(() => [...(thoughtEntries ?? [])].reverse().map(entry => ({
    key: String(entry.seq), label: `${toolLine(`#${entry.seq} User · ${entry.prompt}`, width - 2)}\n  ${toolLine(`◇ ${entry.preview}`, width - 4)}`,
    action: () => operate(async () => { const next = new Set(reasoningOverrides); next.add(entry.seq); controller.setFolds(next); await jumpHistory(entry.seq, next); }),
  })), [thoughtEntries, width, pageSize, reasoningOverrides, liveReasoning, displayTranscript]);
  const thoughtOptions = useMemo(() => [
          ...(liveThought ? [{ key: 'live', label: `${toolLine(`Now · User · ${state.session.record.latestPrompt}`, width - 2)}\n  ${toolLine(liveThought.text, width - 4)}`,
            action: () => { controller.setLiveReasoning('full'); controller.openThoughts(false); const expanded = historyLayout(state.session.record, width, reasoning, reasoningOverrides, 'full'); controller.setScroll(Math.max(0, expanded.length - pageSize - expanded.liveOffset)); } }] : []),
          ...thoughtChoices,
          ...(displayTranscript.hasMore ? [{ key: 'older', label: '↑ Load older reasoning', action: () => operate(() => historyOperation(signal => controller.older(signal, displayTranscript))) }] : []),
          { key: 'close', label: '← Back to conversation', action: () => controller.openThoughts(false) },
        ], [liveThought, thoughtChoices, displayTranscript, displayTranscript.hasMore, width, pageSize, reasoningOverrides]);
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  const workspaceName = workspace ? string(workspace.title) || string(workspace.path) : state.workspaceId;
  const headerTitle = controller.sessionName
    ? [controller.sessionName, width >= 60 ? workspaceName : undefined].filter(Boolean).join(' · ')
    : workspaceName || 'All workspaces';
  const commandSuggestions = input.startsWith('/') && !input.includes(' ') ? suggestedCommands(input) : undefined;
  // Reading older history pauses the clock without freezing the connection state on picker screens.
  // A paused clock is named rather than left frozen: a stopped number looks like a stall.
  const pauseReason: 'copy' | 'dialog' | 'history' | undefined = copyMode ? 'copy'
    : state.screen === 'chat' && dialogOpen ? 'dialog'
    : state.screen === 'chat' && position > 0 ? 'history'
    : undefined;
  const statusFrozen = pauseReason !== undefined;
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
      canSelect={() => !controller.composer.draft && !controller.state.busy && controller.state.online && !controller.state.pending.length}
      onRemove={id => operate(() => controller.removeQueued(id))} /> : removal ? <RemovalDialog removal={removal}
      enabled={!input && !state.busy && state.online}
      canSelect={() => !controller.composer.draft && !controller.state.busy && controller.state.online}
      onCancel={() => setRemoval(undefined)}
      onConfirm={() => operate(async () => { await controller.removeTarget(removal); setRemoval(undefined); })} /> : models ? <ModelDialog models={models} rows={stdout.rows ?? 30} width={width}
      enabled={!input && !state.busy && state.online}
      canSelect={() => !controller.composer.draft && !controller.state.busy && controller.state.online}
      onChoose={(provider, model, effort) => operate(async () => { await controller.selectModel(provider, model, effort); controller.setModelPanel(undefined); })}
      onOpen={(provider, model) => controller.setModelPanel({ catalog: models.catalog, provider, model })}
      onBack={() => controller.setModelPanel({ catalog: models.catalog })}
      onClose={() => controller.setModelPanel(undefined)} /> : searchResults ? <SearchResultsDialog query={searchResults.query} items={searchResults.items} hasMore={searchResults.hasMore} width={width}
      enabled={!input && !state.busy} canSelect={() => !controller.composer.draft && !controller.state.busy}
      onOpen={sessionId => operate(() => openSearchSession(sessionId, searchResults.query))}
      onClose={() => controller.setSearchPanel(undefined)} /> : state.screen === 'workspaces' || state.screen === 'sessions' ? <PickerScreen
      title={state.screen === 'workspaces' ? 'Choose workspace' : state.showAllSessions ? 'Choose session · All workspaces' : 'Choose session'}
      identity={`${state.screen}:${state.workspaceId ?? ''}`} choices={choices} width={pickerWidth}
      // A rollup of badges is read through the key beside it; spelled-out states need no key, and a
      // terminal too narrow for the whole key gets the badges alone rather than half a legend.
      legend={state.screen === 'workspaces' && rollupStyle === 'badges' && pickerWidth >= 40 ? ROLLUP_LEGEND : undefined}
      enabled={state.online && !state.busy && !input}
      canSelect={() => !controller.composer.draft && controller.state.online && !controller.state.busy} /> : <>
      {thoughtList && <ThoughtsDialog identity={`thoughts:${state.sessionId}`} options={thoughtOptions} empty={!thoughtEntries?.length && !liveThought}
        rows={stdout.rows ?? 30} enabled={!input && !state.busy} canSelect={() => !controller.composer.draft && !controller.state.busy} />}
      {state.screen === 'chat' && historyQuery !== undefined && <HistoryDialog identity={`history:${historyQuery}`}
        contentSearch={contentSearch} matches={historyMatches} query={historyQuery} messages={layout.messages} width={width}
        enabled={!input && !state.busy} canSelect={() => !controller.composer.draft && !controller.state.busy}
        onJump={seq => operate(() => jumpHistory(seq))}
        onClose={() => controller.setHistoryPanel(undefined)} />}
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
            ? '↑ ↓ move · Space / 1–9 toggle · Enter confirm · Esc dismisses' : '↑ ↓ / 1–9 select · Enter confirm · Esc dismisses'}</Text>
        </Box>}
        <Text dimColor>{question ? options.length > 0
          ? 'Choose "Other answer" to type · the draft is kept while this is open'
          : 'Esc dismisses the question · the draft is kept while this is open'
          : 'Esc keeps this pending · the draft is kept while this is open'}</Text>
      </Box>}
    </>}
        </Box>
        {!queueOpen && !pending && state.screen === 'chat' && queued.length > 0 && <QueuedPreview queued={queued} width={width} />}
        <TextInput value={input} onChange={setInput} onCursorChange={cursor => controller.setComposerCursor(cursor)} onSubmit={() => { void submit(controller.composer.draft); }}
          reservedKeys={approvalKeysActive ? ['1','2','3'] : queueOpen && !pending ? ['d'] : questionKeysActive ? ['1','2','3','4','5','6','7','8','9', ...(question?.multiSelect === true ? [' '] : [])] : !removal && !models && !searchResults && (state.screen === 'workspaces' || state.screen === 'sessions') ? ['d'] : undefined}
          width={draftWidth} maxRows={composerRows} promptColor={answerPending ? theme.colors.muted : theme.accent}
          focus={state.online && !state.busy && !copyMode && !answerPending} placeholder={state.screen === 'path' ? 'Absolute directory path on host' : 'Message, @host-file, or /help'} />
      {referenceOpen && <ReferenceMenu matches={matches} index={referenceIndex} />}
      </Box>
      {commandSuggestions && <Text dimColor>{commandSuggestions.join('  ')}</Text>}
      {help && <HelpPanel page={currentHelpPage} pages={helpPages} pageSize={helpPageSize} />}
      {costExpanded && <CostPanel controller={controller} />}
      <Frozen frozen={statusFrozen} identity={`${width}:${state.sessionId}:${statusExpanded}:${statusScroll}:${pauseReason ?? ''}`}><StatusBar controller={controller} width={width} expanded={statusExpanded} scroll={statusScroll} pageSize={statusViewRows} onScroll={setStatusScroll} onOverflow={setStatusOverflow} onRows={setStatusBarRows} pauseReason={pauseReason} revision={state.version} /></Frozen>
    </Box>
  </Box></Frozen></CopyMode.Provider></ThemeContext.Provider>;
}
