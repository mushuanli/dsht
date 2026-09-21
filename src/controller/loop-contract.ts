/** The result contract every loop protocol appends, so one parser serves them all.
 *
 * A protocol owns its objective text; this module owns how the reply is scored and what block must
 * end it. Keeping it in one place is what lets every `/loop` record and any later protocol
 * share `parseLoopResult` and the same verification wording.
 */
import { readResultFields, type LoopLimits, type LoopResult, type PriorVerdict } from './loop.ts';

/** Fence marker shared by every loop protocol's result block. */
export const LOOP_MARKER = 'dsht-loop';

/** The status values a result block may declare. */
export const LOOP_STATUSES = 'done|retry|blocked|abstained';

/** How a verifier may stop a round early, shared by the work brief and the verdict brief.
 *
 * Both stops are claims about the task, so each is written the same way wherever it is read: a
 * reason a person can check, no score to hide behind, and a label that agrees with the status. A
 * block that breaks any of these is not a verdict at all, so the run reports verification unusable
 * instead of guessing what was meant.
 * @returns The rules as lines, ready to append to a brief.
 */
export function earlyStopLines(): string[] {
  return [
    '提前停下（只有这两种，都必须给 reason，都不许给 score）：',
    '- 任务在当前约束下被证明无法完成：status 用 "blocked"（可选 exit_reason: "cannot-fix"），'
      + 'reason 写清为什么不可完成、已经排除过哪些路径。',
    '- 必须由人决定才能继续：status 用 "abstained"（可选 exit_reason: "needs-human"），'
      + 'reason 写清需要人决定什么，needs 写清具体要人提供什么。',
    'exit_reason 与 status 必须一致；缺 reason、同时给出两种判断、或带着 score 提前停下，'
      + '都会被当成「没有可用判断」，本轮不计分。',
    'explanation 是可选的说明（例如「本轮无需改动」）：它只作解释，不改变评分，也不跳过任何未验证的范围。',
  ];
}

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
  /** This step ends a run over the whole record, so this version may not break any earlier round. */
  final?: boolean;
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
  brief: VerificationBrief = {}, mode: 'subagent' | 'forked' = 'subagent', selfScoring = mode !== 'forked'): string[] {
  const { standard, artifact, focus, final } = brief;
  return [
    '评分与验证：',
    `1. 产出物必须落到工作区${artifact === undefined ? '' : `（${artifact}）`}，因为验证者在全新上下文里看不到本对话。`,
    ...(mode === 'forked'
      ? [
        '2. 本轮由 dsht 启动的独立验证进程单独评分：它有自己的 session、自己的上下文，会读产出物并自己取证，你无法影响它的判断。',
        '3. 不要 spawn 子代理替你评分，也不要自评；只要完成本步工作，并在回复里简要列出改了什么、依据是什么。',
        ...(selfScoring
          // The verifier's verdict normally decides, but the operator allowed the reply block to stand
          // in when it cannot judge — so that block still has to be there.
          ? ['4. 结尾仍需按下面的格式给出块：验证进程无法判断时，本轮采用它。']
          // Nothing reads a block here, so asking for one costs output tokens and shows the reader a
          // score that moves nothing (the confusing part of the old wording).
          : ['4. 不要输出 dsht-loop 块：本轮的分数只来自那个独立验证进程，回复里的块不会被读取。']),
      ]
      : [
        '2. 每次尝试都要 spawn 一个全新的 verifier 子代理（subagent，独立上下文），把「原始目标 + 本步焦点 + 产出物 + 评分标准」交给它独立打分；不要用主回复替代它的判断。',
        '3. 只有当前环境确实没有 subagent 能力时，才允许自评，并在 status 中注明 self-scored。',
      ]),
    ...(focus === undefined ? [] : ['', `本步焦点：${focus}`]),
    ...(final === true ? ['', `本轮是本次 run（第 ${limits.from}–${limits.to} 轮）的收尾轮：写这一版时，前面每一轮已经满足的要求都必须仍然满足；`
      + '若为了本轮改动而破坏了任何前序要求，必须在本轮改回，否则本轮不算完成。'] : []),
    '',
    ...(standard === undefined
      ? ['评分标准：未提供；按原始目标的完成度评分。']
      : ['评分标准（逐条对照）：', standard]),
    ...(selfScoring ? [
      `分数为 0–10（允许小数）。score 小于 ${limits.score} 时 status 必须是 retry，并列出仍未解决的问题。`,
      ...earlyStopLines(),
      `结尾必须输出唯一一个 \`\`\`${LOOP_MARKER} 代码块，并且它必须是回复正文的最后内容：`,
      `{"kind":"${kind}","step":${step},"attempt":${attempt},"score":X,"status":"${LOOP_STATUSES}","evidence":"...","top_findings":["..."]}`,
      'status 为 blocked 或 abstained 时不要 score，改为给 "reason"；abstained 再加上 "needs"。',
      'evidence 必须给出评分的依据：跑过的命令与结果、看到的具体失败、或验证者引用的原文。',
    ] : [
      '结论写在工作正文里即可（发现的问题、依据、改法）：本轮的分数、status 与 findings 都由那个独立验证进程给出，'
        + '它读产出物和你写在产出物里的结论，不读你的回复格式。',
    ]),
  ];
}

