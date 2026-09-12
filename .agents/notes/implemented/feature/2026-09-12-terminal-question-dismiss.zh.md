# Agent Note：Esc 放弃待答提问

Status: implemented

## Problem

`ask_user_question` 请求过去只能靠"回答"来结束。提问对话框会寄存输入框，因此它打开时 `/cancel` 根本打不进去；而 `Esc` 与 `Ctrl+C` 是刻意保留待答交互的——脚注也正是这么写的。于是不想回答任何选项的用户，除了随便选一个选项或重启客户端之外无路可走，而 Web 客户端在同一个请求上明明提供了关闭按钮。

## Decision

在待答提问上按 `Esc` 现在会把该 waterfall 以"拒绝"结算，与 Web 客户端的关闭按钮完全一致：`$events/result` 携带 `{ kind: 'rejected', error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' } }`。`SessionController.dismissQuestion` 负责发送并移除本地保留的交互，因此宿主记为取消而不是回答。一组提问是作为一次请求回答的，所以放弃也会丢弃同一批中已经收集到的前几题答案。

两道守卫让这个键不会做超出用户意图的事。`Other answer` 保留原有的逐级退出——第一次 `Esc` 回到选项，再按一次才放弃——因此自由输入不会被一次按键丢掉。审批不变：Web 端只有"拒绝"和"允许一次"，所以 TUI 保留显式的 `1`/`2`/`3` 列表，`Esc` 仍只清除高亮。两个对话框上的 `Ctrl+C` 也不变：清空草稿，否则保持待答。

## Alternatives considered

把 `Esc` 直接映射为 `session/cancel` 被否决：它离"停掉整轮工作"只有一次按键之遥，宿主看到的是中止而不是用户取消，而且会让提问对话框与 Web 客户端行为不一致。在 `Other answer` 里直接放弃也被否决：那里用户正在打字，一个按 `Esc` 就丢文本的输入框比多按一次键更糟。彻底不给退出路径同样被否决：唯一的出口变成了回答一个用户并不想要的答案。

## Consequences

`tests/ui/app.test.tsx` 覆盖了从选项列表放弃（断言 wire 上的 rejected 结果、没有发送 `session/cancel`、对话框从画面消失）、`Other answer` 的两步退出，以及审批在 `Esc` 之后仍原样保留。提问脚注现在写明 `Esc dismisses`，无选项提问的脚注行也会提到它。`tui-design.md` 与双语 README 都记录了新语义。
