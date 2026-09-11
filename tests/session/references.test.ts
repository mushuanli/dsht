/** Pin the independent client's path syntax to Harness's path-only mentions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeReference, fileMention, fileReferences } from '../../src/session/references.ts';

test('finds trailing mentions without treating emails or closed quotes as queries', () => {
  assert.equal(activeReference('email a@b.com'), undefined);
  assert.equal(activeReference('read @"hello world.ts"'), undefined);
  assert.equal(activeReference('read @src/a.ts next'), undefined);
  assert.deepEqual(activeReference('read @src/'), { prefix: '@src/', query: 'src/', quoted: false });
  assert.deepEqual(activeReference('read @"hello world'), { prefix: '@"hello world', query: 'hello world', quoted: true });
});

test('quotes spaced paths and keeps directory descent open', () => {
  assert.equal(fileMention({ kind: 'file', path: 'src/a.ts' }), '@src/a.ts');
  assert.equal(fileMention({ kind: 'file', path: 'src/a.ts' }, true), '@"src/a.ts"');
  assert.equal(fileMention({ kind: 'file', path: 'hello world.ts' }), '@"hello world.ts"');
  assert.equal(fileMention({ kind: 'directory', path: 'hello world' }), '@"hello world/');
  assert.equal(fileMention({ kind: 'directory', path: 'src' }), '@src/');
});

test('rejects malformed remote rows and hides unrepresentable paths', () => {
  assert.throws(() => fileReferences({ items: [] }), /array/);
  assert.throws(() => fileReferences([{ path: 'x', kind: 'unknown' }]), /kind/);
  assert.throws(() => fileReferences([{ path: 1, kind: 'file' }]), /string/);
  assert.deepEqual(fileReferences([
    { path: 'a\nb', kind: 'file' }, { path: 'a"b', kind: 'file' },
    { path: '\u001b[31mred', kind: 'file' }, { path: 'README.md', kind: 'file' },
  ]), [{ path: 'README.md', kind: 'file' }]);
});
