/** Architectural import rules: each directory is a boundary, not a file category. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Allowed target units per importing unit; a unit is a top-level directory or a root file. */
const UNITS: Record<string, readonly string[]> = {
  transport: ['transport'],
  session: ['transport', 'session', 'state.ts'],
  cost: ['transport', 'cost'],
  catalog: ['transport', 'catalog', 'state.ts'],
  controller: ['transport', 'session', 'cost', 'catalog', 'controller', 'state.ts'],
  ui: ['transport', 'session', 'cost', 'catalog', 'controller', 'ui', 'state.ts'],
  cli: ['transport', 'session', 'cost', 'catalog', 'controller', 'ui', 'cli', 'state.ts'],
  'state.ts': ['transport', 'session'],
  'index.ts': ['transport'],
};

/** Modules that may only appear inside the ui layer. */
const RENDERER_MODULES = new Set(['react', 'ink', 'ink-testing-library']);

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
    for (const spec of specifiers(file.source)) {
      if (spec.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(file.path), spec));
        if (target.startsWith('..')) { problems.push(`${file.path}: relative import escapes src (${spec})`); continue; }
        const targetUnit = unitOf(target);
        if (!allowed.includes(targetUnit)) problems.push(`${file.path}: ${unit} must not import ${targetUnit} (${spec})`);
        if (unit === 'ui' && target === 'transport/client.ts') problems.push(`${file.path}: ui must not call the transport client directly`);
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
  assert.deepEqual(violations([{ path: 'cost/format.ts', source: "import { useTheme } from '../ui/theme/index.ts';" }]),
    ['cost/format.ts: cost must not import ui (../ui/theme/index.ts)']);
  assert.deepEqual(violations([{ path: 'session/render.ts', source: "import { Box } from 'ink';" }]),
    ['session/render.ts: React/Ink belongs to the ui layer (ink)']);
  assert.deepEqual(violations([{ path: 'ui/panel.ts', source: "import { Client } from '../transport/client.ts';" }]),
    ['ui/panel.ts: ui must not call the transport client directly']);
  assert.deepEqual(violations([{ path: 'ui/app.ts', source: "import { Box } from 'ink';\nimport { Client } from '../transport/client.ts';\nimport { Controller } from '../controller/index.ts';\nimport { safeText } from '../transport/wire.ts';" }]),
    ['ui/app.ts: ui must not call the transport client directly']);
});
