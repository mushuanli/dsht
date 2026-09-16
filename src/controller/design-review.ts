/** The design-review protocol: the ten rounds a `/design-review` run walks through.
 *
 * Everything mechanical lives in `loop.ts`; this module is only the text the agent receives and the
 * step count, so a second review command adds a sibling file rather than another loop.
 */
import { LOOP_MARKER, followUpContract, resultContract } from './loop-contract.ts';
import type { LoopLimits, LoopProtocol } from './loop.ts';

/** Rounds the review protocol defines; `--to` defaults to the last one. */
export const DESIGN_REVIEW_ROUNDS = 10;

/** Round titles, indexed from 1 so `ROUND_TITLES[step]` is the round's name. */
const ROUND_TITLES = [
  '',
  '职责与归属',
  '依赖关系',
  '接口审查',
  '状态审查',
  '变化传播测试',
  '删除式审查',
  '反证当前方案',
  '一致性检查',
  '过度设计检查',
  '最终收敛',
] as const;

/** What each round must actually inspect. */
const ROUND_CHECKS: readonly string[] = [
  '',
  '逐个模块/类/服务/Store/Controller/组件：它为什么存在？核心职责能否一句话说明？是否只有一个变化原因？是否混合了不同生命周期的职责？是否因"方便统一管理"承担了不属于自己的职责？状态与行为真正属于谁？是否有 God Object/God Module 趋势？重点找：表现层状态进入业务层、基础设施细节进入业务模型、一个模块同时承担数据/控制/格式化/网络/持久化、顶层协调器做了本应模块自己做的事、通用模块变成所有功能的中心。',
  '按真实 import/调用/类型引用画依赖图，不看目录名。逐条检查：不必要依赖？同层横向依赖？隐藏的 type-only 依赖？上层直接依赖底层实现？底层反向理解上层业务？表现层直接依赖业务服务或基础设施？是否用 common/shared/types/barrel/facade/helper 隐藏真实耦合？特别警惕"只是 import type""只是 getter""只是 facade""只是 barrel""只是公共 helper"。',
  '逐个检查 public API、参数、返回值、props 与跨模块数据：调用者真的需要整个对象吗？只用到几个字段吗？是否获得了超出需要的能力？是否暴露内部实现类型或 mutable state？能否换成更小、更稳定、更语义化的数据结构？参数表达的是业务意图还是实现方式？优先 plain object、readonly array、判别联合、最小 callback、语义化 DTO/Snapshot/Result；避免跨边界传 Controller/Service 实例、数据库/Client/Connection、内部状态容器、mutable collection、原始协议对象、Json/any/unknown 逃生口、巨大 Context/Actions/Manager。遵循最小能力原则。',
  '对每个状态问：谁拥有、谁修改、谁读取、生命周期是什么、是否需要持久化、是否需要跨模块共享、能否由其他状态计算得到？状态应靠近真正使用者：组件能持有就不上提模块 Store，模块能持有就不上提全局 Store，能派生就不重复存储。重点检查 source state 与 derived state 是否被同时长期保存，避免多个事实源。',
  '不要只看"能工作"，要测变化传播多远。A 外部协议/API/数据格式变化：理想只影响 infrastructure/adapter/mapper，若业务与 UI 大面积修改说明协议泄漏。B UI/表现形式变化（布局、CLI→Web、状态栏字段、颜色/排序/折叠）：理想只影响表现层，若业务逻辑随之改动说明表现语义泄漏。C 核心业务规则变化（算法、计费、校验、状态机）：理想只影响对应功能模块。D 新增一个功能：需要改多少旧模块？是否必须改巨大中央 Controller 或 shared/common/core？是否要在多处加同一个 case？理想是新增代码多、修改旧代码少。',
  '假设当前方案"基本正确"，专门寻找可以删除的东西：哪个目录/interface/abstraction 没有独立语义？哪个 facade 只是原样转发？哪个 barrel 只隐藏真实路径？哪个 Store abstraction 只是重复 get/set/update？哪个 ViewModel/read-model/adapter 是不必要的中间层？哪个 Controller 方法应该消失？哪个 DTO 只为满足架构形式而存在？哪个公共类型只为绕开依赖规则？哪些只为"看起来更分层"？原则：若 A→B→C 而 B 只原样转发/返回、无独立策略与稳定语义、不隔离变化，优先 A→C。',
  '假设当前方案是错的，主动寻找它未来最可能坏掉的方式：哪个新模块会成为下一代 God Object？哪个 Store 会成为所有状态的垃圾场？哪个 Controller 会重新变成所有功能入口？哪个 shared/common/types 会变成公共垃圾场？哪个 read-model 会成为所有数据的中央聚合器？哪个 UI root 会重新成为巨型状态机？哪个 Snapshot 暴露过多内部信息？哪个"解耦层"只是把依赖搬到了别处？是否为了禁止依赖制造大量 DTO/Adapter/Port？是否为了低耦合增加过多中间层？是否为了满足模式提高理解与修改成本？对每个发现继续问：能否通过删除而不是新增架构来解决？',
  '把设计文档、接口定义、依赖规则与状态归属交叉检查，列出所有矛盾：原则说 A 不能依赖 B 但代码或依赖表允许；声称边界是 plain data 但接口仍暴露内部对象；声称 Query 无副作用但实际写操作；声称某层不知道某模块但通过 types/barrel 间接引用；同一状态在不同章节归属不同；同一概念有多个事实源；架构图与实际 import 方向不一致；命名表达的职责与真实职责不一致。',
  '单独检查是否超过实际问题所需复杂度：当前规模真的需要这些层吗？这个 abstraction 今天解决了什么具体问题？删除它真正会失去什么？是否只为未来"可能"的需求？能否等第二个真实用例出现再抽象？是否为了测试而制造生产代码复杂度？是否为了依赖倒置创建大量同形接口？是否为了目录整齐增加无语义的层？遵循 Rule of Three：第一次直接实现，第二次允许少量重复，第三次模式稳定后再抽象。',
  '完成前面所有检查后重新整体审查一次，禁止再引入新的架构模式。只判断：当前设计是否已经足够简单？哪些是 P0 必须修改？哪些是 P1 值得修改？哪些只是理论洁癖应保持现状？哪些抽象应该删除？哪些状态应该移动？哪些接口应该缩小？哪些依赖应该禁止？最终推荐的依赖关系是什么？是否已到"停止设计、开始实施"的阶段？',
];

