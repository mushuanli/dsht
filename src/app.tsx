/** Ink terminal interface: startup pickers, transcript, and slash-command composer. */
import { useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import wrapAnsi from 'wrap-ansi';
import { Controller } from './controller.ts';
import { array, object, safeText, string, type ObjectValue } from './wire.ts';

const HELP = '/sessions  /workspaces  /new  /older  /cancel  /steer text  /allow  /deny  /quit';

/** Render a session title from the optional host projection, falling back to its ID. */
export function sessionLabel(session: ObjectValue): string {
  const projections = session.projections;
  if (projections && typeof projections === 'object' && !Array.isArray(projections)) {
    const values = projections.values;
    const title = values && typeof values === 'object' && !Array.isArray(values) ? values.title : undefined;
    if (typeof title === 'string' && title) return safeText(title);
    if (title && typeof title === 'object' && !Array.isArray(title) && typeof title.title === 'string') {
      return safeText(title.title);
    }
  }
  return string(session.sessionId);
}

interface Choice { key: string; label: string; action(): void }

function Picker({ choices, enabled }: { choices: Choice[]; enabled: boolean }) {
  const [selected, setSelected] = useState(0);
  const current = Math.min(selected, choices.length - 1);
  useInput((_input, key) => {
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
    <Text dimColor>↑ ↓ select · Enter open · Ctrl+C exit</Text>
  </Box>;
}

/** The caller owns starting and stopping the controller around the Ink render lifetime. */
export function App({ controller }: { controller: Controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, updateInput] = useState('');
  const draft = useRef('');
  // Input callbacks may run before Ink refreshes the controlled field's listener.
  const setInput = (value: string) => { draft.current = value; updateInput(value); };
  const [scroll, setScroll] = useState(0);
  const [help, setHelp] = useState(false);
  const [answers, setAnswers] = useState<Record<string, ObjectValue[]>>({});
  const pending = state.pending[0];
  const questions = pending?.event === 'user-questions/request' ? array(object(pending.request).questions).map(object) : [];
  const eventId = pending ? string(pending.eventId) : '';
  const answered = answers[eventId] ?? [];
  const question = questions[answered.length];
  const operate = (fn: () => Promise<void>) => { void controller.perform(fn); };
  useInput((_value, key) => {
    if (key.escape && state.screen === 'chat') operate(() => controller.cancelTurn());
    if (key.pageUp) setScroll(value => value + 10);
    if (key.pageDown) setScroll(value => Math.max(0, value - 10));
  });

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (value === '/quit') { exit(); return; }
    if (value === '/help') { setHelp(value => !value); setInput(''); return; }
    const accepted = await controller.perform(async () => {
      if (state.screen === 'path') await controller.createWorkspace(value);
      else if (value === '/sessions') await controller.showPicker('sessions');
      else if (value === '/workspaces') await controller.showPicker('workspaces');
      else if (value === '/new') await controller.createSession();
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
      else { await controller.prompt(value); setScroll(0); }
    });
    if (accepted) setInput('');
  };

  const choices: Choice[] = state.screen === 'workspaces' ? [
    ...state.workspaces.map(workspace => ({ key: string(workspace.workspaceId),
      label: `${string(workspace.title)}  ${string(workspace.path)}`,
      action: () => controller.pickWorkspace(string(workspace.workspaceId)) })),
    { key: '@all', label: 'All sessions', action: () => controller.pickWorkspace() },
    { key: '@new', label: '+ Add workspace (host directory)', action: () => controller.enterPath() },
  ] : [
    ...(state.workspaceId ? [{ key: '@new', label: '+ New session', action: () => operate(() => controller.createSession()) }] : []),
    ...controller.visibleSessions.map(session => ({ key: string(session.sessionId),
      label: `${session.running ? '● ' : ''}${sessionLabel(session)}  ${session.sessionId}`,
      action: () => { setScroll(0); operate(() => controller.selectSession(string(session.sessionId))); } })),
    { key: '@back', label: '← Workspaces', action: () => operate(() => controller.showPicker('workspaces')) },
  ];
  const messages = state.transcript.messages;
  const width = Math.max(10, (stdout.columns ?? 80) - 2);
  const wrap = (value: string) => wrapAnsi(value, width, { hard: true }).split('\n');
  const lines = messages.flatMap(message => [`${message.role}`, ...wrap(message.text), '']);
  if (state.transcript.liveText) lines.push('Assistant · streaming', ...wrap(state.transcript.liveText));
  const pageSize = Math.max(5, (stdout.rows ?? 30) - (pending ? 17 : 12));
  const end = Math.max(pageSize, lines.length - Math.min(scroll, Math.max(0, lines.length - pageSize)));
  const visible = lines.slice(Math.max(0, end - pageSize), end);
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  return <Box flexDirection="column" paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">DeepSeek Harness · HTTP TUI</Text>
      <Text dimColor>{controller.base} · {state.status}{state.busy ? ' · Working…' : ''}</Text>
      <Text>{workspace ? safeText(string(workspace.title)) : 'All workspaces'}{state.sessionId ? ` / ${state.sessionId}` : ''}</Text>
    </Box>
    {state.error && <Text color="red">{state.error}</Text>}
    {state.screen === 'workspaces' || state.screen === 'sessions' ? <Box flexDirection="column" marginY={1}>
      <Text bold>{state.screen === 'workspaces' ? 'Choose workspace' : 'Choose session'}</Text>
      <Picker key={`${state.screen}:${state.workspaceId ?? ''}`} choices={choices} enabled={state.online && !state.busy} />
    </Box> : <>
      {state.screen === 'chat' && <Box flexDirection="column" marginY={1}>
        <Text>{visible.length ? visible.join('\n') : 'Start a conversation with the host agent.'}</Text>
        {state.transcript.hasMore && <Text dimColor>/older loads earlier history</Text>}
      </Box>}
      {pending && <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
        <Text bold color="yellow">{question ? 'Question' : 'Approval required'}</Text>
        <Text>{safeText(question ? string(question.question) : JSON.stringify(pending.request, null, 2))}</Text>
        {question?.detail && <Text>{safeText(string(question.detail))}</Text>}
        {question?.options && <Text>{array(question.options).map(option => string(object(option).label)).join(' · ')}</Text>}
        <Text dimColor>{question ? 'Type your answer below' : '/allow approves once · /deny rejects'}</Text>
      </Box>}
      <Box borderStyle="round" borderColor={state.online ? 'cyan' : 'gray'} paddingX={1}>
        <Text color="cyan">❯ </Text>
        <TextInput value={input} onChange={setInput} onSubmit={() => { void submit(draft.current); }}
          focus={state.online && !state.busy} placeholder={state.screen === 'path' ? 'Absolute directory path on host' : 'Message or /help'} />
      </Box>
      <Text dimColor>Enter send · Esc cancel · PgUp/PgDn scroll · Ctrl+C exit</Text>
      {help && <Text dimColor>{HELP}</Text>}
    </>}
  </Box>;
}