/** The shorter clause a later attempt ends with, once the protocol is already in context.
 * @param kind - Protocol kind the block must declare.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @returns The clause as one line.
 */
export function followUpContract(kind: string, step: number, attempt: number, selfScoring = true): string {
  return selfScoring
    ? `结尾仍然只输出一个 \`\`\`${LOOP_MARKER} JSON 块，`
      + `kind=${kind}、step=${step}、attempt=${attempt}、score 为本次评分、status 为 ${LOOP_STATUSES}。`
    : '结尾不需要输出 dsht-loop 块：本轮分数同样只由独立验证进程给出。';
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
  /** Every earlier round's requirements, when this step has to re-check the whole record. */
  coverage?: readonly { title: string; checks: string }[];
  /** The heading the round's section carries in the artifact, as the client checks it.
   *
   * The verifier marks the section it judged, and the client marks the section it accepts: giving both
   * the same string is what keeps a section from another run against another document out of the round.
   */
  marker?: string;
  /** The run's record variables, resolved: what this run is about, e.g. `path` for the reviewed file.
   *
   * The verifier cannot see the review conversation, so without these it can only guess the subject
   * from the artifact — and an artifact left by an earlier run against another document then reads as
   * this run's (a live run scored the previous document twice).
   */
  vars?: Readonly<Record<string, string>>;
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
  const { verificationId: identity, kind, step, attempt, standard, artifact, focus, previous, coverage, vars, marker } = brief;
  return [
    `你是独立验证者：验证 kind=${kind} 的第 ${step} 轮第 ${attempt} 次尝试。`,
    '你没有本次评审的对话上下文，也不属于被验证的 session；你的判断只能来自磁盘上的产出物和你自己跑出来的证据。',
    '',
    ...(artifact === undefined ? [] : [`待验证产出物：${artifact}（在工作区中，自行阅读；不要修改它）。`]),
    ...(vars === undefined || Object.keys(vars).length === 0 ? [] : [
      `本次 run 的记录变量：${Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('、')}`,
      '产出物必须属于这次 run 所指的同一个对象（例如同一份被评审文档）。小节内容谈的是别的对象、'
        + '或明显来自更早的 run 时，本轮按不满足处理。',
    ]),
    ...(marker === undefined ? [] : [
      `本轮在产出物中的小节标题：${marker}`,
      '以这个标题定位本轮小节；标题不符、只有同名但不同对象的旧小节、或该小节缺失时，本轮按不满足处理。',
    ]),
    ...(focus === undefined ? [] : [`本轮焦点：${focus}`]),
    ...(coverage === undefined || coverage.length === 0 ? [] : [
      '',
      `这是本次 run 覆盖全部 ${coverage.length + 1} 轮的最后一次验证，所以本轮不只看本轮焦点：`
        + '本版产出物必须**同时**仍然满足下面每一轮的要求。逐轮复核，把被后来的改动破坏的要求写进 top_findings 并据此扣分——'
        + '本轮通过意味着整份产出物通过，而不只是最后这一轮通过。',
      '',
      '前面各轮的要求（逐轮复核）：',
      ...coverage.map(round => `【${round.title}】\n${round.checks}`),
    ]),
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
    `分数为 0–10（允许小数）。score 小于 8 时 status 必须是 retry 并列出仍未解决的问题。`,
    ...earlyStopLines(),
    '',
    '返回方式：在回复正文的最后输出唯一一个 JSON 对象，不要加代码块围栏，也不要用工具去写文件：',
    `{"verificationId":"${identity}","kind":"${kind}","step":${step},"attempt":${attempt},"score":X,"status":"${LOOP_STATUSES}","evidence":"...","top_findings":["..."]}`,
    'status 为 blocked 或 abstained 时不要 score，改为给 "reason"；abstained 再加上 "needs"。',
    'evidence 必须写出评分依据：跑过的命令与结果、看到的具体失败、或引用的原文。',
    '客户端会读取你回复里的这个对象并落盘；不要自己创建、修改或删除 verdict 文件。',
  ].join('\n');
}

