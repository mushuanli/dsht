/** The result contract every loop protocol appends, so one parser serves them all.
 *
 * A protocol owns its objective text; this module owns how the reply is scored and what block must
 * end it. Keeping it in one place is what lets `/loop`, `/design-review` and any later protocol
 * share `parseLoopResult` and the same verification wording.
 */
import type { LoopLimits } from './loop.ts';

/** Fence marker shared by every loop protocol's result block. */
export const LOOP_MARKER = 'dsht-loop';

/** The status values a result block may declare. */
export const LOOP_STATUSES = 'done|retry|blocked';

/** What a protocol tells the verifier, beyond the score threshold.
 *
 * A protocol that names its steps supplies its own `standard` (its checklist for that step); the
 * operator's `/verify` text is folded in by the protocol that has one, so this module never has to
 * guess where a standard came from.
 */
export interface VerificationBrief {
  /** Standard the verifier scores against, checked item by item. */
  standard?: string;
  /** Workspace artifact the verifier must read, when the protocol requires one. */
  artifact?: string;
  /** What this step is about, when the protocol names its steps. */
  focus?: string;
}

/** How the reply is scored, by whom, and the block that must end it.
 *
 * The verifier is a fresh subagent because the agent that produced the artifact cannot judge it
 * fairly, and a fresh context cannot see the conversation, so the artifact must be on disk.
 * @param kind - Protocol kind the block must declare.
 * @param limits - Resolved run limits.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @param brief - Standard, artifact and focus the verifier needs.
 * @returns The contract as lines, ready to append to a brief.
 */
export function resultContract(kind: string, limits: LoopLimits, step: number, attempt: number, brief: VerificationBrief = {}): string[] {
  const { standard, artifact, focus } = brief;
  return [
    '评分与验证：',
    `1. 产出物必须落到工作区${artifact === undefined ? '' : `（${artifact}）`}，因为验证者在全新上下文里看不到本对话。`,
    '2. 每次尝试都要 spawn 一个全新的 verifier 子代理（subagent，独立上下文），把「原始目标 + 本步焦点 + 产出物 + 评分标准」交给它独立打分；不要用主回复替代它的判断。',
    '3. 只有当前环境确实没有 subagent 能力时，才允许自评，并在 status 中注明 self-scored。',
    ...(focus === undefined ? [] : ['', `本步焦点：${focus}`]),
    '',
    ...(standard === undefined
      ? ['评分标准：未提供；按原始目标的完成度评分。']
      : ['评分标准（逐条对照）：', standard]),
    `分数为 0–10（允许小数）。score 小于 ${limits.score} 时 status 必须是 retry，并列出仍未解决的问题；`
      + '若任务被证明无法完成，status 必须是 blocked，并说明原因与已尝试过的路径。',
    `结尾必须输出唯一一个 \`\`\`${LOOP_MARKER} 代码块，并且它必须是回复正文的最后内容：`,
    `{"kind":"${kind}","step":${step},"attempt":${attempt},"score":X,"status":"${LOOP_STATUSES}","evidence":"...","top_findings":["..."]}`,
    'evidence 必须给出评分的依据：跑过的命令与结果、看到的具体失败、或验证者引用的原文。',
  ];
}

/** The shorter clause a later attempt ends with, once the protocol is already in context.
 * @param kind - Protocol kind the block must declare.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @returns The clause as one line.
 */
export function followUpContract(kind: string, step: number, attempt: number): string {
  return `结尾仍然只输出一个 \`\`\`${LOOP_MARKER} JSON 块，`
    + `kind=${kind}、step=${step}、attempt=${attempt}、score 为本次评分、status 为 ${LOOP_STATUSES}。`;
}
