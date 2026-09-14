# Agent Note：一次历史读取同时供计费与回填

Status: implemented

## Problem

打开会话时会把宿主历史往回走一遍，把每条 user prompt 折进回填索引；计费扫描也会在连接时与每分钟用同样的 80 条/页走同一份历史。对读者在启动后紧接着打开的那个会话，日志被读了两遍，而第二遍之所以存在，只是因为两个域各自拥有一个读取者。

## Decision

计费扫描现在把它已经拿在手上的每一页交给会话域：`sessionCostHistory` 增加可选的 `onRecords(records)` 回调，`CostController` 通过 `CostHost.scanPage`／`scanDone` 转发，门面把它们接到 `SessionController.rememberScanPage`／`rememberScanDone`。会话侧用 transcript 自己的 `recordPrompts` 解析页面，因此从 wire 记录直接读出的提示词与从实时流折出来的完全一致，然后折进进程级 `PromptCache`。

`selectSession` 随后 `adoptCachedPrompts` 采用完整的缓存条目而不再遍历，所以"扫描之后的打开"是 0 请求；未命中则回落到既有的有界回填，而回填走到开头时也会写入缓存。缓存按 session id 键、按字节 LRU（至少保留一个条目），并且只有 `complete` 条目可用——被取消一半的扫描留下不完整条目，打开时会忽略它，因为它缺的正是最旧的那一段。

## Alternatives considered

把每会话费用放进 `SessionInfo` 被否决：账本是跨会话的、落盘的、每次扫描都会重新折叠，而 `CostLedger.replace` 每次都会换成一个新对象，因此无论存副本还是存引用，下一次扫描后就已过期。UI 改为走 `Controller.sessionCostText`，这同时替代了状态栏里重复出现两次的表达式。让会话域拥有这次共享遍历也被否决：计费需要每个会话，回填只需要打开的那个，而本来就在遍历全部会话的是扫描器。

## Consequences

因为预算而丢弃过前缀的索引不再声称自己已穷尽（`PromptIndex.trimmed`，`markComplete` 会拒绝），否则被丢掉的提示词比实时窗口更旧、惰性路径也取不回——缓存与穷尽标志会一起宣称一个带洞的列表。`tests/ui/app.test.tsx` 断言扫描会预热缓存、随后的打开不再新增 `session/page` 请求；`tests/session/info.test.ts` 覆盖页面顺序、完成标记、按字节淘汰与丢弃保护。`tui-design.md` 的 4.3 / 4.5 / 5.1 / 5.3 / 5.5 / 5.7 与附录记录了该变更。没有用户可见行为变化，因此 README 双语未改。
