# Agent Note：记录只有一个所有者

Status: implemented

## Problem

选中会话的 `Transcript` 原先作为独立字段住在 `State.transcript` 里，而会话的其余部分——提示词索引、输入框、阅读视图、交互状态——已经迁入 `State.session`。一个会话有两个入口，意味着"切换会话"要同时记得两处，`selectSession`、`pickWorkspace` 与释放路径也各自构造或销毁 transcript。

## Decision

`SessionInfo.record` 现在是会话 `Transcript` 的唯一强引用。`SessionInfo.reset()` 释放旧记录（`releaseHistoryLayout` + `dispose`）、新建一份，并关闭任何独立历史窗口，因此原先要替换记录的调用点现在只需重置会话。`State.transcript` 已移除；只需要 transcript 的代码走 `Controller.record` 读取，`ui/app.tsx` 读 `state.session.record`。

记录仍是所有派生数据的唯一来源：提示词索引从它折叠，阅读视图指向它或指向独立窗口，行缓存仍是以它为键的 `WeakMap`——而它现在保证有一个强引用键。

## Alternatives considered

保留 `State.transcript` 作为别名、再在旁边加 `SessionInfo.record` 被否决：同一个对象挂在两个属性上仍然是两个入口，而且由于 `update()` 会展开 state，别名 getter 会悄悄变成快照。切换会话时不替换对象、改为原地重写（`record.accept(snapshot)`）被否决，因为行缓存、已折叠的提示词索引与独立窗口判断都以对象身份为键。

## Consequences

`tests/ui/app.test.tsx` 新增一条：断言 `controller.record === controller.state.session.record`、切换会话后换成新对象、旧记录 `ready` 为 false。测试里 88 处 `controller.state.transcript` 改为 `controller.record`，输入基准改为替换 `state.session.record`。`tui-design.md` 的 2.5 / 5.3 / 5.5 / 5.7 与附录记录了该变更。没有用户可见行为变化，因此 README 双语未改。剩余：可选的面板可见性（`panels`）。
