/** The loop record source: the shipped file, a user overlay, the merged table and its fallback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { LOOP_PROMPTS } from '../../src/controller/loop-prompts.generated.ts';
import { installLoopSource, loopPrompts, loopSourceInfo } from '../../src/controller/loop-prompts.ts';
import { loopRecords } from '../../src/controller/loop-protocols.ts';
import { loadLoopSource, loopOverlayFile, shippedLoopFile }
  from '../../src/controller/loop-source.ts';
import { validateLoopOverlayPrompts } from '../../src/controller/loop-prompts-schema.ts';
import type { LoopProtocolText, LoopPromptSource } from '../../src/controller/loop-prompts-schema.ts';

/** One valid record, matching what the shipped file must contain. */
function protocol(overrides: Partial<LoopProtocolText> = {}): LoopProtocolText {
  return {
    title: 'Custom review', steps: 1, fallbackLabel: 'Round',
    rounds: [{ title: 'One', checks: 'do it' }],
    brief: ['Do the work', '{{checks}}'],
    followUp: ['Continue', '{{checks}}'],
    ...overrides,
  };
}

/** A shipped-style table holding one record per name. */
function shipped(names: string[]): LoopPromptSource {
  return { version: 1, defaults: { score: 8, tries: 10 },
    protocols: Object.fromEntries(names.map(name => [name, protocol({ title: `Shipped ${name}` })])) };
}

/** Run one body with a temporary directory, removed afterwards. */
async function withTemp<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-loop-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Write a loop file into a directory and return its path. */
async function writeLoopFile(directory: string, name: string, document: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, stringify(document), 'utf8');
  return path;
}

test('a missing config loop.yaml is created from the shipped file and then read at runtime', async () => {
  await withTemp(async directory => {
    const config = join(directory, 'config');
    const load = await loadLoopSource({ configDirectory: config });
    assert.equal(load.info.builtin, shippedLoopFile());
    assert.deepEqual(load.info.overridden, []);
    assert.deepEqual(load.info.added, []);
    assert.deepEqual(load.info.warnings, []);
    assert.equal(load.info.file, join(config, 'loop.yaml'));
    assert.equal(await readFile(join(config, 'loop.yaml'), 'utf8'), await readFile(shippedLoopFile(), 'utf8'));
    assert.deepEqual(Object.keys(load.source.protocols), ['design-review', 'designdoc-review']);
  });
});

test('a shipped update changes only unedited records and defaults in the config file', async () => {
  await withTemp(async directory => {
    const builtInFile = await writeLoopFile(directory, 'shipped.yaml', shipped(['a', 'b']));
    const config = join(directory, 'config');
    const options = { configDirectory: config, builtinFile: builtInFile };
    await loadLoopSource(options);
    const original = shipped(['a', 'b']);
    const reordered = Object.fromEntries(Object.entries(original.protocols.a!).reverse()) as unknown as LoopProtocolText;
    const edited = { ...original, protocols: { ...original.protocols, a: reordered,
      b: protocol({ title: 'My b' }), mine: protocol({ title: 'Mine' }) }, defaults: { score: 9, tries: 10 } };
    await writeFile(join(config, 'loop.yaml'), stringify(edited));
    const updated = shipped(['a', 'b', 'c']);
    const next = { ...updated, protocols: { ...updated.protocols,
      a: protocol({ title: 'New a' }), b: protocol({ title: 'New b' }) }, defaults: { score: 7, tries: 12 } };
    await writeFile(builtInFile, stringify(next));
    const load = await loadLoopSource(options);
    assert.equal(load.source.protocols.a!.title, 'New a');
    assert.equal(load.source.protocols.b!.title, 'My b');
    assert.equal(load.source.protocols.c!.title, 'Shipped c');
    assert.equal(load.source.protocols.mine!.title, 'Mine');
    assert.deepEqual(load.source.defaults, { score: 9, tries: 12 });
    assert.deepEqual(load.info.overridden, ['b']);
    assert.deepEqual(load.info.added, ['mine']);
    assert.match(load.info.warnings[0]!, /shipped record that changed/);
    const persisted = parse(await readFile(join(config, 'loop.yaml'), 'utf8')) as LoopPromptSource;
    assert.deepEqual(persisted, load.source);
    assert.deepEqual((await loadLoopSource(options)).info.warnings, []);
  });
});

