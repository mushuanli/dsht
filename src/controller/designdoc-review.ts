/** The design-document review protocol: rounds that check a document against the code it describes.
 *
 * It is the same scored loop `/design-review` uses; only the objective and the per-round rubric
 * differ, which is exactly what `LoopProtocol` is for.
 */
import { LOOP_MARKER, followUpContract, resultContract, verdictBrief } from './loop-contract.ts';
import type { LoopLimits, LoopProtocol, PriorVerdict, VerifyTarget } from './loop.ts';

/** Rounds the review defines; `--to` defaults to the last one. */
export const DESIGNDOC_REVIEW_ROUNDS = 10;

/** Workspace file each round appends to, so a fresh verifier can read the review itself. */
export const DESIGNDOC_REVIEW_ARTIFACT = 'DESIGN-DOC-REVIEW.md';

/** Round titles, indexed from 1 so `ROUND_TITLES[step]` is the round's name. */
const ROUND_TITLES = [
  '',
  '定位与范围',
  '结构与导航',
  '与代码一致性',
  '完整性与悬空引用',
  '准确性',
  '单一事实源',
  '可维护性',
  '可执行性',
  '删减与过时',
  '收敛结论',
] as const;

/** What each round must actually inspect. */
const ROUND_CHECKS: readonly string[] = [
  '',
  '这份文档为谁写、承诺记录什么/不记录什么、覆盖哪些模块与边界？是否有明确的边界声明（本文不是规范/不覆盖什么）？与 README、CONTRIBUTING 的分工是否说清？若读者只关心一个子系统，能否从目录直接找到入口？',
  '章节层级是否可预期、能否只读一节就完成一项任务？术语是否统一并有定义或术语表？交叉引用是否指向存在的锚点/章节？篇幅与信息密度是否匹配，是否有大段可压缩的叙述？',
  '把文档里的每条结构性声明与实际代码对照：目录依赖规则与 import 边界、导出符号与文件清单、状态归属与生命周期、命令表与 CLI 选项、宿主端点与帧结构。逐条列出「文档说 A、代码做 B」的差异，并给出代码侧证据（文件:符号）。',
  '文档引用的文件、符号、章节、命令、参数是否存在？关键决策是否记录了原因与取舍，而不只是结论？反过来看：代码里重要的机制（谁拥有状态、谁负责回收、失败如何传播）是否在文档中有位置？列出悬空引用与缺失章节。',
  '具体数字（行数、文件数、条数、上限、默认值）、路径、命令、参数、时序（谁在何时写、何时释放）是否与实现一致？示例命令能否直接运行？表格里的计数是否与当前 HEAD 相符？逐条给出实测值与文档值。',
  '同一概念是否在多处重复定义、可能互相漂移（例如同一状态在不同章节归属不同、同一默认值写了两遍、同一路径出现三种写法）？是否有一处权威定义、其它处只引用？指出所有多事实源并建议唯一的归属位置。',
  '文档是否写明「什么变化必须同步更新本文」？易腐内容（行数、文件计数、依赖表、截图）是否有维护约定或生成方式？更新一次的成本是否被控制（能否只改一处）？哪些内容应当改为指向代码/生成物而不是复制？',
  '一个新人能否照着文档跑起来、定位代码、完成一次改动？是否给出验证方式（命令、测试、断言）？是否存在只有作者才懂的隐含前提（环境变量、前置步骤、未写明的约定）？把最小可执行路径写出来并指出缺口。',
  '与当前 HEAD 漂移的历史章节、已被取代的决策、重复段落、失去意义的例子分别是什么？哪些内容删除后不损失信息？哪些"未来计划"只是假设、应当删除或标注状态？给出可删除清单与理由。',
  '完成前面所有检查后重新整体判断，不要引入新的文档结构：P0 必须修改（会导致错误理解或错误实现）、P1 值得修改、保持现状（继续改属于过度设计）、可以删除的章节/段落/表格。最后回答：这份文档是否已经足够支撑维护，还是仍需要补充设计？',
];

/** Rubric one round is scored against: the round's own checklist plus any operator standard. */
function standardFor(step: number, verification?: string): string {
  const checks = ROUND_CHECKS[step] ?? ROUND_CHECKS[DESIGNDOC_REVIEW_ROUNDS]!;
  return verification === undefined ? checks : `${checks}\n\n额外要求（由 /verify 提供）：\n${verification}`;
}

