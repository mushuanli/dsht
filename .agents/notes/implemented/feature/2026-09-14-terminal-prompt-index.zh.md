# Agent Note：回填改由会话提示词索引承担

Status: implemented

## Problem

↑/↓ 回填过去是一个有界缓冲（200 条 / 256 KiB），会话种子与每次提交共用这一份预算。transcript 窗口的生命周期比这份预算长，于是一条提交把最旧条目挤出缓冲时，丢掉的提示词其实还在窗口里；而边界翻页只取严格早于 `transcript.beforeSeq` 的记录，取不回它。在长会话里，读者已经回填过的提示词会永久退出方向键的范围——而这正是该功能存在的理由。

## Decision

回填改为读取由 `SessionController` 持有的会话级 `PromptIndex`（`src/session/info.ts`）。每条条目携带它的来源序号，于是预算只约束内存、不决定可达性：

- **尾部折叠**：每次 `session/follow` 帧后，控制器调用 `Transcript.promptsSince(through)`，它只读比上次折进更新的原始记录并抽取 user prompt。只扫描未见过的那一段，因此流式期间是 O(新增)，也不会为了发现一条提示词而在第二个宽度上重建行投影。
- **可重载淘汰**：`trim()` 在超过 2,000 条 / 512 KiB 时丢弃最旧条目。在索引最旧一条上再往回一步时，先调用 `refillRecall()` 把已加载窗口仍持有的提示词补齐（`Transcript.promptsBefore(oldest)`），只有窗口也用尽才走既有的 `SessionController.older` 分页。
- **本地命令**：slash 命令不会成为持久记录，因此保留在同一索引中并标记为非持久；本地记录的提示词收到持久回声时，把那条条目升级为带序号，而不是追加第二份。
- 预算只是内存上的平衡，不是可达性规则：被淘汰的提示词要么仍在已加载窗口内，要么仍在宿主上。

`InputHistory` 与 `ui/input/history.ts` 一并移除。

## Alternatives considered

保留原缓冲、只加一个序号字段被否决：冲突在于会话数据与输入状态共用同一份预算，小改动会让淘汰线与翻页边界再次错位。打开会话即预载全部提示词（复用计费扫描）在这一步被否决，因为它买到的是常驻而不是可达，并把一次全量遍历加进打开路径；设计把它保留为可选的更深种子（`tui-design.md` 5.7.4）。每帧把窗口折进索引也被否决：那会每帧重扫整个窗口，而旧实现明确避免了这一点。

## Consequences

`tests/session/info.test.ts` 固定序号升级、可重载预算、窗口正反两个方向的扫描、注入上下文的排除，以及"一帧只有工具／助手记录时折进水位仍然前进"——否则这一轮之后的每一帧都会重扫它。`tests/ui/app.test.tsx` 保留原有翻页测试，并新增一条：把一页滚进窗口后，回填应从窗口恢复且不再发起第二次 `session/page`。README 双语、`tui-design.md` 的 2.6 / 4.3 / 5.3 / 5.5 / 5.7 与附录同步记录该变更。尚未完成：`view` / `panels` / `answers` / `reference`，以及 `record` 的统一。
