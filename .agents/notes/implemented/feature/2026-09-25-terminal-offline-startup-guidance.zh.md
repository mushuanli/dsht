# Agent Note: 启动选择器说明宿主为何连不上

Status: implemented

## Problem

`dsht` 刻意不启动 Harness，所以"宿主不可达"是一个有已知解法的操作问题——但启动界面并不说明这一点。宿主连不上时，工作区选择器照旧显示一个被禁用、内容为空的列表，唯一的解释是那一行红色原始传输错误（`connect ECONNREFUSED 127.0.0.1:3080`）和它上面的 `Reconnecting…`。这既没回答"出了什么事"，也没回答"接下来做什么"：`dsh web` 必须先运行、首次运行要导出它打印的 URL 这两件事只写在 README 里。而在第一次尝试刚开始、还没有任何失败时，屏幕已经摆出一副失败的样子。

## Decision

启动选择器的每一种离线状态现在都渲染引导块，而不是列表。`src/ui/offline.ts` 是一个纯叶子模块，把已发布的连接状态映射为标题、几行短句与可选的暗色 detail；`ui/dialogs/index.tsx` 以 `OfflinePanel` 渲染它，`ui/app.tsx` 在 `screen` 为 `workspaces`／`sessions` 且 `online` 为 false 时用它替代选择器。三种状态就是连接本来就发布的三种事实：

- `Connecting…`——首次尝试仍在进行，因此标题写"连接中"而不是"离线"。还没试完就宣称离线只是猜测。
- `Host offline`——某个连接代际已失败，因此给出 `npx @deepseek-ai/dsh web`，以及 README 记录的首次运行 `DSH_URL` 导出行。
- `Login required`——宿主拒绝了本客户端，因此要求 `dsh web` 打印的 URL 或 `DSH_TOKEN`，并重申 token 永不保存。

原始传输错误被保留但降级：它作为 `detail` 传输，以暗色渲染在引导下方，而不是充当主消息。该块只在两个启动界面上替代选择器；对话仍保留自己的记录，状态栏继续报 `! Offline`，状态行与失败行只在引导块已经同时承载两者时才被抑制。

## Alternatives considered

解析传输错误文本来识别 socket 错误码（`ECONNREFUSED`、`ENOTFOUND`、`ETIMEDOUT`）被否决：连接控制器本来就把 `Login required` 与其余失败区分开，而对拒绝连接、超时与未知主机来说，"启动宿主"是同一句指示，再分一次类只会引入脆弱文本依赖而不改变答案。给 `State` 增加结构化 fault 字段也因同一理由被否决——已发布的状态本身就是引导所需的那一个区分。保留列表、只在上面加一行提示被否决：空的、被禁用的列表仍是读者首先看到的东西，而且它的行（`+ Add workspace…`）离线时本来就无法工作。从 `dsht` 内部启动 `dsh web` 被否决，这是设计里明确写下的产品边界：本客户端从不启动 Harness。

## Consequences

`tests/ui/offline.test.ts` 固定三种状态的文案与 URL 辅助函数（`dshUrlLine`），`tests/ui/app.test.tsx` 把应用渲染在一个关闭的端口上，断言启动命令出现而 `Choose workspace` 消失。README 双语对与 `tui-design.md` 4.6 记录了该行为。README 首次运行片段此前写了一个并不存在的包名，现在写 `npx @deepseek-ai/dsh web`，与客户端自己打印的命令一致。
