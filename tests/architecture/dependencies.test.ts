/** Architectural import rules: each directory is a boundary, not a file category. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Allowed target units per importing unit; a unit is a top-level directory or a root file.
 *
 * The UI names a feature only through `contracts.ts` or a shared leaf; even the composition roots
 * may not import one directly.
 */
const UNITS: Record<string, readonly string[]> = {
  'json.ts': [],
  'text.ts': [],
  'session-title.ts': ['json.ts', 'text.ts'],
  'references.ts': [],
  'contracts.ts': ['contracts.ts', 'json.ts', 'references.ts', 'transport', 'session', 'cost', 'catalog', 'shell'],
  slash: ['slash'],
  storage: ['storage'],
  transport: ['transport', 'storage', 'json.ts', 'text.ts'],
  session: ['transport', 'session', 'state.ts', 'storage', 'text.ts', 'json.ts', 'session-title.ts', 'references.ts'],
  shell: ['shell', 'storage', 'text.ts', 'json.ts'],
  cost: ['transport', 'cost', 'storage', 'text.ts', 'json.ts'],
  catalog: ['transport', 'catalog', 'state.ts', 'json.ts'],
  controller: ['transport', 'session', 'cost', 'catalog', 'controller', 'shell', 'state.ts', 'storage',
    'text.ts', 'json.ts', 'contracts.ts', 'slash', 'session-title.ts'],
  ui: ['ui', 'controller', 'contracts.ts', 'json.ts', 'text.ts', 'slash', 'session-title.ts', 'references.ts'],
  cli: ['transport', 'session', 'cost', 'catalog', 'controller', 'ui', 'cli', 'state.ts', 'storage',
    'text.ts', 'json.ts', 'contracts.ts', 'slash', 'shell', 'session-title.ts', 'references.ts'],
  'state.ts': ['transport', 'session', 'shell', 'json.ts'],
  'index.ts': ['transport'],
};

/** The only UI files allowed to know an application capability; every other one takes props. */
const UI_ENTRY_POINTS = new Set(['ui/app.tsx', 'ui/mount.tsx']);

/** Feature units; none of them may import another one directly. */
const FEATURES = ['session', 'cost', 'catalog', 'shell'];

/** Effect modules that may only appear inside the ui layer. */
const RENDERER_MODULES = new Set(['react', 'ink', 'ink-testing-library']);

/** Filesystem modules that may only appear inside the storage unit. */
const FILESYSTEM_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/** Process-execution modules that may only appear inside the shell unit. */
const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

interface SourceFile { path: string; source: string }

/** The architectural unit owning one repository-relative source path. */
function unitOf(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(0, slash);
}

/** Import and re-export specifiers, including dynamic imports. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) out.push(match[1]!);
  return out;
}

/** Check every file against the dependency rules.
 * @param files - Repository-relative source paths and their contents.
 * @returns One message per violation, empty when the graph is legal.
 */
function violations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const unit = unitOf(file.path);
    const allowed = UNITS[unit];
    if (!allowed) { problems.push(`${file.path}: no dependency rule for unit ${unit}`); continue; }
    if (file.path === 'contracts.ts' && /(^|\n)\s*(export\s+)?(const|function|class)\s/.test(file.source)) {
      problems.push(`${file.path}: the UI contract must be types only`);
    }
    for (const spec of specifiers(file.source)) {
      if (spec.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(file.path), spec));
        if (target.startsWith('..')) { problems.push(`${file.path}: relative import escapes src (${spec})`); continue; }
        const targetUnit = unitOf(target);
        // Each specifier reports exactly once, naming the most specific rule it breaks.
        const featurePair = unit !== targetUnit && FEATURES.includes(unit) && FEATURES.includes(targetUnit);
        if (featurePair) problems.push(`${file.path}: a feature must not import another feature (${spec})`);
        else if (unit === 'slash' && targetUnit !== 'slash') problems.push(`${file.path}: slash is a pure leaf (${spec})`);
        else if (unit === 'ui' && FEATURES.includes(targetUnit)) {
          problems.push(`${file.path}: the ui reads a feature only through the contract (${spec})`);
        } else if (unit === 'ui' && targetUnit === 'controller' && !UI_ENTRY_POINTS.has(file.path)) {
          problems.push(`${file.path}: only ui/app.tsx and ui/mount.tsx may import the application controller (${spec})`);
        } else if (!allowed.includes(targetUnit)) problems.push(`${file.path}: ${unit} must not import ${targetUnit} (${spec})`);
      } else if (FILESYSTEM_MODULES.has(spec) && unit !== 'storage') {
        problems.push(`${file.path}: filesystem operations belong to the storage unit (${spec})`);
      } else if (PROCESS_MODULES.has(spec) && unit !== 'shell') {
        problems.push(`${file.path}: process execution belongs to the shell unit (${spec})`);
      } else if (RENDERER_MODULES.has(spec.split('/')[0]!) && unit !== 'ui') {
        problems.push(`${file.path}: React/Ink belongs to the ui layer (${spec})`);
      }
    }
  }
  return problems;
}

