# Agent Note：`!` 在客户端执行，输出是一个本地块

Status: implemented

## Problem

坐在终端前的读者没有办法不离开终端就跑一条本地命令。agent 的 `bash` 工具在宿主上、会话内执行，要花 token，还可能被审批流程打断——对 `pwd`、`git status`、或只想看一眼自己这台机器上的文件来说全都不合适。客户端是 wire 协议消费者，没有宿主 shell 通道，所以这件事只能是本地设施。

## Decision

以 `!` 开头的输入行在本客户端所在的机器上执行。`ui/commands/parse.ts` 的 `Submission` 新增 `shell` 种类；shell 领域是 `src/shell/`，本仓唯一允许导入 `node:child_process` 的单元——`tests/architecture/dependencies.test.ts` 现在带有 `shell` 单元与 `PROCESS_MODULES` 规则（与既有的文件系统规则同形），因此别处的 `spawn` 会被门禁拒绝。

`runner.ts` 用 `detached: true` 启动 `$SHELL -c`（缺失时回落 `/bin/sh`），让子进程拥有自己的进程组：取消时向**进程组**发信号，这正是让它像终端里的 Ctrl+C 而不是留下管道与后台子进程占着 fd 的原因。stdout 与 stderr 合并为一条行流；单行超过 8 KiB 时只发出一次带 `…` 的截断行，并把该行余下部分丢弃，因此一个从不换行的命令不会撑大内存。SIGTERM 之后有 2 秒宽限再 SIGKILL。

`ShellController` 最多保留 20 个块，每块上限 200 行 / 64 KiB 并记录丢弃行数，同一时刻只运行一条命令——第二条 `!` 被拒绝而不是排队。草稿为空且没有对话框接管键盘时，`Esc` 或 `Ctrl+C` 都会先杀死整个进程组来停止正在运行的命令，再按一次才回到这两个键原本的语义。输出按 80 ms 节流发布，状态变化立即发布。

块**内联渲染在它发生的位置**：每个块记录命令启动时最新的持久序号，`mergeShellRuns`（`ui/chat/shell-view.ts`）把它插在"锚点之后第一条消息"之前，因此之后到达的消息出现在块**下方**，块随历史滚走，而不是被钉在屏幕底部。相同锚点保持创建顺序，比已放置块更旧的锚点被夹到其后，所以向前翻页时合并流仍然有序。合并后的总行数取代 `layout.length` 参与滚动数学，合并视口按"宿主行段 / 块行段"交替读取，只向 `layout.viewport` 请求可见的宿主区间，宿主记录的偏移与回收完全不受影响。命令行带 `HistoryRow.highlight`（画在主题的 `shell` 色条上，读起来是"这台机器"而不是 agent）。换行在加 `  ⎿  ` gutter **之前**完成，所以折行留在块内，行计数与视口一致。

## Alternatives considered

composer 上方的独立面板在第一轮设计后被否决：它把命令与读者正在看的地方分开，而读者要的是 Claude Code 那种内联形态。把块放进 `Transcript` 被否决，因为本地命令没有持久序号，只能假装成宿主消息——客户端就会持久化它、把它算进历史预算，并让 `/export` 带上它。默认把输出发给模型被否决：它花 token，还可能把路径与密钥带出操作者的机器；需要的人可以自己复制。把 `!` 记进提示词回填索引被读者否决：它是命令，不是提示词。

## Consequences

`tests/shell/runner.test.ts` 固定行流、两条管道的到达、退出码、超长行截断，以及取消会终止进程组。`tests/ui/app.test.tsx` 固定 `! echo …` 内联打印、不产生任何 `session/prompt`、块停在它发生的位置（后到的消息在它下方）、Esc 停止运行中的命令而不取消 agent 回合，以及以关闭 shell 构造的客户端会拒绝该前缀。`tui-design.md` 的 2.6 / 4.8 / 5.3 / 7.2 / 7.6 与附录记录了领域、上限与开关。README 双语记录了 `!`——在哪执行、上限、以及 `--no-shell` / `DSHT_NO_SHELL=1`——并重记了配对哈希。输出刻意是只读的：要把它交给模型就走复制模式选中复制，客户端不提供把命令输出灌进输入框的捷径。已知限制：子进程没有 TTY，也没有运行列表。