test('a user file adds records and replaces shipped ones, one record at a time', async () => {
  await withTemp(async directory => {
    const overlay = await writeLoopFile(directory, 'loop.yaml', {
      version: 1,
      protocols: {
        'design-review': protocol({ title: 'My design review' }),
        'my-review': protocol({ title: 'My review' }),
      },
    });
    const load = await loadLoopSource({ configDirectory: directory });
    assert.equal(load.info.file, overlay);
    assert.deepEqual(load.info.overridden, ['design-review']);
    assert.deepEqual(load.info.added, ['my-review']);
    // The runtime file keeps its existing order; newly supplied shipped records are appended.
    assert.deepEqual(Object.keys(load.source.protocols), ['design-review', 'my-review', 'designdoc-review']);
    assert.equal(load.source.protocols['design-review']!.title, 'My design review');
    assert.equal(load.source.protocols['designdoc-review']!.title, LOOP_PROMPTS.protocols['designdoc-review'].title);
  });
});

test('a user file may move the global defaults without touching a record', async () => {
  await withTemp(async directory => {
    await writeLoopFile(directory, 'loop.yaml', { version: 1, defaults: { score: 9 } });
    const load = await loadLoopSource({ configDirectory: directory });
    assert.equal(load.source.defaults.score, 9);
    assert.equal(load.source.defaults.tries, 10);
    assert.deepEqual(load.info.overridden, []);
    assert.deepEqual(load.info.added, []);
  });
});

test('an explicit file wins over the configuration directory', async () => {
  await withTemp(async directory => {
    const explicit = await writeLoopFile(directory, 'other.yaml', { version: 1,
      protocols: { 'my-review': protocol() } });
    // A loop.yaml that would otherwise be read, to prove the explicit file is the one taken.
    await writeLoopFile(directory, 'loop.yaml', { version: 1, protocols: { ignored: protocol() } });
    const options = { configDirectory: directory, overlayFile: explicit };
    assert.equal(loopOverlayFile(options), explicit);
    const load = await loadLoopSource(options);
    assert.deepEqual(load.info.added, ['my-review']);
    assert.deepEqual(Object.keys(load.source.protocols).includes('ignored'), false);
  });
});

test('an invalid user file stops the client and names the file and the field', async () => {
  await withTemp(async directory => {
    const path = join(directory, 'loop.yaml');
    // The renderer cannot tell a user record from a shipped one, so the rules are the same ones.
    await writeFile(path, stringify({ version: 1, protocols: { 'my-review': protocol({ brief: ['{{nope}}'] }) } }), 'utf8');
    await assert.rejects(loadLoopSource({ configDirectory: directory }),
      (error: Error) => error.message.includes(path) && error.message.includes('unknown placeholder {{nope}}'));
  });
});

test('an unparseable user file is refused with its path', async () => {
  await withTemp(async directory => {
    const path = join(directory, 'loop.yaml');
    await writeFile(path, 'version: 1\nprotocols: [unclosed\n', 'utf8');
    await assert.rejects(loadLoopSource({ configDirectory: directory }),
      (error: Error) => error.message.startsWith(path));
  });
});

test('a shipped file that cannot be read falls back to the compiled-in records', async () => {
  await withTemp(async directory => {
    const fallback = shipped(['fallback']);
    const load = await loadLoopSource({ configDirectory: directory,
      builtinFile: join(directory, 'missing.yaml'), fallback });
    assert.deepEqual(Object.keys(load.source.protocols), ['fallback']);
    assert.equal(load.info.builtin, undefined);
    assert.equal(load.info.warnings.length, 1);
    assert.match(load.info.warnings[0]!, /Cannot read the shipped records/);
  });
});

test('a shipped file that is not a loop file falls back with the reason', async () => {
  await withTemp(async directory => {
    const broken = await writeLoopFile(directory, 'shipped.yaml',
      { version: 1, defaults: { score: 8, tries: 10 }, protocols: {} });
    const load = await loadLoopSource({ configDirectory: directory, builtinFile: broken, fallback: shipped(['fallback']) });
    assert.deepEqual(Object.keys(load.source.protocols), ['fallback']);
    assert.match(load.info.warnings[0]!, /are invalid: .*protocols must be a non-empty mapping/);
  });
});

