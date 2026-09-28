# Agent Note: 没有队列小节的基线仍然是一条基线

Status: implemented

## Problem

已安装的宿主（`dsh` 0.1.7-rc.2）发出的 `session/control` 基线只有 `{ projections }`——它没有队列与活动任务流——而 `controlFrame()` 却要求 `baseline.queues` 与 `baseline.jobs` 是对象。`object(undefined)` 抛出 "Expected a JSON object from the server"，于是整条基线被丢弃：`Telemetry.ready` 保持 false，之后每一帧投影都报 "Session control update before baseline"，状态栏显示 `⚠ Metrics`，而 `Context`／`tok`／`turns` 冻结在 `session/follow` 快照带来的那份值上。看起来像宿主坏了，实际是客户端拒绝了一项宿主从未声称拥有的能力。

## Decision

基线的三个小节是**能力**，不是固定 schema。`controlFrame()` 统一经 `optionalRows()` 读取：缺少的小节按空 map 处理，存在但不是对象的仍是协议错误，而 `projections` 仍是基线必须携带的那一节——没有它就没有任何可应用的东西。只有投影的基线现在会置 `ready`，随后到来的投影帧正常应用，状态栏回到 `● Ready`；`Queued ?` 与 `Jobs ?` 保持未知，因为该宿主不上报队列，这是如实的读法，而不是宣称"没有"。

## Alternatives considered

把缺失小节当作错误正是原来的做法，也是本次要修的：它丢掉了宿主确实发来的投影，于是一项客户端并不需要的能力（队列流）把一项它需要的能力关掉了。让宿主总是发送这两个小节被否决：宿主是独立发布的，客户端必须容忍早于队列流的宿主，而 `dsht` 连的就是用户装的那份 `dsh`。在基线到达前缓冲这些更新被否决，因为没有必要：基线会取代它们，接受快照才是让这条流可用的关键。

## Consequences

`tests/transport/events.test.ts` 固定只有投影的基线以及"存在但形状错误"的小节，`tests/ui/status.test.ts` 断言这种基线能启动遥测且队列与任务数保持未知。README 双语对不变，因为 wire 形状不是面向使用者的内容；`tui-design.md` 3.2.1 节把 `queues`、`jobs` 标为可选。
