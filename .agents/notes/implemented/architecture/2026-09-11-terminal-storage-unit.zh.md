# Agent Note: 文件操作统一归属 storage 单元

Status: implemented

## Problem

文件系统代码分散在四个各有其存在理由的模块里：Cookie 存储、会话导出、成本账本文件和 CLI 价格文件。它们都直接导入 `node:fs`，于是私有权限校验、临时文件改名和残留文件清理被写了三遍，也没有任何机制阻止下一个模块自行打开文件。成本模块还带着一个 `storage.ts`，读起来像第二层存储。

## Decision

`src/storage/` 现在拥有全部文件系统操作。`files.ts` 导出 `readText`、`readPrivateFile`、`writePrivateFile`、`createPrivateFile`、`writeExclusiveStream` 与 `removeFile`；`directories.ts` 导出 `ensureDirectory`、`ensurePrivateDirectory` 与 `listEntries`；`index.ts` 是所有调用方导入的 barrel。各业务域保留自己的格式、校验与保留策略，而本单元负责系统调用、0600 文件与 0700 目录要求（错误信息带上调用方给出的名称，因此文案不变），以及使写入原子化的临时文件改名。

流式导出通过「来源回调」保持原有顺序：`writeExclusiveStream` 先以独占方式创建目标文件，之后才索取字节流，因此目标已存在时不会先访问服务端，而之后的任何失败都会删除残留文件。`cost/storage.ts` 更名为 `cost/ledger-files.ts`，使只有一处名为 storage。

架构测试现在会拒绝 `storage/` 之外任何对 `node:fs` 或 `node:fs/promises` 的导入，允许导入表中把 `storage` 列为 `transport`、`session`、`cost` 与 `cli` 的依赖。`storage` 自身不得导入其他单元，从而保持为叶子。

## Alternatives considered

保留各域的文件代码、只共享小工具被否决，因为权限、原子性与清理规则正是绝不能出现分歧的部分。通用键值存储抽象被否决为过度设计：这里每个路径都由所属业务域按 origin 或会话计算，键值层只会隐藏命名规则而不是拥有它。把账本文件格式、世代规则与截点清理移入 `storage/` 被否决，因为那些是成本域的契约而非文件系统机制。

## Consequences

行为保持不变：Cookie 与账本的错误文案、0600／0700 权限、先独占创建再请求的顺序、下载失败后的删除、旧截点清理，以及 CLI 的「不存在才创建」价格文件都维持原语义，`npm run typecheck` 与全部 134 项测试通过。今后新增文件只有一处可去，而其他位置直接导入 `node:fs` 会被依赖门禁拦下。
