/** Saved shortcut prompts: validation, ordering and the private file they persist in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_PROMPT_CHARS, PromptStore } from '../../src/controller/prompts.ts';
import { installPromptSource, migrateLegacyPromptFile, shippedPromptFile } from '../../src/controller/prompt-source.ts';
import { Controller } from '../../src/controller/index.ts';

test('shortcut prompt actions work offline and publish local errors', async t => {
  const app = new Controller({ base: 'http://localhost' });
  t.after(() => app.stop());
  assert.equal(app.snapshot().online, false);
  assert.equal(await app.actions.savePrompt('Review this code'), true);
  const id = app.queries.prompts[0]!.id;
  assert.equal(await app.actions.updatePrompt(id, 'Review the tests'), true);
  assert.equal(app.queries.prompts[0]!.text, 'Review the tests');
  assert.equal(await app.actions.updatePrompt('missing', 'Anything'), false);
  assert.match(app.snapshot().lastFailure, /no longer exists/);
  assert.equal(await app.actions.deletePrompt(id), true);
  assert.equal(app.snapshot().lastFailure, '');
  assert.deepEqual(app.queries.prompts, []);
});

test('an in-memory store saves, deduplicates, updates and removes prompts', async () => {
  const store = new PromptStore();
  const first = await store.save('Explain this code');
  assert.equal(first.text, 'Explain this code');
  assert.ok(first.id.length > 0);
  // Trimming happens on the way in, and an identical text is returned rather than duplicated.
  assert.equal((await store.save('  Explain this code  ')).id, first.id);
  const second = await store.save('Review for bugs');
  assert.deepEqual(store.list.map(item => item.text), ['Explain this code', 'Review for bugs']);
  assert.equal(await store.update(second.id, 'Review this change for bugs'), true);
  assert.deepEqual(store.list.map(item => item.text), ['Explain this code', 'Review this change for bugs']);
  // Updating keeps the entry where it was, and an unknown identity reports failure rather than adding.
  assert.equal(await store.update('missing', 'anything'), false);
  assert.equal(await store.remove(first.id), true);
  assert.equal(await store.remove(first.id), false);
  assert.deepEqual(store.list.map(item => item.text), ['Review this change for bugs']);
});

test('saved prompts survive a reload from the private file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'prompts.json');
  const store = new PromptStore({ local: path });
  // A missing file loads nothing, which is not a change worth republishing.
  assert.equal(await store.load(), false);
  await store.save('Fix this bug and add tests');
  await store.save('Optimize without changing API');
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.prompts.length, 2);
  // The written file is what the next run reads back, in the same order, and it reports the change.
  const reloaded = new PromptStore({ local: path });
  assert.equal(await reloaded.load(), true);
  assert.equal(reloaded.error, undefined);
  assert.deepEqual(reloaded.list.map(item => item.text), ['Fix this bug and add tests', 'Optimize without changing API']);
  // Reading once is enough; a second call never republishes.
  assert.equal(await reloaded.load(), false);
});

test('a write that cannot land leaves the in-memory list unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A directory where the file belongs makes both the read and the atomic rename fail.
  const path = join(directory, 'prompts.json');
  await mkdir(path);
  const store = new PromptStore({ local: path });
  await store.load();
  assert.match(store.error ?? '', /could not be read/);
  await assert.rejects(() => store.save('dropped'));
  assert.deepEqual(store.list, []);
});

test('a malformed prompts file is reported without failing the client', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'prompts.json');
  await writeFile(path, '{ this is not json');
  const store = new PromptStore({ local: path });
  // A recorded error is itself a change the picker must be able to show.
  assert.equal(await store.load(), true);
  assert.deepEqual(store.list, []);
  assert.match(store.error ?? '', /could not be read/);
  // A syntactically valid document with unusable rows keeps only the rows this build understands.
  await writeFile(path, JSON.stringify({ version: 1, prompts: [{ id: 'a', text: 'keep me' }, { id: 2, text: 'drop' }, { text: 'drop too' }] }));
  const partial = new PromptStore({ local: path });
  assert.equal(await partial.load(), true);
  assert.equal(partial.error, undefined);
  assert.deepEqual(partial.list, [{ id: 'a', text: 'keep me' }]);
});

test('empty and oversized prompts are rejected before they reach the list', async () => {
  const store = new PromptStore();
  await assert.rejects(() => store.save('   '), /Type a prompt/);
  await assert.rejects(() => store.save('x'.repeat(MAX_PROMPT_CHARS + 1)), /limited to/);
  const saved = await store.save('y'.repeat(MAX_PROMPT_CHARS));
  assert.equal(saved.text.length, MAX_PROMPT_CHARS);
});

test('queued mutations never interleave, so the file always matches the list', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'prompts.json');
  const store = new PromptStore({ local: path });
  const texts = Array.from({ length: 12 }, (_, index) => `prompt-${index}`);
  // Fired without awaiting: only a serialized compute+write keeps the last write authoritative.
  const saved = await Promise.all(texts.map(text => store.save(text)));
  assert.deepEqual(store.list.map(item => item.text), texts);
  const reloaded = new PromptStore({ local: path });
  await reloaded.load();
  assert.deepEqual(reloaded.list.map(item => item.text), texts);
  // Concurrent deletes all land, and the file still matches memory.
  const gone = new Set([0, 5, 11]);
  await Promise.all([...gone].map(index => store.remove(saved[index]!.id)));
  const kept = texts.filter((_, index) => !gone.has(index));
  assert.deepEqual(store.list.map(item => item.text), kept);
  const after = new PromptStore({ local: path });
  await after.load();
  assert.deepEqual(after.list.map(item => item.text), kept);
});

test('a failed mutation does not stall the queue behind it', async () => {
  const store = new PromptStore();
  await assert.rejects(() => store.save('x'.repeat(MAX_PROMPT_CHARS + 1)));
  const accepted = await store.save('after the failure');
  assert.equal(accepted.text, 'after the failure');
  assert.deepEqual(store.list.map(item => item.text), ['after the failure']);
});

test('the installed defaults come first in the file and the list shows the operator first', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'prompt.json');
  const local = join(directory, 'prompt.local.json');
  await writeFile(installed, JSON.stringify({ version: 1, prompts: [{ id: 'i1', text: 'Shipped one' }, { id: 'i2', text: 'Shipped two' }] }));
  await writeFile(local, JSON.stringify({ version: 1, prompts: [{ id: 'l1', text: 'Mine' }] }));
  const store = new PromptStore({ installed, local });
  assert.equal(await store.load(), true);
  // The operator's own entries lead; the installed ones follow, marked so the picker can say where they
  // came from. The same identity and the same text both hide an installed entry.
  assert.deepEqual(store.list, [{ id: 'l1', text: 'Mine' }, { id: 'i1', text: 'Shipped one', installed: true },
    { id: 'i2', text: 'Shipped two', installed: true }]);
  await writeFile(local, JSON.stringify({ version: 1, prompts: [{ id: 'l1', text: 'Mine' }, { id: 'i1', text: 'Mine again' }] }));
  const shadowed = new PromptStore({ installed, local });
  await shadowed.load();
  assert.deepEqual(shadowed.list.map(item => `${item.text}${item.installed ? ' (installed)' : ''}`),
    ['Mine', 'Mine again', 'Shipped two (installed)']);
});

test('editing or deleting an installed entry writes the operator file, never the installed one', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'prompt.json');
  const local = join(directory, 'prompt.local.json');
  const original = JSON.stringify({ version: 1, prompts: [{ id: 'i1', text: 'Shipped one' }, { id: 'i2', text: 'Shipped two' }] });
  await writeFile(installed, original);
  const store = new PromptStore({ installed, local });
  await store.load();
  // An edit becomes a local override under the same identity: the default is shadowed, not rewritten.
  assert.equal(await store.update('i1', 'Shipped one, edited'), true);
  assert.deepEqual(store.list.map(item => item.text), ['Shipped one, edited', 'Shipped two']);
  assert.equal(await readFile(installed, 'utf8'), original);
  // A delete of the other default is remembered as hidden, so it stays gone after a reload.
  assert.equal(await store.remove('i2'), true);
  assert.equal(await store.remove('i2'), false);
  assert.deepEqual(store.list.map(item => item.text), ['Shipped one, edited']);
  const reloaded = new PromptStore({ installed, local });
  await reloaded.load();
  assert.deepEqual(reloaded.list.map(item => item.text), ['Shipped one, edited']);
  // Deleting an entry of the operator's own override removes the row for good: the default it shadowed
  // does not reappear, because the operator deleted the row they could see.
  assert.equal(await reloaded.remove(reloaded.list[0]!.id), true);
  assert.equal(reloaded.list.length, 0);
  const document = JSON.parse(await readFile(local, 'utf8')) as { prompts: unknown[]; hidden?: string[] };
  assert.deepEqual(document.prompts, []);
  // Both deletions are remembered: the earlier one of the other default, and this one of the override.
  assert.deepEqual([...(document.hidden ?? [])].sort(), ['i1', 'i2']);
});

test('saving the text of a hidden default brings it back as the operator s own', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'prompt.json');
  const local = join(directory, 'prompt.local.json');
  await writeFile(installed, JSON.stringify({ version: 1, prompts: [{ id: 'i1', text: 'Shipped one' }] }));
  const store = new PromptStore({ installed, local });
  await store.load();
  assert.equal(await store.remove('i1'), true);
  assert.equal(store.list.length, 0);
  const saved = await store.save('Shipped one');
  assert.equal(saved.installed, undefined);
  assert.deepEqual(store.list.map(item => item.text), ['Shipped one']);
  // One identity, one row: the installed entry does not come back beside it.
  assert.equal(store.list.length, 1);
});

test('the shipped defaults install once and a legacy saved-prompt file moves into the local layer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config');
  const first = await installPromptSource({ configDirectory: config, shippedFile: shippedPromptFile() });
  assert.equal(first.info.created, join(config, 'prompt.json'));
  assert.deepEqual(first.info.warnings, []);
  const shipped = JSON.parse(await readFile(join(config, 'prompt.json'), 'utf8')) as { prompts: { id: string; text: string; top?: boolean }[] };
  assert.ok(shipped.prompts.length >= 1);
  // The record `/handoff` used to send is the first shipped shortcut, because that is the request the
  // operator repeats most: the command is gone, the prompt it sent is not.
  // The handoff request is used in almost every session, so the shipped file pins it above everything.
  // Its wording is Chinese; the document it asks for follows the language of the conversation.
  assert.match(shipped.prompts[0]!.text, /HANDOFF\.md/);
  assert.match(shipped.prompts[0]!.text, /交接/);
  assert.match(shipped.prompts[0]!.text, /使用本次对话的语言/);
  assert.equal(shipped.prompts[0]!.top, true);
  // A shipped change reaches an install that already exists: the installed file is ours, so it is kept
  // equal to the shipped set, and an entry it held that the shipped set does not provide moves into the
  // operator's layer rather than being dropped.
  await writeFile(join(config, 'prompt.json'), JSON.stringify({ version: 1, prompts: [
    { id: 'keep', text: 'Mine, in the wrong file' }, ...shipped.prompts] }));
  const again = await installPromptSource({ configDirectory: config, shippedFile: shippedPromptFile() });
  assert.equal(again.info.created, undefined);
  assert.equal(again.info.updated, join(config, 'prompt.json'));
  assert.deepEqual(again.info.adopted, ['keep']);
  const refreshed = JSON.parse(await readFile(join(config, 'prompt.json'), 'utf8')) as { prompts: { id: string; top?: boolean }[] };
  assert.deepEqual(refreshed.prompts.map(item => item.id), shipped.prompts.map(item => item.id));
  assert.equal(refreshed.prompts[0]!.top, true, 'the shipped marker arrives with the refresh');
  const carried = new PromptStore(again.paths);
  await carried.load();
  // The pinned shipped record leads, the adopted entry follows it, and the rest keep the shipped order.
  assert.deepEqual(carried.list.map(item => item.text),
    [shipped.prompts[0]!.text, 'Mine, in the wrong file', ...shipped.prompts.slice(1).map(item => item.text)]);
  // The adopted entry is the operator's from now on: a second install finds the shipped set in place
  // and changes nothing.
  const settled = await installPromptSource({ configDirectory: config, shippedFile: shippedPromptFile() });
  assert.equal(settled.info.updated, undefined);
  assert.deepEqual(settled.info.adopted, []);
});

test('a pinned default and a pinned entry of the operator s own lead, in that order', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'prompt.json');
  const local = join(directory, 'prompt.local.json');
  await writeFile(installed, JSON.stringify({ version: 1, prompts: [
    { id: 'handoff', text: 'Write the handoff', top: true },
    { id: 'a', text: 'Shipped a' }, { id: 'b', text: 'Shipped b', top: true }] }));
  await writeFile(local, JSON.stringify({ version: 1, prompts: [
    { id: 'mine', text: 'Mine, pinned', top: true }, { id: 'other', text: 'Mine' },
    { id: 'a', text: 'My a' }] }));
  const store = new PromptStore({ installed, local });
  await store.load();
  // Pinned rows first — the operator's own pin before the shipped ones — then their unpinned entry, then
  // the installed file's own order with the override in place.
  assert.deepEqual(store.list.map(item => item.text), ['Mine, pinned', 'Write the handoff', 'Shipped b', 'Mine', 'My a']);
  // A `top: false` in the operator's file demotes a pinned default: the row falls back to its installed
  // place, and a marker only there counts — a copy that matches the installed row says nothing.
  await writeFile(local, JSON.stringify({ version: 1, prompts: [
    { id: 'handoff', text: 'Write the handoff', top: false }, { id: 'a', text: 'Shipped a' }] }));
  const demoted = new PromptStore({ installed, local });
  await demoted.load();
  assert.deepEqual(demoted.list.map(item => item.text), ['Shipped b', 'Write the handoff', 'Shipped a']);
  assert.deepEqual(demoted.list.map(item => item.installed === true), [true, false, true]);
});

test('a pinned entry keeps its marker through a save or an edit of another entry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'prompt.local.json');
  await writeFile(path, JSON.stringify({ version: 1, prompts: [
    { id: 'one', text: 'First', top: true }, { id: 'two', text: 'Second' }] }));
  const store = new PromptStore({ local: path });
  await store.load();
  assert.deepEqual(store.list.map(item => item.top), [true, undefined]);
  await store.update('two', 'Second, edited');
  await store.save('Third');
  assert.equal(store.list.length, 3);
  const document = JSON.parse(await readFile(path, 'utf8')) as { prompts: { id: string; top?: boolean }[] };
  assert.deepEqual(document.prompts.map(item => `${item.id}:${item.top ?? '-'}`), ['one:true', 'two:-', `${document.prompts[2]!.id}:-`]);
  assert.deepEqual(store.list.map(item => item.text), ['First', 'Second, edited', 'Third']);
});

test('the installed order is the backbone, so a shadowed entry stays where prompt.json put it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'prompt.json');
  const local = join(directory, 'prompt.local.json');
  await writeFile(installed, JSON.stringify({ version: 1, prompts: [
    { id: 'handoff', text: 'Write the handoff' }, { id: 'a', text: 'Shipped a' }, { id: 'b', text: 'Shipped b' }] }));
  // The shape a migration used to leave behind: byte-identical copies of two installed entries.
  await writeFile(local, JSON.stringify({ version: 1, prompts: [
    { id: 'a', text: 'Shipped a' }, { id: 'b', text: 'Shipped b' }] }));
  const store = new PromptStore({ installed, local });
  await store.load();
  // Nothing is reordered and nothing is duplicated: an identical copy neither leads nor shadows, so the
  // operator sees exactly the installed file's order and a later shipped update still reaches it.
  assert.deepEqual(store.list.map(item => item.id), ['handoff', 'a', 'b']);
  assert.equal(store.list.every(item => item.installed === true), true);
  // An edit keeps the same place — it does not jump to the front — and only that row is the operator's.
  assert.equal(await store.update('a', 'My a'), true);
  const edited = new PromptStore({ installed, local });
  await edited.load();
  assert.deepEqual(edited.list.map(item => `${item.id}${item.installed === true ? '*' : ''}`), ['handoff*', 'a', 'b*']);
  // An entry of the operator's own with no installed counterpart leads: it is the one thing in the list
  // that exists only because they added it, while everything else keeps prompt.json's order.
  const mine = await edited.save('Mine only');
  assert.deepEqual(edited.list.map(item => item.id), [mine.id, 'handoff', 'a', 'b']);
  assert.deepEqual(edited.list.map(item => item.text), ['Mine only', 'Write the handoff', 'My a', 'Shipped b']);
});

test('the migration leaves out entries the installed defaults already provide', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config');
  const install = await installPromptSource({ configDirectory: config, shippedFile: shippedPromptFile() });
  const shipped = (JSON.parse(await readFile(join(config, 'prompt.json'), 'utf8')) as { prompts: { id: string; text: string }[] }).prompts;
  const legacy = join(directory, 'state', 'prompts.json');
  await mkdir(join(directory, 'state'), { recursive: true });
  // The old file holds the shipped entries (the shipped file came from it) plus one of the operator's.
  await writeFile(legacy, JSON.stringify({ version: 1, prompts: [...shipped, { id: 'mine', text: 'Only mine' }] }));
  assert.equal(await migrateLegacyPromptFile(legacy, install.paths.local, install.paths.installed), legacy);
  const moved = JSON.parse(await readFile(install.paths.local!, 'utf8')) as { prompts: { id: string }[] };
  assert.deepEqual(moved.prompts.map(item => item.id), ['mine']);
  // A legacy file that only repeats the shipped defaults creates no local layer at all.
  const second = join(directory, 'config2');
  const other = await installPromptSource({ configDirectory: second, shippedFile: shippedPromptFile() });
  const duplicate = join(directory, 'state2', 'prompts.json');
  await mkdir(join(directory, 'state2'), { recursive: true });
  await writeFile(duplicate, JSON.stringify({ version: 1, prompts: shipped }));
  assert.equal(await migrateLegacyPromptFile(duplicate, other.paths.local, other.paths.installed), undefined);
  await assert.rejects(() => readFile(other.paths.local!, 'utf8'), /ENOENT/);
});
