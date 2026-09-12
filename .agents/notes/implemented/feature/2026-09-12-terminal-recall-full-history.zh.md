# Agent Note：回填可以翻到会话的开头

Status: implemented

## Problem

↑/↓ 回填的种子来自客户端打开会话时加载的那段 transcript 窗口，而最旧的一条种子被当成了回填的尽头。对于在本客户端连接之前就开始的会话，更早的内容完全不可达：方向键在窗口边界上悄悄停住，而这个边界和对话真正的开头毫无关系。README 把这一点写成了有意为之（"不额外拉取历史页"），但用户看到的结果是一个历史键在宿主明明还有更多内容时回答"没有了"。

## Decision

越过最旧一条保留项时，现在先把保留窗口向前翻一页。`app.tsx` 复用读者滚动历史时用的同一个 `SessionController.older`，以加载前捕获的 `transcript.beforeSeq` 为下界，只把严格更早的 User 消息交给新的 `InputHistory.prepend`，然后补上这次按键本来要的那一步。整页没有 User 消息时在同一次有界循环里跳过（最多 5 页），因此一页只有工具调用不会把按键卡住；`historyPaging` 保证同时只有一次请求在飞，`controller.perform` 则让重复按键排队不进去。

`prepend` 刻意不做淘汰。200 条 / 256 KiB 的预算仍然约束会话种子与提交保留的内容，下一次 `record` 会把缓冲收敛回这两个上限，于是"往回走多远"由读者实际要求看多少决定，而不是由会话碰巧以哪个窗口打开决定。因为这一页落进的是实时 transcript，回填到的邻居也能在输入框上方滚到，读者回到实时末端后历史回收照常恢复。

## Alternatives considered

专门做一个只读的提示词分页器（像 `searchHistory` 那样用临时 `Transcript`）被否决：那等于写第二套分页实现，而 transcript 本身就是分页器，它的钉住与回收语义已经描述了"离开实时末端阅读"这件事，取回的页面在对话里也比只在输入框里有价值。打开会话就一次性加载全部历史被否决，因为那正好废掉 transcript 用来兜住内存的窗口，还为读者可能永远不会回填的历史付钱。让 `prepend` 按预算淘汰同样被否决：被淘汰的恰好是读者刚刚要求看到的更早条目；而让光标保持原位也正是这个键"退一条"语义成立的原因。

## Consequences

`tests/ui/input-history.test.ts` 钉住 prepend 的顺序、光标保持、空条目与超大条目的跳过，以及翻页后退回时草稿的恢复。`tests/ui/app.test.tsx` 用一个 snapshot 从 seq 2 开始且 `hasMore` 的夹具走了一遍，断言只发出一次携带 `beforeSeq: 2` 的 `session/page` 请求，能到达 prompt 1 与 prompt 0，并断言会话最旧的提示词就是回填的尽头——不再发请求，也不留下加载提示。双语 README 与 `tui-design.md` 都记录了翻页行为。