/** Every TypeScript source file under src, as repository-relative posix paths. */
function sourceFiles(directory: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) out.push(...sourceFiles(absolute));
    else if (/\.tsx?$/.test(entry)) out.push({ path: relative(SRC, absolute).split(sep).join('/'), source: readFileSync(absolute, 'utf8') });
  }
  return out;
}

test('source modules obey the directory dependency rules', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 20, `expected the whole source tree, found ${files.length} files`);
  assert.deepEqual(violations(files), []);
});

test('the dependency check rejects each forbidden direction', () => {
  // B1: a UI leaf must not know the application capability; only the entry points may.
  assert.deepEqual(violations([{ path: 'ui/chat/panel.tsx', source: "import { Controller } from '../../controller/index.ts';" }]),
    ['ui/chat/panel.tsx: only ui/app.tsx and ui/mount.tsx may import the application controller (../../controller/index.ts)']);
  assert.deepEqual(violations([{ path: 'ui/app.tsx', source: "import { Controller } from '../controller/controller.ts';" }]), []);
  // B3: a UI leaf reads types from the contract, not from a feature.
  assert.deepEqual(violations([{ path: 'ui/chat/panel.tsx', source: "import type { HistoryRow } from '../../session/history.ts';" }]),
    ['ui/chat/panel.tsx: the ui reads a feature only through the contract (../../session/history.ts)']);
  assert.deepEqual(violations([{ path: 'ui/chat/panel.tsx', source: "import type { HistoryRow } from '../../contracts.ts';" }]), []);
  // The composition root reads a feature through the contract and the controller too: no exemption.
  assert.deepEqual(violations([{ path: 'ui/app.tsx', source: "import { historyLayout } from '../session/history.ts';" }]),
    ['ui/app.tsx: the ui reads a feature only through the contract (../session/history.ts)']);
  // B2: the UI never imports the transport domain.
  assert.deepEqual(violations([{ path: 'ui/panel.tsx', source: "import { Client } from '../transport/client.ts';" }]),
    ['ui/panel.tsx: ui must not import transport (../transport/client.ts)']);
  // B4: a feature never imports the UI.
  assert.deepEqual(violations([{ path: 'cost/format.ts', source: "import { useTheme } from '../ui/theme/index.ts';" }]),
    ['cost/format.ts: cost must not import ui (../ui/theme/index.ts)']);
  // B5: the application never imports the UI.
  assert.deepEqual(violations([{ path: 'controller/controller.ts', source: "import { Box } from '../ui/box.ts';" }]),
    ['controller/controller.ts: controller must not import ui (../ui/box.ts)']);
  // B6: features never import each other, not even for types.
  assert.deepEqual(violations([{ path: 'session/state.ts', source: "import type { CostTotal } from '../cost/types.ts';" }]),
    ['session/state.ts: a feature must not import another feature (../cost/types.ts)']);
  // B7: a feature never imports the application layer.
  assert.deepEqual(violations([{ path: 'session/service.ts', source: "import type { Actions } from '../controller/controller.ts';" }]),
    ['session/service.ts: session must not import controller (../controller/controller.ts)']);
  // B8: transport and storage never import an upper layer.
  assert.deepEqual(violations([{ path: 'transport/client.ts', source: "import type { SessionInfo } from '../session/info.ts';" }]),
    ['transport/client.ts: transport must not import session (../session/info.ts)']);
  // B9: slash is a pure leaf.
  assert.deepEqual(violations([{ path: 'slash/parse.ts', source: "import { sessionLabel } from '../session/navigation.ts';" }]),
    ['slash/parse.ts: slash is a pure leaf (../session/navigation.ts)']);
  // The UI contract carries types only.
  assert.deepEqual(violations([{ path: 'contracts.ts', source: 'export const defaultStatus = 1;' }]),
    ['contracts.ts: the UI contract must be types only']);
  // Existing unit confinement stays.
  assert.deepEqual(violations([{ path: 'session/render.ts', source: "import { Box } from 'ink';" }]),
    ['session/render.ts: React/Ink belongs to the ui layer (ink)']);
  assert.deepEqual(violations([{ path: 'cost/files.ts', source: "import { readFile } from 'node:fs/promises';" }]),
    ['cost/files.ts: filesystem operations belong to the storage unit (node:fs/promises)']);
  assert.deepEqual(violations([{ path: 'cost/spawn.ts', source: "import { spawn } from 'node:child_process';" }]),
    ['cost/spawn.ts: process execution belongs to the shell unit (node:child_process)']);
  assert.deepEqual(violations([{ path: 'storage/files.ts', source: "import { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';" }]), []);
  assert.deepEqual(violations([{ path: 'shell/runner.ts', source: "import { spawn } from 'node:child_process';" }]), []);
});

