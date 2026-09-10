# DeepSeek Harness HTTP TUI

[English](README.md) | 中文

## 摘要

在终端中选择工作区和会话，与运行中的 DeepSeek Harness 服务对话，并查看会话历史。这是独立的 Node.js 仓库，拥有自己的 Git 历史、依赖和测试，不导入 Harness 内部包。

## 目录

- [启动](#启动)
- [列出工作区和会话](#列出工作区和会话)
- [对话操作](#对话操作)
- [客户端接口](#客户端接口)
- [开发与限制](#开发与限制)

## 启动

需要 Node.js 22.19 或更新版本，以及已经运行的 `dsh web` 服务。从服务打印的 URL 中取得 token；服务是单独的前置条件，本客户端不会启动它。

```sh
npm ci --ignore-scripts
export DSH_URL=http://127.0.0.1:3080
read -rs -p 'Host token: ' DSH_TOKEN; export DSH_TOKEN; echo
npm start
```

使用 ↑/↓ 和 Enter 选择工作区，然后选择已有会话或 **New session**。**All sessions** 同时显示未归属注册工作区的会话。**Add workspace** 接收服务端已有目录的绝对路径，该路径可能与本机文件系统不同。新建会话前必须选择工作区。

认证通过 `GET /` 将 `DSH_TOKEN` 兑换为仅存于内存的 cookie。服务地址必须是不带路径或查询参数的 origin。服务端必须允许该主机名；HTTP 401 表示认证失败，403 表示 Host/Origin 信任检查失败。客户端不将 token 或 cookie 写入磁盘。

## 列出工作区和会话

```sh
npm start -- list workspaces --json
npm start -- list sessions --json
npm start -- list sessions --workspace WORKSPACE_ID --json
```

脚本中直接调用源码入口，可以避免 npm 的脚本提示混入输出：

```sh
node --import tsx src/cli.tsx list workspaces --json
node --import tsx src/cli.tsx list sessions --json
```

JSON 输出格式为 `{ "items": [...] }`；省略 `--json` 则输出制表符分隔的列表。工作区筛选使用服务端 `sessionIds` 成员关系。工作区列表读取 `workspace/follow` 的首个 baseline 后取消订阅，不会调用不存在的 `workspace/list` 端点。

## 对话操作

Enter 提交消息。Escape 请求取消当前轮次。Page Up/Down 滚动已加载的对话；`/older` 加载更早的历史。Ctrl+C 退出客户端，不取消远程代理。

| 命令 | 操作 |
| --- | --- |
| `/sessions`, `/workspaces` | 刷新列表并打开选择器 |
| `/new` | 在所选工作区创建会话 |
| `/cancel` | 取消当前轮次，保留待处理队列 |
| `/steer TEXT` | 提交转向输入 |
| `/older` | 加载更早的历史 |
| `/allow`, `/deny` | 回复当前审批；批准仅限一次 |
| `/help`, `/quit` | 显示命令提示或退出 |

用户问题逐题接收自由文本回答。其他会话的交互以及不识别的 waterfall 通过 `next` 委托后续处理。提交失败时保留输入；HTTP 响应中断可能导致投递状态不确定，手动重发前应检查会话记录。客户端不会自动重试修改请求。

## 客户端接口

通过 TypeScript loader 从 `src/client.ts` 导入 `Client`，或构建后从 `dist/client.js` 导入。`authenticate(token)` 兑换凭据；`connect()` 打开一条多路复用连接；`listWorkspaces()` 和 `listSessions(workspaceId?)` 返回服务端列表的 Promise。`call(endpoint, args)` 将服务端错误保留为带有 `code` 和 `details` 的 `RemoteError`。务必在 `finally` 中等待 `close()`。

会话和工作区命令在 `args` 内使用 `{ request: { ... } }`；会话列表使用 `{ _request: {} }`。`$events/result` 直接使用具名参数。重连后的 follow 快照整体替换保留状态；持久消息与临时助手文本分别保存。

## 开发与限制

```sh
npm test
npm run build
node dist/cli.js --help
```

测试使用隔离的 HTTP/WebSocket 服务，驱动实际 Ink 选择器和输入框，在子进程中运行 CLI，并投影一份复制的 Harness v2 工作区编辑记录。这些检查不需要模型凭据。记录和预期对话输出位于 `tests/`，不依赖父仓库。测试不覆盖真实模型供应商行为。

界面显示纯文本、思考内容、工具调用和工具结果。尚未实现富插件卡片、文件上传、子代理导航、模型选择、持久认证和队列编辑。重连采用有上限的指数退避及抖动，并替换快照；列表命令直接报告失败而不重试。服务端的非稳定 API 更新后，需要同步本地报文适配和测试。
