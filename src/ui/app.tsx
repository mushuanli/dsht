/** Ink terminal interface: startup pickers, transcript, and slash-command composer. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mocha, ThemeContext, type Theme } from './theme/index.ts';
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from 'ink';
import { useMouseWheel } from './input/mouse.ts';
import { TextInput } from './input/input.tsx';
import { useComposer, type DraftReceipt } from './input/use-composer.ts';
import { useDeferredLines } from './input/use-deferred-lines.ts';
import { useHistoryRecall } from './input/use-history-recall.ts';
import { ReferenceMenu } from './input/references.tsx';
import type { CommandResult, HistoryRow, PanelName, Reasoning, ViewEffect } from '../contracts.ts';
import type { CostTotal } from '../contracts.ts';
import { costText } from './status/model.ts';
import { toolLine } from '../text.ts';
import { activeReference, fileMention } from '../references.ts';
import type { FileReference } from '../contracts.ts';
import { CostPanel, type CostSource } from './dialogs/cost.tsx';
import { StatusBar, type StatusSource } from './chat/status.tsx';
import { ChatHeader } from './chat/header.tsx';
import { LoopStatus } from './chat/loop-status.tsx';
import { ChatViewport } from './chat/viewport.tsx';
import { plainRows } from './chat/shell-view.ts';
import { useHistoryView } from './chat/use-history-view.ts';
import { Frozen } from './frozen.tsx';
import { CopyMode } from './copy-mode.ts';
import type { Choice } from './dialogs/picker.tsx';
import { HelpPanel, HistoryDialog, ModelDialog, PickerScreen, PromptsDialog, QueueDialog, QueuedPreview, RemovalDialog, SearchResultsDialog, ThoughtsDialog } from './dialogs/index.tsx';
import { LoopDialog, LoopMenu, type LoopRun } from './dialogs/loop.tsx';
import { usePanels } from './dialogs/use-panels.ts';
import { PeekPanel } from './dialogs/peek.tsx';
import { COMMAND_HINTS, argumentHint, completeCommand as completeDraft, suggestedCommands } from '../slash/registry.ts';
import { interpret, normalize, authorize, type DeferReason, type LineCommand, type Verdict } from '../slash/index.ts';
import { loopNameQuery } from '../slash/parse.ts';
import { Controller, type HistorySearch } from '../controller/controller.ts';
import { removalIntent, runCommand, type CommandPort } from '../controller/commands.ts';
import { sessionLabel } from '../session-title.ts';
import { ROLLUP_LEGEND, sessionStatus, workspaceCounts, workspaceDetail, workspaceSegments, workspaceStatus, type RollupState, type RollupStyle } from './chat/navigation-model.ts';
import { array, object, string, type ObjectValue } from '../json.ts';
import { errorText } from '../text.ts';
import { safeText } from '../text.ts';

/** Transient notices expire; interactive panels remain open until dismissed. */
const PANEL_LIFETIME_MS = 10_000;

/** No folds: the read-only view has no expand state of its own, and one empty set keeps layout cached. */
const NO_FOLDS: ReadonlySet<number> = new Set();

/** Rows one PgUp/PgDn moves in the read-only view. */
const PEEK_PAGE = 10;

/** How long a Ctrl+C that could not exit stays armed to exit on the next press. */
const FORCE_EXIT_MS = 5000;

/** The caller owns starting and stopping the controller around the Ink render lifetime.
 * @param props - Controller, panel lifetime and semantic theme.
 * @returns The rendered terminal interface.
 */
