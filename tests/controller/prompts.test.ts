/** Saved shortcut prompts: validation, ordering and the private file they persist in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_PROMPT_CHARS, PromptStore } from '../../src/controller/prompts.ts';
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
  const store = new PromptStore(path);
  // A missing file loads nothing, which is not a change worth republishing.
  assert.equal(await store.load(), false);
  await store.save('Fix this bug and add tests');
  await store.save('Optimize without changing API');
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.prompts.length, 2);
  // The written file is what the next run reads back, in the same order, and it reports the change.
  const reloaded = new PromptStore(path);
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
  const store = new PromptStore(path);
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
  const store = new PromptStore(path);
  // A recorded error is itself a change the picker must be able to show.
  assert.equal(await store.load(), true);
  assert.deepEqual(store.list, []);
  assert.match(store.error ?? '', /could not be read/);
  // A syntactically valid document with unusable rows keeps only the rows this build understands.
  await writeFile(path, JSON.stringify({ version: 1, prompts: [{ id: 'a', text: 'keep me' }, { id: 2, text: 'drop' }, { text: 'drop too' }] }));
  const partial = new PromptStore(path);
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
  const store = new PromptStore(path);
  const texts = Array.from({ length: 12 }, (_, index) => `prompt-${index}`);
  // Fired without awaiting: only a serialized compute+write keeps the last write authoritative.
  const saved = await Promise.all(texts.map(text => store.save(text)));
  assert.deepEqual(store.list.map(item => item.text), texts);
  const reloaded = new PromptStore(path);
  await reloaded.load();
  assert.deepEqual(reloaded.list.map(item => item.text), texts);
  // Concurrent deletes all land, and the file still matches memory.
  const gone = new Set([0, 5, 11]);
  await Promise.all([...gone].map(index => store.remove(saved[index]!.id)));
  const kept = texts.filter((_, index) => !gone.has(index));
  assert.deepEqual(store.list.map(item => item.text), kept);
  const after = new PromptStore(path);
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
