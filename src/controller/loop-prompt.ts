/** The ad-hoc `/loop` protocol: any prompt, wrapped in the shared scored-loop contract. */
import { LOOP_MARKER, followUpContract, resultContract } from './loop-contract.ts';
import type { LoopLimits, LoopProtocol } from './loop.ts';

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
 * @param verification - Standard `/verify` set for this session, when any.
 * @returns The protocol the scored loop runs.
 */
export function promptLoopProtocol(prompt: string, verification?: string): LoopProtocol {
  const verified = verification === undefined ? '' : ' (verified)';
  return {
    marker: LOOP_MARKER,
    kind: 'loop',
    title: `Loop · ${label(prompt)}${verified}`,
    steps: 1,
    brief: (limits, step, attempt) => [
      prompt,
      '',
      `这是一次迭代循环：第 ${step} 轮第 ${attempt} 次尝试（共 ${limits.to} 轮，及格线 ${limits.score}，每轮最多 ${limits.tries} 次）。`,
      '请直接完成上面的要求，不要输出冗长的内部思维过程。',
      '',
      ...resultContract('loop', limits, step, attempt, { standard: verification }),
    ].join('\n'),
    followUp: (limits: LoopLimits, step, attempt) => [
      `现在是第 ${step} 轮、第 ${attempt}/${limits.tries} 次尝试（及格线 ${limits.score}）。`,
      '以最初的要求为准，处理上一版未解决的问题并继续改进。',
      followUpContract('loop', step, attempt),
    ].join('\n'),
  };
}
