/** The `/loop` record list and the parameter form that confirms a chosen record's defaults. */
import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { LoopLimits, LoopRecord, LoopSourceInfo } from '../../contracts.ts';
import { validLoopOption } from '../../slash/parse.ts';
import { safeText } from '../../text.ts';
import { useCopyMode } from '../copy-mode.ts';
import { useTheme } from '../theme/index.ts';

/** The numeric fields the form edits, in the order a run reads them. */
export type LoopField = 'from' | 'to' | 'score' | 'tries';

/** How one field presents itself and what it means when a value is rejected. */
interface LoopFieldSpec {
  field: LoopField;
  /** Column label. */
  label: string;
  /** What the value must be, shown beside an invalid one. */
  hint: string;
}

const FIELDS: readonly LoopFieldSpec[] = [
  { field: 'from', label: 'From', hint: 'first round, 1 or more' },
  { field: 'to', label: 'To', hint: 'last round, at least From' },
  { field: 'score', label: 'Pass', hint: 'passing score, 0–10' },
  { field: 'tries', label: 'Tries', hint: 'attempts per round, 1 or more' },
];

/** One row of the form: an action, an editable number, a record variable, or the way back. */
type LoopRow =
  | { kind: 'start' }
  | { kind: 'field'; spec: LoopFieldSpec }
  | { kind: 'var'; name: string }
  | { kind: 'back' };

/** What the form hands to the runner: the four numbers and the record's variables as confirmed. */
export interface LoopRun {
  limits: LoopLimits;
  vars: Readonly<Record<string, string>>;
}

/** The values a run from one record would start with, which the form shows before anything is typed.
 * @param record - Chosen record.
 * @returns Its first round, last round and declared score and attempt budgets.
 */
export function loopRecordDefaults(record: LoopRecord): LoopLimits {
  return { from: 1, to: record.steps, score: record.defaultScore, tries: record.defaultTries };
}

/** The form's rows for one record: its own variables first, then the shared run limits.
 *
 * The record's variables lead because they are why this record's form was opened at all: the document
 * under review is the decision that matters most, and it is not something the command line spells out.
 * @param record - Chosen record.
 * @returns The ordered rows.
 */
function rowsFor(record: LoopRecord): readonly LoopRow[] {
  return [
    { kind: 'start' },
    ...Object.keys(record.vars).map(name => ({ kind: 'var' as const, name })),
    ...FIELDS.map(spec => ({ kind: 'field' as const, spec })),
    { kind: 'back' },
  ];
}

/** Columns the label occupies, so the values line up whatever names a record declares.
 * @param rows - Rows being rendered.
 * @returns One past the longest label.
 */
function labelWidth(rows: readonly LoopRow[]): number {
  const longest = Math.max(0, ...rows.map(row => row.kind === 'field' ? row.spec.label.length
    : row.kind === 'var' ? row.name.length : 0));
  return Math.max(5, longest) + 1;
}

/** The record list shown under the composer while `/loop` is being typed.
 *
 * It offers the same names and defaults the runner reads, so choosing from it cannot start a run
 * other than the one the row describes.
 * @param props - Matching records, the highlighted row, and where the records came from.
 * @returns The key line, the source line, any warning, and up to six record rows.
 */
export function LoopMenu({ records, index, source }: {
  records: readonly LoopRecord[];
  index: number;
  source?: LoopSourceInfo;
}) {
  const theme = useTheme();
  const start = Math.max(0, index - 5);
  // Records are configuration now: whenever a user file supplied or replaced one, the list says so,
  // because an operator who overrode a shipped record cannot tell the two apart from the name alone.
  const origin = source?.file === undefined ? undefined : [
    `Records from ${source.file}`,
    ...(source.overridden.length === 0 ? [] : [`replaced: ${source.overridden.join(', ')}`]),
    ...(source.added.length === 0 ? [] : [`added: ${source.added.join(', ')}`]),
  ].join(' · ');
  return <Box flexDirection="column">
    <Text dimColor>Loop records · ↑ ↓ select · Enter confirm defaults · Tab finish the name · Esc close</Text>
    {origin !== undefined && <Text dimColor wrap="truncate-end">{safeText(origin)}</Text>}
    {(source?.warnings ?? []).map(warning => <Text key={warning} color={theme.colors.error} wrap="truncate-end">{safeText(warning)}</Text>)}
    {records.slice(start, start + 6).map((record, offset) => {
      const current = start + offset === index;
      // The record's own inputs come before the artifact file: they are what the form will edit, and
      // the first thing a narrow row must not lose.
      const vars = Object.entries(record.vars).map(([name, value]) => `${name} ${value}`).join(' · ');
      const target = vars === '' ? '' : ` · ${vars}`;
      const artifact = record.artifact === undefined ? '' : ` · ${record.artifact}`;
      const mine = record.fromFile === true ? ' · yours' : '';
      return <Text key={record.name} color={current ? theme.accent : undefined} wrap="truncate-end">
        {current ? '❯ ' : '  '}{record.name} · {record.title} · {record.steps} rounds · pass {record.defaultScore} · ≤{record.defaultTries} tries{target}{artifact}{mine}
      </Text>;
    })}
  </Box>;
}

/** The loop parameter form: one record's variables and defaults, editable in place, then a Start.
 *
 * Values are replaced by typing over them, so no flag has to be remembered and every default stays
 * visible until it is changed. A record variable is free text because it is a path or a target, not a
 * number; the four limits share the command line's own validation. Leaving a row — with Enter or with
 * an arrow — commits what was typed, so no box needs its own confirmation and Start reads the values
 * as displayed. The run starts only from the Start row, so no keystroke that edits a value can launch
 * it by accident. The form stays readable and escapable even when the host is busy or gone; only Start
 * is unavailable then.
 * @param props - The chosen record, whether a run may start now, and the three row actions.
 * @returns The form.
 */
