# DeepSeek Harness Terminal

[English](README.md) | 中文

![DeepSeek Harness Terminal（dsht）](dsht.png)

> **dsht — 只要有终端，就能随时控制 DeepSeek Harness。**

## 摘要

`dsht` 是一个面向远程使用场景设计的轻量级 DeepSeek Harness TUI 客户端。

它的核心目标是让 DeepSeek Harness 自然融入开发者已有的终端和 SSH 工作流：Harness 可以持续运行在远程工作站或服务器上，而你可以从笔记本、平板，甚至手机重新连入终端，继续查看状态、发送消息、转向任务、审批操作、回答问题、取消轮次或切换会话。

典型场景：

```text
手机 / 平板 / 笔记本
        │
        │ SSH
        ▼
   跳板机 / Bastion
        │
        │ SSH
        ▼
     开发主机
        │
        ├── dsht
        │     │
        │     ▼
        │   dsh web
        │     │
        │     ▼
        └── DeepSeek Harness
```

`dsht` **本身不是 SSH 客户端**。它运行在普通终端中，因此可以直接工作在 SSH、嵌套 SSH、ProxyJump／跳板机、tmux 等远程终端环境里。只要你的终端能够到达运行 `dsht` 的主机，就可以继续控制同一套 DeepSeek Harness 会话。

除了远程控制，`dsht` 还内置了面向成本控制的用量统计：它按请求记录 token 用量，区分未缓存输入、缓存读取、缓存写入和输出，并结合模型、时间、高峰／空闲价格及版本化价格表，计算当前会话、今日和最近三日的人民币费用估算。

主要特点：

- **远程优先**：适合 SSH、嵌套 SSH、跳板机、ProxyJump、tmux 等远程开发环境。
- **手机友好**：只需要一个可用的移动端 SSH 客户端，就能在离开电脑后继续控制远程 Harness。
- 工作区和会话选择器，通过 `/ws`、`/resume` 直接切换，并显式创建会话。
- 流式回复、思考内容、精简工具名称、成功／失败状态以及分页对话历史。
- 排队消息、转向输入、轮次取消、审批和自由文本问题回答。
- 按服务端保存 cookie、自动重连和快照替换，方便断线后恢复控制。
- 面向脚本的 JSON／制表符工作区与会话列表，以及可复用的 HTTP 客户端。
- **成本感知**：会话、今日和三日人民币费用估算，支持版本化高峰／空闲价格和 `/cost` 汇总。

## 为什么使用 dsht？

### 为远程控制而设计

DeepSeek Harness 往往运行在性能更强、环境更完整的开发工作站或服务器上，而人并不总是在那台机器前。

`dsht` 将控制界面保持在纯终端中，因此无需给远程服务器安装桌面环境，也不要求手机运行完整的开发环境。你可以让 Harness 留在开发主机持续工作，需要查看或干预时，再通过已有的 SSH 链路进入主机运行 `dsht`。

最简单的方式：

```text
笔记本 ───────── SSH ────────> 开发主机 ──> dsht
```

经过跳板机时：

```text
手机 ── SSH ──> 跳板机 ── SSH ──> 开发主机 ──> dsht
```

这使得“手机在手，随时控制 Harness”成为实际可用的工作流：无需远程桌面，也无需在公网直接暴露 Harness 的 Web 服务。

> SSH 隧道、ProxyJump、跳板机和访问控制由现有 SSH 环境负责；`dsht` 专注于 DeepSeek Harness 的终端交互与控制。

### 手机也能继续控制任务

在移动场景中，通常不适合长时间编辑代码，但非常适合进行控制和决策。

通过手机 SSH 进入运行 `dsht` 的远程终端后，可以：

- 查看正在运行的任务和实时输出；
- 阅读助手回复、思考内容和工具执行状态；
- 发送新的 prompt 或 `/steer` 转向指令；
- `/allow` 或 `/deny` 审批操作；
- 回答 Harness 提出的问题；
- `/cancel` 停止当前轮次；
- 切换工作区和会话；
- 搜索历史记录；
- 使用 `/cost` 查看当前任务和近期费用。

因此，即使离开电脑，也不必失去对长时间 Harness 任务的控制。

### 不只是日志查看器

`dsht` 是运行中 DeepSeek Harness 的交互式控制界面，而不是只读日志工具。

它能够发送输入、处理审批和问题、转向正在执行的任务、取消轮次、切换会话并在网络恢复后重新连接。Harness 的实际执行状态仍保留在服务端，客户端只负责通过终端呈现和控制。

### 成本感知

长时间的 AI 编码任务可能持续消耗大量 token，而仅看 token 总数很难直观判断实际费用。

`dsht` 按请求保存用量信息，并结合请求结算时间、模型身份和对应价格版本进行计算。费用统计区分：

```text
未缓存输入
缓存读取
缓存写入
输出
```

`/cost` 可以查看：

```text
当前会话
今日
今日 + 前两个自然日
```

