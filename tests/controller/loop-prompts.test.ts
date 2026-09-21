/** The loop prompt source: loop.yaml is the editable truth, the generated module must match it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { LOOP_PROMPTS } from '../../src/controller/loop-prompts.generated.ts';
import { loopPrompts } from '../../src/controller/loop-prompts.ts';
import { validateLoopPrompts } from '../../src/controller/loop-prompts-schema.ts';
import { roundStandard } from '../../src/controller/loop-protocols.ts';

test('the generated prompts are exactly loop.yaml', () => {
  // A YAML edit without `npm run build:prompts` (or a hand edit of the generated module) fails here,
  // so the two can never drift apart.
  const source = parse(readFileSync('loop.yaml', 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(LOOP_PROMPTS)), JSON.parse(JSON.stringify(source)));
});

test('every record renders its own placeholders and vars', () => {
  const records = loopPrompts();
  assert.deepEqual(records.names, ['design-review', 'designdoc-review']);

  const design = records.find('design-review')!;
  assert.equal(design.title, 'Design review');
  assert.equal(design.steps, 10);
  assert.equal(design.artifact, 'DESIGN-REVIEW.md');
  assert.equal(design.defaultScore, 8);
  assert.equal(design.defaultTries, 10);
  assert.equal(design.roundTitle(3), '接口审查');
  // A step past the table keeps the fallback label and the last round's checklist.
  assert.equal(design.roundTitle(11), '收敛审查');
  assert.equal(design.checks(11), design.checks(10));
  assert.match(design.brief({ from: 1, to: 10, score: 8, tries: 10, step: 3, attempt: 2 }).join('\n'), /只执行第 3 轮的第 2 次尝试/);
  assert.equal(design.focus(3), '第 3 轮 · 接口审查');

  // The document path is a record var: the title, brief and follow-up all get it without the caller
  // passing anything.
  const doc = records.find('designdoc-review')!;
  assert.equal(doc.title, 'Designdoc review · tui-design.md');
  const brief = doc.brief({ from: 1, to: 1, score: 8, tries: 1, step: 1, attempt: 1 }).join('\n');
  assert.match(brief, /tui-design\.md/);
  assert.match(doc.followUp({ from: 1, to: 1, score: 8, tries: 1, step: 2, attempt: 1 }).join('\n'), /tui-design\.md/);

  // The artifact marker is a template like the others: it names this round's own section.
  assert.equal(design.artifactMarker(3), '## 第 3 轮 · 接口审查');
  assert.equal(design.artifactMarker(11), '## 第 11 轮 · 收敛审查');
  // The document is part of the heading, so a section written for another document cannot satisfy
  // this run's round check.
  assert.equal(doc.artifactMarker(1), '## 第 1 轮 · 定位与范围 · tui-design.md');
  // Retargeting the run moves the heading with it: the marker is rendered with the run's vars.
  assert.equal(records.find('designdoc-review', { path: 'loop.md' })!.artifactMarker(1), '## 第 1 轮 · 定位与范围 · loop.md');
  // One file per reviewed document: the artifact name follows the run's own input.
  assert.equal(doc.artifact, 'tui-design.md.review.md');
  assert.equal(records.find('designdoc-review', { path: 'loop.md' })!.artifact, 'loop.md.review.md');
  assert.match(brief, /## 第 1 轮 · 定位与范围 · tui-design\.md/);

  assert.equal(records.find('nope'), undefined);
});

test('a record may carry its own standard, which folds on top of every round', () => {
  assert.equal(roundStandard('本轮的清单'), '本轮的清单');
  assert.equal(roundStandard('本轮的清单', '不得新增 any'), '本轮的清单\n\n附加要求（记录自带）：\n不得新增 any');
  // The shipped records declare none, so their rubric is the checklist alone.
  assert.equal(loopPrompts().find('design-review')!.standard, undefined);
});

test('the schema rejects the mistakes an editor would make', () => {
  const errors = validateLoopPrompts({
    version: 1,
    defaults: { score: 8, tries: 10 },
    protocols: {
      broken: { title: 'X', steps: 2, fallbackLabel: 'F', rounds: [{ title: 'a', checks: 'b' }], brief: ['{{nope}}'], followUp: ['x'] },
      answer: { title: 'Y', steps: 1, fallbackLabel: 'F', rounds: [], brief: ['ok'], followUp: ['x'] },
      shadow: { title: 'Z', steps: 1, fallbackLabel: 'F', vars: { score: '9' }, defaults: { score: 42 },
        rounds: [], brief: ['{{score}}'], followUp: ['x'] },
      marker: { title: 'M', steps: 1, artifactMarker: '## 第 {{nope}} 轮', fallbackLabel: 'F',
        rounds: [], brief: ['ok'], followUp: ['x'] },
      moving: { title: 'Move', steps: 1, artifact: 'out/{{step}}.md', artifactMarker: '## {{title}}', fallbackLabel: 'F',
        rounds: [{ title: 'a', checks: 'b' }], brief: ['{{checks}}'], followUp: ['x'] },
    },
  });
  assert.ok(errors.some(message => message.includes('rounds has 1 entries but steps is 2')));
  assert.ok(errors.some(message => message.includes('unknown placeholder {{nope}}')));
  assert.ok(errors.some(message => message.includes('must contain exactly one line that is just {{checks}}')));
  assert.ok(errors.some(message => message.includes('protocols.answer is a reserved name')));
  assert.ok(errors.some(message => message.includes('protocols.shadow.vars.score shadows a runtime placeholder')));
  assert.ok(errors.some(message => message.includes('protocols.shadow.defaults.score must be a number in 0-10')));
  // A marker is only checkable against a file, and only with the placeholders a record may use.
  assert.ok(errors.some(message => message.includes('protocols.marker.artifactMarker: unknown placeholder {{nope}}')));
  assert.ok(errors.some(message => message.includes('protocols.marker.artifactMarker needs protocols.marker.artifact')));
  // The artifact may use the record's vars (one file per input) but never a runtime placeholder: a
  // file that moves between rounds is not a place a round's conclusion can be checked.
  assert.ok(errors.some(message => message.includes('protocols.moving.artifact: {{step}} must be a record var')));
  // The real document must satisfy the same validator the build runs.
  assert.deepEqual(validateLoopPrompts(parse(readFileSync('loop.yaml', 'utf8'))), []);
});

test('a record may not take a name /loop owns itself, including stop', () => {
  const errors = validateLoopPrompts({ version: 1, defaults: { score: 8, tries: 10 }, protocols: {
    stop: { title: 'S', steps: 1, fallbackLabel: 'F', rounds: [{ title: 'r', checks: '{{checks}}' }],
      brief: ['{{checks}}'], followUp: ['next'] },
  } });
  assert.deepEqual(errors, ['protocols.stop is a reserved name: answer, abort, stop belong to /loop itself']);
});
