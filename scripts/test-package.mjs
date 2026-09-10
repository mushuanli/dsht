/** Pack and execute the published entry in a temporary npx installation, without publishing. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dsh-tui-package-'));
const npm = process.env.npm_execpath;
assert(npm, 'Run this check with npm run test:package');
const run = (args, cwd) => exec(process.execPath, [npm, ...args], { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
try {
  const { stdout } = await run(['pack', '--json', '--pack-destination', root], new URL('..', import.meta.url));
  const [pack] = JSON.parse(stdout);
  assert(pack.files.some(file => file.path === 'dist/cli.js'));
  assert(pack.files.some(file => file.path === 'dist/client.d.ts'));
  assert(pack.files.every(file => file.path.startsWith('dist/') || ['package.json', 'README.md', 'README.zh.md', 'README.i18n.yaml'].includes(file.path)));
  const result = await run(['exec', '--yes', '--offline', '--', `file:${join(root, pack.filename)}`, '--help'], root);
  assert.match(result.stdout, /Usage: dsh-tui/);
  assert.match(result.stdout, /list workspaces/);
  console.log(`Packed ${pack.filename}; isolated npx entry passed.`);
} finally { await rm(root, { recursive: true, force: true }); }