/** The shared header of every round's brief. */
function briefHeader(limits: LoopLimits, step: number, attempt: number, verification?: string): string[] {
  return [
    '你是一名资深软件架构师。请对下面的软件架构、模块设计、代码组织或重构方案进行系统审查。',
    '',
    `审查范围：第 ${limits.from} 轮到第 ${limits.to} 轮；每轮及格线 ${limits.score} 分（0–10，允许小数）；每轮最多 ${limits.tries} 次尝试。`,
    `本次只执行第 ${step} 轮的第 ${attempt} 次尝试。完成这一轮后立即停止，不要自行进入后续轮次或重复尝试。`,
    '',
    '你的目标不是套用 MVC、DDD、Clean Architecture、Hexagonal、CQRS、DI 等架构模式，而是寻找最简单、最稳定、最容易长期维护的边界。',
    '',
    '优先目标（冲突时按此顺序决策）：',
    '1 高内聚 > 模式完整；2 低耦合 > 目录漂亮；3 最小接口 > 通用接口；4 明确归属 > 全局统一；',
    '5 局部状态 > 全局状态；6 单一事实源 > 同步多个副本；7 删除抽象 > 新增抽象；8 真实需求 > 未来假设；',
    '9 可维护性 > 理论纯洁；10 简单直接 > 架构炫技。',
    '不要因为模式名词本身而引入复杂度；只有某个模式确实解决已存在的问题时才使用。',
    '',
    `本轮主题：第 ${step} 轮 · ${ROUND_TITLES[step] ?? '收敛审查'}`,
    '本轮检查要点：',
    ROUND_CHECKS[step] ?? ROUND_CHECKS[DESIGN_REVIEW_ROUNDS]!,
    '',
    '输出要求：不要输出冗长的内部思维过程，只输出——',
    '- 发现的问题',
    '- 判断依据',
    '- 修改建议',
    '- 修改后减少了什么耦合或复杂度',
    '- 本轮收敛结论',
    '',
    ...resultContract('design-review', limits, step, attempt, verification),
  ];
}

/** The protocol the `/design-review` command runs.
 * @param verification - Standard `/verify` set for this session, when any.
 * @returns The protocol the scored loop runs.
 */
export function designReviewProtocol(verification?: string): LoopProtocol {
  return {
    marker: LOOP_MARKER,
    kind: 'design-review',
    title: `Design review${verification === undefined ? '' : ' (verified)'}`,
    steps: DESIGN_REVIEW_ROUNDS,
    brief: (limits, step, attempt) => briefHeader(limits, step, attempt, verification).join('\n'),
    followUp: (limits, step, attempt) => [
      `现在是第 ${step} 轮、第 ${attempt}/${limits.tries} 次尝试（及格线 ${limits.score}）。`,
      `阅读上面的结果、意见与建议，按第 ${step} 轮（${ROUND_TITLES[step] ?? '收敛审查'}）的要求继续改进；`,
      '上一版未解决、未回应的 blocking 问题必须逐条处理。',
      followUpContract('design-review', step, attempt),
    ].join('\n'),
  };
}