test('the composition root runs the pipeline stages instead of dispatching commands', () => {
  const source = readFileSync(join(SRC, 'ui/app.tsx'), 'utf8');
  // The pipeline settles what a line means; the root decides only its own front-end modes and hands
  // every command to the application in one call.
  assert.deepEqual([...source.matchAll(/(?:plan|submission)\.action\.kind === '([^']+)'/g)].map(match => match[1]).sort(),
    ['ignore'], 'the root must decide only its own front-end modes');
  assert.ok(source.includes("submission.kind === 'mode'"), 'the root must read the submission it was handed');
  // The three stages stay separate calls: merging them would let one stage read another's facts.
  for (const stage of ['interpret({', 'normalize(submission,', 'authorize(command,']) {
    assert.ok(source.includes(stage), `the root must call ${stage.slice(0, -1)})`);
  }
  assert.ok(source.includes('verdict.allow ? verdict.command : verdict.error'),
    'the root must treat a refusal as the command to report, never as its own branch');
  assert.ok(source.includes('runCommand(controller, executable'), 'the root must delegate command effects to runCommand');
  assert.ok(!/switch \(executable\.kind\)/.test(source), 'the root must not dispatch command kinds itself');
  assert.ok(!/executable\.kind ===/.test(source), 'the root must not branch on command kinds');
});

test('the front end applies effects but starts no business request of its own', () => {
  const source = readFileSync(join(SRC, 'ui/app.tsx'), 'utf8');
  // Two effects used to be triggered by the front end after reading a result: answering a pending
  // question, and starting the cost refresh when the panel opened. Both now run inside `execute`, so
  // the UI must not name them at all — a page that can start a host request is a second entry point
  // that no invariant covers.
  assert.ok(!source.includes('refreshCosts'), 'the cost refresh must start in the command, not in the UI');
  assert.ok(!/\.answer\s*\(/.test(source), 'completing a question must go through the application pipeline');
  // Admission is the pipeline's answer, not the front end's: the UI must not read the policy table to
  // decide whether a line may run while the client is busy (§3.4).
  assert.ok(!source.includes('isControlCommand') && !source.includes('COMMAND_POLICY'),
    'the UI must not decide admission from the policy table');
  // A result is applied by iterating its effects, never by branching on the command that produced it.
  assert.ok(source.includes('for (const effect of result.effects)'), 'the root must apply effects in order');
});

test('the foreground slot has one owner, so the front end keeps no operation state of its own', () => {
  const source = readFileSync(join(SRC, 'ui/app.tsx'), 'utf8');
  // §6.2: "what is running, what is it, and how do I cancel it" used to be split between the
  // controller's busy flag and a UI-owned abort controller, so Esc cancelled a different thing
  // depending on which layer started the work. Both live in the controller now.
  for (const shadow of ['historyAbort', 'historyLoading']) {
    assert.ok(!source.includes(shadow), `the UI must not keep its own ${shadow}`);
  }
  assert.ok(source.includes('controller.queries.foreground'), 'the UI renders the controller\'s slot');
  assert.ok(source.includes('controller.actions.cancelForeground'), 'the UI cancels through the controller');
  // The slot is compared, never negated into a constant: `!foreground !== undefined` is always true
  // (a boolean is not undefined), so a whole-file rewrite once left nineteen guards that quietly
  // stopped guarding anything — menus, keys and dialogs all stayed live while an operation owned the
  // client. The comparison has to be written the way it reads.
  assert.equal([...source.matchAll(/![\w.]*foreground !== undefined/g)].length, 0,
    'the UI must compare the foreground slot, not negate it into an always-true condition');
  // D2: one fact for "something is running" and one internal line for the last failure. The old
  // `state.operation` envelope carried both and let them drift apart.
  assert.ok(!source.includes('operation.busy') && !source.includes('operation.error'),
    'the operation envelope is gone; the slot and lastFailure are the facts');
});

test('Escape is decided by one ordered table, not by a chain of guards', () => {
  const source = readFileSync(join(SRC, 'ui/app.tsx'), 'utf8');
  // §5.4: the first rule whose condition holds wins. A chain let a surface ship with no Escape rule,
  // or with one placed after the fallback where it could never run.
  assert.ok(source.includes('const escapeRules'), 'the Escape rules must live in one table');
  assert.ok(source.includes('escapeRules.find('), 'the handler must consult the table in order');
  // Only copy mode (which owns the keyboard outright) and the table lookup itself may mention Escape:
  // no `key.escape && …` guard may decide anything before the table gets its say.
  assert.equal([...source.matchAll(/key\.escape &&/g)].length, 0, 'no Escape guard may bypass the table');
  assert.equal([...source.matchAll(/key\.escape/g)].length, 2, 'Escape may appear only in copy mode and the lookup');
});
