/** Pack and execute the published entry in a temporary npx installation, without publishing. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dsht-package-'));
const npm = process.env.npm_execpath;
assert(npm, 'Run this check with npm run test:package');
const run = (args, cwd) => exec(process.execPath, [npm, ...args], { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
try {
  const { stdout } = await run(['pack', '--json', '--pack-destination', root], new URL('../..', import.meta.url));
  const [pack] = JSON.parse(stdout);
  assert(pack.files.some(file => file.path === 'dist/cli/index.js'));
  assert(pack.files.some(file => file.path === 'dist/index.d.ts'));
  assert(pack.files.some(file => file.path === 'dsht-m.png'));
  assert(pack.files.some(file => file.path === 'loop.yaml'));
  assert(pack.files.some(file => file.path === 'LICENSE'));
  assert(pack.files.every(file => file.path.startsWith('dist/') || ['package.json', 'loop.yaml', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'dsht-m.png', 'LICENSE'].includes(file.path)));
  const result = await run(['exec', '--yes', '--offline', '--', `file:${join(root, pack.filename)}`, '--help'], root);
  assert.match(result.stdout, /Usage: dsht/);
  assert.match(result.stdout, /list workspaces/);
  // The packed entry must seed a runtime file from its shipped loop.yaml, then read that file.
  // The tarball is given this checkout's dependencies so the real dist module runs offline.
  const unpacked = join(root, 'unpacked');
  const packageRoot = join(unpacked, 'package');
  await mkdir(unpacked, { recursive: true });
  await exec('tar', ['-xzf', join(root, pack.filename), '-C', unpacked]);
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(packageRoot, 'node_modules'), 'dir');
  const probe = [
    `const { loadLoopSource } = await import(${JSON.stringify(join(packageRoot, 'dist', 'controller', 'loop-source.js'))});`,
    `const load = await loadLoopSource({ configDirectory: ${JSON.stringify(join(root, 'config'))} });`,
    `const { readFile } = await import('node:fs/promises');`,
    `const runtime = await readFile(${JSON.stringify(join(root, 'config', 'loop.yaml'))}, 'utf8');`,
    `if (load.info.builtin === undefined || load.info.file !== ${JSON.stringify(join(root, 'config', 'loop.yaml'))}`,
    `    || !load.source.protocols['design-review'] || !runtime.includes('design-review:'))`,
    `  throw new Error('the packed records were not read: ' + load.info.warnings.join(' '));`,
    `process.stdout.write(Object.keys(load.source.protocols).join(','));`,
  ].join('\n');
  const loaded = await exec(process.execPath, ['--input-type=module', '-e', probe], { cwd: packageRoot, timeout: 30_000 });
  assert.equal(loaded.stdout, 'design-review,designdoc-review');
  console.log(`Packed ${pack.filename}; isolated npx entry passed; config loop.yaml created and read.`);
} finally { await rm(root, { recursive: true, force: true }); }
