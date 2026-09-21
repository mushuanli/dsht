/** The bridge from a loop.yaml record to the protocol the scored loop runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loopProtocolFor, loopProtocolNames, loopRecordVars, loopRecords } from '../../src/controller/loop-protocols.ts';
import { resultContract } from '../../src/controller/loop-contract.ts';

test('the records of loop.yaml are the protocols /loop can run', () => {
  assert.deepEqual(loopProtocolNames(), ['design-review', 'designdoc-review']);
  assert.equal(loopProtocolFor('nope'), undefined);
});

test('the verifier is told the run\'s variables, so it cannot judge another document', () => {
  const limits = { from: 1, to: 10, score: 8, tries: 10 };
  const target = { verificationId: 'r/designdoc-review/1/1/1', file: '/w/v.json' };
  // The record's own default when the operator changed nothing…
  const byDefault = loopProtocolFor('designdoc-review', true)!.verify!(limits, 1, 1, target);
  assert.match(byDefault, /本次 run 的记录变量：path=tui-design\.md/);
  // …and the form's value when they retargeted the run.
  const retargeted = loopProtocolFor('designdoc-review', true, { path: 'loop.md' })!.verify!(limits, 1, 1, target);
  assert.match(retargeted, /本次 run 的记录变量：path=loop\.md/);
  assert.doesNotMatch(retargeted, /path=tui-design\.md/);
});

test('a record becomes a protocol without any per-record code', () => {
  const design = loopProtocolFor('design-review')!;
  assert.equal(design.kind, 'design-review');
  assert.equal(design.marker, 'dsht-loop');
  assert.equal(design.title, 'Design review');
  assert.equal(design.steps, 10);
  assert.equal(design.artifact, 'DESIGN-REVIEW.md');
  // The record's own defaults, not the global ones, are what a bare command inherits.
  assert.equal(design.defaultScore, 8);
  assert.equal(design.defaultTries, 10);
  // The shipped records review something that already exists, so a step verifies before it works.
  assert.equal(design.starts, 'verify');
  assert.equal(design.stepLabel?.(3), '接口审查');
  assert.equal(design.stepLabel?.(11), '收敛审查');
  // The marker is what the client looks for in the artifact before accepting a round.
  assert.equal(design.artifactMarker?.(3), '## 第 3 轮 · 接口审查');

  const limits = { from: 1, to: 10, score: 8, tries: 10 };
  const brief = design.brief(limits, 3, 2);
  assert.match(brief, /只执行第 3 轮的第 2 次尝试/);
  assert.match(brief, /评分标准（逐条对照）：/);
  assert.match(brief, /本步焦点：第 3 轮 · 接口审查/);
  assert.match(brief, /"kind":"design-review","step":3,"attempt":2/);
  assert.match(design.followUp(limits, 4, 2), /现在是第 4 轮、第 2\/10 次尝试（及格线 8）/);
});

test('the record owns its vars, so the title and prompts carry the document', () => {
  const doc = loopProtocolFor('designdoc-review')!;
  assert.equal(doc.title, 'Designdoc review · tui-design.md');
  const limits = { from: 1, to: 10, score: 8, tries: 10 };
  assert.match(doc.brief(limits, 1, 1), /tui-design\.md/);
  assert.match(doc.followUp(limits, 2, 1), /tui-design\.md/);
});

test('a forked record delegates the verdict, and an unforked one does not', () => {
  const plain = loopProtocolFor('design-review')!;
  assert.equal(plain.verify, undefined);
  // Without a verifier the brief still names the reply block: that path stays for hosts without one.
  assert.match(plain.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1), /verifier 子代理/);

  const forked = loopProtocolFor('design-review', true)!;
  assert.equal(typeof forked.verify, 'function');
  const prompt = forked.verify!({ from: 1, to: 1, score: 8, tries: 1 }, 3, 2,
    { file: '/tmp/v.json', verificationId: 'run/design-review/3/2/1' });
  // The verifier's prompt carries this round's rubric, the artifact and the identity it must echo.
  assert.match(prompt, /接口审查/);
  assert.match(prompt, /DESIGN-REVIEW\.md/);
  assert.match(prompt, /"verificationId":"run\/design-review\/3\/2\/1"/);
  assert.match(forked.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1), /独立验证进程/);
});

test('only a run over the whole record hands the last verifier every earlier round', () => {
  const forked = loopProtocolFor('design-review', true)!;
  const target = { file: '/tmp/v.json', verificationId: 'run/design-review/10/1/1' };
  const final = forked.verify!({ from: 1, to: 10, score: 8, tries: 10 }, 10, 1, target);

  // The consolidation round is the only place where "passed" may mean the whole artifact, so the
  // verifier is asked to re-check every earlier round and is given its rubric to do it.
  assert.match(final, /覆盖全部 10 轮的最后一次验证/);
  assert.match(final, /本轮通过意味着整份产出物通过/);
  assert.match(final, /【第 1 轮 · 职责与归属】/);
  assert.match(final, /【第 9 轮 · 过度设计检查】/);
  // Every earlier round is listed, and the consolidation round is not a prerequisite of itself.
  assert.equal(final.match(/【第 \d+ 轮/g)?.length, 9);
  // The last round's own rubric stays the round's standard, and the work prompt says the same.
  assert.match(forked.brief({ from: 1, to: 10, score: 8, tries: 10 }, 10, 1), /本轮是本次 run（第 1–10 轮）的收尾轮/);

  // A selected range never claims the whole record, and no other round carries the regression list.
  const partial = forked.verify!({ from: 1, to: 3, score: 8, tries: 10 }, 3, 1, target);
  assert.doesNotMatch(partial, /覆盖全部/);
  assert.doesNotMatch(forked.brief({ from: 1, to: 3, score: 8, tries: 10 }, 3, 1), /收尾轮/);
  // Starting late leaves earlier rounds unverified, so ending on the last step is still a range.
  assert.doesNotMatch(forked.verify!({ from: 5, to: 10, score: 8, tries: 10 }, 10, 1, target), /覆盖全部/);
  assert.doesNotMatch(forked.verify!({ from: 1, to: 10, score: 8, tries: 10 }, 9, 1, target), /覆盖全部/);
});

test('a record without rounds is refused by the schema, so every protocol has a rubric', () => {
  // `resultContract` is shared; the record only supplies the text, which the schema validated.
  const contract = resultContract('design-review', { from: 1, to: 1, score: 8, tries: 1 }, 1, 1, { standard: 'x' });
  assert.ok(contract.some(line => line.includes('评分标准')));
});

test('the record list offers the same names, artifacts, defaults and inputs the runner would use', () => {
  const records = loopRecords();
  assert.deepEqual(records.map(record => record.name), ['design-review', 'designdoc-review']);
  assert.deepEqual(records[0], { name: 'design-review', title: 'Design review', steps: 10,
    artifact: 'DESIGN-REVIEW.md', defaultScore: 8, defaultTries: 10, vars: {} });
  // A record's own vars are already rendered into the title the picker shows, and listed for the form.
  assert.equal(records[1]?.title, 'Designdoc review · tui-design.md');
  assert.equal(records[1]?.artifact, 'DESIGN-DOC-REVIEW.md');
  assert.deepEqual(records[1]?.vars, { path: 'tui-design.md' });
  assert.deepEqual(loopRecordVars('designdoc-review'), { path: 'tui-design.md' });
  assert.equal(loopRecordVars('nope'), undefined);
  // Every listed name is one the runner accepts, so a row can never offer an unrunnable record.
  for (const record of records) assert.notEqual(loopProtocolFor(record.name), undefined);
});

test('a run may retarget a record without editing loop.yaml', () => {
  const plain = loopProtocolFor('designdoc-review')!;
  assert.equal(plain.title, 'Designdoc review · tui-design.md');
  const limits = { from: 1, to: 10, score: 8, tries: 10 };
  assert.match(plain.brief(limits, 1, 1), /tui-design\.md/);

  // An override wins over the declared value everywhere the record uses it: title, work and verdict.
  const moved = loopProtocolFor('designdoc-review', false, { path: 'docs/other.md' })!;
  assert.equal(moved.title, 'Designdoc review · docs/other.md');
  assert.match(moved.brief(limits, 1, 1), /docs\/other\.md/);
  assert.doesNotMatch(moved.brief(limits, 1, 1), /tui-design\.md/);
  assert.match(moved.followUp(limits, 2, 1), /docs\/other\.md/);

  // A record without that variable is unaffected: the override only replaces declared names.
  const design = loopProtocolFor('design-review', false, {})!;
  assert.equal(design.title, 'Design review');
});
