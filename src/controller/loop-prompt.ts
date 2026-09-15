/** The ad-hoc `/loop` protocol: any prompt, wrapped in the scored loop's result contract. */
import type { LoopLimits, LoopProtocol } from './loop.ts';

/** Marker shared by every loop protocol's result block. */
const MARKER = 'dsht-loop';

/** Shorten a free-form prompt into the progress line's label. */
function label(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 39)}…`;
}

/** Wrap one prompt into the loop contract, so `/loop` needs no bespoke command code.
 *
 * The prompt is the whole objective: the first send is the prompt plus the result contract, and a
 * later attempt only asks for the unfinished part, because the original request is already in the
 * conversation.
 * @param prompt - Free-form objective exactly as the operator typed it.
 * @returns The protocol the scored loop runs.
 */
export function promptLoopProtocol(prompt: string): LoopProtocol {
  return {
    marker: MARKER,
    kind: 'loop',
    title: `Loop · ${label(prompt)}`,
    steps: 1,
    brief: (limits, step, attempt) => [
      prompt,
      '',
      `这是一次迭代循环：第 ${step} 轮第 ${attempt} 次尝试（共 ${limits.to} 轮，及格线 ${limits.score}，每轮最多 ${limits.tries} 次）。`,
      '请直接完成上面的要求，不要输出冗长的内部思维过程。',
      '',
      '评分：本轮完成度用 0–10 表示（允许小数），应由独立 verifier 子代理（subagent，全新上下文，以上面的要求作为 rubric）给出；若当前环境没有 subagent 能力，则由你自己评分并在 verdict 中标注 self-scored。',
      '结尾必须输出唯一一个 ```' + MARKER + ' 代码块，并且它必须是回复正文的最后内容：',
      `{"kind":"loop","step":${step},"attempt":${attempt},"score":X,"verdict":"pass|retry","top_findings":["..."],"next_focus":"..."}`,
      `score 小于 ${limits.score} 时 verdict 必须是 retry，并列出仍未解决的问题。`,
    ].join('\n'),
    followUp: (limits, step, attempt) => [
      `现在是第 ${step} 轮、第 ${attempt}/${limits.tries} 次尝试（及格线 ${limits.score}）。`,
      '以最初的要求为准，处理上一版未解决的问题并继续改进。',
      '结尾仍然只输出一个 ```' + MARKER + ' JSON 块，'
        + `kind=loop、step=${step}、attempt=${attempt}、score 为本次评分。`,
    ].join('\n'),
  };
}