test('a shipped record changed under an override is reported, and the override still wins', async () => {
  await withTemp(async directory => {
    const shippedFile = await writeLoopFile(directory, 'shipped.yaml', shipped(['mine']));
    await writeLoopFile(directory, 'loop.yaml', { version: 1, protocols: { mine: protocol({ title: 'Mine' }) } });
    const options = { configDirectory: directory, builtinFile: shippedFile };
    const first = await loadLoopSource(options);
    assert.deepEqual(first.info.warnings, []);
    assert.equal(first.source.protocols['mine']!.title, 'Mine');
    // The next version ships a different definition of the record this install overrides. The file
    // still wins — the operator wrote it — but the update it will never receive is now visible.
    await writeFile(shippedFile, stringify(shipped(['mine'])).replace('Shipped mine', 'Shipped mine v2'), 'utf8');
    const second = await loadLoopSource(options);
    assert.equal(second.source.protocols['mine']!.title, 'Mine');
    assert.equal(second.info.warnings.length, 1);
    assert.match(second.info.warnings[0]!, /replaces a shipped record that changed in this version/);
    assert.match(second.info.warnings[0]!, /loop\.yaml/);
    // The change is reported once, not on every later start.
    const third = await loadLoopSource(options);
    assert.deepEqual(third.info.warnings, []);
  });
});

test('an installed source is what /loop lists and runs, and marks the user records', async () => {
  await withTemp(async directory => {
    await writeLoopFile(directory, 'loop.yaml', { version: 1, protocols: {
      'design-review': protocol({ title: 'My design review' }),
      'my-review': protocol({ title: 'My review' }),
    } });
    const load = await loadLoopSource({ configDirectory: directory });
    installLoopSource(load.source, load.info);
    try {
      assert.deepEqual(loopPrompts().names, ['design-review', 'my-review', 'designdoc-review']);
      assert.equal(loopPrompts().find('design-review')!.title, 'My design review');
      const records = loopRecords();
      assert.equal(records.find(record => record.name === 'my-review')!.fromFile, true);
      assert.equal(records.find(record => record.name === 'design-review')!.fromFile, true);
      assert.equal(records.find(record => record.name === 'designdoc-review')!.fromFile, undefined);
      assert.deepEqual([...loopSourceInfo().added], ['my-review']);
    } finally {
      installLoopSource(LOOP_PROMPTS as unknown as LoopPromptSource, { overridden: [], added: [], warnings: [] });
    }
    assert.deepEqual(loopPrompts().names, ['design-review', 'designdoc-review']);
  });
});

test('an overlay may be partial; a record it declares is held to every shipped rule', () => {
  // Nothing to change yet is valid: a file being written is not a broken file.
  assert.deepEqual(validateLoopOverlayPrompts({ version: 1 }), []);
  assert.deepEqual(validateLoopOverlayPrompts({ version: 1, defaults: { score: 7 } }), []);
  assert.deepEqual(validateLoopOverlayPrompts({ version: 1, protocols: {} }), []);
  // A version this build does not read fails loudly instead of having its fields misread as version 1.
  assert.deepEqual(validateLoopOverlayPrompts({ protocols: {} }), ['version must be 1']);
  assert.deepEqual(validateLoopOverlayPrompts({ version: 2, protocols: {} }), ['version must be 1']);
  // A default that reaches a real run is range-checked, unlike the shipped file's numeric-only rule.
  assert.deepEqual(validateLoopOverlayPrompts({ version: 1, defaults: { score: 42 } }),
    ['defaults.score must be a number in 0-10']);
  assert.deepEqual(validateLoopOverlayPrompts({ version: 1, defaults: { tries: 0 } }),
    ['defaults.tries must be a positive integer']);
  // The record rules are the shipped ones: reserved names, rounds against steps, known placeholders.
  const errors = validateLoopOverlayPrompts({ version: 1, protocols: {
    stop: protocol(),
    broken: protocol({ steps: 2 }),
  } });
  assert.ok(errors.some(message => message.includes('protocols.stop is a reserved name')));
  assert.ok(errors.some(message => message.includes('protocols.broken.rounds has 1 entries but steps is 2')));
});
