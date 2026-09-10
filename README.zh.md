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

首次登录通过 `GET /` 兑换 `DSH_TOKEN`，并按 HTTP origin 保存 cookie。后续启动和列表命令自动复用 cookie，无需再次提供 token。默认目录为 `$XDG_STATE_HOME/dsh-http-tui/auth`，未设置时使用 `~/.local/state/dsh-http-tui/auth`；可通过 `--auth-dir` 或 `DSH_TUI_AUTH_DIR` 覆盖。POSIX 下目录权限为 0700、cookie 文件为 0600；Windows 使用账户目录继承的访问控制。启动 token 永不保存。

Cookie 有效期由服务端决定。过期或被拒绝后，需要再次提供 `DSH_TOKEN`；已提供 token 时，HTTP 401 会自动触发重新认证。网络故障和 HTTP 403 不触发 token 兑换。损坏或权限不安全的 cookie 文件会明确报错。服务地址必须是不带路径或查询参数的 origin，且主机名须受服务端信任。

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
| `/session`, `/sessions` | 刷新列表并打开会话选择器 |
| `/workspace`, `/workspaces` | 刷新列表并打开工作区选择器 |
| `/workspace TARGET` | 按 ID、完整名称／路径或唯一 ID 前缀选择工作区 |
| `/session TARGET` | 按 ID、完整标题或唯一 ID 前缀跨工作区打开会话 |
| `/new` | 在所选工作区创建会话 |
| `/cancel` | 取消当前轮次，保留待处理队列 |
| `/steer TEXT` | 提交转向输入 |
| `/older` | 加载更早的历史 |
| `/allow`, `/deny` | 回复当前审批；批准仅限一次 |
| `/help`, `/quit` | 显示命令提示或退出 |

Slash 命令在选择器和对话输入框中均可使用。输入 `/` 会显示匹配命令。名称可以包含空格，完整目标两侧的引号可选。目标有歧义时必须提供完整 ID。切换工作区会打开其会话列表并解除旧对话订阅；切换会话会同步工作区标签。两种操作均不会取消远程代理。

用户问题逐题接收自由文本回答。其他会话的交互以及不识别的 waterfall 通过 `next` 委托后续处理。提交失败时保留输入；HTTP 响应中断可能导致投递状态不确定，手动重发前应检查会话记录。客户端不会自动重试修改请求。

## 客户端接口

通过 TypeScript loader 从 `src/client.ts` 导入 `Client`，或构建后从 `dist/client.js` 导入。`authenticate(token)` 兑换凭据；`connect()` 打开一条多路复用连接；`listWorkspaces()` 和 `listSessions(workspaceId?)` 返回服务端列表的 Promise。`call(endpoint, args)` 将服务端错误保留为带有 `code` 和 `details` 的 `RemoteError`。务必在 `finally` 中等待 `close()`。库调用方可使用 `src/auth.ts` 的 `login(client, token, new CookieStore())` 启用持久化；`Client.authenticate()` 本身仅在内存中保留凭据。

会话和工作区命令在 `args` 内使用 `{ request: { ... } }`；会话列表使用 `{ _request: {} }`。`$events/result` 直接使用具名参数。重连后的 follow 快照整体替换保留状态；持久消息与临时助手文本分别保存。读取器同时支持 `event` 记录和旧版 `chunks` 包装；后者包含 `chunkrow/text-chunks`、`chunkrow/reasoning-chunks` 或 `chunkrow/tool-call-chunks`。不提供 `assistantStream` 的服务端通过日志 chunk 传递实时文本；TUI 只重建尚未完成的尝试，并保留每条压缩记录的起始序号用于翻页。

## 开发与限制

```sh
npm test
npm run build
node dist/cli.js --help
```

测试使用隔离的 HTTP/WebSocket 服务，驱动实际 Ink 选择器和输入框，在子进程中运行 CLI，并投影复制的 Harness v2 工作区编辑记录和 v0 压缩 chunk 记录。这些检查不需要模型凭据。记录和预期对话输出位于 `tests/`，不依赖父仓库。测试不覆盖真实模型供应商行为。

界面显示纯文本、思考内容、工具调用和工具结果。尚未实现富插件卡片、文件上传、子代理导航、模型选择和队列编辑。重连采用有上限的指数退避及抖动，并替换快照；列表命令直接报告失败而不重试。服务端的非稳定 API 更新后，需要同步本地报文适配和测试。