export function App({ controller, panelLifetimeMs = PANEL_LIFETIME_MS, theme = mocha }: { controller: Controller; panelLifetimeMs?: number; theme?: Theme }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const presetId = controller.queries.telemetry.view(state.sessionId).values.agentPreset;
  useEffect(() => { if (typeof presetId === 'string') controller.actions.loadPresetNames(); }, [controller, state.online, presetId]);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [copyMode, setCopyMode] = useState(false);
  const historyWindow = state.session.window;
  /** The operation the controller owns right now; the front end only renders it. */
  const foreground = controller.queries.foreground;
  const displayTranscript = historyWindow ?? state.session.record;
  const conversationBox = useRef<DOMElement>(null);
  const [conversationRows, setConversationRows] = useState(20);
  useLayoutEffect(() => {
    if (conversationBox.current) {
      const height = Math.floor(measureElement(conversationBox.current).height);
      if (height !== conversationRows) setConversationRows(height);
    }
  });
  const panelState = usePanels({ sessionId: state.sessionId, pendingId: state.pending[0]?.eventId,
    peekOpen: controller.queries.peek !== undefined, closePeek: () => controller.actions.closePeek() });
  const { openThoughts, openQueue, openPrompts, setModelPanel, setHistoryPanel, setSearchPanel,
    setRemoval, setLoopForm, setHelp, setCostExpanded, setStatusExpanded } = panelState;
  const { thoughts: thoughtList, queue: queueOpen, model: models, history, search: searchResults,
    prompts: promptsOpen, removal, loop: loopForm, help, cost: costExpanded, status: statusExpanded } = panelState.state;
  const historyQuery = history?.query;
  const contentSearch = history?.contentSearch === true;
  const historyMatches = history?.matches;
  const reasoning: Reasoning = 'row';
  const [notice, setNotice] = useState<string>();
  const composer = useComposer({
    sessionId: state.sessionId,
    currentSession: () => controller.snapshot().sessionId,
    resetRecall: () => controller.actions.resetRecall(),
    messageStarted: () => { if (controller.snapshot().screen === 'chat') setScroll(0); },
    notify: setNotice,
  });
  const { input, cursor, intent: composerIntent, setInput, setCursor, setIntent: setComposerIntent } = composer;
  const recallOlderPrompts = useHistoryRecall({
    source: state.session.record, draft: input,
    capture: composer.capture, restore: composer.recallIfCurrent,
    previous: draft => controller.queries.recall(-1, draft),
    refill: () => controller.actions.refillRecall(),
    hasPrevious: () => controller.queries.recallLength > 0 && !controller.queries.recallAtOldest,
    older: (signal, source) => controller.actions.older(signal, source),
    run: work => controller.actions.foreground('history', 'Loading older prompts…', work),
    notify: setNotice,
  });
  const [helpPage, setHelpPage] = useState(0);
  const helpPageSize = Math.max(1, (stdout.rows ?? 30) - 12);
  const helpPages = Math.ceil(COMMAND_HINTS.length / helpPageSize);
  const currentHelpPage = Math.min(helpPage, helpPages - 1);
  const [statusScroll, setStatusScroll] = useState(0);
  /** When the last Ctrl+C that could not exit was armed, so the next one leaves regardless. */
  const exitArmed = useRef(0);
  const [statusOverflow, setStatusOverflow] = useState(false);
  // The panel owns two border rows and a one-row footer, and the two header rows and the
  // three-row composer above it never shrink, so only the remainder of the screen height shows rows.
  const [statusBarRows, setStatusBarRows] = useState(1);
  const statusViewRows = Math.max(1, (stdout.rows ?? 30) - 9 - (statusBarRows - 1));
  // Answers and menu highlights are session-owned too: the waterfall itself is derived per session
  // by the controller, so only the local selection is kept here.
  const { answers, option: optionState, approval: approvalSelection } = state.session.interaction;
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [dismissedReference, setDismissedReference] = useState<string>();
  // The `/loop` record list under the composer: which row is highlighted, and the draft Esc dismissed
  // it for, so the next keystroke brings it back instead of it staying gone.
  const [loopMenuIndex, setLoopMenuIndex] = useState(0);
  const [dismissedLoopMenu, setDismissedLoopMenu] = useState<string>();
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
    const timer = setTimeout(() => { setHistoryPanel(undefined); }, panelLifetimeMs);
    return () => clearTimeout(timer);
  }, [historyQuery, contentSearch, panelLifetimeMs, copyMode]);
  const pending = state.pending[0];
  // The loop lives in the application; the UI only renders its progress snapshot.
  const loop = controller.queries.loop;
  // The record the open form edits, read from the same list the runner uses.
  const loopRecord = loopForm === undefined ? undefined
    : controller.queries.loopRecords.find(record => record.name === loopForm.name);
  const queued = controller.queries.telemetry.pending(state.sessionId).filter(item => item.placement !== 'context');
  // The read-only view: the application owns which source is followed and what it holds, the front end
  // owns only the reader's position in it.
  const peek = controller.queries.peek;
  const [peekScroll, setPeekScroll] = useState(0);
  const peekBox = useRef<DOMElement>(null);
  const [peekRows, setPeekRows] = useState(20);
  // The rows above the transcript are measured, not guessed: a click is placed by counting down from
  // the first line, and the header and the connection/foreground notices are what stand above it.
  const headerSection = useRef<DOMElement>(null);
  const bodyPrefix = useRef<DOMElement>(null);
  const [chromeRows, setChromeRows] = useState({ header: 2, prefix: 0 });
  useLayoutEffect(() => {
    if (peekBox.current) {
      const height = Math.floor(measureElement(peekBox.current).height);
      if (height !== peekRows) setPeekRows(height);
    }
  });
  // A new source is a new document: it opens at its newest row rather than wherever the last one was.
  useEffect(() => { setPeekScroll(0); }, [peek?.source.id]);
  useLayoutEffect(() => {
    const header = headerSection.current ? Math.floor(measureElement(headerSection.current).height) : 0;
    const prefix = bodyPrefix.current ? Math.floor(measureElement(bodyPrefix.current).height) : 0;
    if (header !== chromeRows.header || prefix !== chromeRows.prefix) setChromeRows({ header, prefix });
  });
  useEffect(() => {
    setReferenceIndex(0); setDismissedReference(undefined);
    setLoopMenuIndex(0); setDismissedLoopMenu(undefined);
  }, [state.sessionId]);
  // A replayed interaction (same eventId after a reconnect) starts unselected again.
  useEffect(() => { controller.actions.setApproval(undefined); }, [state.sessionId, state.online, pending?.eventId]);
  const token = state.screen === 'chat' && state.online && foreground === undefined && !pending
    && !input.startsWith('/') && dismissedReference !== input && cursor === input.length
    ? activeReference(input) : undefined;
  const referenceOpen = token !== undefined;
  // `/loop` offers its records while the draft is still a name: the composer menu is the one place a
  // name can be chosen, and every row carries the defaults the form would open with. Once a second
  // word (a flag or value) is typed the operator has decided, so the menu steps aside. The candidates
  // survive a dismissal, because Esc only hides the list — it does not withdraw the choice.
  const loopDraft = state.screen === 'chat' && state.online && foreground === undefined && !pending
    && !copyMode && !referenceOpen ? loopNameQuery(input) : undefined;
  const loopCandidates = loopDraft === undefined ? []
    : controller.queries.loopRecords.filter(record => record.name.startsWith(loopDraft));
  const loopMenuOpen = loopCandidates.length > 0 && loopForm === undefined && dismissedLoopMenu !== input;
  const loopMenuCursor = Math.min(loopMenuIndex, Math.max(0, loopCandidates.length - 1));
  const { openSurfaces, reservedKeys: surfaceReservedKeys } = panelState;
  const dialogOpen = !!(openSurfaces.length || pending || referenceOpen || state.screen !== 'chat');
  const displayPaused = copyMode || dialogOpen;
  // Startup screens need live connection feedback even while their picker remains open.
  const statusPaused = copyMode || (state.screen === 'chat' && dialogOpen);
  const matches = referenceOpen && lookup?.draft === input && lookup.sessionId === state.sessionId ? lookup : undefined;
  useEffect(() => {
    if (!referenceOpen) return;
    const abort = new AbortController();
    setLookup(undefined);
    setReferenceIndex(0);
    void controller.queries.references(activeReference(input)!.query, abort.signal).then(items => {
      if (!abort.signal.aborted) setLookup({ draft: input, sessionId: state.sessionId!, items });
    }, error => {
      if (!abort.signal.aborted) setLookup({ draft: input, sessionId: state.sessionId!, items: [], error: errorText(error) });
    });
    return () => abort.abort();
  }, [controller, input, state.sessionId, referenceOpen]);
  const pickReference = () => {
    const candidate = matches?.items[referenceIndex];
    if (!candidate || !token) return;
    const mention = fileMention(candidate, token.quoted)!;
    setInput(input.slice(0, -token.prefix.length) + mention + (candidate.kind === 'file' ? ' ' : ''));
  };
  /** Complete the leading slash command; an ambiguous draft extends to the shared prefix. */
  const completeCommand = () => {
    const completed = completeDraft(input);
    if (completed !== undefined) setInput(completed);
  };
  const questions = pending?.kind === 'question' ? pending.questions : [];
  const eventId = pending?.eventId ?? '';
  const answered = answers[eventId] ?? [];
  const question = questions[answered.length];
  const optionKey = `${eventId}:${answered.length}`;
  const options: readonly { label: string; description?: string }[] = question ? question.options : [];
  const choiceState = optionState?.key === optionKey ? optionState : { key: optionKey, cursor: 0, selected: [], custom: false };
  const optionCursor = Math.min(choiceState.cursor, options.length);
  // Reserve the header, composer and question instructions; each choice may have a description.
  const optionPageSize = Math.max(1, Math.min(6, Math.floor(((stdout.rows ?? 30) - 16) / 2)));
  const optionStart = Math.max(0, optionCursor - optionPageSize + 1);
  // One open surface owns the arrow and digit keys; the picker screens and the composer are not
  // keyboard owners. The traits live in `surfaces`, so no panel is named here.
  const panelBlocksKeys = openSurfaces.some(surface => surface.blocksKeys);
  // Composer recall yields only to a surface that uses the arrows itself: the pickers, and a status
  // panel with more lines than the view holds. The help and cost panels and a fitting status panel
  // leave the arrows with the history, and Ctrl+P/N reach it from every surface.
  const recallBlocked = openSurfaces.some(surface => surface.arrows) || (statusExpanded && statusOverflow) || composerIntent !== undefined;
  const questionKeysActive = !!question && options.length > 0 && !choiceState.custom && !copyMode && !panelBlocksKeys;
  // A dialog that demands an answer owns the keyboard until it is settled: the draft being written is
  // parked rather than typed into, and comes back when the last one closes. A question switches to
  // the composer itself for a free-text or "Other" answer, so it keeps the keys then.
  const answerPending = !!pending && (pending.kind === 'approval' || options.length > 0 && !choiceState.custom);
  useEffect(() => {
    composer.interactionChanged(answerPending, pending !== undefined);
  }, [answerPending, pending]);
  const approvalKeysActive = pending?.kind === 'approval' && !copyMode && !panelBlocksKeys;
  const approvalIndex = approvalSelection?.eventId === eventId ? approvalSelection.index : -1;
  // Actions own their busy/error envelope; this only surfaces a UI-local orchestration failure.
  const operate = (fn: () => Promise<unknown>) => { void fn().catch(error => setNotice(errorText(error))); };
  /** Resolve and apply a removal; shared by the pickers' `d` key and the delete commands. */
  async function requestRemoval(kind: 'workspace' | 'session', query: string): Promise<boolean> {
    const effects = await removalIntent(controller, kind, query);
    if (effects === undefined) return false;
    for (const effect of effects) await applyEffect(effect);
    return true;
  }
  /** Run one record with the values the form confirmed.
   *
   * The line is handed back to the application as a parsed command, so the form and a typed command
   * start a run through exactly the same path and cannot disagree about what the values mean.
   * @param name - Record key to run.
   * @param run - The four limits and the record variables as the form left them.
   */
  function startLoopFromForm(name: string, run: LoopRun): void {
    controller.traceNote('loop-ui', { phase: 'start', name, from: run.limits.from, to: run.limits.to,
      score: run.limits.score, tries: run.limits.tries, vars: Object.keys(run.vars) });
    operate(async () => {
      const port: CommandPort = { interactive: true, run: (label, operation) => controller.actions.foreground('command', label, operation) };
      // Start is a second submission (§3.4): the form may have been open while a turn started or a
      // question arrived, so the line is authorized again here rather than trusting the earlier one.
      const verdict = verdictFor({ kind: 'loop', name, options: { ...run.limits, vars: run.vars } });
      // A turn that started while the form was open holds the run: the values are confirmed, so the
      // line is queued and the form closes, exactly like a refusal keeps it open.
      if (holdIfDeferred(verdict, `/loop ${name}`)) { setLoopForm(undefined); return; }
      const result = await runCommand(controller, verdict.allow ? verdict.command : verdict.error, port);
      // A rejected result carries its own error and keeps the form open; only a missing one would leave
      // Start looking ignored, so it says the same thing here.
      if (result === undefined) {
        setNotice(`Loop did not start: ${controller.state.lastFailure || 'the host did not accept the request'}`);
        return;
      }
      await applyResult(result);
      if (result.disposition === 'consume') setLoopForm(undefined);
    });
  }
  useInput((_value, key) => {
    if (key.eventType === 'release') return;
    if (copyMode) {
      if (key.escape || key.ctrl && (_value === 's' || _value === 'c')) setCopyMode(false);
      return;
    }
    // The loop form owns every key but Ctrl+C: it reads them itself, and leaving them to this handler
    // would let a digit meant for a value start a composer draft or a recall step.
    if (loopForm && !(key.ctrl && _value === 'c')) return;
    if (key.ctrl && _value === 's') { setCopyMode(true); return; }
    // Esc is a table, not a chain (§5.4): the first rule whose condition holds wins. A table is what
    // keeps a new surface from either shipping with no Escape rule or placing one after the fallback,
    // where it can never run — the two mistakes this replaces.
    const escapeRules: { when: boolean; run: () => void }[] = [
      // 1 Copy mode is handled above: it owns the keyboard outright.
      // 2 A borrowed composer drops the edit and the draft it loaded.
      { when: composerIntent !== undefined, run: () => { setInput(''); setComposerIntent(undefined); } },
      // 3 A cancellable load in flight is the most urgent thing Esc can stop.
      { when: foreground !== undefined, run: () => {
        controller.actions.cancelForeground();
        // Esc also leaves a history list that was already on screen when the load was aborted.
        if (historyQuery !== undefined) setHistoryPanel(undefined);
      } },
      // 4 The read-only view sits on top of the conversation it was opened from.
      { when: peek !== undefined, run: () => controller.actions.closePeek() },
      // 5 An approval or a question owns the keyboard until it is settled.
      { when: pending !== undefined, run: () => {
        controller.actions.setApproval(undefined);
        setRemoval(undefined); setModelPanel(undefined); openThoughts(false); setSearchPanel(undefined);
        setHistoryPanel(undefined); setHelp(false); setCostExpanded(false); setStatusExpanded(false);
        // A question batch is one request, so Esc leaves the whole set the way the Web client's close
        // button does. The free-text row keeps its own step back: its first Esc returns to the options,
        // and only the next one dismisses. Approval keeps every choice explicit.
        if (pending?.kind === 'question' && !choiceState.custom) {
          if (controller.state.online && controller.queries.foreground === undefined && controller.state.pending[0]?.eventId === eventId) {
            controller.actions.setOption(undefined);
            const rest = { ...controller.queries.interaction.answers }; delete rest[eventId]; controller.actions.setAnswers(rest);
            operate(() => controller.actions.dismissQuestion());
          }
          return;
        }
        controller.actions.setOption({ ...choiceState, custom: false });
      } },
      // 6 The panels a command opened.
      { when: queueOpen === true, run: () => openQueue(false) },
      { when: promptsOpen === true, run: () => openPrompts(false) },
      { when: removal !== undefined, run: () => setRemoval(undefined) },
      { when: models !== undefined, run: () => setModelPanel(undefined) },
      { when: thoughtList === true, run: () => { openThoughts(false); if (controller.queries.running) void controller.actions.interrupt(true); } },
      { when: searchResults !== undefined, run: () => { setSearchPanel(undefined); if (controller.queries.running) void controller.actions.interrupt(true); } },
      { when: historyQuery !== undefined, run: () => { setHistoryPanel(undefined); if (controller.queries.running) void controller.actions.interrupt(true); } },
      // 7 Screens. The typed host path is one of them: the picker behind it is disabled while a draft
      // exists, so a leftover path would leave no way back at all.
      { when: state.screen === 'path', run: () => { setInput(''); operate(() => controller.actions.showPicker('workspaces')); } },
      // A picker opened over a conversation is a detour, so Esc returns to that conversation; from the
      // session list with nothing selected it steps back to the workspace list instead, which is the
      // only thing behind the startup picker.
      { when: state.screen === 'sessions', run: () => { if (!controller.actions.showChat()) operate(() => controller.actions.showPicker('workspaces')); } },
      { when: state.screen === 'workspaces', run: () => { controller.actions.showChat(); } },
      // 8 The composer's own menus: hiding one never undoes the choice it was offering.
      { when: loopMenuOpen === true, run: () => setDismissedLoopMenu(input) },
      { when: referenceOpen === true, run: () => { setDismissedReference(input); if (controller.queries.running) void controller.actions.interrupt(true); } },
      // 9 The read-only surfaces.
      { when: help || costExpanded || statusExpanded || notice !== undefined, run: () => {
        setHelp(false); setCostExpanded(false); setStatusExpanded(false); setStatusScroll(0); setNotice(undefined);
        if (controller.queries.running) void controller.actions.interrupt(true);
      } },
      // 10 A local command in the transcript is more immediate than the agent behind it.
      { when: state.shell.running && input === '' && !panelBlocksKeys && pending === undefined && state.screen === 'chat',
        run: () => controller.shell.cancel() },
      // 11 Anything left on the conversation screen cancels whatever the agent is doing.
      { when: state.screen === 'chat', run: () => { void controller.actions.interrupt(true); } },
    ];
    if (key.escape) {
      const rule = escapeRules.find(candidate => candidate.when);
      if (rule !== undefined) { rule.run(); return; }
    }
    // The read-only view owns the arrows and paging: it is a document the reader scrolls, so its keys
    // must not fall through to prompt recall or to the conversation behind it.
    if (peek !== undefined && !key.ctrl && !key.meta) {
      if (key.pageUp) { setPeekScroll(value => value + PEEK_PAGE); return; }
      if (key.pageDown) { setPeekScroll(value => Math.max(0, value - PEEK_PAGE)); return; }
      if (key.upArrow) { setPeekScroll(value => value + 1); return; }
      if (key.downArrow) { setPeekScroll(value => Math.max(0, value - 1)); return; }
    }
    // Ctrl+O opens the read-only view on the newest source — the work most likely worth watching — so
    // the view is reachable without a list. Clicking a transcript row opens a specific source.
    if (key.ctrl && _value === 'o' && state.screen === 'chat' && pending === undefined) {
      const source = controller.queries.sources[0];
      if (source !== undefined) controller.actions.openPeek(source.id);
      return;
    }
    // Ctrl+C is not Esc: it never dismisses a dialog, and when nothing is pending it stops the agent
    // and then exits. The branches below keep that order.
    if (key.ctrl && _value === 'c') {
      // Every branch below can fail to end the client: the host may never report the turn idle, an
      // operation may ignore the abort, an interaction may be waiting. A press that could not exit
      // arms the next one, so no state can trap the reader. Leaving still asks the host to stop the
      // selected turn, because every exit path runs `Controller.shutdown`.
      if (exitArmed.current !== 0 && Date.now() - exitArmed.current < FORCE_EXIT_MS) {
        exitArmed.current = 0;
        exit();
        return;
      }
      exitArmed.current = 0;
      /** Arm the escape after a press that asked for something and did not get to leave. */
      const offerExit = () => {
        exitArmed.current = Date.now();
        setNotice('Press Ctrl+C again to exit without waiting for the host');
      };
      if (controller.queries.foreground !== undefined) { controller.actions.cancelForeground(); offerExit(); return; }
      if (controller.state.pending.length) { if (input) setInput(''); offerExit(); return; }
      if (input === '' && state.shell.running) { controller.shell.cancel(); return; }
      // A draft clears first, exactly like a shell prompt; an empty draft still stops or exits.
      if (input !== '') { setInput(''); return; }
      if (composerIntent) { setComposerIntent(undefined); return; }
      void controller.actions.interrupt().then(shouldExit => { if (shouldExit) exit(); else offerExit(); });
      return;
    }
    if (approvalKeysActive && !input && controller.state.online && controller.queries.foreground === undefined
      && controller.state.pending[0]?.eventId === eventId && !key.ctrl && !key.meta) {
      const digit = /^[1-3]$/.test(_value) ? Number(_value) - 1 : -1;
      if (digit >= 0 || key.upArrow || key.downArrow) {
        // An unselected list enters at the first, non-destructive choice, so a stray arrow plus Enter cannot cancel.
        const index = digit >= 0 ? digit : approvalIndex < 0 ? 0
          : Math.max(0, Math.min(2, approvalIndex + (key.upArrow ? -1 : 1)));
        controller.actions.setApproval({ eventId, index }); return;
      }
      if (key.return) {
        // Choice 3 cancels the turn instead of answering the request, so it sends no event result.
        if (approvalIndex >= 0) operate(() => approvalIndex === 2 ? controller.actions.cancelTurn() : controller.actions.approve(approvalIndex === 0));
        return;
      }
    }
    if (questionKeysActive && !input && controller.queries.foreground === undefined && !key.ctrl && !key.meta) {
      const digit = /^[1-9]$/.test(_value) ? Number(_value) - 1 : -1;
      if (key.upArrow || key.downArrow) {
        controller.actions.setOption({ ...choiceState, cursor: Math.max(0, Math.min(options.length, optionCursor + (key.upArrow ? -1 : 1))) }); return;
      }
      if (digit >= 0 && digit <= options.length || _value === ' ' && question!.multiSelect === true && optionCursor < options.length) {
        const index = digit >= 0 ? digit : optionCursor;
        const label = index < options.length ? string(options[index]!.label) : undefined;
        const selected = question!.multiSelect === true && label
          ? choiceState.selected.includes(label) ? choiceState.selected.filter(item => item !== label) : [...choiceState.selected, label]
          : choiceState.selected;
        controller.actions.setOption({ ...choiceState, cursor: index, selected }); return;
      }
      if (key.return) {
        if (optionCursor === options.length) { controller.actions.setOption({ ...choiceState, custom: true }); return; }
        const selected = question!.multiSelect === true ? choiceState.selected : [string(options[optionCursor]!.label)];
        if (!selected.length) { setNotice('Select at least one option with Space or a number'); return; }
        operate(() => controller.actions.answerQuestion({ selected })); return;
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
    if (loopMenuOpen) {
      if (key.tab) {
        const chosen = loopCandidates[loopMenuCursor];
        if (chosen !== undefined) setInput(`/loop ${chosen.name}`);
        return;
      }
      if (key.upArrow) { setLoopMenuIndex(Math.max(0, loopMenuCursor - 1)); return; }
      if (key.downArrow) { setLoopMenuIndex(Math.min(loopCandidates.length - 1, loopMenuCursor + 1)); return; }
    }
    if (referenceOpen) {
      if (key.tab) pickReference();
      else if (key.upArrow) setReferenceIndex(Math.max(0, referenceIndex - 1));
      else if (key.downArrow) setReferenceIndex(Math.max(0, Math.min((matches?.items.length ?? 1) - 1, referenceIndex + 1)));
      return;
    }
    const recallPrevious = key.upArrow || key.ctrl && _value === 'p';
    const recallNext = key.downArrow || key.ctrl && _value === 'n';
    if ((recallPrevious || recallNext) && state.online && controller.queries.foreground === undefined && !pending
      && !queueOpen && (!recallBlocked || key.ctrl)
      && (state.screen === 'chat' || input !== '' || key.ctrl)) {
      // The oldest seeded entry is where the session happened to open, not where it began: stepping
      // past it fetches the page before the retained window, and the step is applied once the page
      // lands, so recall covers prompts from before this client connected. Paging stays with the
      // conversation: on a picker screen the arrows only ever walked what was already retained.
      if (recallPrevious && state.screen === 'chat'
        && (controller.queries.recallAtOldest || controller.queries.recallLength === 0)
        && state.session.record.ready && controller.queries.recallHasOlder) { void recallOlderPrompts(); return; }
      setInput(controller.queries.recall(recallPrevious ? -1 : 1, input), true); return;
    }
    if (key.tab && !composerIntent) { completeCommand(); return; }
  });

  /** The application facts `normalize`/`authorize` read, read in one place.
   *
   * Every submission uses these — the composer's line and the loop form's Start — so a command cannot
   * pass one door and not the other (§3.4: authorize is per submission, not per user action).
   */
  function applicationFacts() {
    const current = controller.snapshot();
    return {
      sessionId: current.sessionId,
      ready: current.online && controller.queries.connectionSettled && (current.sessionId === undefined || controller.queries.record.ready),
      sessionSelected: current.sessionId !== undefined,
      pending: current.pending.length > 0,
      foreground: controller.queries.foreground !== undefined,
      // A loop is reported as such because stopping it is what the refusal has to name.
      during: controller.queries.loop?.active === true ? 'loop' as const
        : controller.queries.running ? 'turn' as const : 'idle' as const,
    };
  }

  const deferredLines = useDeferredLines({ facts: applicationFacts, run: command => runLine(command), notify: setNotice });

  /** What a held line is waiting for, in the words the notice uses. */
  function describeDefer(defer: DeferReason): string {
    return defer === 'busy' ? 'the running operation finishes' : defer === 'loop' ? 'the loop ends' : 'the turn finishes';
  }

  /** Hold one accepted-but-deferred line, and say whether it was deferred.
   *
   * A deferred line is the operator's committed submission, not a draft, so the caller is free to use
   * up its draft; the queue runs it when the fact it named clears.
   * @param verdict - What `authorize` said about the line.
   * @param label - Text the notice shows.
   * @returns True when the line was queued instead of running now.
   */
  function holdIfDeferred(verdict: Verdict, label: string): boolean {
    if (!verdict.allow || verdict.defer === undefined) return false;
    const defer = verdict.defer;
    controller.traceNote('command', { phase: 'queued', kind: verdict.command.kind, reason: defer });
    deferredLines.enqueue(verdict.command, defer);
    setNotice(`Queued ${label} · runs when ${describeDefer(verdict.defer)}`);
    return true;
  }

  /** Authorize one already-normalized line against the facts as they are *now*. */
  function verdictFor(command: LineCommand) {
    const facts = applicationFacts();
    return authorize(command, { sessionSelected: facts.sessionSelected, pending: facts.pending,
      during: facts.during, foreground: facts.foreground });
  }

  const submit = async (raw: string) => {
    const receipt = composer.capture();
    // A borrowed composer commits on Enter instead of sending, so an edit is never delivered.
    if (composerIntent) {
      await composer.commit(raw);
      return;
    }
    // A composer menu completes the draft before it is submitted: Enter on the record list accepts the
    // highlighted record exactly as if its name had been typed, so even that decision belongs to the
    // pipeline below — the application still says whether a bare known name opens its form.
    const highlighted = loopDraft !== undefined && loopForm === undefined ? loopCandidates[loopMenuCursor] : undefined;
    if (highlighted !== undefined) {
      controller.traceNote('loop-ui', { phase: 'choose', draft: loopDraft ?? '', index: loopMenuCursor,
        candidates: loopCandidates.length, chosen: highlighted.name });
    }
    const line = highlighted === undefined ? raw : `/loop ${highlighted.name}`;
    // The pipeline decides what the line means; the root only carries out the three stages' results.
    const submission = interpret({ line, referenceOpen, copyMode, screen: state.screen });
    if (submission.kind === 'mode') {
      if (submission.action.kind === 'ignore') return;
      pickReference(); return;
    }
    const facts = applicationFacts();
    const command = normalize(submission, { sessionSelected: facts.sessionSelected, question: question !== undefined, pending: facts.pending });
    // One line completes before the next may start: `authorize` refuses a second submission while the
    // foreground slot is taken, with a reason the operator can read, and admits a control command
    // through (its whole purpose is to interrupt whatever owns the slot).
    const verdict = verdictFor(command);
    // A line the policy holds runs when the fact it named clears (A2). It is accepted here — the
    // operator pressed Enter, so the draft is used up — and the queue below runs it later; a line that
    // was *refused* keeps the draft and is never sent on the operator's behalf (D1).
    if (holdIfDeferred(verdict, line.trim())) { setInput(''); return; }
    const executable = verdict.allow ? verdict.command : verdict.error;
    const value = line.trim();
    if (!pending && !/^\/feedback(?:\s|$)/.test(value)) controller.actions.recordRecall(value);
    await runLine(executable, receipt);
  };

  /** Run one authorized line under the UI's port and apply what it returns.
   *
   * `draft` identifies the draft to clear when the line is consumed; a line the UI runs from its own
   * queue passes none, because that draft was used up when the operator submitted it.
   */
  async function runLine(executable: LineCommand, draft?: DraftReceipt): Promise<void> {
    // The application decides what the command does and returns the effects; the UI applies them in
    // order. The port says a surface can be shown, which is what lets `/loop <name>` confirm defaults.
    const port: CommandPort = { interactive: true, run: (label, operation) => controller.actions.foreground('command', label, operation) };
    try {
      const result = await runCommand(controller, executable, port);
      if (result === undefined) return;
      await applyResult(result);
      // Consuming the line is the application's decision, so the composer never guesses it. Only the
      // line that was submitted is cleared: the operation may have taken long enough for the operator
      // to write the next one (D1), and that draft is theirs, not this result's to discard.
      if (result.disposition === 'consume' && draft !== undefined) composer.consume(draft);
    } catch (error) { setNotice(errorText(error)); }
  }

  /** Apply one command result: its effects in the order the application emitted them.
   *
   * This is the whole front-end half of a command — the UI names no command here and never reorders.
   * @param result - What the application did and what should be shown.
   */
  async function applyResult(result: CommandResult): Promise<void> {
    // `closePanels` must know which panel this result keeps, and the contract puts it first, so the
    // kept panel is read from the whole list before any effect runs.
    const keep = result.effects.find(effect => effect.kind === 'open' || effect.kind === 'toggle');
    const keepPanel = keep?.kind === 'open' || keep?.kind === 'toggle' ? keep.panel : undefined;
    for (const effect of result.effects) await applyEffect(effect, keepPanel);
  }

  /** Apply one presentational verb. */
  async function applyEffect(effect: ViewEffect, keepPanel?: PanelName): Promise<void> {
    switch (effect.kind) {
      case 'quit': exit(); return;
      case 'copy': setCopyMode(true); return;
      case 'closePanels': panelState.closeExcept(keepPanel); return;
      case 'close': panelState.close(effect.panel); return;
      case 'open':
        if (effect.panel === 'queue') openQueue(true);
        else if (effect.panel === 'prompts') openPrompts(true);
        else if (effect.panel === 'thoughts') openThoughts(true);
        return;
      case 'toggle':
        if (effect.panel === 'help') { setHelp(value => !value); setHelpPage(0); }
        else if (effect.panel === 'cost') setCostExpanded(value => !value);
        else if (effect.panel === 'status') { setStatusExpanded(value => !value); setStatusScroll(0); }
        return;
      case 'history': setHistoryPanel(effect.history); return;
      case 'search': setSearchPanel(effect.search); return;
      case 'model': setModelPanel(effect.model); return;
      case 'removal': setRemoval(effect.removal); return;
      case 'loop': {
        // The application validated the record before asking for the form, so the UI only records that
        // the request arrived and renders it.
        const known = controller.queries.loopRecords.some(record => record.name === effect.loop.name);
        controller.traceNote('loop-ui', { phase: 'open', name: effect.loop.name, known });
        setDismissedLoopMenu(undefined);
        setLoopForm({ name: effect.loop.name });
        return;
      }
      case 'live': controller.actions.showLatest(); return;
      case 'pinLive': controller.actions.pinHistory(false); return;
      case 'resetFolds': setReasoningOverrides(new Set()); return;
      case 'toggleLiveReasoning': setLiveReasoning(liveReasoning === 'row' ? 'full' : 'row'); return;
      case 'toggleFold': {
        const next = new Set(reasoningOverrides);
        if (next.delete(effect.seq)) setReasoningOverrides(next);
        else { next.add(effect.seq); setReasoningOverrides(next); await jumpHistory(effect.seq); }
        return;
      }
      case 'scroll': setScroll(effect.position); return;
      case 'scrollBy': setScroll(current => current + effect.delta); return;
      case 'notice': setNotice(effect.text); return;
      case 'error': setNotice(effect.text); return;
    }
  }


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
  const pendingCounts = controller.queries.pendingCounts();
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
        action: () => controller.actions.pickWorkspace(string(workspace.workspaceId)) };
    }),
    { key: '@all', label: 'All sessions', action: () => operate(() => controller.actions.switchSession('all')) },
    // The directory this client runs in is the one case where no path has to be typed, and offering
    // it only while the host has not registered it keeps the row from repeating itself.
    ...(state.workspaces.some(workspace => string(workspace.path) === controller.localDirectory) ? []
      : [{ key: '@here', label: `+ Add workspace (this directory)  ${controller.localDirectory}`,
        action: () => operate(() => controller.actions.createWorkspace(controller.localDirectory)) }]),
    { key: '@new', label: '+ Add workspace (host directory)', action: () => controller.actions.enterPath() },
  ] : [
    ...(state.workspaceId && !state.showAllSessions ? [{ key: '@new', label: '+ New session', action: () => operate(() => controller.actions.createSession()) }] : []),
    ...controller.queries.visibleSessions.map(session => ({ key: string(session.sessionId),
      label: `${sessionStatus(session, listAge, isPending(session))} ${sessionLabel(session)}  ${session.sessionId}`,
      remove: () => operate(() => requestRemoval('session', string(session.sessionId))),
      action: () => { setScroll(0); operate(() => controller.actions.selectSession(string(session.sessionId))); } })),
    { key: '@back', label: '← Workspaces', action: () => operate(() => controller.actions.showPicker('workspaces')) },
  ];
  const showHistoryHint = dialogOpen || displayTranscript.hasMore || !!historyWindow;
  const historyView = useHistoryView({
    sessionId: state.sessionId, source: state.session.record, display: displayTranscript, detached: !!historyWindow,
    width, rows: conversationRows, showHint: showHistoryHint,
    protect: thoughtList || historyQuery !== undefined && !contentSearch,
    enabled: !copyMode && state.screen === 'chat', online: state.online, busy: foreground !== undefined,
    revision: state.version, blocks: state.shell.blocks,
    current: source => controller.queries.record === source && controller.snapshot().screen === 'chat',
    render: input => controller.queries.render(input),
    run: (work, label) => controller.actions.foreground('history', label, work),
    older: (signal, source) => controller.actions.older(signal, source),
    open: (target, signal) => controller.actions.openHistory(target, signal),
    pin: value => controller.actions.pinHistory(value),
    closePanels: () => { setHistoryPanel(undefined); openThoughts(false); }, notify: setNotice,
  });
  const { layout, merged, totalRows, pageSize, position, reasoningOverrides, liveReasoning,
    setScroll, setReasoningOverrides, setLiveReasoning, scrollHistory, jumpHistory, historyOperation } = historyView;
  const { length } = layout;
  // The read-only view lays out its own transcript, so its fold mode never leaks into the
  // conversation's, and a local source needs no layout at all: it already holds plain lines.
  const peekLayout = useMemo(() => peek?.transcript === undefined ? undefined
    : controller.queries.render({ transcript: peek.transcript, width, folds: NO_FOLDS, liveReasoning: 'row' }),
    [controller, peek?.transcript, peek?.transcript?.version, width]);
  const peekPlainRows = useMemo((): HistoryRow[] => peek?.lines === undefined ? []
    : peek.lines.flatMap(line => plainRows(line, width, 'shell')), [peek?.lines, width]);
  const statusNotice = !['Connected', 'Idle', 'Running…', 'Responding…'].includes(state.status);
  async function openSearchSession(sessionId: string, query: string): Promise<void> {
    await historyOperation(async signal => {
      if (!await controller.actions.selectSession(sessionId)) return;
      const record = controller.queries.record;
      const current = () => controller.snapshot().sessionId === sessionId && controller.queries.record === record
        && controller.snapshot().screen === 'chat';
      if (!current() || !await controller.actions.waitForHistory(signal)) return;
      signal.throwIfAborted();
      if (!current()) return;
      const matches = await controller.actions.searchHistory(query, signal);
      signal.throwIfAborted();
      if (!matches || !current()) return;
      setHistoryPanel({ query, contentSearch: true, matches }); setSearchPanel(undefined);
    });
  }
  const trailingGap = dialogOpen && length > 0 && layout.viewport(length - 1, length)[0]?.text === '' ? 1 : 0;
  const end = Math.max(pageSize, totalRows - position - trailingGap);
  // The first merged row the viewport shows: a short record starts at 0, a scrolled one does not, and
  // every screen line has to be translated back through this to find its row.
  const visibleStart = Math.max(0, end - pageSize);
  const visible = useMemo(() => merged.viewport(visibleStart, end), [merged, visibleStart, end]);
  // The read-only view's own window: `peekScroll` counts rows back from the newest, like the
  // conversation's scroll, so new output keeps arriving at the bottom unless the reader looked away.
  const peekTotal = peekLayout?.length ?? peekPlainRows.length;
  const peekMaxScroll = Math.max(0, peekTotal - Math.max(1, peekRows));
  const peekPosition = Math.min(peekScroll, peekMaxScroll);
  const peekEnd = Math.max(0, peekTotal - peekPosition);
  const peekStart = Math.max(0, peekEnd - Math.max(1, peekRows));
  const peekVisible = peekLayout === undefined ? peekPlainRows.slice(peekStart, peekEnd) : peekLayout.viewport(peekStart, peekEnd);
  // Where the first visible transcript row sits on screen: the copy-mode banner, the measured header,
  // the measured connection/foreground notices inside the body, and the viewport's own top margin.
  // Rows are laid out from the top of the viewport, so a given row's screen line is simply this plus
  // its index in `visible` — no counting back from the composer's variable height.
  const transcriptTop = (copyMode ? 1 : 0) + chromeRows.header + chromeRows.prefix + (dialogOpen ? 0 : 1);
  useMouseWheel(direction => {
    // The read-only view scrolls itself; the conversation behind it must not move.
    if (peek !== undefined) { setPeekScroll(value => Math.max(0, value + direction * 3)); return; }
    if (statusExpanded && statusOverflow) setStatusScroll(value => Math.max(0, value - direction * 3));
    else scrollHistory(direction * 3);
  }, !copyMode && state.screen === 'chat', cell => {
    // A bar stands for one readable source, and only its own row is the bar: its output rows below
    // are content, and a press on them still starts a selection. Everything else is copy mode.
    if (dialogOpen) return;
    const index = cell.row - 1 - transcriptTop;
    if (index < 0 || index >= visible.length) { setCopyMode(true); return; }
    // Screen line -> merged row: the viewport starts at `visibleStart`, so a short record's first row
    // and a scrolled one's are both placed correctly. Reading the index directly only worked when the
    // whole transcript fit on screen, which is exactly what a real session is not.
    const source = merged.sources.get(visibleStart + index);
    if (source !== undefined) { controller.actions.openPeek(source); return; }
    setCopyMode(true);
  });
  // Clamp the stored offset once the source's length is known, so scrolling back down starts moving
  // immediately instead of burning the overshoot first.
  useLayoutEffect(() => {
    if (peekPosition !== peekScroll) setPeekScroll(peekPosition);
  }, [peekPosition, peekScroll]);
  const liveThought = thoughtList && !historyWindow ? state.session.record.liveParts(width).find(part => part.kind === 'reasoning') : undefined;
  const thoughtEntries = thoughtList ? displayTranscript.thoughts : undefined;
  const thoughtChoices = useMemo(() => [...(thoughtEntries ?? [])].reverse().map(entry => ({
    key: String(entry.seq), label: `${toolLine(`#${entry.seq} User · ${entry.prompt}`, width - 2)}\n  ${toolLine(`◇ ${entry.preview}`, width - 4)}`,
    action: () => operate(async () => { const next = new Set(reasoningOverrides); next.add(entry.seq); setReasoningOverrides(next); await jumpHistory(entry.seq); }),
  })), [thoughtEntries, width, pageSize, reasoningOverrides, liveReasoning, displayTranscript]);
  const thoughtOptions = useMemo(() => [
          ...(liveThought ? [{ key: 'live', label: `${toolLine(`Now · User · ${state.session.record.latestPrompt}`, width - 2)}\n  ${toolLine(liveThought.text, width - 4)}`,
            action: () => { setLiveReasoning('full'); openThoughts(false); const expanded = controller.queries.render({ transcript: state.session.record, width, folds: reasoningOverrides, liveReasoning: 'full' }); setScroll(Math.max(0, expanded.length - pageSize - expanded.liveOffset)); } }] : []),
          ...thoughtChoices,
          ...(displayTranscript.hasMore ? [{ key: 'older', label: '↑ Load older reasoning', action: () => operate(() => historyOperation(signal => controller.actions.older(signal, displayTranscript))) }] : []),
          { key: 'close', label: '← Back to conversation', action: () => openThoughts(false) },
        ], [liveThought, thoughtChoices, displayTranscript, displayTranscript.hasMore, width, pageSize, reasoningOverrides]);
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  const workspaceName = workspace ? string(workspace.title) || string(workspace.path) : state.workspaceId;
  const headerTitle = controller.queries.sessionName
    ? [controller.queries.sessionName, width >= 60 ? workspaceName : undefined].filter(Boolean).join(' · ')
    : workspaceName || 'All workspaces';
  const commandSuggestions = !loopMenuOpen && input.startsWith('/') && !input.includes(' ') ? suggestedCommands(input) : undefined;
  // Once the name is settled and arguments begin, the composer says what this command takes. The
  // `/loop` record list is more specific, so it replaces the generic line rather than stacking on it.
  const commandHint = loopMenuOpen ? undefined : argumentHint(input);
  // Reading older history pauses the clock without freezing the connection state on picker screens.
  // A paused clock is named rather than left frozen: a stopped number looks like a stall.
  const pauseReason: 'copy' | 'dialog' | 'history' | undefined = copyMode ? 'copy'
    : state.screen === 'chat' && dialogOpen ? 'dialog'
    : state.screen === 'chat' && position > 0 ? 'history'
    : undefined;
  const statusFrozen = pauseReason !== undefined;
  // The bar renders plain data: the composition root is the one place that reads the controller.
  const statusSource: StatusSource = (() => {
    const view = controller.queries.telemetry.view(state.sessionId);
    const ledger = controller.costs;
    const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
    const line = (total: CostTotal) => ({ text: costText(total), amount: total.amount, unknown: total.unknown });
    const sessionOf = () => state.sessionId !== undefined && ledger !== undefined && ledger.hasSession(state.sessionId)
      ? ledger.total(state.sessionId) : undefined;
    const session = sessionOf();
    return {
      host: controller.base, online: state.online, status: state.status,
      running: controller.queries.running,
      // What is busy, and since when, is the controller's answer; the bar only draws it.
      ...(controller.queries.activity === undefined ? {} : { activity: controller.queries.activity }),
      sessionId: state.sessionId, sessionMode: controller.queries.sessionMode,
      workspaceLabel: workspace ? `${string(workspace.title)} · ${string(workspace.path)}` : 'none selected',
      activeTurnStartedAt: state.session.record.activeTurnStartedAt,
      pendingCount: state.pending.length,
      ...(state.session.record.livePhase === undefined ? {} : { livePhase: state.session.record.livePhase }),
      values: view.values, queued: view.queued, jobs: view.jobs,
      ...(state.defaultModel === undefined ? {} : { defaultModel: state.defaultModel }),
      ...(ledger === undefined ? {} : { cost: {
        sessionText: session === undefined ? '?' : costText(session),
        today: () => line(ledger.today()),
        session: () => { const total = sessionOf(); return total === undefined ? undefined : line(total); },
        coverage: ledger.coverage,
        ...(ledger.error === undefined ? {} : { error: ledger.error }),
      } }),
      ...(state.controlError === undefined ? {} : { controlError: state.controlError }),
      ...(state.presetError === undefined ? {} : { presetError: state.presetError }),
      ...(state.modelError === undefined ? {} : { modelError: state.modelError }),
    };
  })();

  const costSource: CostSource | undefined = (() => {
    const ledger = controller.costs;
    if (ledger === undefined) return undefined;
    const line = (total: CostTotal) => ({ text: costText(total), unknown: total.unknown, records: total.records });
    const id = state.sessionId;
    const session = id !== undefined && ledger.hasSession(id) ? ledger.total(id) : undefined;
    return {
      ...(session === undefined ? {} : { session: line(session) }),
      today: line(ledger.today()),
      scanning: ledger.scanning, coverage: ledger.coverage,
      ...(ledger.scannedAt === undefined ? {} : { scannedAt: ledger.scannedAt }),
      customPrices: ledger.customPrices,
      ...(ledger.error === undefined ? {} : { error: ledger.error }),
      missing: ledger.missing(),
    };
  })();

  return <ThemeContext.Provider value={theme}><CopyMode.Provider value={copyMode}><Frozen frozen={copyMode} identity={`${width}:${stdout.rows}`}><Box flexDirection="column" paddingX={1} height={Math.max(1, (stdout.rows ?? 30) - 1)} overflowY="hidden">
    {copyMode && <Text color={theme.accent}>Copy mode · drag to select · Esc / Ctrl+S resumes</Text>}
    <Box ref={headerSection} flexShrink={0}><ChatHeader title={headerTitle} mode={controller.queries.sessionMode} width={width} frozen={displayPaused} identity={`${width}:${state.sessionId}`} /></Box>
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden">
    <Box ref={bodyPrefix} flexDirection="column" flexShrink={0}>
    {foreground && <Text dimColor>{foreground.label} · Esc / Ctrl+C cancel</Text>}
    <Frozen frozen={statusPaused} identity={state.sessionId ?? ""}>{statusNotice && <Text dimColor wrap="truncate-end">{safeText(state.status)}</Text>}</Frozen>
    {state.lastFailure && <Text color={theme.colors.error}>{state.lastFailure}</Text>}
    </Box>
      {state.screen === 'chat' && (peek === undefined ? <ChatViewport rows={visible} showHistoryHint={showHistoryHint} dialogOpen={dialogOpen}
        historyWindow={!!historyWindow} frozen={displayPaused}
        identity={`${width}:${state.sessionId}:${position}:${pageSize}`} boxRef={conversationBox} />
        : <PeekPanel source={peek.source} {...(peek.error === undefined ? {} : { error: peek.error })} rows={peekVisible}
          position={peekPosition} total={peekTotal} width={width} now={Date.now()} boxRef={peekBox} />)}
    </Box>
    <Box flexDirection="column" flexShrink={0}>
      {notice && <Text dimColor>{safeText(notice)}</Text>}
      {composerIntent && <Text color={theme.colors.context}>{composerIntent.hint}</Text>}
      {loop && <LoopStatus progress={loop} />}
      {/* The read-only view is the whole screen: while it is open the composer is gone, and Esc is
          the one way back. Its own keys never reach the draft, which stays parked untouched. */}
      {peek === undefined && <Box borderStyle="round" borderColor={pending ? theme.colors.context : state.online ? theme.accent : theme.border} paddingX={1} flexDirection="column" flexShrink={1} minHeight={3}>
        <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
    {loopForm && loopRecord ? <LoopDialog key={loopForm.name} record={loopRecord}
      enabled={state.online && controller.queries.foreground === undefined}
      onStart={run => startLoopFromForm(loopForm.name, run)}
      onBack={() => { setLoopForm(undefined); setInput('/loop '); setDismissedLoopMenu(undefined); }}
      onClose={() => setLoopForm(undefined)} /> : queueOpen && !pending ? <QueueDialog queued={queued} rows={stdout.rows ?? 30} width={width}
      unavailable={!!state.controlError}
      enabled={!input && foreground === undefined && state.online}
      canSelect={() => !input && controller.queries.foreground === undefined && controller.state.online && !controller.state.pending.length}
      onRemove={id => operate(() => controller.actions.removeQueued(id))} /> : removal ? <RemovalDialog removal={removal}
      enabled={!input && foreground === undefined && state.online}
      canSelect={() => !input && controller.queries.foreground === undefined && controller.state.online}
      onCancel={() => setRemoval(undefined)}
      onConfirm={() => operate(async () => { if (await controller.actions.removeTarget(removal)) setRemoval(undefined); })} /> : models ? <ModelDialog models={models} rows={stdout.rows ?? 30} width={width}
      enabled={!input && foreground === undefined && state.online}
      canSelect={() => !input && controller.queries.foreground === undefined && controller.state.online}
      onChoose={(provider, model, effort) => operate(async () => { if (await controller.actions.selectModel(provider, model, effort)) setModelPanel(undefined); })}
      onOpen={(provider, model) => setModelPanel({ catalog: models.catalog, provider, model })}
      onBack={() => setModelPanel({ catalog: models.catalog })}
      onClose={() => setModelPanel(undefined)} /> : searchResults ? <SearchResultsDialog query={searchResults.query} items={searchResults.items} hasMore={searchResults.hasMore} width={width}
      enabled={!input && foreground === undefined} canSelect={() => !input && controller.queries.foreground === undefined}
      onOpen={sessionId => operate(() => openSearchSession(sessionId, searchResults.query))}
      onClose={() => setSearchPanel(undefined)} /> : state.screen === 'workspaces' || state.screen === 'sessions' ? <PickerScreen
      title={state.screen === 'workspaces' ? 'Choose workspace' : state.showAllSessions ? 'Choose session · All workspaces' : 'Choose session'}
      identity={`${state.screen}:${state.workspaceId ?? ''}`} choices={choices} width={pickerWidth}
      // A rollup of badges is read through the key beside it; spelled-out states need no key, and a
      // terminal too narrow for the whole key gets the badges alone rather than half a legend.
      legend={state.screen === 'workspaces' && rollupStyle === 'badges' && pickerWidth >= 40 ? ROLLUP_LEGEND : undefined}
      enabled={state.online && foreground === undefined && !input}
      canSelect={() => !input && controller.state.online && controller.queries.foreground === undefined} /> : <>
      {thoughtList && <ThoughtsDialog identity={`thoughts:${state.sessionId}`} options={thoughtOptions} empty={!thoughtEntries?.length && !liveThought}
        rows={stdout.rows ?? 30} enabled={!input && foreground === undefined} canSelect={() => !input && controller.queries.foreground === undefined} />}
      {promptsOpen && state.screen === 'chat' && <PromptsDialog identity="prompts"
        prompts={controller.queries.prompts} error={controller.queries.promptsError} width={width}
        enabled={!input && foreground === undefined} canSelect={() => !input && controller.queries.foreground === undefined}
        onChoose={text => { setInput(text); openPrompts(false); }}
        onEdit={prompt => {
          setComposerIntent({
            hint: 'Editing saved prompt · Enter saves · Esc cancels',
            emptyNotice: 'Type the prompt text; Enter then saves it',
            successNotice: 'Saved prompt updated',
            commit: text => controller.actions.updatePrompt(prompt.id, text),
          });
          setInput(prompt.text); openPrompts(false);
        }}
        onRemove={id => operate(async () => { if (await controller.actions.deletePrompt(id)) setNotice('Deleted saved prompt'); })} />}
      {state.screen === 'chat' && historyQuery !== undefined && <HistoryDialog identity={`history:${historyQuery}`}
        contentSearch={contentSearch} matches={historyMatches} query={historyQuery} messages={layout.messages} width={width}
        enabled={!input && foreground === undefined} canSelect={() => !input && controller.queries.foreground === undefined}
        onJump={seq => operate(() => jumpHistory(seq))}
        onClose={() => setHistoryPanel(undefined)} />}
      {pending && <Box flexShrink={0} flexDirection="column">
        <Text bold color={theme.colors.context}>{question ? `Question ${answered.length + 1}/${questions.length}${question.header ? ` · ${safeText(question.header)}` : ''}` : 'Approval required'}</Text>
        <Text>{safeText(question ? question.question : pending.kind === 'approval' ? pending.description : '')}</Text>
        {question?.detail && <Text>{safeText(question.detail)}</Text>}
        {pending.kind === 'approval' && <Box flexDirection="column" flexShrink={0}>
          {/* Choices 1 and 2 are the host's `allowed-once` and `rejected` outcomes; 3 cancels the turn. */}
          {['Allow once', 'Deny', 'Stop turn'].map((label, index) => <Text key={label} color={approvalIndex === index ? theme.accent : undefined}>
            {approvalIndex === index ? '❯ ' : '  '}{index + 1}. {label}
          </Text>)}
          <Text dimColor>↑ ↓ / 1–3 select · Enter confirm</Text>
        </Box>}
        {options.length > 0 && <Box flexDirection="column" flexShrink={0}>
          {[...options, { label: 'Other answer — type below' } as { label: string; description?: string }].map((option, index) => ({ option, index }))
            .slice(optionStart, optionStart + optionPageSize).map(({ option, index }) => <Box key={index} flexDirection="column" flexShrink={0}>
              <Text color={index === optionCursor ? theme.accent : undefined} wrap="truncate-end">{index === optionCursor ? '❯ ' : '  '}{index + 1}. {question?.multiSelect === true && index < options.length ? choiceState.selected.includes(option.label) ? '[x] ' : '[ ] ' : ''}{safeText(option.label)}</Text>
              {option.description && <Text dimColor wrap="truncate-end">{'     '}{safeText(option.description)}</Text>}
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
        {/* D1: a long operation must not take the keyboard away. The draft stays editable, Enter is
            refused by the admission guard in `submit` instead of being sent or dropped, and nothing
            sends the draft when the operation finishes. */}
        <TextInput value={input} onChange={setInput} onCursorChange={setCursor} onSubmit={() => { void submit(input); }}
          reservedKeys={approvalKeysActive ? ['1','2','3'] : questionKeysActive ? ['1','2','3','4','5','6','7','8','9', ...(question?.multiSelect === true ? [' '] : [])] : !removal && !models && !searchResults && (state.screen === 'workspaces' || state.screen === 'sessions') ? ['d'] : surfaceReservedKeys.length ? surfaceReservedKeys : undefined}
          width={draftWidth} maxRows={composerRows} promptColor={answerPending ? theme.colors.muted : theme.accent}
          focus={!copyMode && !answerPending && !loopForm} placeholder={state.screen === 'path' ? 'Absolute directory path on host' : 'Message, @host-file, or /help'} />
      {referenceOpen && <ReferenceMenu matches={matches} index={referenceIndex} />}
      {loopMenuOpen && <LoopMenu records={loopCandidates} index={loopMenuCursor} />}
      </Box>}
      {commandSuggestions && <Text dimColor>{commandSuggestions.join('  ')}</Text>}
      {commandHint && <Text dimColor><Text color={theme.accent}>{commandHint.command}{commandHint.usage === undefined ? '' : ` ${commandHint.usage}`}</Text> · {commandHint.description}</Text>}
      {help && <HelpPanel page={currentHelpPage} pages={helpPages} pageSize={helpPageSize} />}
      {costExpanded && <CostPanel source={costSource} />}
      <Frozen frozen={statusFrozen} identity={`${width}:${state.sessionId}:${statusExpanded}:${statusScroll}:${pauseReason ?? ''}`}><StatusBar source={statusSource} width={width} expanded={statusExpanded} scroll={statusScroll} pageSize={statusViewRows} onScroll={setStatusScroll} onOverflow={setStatusOverflow} onRows={setStatusBarRows} pauseReason={pauseReason} revision={state.version} /></Frozen>
    </Box>
  </Box></Frozen></CopyMode.Provider></ThemeContext.Provider>;
}
