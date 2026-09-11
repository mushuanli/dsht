# Agent Note: 内存样本指明可能增长的结构

Status: implemented

## Problem

运行时内存日志记录了进程计数器、保留的 transcript 与账本；在一次长时间运行中它显示堆已到 2.3 GB，而 transcript 只有 1.7 MB、账本约 2 MB。样本完全没有覆盖随渲染内容增长的结构——布局行缓存、其中展开的推理行，以及有界的数学与图表缓存——也没有记录每分钟一次的成本扫描重读了多少历史。隔离实测表明渲染路径不保留内存：四百个富文本文档只把 GC 后的地板移动了 3 MiB，四百次不同公式的 MathJax 渲染则完全没有移动地板。因此下一次运行必须指出剩下的结构中究竟哪一个在增长，而不是重复猜测。

## Decision

样本现在还会记录布局行缓存（`layoutRows`、`layoutCacheBytes`、`layoutSpans`、`layoutSpanChars`）、它的增量实时尾部状态、数学与图表缓存（`markdownEntries`、`markdownChars`、`markdownHits`、`markdownMisses`）、实时字符数、推理条目数，以及最近一次完成扫描的会话数、页数与事件数。`layoutStats` 报告某个 transcript 的缓存，`markdownCacheStats` 报告渲染缓存，因此这些数字来自结构本身，而不是第二份估算。

当运行时暴露 `global.gc` 时，样本会先回收一次并记录 `heapUsedAfterGc` 与 `gcMs`，把真正保留的状态与 V8 尚未回收的垃圾区分开；没有该能力时这些字段缺席。`npm run start:profile` 会先建好 `.diagnostics/`，再以 `--expose-gc --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=.diagnostics` 启动客户端，于是可以在平台期用 `kill -USR2 <pid>` 把堆快照写进该目录——快照目录不存在时该信号会直接让进程崩溃——也可以用 `--max-old-space-size` 给已经到 3 GB 的运行加上上限。

## Alternatives considered

提高采样频率被否决：日志在八十分钟里已有 159 个样本，缺的是原因而不是分辨率。不带开关地在每次采样时回收被否决，因为在数 GB 的堆上做一次完整回收会按 `gcMs` 报告的时长卡住终端，所以它留在显式的运行时开关之后。专门的 profiler 构建被否决，因为 Node 可以在收到信号时写出快照，既不需要构建，也不改动发布的代码。

## Consequences

样本仍然只有计数与大小，绝不含提示词、工具或会话正文。`tests/controller/memory-log.test.ts` 断言新字段存在、已构建的布局会以大于零的 `layoutRows` 出现，以及强制回收字段恰好在运行时提供回收能力时出现。这些计数器每个样本只从本就有界的结构读取一次，因此采样开销不随对话增长。
