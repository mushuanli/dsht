# Agent Note: 独立 HTTP 终端客户端

Status: implemented

## Problem

终端用户需要选择服务端已有的工作区和会话，同时避免启动额外的代理进程，或让客户端依赖 Harness 工作区内的包。

## Decision

本仓库提供 Node.js/Ink 可执行入口和可复用 HTTP 客户端。npm 包携带编译后的 JavaScript 和类型声明；唯一的 `dsh-tui` bin 使 `npx dsh-http-tui` 无需源码仓库或 TypeScript loader 即可运行。打包冒烟检查在仓库外执行 tarball，先验证再发布。`/ws` 始终选择工作区，`/s` 选择当前工作区的会话，`/s all` 显式扩大列表范围。没有工作区时，`/s` 先引导选择工作区，而不改变 `/ws` 的含义。服务端仍单独启动。工作区列表读取 mux 首个 baseline；会话列表使用一元端点。每个请求显式保留服务端形参名称。重连替换 baseline 状态，不重放用户的修改请求。旧版服务端以 `chunks` 包装 `chunkrow/*` 事件，并省略进程内助手 baseline。读取器保留压缩记录的起始序号用于翻页，并汇总日志中未完成的尝试以显示实时输出；已提交的助手消息仍是对话依据。假设所有包装都是 `event` 会拒绝这些服务端，而丢弃压缩记录会丢失实时文本和翻页位置。

## Alternatives considered

复用 Cordis 客户端服务会使安装和启动依赖 Harness 组合。Rust 改善原生分发，但需要更多协议和终端集成工作。Python 引入了所选 Node.js 实现不需要的另一套运行时生态。独立 Git 仓库使依赖安装和发布历史保持独立。

## Consequences

适配层必须跟踪服务端非稳定报文的变化。CLI 通过仅限所有者访问的原子文件持久保存按 origin 隔离的 cookie，复用前验证缓存认证，仅在提供启动 token 时刷新被拒绝的凭据。启动 token 仅留在内存。Slash 选择器先匹配完整身份或名称，再匹配唯一 ID 前缀，并拒绝有歧义的目标。未知 waterfall 委托后续处理，不阻塞服务端。测试覆盖本地 HTTP/WS 传输、用户选择、命令子进程及录制对话投影，不声称覆盖真实模型供应商。本独立仓库没有被本决策取代的已有记录。
