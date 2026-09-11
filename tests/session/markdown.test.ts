/** Rich transcript snapshots and malformed streaming input exercise the actual history layout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import stringWidth from 'string-width';
import { markdownRows, markdownHtml } from '../../src/session/markdown.ts';
import { historyLayout } from '../../src/session/history.ts';
import { Transcript } from '../../src/session/transcript.ts';
import { saveTranscriptHtml } from '../../src/session/export-html.ts';
import { classifySubmission } from '../../src/ui/commands/parse.ts';

const source = readFileSync(new URL('../fixtures/markdown.md', import.meta.url), 'utf8');
const lines = (text: string, width = 80) => markdownRows(text, width).map(row => row.text);
function transcript(text: string): Transcript {
  const result = new Transcript();
  result.accept({ type: 'snapshot', cursor: 1, hasMore: false, assistantStream: { revision: 0 }, records: [
    { type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text }] } } } },
  ] });
  return result;
}

test('recorded rich message lays out Chinese tables, code, diagrams and math at desktop and mobile widths', () => {
  const conversation = transcript(source);
  for (const width of [100, 32]) {
    const layout = historyLayout(conversation, width);
    assert.equal(layout.lines.join('\n') + '\n', readFileSync(new URL(`../expected/markdown-${width}.txt`, import.meta.url), 'utf8'));
    assert.ok(layout.lines.every(line => stringWidth(line) <= width));
    for (let offset = 0; offset < layout.length; offset += 7) {
      assert.deepEqual(layout.viewport(offset, offset + 7).map(row => row.text), layout.lines.slice(offset, offset + 7));
    }
    assert.equal(layout.offsets.get(1), 0);
  }
  assert.equal(conversation.messages[0]!.text, source);
});

test('inline styles survive wrapping and raw HTML stays inert terminal text', () => {
  const rows = markdownRows('**bold *italic* after** ~~gone~~ `code` [link](https://example.com)', 12);
  assert.ok(rows.every(row => stringWidth(row.text) <= 12));
  const spans = rows.flatMap(row => row.spans ?? []);
  assert.ok(spans.some(span => span.italic && span.bold && span.text.includes('italic')));
  assert.ok(spans.some(span => span.strikethrough && span.text.includes('gone')));
  assert.ok(spans.some(span => span.inverse && span.text.includes('code')));
  assert.deepEqual(lines('&amp; &#x1b; &lt;b&gt;'), ['&  <b>']);
  assert.deepEqual(lines('<script>alert(1)</script>'), ['<script>alert(1)</script>']);
  assert.ok(rows.every(row => !row.text.includes('\x1b')));
  assert.deepEqual(lines('> quote\n\n1. one\n2. two'), ['│ quote', '', '1. one', '2. two']);
});

test('tables preserve escaped pipes and alignment, and stack cells on narrow screens', () => {
  const table = '| Left | Right | Center |\n| :--- | ---: | :---: |\n| a\\|b | 7 | 中 |';
  const wide = lines(table, 80);
  assert.ok(wide.some(line => line.includes('a|b')));
  assert.equal(new Set(wide.map(string => stringWidth(string))).size, 1);
  assert.ok(wide.some(line => line.includes('│     7 │')));
  const narrow = lines(table, 20);
  assert.ok(narrow.includes('Left: a|b'));
  assert.ok(narrow.includes('Right: 7'));
  assert.ok(narrow.every(line => stringWidth(line) <= 20));
  assert.deepEqual(lines('| Left | Right |\n| --- | --- |', 20), ['Left', 'Right']);
});

test('Mermaid renders closed graphs, preserves unfinished and unsupported source, and fits Chinese labels', () => {
  const graph = '```mermaid\ngraph TD\n A[开始] --> B[完成]\n```';
  const result = lines(graph);
  assert.ok(result.some(line => line.includes('│ 开始 │')));
  assert.ok(result.some(line => line.includes('▼')));
  assert.ok(result.filter(line => /^[┌│└]/.test(line)).every(line => stringWidth(line) === stringWidth(result[0]!)));
  assert.ok(lines(graph.slice(0, -3)).includes('┌ mermaid'));
  assert.ok(lines('```mermaid\npie\n "A" : 1\n```').some(line => line.includes('pie')));
  assert.ok(lines(graph, 6).every(line => stringWidth(line) <= 6));
});

test('MathJax parses all delimiters, fractions, scripts and matrices without interpreting code or currency', () => {
  assert.deepEqual(lines(String.raw`$E=mc^2$ and \(x_1\)`), ['E=mc² and x₁']);
  assert.deepEqual(lines(String.raw`\[\sqrt{x^2+1}\]`), ['√(x²+1)']);
  assert.deepEqual(lines('$$\n\\frac{1}{2}\n$$'), ['(1)/(2)']);
  assert.deepEqual(lines('```mathjax\nx^2\n```'), ['x²']);
  assert.deepEqual(lines('${a+b}^2$'), ['(a+b)²']);
  assert.deepEqual(lines(String.raw`$\begin{matrix}1&2\\3&4\end{matrix}$`), ['[1, 2; 3, 4]']);
  assert.deepEqual(lines('Cost $5 and $10.'), ['Cost $5 and $10.']);
  assert.deepEqual(lines('`$x^2$` and $unfinished'), ['$x^2$ and $unfinished']);
  assert.deepEqual(lines(String.raw`$\unknown{x}$`), [String.raw`$\unknown{x}$`]);
  assert.match(markdownHtml(String.raw`$\frac{1}{2}$`), /<mfrac/);
  assert.doesNotMatch(markdownHtml(String.raw`$\href{javascript:alert(1)}{x}$`), /href=/);
});

test('every rich streaming delta matches complete parsing and final history keeps the source', () => {
  const conversation = new Transcript();
  conversation.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'rich', revision: 1 } });
  let text = ''; let frame = 0;
  for (let offset = 0; offset < source.length; offset += 19) {
    const delta = source.slice(offset, offset + 19); text += delta;
    conversation.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'rich', index: frame, revision: frame + 2,
      chunk: { type: 'text-delta', index: 0, text: delta } } }); frame++;
    for (const width of [32, 100]) {
      const layout = historyLayout(conversation, width);
      assert.deepEqual(layout.lines.slice(1), lines(conversation.liveParts(width)[0]!.text, width), `delta ${offset}, width ${width}`);
    }
  }
  assert.equal(conversation.liveText, text);
});

test('offline HTML export includes inert SVG and MathJax math, preserves files, and supports cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsht-markdown-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'rich conversation.html');
  const conversation = transcript(source + '\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![image](https://example.com/tracker.png)');
  assert.equal(await saveTranscriptHtml(conversation, 's1', path, new AbortController().signal), path);
  const html = await readFile(path, 'utf8');
  assert.match(html, /<table>/); assert.match(html, /data:image\/svg\+xml;base64,/); assert.match(html, /<mfrac/);
  assert.match(html, /Loaded conversation only/); assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script|href="javascript:|src="https:/);
  await assert.rejects(saveTranscriptHtml(conversation, 's1', path, new AbortController().signal), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), html);
  const abort = new AbortController(); abort.abort();
  const cancelled = join(root, 'cancelled.html');
  await assert.rejects(saveTranscriptHtml(conversation, 's1', cancelled, abort.signal), { name: 'AbortError' });
  await assert.rejects(stat(cancelled), { code: 'ENOENT' });
  const context = { referenceOpen: false, copyMode: false, pending: false, question: false, screen: 'chat' as const };
  assert.deepEqual(classifySubmission('/export-html "rich conversation.html"', context), { kind: 'exportHtml', destination: 'rich conversation.html' });
  assert.deepEqual(classifySubmission('/export-html', { ...context, screen: 'sessions' }), { kind: 'error', message: 'Select a session first' });
});