状态栏还可以持续显示会话／今日费用（`~¥1.23/~¥5.00`），便于在任务执行过程中及时发现成本变化，而不是等到账单出现后才知道消耗了多少。

这让 `dsht` 同时承担两个角色：

1. **DeepSeek Harness 的远程终端控制界面**
2. **面向实际使用过程的成本监控工具**

## 目录

- [为什么使用 dsht？](#为什么使用-dsht)
- [启动](#启动)
- [远程 SSH 工作流](#远程-ssh-工作流)
- [列出工作区和会话](#列出工作区和会话)
- [对话操作](#对话操作)
- [实时状态](#实时状态)
- [费用估算](#费用估算)
- [客户端接口](#客户端接口)
- [发布到 npm](#发布到-npm)
- [开发与限制](#开发与限制)

## 启动

需要 Node.js 22.19 或更新版本，以及已经运行的 `dsh web` 服务；服务是单独的前置条件，本客户端不会启动它。默认连接本机 `http://127.0.0.1:3080`：

```sh
npx @itookit/dsht
```

仅在首次运行以及已保存的 cookie 过期后需要 token。可以单独导出它，也可以直接导出 `dsh web` 打印的完整地址，由客户端拆出其中的 `?token=` 参数：

```sh
export DSH_TOKEN=<token> && npx @itookit/dsht
export DSH_URL='http://127.0.0.1:3080/?token=<token>' && npx @itookit/dsht
```

两者同时提供时 `DSH_TOKEN` 优先，`--url` 可覆盖单次运行的 `DSH_URL`。token 不会写入磁盘，只保存兑换得到的 cookie。上面两种 export 都会留在 shell 历史中，在意时改用 `read -rs -p 'Host token: ' DSH_TOKEN`。连接其他服务端需在 `DSH_URL` 中给出其 origin。

`npx @itookit/dsht list workspaces --json` 和 `npx @itookit/dsht list sessions --json` 供脚本获取工作区和会话列表，`npm install -g @itookit/dsht` 会安装 `dsht` 命令。这些 registry 命令要求包已发布。

若使用源码仓库，先安装依赖，再运行 TypeScript 入口：

```sh
npm ci --ignore-scripts
npm start
```

两种方式读取相同的 `DSH_URL` 和 `DSH_TOKEN` 变量。

使用 ↑/↓ 和 Enter 选择工作区，然后选择已有会话或 **New session**。**All sessions** 同时显示未归属注册工作区的会话。**Add workspace** 接收服务端已有目录的绝对路径，该路径可能与本机文件系统不同。新建会话前必须选择工作区。

首次登录通过 `GET /` 兑换 token，并按 HTTP origin 保存 cookie。后续启动和列表命令自动复用 cookie，无需再次提供 token。默认目录为 `$XDG_STATE_HOME/dsht/auth`，未设置时使用 `~/.local/state/dsht/auth`；可通过 `--auth-dir` 或 `DSHT_AUTH_DIR` 覆盖。POSIX 下目录权限为 0700、cookie 文件为 0600；Windows 使用账户目录继承的访问控制。启动 token 永不保存。

Cookie 有效期由服务端决定。过期或被拒绝后，需要再次提供 token；已提供 token 时，HTTP 401 会自动触发重新认证。网络故障和 HTTP 403 不触发 token 兑换。损坏或权限不安全的 cookie 文件会明确报错。服务地址必须是不带路径、且除 `token` 外无其他查询参数的 origin，主机名须受服务端信任。

## 远程 SSH 工作流

`dsht` 最适合与现有 SSH 基础设施组合使用。它不要求 DeepSeek Harness 暴露到公网，也不要求客户端设备能够直接访问 `dsh web`。

### 直接 SSH 到开发主机

如果开发主机可以直接 SSH：

```text
Laptop / Phone
      │
      │ SSH
      ▼
Development Host
      │
      ├── dsht
      └── dsh web
```

登录远程主机后直接运行：

```sh
dsht
```

或者无需全局安装：

```sh
npx @itookit/dsht
```

### 通过跳板机访问

如果开发主机只能通过跳板机访问：

```text
Phone
  │
  │ SSH
  ▼
Jump Host
  │
  │ SSH / ProxyJump
  ▼
Development Host
  │
  ├── dsht
  └── dsh web
```

例如已有 OpenSSH `ProxyJump` 配置时，可以先正常 SSH 到目标开发主机，然后运行：

```sh
dsht
```

`dsht` 不需要理解这条 SSH 链路；从它的角度看，它只是运行在能够访问 `dsh web` 的终端环境中。

### 与 tmux 配合

远程环境中可以把 `dsht` 放在 tmux 会话中，以便网络中断后重新进入同一个终端环境：

```sh
tmux new -s dsht
dsht
```

之后重新 SSH 登录：

```sh
tmux attach -t dsht
```

即使不使用 tmux，Harness 会话状态仍然保留在服务端；重新启动 `dsht` 后可以重新选择原工作区和会话。tmux 的价值主要在于保留本地终端布局和当前 TUI 进程。

### 手机访问

任何能够正常使用 SSH 的手机终端都可以作为入口：

```text
Mobile SSH Client
       │
       ▼
   Jump Host
       │
       ▼
Development Host
       │
       ▼
      dsht
```

实际体验取决于移动终端对 ANSI、Unicode、方向键、SGR mouse reports 等终端能力的支持。即使触摸鼠标能力有限，核心操作仍可以通过键盘和 slash 命令完成。

## 列出工作区和会话

```sh
npx @itookit/dsht list workspaces --json
npx @itookit/dsht list sessions --json
npx @itookit/dsht list sessions --workspace WORKSPACE_ID --json
```

在源码仓库中，可以通过 npm 或源码入口执行同样的命令；直接调用入口可以避免 npm 的脚本提示混入输出：

```sh
npm start -- list workspaces --json
npm start -- list sessions --json
node --import tsx src/cli.tsx list workspaces --json
node --import tsx src/cli.tsx list sessions --json
```

JSON 输出格式为 `{ "items": [...] }`；省略 `--json` 则输出制表符分隔的列表。工作区筛选使用服务端 `sessionIds` 成员关系。工作区列表读取 `workspace/follow` 的首个 baseline 后取消订阅，不会调用不存在的 `workspace/list` 端点。

## 对话操作

Enter 提交消息。输入框非空时，Ctrl+C 先清空输入；否则所选会话运行中时请求取消，只有空闲时才退出，连续按键会复用尚未完成的取消请求。取消会等待正在提交的消息完成接收，失败时保留客户端。聊天界面中 Esc 会发送取消请求，不受本地空闲状态判断限制。任务运行中时，Esc 关闭文件或历史／搜索菜单的同时请求取消；空闲菜单仅关闭。正在执行的本地历史／搜索／费用加载优先被取消。Page Up/Down 滚动当前对话；`/older` 加载更早记录。所有退出路径（包括 `/quit` 和 SIGTERM）都会在关闭连接前停止所选任务，因此退出不会留下仍在运行的代理；会话空闲时不发送取消。取消当前任务会保留排队消息。

`/copy`、Ctrl+S 或普通聊天界面的鼠标左键单击冻结画面并关闭鼠标事件捕获，便于使用终端原生选择复制。Esc、Ctrl+S 或 Ctrl+C 退出复制模式并显示最新输出，退出复制模式不会取消代理。对话框和选择器自动冻结背景标题、对话和状态更新，并释放鼠标捕获，界面操作仍可使用。回看旧历史时 Working 计时显示也暂停。帮助／状态／费用面板不再定时消失。后台接收与内存回收继续运行，调整窗口大小仍可能重绘。

鼠标滚轮和 Page Up/Down 滚动对话；滚到顶部自动加载更早的一页。查看旧记录时，新输出保留阅读位置；向下滚动即可恢复跟随最新输出。TUI 挂载时启用鼠标报告，退出时关闭，需要终端支持 SGR 鼠标报告。加载历史或搜索期间，Esc 或 Ctrl+C 优先取消本地操作，不中断远程任务。

在 `/ws` 和 `/resume` 列表选中工作区或会话后，输入框为空时按 `d` 或 Delete 查看移除确认页。已有草稿时 `d` 仍正常输入，Backspace 不会打开移除页。`/ws --delete <名称或ID>` 和 `/resume --delete <标题或ID>` 打开相同确认页，`/resume --archive <标题或ID>` 也可归档会话。移除会话前重新读取 `session/list`；服务端明确标记 `blank: true`、未运行，且没有已知排队任务或本地正在提交的提示词时，直接归档，不再确认。判定使用服务端空会话标记，不依赖当前已加载历史或标题。其他会话仍需确认，默认选中取消，Esc 关闭确认页。工作区移除调用 `workspace/delete`，只移除注册，保留目录和会话。会话移除调用 `workspace/archiveSession`，从工作区会话列表和 `/resume all` 隐藏，但保留历史，可通过 `/resume ID` 重开。当前服务端 API 提供归档，没有永久删除会话接口。运行中的任务继续执行。归档当前会话会释放其 transcript 和排版缓存；操作被拒绝时保留列表及确认页，便于重试。

`/search` 对对话消息进行不区分大小写的字面文本匹配，包含旧页，排除纯工具行。搜索每次请求最多 80 条消息，扫描后释放临时页，只保留最多 200 条简短命中摘要，包含折叠的思考；结果截断时提示缩小查询范围。选择命中项只加载其序号附近的独立页面，`/latest` 释放该窗口。Esc 或 Ctrl+C 可取消搜索。稀有词或无匹配查询仍需通过 HTTP 扫描全部历史，此命令尚无服务端全文索引。`/history` 只列出已加载页面中自己的提示词，选择器显示的数字就是记录序号。`/ssearch` 与 `/wsearch` 调用 `session/search`，服务端搜索当前用户／助手消息内容，最多返回 20 个会话、摘要和截断标记，没有结果分页游标或命中记录序号。工作区筛选在全局数量限制之后进行，因此截断时可能漏掉工作区内的匹配会话；界面会提示结果不完整，可缩小查询范围。选择会话后加载其历史，再选择匹配消息跳转。所有操作均通过 HTTP 完成，不扫描服务端配置目录。

↑/↓ 或 Ctrl+P/N 回填之前提交的提示词和 slash 命令，按 Enter 才提交。向下越过最新记录时恢复未发送草稿；编辑回填内容后开始新的草稿。历史按当前会话保留，最多 200 条、约 256 KiB 文本。打开或恢复会话时，从已加载的 User 消息初始化回填；切换会话释放旧缓存。不额外拉取历史页，也不写入独立历史文件。连续重复输入合并，超大输入跳过，提问和审批回答不记入历史。提问选项与补全菜单优先使用箭头；工作区／会话列表在输入框为空时使用箭头选择，可用 Ctrl+P/N 调出输入历史。

每条 User 消息之后，只在第一段助手正文或思考前显示 Assistant 标题；后续消息及流式输出沿用分组，工具结果和 Context 消息不重置分组。当前加载的历史窗口从自身起点建立可见分组，消息序号、工具状态、搜索和思考展开仍各自保留。

鼠标复制时，先单击进入复制模式，待画面冻结后再拖动选择。松开鼠标不会恢复刷新，需按 Esc、Ctrl+S 或 Ctrl+C。终端原生 Shift+拖选可能不向应用发送鼠标事件，此时请先按 Ctrl+S。对话框中已关闭鼠标捕获，如需冻结整个对话框可按 Ctrl+S。

Tab 补全开头的 slash 命令，多个候选时补到公共前缀。单行输入框支持 Readline 风格编辑。单词以空白分隔；光标移动和逐字符删除保持完整的 Unicode 组合字符。粘贴的多行文本会以空格连接成一行。空输入时 Ctrl+D 不退出；输入非空时 Ctrl+C 先清空输入，然后才停止或退出。未处理的修饰键快捷键不会将控制字符插入消息。终端退格键的 BS 和 DEL 编码均向后删除；独立 Delete 键（CSI 3~）向前删除。

| 按键 | 编辑操作 |
| --- | --- |
| ↑ / ↓、Ctrl+P / Ctrl+N | 回填更早／较新的提交内容 |
| Ctrl+A / Ctrl+E、Home / End | 移到开头／末尾 |
| Ctrl+B / Ctrl+F、← / → | 移动一个字符 |
| Alt+B / Alt+F、Ctrl+← / Ctrl+→ | 移动一个词 |
| Ctrl+K / Ctrl+U | 删除光标至末尾／开头至光标 |
| Ctrl+W、Alt+Backspace | 删除前一个词 |
| Alt+D | 删除后一个词 |
| Ctrl+Y | 在光标处恢复最近剪除的文本 |
| Ctrl+H / Backspace、Ctrl+D / Delete | 删除前一个／后一个字符 |

| 命令 | 操作 |
| --- | --- |
| `/ws` | 显示所有工作区，选中后打开其会话列表 |
| `/ws TARGET` | 按 ID、完整名称／路径或唯一 ID 前缀选择工作区 |
| `/resume` | 显示当前工作区的会话；未选择工作区时先引导选择 |
| `/resume TARGET` | 按 ID、完整标题或唯一 ID 前缀跨工作区打开会话 |
| `/resume all` | 显示所有工作区的会话 |
| `/model [provider model [effort]]` | 选择模型及其思考强度，也可直接提交精确路由 ID |
| `/new` | 在所选工作区创建会话 |
| `/cancel` | 取消当前轮次，保留待处理队列 |
| `/steer TEXT` | 提交转向输入 |
| `/older` | 加载更早的历史 |
| `/history [text]` | 列出自己的提示词并可选筛选；Enter 跳到所选记录 |
| `/search <text>` | 逐页搜索历史，选择命中项后打开其位置 |
| `/copy` | 冻结画面便于终端选择，Esc 恢复 |
| `/latest` | 返回实时输出并释放独立历史窗口 |
| `/ssearch <text>` | 在服务端搜索结果中筛选当前工作区的会话 |
| `/wsearch <text>` | 搜索服务端可见的所有工作区会话 |
| `/allow`, `/deny` | 回复当前审批；批准仅限一次 |
| `/status` | 展开或收起底部完整状态信息 |
| `/cost` | 展开／收起会话、今日、三日费用，并刷新用量 |
| `/think` | 显示思考及用户 prompt 摘要列表；↑/↓ 选择、Enter 跳转并展开 |
| `/think SEQ` | 切换一条已加载思考的展开状态；`live` 表示当前尝试 |
| `/help`, `/quit` | 列出每条命令及其说明，或退出 |

Slash 命令在选择器和对话输入框中均可使用。输入 `/` 会显示匹配命令，`/help` 会逐条列出命令及其单行说明。`/help`、`/cost`、`/status` 面板保持打开，直到下一条命令或 Esc；Esc 保留输入内容。`/workspace`、`/workspaces` 是 `/ws` 的别名；`/session`、`/sessions` 是 `/resume` 的别名。名称可以包含空格，完整目标两侧的引号可选。不带引号的目标 `all` 保留给 `/resume all`；打开标题为 `all` 的会话时，使用 `/resume "all"` 或其 ID。目标有歧义时必须提供完整 ID。切换工作区会打开其会话列表并解除旧对话订阅；切换会话会同步工作区标签。两种操作均不会取消远程代理。

在输入末尾键入 `@`，可搜索所选会话**在服务端**工作目录中的文件和目录。使用 ↑/↓ 选择，Tab 或 Enter 插入；选择目录后继续补全其内部路径。带空格的路径使用 `@"path with spaces"`。Esc 关闭菜单，任务运行中时同时请求取消；关闭后 Enter 发送原样输入，包括未匹配到的路径。搜索失败时显示错误，不提交输入。补全针对输入末尾的引用，不跟踪已有文本内部的光标位置。

文件引用仅在文本块中发送 `@path`。Harness 提示模型按需读取文件或列出目录；TUI 不读取本地文件、不上传字节，也不将文件内容展开进提示词。引用图片路径不会附带图片数据。尚未实现本地附件、图片上传／预览及 `@` 会话引用。

用户问题显示题目进度、编号选项和说明。待答问题和审批独占对话区域，避免冻结的历史挤压选项行；可见选项数量按终端高度调整，并跟随当前高亮项滚动。输入框为空时，↑／↓ 或 1–9 定位选项，Enter 确认；数字键只选择、不提交。多选题用空格或 1–9 勾选／取消勾选，Enter 确认，超过九个选项仍可通过方向键访问。选择 Other answer 后可输入纯数字自由文本，也保留普通文本回答。已有草稿时按正常文字输入处理，Esc 从 Other 返回选项而不取消提问。全部题目回答完成后，一次提交结构化选项标签及可选自定义文本；失败时保留答案以便重试。已识别的提问和审批事件在本次连接中按事件 ID 保留，包括早于会话选择到达的重放事件；只展示当前会话对应的请求。切换列表不会退回这些请求，不识别的 waterfall 仍通过 `next` 委托后续处理。存活服务端在客户端重连后重发待答事件；客户端重启不保留尚未提交的回答草稿。正常退出 TUI 会取消正在运行的轮次。调用已取消／失败或服务端已重启时，无法靠本地 UI 状态恢复原等待，需要发送新提示词要求重新提问。提交失败时保留输入；HTTP 响应中断可能导致投递状态不确定，手动重发前应检查会话记录。客户端不会自动重试修改请求。

标题固定在可滚动对话区域上方，输入框和状态栏保留在下方。底部不再常驻快捷键说明，完整快捷键放在 `/help`，选择器只显示当前需要的导航提示。顶部单行显示 `dsht · <主机名>`、工作区名称和最新会话标题（无标题时回退到 ID）及右对齐的连接状态，下方为分隔线；`/status` 保留完整会话 ID。取消回执在后续历史消息到达时保持可见，直到服务端报告空闲；接受取消不表示工具进程已经退出。

## 实时状态

底栏分组显示 `◐ Working · 8s · Ctrl+C Stop` 或 `● Ready`、模型与思考强度、会话／今日费用、十格上下文进度条及百分比、会话轮次与累计 token。宽终端为运行状态预留固定宽度，完成后模型和指标保持对齐。窄终端依次回收留白、隐藏进度条、缩短模型名、省略次要指标，优先保留停止提示。`/status` 显示主机 URL、操作状态、工作区完整路径、完整供应商／模型、下次模型、各项用量、轮次、队列、后台任务和四位小数费用。`!` 表示有指标或模型目录错误，或计费覆盖不完整；详情中显示原因。运行中使用最近实际使用的模型，空闲时使用下次模型，新会话使用服务端模型目录默认值。服务端设置、凭据和适配器变更通知会刷新模型目录。

工作计时使用已加载日志的 `turn/start` 时间戳。缺少该时间戳时，紧凑计时后的 `~`（详情中的 `(observed)`）表示从客户端观察到运行开始计时；重连可能重置此备用计时。服务端报告空闲后停止计时。运行状态涵盖模型生成、工具执行及审批等待，不仅是文本输出。断线时明确标注为最后已知状态。

轮次数来自完整会话的 `sessionStats.turns` 投影。上下文占用标为 `~`：Harness 将供应商用量与对话变化估算值、最新模型容量结合。Token 总量来自完整会话的 `tokenUsage` 投影，分别显示非缓存输入、输出、缓存读取和缓存写入；思考 token 已包含在输出中。总量随服务端用量投影更新，不按流式字符计数。缺失数据显示 `unknown` 或 `?`。重连时控制流基线整体替换状态，每个投影键的序号防止旧 follow 快照覆盖较新的指标。

默认使用 [Catppuccin Mocha](https://catppuccin.com/palette/) 主题：`❯ User` 为蓝色，`✦ Assistant` 为绿色，思考为淡紫色，工具为天蓝色，成功为绿色，错误为红色。紧凑状态栏中 Ready 为绿色、Working 为黄色、离线为红色，模型／强度为淡紫色、费用为天蓝色、用量为柔和灰色。上下文占用达到 80% 时从绿色变黄，95% 时变红；这只是视觉阈值，不代表服务端压缩触发条件。各组先按宽度裁剪，再添加 ANSI 样式，保持对齐及无色终端输出。语义配色独立放在 `src/theme.ts`，应用可单独接收主题，消息不保存 ANSI 样式。Ink 根据终端能力输出颜色，无色终端仍保留角色标记。工具调用显示名称和描述；命令与描述不同时，下一行以 `$` 显示命令第一行。没有描述时使用命令第一行、路径或查询作为摘要。各行按终端显示宽度截断；结果按调用 ID 在原条目上将 ⚙ 更新为 ✓ 或 ✗，不再重复新增结果条目，命令预览保留两格缩进。调用尚未加载时单独显示结果摘要，加载调用页后合并；嵌套结果正文保持隐藏。

思考生成时完整流式显示，思考块结束或正文／工具输出开始后自动折叠。`/think` 按从新到旧列出思考摘要、前一条已加载的用户 prompt，并包含当前尝试。↑/↓ 选择、Enter 跳到原消息并展开；`/think SEQ` 可切换该消息的折叠状态，`/think live` 控制当前尝试。列表在选择、Esc 或其他命令时关闭，不自动超时。打开列表只使用已加载记录，选择 `Load older reasoning` 才读取一页更早历史；prompt 在已加载窗口之前时明确提示，加载对应页面后补全。完整思考仍可被搜索。

`/model` 读取 `session/modelCatalog`，展示服务端公布的 provider／model 路由及思考强度。选择通过 `session/selectModel` 提交 `{ request: { sessionId, provider, model, reasoningEffort? } }`，省略强度时使用适配器默认值。服务端将选择用于后续请求、记录选择事件，并尝试保存为部署默认值；不会替换正在执行的请求。展示模型继续以 `modelSelection.next` 和 `lastUsed` 为准，调用失败保留原选择。部分 provider 目录失败会单独提示，不隐藏正常 provider。标题与网页的 Agent preset 标签一致：`agentPreset` 提供当前 ID，`agentPresets/list` 提供名称和信任来源。内置系统预设显示 Standard mode、PTC mode、Minimal mode、Creator mode；自定义预设保留其名称，目录缺失时回退显示 ID。可选目录按需读取并在本次连接中复用。Plan 是独立功能，不决定这里的模式名称。终端少于 62 列时，mode 可在 `/status` 查看，为连接指示留出空间。

历史分为语义消息块、prompt／思考摘要、独立折叠状态和行数索引。流式更新复用已提交历史的位置索引，只生成当前可见区域。每个会话的 LRU 最多保留 2,048 行已提交终端内容，移出缓存的行在回看时重建。已结束的旧版流式分片和不用展示的工具结果正文会释放，原始日志由服务端保存。服务端日志作为持久层，客户端作为可重载的内存层。实时历史默认以 2,000 条记录或 16 MiB 语义数据估算量为软限制（`--history-records`、`--history-mb`），触发回收后以限制的 75% 为目标，释放旧正文、摘要和排版缓存。切换会话会释放上一会话的 transcript。回看和思考导航期间保护已加载窗口；`/latest` 返回实时输出并恢复回收。离线历史、未结束流和最小近期尾部受保护，因此这些参数不是进程 RSS 硬上限。首次排版、改变终端宽度及展开特别大的单个内容块，仍需要处理对应全文。`npm run bench:history` 测量 500、2,000、10,000 条消息下的本地流式排版耗时，不含网络和模型时间。

## 费用估算

`dsht` 不只是显示 token 数，而是把 Harness 可见的逐请求用量转换为可追踪的人民币费用估算。它区分未缓存输入、缓存读取、缓存写入和输出，并结合模型、请求结算时间、价格版本以及高峰／空闲时段进行计算，便于在任务运行过程中及时了解当前会话和近期总成本。

> 这里的费用是基于 Harness 可见用量和本地价格配置得到的高精度估算，用于成本监控和控制；它不是供应商账户级账单，最终费用仍以供应商账单为准。

`/cost` 显示当前会话、今日及今日加前两个自然日的费用。日期使用 Asia/Shanghai，三日统计不是滚动 72 小时。状态栏以两位小数显示会话／今日费用，斜杠不表示预算。`~` 表示估算；`*` 表示该小计并不精确：请求缺少时间戳、没有价格覆盖，或无法归入所选自然日区间。覆盖不完整另行通报：之前运行缓存的费用视为完整，而账本为空或扫描失败时状态栏出现 `!` 前缀，并在 `/status` 中说明原因。每个服务端 origin 使用独立账本；总额覆盖 HTTP 可见会话及之前缓存的会话，不是供应商账户级账单。

客户端连接后、每 60 秒、任务结束及打开 `/cost` 时在后台通过 HTTP 读取完整历史；服务端更新时间未变的空闲会话跳过扫描。计费不会发起模型请求。显式刷新时可按 Esc 或 Ctrl+C 取消。账本分别统计未缓存输入、缓存读／写和输出，思考 token 已包含在输出中。重试单独计费，同一次尝试的替换用量更新原记录，fork 继承历史不重复计费。缺少结算时间戳的请求仍按该模型族的最低费率给出下限金额，并标记为估算。用量矛盾，以及没有任何模型或供应商条目覆盖的价格，仍标为未计价；模型名是否包含 `pro` 决定按 Pro 还是 Flash 计价，而未列出的供应商不会套用官方价目。每个会话独立读取：某个会话不可达或被拒绝时只计为失败数量并继续扫描，不会中止整轮；子代理会话按其持久父级地址读取。扫描失败保留并标明部分缓存结果。

内置人民币价格于 2026-09-10 根据[官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)核对。北京时间工作日 09:00–12:00、14:00–18:00 为高峰，其余时段半价。Flash 高峰未命中输入／缓存命中输入／输出为每百万 token ¥2/¥0.04/¥8，Pro 为 ¥9/¥0.30/¥27；当前模型名为 `deepseek-flash`，旧 Flash 名称沿用同一费率。供应方已公告自北京时间 2026-09-14 12:00 起将 `deepseek-v4-pro` 交由 Flash 服务并按 Flash 价格计费，内置条目已记录该变更，避免此后高估 Pro 用量。单列的缓存写入按未命中输入价计算。配置中的精确模型价格优先；否则 `deepseek-official` 模型名包含 `pro`（不区分大小写）时按 Pro 计价，其余名称包括临时别名均按 Flash 计价。其他供应商需要显式配置。

默认价格有效期从核对日期的北京时间零点开始，这是本地估算规则，不代表官方价格生效日期。更早用量需要补充历史价格版本。程序按助手请求结算记录的时间选择单价；官方未说明跨时段请求的归属，因此边界附近的估算可能与账单不同。图片使用供应商报告的 token 数。每次扫描都按当前配置重新计算已存请求，因此修正价格版本会一并修正此前的小计；此前没有任何条目覆盖的请求，会在条目覆盖其结算日期后被计价。

首次交互启动会创建 `~/.config/dsht/prices.json`（或 `$XDG_CONFIG_HOME/dsht/prices.json`），可用 `DSHT_CONFIG_DIR` 覆盖目录。JSON 数组中的价格版本包含 `id`、`provider`、`model`、`currency: "CNY"`、`source`、包含起点的 `from`、可选且不含终点的 `until`、`timezone`、星期数字 `weekdays`（`0` 为周日）、日内分钟区间 `windows`，以及 `peak`／`offPeak` 下每百万 token 的 `input`、`cacheRead`、`cacheWrite`、`output` 单价。调价时用 `until` 结束旧区间，再添加唯一 ID 且 `from` 衔接的新版本；程序拒绝重叠区间。重启后读取配置修改；价格由用户维护，启动时不抓取网页价格。

用量文件位于 `~/.local/state/dsht/cost/<origin-hash>/`，遵循 `XDG_STATE_HOME`，也可通过 `DSHT_STATE_DIR` 指定应用状态根目录。文件只含会话 ID、时间戳、模型身份、token 数、所选价格版本和估算值，不包含提示词、工具正文、凭据或 cookie。价格文件属于配置，这些用量文件属于状态，因此只有前者需要纳入设置备份。写入使用私有临时文件及原子替换，按历史截点命名的文件避免旧扫描覆盖更新的缓存截点。缓存跨重启保留，不需要访问服务端配置目录。账本保存的是逐条请求而非累计总额，且跳过已扫描会话的记录只存在内存中，因此重启后的首次扫描会重新读取每个会话，并按各请求自身的结算时间重新计算停机期间新增的用量。

## 客户端接口

安装后的包通过 `@itookit/dsht` 导出 `Client`，通过 `@itookit/dsht/auth` 导出 `login`／`CookieStore`，并提供 TypeScript 声明。源码调用方可通过 TypeScript loader 从 `src/client.ts` 导入，或构建后从 `dist/client.js` 导入。`authenticate(token)` 兑换凭据；`connect()` 打开一条多路复用连接；`listWorkspaces()` 和 `listSessions(workspaceId?)` 返回服务端列表的 Promise。`call(endpoint, args, signal?)` 将服务端错误保留为带有 `code` 和 `details` 的 `RemoteError`。务必在 `finally` 中等待 `close()`。库调用方可使用 `src/auth.ts` 的 `login(client, token, new CookieStore())` 启用持久化；`Client.authenticate()` 本身仅在内存中保留凭据。

会话和工作区命令在 `args` 内使用 `{ request: { ... } }`；会话列表使用 `{ _request: {} }`。`$events/result` 直接使用具名参数。重连后的 follow 快照整体替换保留状态；持久消息与临时助手文本分别保存。读取器同时支持 `event` 记录和旧版 `chunks` 包装；后者包含 `chunkrow/text-chunks`、`chunkrow/reasoning-chunks` 或 `chunkrow/tool-call-chunks`。不提供 `assistantStream` 的服务端通过日志 chunk 传递实时文本；TUI 只重建尚未完成的尝试，并保留每条压缩记录的起始序号用于翻页。

## 发布到 npm

本仓库从 `mushuanli/dsht` 仓库发布一个公开包 `@itookit/dsht`。必须使用 scope，因为 npm 会以「与 `dot`、`st` 等现有短名过于相似」为由拒绝非 scope 的 `dsht`。下表中 `package.json` 是各字段的依据。

| 字段 | 值 |
| --- | --- |
| 名称与版本 | `@itookit/dsht` `0.2.2` |
| 可执行命令 | `dsht`，不安装时用 `npx @itookit/dsht` |
| 库入口 | `@itookit/dsht` 和 `@itookit/dsht/auth` |
| 作者 | lizlok\@gmail.com |
| 许可证 | MIT，许可证正文位于 `LICENSE` |
| 仓库与问题反馈 | [mushuanli/dsht](https://github.com/mushuanli/dsht) |
| Node.js | 22.19 或更新版本 |
| Registry 访问 | public，使用 `@itookit` scope |
| 发布内容 | `dist/`、两份 README、它们的配对记录、截图和许可证 |

描述、关键词和依赖位于 `package.json`。以下命令属于维护者操作；创建本地安装包不会自动发布。

```sh
npm run test:package
npm login
npm publish --access public
```

`test:package` 构建 tarball，然后使用安装依赖时填充的缓存，在隔离的离线 npm-exec 安装中运行 CLI，并拒绝上述发布集合之外的打包路径。`prepublishOnly` 执行类型检查和测试；`prepack` 编译 JavaScript 与类型声明。包内不包含源码测试、录制数据和本地认证文件。

`publishConfig.access` 为 `public`；scoped 包需要它才能被公开安装，因此该设置放在包里而不是每次发布命令上。启用两步验证的账号需用即时验证码发布：`npm publish --otp=<验证码>`；验证码在最后一次请求时校验，此时类型检查、测试和构建均已执行完毕。

后续版本由 `.github/workflows/publish.yml` 发布：它以版本 tag 触发，使用 [trusted publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）并生成 provenance，不保存任何发布 token。需在 `npmjs.com` → `@itookit/dsht` → Settings → Trusted Publisher → GitHub Actions 一次性配置：组织或用户 `mushuanli`、仓库 `dsht`、工作流文件名 `publish.yml`、允许动作 `npm publish`。Trusted publishing 无法创建包，因此最早的版本需手工发布；之后的版本推送对应 tag 即可发布，例如 `npm version 0.2.3 && git push --follow-tags`。

手动触发时该工作流只打包不发布，并拒绝与 `package.json` 不一致的 tag。参见官方 [scoped 发布指南](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)和 [npx 文档](https://docs.npmjs.com/cli/npm-exec/)。Registry 发布不属于本仓库已执行的本地验证。

## 开发与限制

```sh
npm test
npm run test:terminal
npm run build
npm run bench:input
node dist/cli.js --help
```

测试使用隔离的 HTTP/WebSocket 服务，驱动实际 Ink 选择器和输入框，在子进程中运行 CLI，并投影复制的 Harness v2 工作区编辑记录和 v0 压缩 chunk 记录。这些检查不需要模型凭据。记录和预期对话输出位于 `tests/`，不依赖父仓库。测试不覆盖真实模型供应商行为。

`npm test` 渲染不带样式的帧，因为断言和 `tests/expected/` 中的预期输出描述的是文本。从终端启动的测试运行器会向每个测试文件导出 `FORCE_COLOR=1`，使 Ink 在提示符与文本之间插入 SGR 转义序列；`npm run test:terminal` 在任何主机上复现该环境，`prepublishOnly` 也会运行它，因此从终端发布时验证的就是终端实际渲染的结果。

输入期间复用历史投影和换行结果，直到对话版本或终端宽度变化；服务端更新和历史翻页会使缓存失效。`bench:input` 使用 20 条和 500 条合成消息，在预热后测量 30 次按键的本地输入至渲染耗时及历史投影读取次数。它排除网络／模型耗时，仅供诊断，不作为跨机器的延迟阈值。

界面显示纯文本、思考内容、工具调用和工具结果。尚未实现富插件卡片、文件上传、子代理导航和队列编辑。重连采用有上限的指数退避及抖动，并替换快照；列表命令直接报告失败而不重试。服务端的非稳定 API 更新后，需要同步本地报文适配和测试。