export function LoopDialog({ record, enabled, onStart, onBack, onClose }: {
  record: LoopRecord;
  enabled: boolean;
  onStart(run: LoopRun): void;
  onBack(): void;
  onClose(): void;
}) {
  const theme = useTheme();
  const copyMode = useCopyMode();
  const defaults = loopRecordDefaults(record);
  const rows = useMemo(() => rowsFor(record), [record]);
  const width = useMemo(() => labelWidth(rows), [rows]);
  const [row, setRow] = useState(0);
  const [values, setValues] = useState<LoopLimits>(defaults);
  const [vars, setVars] = useState<Record<string, string>>({ ...record.vars });
  const [edit, setEdit] = useState<string>();
  const [error, setError] = useState<string>();
  const current = rows[Math.min(row, rows.length - 1)]!;
  /** Validate and apply the selected editable row's buffer.
   *
   * Leaving a row takes its value with it, so no box needs its own Enter: an arrow to the next row
   * commits what was typed, and Start then reads the committed values. A value that cannot be used
   * keeps the cursor on its row and says why, so nothing is dropped silently.
   * @returns True when it is safe to leave the row.
   */
  const applyEdit = (): boolean => {
    if (edit === undefined || current.kind === 'start' || current.kind === 'back') return true;
    if (current.kind === 'var') {
      const value = edit.trim();
      if (value === '') { setError(`${current.name}: a value is required`); return false; }
      if (value !== vars[current.name]) setVars({ ...vars, [current.name]: value });
      setEdit(undefined); setError(undefined);
      return true;
    }
    // Nothing typed (or the value erased) leaves the field as it was rather than reading `''` as 0.
    if (edit === '') { setEdit(undefined); setError(undefined); return true; }
    const parsed = Number(edit);
    if (!validLoopOption(current.spec.field, parsed)) { setError(`${current.spec.label}: ${current.spec.hint}`); return false; }
    const next = { ...values, [current.spec.field]: parsed };
    if (next.to < next.from) { setError('To must be at least From'); return false; }
    setValues(next); setEdit(undefined); setError(undefined);
    return true;
  };
  const move = (next: number): void => {
    if (!applyEdit()) return;
    setRow(Math.max(0, Math.min(rows.length - 1, next)));
    setEdit(undefined); setError(undefined);
  };
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {
      if (edit !== undefined) { setEdit(undefined); setError(undefined); } else onClose();
      return;
    }
    if (key.upArrow) { move(row - 1); return; }
    if (key.downArrow) { move(row + 1); return; }
    if (current.kind === 'var') {
      const { name } = current;
      if (key.backspace || key.delete) { setEdit((edit ?? vars[name] ?? '').slice(0, -1)); setError(undefined); return; }
      // A variable is a path or a target, so anything printable goes in; control bytes never do.
      const typed = input.replace(/[\u0000-\u001f\u007f]/g, '');
      if (typed !== '' && !key.ctrl && !key.meta) { setEdit(edit === undefined ? typed : edit + typed); setError(undefined); return; }
      if (key.return) move(row + 1);
      return;
    }
    if (current.kind === 'field') {
      const { field } = current.spec;
      if (key.backspace || key.delete) { setEdit((edit ?? String(values[field])).slice(0, -1)); setError(undefined); return; }
      if (/^[0-9.]$/.test(input)) { setEdit(edit === undefined ? input : edit + input); setError(undefined); return; }
      if (key.return) move(row + 1);
      return;
    }
    if (!key.return) return;
    if (current.kind === 'back') { onBack(); return; }
    if (!enabled) { setError('Cannot start: the host is busy or offline'); return; }
    if (values.to < values.from) { setError('To must be at least From'); return; }
    onStart({ limits: values, vars });
  }, { isActive: !copyMode });
  return <Box flexDirection="column" marginY={1}>
    <Text bold>Run loop record · {safeText(record.name)}{record.fromFile === true ? ' · your file' : ''} · Esc close</Text>
    <Text dimColor wrap="truncate-end">{record.steps} rounds{record.artifact === undefined ? '' : ` · ${safeText(record.artifact)}`} · ↑ ↓ to a row, then type</Text>
    {rows.map((item, index) => {
      const selected = index === row;
      const cursor = selected ? '❯ ' : '  ';
      if (item.kind === 'start' || item.kind === 'back') return <Text key={item.kind} color={selected ? theme.accent : undefined}>
        {cursor}{item.kind === 'start' ? 'Start run' : '← Choose another record'}
      </Text>;
      if (item.kind === 'var') {
        const value = vars[item.name] ?? '';
        const shown = selected && edit !== undefined ? edit : value;
        return <Text key={`var:${item.name}`} color={selected ? theme.accent : undefined}>
          {cursor}{item.name.padEnd(width)}{selected && edit !== undefined ? <Text inverse>{shown || ' '}</Text> : shown}
          {value === record.vars[item.name] ? null : <Text dimColor> · default {record.vars[item.name]}</Text>}
        </Text>;
      }
      const { field, label } = item.spec;
      const shown = selected && edit !== undefined ? edit : String(values[field]);
      return <Text key={`field:${field}`} color={selected ? theme.accent : undefined}>
        {cursor}{label.padEnd(width)}{selected && edit !== undefined ? <Text inverse>{shown || ' '}</Text> : shown}
        {values[field] === defaults[field] ? null : <Text dimColor> · default {defaults[field]}</Text>}
      </Text>;
    })}
    {error !== undefined && <Text color={theme.colors.error}>{safeText(error)}</Text>}
    <Text dimColor>Enter edit a value / start · type to replace · Esc close</Text>
  </Box>;
}
