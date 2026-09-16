/** The result contract every loop protocol appends, so one parser serves them all.
 *
 * A protocol owns its objective text; this module owns how the reply is scored and what block must
 * end it. Keeping it in one place is what lets `/loop`, `/design-review` and any later protocol
 * share `parseLoopResult` and the same verification wording.
 */
import { readResultFields, type LoopLimits, type LoopResult, type PriorVerdict } from './loop.ts';

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
 * @param mode - `subagent` asks the agent to spawn a grader; `forked` says one is started for it.
 * @returns The contract as lines, ready to append to a brief.
 */
export function resultContract(kind: string, limits: LoopLimits, step: number, attempt: number,
  brief: VerificationBrief = {}, mode: 'subagent' | 'forked' = 'subagent'): string[] {
  const { standard, artifact, focus } = brief;
  return [
    '评分与验证：',
    `1. 产出物必须落到工作区${artifact === undefined ? '' : `（${artifact}）`}，因为验证者在全新上下文里看不到本对话。`,
    ...(mode === 'forked'
      ? [
        '2. 本轮由 dsht 启动的独立验证进程单独评分：它有自己的 session、自己的上下文，会读产出物并自己取证，你无法影响它的判断。',
        '3. 不要 spawn 子代理替你评分，也不要自评；只要完成本步工作，并在回复里简要列出改了什么、依据是什么。',
        '4. 若独立验证没有返回结果，则以你结尾输出的块为准，所以它仍然必须存在且格式正确。',
      ]
      : [
        '2. 每次尝试都要 spawn 一个全新的 verifier 子代理（subagent，独立上下文），把「原始目标 + 本步焦点 + 产出物 + 评分标准」交给它独立打分；不要用主回复替代它的判断。',
        '3. 只有当前环境确实没有 subagent 能力时，才允许自评，并在 status 中注明 self-scored。',
      ]),
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

/** What the forked verifier must judge, and where its verdict has to land.
 *
 * The verifier runs as its own `dsht` process against its own session, so it cannot see the review
 * conversation at all: the artifact on disk and this brief are its whole input, and the verdict file
 * is its whole output.
 */
export interface VerdictBrief extends VerificationBrief {
  /** Identity of this verification, echoed into the verdict so a file cannot be misread. */
  verificationId: string;
  /** Protocol kind the verdict must declare. */
  kind: string;
  /** Step in flight. */
  step: number;
  /** Attempt in flight. */
  attempt: number;
  /** Absolute path of the JSON file the verifier session must write. */
  file: string;
  /** What the previous attempt on this step concluded, when there was one. */
  previous?: PriorVerdict;
}

/** What a retry must be told, so it answers the verdict instead of guessing.
 *
 * A score alone leaves the reviewer re-deriving what was wrong; the verifier's own findings are the
 * only account of why the attempt failed, so they are quoted back verbatim.
 * @param result - Verdict that ended the previous attempt.
 * @returns Lines to append to the follow-up prompt, empty when the verdict explained nothing.
 */
export function findingsLines(result: LoopResult): string[] {
  const lines: string[] = [];
  if (result.evidence !== undefined) lines.push(`评分依据（来自验证）：${result.evidence}`);
  if (result.findings !== undefined && result.findings.length > 0) {
    lines.push('验证者认为仍未解决的问题：');
    for (const [index, finding] of result.findings.entries()) lines.push(`${index + 1}. ${finding}`);
    lines.push('逐条处理上面的问题，不要只做与它们无关的改动。');
  }
  return lines.length === 0 ? [] : ['', ...lines];
}

/** The prompt one forked verifier session receives.
 *
 * It states its independence, the evidence it must gather, the artifact it must not change, and the
 * exact file it must write, because that file is the only channel back to the review.
 * @param brief - Kind, step, attempt, path, standard, artifact and focus.
 * @returns The prompt as one string.
 */
export function verdictBrief(brief: VerdictBrief): string {
  const { verificationId: identity, kind, step, attempt, standard, artifact, focus, previous } = brief;
  return [
    `你是独立验证者：验证 kind=${kind} 的第 ${step} 轮第 ${attempt} 次尝试。`,
    '你没有本次评审的对话上下文，也不属于被验证的 session；你的判断只能来自磁盘上的产出物和你自己跑出来的证据。',
    '',
    ...(artifact === undefined ? [] : [`待验证产出物：${artifact}（在工作区中，自行阅读；不要修改它）。`]),
    ...(focus === undefined ? [] : [`本轮焦点：${focus}`]),
    ...(previous === undefined ? [] : [
      '',
      `上一次（第 ${previous.step} 轮第 ${previous.attempt} 次）验证给出的分数是 ${previous.result.score ?? '未给出'}：`,
      ...(previous.result.findings === undefined || previous.result.findings.length === 0
        ? ['（没有留下具体问题清单。）']
        : ['上次仍未解决的问题：', ...previous.result.findings.map((finding, index) => `${index + 1}. ${finding}`)]),
      '请优先逐条确认这些问题是否真的已经解决；没有解决的必须继续计入本轮评分。',
    ]),
    '',
    '验证要求：',
    '1. 亲自核对，不要相信任何未经验证的说法：跑命令、读源码、对照文档与实现。',
    '2. 逐条对照下面的评分标准，指出每条是满足、部分满足还是不满足。',
    '3. 不要修改产出物；你只负责判断。',
    '',
    ...(standard === undefined
      ? ['评分标准：未提供；按产出的完成度与准确性评分。']
      : ['评分标准（逐条对照）：', standard]),
    '',
    `分数为 0–10（允许小数）。score 小于 8 时 status 必须是 retry 并列出仍未解决的问题；`
      + '若任务被证明无法完成，status 必须是 blocked 并说明原因。',
    '',
    '返回方式：在回复正文的最后输出唯一一个 JSON 对象，不要加代码块围栏，也不要用工具去写文件：',
    `{"verificationId":"${identity}","kind":"${kind}","step":${step},"attempt":${attempt},"score":X,"status":"${LOOP_STATUSES}","evidence":"...","top_findings":["..."]}`,
    'evidence 必须写出评分依据：跑过的命令与结果、看到的具体失败、或引用的原文。',
    '客户端会读取你回复里的这个对象并落盘；不要自己创建、修改或删除 verdict 文件。',
  ].join('\n');
}

/** Every top-level JSON object in one reply, last one first.
 *
 * A review reply is prose with evidence in it, so the verdict is not the only braces in the text: a
 * quoted snippet before or after it used to be swallowed by a first-brace-to-last-brace slice and
 * made the whole verdict unparsable. Each balanced top-level object is a candidate instead.
 * Brace counting ignores nesting inside strings, which is enough for a verdict and its evidence.
 * @param text - Reply or file contents.
 * @returns Parsed objects, most recent first.
 */
function jsonObjects(text: string): Record<string, unknown>[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') { if (depth === 0) start = index; depth += 1; } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) { spans.push(text.slice(start, index + 1)); start = -1; }
      }
    }
  }
  const objects: Record<string, unknown>[] = [];
  for (const span of spans.reverse()) {
    try {
      const parsed = JSON.parse(span) as unknown;
      if (typeof parsed === 'object' && parsed !== null) objects.push(parsed as Record<string, unknown>);
    } catch { /* a quoted non-JSON brace group is not a candidate */ }
  }
  return objects;
}

/** Read one forked verifier's verdict.
 *
 * The reply is written by another process and by a model, so it is treated as untrusted input: the
 * identity has to match the round being judged, or a stale or quoted object would score the wrong
 * attempt. Later objects win, because the instruction is to end the reply with the verdict.
 * @param text - Reply or file contents.
 * @param expect - Identity, kind, step and attempt the verdict must declare.
 * @returns The verdict's usable fields, or undefined when no candidate declared this round.
 */
export function parseVerdict(text: string,
  expect: { verificationId: string; kind: string; step: number; attempt: number }): LoopResult | undefined {
  for (const body of jsonObjects(text)) {
    // The identity is checked before the round, so a verdict from another run is never usable.
    if (body.verificationId !== expect.verificationId) continue;
    if (body.kind !== expect.kind || body.step !== expect.step || body.attempt !== expect.attempt) continue;
    return readResultFields(body);
  }
  return undefined;
}
