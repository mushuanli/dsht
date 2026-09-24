/** Generate src/controller/loop-prompts.generated.ts from loop.yaml.
 *
 * `loop.yaml` is the editable source and the file the client reads at runtime: it travels in the
 * package and a user file layers over it. This module compiles the same records into TypeScript so a
 * package whose data file is missing or corrupt still starts on the table this build was made with.
 * The generated module is committed; `npm test` fails when it is stale, so a YAML edit cannot be
 * forgotten. Run through `npm run build:prompts` (tsx), which is why this file is TypeScript.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateLoopPrompts } from '../../src/controller/loop-prompts-schema.ts';

const SOURCE = 'loop.yaml';
const TARGET = 'src/controller/loop-prompts.generated.ts';

const source = parse(readFileSync(SOURCE, 'utf8')) as unknown;
const errors = validateLoopPrompts(source);
if (errors.length > 0) {
  console.error(`${SOURCE}:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  const body = '// GENERATED FILE — do not edit. Edit loop.yaml and run `npm run build:prompts`.\n'
    + '// The fallback table: loop.yaml is read at runtime, and this is what a package whose file is\n'
    + '// missing or unreadable starts on. Kept in sync by tests/controller/loop-prompts.test.ts.\n\n'
    + `export const LOOP_PROMPTS = ${JSON.stringify(source, null, 2)} as const;\n`;
  let current: string | undefined;
  try { current = readFileSync(TARGET, 'utf8'); } catch { current = undefined; }
  // Progress goes to stderr: `npm pack --json` (and `test:package`) parses stdout, and prepack runs this.
  if (current === body) process.stderr.write(`${TARGET} is up to date\n`);
  else { writeFileSync(TARGET, body); process.stderr.write(`wrote ${TARGET}\n`); }
}
