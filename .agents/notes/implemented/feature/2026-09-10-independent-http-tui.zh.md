# Agent Note: 独立 HTTP 终端客户端

Status: implemented

## Problem

终端用户需要选择服务端已有的工作区和会话，同时避免启动额外的代理进程，或让客户端依赖 Harness 工作区内的包。

## Decision

本仓库提供 Node.js/Ink 可执行入口和可复用 HTTP 客户端。服务端仍单独启动。工作区列表读取 mux 首个 baseline；会话列表使用一元端点。每个请求显式保留服务端形参名称。重连替换 baseline 状态，不重放用户的修改请求。

## Alternatives considered

复用 Cordis 客户端服务会使安装和启动依赖 Harness 组合。Rust 改善原生分发，但需要更多协议和终端集成工作。Python 引入了所选 Node.js 实现不需要的另一套运行时生态。独立 Git 仓库使依赖安装和发布历史保持独立。

## Consequences

适配层必须跟踪服务端非稳定报文的变化。Cookie 仅保存在内存中；未知 waterfall 委托后续处理，不阻塞服务端。测试覆盖本地 HTTP/WS 传输、用户选择、命令子进程及录制对话投影，不声称覆盖真实模型供应商。本独立仓库没有被本决策取代的已有记录。
