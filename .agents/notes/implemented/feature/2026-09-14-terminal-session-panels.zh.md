# Agent Note：面板属于它们自己的会话

Status: implemented

## Problem

六个面板标志原先作为 `useState` 住在 `ui/app.tsx`：思考面板、队列面板、模型对话框的步骤，以及历史／搜索的 query、模式与命中。它们由三个不同的 effect 重置（分别以记录、会话 ID 与待答事件为键），因此"切换会话后哪个面板还开着"取决于哪个 effect 恰好运行。这些面板显示的行本来就来自记录，所以这些标志是 `SessionInfo` 之外仅剩的会话级状态。

## Decision

`SessionInfo.panels` 持有 `{ thoughts, queue, model?, history?, search? }`，只由 `SessionController` 写入（`openThoughts`、`openQueue`、`setModelPanel`、`setHistoryPanel`、`setSearchPanel`），并由 `SessionInfo.reset()` 清空——那三个重置 effect 因此删除。`ModelState` 移入会话域（`src/session/info.ts`），对话框改为再导出，模型对话框的步骤形状从此只有一个定义。

面板内的行光标仍住在 `Picker`，仍由 `key={identity}` 重置：它是焦点而不是会话数据，提升它会让每次方向键都重渲染整棵树。

## Alternatives considered

在记录与会话其余部分都归于一个所有者之后，把面板标志留在组件里被否决：没有理由让面板可见性成为例外，而零散的重置正是可见的症状。把面板光标也放进 `SessionInfo` 被否决，理由与交互状态相同——模态内部的焦点不该让每次按键都触发整树重渲染。

## Consequences

`tests/ui/app.test.tsx` 新增一条：通过 `/queue` 打开队列面板、置入其余面板字段，切到 `s2` 后断言每个字段都被清空且面板不再出现在帧里。`tui-design.md` 的 5.3 / 5.5 / 5.7 与附录记录了新的所有者，§5.7.5 标记迁移六步全部完成。没有用户可见行为变化，因此 README 双语未改。
