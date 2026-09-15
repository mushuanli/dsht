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
    'text.ts', 'json.ts', 'contracts.ts', 'slash'],
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
