/** Terminal colors are emitted by the view, never interpreted from the session's text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

/** Render with an explicit color depth, independent of terminal and CI detection. */
function renderFixture(source: string, color: '0' | '3'): string {
  // TERM=dumb uses FORCE_COLOR directly; Azure detection runs before that TERM check.
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', FORCE_COLOR: color };
  delete env.TF_BUILD;
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const script = `
import { createElement } from 'react';
import { renderToString } from 'ink';
import { HistoryViewport } from './src/history-view.tsx';
import { safeText } from './src/wire.ts';
const rows = [
  {kind:'user',text:'❯ User',bold:true}, {kind:'assistant',text:'✦ Assistant',bold:true},
  {kind:'reasoning',text:'◇ /think 1 · reasoning'}, {kind:'tool',text:'⚙ bash · Run tests'},
  {kind:'tool',text:'$ npm test'}, {kind:'success',text:'✓ bash · Run tests'},
  {kind:'error',text:'✗ bash · Run tests'}, {kind:'text',text:safeText('remote\\x1b[31mtext')},
];
process.stdout.write(renderToString(createElement(HistoryViewport,{rows}),{columns:80}));
`;

test('Mocha emits truecolor role colors and supports a plain terminal', () => {
  const colored = renderFixture(script, '3');
  for (const rgb of ['137;180;250', '166;227;161', '203;166;247', '137;220;235', '243;139;168']) assert.ok(colored.includes(`\x1b[38;2;${rgb}m`), colored);
  const plain = renderFixture(script, '0');
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.doesNotMatch(plain, /\x1b/);
  assert.ok(plain.includes('❯ User\n✦ Assistant'));
});

test('status groups retain their colors and identical plain layout across terminal widths', () => {
  const statusScript = `
import { createElement } from 'react';
import { renderToString } from 'ink';
import { StatusBar } from './src/status.tsx';
import { Controller } from './src/controller.ts';
const controller = new Controller('http://fixture', undefined);
controller.state = {...controller.state, online:true, sessionId:'s1', sessions:[{sessionId:'s1',running:false}]};
const frames = [];
for (const percent of [25,80,95]) {
 controller.telemetry.accept({type:'baseline',value:{projections:{s1:{asOfSeq:0,values:{
  modelSelection:{next:{provider:'p',model:'flash',reasoningEffort:'high'}},
  contextPressure:{projectedTokens:percent,contextWindow:100}, sessionStats:{turns:42},
  tokenUsage:{uncachedInputTokens:100,outputTokens:200,cacheReadTokens:0,cacheWriteTokens:0}
 }}},queues:{},jobs:{}}});
 for (const width of [140,60,24]) frames.push(renderToString(createElement(StatusBar,{controller,width}),{columns:width}));
}
controller.state = {...controller.state,online:false};
frames.push(renderToString(createElement(StatusBar,{controller,width:140}),{columns:140}));
process.stdout.write(JSON.stringify(frames));
`;
  const colored = JSON.parse(renderFixture(statusScript, '3')) as string[];
  const plain = JSON.parse(renderFixture(statusScript, '0')) as string[];
  assert.deepEqual(colored.map(stripVTControlCharacters), plain);
  assert.ok(colored[0]!.includes('\x1b[38;2;166;227;161m'));
  assert.ok(colored[0]!.includes('\x1b[38;2;203;166;247m'));
  assert.ok(colored[3]!.includes('\x1b[38;2;249;226;175m'));
  assert.ok(colored[6]!.includes('\x1b[38;2;243;139;168m'));
  assert.ok(colored[9]!.includes('\x1b[38;2;243;139;168m'));
  for (const row of plain) assert.doesNotMatch(row, /\x1b|\n/);
});