/** The protocol the `/designdoc-review` command runs.
 * @param path - Document under review, as written in the workspace.
 * @param verification - Standard `/verify` set for this session, when any.
 * @param forked - Delegate each round's verdict to an independent verifier process.
 * @returns The protocol the scored loop runs.
 */
export function designdocReviewProtocol(path: string, verification?: string, forked = false): LoopProtocol {
  return {
    marker: LOOP_MARKER,
    kind: 'designdoc-review',
    title: `Designdoc review · ${path}${verification === undefined ? '' : ' (verified)'}${forked ? ' · forked' : ''}`,
    steps: DESIGNDOC_REVIEW_ROUNDS,
    artifact: DESIGNDOC_REVIEW_ARTIFACT,
    stepLabel: step => ROUND_TITLES[step] ?? '收敛结论',
    brief: (limits, step, attempt) => brief(path, limits, step, attempt, verification, forked),
    ...(forked ? { verify: (limits: LoopLimits, step: number, attempt: number, target: VerifyTarget, previous?: PriorVerdict) => verdictBrief({
      ...target, kind: 'designdoc-review', step, attempt, previous, standard: standardFor(step, verification),
      artifact: DESIGNDOC_REVIEW_ARTIFACT, focus: `第 ${step} 轮 · ${ROUND_TITLES[step] ?? '收敛结论'}`,
    }) } : {}),
    followUp: (limits, step, attempt) => [
      `现在是第 ${step} 轮、第 ${attempt}/${limits.tries} 次尝试（及格线 ${limits.score}）。`,
      `以 ${path} 为准，按第 ${step} 轮（${ROUND_TITLES[step] ?? '收敛结论'}）的要求处理上一版未解决的问题，并更新工作区文件 `
        + `${DESIGNDOC_REVIEW_ARTIFACT} 中本轮的小节。`,
      followUpContract('designdoc-review', step, attempt),
    ].join('\n'),
  };
}

/** Build one round's brief: the document, this round's rubric, and the result contract. */
function brief(path: string, limits: LoopLimits, step: number, attempt: number, verification?: string, forked = false): string {
  const title = ROUND_TITLES[step] ?? '收敛结论';
  const checks = ROUND_CHECKS[step] ?? ROUND_CHECKS[DESIGNDOC_REVIEW_ROUNDS]!;
  return [
    `你是一名资深软件架构师兼技术文档维护者。请对工作区中的设计文档 \`${path}\` 做系统审查，判断它是否准确、完整、可维护，并与当前代码一致。`,
    '',
    `审查范围：第 ${limits.from} 轮到第 ${limits.to} 轮；每轮及格线 ${limits.score} 分（0–10，允许小数）；每轮最多 ${limits.tries} 次尝试。`,
    `本次只执行第 ${step} 轮的第 ${attempt} 次尝试。完成这一轮后立即停止，不要自行进入后续轮次或重复尝试。`,
    '',
    '判断原则（冲突时按此顺序）：准确 > 完整 > 简洁；与代码一致 > 文采；单一事实源 > 多处重复；可维护 > 面面俱到；能删除 > 新增章节。不要为了"看起来更完整"而增加无人维护的内容。',
    '',
    `本轮主题：第 ${step} 轮 · ${title}`,
    '本轮检查要点：',
    checks,
    '',
    '输出要求：不要输出冗长的内部思维过程，只输出——',
    '- 发现的问题（逐条，附文档位置与代码/实测证据）',
    '- 判断依据',
    '- 修改建议（具体到章节与改法）',
    '- 修改后减少了什么维护风险',
    '- 本轮收敛结论',
    '',
    `每轮结论必须写入工作区文件 ${DESIGNDOC_REVIEW_ARTIFACT} 的 “## 第 ${step} 轮 · ${title}” 小节：不存在则创建，已存在则替换该小节，不要覆盖其它轮次。验证者会直接读这个文件。若工作区不可写，则在正文给出完整内容并在 evidence 中说明。`,
    '若本轮确实没有可改进项，请如实在 status 中给 done 并说明无需改进，不要为了触发重试而压低分数。',
    '',
    ...resultContract('designdoc-review', limits, step, attempt, {
      standard: standardFor(step, verification),
      artifact: DESIGNDOC_REVIEW_ARTIFACT,
      focus: `第 ${step} 轮 · ${title}`,
    }, forked ? 'forked' : 'subagent'),
  ].join('\n');
}