/** Undefined escape sequences made literal, so one backslash cannot discard a whole verdict.
 *
 * A model writing a regular expression or a Windows path inside a JSON string emits `\d` or `\C`
 * without doubling the backslash, and `JSON.parse` then rejects the entire object — spending a review
 * attempt on a formatting slip (a live run lost a valid `score 8.4 · done` verdict to `\d+\.\d+`
 * sitting in `evidence`). Only escapes JSON does not define are rewritten, and the identity check
 * below still decides which round a candidate belongs to, so this cannot admit another round's verdict.
 * @param text - One candidate object's text.
 * @returns The same object with undefined escapes doubled.
 */
export function repairJsonEscapes(text: string): string {
  // Written with explicit characters because the whole job is counting backslashes: a `\\` in this
  // file is one character, and the repair has to produce two.
  const backslash = String.fromCharCode(92);
  const defined = `"${backslash}/bfnrt`;
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== backslash) { out += char; continue; }
    const next = text[index + 1];
    if (next === undefined) { out += backslash + backslash; continue; }
    const valid = defined.includes(next)
      || next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6));
    out += valid ? char + next : backslash + backslash + next;
    index += 1;
  }
  return out;
}

/** Every top-level JSON object in one reply, last one first.
 *
 * A review reply is prose with evidence in it, so the verdict is not the only braces in the text: a
 * quoted snippet before or after it used to be swallowed by a first-brace-to-last-brace slice and
 * made the whole verdict unparsable. Each balanced top-level object is a candidate instead.
 * Braces inside strings are ignored: evidence quotes the record, which is full of `{{placeholders}}`,
 * and counting those as nesting ended the candidate early, so a complete verdict read as unparsable.
 * @param text - Reply or file contents.
 * @returns Parsed objects, most recent first.
 */
function jsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (let index = 0; index < text.length; index += 1) {
    // A JSON object starts with `{"`, so prose quotes cannot desynchronize the scan and a brace
    // inside a string (evidence quoting `{{placeholders}}`) cannot end the candidate early.
    if (text[index] !== '{' || text[index + 1] !== '"') continue;
    const candidateStart = index;
    const end = objectEnd(text, candidateStart);
    if (end === -1) continue;
    index = end - 1;
    const span = text.slice(candidateStart, end);
    const parsed = parseObject(span);
    if (parsed !== undefined) objects.push(parsed);
  }
  return objects.reverse();
}

/** Index just past the `}` that closes the object opened at `start`, or -1 when it never closes.
 * @param text - Text to scan.
 * @param start - Index of the opening `{`.
 * @returns The exclusive end index, or -1.
 */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** One candidate object, parsed as written and then with its undefined escapes repaired.
 * @param span - Text from `{` to its matching `}`.
 * @returns The object, or undefined when both readings fail.
 */
function parseObject(span: string): Record<string, unknown> | undefined {
  for (const candidate of [span, repairJsonEscapes(span)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch { /* try the repaired reading, then give up on this candidate */ }
  }
  return undefined;
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
