/** Heap-snapshot naming and the injected writer behind `/coredump`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';
import { heapSnapshotName, writeHeapSnapshot } from '../../src/storage/heap-snapshot.ts';

test('a snapshot filename keeps its tag inside one directory', () => {
  assert.equal(heapSnapshotName('point-A-baseline', 1_700_000_000_000), 'point-A-baseline-1700000000000.heapsnapshot');
  assert.equal(heapSnapshotName('after stress', 7), 'after-stress-7.heapsnapshot');
  assert.equal(heapSnapshotName('../../etc/passwd', 8), 'etc-passwd-8.heapsnapshot');
  assert.equal(heapSnapshotName('.hidden.', 9), 'hidden-9.heapsnapshot');
  assert.equal(heapSnapshotName('   ', 10), 'snapshot-10.heapsnapshot');
  assert.equal(heapSnapshotName('-', 11), 'snapshot-11.heapsnapshot');
});

test('an overlong tag is bounded before it reaches the filename', () => {
  assert.equal(heapSnapshotName('x'.repeat(200), 12), `${'x'.repeat(48)}-12.heapsnapshot`);
});

test('writing a snapshot joins the directory and delegates the write', () => {
  const written: string[] = [];
  const path = writeHeapSnapshot('/tmp/dsht', 'after-stress', file => { written.push(file); return file; });
  assert.deepEqual(written, [path]);
  assert.equal(dirname(path), '/tmp/dsht');
  assert.match(basename(path), /^after-stress-\d+\.heapsnapshot$/);
});

test('a snapshot defaults to the snapshot tag', () => {
  const path = writeHeapSnapshot('/tmp/dsht', undefined, file => file);
  assert.match(basename(path), /^snapshot-\d+\.heapsnapshot$/);
});
