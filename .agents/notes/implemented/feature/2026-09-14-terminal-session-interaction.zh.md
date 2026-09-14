# Agent Note：作答与菜单高亮属于它们自己的会话

Status: implemented

## Problem

围绕宿主待答 waterfall 与 `@` 引用菜单的三块状态原先住在 `ui/app.tsx`：按事件 ID 键的部分提问作答、被高亮的选项或审批行、以及引用菜单的高亮行与抑制它的草稿。waterfall 本身早已由 `SessionController.pendingFor` 按会话派生，因此本地选择可能活得比它所属的请求更久：切换会话后，读者已经离开的那个会话仍留着高亮和半套作答。

## Decision

`SessionInfo.interaction` 持有 `{ answers, option, approval }`，`SessionInfo.reference` 持有 `{ index, dismissed }`，只由 `SessionController` 写入（`setAnswers`、`setOption`、`setApproval`、`setReferenceIndex`、`setReferenceDismissed`），并由 `SessionInfo.reset()` 清空。`@` 菜单抓取到的条目刻意留下：`lookup` 由当前 draft 与会话 ID 现算，存下来只是多一个需要失效的缓存。

两种状态的寿命被有意设计成相反，文档保持这一点：选择器行光标住在 `Picker` 内部、由 `key={identity}` 重置，因为它是焦点；而作答选择被提升到会话容器，因为它必须在底下的 `pending` 事件变化时仍然保留。

## Alternatives considered

把作答留在组件里、再加一个监听 `state.sessionId` 的 effect 清空被否决：重置依然是零散的，而且 `pending` 的事件 ID 可以在不换会话的情况下变化。把 `lookup` 一并迁入被否决，因为它是派生的查询结果而不是会话状态。给 `interaction` 单独的 `State` 字段而不是嵌进 `SessionInfo` 被否决：会话事实应当只有一个所有者。

## Consequences

`tests/ui/app.test.tsx` 新增一条：打开 `@` 菜单、移动高亮、置入部分作答、选项选择与审批高亮，然后切到 `s2`，断言全部被清空且菜单不再跟随。`tui-design.md` 的 5.3 / 5.5 / 5.7 与附录记录了新的所有者。没有用户可见行为变化，因此 README 双语未改。尚未完成：`panels` 与 `record` 的统一。
