# Agent Note：输入框属于它自己的会话

Status: implemented

部分被 `architecture/2026-09-15-layered-boundaries-and-plain-ui-contract` 取代：输入框重新成为 `ui/app.tsx` 的组件状态（切换会话由一处 effect 清理），因为光标与寄存草稿不是会话数据。

## Problem

输入框原先住在 `ui/app.tsx` 里，一份 React state 加一个 `draft` ref 镜像。切换会话时没有任何东西重置它：`selectSession` 会新建 `Transcript`、重置回填索引，但草稿、光标以及被阻塞对话框寄存的草稿都留了下来，于是一个会话里写了一半的提示词会出现在下一个会话里。那个 ref 镜像的存在只是因为 Ink 的输入回调可能在受控监听器刷新之前就运行，这等于同一个值有两个来源。

## Decision

输入框现在是 `SessionInfo`（`src/session/info.ts`）的一部分，也就是控制器作为 `State.session` 暴露的会话级容器。`SessionController` 通过 `setComposer`、`setComposerCursor`、`parkComposer`、`restoreComposer` 写入，`releaseTranscript()` 在打开另一个会话或释放当前会话时把整个会话——提示词索引与输入框一起——重置。`setComposer` 只在文本或光标真的变化时才发布，因此一次没有改变任何东西的按键不会带来渲染。

`ui/app.tsx` 只保留一个 `setInput` 助手，承担两件不属于会话状态的副作用——消息草稿由空变为非空时把视口带回实时末端，以及编辑回填内容时离开回填导航——并在回调里读 `controller.composer` 而不是 `draft` ref。控制器状态永远是最新的，因此 ref 镜像、`updateInput` 与 `setCursor` 都删掉了。

## Alternatives considered

把草稿留在 React state、再加一个监听 `state.sessionId` 的重置 effect 被否决：值仍然存在于两处，而且修法本身又新增一处零散重置，正是这个容器要消除的模式。让输入框走另一个新的 `State` 字段而不是 `state.session` 被否决，因为会话事实应当只有一个所有者。把输入框留在 UI 侧、只在切换会话时清空也被否决，因为光标与寄存草稿共享同一生命周期，会各自继续需要一套规则。

## Consequences

`tests/ui/app.test.tsx` 新增一条：输入草稿、切到 `s2`，断言输入框为空且草稿不再出现在帧里。README 双语记录了"切换会话会清空未发送草稿"。`tui-design.md` 的 5.3 / 5.5 / 5.7 与附录记录了新的所有者。尚未完成：`view`、`panels`、`answers`、`reference`，以及 `record` 的统一。
