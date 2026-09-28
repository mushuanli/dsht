# Agent Note: 降级的状态栏点名它失去的是哪个子系统

Status: implemented

## Problem

单行状态栏把所有客户端元数据失败都压成一个 `⚠ Error`。能设置它的有三处——`session/control` 实时指标流（`controlError`）、`session/modelCatalog` 读取（`modelError`）与 preset 名册（`presetError`），其中两处没有过期机制。`controlError` 只在下一次连接代际开始时清除，所以一帧无法解码的控制帧会把整条连接标记为坏掉；`modelError` 只在一次成功的 `catalog.refresh()`（重连、目录失效事件或选择模型）后清除。于是会话已经空闲、模型路由也正常的读者会看到永久 `⚠ Error`，不打开 `/status` 就无从知道它指哪个子系统。`presetError` 甚至不会点亮这个标记，因此状态栏可能把坏掉的 preset 名册藏起来，而面板却报了出来。

## Decision

收起的状态标记改为点名子系统而不是笼统写"Error"：`⚠ Metrics`、`⚠ Models`、`⚠ Presets`，优先级如序，完整消息仍留在展开的 `/status` 面板里。控制流现在会清除自己的降级：`ConnectionStreams` 记住有一帧解码失败，并在下一帧成功解码时发布一次 `degraded(undefined)`，因此一次性的坏帧不会比它描述的状况活得更久。一次降级只发布第一条失败，因此"本客户端应用不了的基线"不会被随后每个更新抛出的 "before baseline" 埋掉。"Live metrics unavailable on this host" 仍然保留，因为没有帧能到达来推翻它。`presetError` 现在与另外两个一样点亮标记，状态栏与面板对"什么被降级了"从此一致。

## Alternatives considered

保留笼统的 `⚠ Error` 被否决：它回答了"出了问题"，而读者问的是"哪一部分"，答案却只存在于一个他们得知道要打开的面板里。让 `controlError` 在整个代际内保持粘滞被否决：降级存在的意义是让运行中的对话仍然可读，而不是指控一条已经恢复的流。不加保护地在每一帧解码后都清除被否决，因为那会为每帧多发一次状态更新；一次性标志只在确有东西可清时才清。用定时器重试 `modelError` 没有做：目录本来就会在重连、目录失效事件与选择模型后刷新，加重试循环会给宿主添一份它不需要的请求节奏。

## Consequences

`tests/controller/connection-streams.test.ts` 固定一次性上报与恢复，`tests/controller/loop-run.test.ts` 断言坏掉的 `jobs` 帧在一帧格式正确的控制帧到达后清除降级，`tests/ui/status-panel.test.tsx` 固定三个收起标记与其优先级。README 双语对与 `tui-design.md` 的 3.2.1、5.2.5 节记录了具名降级与恢复规则。
