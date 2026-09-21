# slash：命令的语法、执行管线、并发模型与事件流

> 本文是 slash 命令的**单一事实源**：一行输入（composer 里按 Enter 的一行、`dsht --command` 的一行、
> 或 `/loop` 参数表单确认的一次运行）如何被解释、归一化、授权、执行、投影成 UI 状态，以及全过程写了哪些事件。
> 本文不仅写"是什么"，也写**每一部分为什么这样定**，以及**为什么不是另一种做法**。
>
> 相关：`loop.md` 记录 `/loop` 协议循环；`README.md` 记录用户可见命令表。
>
> **标记约定**
>
> * **【现状】** 已实现，并有测试；
> * **【目标】** 方向已定、尚未实现——读到它时必须知道当前行为可能不同；
> * **【取舍】** 为什么选 A 而不是 B（含被否决的方案）；
> * **【待定】** 实现前必须由人拍板的产品/语义决定。
>
> 状态：三层分层与统一执行入口、四段管线（`interpret → normalize → authorize → execute`）、`command begin/end`
> 与关联 ID、`/loop stop`（含控制泳道接入）、`SessionMutationGate`（按会话写串行 + 正常/控制两条泳道）、
> `CommandResult` + 判别联合 `ViewEffect[]`（两个 UI 触发业务效果的实例已消除）、`duringTurn`/`duringLoop`
> 按 kind 的 `run`/`deny`（含 headless）、Esc 表驱动、composer 在 busy 期间保持可编辑（13.2-D1）、
> **`ForegroundOperation` 归 controller（槽位 / AbortSignal / 取消入口合一）**是【现状】。
> 前台槽位排队（A1）、`during*` 的 `queue`（A2）、`dsht trace` 汇总、§7.3 的隐私边界
> （结构化 reason + `sanitizeTraceText()` + `--trace-verbose`）也都是【现状】；
> **只读输出源 + 整屏 peek 视图**（§7.5，`Ctrl+O` / `Esc`）也是【现状】——机制、面板、trace 都已落地，
> 只剩"点击 transcript 行打开指定源"（§13.1 里仍标 ◐ 的条目之一）。
> 【目标】另见 §13.1 里仍标 ◐ 的条目（`/loop answer`、`/loop abort` 与 `needs-human` 的 PAUSED 化）。

---

## 0. 设计目标与理由

| 目标 | 为什么 |
|---|---|
| 1 语法、策略、副作用、UI 状态分离 | 四者变化频率与测试方式不同：语法可穷举、策略是表、副作用要真机、UI 要渲染。混在一起时任何一改都要重测全部 |
| 2 TUI / headless / 未来 API 共用业务路径 | 否则"手动能跑、脚本不能跑"或反之，且差异只会在事故里被发现 |
| 3 foreground 命令不允许互相并发 | 同一会话上的副作用无法安全交错；并发只制造难复现的中间态 |
| 4 agent 工作期间 UI 仍可交互并允许 steering | turn 可能数分钟；冻结输入会让"边看边纠正"这一核心用法失效 |
| 5 `/loop` 是长期 orchestration，不长期占用 command busy | 一次 review 可能十分钟；占着执行位等于把 UI 锁死 |
| 6 loop 创建/验证/重试后仍有稳定生命周期 | 会话与连接会变，但"这次 review"必须仍是可追踪、可取消的对象 |
| 7 任何运行状态都有明确 owner | 否则同一事实会有两个写者（"是否忙"既由 controller 又由 UI 判断），必然漂移 |
| 8 重要状态变化均可通过 trace 定位 | 现场只在用户机器上；没有迁移历史就只能猜 |
| 9 新增命令原则上不改根 UI 执行流程 | 根组件每加一个 `if (kind)` 都是一次架构回退 |

---

## 1. 分层与依赖【现状】

| 层 | 目录 | 拥有 | 不拥有 |
|---|---|---|---|
| 输入语义 / 管线 | `src/slash/` | 一行的**含义**：命令表、参数语法、前缀解析、文本归一化 | 任何效果、任何应用运行事实、UI 状态 |
| 应用 | `src/controller/` | **授权**（应用前置条件）、**效果**、session/workspace 生命周期、turn、loop orchestration、并发门控、trace | 组件状态、渲染、键盘所有权 |
| 前端 | `src/ui/`、`src/cli/` | 事实（菜单、屏幕、草稿）与渲染；把结果投影成组件状态 | "这条命令应该做什么" |

**为什么这样分**

* **可测**：`slash/` 是纯叶子，归一化可以只喂事实对象就穷举所有分支，不用挂 Ink、不用连 host；
* **可换前端**：headless 与未来的 HTTP/RPC 只需产出同一种归一化命令，就能复用全部授权与效果；
* **防泄漏**：架构测试禁止 `slash → 非 slash`、`controller → ui`、以及非入口 UI 文件 import controller。

**【取舍】**暂不把 `slash/` 改名 `command/`：名字不改变依赖方向，改名只制造一次大 diff；等必须重构时再改。

---

## 2. 语法层：一行 → 一个 `Command`【现状】

`src/slash/parse.ts` 是纯函数 `parseCommand(line): Command`。**为什么必须纯**：它只回答"这行是什么"，
不回答"现在能不能跑"。把屏幕、待答、busy 塞进解析器，会让"语法对不对"无法单独测试，也会让同一行
在不同前端解析出不同结果。

### 2.1 识别顺序

| 顺序 | 情况 | 结果 | 为什么在这个位置 |
|---|---|---|---|
| 1 | 空行/全空白 | `ignore` | 空提交不该产生事件或副作用 |
| 2 | `!cmd` | `shell`（本机执行） | 不经过 host/模型，必须在"斜杠命令"之前分流 |
| 3 | `@path` 结尾 | 不是命令（交给引用菜单） | 引用是 composer 模式，不是命令语法 |
| 4 | `/name …` | 见 §2.2 | —— |
| 5 | 其它 | `prompt` | 兜底：不是命令就是消息 |

### 2.2 命令名解析

1. 取第一个空格前的 token，`resolveCommand(token)` 解析；
2. **唯一前缀可直接执行**（`/pro Add tests` → `/prompt Add tests`）：省键盘，且前缀唯一时意图无歧义；
3. **歧义前缀不执行**，报候选：猜错会产生副作用，列候选比猜便宜；
4. **`exactOnly` 必须打全**（`/loop`、`/quit`、`/allow`、`/deny`）：这些命令昂贵或不可逆，值得多打几个字符
   换取"不会误触"。

### 2.3 命令表与广告

`registry.ts` 的 `COMMAND_HINTS` 是**用户可见元数据的唯一事实源**，`/help`、Tab 补全、
`commandSuggestions`、`argumentHint` 都由它派生。**为什么单一**：三份列表必然漂移，而漂移的表现是
"帮助里有的命令补全不出来"。

但 registry **不是整个系统的事实源**：语法在 `parse.ts`、授权在 `controller/`、元数据才在这里。
**【取舍】**不把三者塞进 registry：那会让"元数据"变成上帝对象，并强制所有消费者 import 实现。

### 2.4 `/loop` 的参数语法（唯一的复合语法）

```
/loop <name> [score] [tries] [--from N] [--to N] [--score X] [--tries N]
/loop                      → {kind:'loops'}（请求记录列表）
/loop stop                 → {kind:'loopStop'}（控制泳道，结束当前 LoopRun）
/loop abort                → {kind:'loopStop'}（同一动作的暂停期拼写）
/loop answer <text>        → {kind:'loopAnswer', text}（回答一个暂停中的 run，见 §8.3）
```

`stop` 是 `/loop` 自己的子命令，所以 `RESERVED_PROTOCOL_NAMES`（`loop-prompts-schema.ts`）包含它：
记录不能叫 `stop`，菜单也不会把它当记录前缀（`loopNameQuery` 对它返回 undefined）。

记录变量（`vars`，如 `designdoc-review` 的 `path`）**没有命令行语法**。**为什么**：

* 变量名归**记录**所有，语法层不认识 `loop.yaml`；为它造旗标就必须让语法层拿到记录表，破坏纯叶子；
* form → 命令对象比"form → 文本 → 再 parse"更直接（§3.3），文本只是命令的一种**生产方式**。

### 2.5 命令目录（全部命令）

| 命令（含 `usage`） | `kind` | requiresSession | requiresNoInteraction | 效果 |
|---|---|:--:|:--:|---|
| `/ws [name or ID]` | `navigate`(workspace) / `remove` | | | 切换/列表工作区；`--delete` → 删除确认 |
| `/resume [title or ID]` | `navigate`(session) / `remove` | | | 切换/列表会话；`--delete` → 归档确认 |
| `/model [provider model [effort]]` | `models` | ✓ | | 无参 → 模型对话框；有参 → 直接选择 |
| `/new` | `newSession` | | | 新建会话 |
| `/copy` | `copy` | | | 冻结显示供终端选择 |
| `/latest` | `latest` | | | 回实时并释放历史窗口 |
| `/older` | `older` | | | 加载更早历史 |
| `/history [text]` | `history` | ✓ | | 提示词列表/筛选 |
| `/prompt [text]` | `prompts` / `savePrompt` | ✓ / — | | 无参 → 快捷提示词面板；有参 → 保存 |
| `/search text` | `historySearch` | ✓ | | 当前会话内容搜索（结果面板） |
| `/ssearch text` / `/wsearch text` | `sessionSearch` | | | 会话搜索（结果面板） |
| `/compact` | `compact` | ✓ | | 请求 host 压缩历史 |
| `/cancel` | `cancel` | | | 取消当前 turn（并停止 loop，见 §8.5） |
| `/queue` | `queue` | ✓ | ✓ | 待发输入列表 |
| `/plan` `/goal` `/permission` `/feedback` | `hostCommand` | ✓ | ✓ | 原样交给 host 命令注册表 |
| `/handoff` | `handoff` | ✓ | ✓ | 删本地 HANDOFF.md 后发一轮 |
| `/loop [name\|stop] [score] [tries]` | `loop` / `loops` / `loopStop` / `loopAnswer` | ✓ | ✓ / — | 无参 → 记录列表；`<name>` → 表单或直接运行；`stop`/`abort` → 结束当前 LoopRun；`answer <text>` → 回答暂停中的 run |
| `/export [local.zip]` | `export` | ✓ | | 保存会话 ZIP |
| `/export-html [local.html]` | `exportHtml` | ✓ | | 保存离线 HTML |
| `/coredump [tag]` | `coredump` | | | 本机写 V8 堆快照 |
| `/allow` / `/deny` | `approval` | | | 允许一次 / 拒绝待审批 |
| `/status` `/cost` `/help` | `panel` | | | 面板展开/切换 |
| `/think [seq or live]` | `think` | ✓ | | 无参 → 思考列表；`live`/序号 → 折叠 |
| `/quit` | `quit` | | | 退出 |
| `!cmd` | `shell` | ✓ | | 在本机执行，不经过 host/模型 |
| 普通文本 | `prompt` | | | 发送消息；turn 运行中则成为 steering |
| `@path` | ——（不是命令） | | | composer 的 `@` 引用菜单，见 §5.5 |

表头用的是**目标名**（§3.4）：现状里这两个字段叫 `chatOnly` / `blockedByPending`。
`/search` 的关键点：它的结果只在 chat 屏幕渲染，因此 `requiresSession` 挡的是"看起来成功、其实没有出口"
的命令，不只是危险命令；`/ssearch`、`/wsearch` 列出的是会话，在 picker 屏幕同样有意义，所以不挡。
表里还有第三个策略字段 `control`（§6.3.2 控制泳道），目前只有 `loopStop` 声明：它不改变"能不能跑"，
只改变"线上已有另一条命令在跑时能否插队"，所以单独说明而不占一列。

---

## 3. 统一管线：interpret → normalize → authorize → execute【现状】

### 3.1 为什么必须四段，而不是"planLine + authorize"两段

现状的 `planLine` 同时做了三件事：前端解释（菜单/拷贝模式）、文本分类（自由文本是 answer/path/prompt）、
应用授权（会话/待答）。**只切两段会留下一个无家可归的中间层**：自由文本 → `answer`/`prompt` 既不是
"UI 解释"，也不是"授权"，它是**归一化**；因此完整管线是 `interpret → normalize → authorize → execute`。
目标形态：

```
raw line
  │
  ▼ interpret(uiFacts)              前端，各家实现可以不同
  │   @ 菜单 / loop 菜单 / copyMode / 空行 / path 屏幕
  ▼
Submission
  ├─ { kind:'mode'; mode: 'ignore' | 'reference' }
  ├─ { kind:'line'; line: string }    ← 斜杠/感叹号命令，或普通文本
  └─ { kind:'path'; value: string }   ← path 屏幕上的文本
  │
  ▼ normalize(appFacts)             应用，TUI/headless 共用；**不认识 screen**
  │   斜杠解析；自由文本分类（answer / prompt / error）
  ▼
LineCommand
  │
  ▼ authorize(command, appFacts)     应用，TUI/headless 共用
  │   requiresSession / requiresNoInteraction / duringTurn / duringLoop / foreground 冲突
  ▼
Verdict = { allow } | { deny; reason }
  │
  ▼ execute(command)
```

**为什么 authorize 必须在应用层**：它与"是否有选中会话""是否有未处理 interaction""是否在 turn/loop
中"有关，这些是应用事实；只因当前实现用 `screen` 代替 `sessionId`，才看起来像 UI 策略。
headless 也有这些事实（`runStartup` 先选/建会话，所以 `requiresSession` 恒被满足），因此**策略只有一份**。

**为什么 normalize 不认识 `screen`**：path 屏幕的语义在 `interpret` 里就已经变成 `Submission.path`（§3.2），
应用层因此不需要知道"UI 当前在哪个屏幕"。这是 §1 分层在管线里的最后一道封口：
`screen` 只出现在 `interpret`，`Submission` 之后不再出现任何 UI 状态。

**为什么 interpret 可以分前端**：`@` 菜单、草稿菜单、拷贝模式、path 屏幕是终端特有的输入方式；
未来的 HTTP API 没有这些，但归一化之后它必须走同一条 authorize + execute。

### 3.2 interpret（前端）【现状】

只处理前端自有语义：

| 事实 | 结果 |
|---|---|
| `@` 菜单打开 | `Submission: mode reference`（Enter 接受高亮候选） |
| `/loop` 记录菜单打开 | 把草稿补成 `/loop <name>`，继续走 normalize |
| `copyMode` | `Submission: mode ignore` |
| 去空白后为空 | `Submission: mode ignore` |
| `screen === 'path'` | `Submission: path`（value = 草稿文本） |
| 其它 | `Submission: line`（斜杠/感叹号命令或普通文本） |

**为什么 path 由 `interpret` 归类，而不是留给 `normalize`**：如果 `normalize` 需要读 `screen` 才能
判断"这段文本是目录还是消息"，那应用层就反过来依赖了 UI 状态，§1 的分层在管线上破一个口。
**【取舍】另一种做法**是把"正在等待目录"提升为 controller 状态（`inputExpectation: 'workspace-path'`），
那样它就不是 UI screen fact；但对当前规模太重（要新增状态、迁移与清理规则），因此选前者。

### 3.3 normalize（应用）【现状】

| 输入 | 结果 | 为什么 |
|---|---|---|
| `Submission: path` | `{kind:'path', value}` | `interpret` 已判定"这段文本是目录"，应用不需要知道为什么 |
| `Submission: line` + `/` 或 `!` 开头 | `parseCommand` → `Command`（错误原样保留） | 语法归 `slash/parse.ts` |
| `Submission: line` + 自由文本 + 待答**问题** | `{kind:'answer', text}` | 问题允许自由文本作答 |
| `Submission: line` + 自由文本 + 待答**审批** | `{kind:'error'}`（要求 `/allow`/`/deny`） | 审批不接受自由文本 |
| `Submission: line` + 其它自由文本 | `{kind:'prompt', text}` | 消息 |

**【现状】对照**：这些判断今天都在 `planLine`（§3.6），迁移后 `planLine` 只保留 §3.2 的表格。

### 3.4 authorize（应用）：策略是事实，不是屏幕【现状】

| 目标字段 | 现状名 | 真正含义 | 违规结果 |
|---|---|---|---|
| `requiresSession` | `chatOnly` | 命令作用于"当前选中的会话" | `Select a session first` |
| `requiresNoInteraction` | `blockedByPending` | 选中会话没有未处理 interaction | `Answer the pending question or approval first` |
| `whileBusy: 'run'\|'queue'\|'deny'` | —— | 前台槽位被别的 operation 占用时可否执行 | `Wait for the running operation to finish` |
| `duringTurn: 'run'\|'deny'` | —— | turn 运行期间可否执行 | 拒绝 |
| `duringLoop: 'run'\|'deny'` | —— | loop 运行期间可否执行 | 拒绝 |

**"是否占用前台槽位"不是策略字段**：它由执行原语本身决定（走 `runAction` 就是 foreground，返回 effects 就是 ui），
见 §3.5；把它写成 policy 字段会造出第二个事实源。

**为什么改名**：`chatOnly` 带着"chat 屏幕"的 UI 气味，但它保护的是业务前置条件；headless 下
`requiresSession` 依然成立（启动时已选/建会话）。`blockedByPending` 曾经**在 headless 完全没有检查**，
这个真实缺口已经补上：`cli/startup.ts` 现在也走 `normalize → authorize`，
没有应答通道的调用方遇到未处理 interaction 会被直接拒绝，而不是继续执行（§5.1）。

**为什么 `during*` 按 `kind` 而不是命令名挂**：一个命令名会映射到不同 kind
（`/prompt`→`prompts`/`savePrompt`，`/loop`→`loop`/`loops`，`/model` 有无参数分支）。
按名字挂策略会出现"保存提示词被当成面板命令"这类错误。

**一期矩阵（已实现）**：策略表里只写 `deny`，缺省即"不受约束"——读操作、视图切换、本地命令、
host 自己的命令都不需要为"我在运行"单独开一条：

```ts
const QUEUES_WHILE_RUNNING   = { duringTurn: 'queue', duringLoop: 'queue' };  // compact / handoff / loop
const CONFLICTS_WITH_RUNNING = { duringTurn: 'deny',  duringLoop: 'deny'  };  // loops（裸 /loop 的记录列表）
const ANSWERS_WHILE_RUNNING  = { duringTurn: 'run',   duringLoop: 'run'   };  // panel / copy / think / cancel / approval / loopStop / loopAnswer
const ANSWERS_WHILE_BUSY     = { whileBusy: 'run' };                          // cancel / approval / loopStop
```

* **`queue` 的是操作者自己的写入**：`compact`、`handoff`、`loop`（启动一次评审）。它们与正在跑的 turn
  写同一个会话，但"下一件事做这个"是操作者明确按下 Enter 表达的意图，直接拒绝等于让这句话无法表达；
  所以它们被**接受并持有**，等 turn（或 loop）结束后运行；
* **仍然 deny 的是"此刻提供也没有意义"的**：裸 `/loop` 的记录列表是给正在敲的草稿用的面，
  turn 结束时操作者早已不在那个上下文里；
* **`hostCommand`（`/plan`、`/goal`、`/permission`、`/feedback`）不 deny**：host 自己拥有这些命令的
  busy 规则，客户端替它拒绝只会与 host 的实际行为矛盾（这条是被现有测试逼出来的）；
* **`models`（`/model`）也不 deny**：它改的是后续请求的默认值，面板在 turn 期间照样能开；
* **`cancel`/`approval` 明确 `run`**：取消与解决 interaction 恰恰是 turn 期间最需要能用的两条；
* 判定顺序是 `requiresSession` → `requiresNoInteraction` → `during` → `whileBusy`：等待中的互动是更可操作的理由，
  而且它通常就意味着 turn 也在跑；turn/loop 的红线比"前台槽位被占"更长期、也更能说明要停什么；
* **前台槽位的默认是 deny**（D1：长操作期间 Enter 拒绝提交并保留 draft），只有声明 `whileBusy: 'run'` 的
  命令放行：`cancel`、`approval`、`loopStop`——它们的存在意义就是打断或了结占用槽位的那件事。
  `control: true`（只有 `loopStop`）说的是**另一件事**：它在 §6.3 的会话写 gate 里属于控制泳道、可抢等待队列；
  `/loop answer` 也一样放行——一个暂停中的 run 正在等这条命令，把它排到 turn 后面等于永远答不上；
  两个字段都在，因为"前台槽位"和"会话写次序"本来就是两个事实；
* 拒绝文案按事实区分：turn → `Wait for the running turn to finish`；loop → `Stop the running loop first`
  （停 loop 才是操作者要先做的事）。

**前端怎么给出这个事实**：`loop.active ? 'loop' : queries.running ? 'turn' : 'idle'`——只有 **`active`** 参与判断，
所以一个已经终止、只是残留进度行的 loop 不会 deny 任何东西（§13.3-Q3）。

**`queue` 由谁履行**【现状】：`authorize` 返回 `{allow:true, command, defer:'turn'|'loop'|'busy'}`，
`defer` 就是"要等哪个事实"。TUI 把这一行放进一个**前端持有的 FIFO**（`ui/app.tsx` 的 `queuedLines`），
条件满足时按到达顺序重新授权并运行——端口与效果都属于前端，所以队列也只能由前端履行；
运行前会再授权一次，若事实又变了就放回队首继续等，会话已经切换的行会被丢弃并说明原因。
脚本前端（`cli/startup.ts`）没有输入框可持有，于是**等待同一个事实**（上限 `STEP_TIMEOUT_MS`）后运行，
因为"只要客户端在跑 turn，`--command` 就失败"会让自动化在它最需要的时候不可用。
`command` 事件在入队时写一条 `phase:'queued'`（带 `reason`），真正执行时照旧写 `begin`/`end`，
所以"这一行被接受但还没跑"在 trace 里是可见的；`dsht trace` 不把 `queued` 计入执行次数。

**优先级**：`during` 的 `deny` > `during` 的 `queue` > `whileBusy` 的 `deny` > `whileBusy` 的 `queue`。
即：会被拒的事实先拒；只要有一个事实是"排队"就排队（反正要等，此刻槽位忙不忙不改变结论）；
只有都不排队时才轮到前台槽位说话。

`/loop stop`（`loopStop`）是例外中的例外：它是**控制泳道**（§6.3.2），并且显式 `during*: 'run'`——
"停止正在跑的东西"没有可以被判 deny 的理由，判 deny 只会在最需要它的时候让它不可用。

**【取舍】`queue` 暂不出现在类型里**：host 侧还没有"命令排队"能力，保留一个类型上允许、系统却无法履行的
取值，只会制造"配置了 queue 但实际被当成 deny 或静默丢弃"的中间态。等 P4 真正做队列时再把
`DuringExecution` 扩展成 `'run' | 'queue' | 'deny'`；在那之前，authorize **永远不得返回 queue**。

### 3.5 执行类别：**执行原语本身就是事实源**，不要第二张表【现状】

现状里"执行类别"是**涌现**的：`execute` 里调不调 `controller.actions.*`（busy 信封）就决定它是
foreground 还是 ui。它既不能按 kind 静态决定，也不该由第二个函数回答：

| 命令 | 情况 | 实际执行类别 | 为什么 |
|---|---|---|---|
| `/loop` | bare | `ui` | 记录列表来自本地 `loop.yaml`，无网络、无 action |
| `/loop name` | 无旗标 | `ui` | 只是返回表单意图（`interactive` 时） |
| `/loop name 9` | 有旗标 | `foreground` → `LoopRun` | `startLoop` 走 busy 信封，随后交给 LoopRun |
| `/model` | bare | **`foreground`** + UI effect | 先 `modelCatalog()` 拉目录（网络），再开对话框 |
| `/model p m` | 有参 | `foreground` | 改默认模型 |
| `/ws` / `/resume` | bare | **`foreground`** + UI effect | `showPicker` 会 `listWorkspaces/listSessions`（网络） |
| `/ws foo` | 有参 | `foreground` | 切换 |

**结论：不要存在 `operationClassOf(command)`。** 让真正的执行原语成为唯一事实：

```ts
execute(command) {
  // 走前台槽位就是 foreground：kind/label 在这里给出，trace 的 foreground begin/end 与 operationId 自动产生
  return controller.actions.switchSession(query);   // → runAction('navigation', 'Switching session…', …)
  // 直接返回 ViewEffect[] 就是 ui
  // startLoop(...) 短暂经过前台槽位，然后转交 LoopRun
}
```

这样"**执行方式 = 分类事实**"，不会出现"函数说是 foreground、`execute` 实际没占槽"的漂移。

**【取舍】如果 authorize 必须在执行前知道类别**（例如要在动手前拒绝冲突），用一个**事前计划**
`prepare(command, context) → UiPlan | ForegroundPlan | TurnPlan | LoopPlan`，**但不要同时保留
`operationClassOf()` 与 `execute` 的自行决定**——二选一。
对当前规模，先不做 `prepare`：authorize 只判断静态谓词与 `foreground` 冲突，类别由执行原语体现。

**顺带修正一处自相矛盾**：`/model` bare、`/ws` bare、`/resume` bare 看起来是"UI 命令"，但它们**都会发网络请求**
（拉目录 / 刷新列表），因此是 foreground + UI effect。真正纯 UI 的只有本地就能完成投影的命令
（`/loop` bare、`/history`、`/prompt` bare、`/queue`、`/think` bare、`panel` 等）。

### 3.6 现状对照：`planLine` 的判定顺序（迁移前的事实基线）

| 顺序 | 事实 | 结果 |
|---|---|---|
| 1 | `referenceOpen` | `ui: reference` |
| 2 | `copyMode` | `ui: ignore` |
| 3 | 空白 | `ui: ignore` |
| 4 | `/` 或 `!` | `parseCommand` + `COMMAND_POLICY` |
| 5 | `question` | `command: answer` |
| 6 | `pending` | `command: error` |
| 7 | `screen === 'path'` | `command: path` |
| 8 | `screen !== 'chat'` | `command: error` |
| 9 | 其它 | `command: prompt` |

**关键不变量**：屏幕守卫只决定"这条已解析的命令**能不能在这里跑**"，绝不改变"它**是什么**"。

---

## 4. 应用：`execute` → 结果（`src/controller/commands.ts`）

### 4.1 单一入口 + 授权次数【现状】

```ts
runCommand(controller, command: LineCommand, port: CommandPort): Promise<CommandResult | undefined>
```

* TUI：`ui/app.tsx` 的 `submit`；headless：`cli/startup.ts` 的每条 `--command`；
* 两者共享全部授权与效果；`command` 事件因此天然覆盖所有入口。

`port`：

| 字段 | 含义 | 为什么 |
|---|---|---|
| `run(label, op)` | 在 UI 的 loading/可取消信封里执行 | 让应用借前端 UI，而不必 import UI |
| `interactive` | 调用方**能显示面板并等人操作** | "要不要弹表单"是调用方能力问题；脚本默认无人可问 |

**授权按"每次提交"计【现状】**：`/loop <name>` 的表单意图在 `execute` 内产生，表单的 Start 是**第二次提交**。
`ui/app.tsx` 把两个入口都指向同一对 helper（`applicationFacts()` + `verdictFor()`）：命令行走
`normalize → verdictFor`，表单 Start 走 `verdictFor` 再 `runCommand`。表单打开期间世界会变
（turn 开跑、问题到达），所以 Start 会拿到当时的理由（如 `Wait for the running turn to finish`）
并留在屏上，而不是带着过期的事实去启动一个注定失败的 run。

### 4.2 返回类型：`CommandResult`【现状】

旧形态是一组 optional 字段（`CommandIntent`），非法组合可表达（`{open, close, toggle}` 能同现），
且一个 `accepted:boolean` 同时承担"草稿要不要清"与"命令成功没有"两件事。现在：

```ts
interface CommandResult {
  disposition: 'consume' | 'retain';   // 输入是否清除
  outcome: 'ok' | 'rejected' | 'cancelled' | 'failed';
  effects: ViewEffect[];               // 数组顺序即执行顺序
}
```

**【取舍】为什么两个维度**：它们正交。语法错误 = `retain + rejected`；成功 = `consume + ok`；
表单校验失败 = `retain + rejected`；导出中断（Esc）= `retain + cancelled`。一个布尔无法表达，实现者只能各自解读。
`undefined`（没有结果）仍然表示**应用没接受这一行**——离线、已有一行在飞、某个 action 拒绝启动——草稿留在原处；
`cancelled` 专门表示"已经开始、被调用方中断"，由 `runCancellable()` 用 abort 信号区分，不再和"没接受"混在一个 `undefined` 里。

### 4.3 kind → 效果 → 结果对照【现状】

| kind | 应用做什么 | effects（顺序即契约；`ok` = `consume+ok`，除非另注） |
|---|---|---|
| `quit` / `copy` | 退出 / 冻结显示 | `[quit]` / `[copy]` |
| `panel` | `/cost` 额外起一次刷新（`port.run`，不等回包） | `[closePanels, toggle]` |
| `remove` | `removalTarget`；空会话直接归档 | `[closePanels]` / `[closePanels, open:'removal', removal]` |
| `navigate` | `switchWorkspace` / `switchSession` | `[closePanels, scroll:0]` |
| `path` | `createWorkspace` | `[closePanels]` |
| `latest` | 释放窗口/固定/折叠 | `[closePanels, live, pinLive, resetFolds, scroll:0]` |
| `models` | 无参拉目录；有参选模型 | `[closePanels, model:{catalog}]` / `[closePanels, close:'model']` |
| `queue` / `prompts` | 无 | `[closePanels, open:'queue'\|'prompts']` |
| `savePrompt` | 保存快捷提示词 | `[closePanels, notice]` |
| `shell` | 本机启动 `!` | `[closePanels, scroll:0]` |
| `newSession` | 新建会话 | `[closePanels]` |
| `history` | 无 | `[closePanels, history:{query, contentSearch:false}]` |
| `sessionSearch` | `searchSessions`（可取消） | `[closePanels, search]`；中断 → `retain+cancelled` |
| `historySearch` | `searchHistory`（可取消） | `[closePanels, history:{…, contentSearch:true}]`；中断 → `retain+cancelled` |
| `think` | 无参列表；`live`/序号切折叠 | `[closePanels, open:'thoughts']` / `[closePanels, toggleLiveReasoning, scroll:0]` / `[closePanels, toggleFold]` |
| `older` | 加载更早历史 | `[closePanels, scrollBy:10]` |
| `compact` / `hostCommand` | host 命令（可取消） | `[closePanels, notice]`；中断 → `retain+cancelled` |
| `cancel` / `approval` | 取消 turn / 允许或拒绝 | `[closePanels]` |
| `export` / `exportHtml` / `coredump` | 写文件 / 写堆快照 | `[closePanels, notice]`；前两个中断 → `retain+cancelled` |
| `answer` | **应用自己完成提问瀑布**（`actions.answerQuestion`） | `[closePanels]` |
| `error` | 无 | `retain+rejected`：`[closePanels, error]` |
| `prompt` | 发送消息 | `[closePanels, live, scroll:0]` |
| `handoff` | 删本地 HANDOFF.md 后发一轮 | `[closePanels, live, scroll:0, notice]` |
| `loops` | 无（纯交互命令） | `retain+rejected`：`[closePanels, error]`（列出可用记录） |
| `loop` | 查记录、校验变量、解析 limits、启动 | `[closePanels, loop:{name}]` / `[closePanels, live, scroll:0, notice]` / `retain+rejected: [closePanels, error]`；`not-started` 只给 `[error]`，表单留在屏上 |
| `loopStop` | 结束运行中的 run（`stop`/`abort` 同一分支） | `[closePanels, live, scroll:0, notice]`；没有 run 时只给 `notice` |
| `loopAnswer` | 回答暂停中的 run，重新判断当前产出物 | `[closePanels, live, scroll:0, notice]`；不是暂停中的 verdict 请求 → `retain+rejected: [error]`（并说明该答什么） |

### 4.4 返回约定与 `ViewEffect`【现状】

| 返回值 | 含义 | 前端行为 |
|---|---|---|
| 有结果 | 接受或明确失败 | `applyResult`：按数组顺序应用 effects，`disposition` 决定清不清草稿 |
| `undefined` | 未被接受（离线/busy/动作拒绝启动） | 保留草稿；失败原因只在 action 信封里（`state.operation.error`） |
| `outcome: 'rejected'` + `{kind:'error'}` | 可读失败 | 显示错误，**不动屏幕**：拒绝不关任何面板，草稿、参数表单、正在读的面板都留在原处可重试 |

**`ViewEffect` 是判别联合**（`payload?: unknown` 会丢掉现有类型安全：`history`/`search`/`model`/
`removal`/`loop` 各自形状）；`CommandIntent` 已删除，没有两套。

**【取舍】顺序由数组定义（方案 A）**：既然 `effects` 是数组，执行顺序就是数组顺序；
`applyEffect` 不得再自行排序，否则数组顺序变成假语义。生产者（`execute`）负责按契约顺序 emit：

```
closePanels → close → open/toggle → live/pinLive/resetFolds/toggle* → scroll/scrollBy → notice/error
```

唯一的例外是**读取顺序**：`closePanels` 在契约里排第一，而它要知道"这一批结果保留哪个面"，
所以 `applyResult` 先扫一遍数组取出 `open`/`toggle` 的 `panel` 再开始应用——它读的是数组，不改变顺序。

若担心多生产者不可信，才退回方案 B（结构化 slots + apply 排序），但**不要两个都保留**。

**两个 UI 触发业务效果的实例都已消除**（I1/I6）：

| 实例 | 旧路径 | 现在的路径 |
|---|---|---|
| `answer` | `intent.answer` → `applyIntent` → `answerQuestion` → `controller.actions.answer(...)` | `execute` 的 `answer` 分支直接调 `controller.actions.answerQuestion({ custom })`；**提问瀑布本身也搬进了 controller**（`Controller.answerQuestion`），因为"当前是第几个子问题"由已收集的答案推出，勾选项也存在 `interaction.option` 里，前端只负责渲染 |
| `refreshCosts` | `/cost` 的 `applyIntent` 分支 → `controller.actions.refreshCosts(signal)` | `/cost` 的 `execute` 内用 `port.run(...)` 起请求（`void`，前台只显示 loading 标签），返回 `[closePanels, toggle:'cost']` |

**为什么值得单独列**：`/cost` 那条路径很隐蔽——面板是 UI 的，但它顺手发起了一个业务请求。
两条都被测试和架构守卫钉住：`tests/controller/commands.test.ts` 在没有 UI 的情况下断言"输入回答"和
"`/cost` 刷新"都发生在 `runCommand` 内，`tests/architecture/dependencies.test.ts` 则禁止 `ui/app.tsx`
出现 `refreshCosts` 或直接调用 `answer(`。

**命令失败只有一个通道（13.2-D2）**：`CommandResult.outcome` + 同名文本的 `error` effect + `command end`
事件；`runCommand` 会在这一行自己报告失败之后清掉 action 信封里的同一次失败，避免状态栏再显示一遍。
`state.operation.error` 从此是**内部 lastFailure**（连接、会话流、动作信封自己的失败），
只在"这一行根本没被接受"时才是用户可见的唯一解释。

---

## 5. 前端：结果 → UI 状态

### 5.1 两个前端与真正的共享边界【现状】

| 前端 | 入口 | 流程 |
|---|---|---|
| TUI | `ui/app.tsx` `submit` | interpret → normalize → authorize → execute → apply |
| headless | `cli/startup.ts` `runStartup` | normalize → authorize → execute（无 interpret）|

**为什么 headless 不走 interpret 但要走 authorize**：`interpret` 处理的是终端输入方式（菜单/拷贝/屏幕），
headless 没有；而 authorize 处理的是业务前置条件，两个前端**都有**这些事实。`runStartup` 先选/建会话，
所以 `requiresSession` 恒被满足；`requiresNoInteraction`/`during*` 现在也检查——它和 TUI 调用同一张
策略表，只是 `interpret` 一步换成 `{ kind: 'line', line }`（§3.4）。

### 5.2 `applyResult` / `applyEffect` 的边界【现状】

`applyResult(result)` 是**命令结果改变 UI 状态的唯一入口**：它按顺序遍历 `result.effects` 并逐个交给
`applyEffect`，然后用 `disposition` 决定是否清草稿。**为什么不是"所有 UI 状态修改的唯一入口"**：composer 草稿、
`@` 菜单高亮、方向键选择、Esc 关菜单、光标移动都是 UI 自有状态，与命令无关。

### 5.3 面（surfaces）与键所有权【现状】

`surfaces` 表描述每个面板：`open`、`arrows`、`blocksKeys`、`reserved`、`close`，由它派生
`openSurfaces`、`recallBlocked`、`panelBlocksKeys`、`dialogOpen`。

**为什么用表**：每加一个面都要同时改"Esc 关闭、方向键归属、是否屏蔽数字键、是否冻结状态栏"四处；
用表只需加一行，遗漏会变成可见缺失（例如曾经 `/resume` 没有 Esc 分支）。

### 5.4 Esc：取消命令打开的东西【现状：一张有序表】

| # | 条件 | 行为 | 为什么在这个位置 |
|---|---|---|---|
| 1 | copy mode | 退出复制模式 | 复制模式拥有最高键盘优先 |
| 2 | `composerIntent` | 放弃编辑、清空草稿 | 借用输入框的编辑是"最当前"的交互 |
| 3 | 可取消操作进行中 | abort（必要时顺带关列表） | 取消正在跑的比关闭静态面板更紧迫 |
| 4 | 待答审批/提问 | 关闭整批 / 从自由输入退回 | 待答独占键盘 |
| 5 | 面板（queue/prompts/removal/model/thoughts/search/history） | 关闭 | 静态面次于运行中的操作 |
| 6 | `path` / `sessions` / `workspaces` 屏幕 | 回上一层 | 屏幕级导航 |
| 7 | `/loop` 记录菜单 | 隐藏（不撤销选择） | 菜单是草稿辅助 |
| 8 | `@` 引用菜单 | 隐藏 | 同上 |
| 9 | `help`/`cost`/`status`/`notice` | 关闭/清空 | 纯阅读面 |
| 10 | 本地 `!` 在跑 | 取消本地命令 | 本地命令与本机最相关 |
| 11 | chat | 打断 turn（`controller.interrupt` 同时 `stopLoop`） | 兜底 |

**实现**：上表就是 `ui/app.tsx` 里的 `escapeRules` 数组，按序 `find` 第一个成立的条件并执行；
`key.escape` 在别处只出现两次（copy mode 与这次查表），由 `tests/architecture/dependencies.test.ts` 钉住。
**为什么改成表**：原来是一条 `if (key.escape && …)` 长链，于是出现过两类事故——某个面板根本没有 Esc 分支
（`/resume`），以及分支被放在兜底之后、永远轮不到。加一个面现在只需在表里加一行，位置就是优先级。

**【取舍】为什么不让 Esc 隐式停整个 loop**：loop 可能处于 `verifying/needs-human`，没有 active turn，
"打断 turn"语义不明；第 11 行的兜底走 `controller.interrupt`，它按既有语义先 `stopLoop` 再打断 turn，
需要"只停 loop"时用显式的 `/loop stop`（§8.5）。

### 5.5 composer 上的三个模式【现状】

| 模式 | 何时 | Enter | Esc | 其它键 |
|---|---|---|---|---|
| `@` 引用菜单 | 草稿尾部 `@…` | 接受高亮候选进草稿 | 隐藏 | ↑↓ 选择、Tab 插入 |
| `/loop` 记录菜单 | 草稿是 `/loop` 或 `/loop <前缀>` | **补全成 `/loop <name>` 后走管线** | 隐藏 | ↑↓ 选择、Tab 补名 |
| `/loop` 参数表单 | 应用返回 `{kind:'loop'}` effect | 提交当前行 / 开始运行 | 先撤销编辑再退出 | ↑↓ 换行、直接输入覆盖、离开一行即提交 |

**为什么记录菜单不直接打开表单**：直接开表单会让"选记录"成为第二条执行路径（不经过管线、不写
`command` 事件、不查策略）。补全后照常走管线，菜单/表单/typed 命令三者共用同一套判定与同一条事件流。

### 5.6 并发与门控（现状）与两层并发（目标）

**现状规则**：产生效果的行占用"执行位"；被占用期间 composer 不聚焦，任何新行（slash 或 prompt）都提交不进来。

| 事实 | 何时置位 | 效果 |
|---|---|---|
| `state.operation.busy` | `controller.actions.*` 的 busy 信封（全局） | 挡住命令与 prompt |
| `historyLoading` | UI 借出的可取消请求 | 同上；封住纯 UI 侧请求 |
| `composerIntent` | 命令借用输入框编辑 | 关闭（Enter=提交编辑） |
| `loopForm` | `/loop` 参数表单 | 关闭（表单接管按键） |
| `answerPending` | 待答审批/提问 | 关闭（草稿被寄存） |
| `copyMode` | 复制模式 | 关闭 |

**允许在"执行中"发生的**：Esc/Ctrl+C 中止；待答对话框按键；滚动/复制/查看；已打开的面保持到被替换。
**prompt 与命令**：受同一执行位约束；但 prompt 启动的 turn **不占执行位**（`running ≠ busy`），
所以 agent 工作期间 composer 开着：文本成为 steering，控制类命令照常执行。
**为什么保留这个重叠**：产品需求（边看边纠正），不是疏漏；命令↔命令仍串行。

**"执行位"已显式化为 `ForegroundOperation`（§6.2）**：UI 不再持有 `historyAbort`/`historyLoading` 这类影子状态，渲染与取消都走 controller。

---

## 6. 并发模型：两层锁【现状】

### 6.1 为什么必须分开

迁移前把两件事压在一个全局 `busy` 上：

```
ForegroundOperation（全局唯一）           SessionMutationGate(sessionId)
  = 用户命令互斥（UX 串行）                 = 业务正确性（同会话写串行）
```

压在一起的后果，两个方向都错：

* **过锁**：`/export`（只读）占全局槽，却可能无意义地挡住别的东西；
* **漏锁**：loop 的 `settleWith → flushLoop → promptInternal` **不经过** busy 信封，
  于是 `compact S1`（写）与 `loop.promptInternal S1`（写）可以在客户端并发（见 §6.4 的现状说明）。

**结论**：`ForegroundOperation` 是**用户交互并发模型**，不是 session 数据一致性锁。两者必须分开，
否则只是把旧的 `busy` 换个名字。

最终形态：

```
                       USER INPUT
                           │
                           ▼
                    interpret(UI)
                           │
                           ▼
                      Submission
                           │
                           ▼
                  normalize(App facts)      ← 不认识 screen
                           │
                           ▼
                    LineCommand
                           │
                           ▼
                 authorize(App facts)
                           │
                           ▼
                       execute
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
  ForegroundOperation    Turn           LoopRun
       max 1          lifecycle       lifecycle
          │                │                │
          └──────────┬─────┴───────┬────────┘
                     │             │
                     ▼             ▼
              SessionMutationGate(sessionId)
                admission / dispatch only
                     │
                     ▼
                    host

旁路：LocalShellRun → 本机进程；PendingInteractions → session + eventId
```

```
ForegroundOperation ≠ SessionMutationGate ≠ Turn ≠ LoopRun ≠ LocalShellRun
   UX 串行              写入次序           agent     workflow    本机进程
                                         生命周期    生命周期      生命周期
```

### 6.2 `ForegroundOperation`（全局，max 1）【现状】

```ts
interface ForegroundOperation extends ForegroundSnapshot { readonly abort: AbortController }
// ForegroundSnapshot = { id: number; kind: ForegroundKind; label: string; startedAt: number }
```

* 覆盖：切换/新建/删除会话与工作区、搜索、导出、compact 请求、加载历史、模型目录与选择，以及
  **前端自己编排的分页/加载**——凡是"用户主动发起、需要 UX 串行"的都占这个位。它和 §6.3 的
  session 写锁回答的是**两个不同问题**：这里串行的是"操作者此刻在做的事"，读操作同样占位。
* **owner 是 controller**：槽位、`AbortController`、`id/kind/label/startedAt` 都在 controller 里，
  `queries.foreground` 供渲染，`actions.cancelForeground()` 是唯一的取消入口。UI 不再持有
  `historyAbort`/`historyLoading` 这类影子状态（架构守卫禁止它们再出现），Esc 的第 3 条规则
  就是"取消当前 operation"（§5.4）。
* **两种认领方式，一个事实**：`actions` 的每个入口自带 `kind`/`label` 并在内部认领；前端自己编排的工作
  （历史分页、跳转）走 `actions.foreground(kind, label, work, wait)`。
  **`wait: true` 是 A1 的排队**：槽位被占时按到达顺序等待（`foreground phase:'queued'` 记录它等过），
  释放时把槽位**直接交给队首**（`foregroundGranted` 防止新来的插队），客户端停止时唤醒所有等待者并放弃。
  默认 `wait` 为假＝拒绝，因为操作者主动提交的那一行由 `authorize` 决定（D1：默认拒绝并保留草稿）。**嵌套不重复认领**：用
  `AsyncLocalStorage` 记录"当前 continuation 属于哪个 operation"，所以分页循环里调 `older`、
  `/cost` 的 effect 里调 `refreshCosts` 都不会因为"client busy"被自己拒掉——普通布尔标志做不到这一点。
* **UI 里唯一剩下的 `AbortController`** 是 `@` 引用查找：它逐键触发、随组件卸载取消，是查询而不是一次
  operation，既不占槽位也不该被 Esc 当成"当前操作"取消——这是有意的例外，不是漏网。
* **取消语义**：`cancelForeground()` 只 `abort()` 槽位持有者的信号，认领方拿到 `undefined`；槽位释放后
  再调返回 false。Esc 在"有 operation 在跑"时取消它（而不是打断 agent turn），只有没有 operation 时
  才走到兜底的 `interrupt`。
* **诊断**：每次认领写一对 `foreground begin/end`（`id`、`kind`，end 带 `cancelled`），
  所以"那一刻客户端在忙什么、是不是被人取消的"可以直接从 trace 读出来（§7）。

### 6.3 `SessionMutationGate(sessionId)`（按会话写串行）【现状】

#### 6.3.1 锁的范围：**admission / dispatch，不是整个远端生命周期**【现状】

Gate 保护的是"**决定并提交 mutation 的顺序**"，不是"远端 mutation 跑完没有"。持锁跨越整个
异步生命周期会立刻产生两个坏结果：

* `cancel`/`interrupt` 也要取同一把锁 → 它得等一个可能很久的 `compact` 释放锁，**取消失去"立即打断"能力**；
* `promptInternal` 等网络回包期间持锁 → 普通 steering、approval 全排在它后面。

正确的形状（也是实现形状）：

```ts
// src/session/controller.ts —— prompt 的 admission
const admission = await this.mutations.admit(sessionId, 'normal', () => {
  if (this.store.state.pending.length) throw new Error('Answer the pending question or approval first');
  if (!this.info.record.ready) throw new Error('Wait for the session snapshot before sending');
  const issued = this.host.require().call('session/prompt', { request: { sessionId, mode: this.running ? 'steer' : 'queue', … } });
  this.admission = issued;
  return issued;              // 只把"已发出的请求"交出去
});
try { await admission; } finally { … }   // approve/gate 之外才等远端回包
```

`admit` 的 `finally` 在 section **返回**时释放，所以即使 section 是 `async`，也只持有到它的第一个
`await`；把 `await` 写进 section（或让 gate 自己 `await dispatch()`）会立刻让"长 compact 挡住 cancel"复活。
这一条由测试守住：`session-writes.test.ts` 让 host 卡住 `/compact`，再断言 `session/cancel` 仍然立刻到达。

**【取舍】为什么可以在 dispatch 后释放**：请求交给传输层后顺序已定，host 按会话串行执行；
Gate 要消除的是"两个并发决定基于同一份陈旧状态"，而不是"两个远端任务同时在跑"。

#### 6.3.2 两条泳道：控制优先【现状】

| 泳道 | 动作（`admit` 的 `lane`） | 规则 |
|---|---|---|
| 普通 | `prompt`（新 turn）、steering、host `command`（如 `/compact`）、`answer`/`approve`/`dismissQuestion`、`removeQueued`、`archiveSession` | 同会话内按到达顺序串行 dispatch |
| **控制** | `cancelTurn` / `interrupt` / `cancelNamedSession` | **可抢占普通泳道的等待队列**：只等"正在执行的 section"结束，不等排在后面的正常等待者 |

`/loop stop` 本身不改 host 会话（它只收本地 LoopRun 与验证子进程），因此不进这张表；它作为**控制命令**
的准入在 §3.4 的 `during*` 之外单独放行（`isControlCommand`）。

**为什么必须分泳道**：控制类动作的存在意义就是"立刻生效"；如果它和普通 mutation 共用一条 FIFO，
用户按 Ctrl+C 时最需要它快的场景反而最慢。

#### 6.3.3 读不取锁【现状】

| 类别 | 动作 | 取写锁？ |
|---|---|---|
| 写 | `prompt`（新 turn）、steering、`promptInternal`（loop） | ✓ |
| 写 | host `command`（如 `/compact`） | ✓ |
| 写 | `answer` / `approve` / `dismissQuestion`（解决 interaction） | ✓ |
| 写 | `cancelTurn` / `interrupt` / `cancelNamedSession`（控制泳道） | ✓ |
| 写 | `removeQueued`（改 host 队列） | ✓ |
| 写 | `archiveSession`（按被归档的 sessionId 建键） | ✓ |
| 读 | `export` / `exportHtml`（读会话日志或已加载 transcript） | ✗ |
| 读 | `searchHistory` / `searchSessions` | ✗ |
| 读 | `older` / `historyThrough` / `historyAt` | ✗ |
| 读 | `status` / `cost` / `modelCatalog` / `refreshCosts` | ✗ |
| 非会话 | `selectModel`（host 默认模型）、`createWorkspace`、`createSession` | ✗（只占 foreground 槽） |


**两条硬性要求**：

1. **按目标 sessionId 建键**，不是"当前选中"：`createVerifierSession` / `cancelVerifierSession` 操作的是
   别的会话，锁必须落在那个会话上；
2. **只覆盖写**：读操作不得因为"都是 foreground"而取得写锁。

### 6.4 与现有机制的关系（不是从零造锁）

* host 侧已有"一个会话一个 active turn"的语义（`session/prompt` 带 `mode: running ? 'steer' : 'queue'`）；
* client 侧 `admission` 仍只是**跟踪**字段（最后一个未回包的 prompt），供 `interrupt` 判断"要不要先等这次
  提交落地"；串行化本身已由 gate 提供，不再依赖"两个 `prompt` 恰好同步执行"这一巧合；
* 所以 P2 的工作是：把"同会话写串行"从隐含事实变成**显式 gate + 测试**，并关闭
  `promptInternal` 与 foreground mutation 的重叠。
* **已落地**（`src/session/mutation-gate.ts` + `SessionController` 的每个写入口）：`prompt`/`promptInternal`、
  `command`、`answer`/`approve`/`dismissQuestion`、`removeQueued`、`archiveSession` 走**正常泳道**，
  `cancelTurn`/`interrupt`/`cancelNamedSession` 走**控制泳道**；键是**目标 sessionId**（验证者的 child session
  独立成键），读操作完全不取锁。gate 的 section 只做"检查 → 决定 → 发出请求"并 `return` 那个 promise，
  调用方在 gate 之外 `await`，所以**一次 `/compact` 不会把 cancel 挡在门外**。

### 6.5 这个 gate **不**负责的事

* **工作区文件竞争**：agent 写 `DESIGN-DOC-REVIEW.md` 与 `settleChecked` 读它，属于 artifact 版本问题，
  已由"验证前指纹 + 变化即作废 verdict"处理（`loop.md` §6）。不要把它塞进 session 写锁；
* **跨会话一致性**：两个会话各自的数据互不冲突，gate 按会话建键即可；
* **进程级持久化**：loop/shell 都是进程内状态，进程退出即结束（§7.3）。

---

## 7. 事件流（默认写 `<state>/trace.log`）

`TraceLog` 每行一个 JSON，只写**标识、阶段与计数**，绝不写 prompt/工具/会话正文。
**为什么**：这份日志会被贴进问题报告；一旦含正文，就等于把会话内容带出机器。

| event | phase（典型） | 谁写 | 记录什么 |
|---|---|---|---|
| `command` | `queued`/`begin`/`end` | 前端（`queued`）+ `runCommand` | `queued`：被策略持有的一行（`kind`、`reason`）；`begin`/`end`：真正执行的一行，同一 `commandId`，`end` 带 `kind`、`outcome`、`disposition`、失败时的 `error` |
| `mutation` | `admit` | `SessionMutationGate`（`SessionController` 注入的观察者） | 每次会话写准入：`session`、`lane`（`normal`/`control`）、`waited`；**行的先后就是 dispatch 先后** |
| `foreground` | `begin`/`end` | `Controller` | 前台槽位的一次认领：`id`、`kind`；end 带 `cancelled` |
| `action` | — | `Controller` | `showPicker`/`pickWorkspace`/`switchWorkspace`/`switchSession`/`selectSession`/`createWorkspace`/`createSession`/`enterPath`/`removeTarget`/`showChat` |
| `generation` | `begin`/`ready`/`settled`/`ended` | controller | 一次连接代际的生命周期 |
| `picker` / `adopt` / `resolve` | — | controller | 选择器请求 / 采用本地目录 / 代际结束时的会话决定（含 loop 重挂） |
| `state` | — | controller | 具体状态字段变化（`online`/`screen`/`session`/`workspace`…） |
| `loop` | `command`/`form`/`rejected`/`not-started`/`begin`/`verify-first`/`sent`/`answered`/`end` | commands + controller | `/loop` 的决策、启动与回答；`answered` 只记 `judged` 与 `chars`，**绝不记答案正文** |
| `loop-ui` | `choose`/`open`/`start` | app | 菜单选了哪条记录、表单是否打开、Start 提交的值 |
| `verify` | `begin`/`verified`/`retry`/`unavailable`/`fallback`/`needs-human`/`cancelled`/`stale`/`abandoned` | controller | 每次 fork 验证的生命周期 |
| `peek` | `begin`/`end` | controller | 只读视图打开了哪个源（`source`、`kind`）；配对只用于对账，不参与淘汰（见 §7.5） |
| `artifact` | `missing` | controller | 验证给分但产出物缺本轮小节（硬判不通过） |

### 7.1 一次 `/loop` 的典型序列（真实先后）

```
loop-ui choose      draft="/loop", index=1, chosen="designdoc-review"
command begin       commandId="C1", kind="loop"     ← 第一次提交：这一行进入 executor
loop    command     name="designdoc-review", interactive=true, vars=[path]
loop    form        name="designdoc-review"        ← 应用返回表单意图
command end         commandId="C1", kind="loop", accepted=true, outcome="ok"
loop-ui open        name="designdoc-review", known=true
loop-ui start       from=1,to=10,score=8,tries=10,vars=["path"]
command begin       commandId="C2", kind="loop"     ← Start 提交（带确认后的值）
loop    command     name="designdoc-review", flags=[…], vars=[path]
loop    begin       runId=…, kind=…, session=…, forked=true
loop    verify-first runId=…, step=1
command end         commandId="C2", kind="loop", accepted=true, outcome="ok"
verify  begin       runId=…, kind=…, step=1, attempt=1, seq=1, file=…
verify  verified    runId=…, score=…   |  verify unavailable runId=…, reason=…
```

一次运行是**两个 `command` span**：列表确认只产生表单意图，Start 才真正启动；
`loop begin` 带 `runId` 与 `command begin C2` 的顺序是固定的（`startLoop` 在 `execute` 内同步开始）。

### 7.2 `command begin/end` 与关联 ID【现状】

```json
{"event":"command","phase":"begin","commandId":"C17","kind":"loop"}
{"event":"command","phase":"end","commandId":"C17","kind":"loop","accepted":true,"outcome":"ok"}
{"event":"command","phase":"end","commandId":"C18","kind":"error","accepted":false,"outcome":"error","error":"Unknown command…"}
```

**为什么加 begin**：end 是一行的总账（`accepted` + `outcome` ∈ `ok|refused|error|failed`），begin 则让"进程在副作用中途
崩溃"也留下"它进过 executor"；`execute` 抛错时 end 仍会写（`outcome="failed"`），否则一个 begin 会永远没有配对。
**关联 ID**：`commandId / operationId / turnId / loopRunId / verifyId / sessionId / generationId`，
让 slash 命令、turn、verifier 子进程、child session 交叠时仍能串起来。
**【已补齐】**`LoopProgress.runId` 已暴露，`loop begin`/`loop end` 都带 `runId`；每条 `command` 也由
`Controller.nextCommandId()` 分配 `commandId`。**配对淘汰**已实现（`trace-log.ts` 的 `compactCut`）：切割点只落在
`command`/`loop`/`generation` 的 span 之外——若窗口边界会留下没有 begin 的 close，就把切割点前移到那个 close 之后；
一个 close 从未出现的 span 不能"被拆开"，因此不移动切割点（那正是崩溃现场）。

**【取舍】为什么不持久化 loop 状态**：loop 属客户端进程，进程退出即结束；trace 是唯一历史。
**由此 I9 有边界**：`TraceLog` 上限 2000 条并会重写压缩，一个 span 仍可能整体滑出窗口；`compactCut` 保证的是
**留下的那一半不残缺**，而不是"每个 begin 都还在窗口里"。

### 7.3 隐私边界：结构化字段，而不是子进程正文【现状】

旧行为是 `ProcessVerifier` 把子进程**最后一行**并入 `unavailable.reason`，而 reason 会同时进入
**UI 进度行**、**verdict 摘要**与 **`verify` trace**——stderr 里可能是路径、模型输出甚至带 credential 的
报错。现在：

* **默认只有结构化事实**：`verifier wrote no verdict (exit 1) · stderrClass auth`。
  类别由 `classifyVerifierOutput()` 判定（`auth` → `host` → `config` → `unknown`，取最可操作的一类）；
  子进程什么都没写时**不写类别**（`unknown` 在"正常退出但没写文件"这一类上只是噪音）。
* **正文默认不出现**：只有 `--trace-verbose`（或 `DSHT_TRACE_VERBOSE=1`）才附加最后一行，
  且必须先过 `sanitizeTraceText()`（`src/text.ts`）：绝对路径与 URL 路径段 → `<path>`，
  `token=`/`Authorization: Bearer`/`sk-…`/长十六进制 → `<redacted>`，空白折叠、长度截断。
* **它只过滤诊断文本**：operator 本就该完整读到的消息（verdict、他主动要的错误）不经过它——
  否则"脱敏"会变成"丢失信息"。
* 取消/超时的 reason 本来就只写结构化 note（`remote cancel confirmed|rejected|unconfirmed after N ms`）。

**为什么类别比正文更有用**：这份日志的价值是"下一步该做什么"——`auth` 要换凭据、`host` 要重试、
`config` 重试也没用；这些结论不需要把用户的路径带出机器。

### 7.4 诊断原则

* "命令没反应"先看 `command`：连 `begin` 都没有 → 前端根本没提交（菜单/门控/失焦）；有 `begin` 没 `end` → 副作用
  进行中或进程死了；有 `end` 但 `accepted=false` → 看 `error` 与 `outcome`。同一个 `commandId` 把三者串起来；
* "循环没启动"看 `loop` 的 `refused`/`failed`/`not-started`；"循环为何结束"看 `loop end` 的 `reason`（= `terminalReason`）；
* "验证没有结论"看 `verify` 的 `unavailable`（结构化字段 + 可选正文）。

**`dsht trace`：把同一份文件读回几行事实。** trace 是给机器的 JSONL，而人读它只问固定几个问题，
所以把它们写进了 `src/cli/trace-summary.ts`（纯函数，可单测）并由 `dsht trace [--trace <path>] [--json]` 打印：
命令按 outcome/kind 计数、会话写入按 lane/session、前台槽位的次数/取消数/最长一次、
每个 loop run 的 `sent` 次数与结局（含 `terminalReason`）、验证的 `begin` 与各类收尾（含 `stderrClass`），
以及所有 begin/end 不配对的 span（含"end without begin"——那说明窗口淘汰或写入端出了问题）。
它需要 host、凭据、终端都为零，因为读自己的日志本来就不该需要这些；老格式（没有 `runId`、没有
`command begin/end`）也能读，只是把同一段历史归到一个无 identity 的 run 上（显示为 `<no-run-id>`）。

### 7.5 只读输出源与 peek 视图【现状】

**问题**：一个 client 里同时存在多份"别人在说话"的输出——fork 出来的 verifier 会话、host 侧 subagent
子会话、本机 `!` 命令的 stdout——而它们此前只能靠"切过去选中"来看。选中即写入（follow 成为当前会话、
composer 换了收件人），所以"看一眼"和"接管"分不开。

**机制**（`OutputSource` / `PeekSnapshot` / `SessionPeek`）：

* **一个源就是一个可读对象**：`OutputSource { id, kind, label, state, startedAt?, endedAt?, createdBy,
  parentSessionId?, detail? }`。血缘是重点——`createdBy` 说谁造的、`parentSessionId` 说属于哪个会话，
  看的人不必猜这个 session 为什么存在。
* **三个来源合成一张表**（`Controller.outputSources()`）：本 client 自己造的 session（host 没有记录这条
  血缘的 API，所以由 client 登记，`createdBy: 'verifier'`）、本机 `!` 运行（`shell:<id>`，`createdBy: 'shell'`）、
  host 侧 subagent 子会话（唯一记载在 `session/list` 行的 `origin`/`parentSessionId`，`createdBy: 'agent'`）。
  同一 session 上 client 登记优先于列表行，因为它知道得更多。
* **跟随是只读的**：`SessionPeek` 用 `session/follow` 订阅目标地址，自带一个 `Transcript`，**不选中、不
  写入、不占用 mutation 门**；关闭即 `cancel()` + `releaseHistoryLayout` + `dispose()`。子会话在其 parent
  之下，地址形态（`continuable`/`one-shot`）列表行并不携带，因此按 `costAddresses()` 的顺序逐个尝试。
* **同址复用**：`!` 的地址形态与 subagent 相同，所以这一条通路以后同时服务两者——本机 `!` 现在仍然是
  内联块（**共存**，不是替换），peek 是它的展开视图。

**【取舍】为什么 host 侧子会话登记要改上层仓库**：`session/create` 的参数只有
`{ workspaceId?, cwd?, sessionId? }`，host 的父子关系来自 `subagents.list(parentSessionId)` 目录。
本 client 造的 verifier session 因此**只能由 client 自己**记住血缘；要让它也成为 host 意义上的 child，
需要在被审查的仓库里给 create 增加 `parentSessionId`/origin 并登记进目录——那是 `tui/` 之外的一步，
**尚未做**。现在的做法是在 client 侧登记（`createdSources`），并让 peeker 对两种地址形态都能工作：
即使将来 host 侧补上了，客户端代码不需要改。

**【取舍】为什么是整屏只读视图**：面板按 §5.3 是"面"，但这一张复用的是会话本身的排版（
`queries.render()`，与聊天同一套 wrap/markdown/颜色），并且要能滚动长输出；塞进 composer 上方的
小面板既看不清也不是"读别人输出"的形态。所以它是唯一**替换正文区**的面：打开时 composer 让位，
`Esc` 是唯一回路（Esc 表第 4 条，早于 pending/面板规则）。键盘入口 `Ctrl+O` 打开"最新的一个源"，
点击 transcript 行打开指定源是下一步（§13.1 未标 ✅ 的条目）。

---

## 8. 生命周期模型

### 8.1 五个生命周期【现状】

```
App / runtime
├── ForegroundOperation      短事务，全局 max 1          controller.foreground（投影 state.operation.busy）
├── Turn                     agent 工作，会话级           session.running + workingSince
├── LoopRun                  长期 orchestration，绑定 parentSessionId   controller.loop，带 runId
├── LocalShellRun            本地 `!`，UI/local-runtime owned          state.shell，单实例已强制
└── PendingInteractions      待答审批/提问，按会话+eventId               state.pending
```

**为什么五个都命名**：目标 7 是"任何运行状态都有明确 owner"。前四个现在都有自己的对象与身份
（`foreground.id`、turn 的 `workingSince`、`loop.runId`、shell 的单实例约束），第五个按 eventId 排队。

### 8.2 scope【现状】

| 生命周期 | scope | 现状 |
|---|---|---|
| ForegroundOperation | **全局唯一** | `controller.foreground`（`queries.foreground`）+ 它投影的 `state.operation.busy` ✔ |
| Turn | 当前选中会话 | `session.running` + `workingSince` ✔ |
| LoopRun | **immutable `parentSessionId`**（不是"当前选中会话"） | `ScoredLoop.sessionId` 启动时捕获后不变 ✔ |
| LocalShellRun | UI/local-runtime（与 host 无关） | `state.shell` ✔ |
| PendingInteractions | 按会话 + eventId 的队列 | `state.pending` ✔ |

**为什么 LoopRun 不能"属于当前选中会话"**：那会让 UI selection 反向决定 application ownership。
正确关系是：LoopRun 绑定 `parentSessionId`；**切换选中会话是"取消 loop"的触发条件**（一条策略），
不是归属变化。将来若允许"切走但继续跑"，只需改触发策略，不必改身份模型。

### 8.3 phase 的 terminality 必须显式定义【现状】

现状 `ScoredLoop.active` 就是 `phase === 'running'`；`needs-human` 目前**显式是终态**
（无 answer 通道，`active = false`）。所以直接定：

| 分类 | 取值 | 含义 |
|---|---|---|
| ACTIVE | `running` | 还会发送/结算 |
| PAUSED | `needs-human` **且没有 `terminalReason`** | 判断要一个人：run 仍持有会话（不可被静默替换），`/loop answer` 继续、`/loop abort` 结束；不消耗任何预算 |
| TERMINAL | `passed` `exhausted` `stalled` `blocked` `unavailable` `cancelled` `needs-human`（有 `terminalReason`）`deadline` | 已经结束，不会再有迁移 |

**为什么必须显式**：只说"phase = 结局"是不准确的（`running` 不是结局），而 `needs-human` 是否终态
决定了"回答后能否继续"这一整条路径；模糊会让状态机出现无法判定的分支。

#### 8.3.1 "存在"与"正在运行"必须分开

终态进度行会继续显示（D3），所以 `state` 里"有一份 loop 进度"并不等于"loop 在跑"。必须只用一个谓词：

```ts
loop.active === (loop.phase === 'running' || (loop.phase === 'needs-human' && loop.terminalReason === undefined))
```

即 `active` = "这一轮 run 还没结束"。暂停算未结束：它还在等操作者，**不能被静默替换**（新的 `/loop` 必须显式
先结束它）；但它也不在"工作"，所以 `progress.activity` 缺失，界面据此显示 `⏸ needs you` 而不是时钟。

`active` 是所有**并发与授权判断**的唯一入口：

```
duringLoop 授权 / 禁止第二个 /loop / steering 是否属于 loop
/resume、/ws、/new、/handoff 是否 deny / Esc 的 loop 行为
```

而"存在"只能表示"有一份当前/最近的 LoopProgress 可展示"。因此目标里状态字段命名为
**`loopProgress?: LoopProgress`**（不是 `loop?: LoopRun`），从命名上就阻止 `if (state.loop)` 被当成
"正在运行"来用。这是这类终态可见 UI 最常见的 bug 来源。

### 8.4 LoopRun：两轴 + 父子会话【现状 + 目标修正】

```
phase    : 见 §8.3
activity : turn | verify | settle            （仅 phase === 'running' 时有意义）
```

**为什么保留两轴，而不是单轴 `starting/waiting-agent/verifying/retrying/needs-human/cancelling`**：

* `passed/exhausted/...` 是**结果**，删掉就丢失最重要信息；
* `retrying` 不是独立状态（重试就是再来一次 verify/turn）；
* `cancelling` 不存在（取消耗子是同步的）；
* 两轴各答一问：`phase` = 生命周期位置与结局，`activity` = 此刻在等什么。

**为什么 work 在父会话，只有 verifier 隔离**：被审对象与其上下文属于当前会话；把 work 拆到 child session
会让产出物、历史、steering 全部换上下文，且每步多一个 session。**真正需要隔离的只有验证**：
`ProcessVerifier` 为**每次验证任务**创建自己的 session，任务结束即弃。

```
LoopRun { id, parentSessionId, verifierSessionId?, step, attempt, phase, activity, startedAt }
```

**身份规则**：稳定身份是 `LoopRunId`；`parentSessionId`、`verifierSessionId`、连接 `generation` 都是
它**使用的载体**，变化不改变身份。现状 loop 重挂已按 `loop.sessionId` 找回自身（`ready()` 的 `resolve`），
方向一致；缺的是把 `loopRunId` 正式写进 trace（§7.2）。

### 8.5 终止语义与 terminalReason【现状】

| 触发 | 现状行为 | 目标 |
|---|---|---|
| `/cancel` | `cancelTurn()` 第一行就是 `stopLoop()` → **loop 一起停** | 保持；语义 = 取消当前 turn（若在 loop 中，同时终止 loop） |
| Esc / Ctrl+C | `interrupt()` 同样先 `stopLoop()` | 保持；Esc 是上下文相关的"取消当前最紧急的东西" |
| `/loop stop` / `/loop abort` | 已实现：`parseCommand` 认 `stop`/`abort`（同一 `loopStop`），`execute` 调 `stopLoop()`；两者都在 `RESERVED_PROTOCOL_NAMES` | 保持；无运行时给 `No loop is running` 而不是报错，终态进度行保留（D3）；暂停中的 run 用 `abort` 拼写更自然 |
| 判断者弃权 | 已实现：`ScoredLoop.settle()` 收到 `abstained` → `pause()`（phase `needs-human`、**不写** `terminalReason`） | `/loop answer <text>` 只补充判断条件、用**新的 verificationId** 重新判断当前产出物（不进入工作阶段、不结算任何计数）；`/loop abort` 结束它 |
| 验证进程/host 要人 | 保持终态：`human(request, 'verifier-needs-human')`——验证子进程自己的会话提问，本客户端无法代答 | 保持终态；操作者处理完外部阻塞后重跑（§4.2 二期语义不变） |

**结论**："用户取消 turn 后 loop 立刻 retry"在现状**不成立**（`/cancel`、Esc、Ctrl+C 都先停 loop）。
但"终止原因进入状态机"仍然缺，真实实例有两个：

1. **`prompt()` 在有待答时直接 throw**（session 层），loop 的 `flushLoop` 捕获后是
   `forgetLoop() + operation.error`——loop 被**丢弃**，而不是像 verify 路径那样进入 `needs-human`；
2. turn 因 host 侧原因结束且没有 result block 时，会**消耗一次 attempt 重试**：这是设计意图，
   但"谁终止的/为什么没有 block"的信息丢了。

**【取舍】为什么叫 `terminalReason` 而不是 `cancelOrigin`**：`verifier-needs-human`、`send-rejected`
根本不是 cancel。若把它们塞进 `cancelOrigin`，trace 会出现 `phase=needs-human` 却带
`cancelOrigin=verifier-needs-human` 这种自相矛盾的记录。

```ts
type LoopTerminalReason =
  | 'user-cancelled'          // /loop stop、Esc、/cancel
  | 'turn-cancelled'          // turn 被外部取消
  | 'send-rejected'           // 发送被拒（有待答、快照未就绪、离线）
  | 'verifier-needs-human'    // 验证者要求人工
  | 'verifier-unavailable'    // 验证故障用尽重试
  | 'deadline'                // 整轮截止
  | 'pass' | 'exhausted' | 'stalled' | 'blocked';   // 正常判定结果
```

`terminalReason?` **只在进入终态时写入一次**，且与 `phase` 自洽（这是可加断言的不变量）；
`cancelOrigin` 这个字段不再存在。同时让 work 路径与 verify 路径一样能进 `needs-human`。

### 8.6 PendingInteractions 为什么独立

提问/审批是**按会话、按 eventId** 到达的交互，可以在没有 active turn 时出现，也可能一次多个（瀑布）。
塞进 `TurnState.waiting-human` 会让"turn 结束但还有待答"这种常见状态无法表达。

---

## 9. 系统不变量（I1–I10）

> 这些不变量是"实现完成后必须由测试保证"的清单；本文其余章节引用它们。

| # | 不变量 | 现状 |
|---|---|---|
| I1 | 用户命令的业务副作用只能经 `authorize → execute` | ✔ 两个实例（`answer`、`/cost` 的 `refreshCosts`）已消除；"输入回答"与"打开 cost 面板"的业务请求都发生在 `execute` 内，并由架构守卫钉住 |
| I2 | 全局最多一个 `ForegroundOperation` | ✔ `state.operation.busy` |
| I3 | **同一 session 的 mutation 的 admission/dispatch 串行有序；长期生命周期不持有 mutation gate** | ✔ `SessionMutationGate`：按目标 sessionId 建键、正常/控制两泳道、section 返回即释放；`session-writes.test.ts` 用卡住的 `/compact` 证明 gate 不跨回包 |
| I4 | `Turn running ≠ Foreground busy` | ✔ |
| I5 | `LoopRun running ≠ Foreground busy` | ✔ |
| I6 | UI 不直接执行业务 action | ⚠ 同 I1 |
| I7 | Controller 不修改 component state | ✔ |
| I8 | `LoopRun` identity 不依赖 session/generation | ✔（`LoopProgress.runId` + `loop begin/end` 的 `runId`） |
| I9 | 每个 lifecycle `begin` 在**trace 保留窗口内**有配对的 `end`/`failed`/`cancelled` | ✔ `command`/`loop`/`generation` 有 begin/close；`compactCut` 成对淘汰 |
| I10 | root UI 不按 command kind 做业务分派 | ✔ 架构测试已守 |

**附带不变量**（小、但必须断言）：

* `loop.active === (phase === 'running')`，且所有并发/授权判断只用 `active`（§8.3.1）；
* `terminalReason` 与 `phase` 自洽（例：`phase=cancelled` ⇔ `terminalReason ∈ {user-cancelled, turn-cancelled}`）；
* `loopProgress != null` **不蕴含** `loop.active`（终态进度仍可展示）。


---

## 10. 新增一条命令的清单

1. **语法**：`slash/parse.ts` 加 `Command` 变体与分支；
2. **广告**：`registry.ts` 的 `COMMAND_HINTS` 加一行；
3. **授权**：需要会话 → `requiresSession`；需要无待答 → `requiresNoInteraction`；需要在 turn/loop 或前台槽位被占时
   特殊处理 → `duringTurn`/`duringLoop`/`whileBusy`（缺省即 `run`／前台缺省是 `deny`）；**不需要**声明执行位——走
   `controller.actions.*` 自动占 foreground，
   纯 UI 命令自动成为可被 `closePanels` 替换的面；
4. **效果**：`commands.ts` 的 `execute` 加 `case` 返回结果；需要等人操作时用 `port.interactive`；
5. **展示**：只有需要**新表现动词**时才动 `ViewEffect` 与 `surfaces`；
6. **测试**：语法 + 归一化 + 授权（`tests/ui/commands.test.ts`）、效果与结果（`tests/controller/commands.test.ts`）、
   端到端与键（必要时 `tests/ui/app.test.tsx`）。

**为什么"不需要改根组件"**：授权是查表、效果在 controller、结果由 `applyResult`/`applyEffect` 解释、面由 `surfaces` 描述；
只有引入**全新表现动词**才需要动 UI。

---

## 11. 测试与架构守卫

| 断言 | 位置 | 为什么 |
|---|---|---|
| `slash` 只依赖 `slash`；`ui` 只经 `contracts` 读 feature；只有 `ui/app.tsx`/`mount.tsx` 可 import controller | `tests/architecture/dependencies.test.ts` | 分层靠测试固定 |
| 根组件只判断 `submission.action.kind`，三段管线各调一次，命令必须交给 `runCommand`，不得对 `executable.kind` 分支 | 同上 | I10 |
| 归一化九条顺序、授权谓词、前缀/exactOnly | `tests/ui/commands.test.ts` | "一行含义唯一"是下游全部推理的前提 |
| 每条命令的 kind → effects（数组顺序即契约） | `tests/controller/commands.test.ts` | 应用策略 |
| `duringTurn`/`duringLoop` 只拒会写同一会话的命令；pending 的理由优先 | `tests/ui/commands.test.ts` | §3.4 |
| 前台槽位被占时由 `authorize` 拒绝并给理由，只有 `whileBusy: 'run'` 的命令放行 | `tests/ui/commands.test.ts`、`tests/ui/app.test.tsx` | §3.4/D1 |
| turn/loop 期间 `queue` 的命令被接受并持有；`defer` 的事实与优先级 | `tests/ui/commands.test.ts` | §3.4/A2 |
| 前端队列按到达顺序在事实清零后运行；脚本前端等待同一事实 | `tests/ui/app.test.tsx`、`tests/cli/startup.test.ts` | §3.4/A2 |
| 前台槽位 FIFO：`wait` 的认领按到达顺序被服务，新来的不插队 | `tests/controller/foreground.test.ts` | §6.2/A1 |
| `queued` 不计入 `dsht trace` 的执行次数 | `tests/cli/trace-summary.test.ts` | §7 |
| 弃权 → 暂停（active、无 terminalReason、不消耗 attempt）；`/loop answer` 以新 identity 重判；`/loop abort` 结束 | `tests/controller/loop.test.ts`、`tests/controller/loop-verify.test.ts`、`tests/ui/app.test.tsx` | §8.3/D4 |
| `stop`/`abort`/`answer` 的语法、保留名与策略 | `tests/ui/commands.test.ts` | §2.4/§3.4 |
| 前端不得读 policy 表自行判断准入 | `tests/architecture/dependencies.test.ts` | I10/§3.4 |
| headless 也走 normalize → authorize（忙时拒绝而不是交给 host） | `tests/cli/startup.test.ts` | §3.4/§5.1 |
| Esc 由一张有序表决定，别处不得出现 `key.escape &&` | `tests/architecture/dependencies.test.ts` | §5.4 |
| D1：busy 期间草稿可写、Enter 被拒、结束不自动发送、也不清别人写的草稿 | `tests/ui/app.test.tsx` | §13.2-D1 |
| loop 的下一次发送在前台占位时被持有而不是让运行失败 | `tests/controller/loop-run.test.ts` | §7.1/P4 |
| 前台槽位：一次一个、发布 id/kind/label、取消只 abort 持有者、嵌套动作不被自己拒绝、begin/end 入 trace | `tests/controller/foreground.test.ts` | §6.2 |
| 前端不留 operation 影子状态（`historyAbort`/`historyLoading`），渲染 `queries.foreground`、取消走 `cancelForeground` | `tests/architecture/dependencies.test.ts` | §6.2 |
| 运行态只有一个事实：`state.operation` 不再存在，失败是 `state.lastFailure`，运行是 `queries.foreground` | `tests/architecture/dependencies.test.ts` | D2 |
| 表单 Start 重新授权：表单打开期间开跑的 turn 会让 Start 被拒且表单留在屏上 | `tests/ui/app.test.tsx` | §3.4 |
| 验证失败原因只有结构化字段；类别判定；`--trace-verbose` 下的脱敏 | `tests/cli/verifier.test.ts`、`tests/session/sanitize.test.ts` | §7.3 |
| `CommandResult` 的两个维度：拒绝保留草稿、成功清空草稿 | `tests/ui/app.test.tsx`（`retain`/`consume` 用例） | §4.2 |
| 输入回答与 `/cost` 刷新都发生在 `runCommand` 内，前端不自己发业务请求 | `tests/controller/commands.test.ts`（无 UI 的两个用例）、`tests/architecture/dependencies.test.ts` | I1/I6 |
| 每条执行行恰好一对 `command begin/end`、同一个 `commandId`、end 带 `outcome`/`disposition`（失败时带同源的 `error`），且不含参数正文 | 同上 | 事件总账 + 隐私 + I9 + D2 |
| 执行位被占用时第二条命令与 prompt 都提交不进来 | `tests/ui/app.test.tsx`（`/compact` 挂起） | §5.6 |
| 同会话写串行：`promptInternal` 不与 foreground mutation 重叠 | `tests/controller/session-writes.test.ts`（同一 gate、同一键）、`tests/session/mutation-gate.test.ts`（顺序/控制抢泳/跨会话独立/抛错释放） | I3 |
| 长 mutation 不持有 gate：卡住的 `/compact` 期间 cancel 立即 dispatch | `tests/controller/session-writes.test.ts` | §6.3.1、§13.3-Q2 |
| `/loop` 全流程（菜单→表单→启动→验证→trace） | `tests/ui/app.test.tsx`、`tests/controller/loop-*.test.ts` | 复合命令端到端 |
| loop 身份跨重连不变 | `tests/controller/loop-run.test.ts` | §8.4 |
| `begin/end` 在保留窗口内配对 | `tests/controller/trace-log.test.ts`（`compactCut`） | I9 |
| `/loop stop` 结束运行、无运行时只提示；记录名 `stop` 被拒 | `tests/ui/app.test.tsx`、`tests/controller/commands.test.ts`、`tests/ui/commands.test.ts` | §8.5 + 控制泳道 |
| 三个来源合成一张源表（client 登记的 verifier、`!` 运行、host subagent 子会话），登记优先于列表行 | `tests/controller/sources.test.ts` | §7.5 |
| 跟随只读：`session/follow` 用正确地址形态（子会话两种都试）、不选中不写入、关闭即 cancel | `tests/controller/sources.test.ts`、`tests/ui/app.test.tsx` | §7.5 |
| 本地源不需要流：`lines` 直接可读，打开它不发 host 请求 | `tests/controller/sources.test.ts` | §7.5 |
| 整屏视图：`Ctrl+O` 打开最新源、箭头/PgUp/PgDn/滚轮滚动、`Esc` 关闭并交回 composer | `tests/ui/app.test.tsx` | §7.5/§5.4 |

---

## 12. 设计取舍（为什么不是另一种做法）

| 被否决的做法 | 否决理由 |
|---|---|
| 语法/管线放进 `ui/` | "一行是什么"与前端外观无关；放纯叶子可被两个前端与单测直接使用 |
| registry 也拥有授权与执行 | registry 变成上帝对象，消费者被迫 import 实现 |
| 根组件按 `kind` 分派 | 每加命令都改根流程，且无法机械守卫 |
| 只切"planLine / authorize"两段 | 自由文本分类（answer/path/prompt）无家可归（§3.1） |
| `operationClass` 放进 policy 静态字段 | 与 `runAction` 涌现的类别形成两个事实源；且按 kind 无法表达 `/loop`/`/model`/`/ws` 的多形态 |
| 用一个 `busy` 表示所有运行态 | 五种生命周期的并发关系不同（§6.1），合并后只能全锁或全放 |
| 让 `ForegroundOperation` 兼任 session 写锁 | 过锁（只读挡写）与漏锁（loop 内部发送绕过）同时发生（§6） |
| 把 `SessionMutationGate` 做成覆盖整个远端生命周期的 mutex | `/compact` 等长 mutation 会把 `cancel` 排在几十秒之后，控制泳道就失去意义；而且 `promptInternal` 的网络回包会把普通 steering、approval 全堵在后面（§6.3.1） |
| 保留 `CommandIntent` 的一组 optional 字段，只加 `outcome`/`disposition` | 非法组合仍然可表达（`open`/`close`/`toggle` 同现），payload 仍是可选字段而非判别联合；而 `ViewEffect[]` 让"顺序"成为契约本身 |
| 把 `answer` 定义为受控例外（§4.4 的备选） | 提问瀑布的状态（当前是第几个子问题、勾选了哪些标签）本来就在 controller 里，前端只是渲染；把瀑布搬过去反而**减少**了一条"前端自己调 `answer`"的路径，且键路径与命令行从此共用一份实现 |
| 让 gate `await dispatch()`（等 section 返回的 promise 结算） | section 只负责"发出请求"，`await` 会让"发出即释放"悄悄退回成长持锁；实现里用 `return dispatch()` 保证，并由卡住 `/compact` 的用例守住（§6.3.1） |
| 给 loop 单轴 `retrying/cancelling` 相位 | 不表达新事实，且丢掉 outcome 相位（§8.4） |
| 每步开 child session 做 work | 被审上下文属于当前会话；只有验证需要隔离（§8.4） |
| `ViewEffect` 自行排序 | 与"数组即顺序"冲突，让数组顺序变成假语义（§4.4） |
| `payload?: unknown` 的 `ViewEffect` | 丢掉现有类型安全 |
| trace 直接写子进程最后一行 | 与"绝不写正文"冲突（§7.3） |
| 现在把 `slash/` 改名 `command/` | 无功能收益，制造大 diff（§1） |
| 现在就把 `duringTurn` 的 `queue` 写进类型 | host 无排队能力；类型允许而系统无法履行会制造静默丢弃。一期类型只保留 `run/deny`，`queue` 为保留值（§3.4） |
| 持久化 loop 状态 | loop 属客户端进程；持久化要定义恢复/冲突语义（§7.2） |

---

## 13. 目标态差距、原因与顺序

> **设计在此收敛**：本节之后不再新增"大抽象"。后续若需改动，作为**新决策**追加到 13.2，而不是重写结构。

### 13.1 落地顺序

| 期 | 做什么 | 为什么这个顺序 |
|---|---|---|
| **P0** | 固定 §9 的 I1–I10 与附带不变量；定义 §8.3 terminality 与 §8.3.1 的 `active` 谓词；定义 §8.5 `terminalReason`；把 §3 的四段管线（含 `Submission.path`）写进契约 | 先把"什么算冲突、什么算终止、什么算终止原因"钉死；P2/P3 都依赖这些定义 |
| **P1** ✅ | `command begin/end` + 关联 ID（含 `LoopProgress.runId`）；trace 压缩成对淘汰；`/loop stop` + 保留名 | 已实现；`loopStop` 带 `control: true`，`ui/app.tsx` 照此让它在运行期间也能提交；配合 D1（P4）后，启动那一刻的 busy 信封期间也能把这一行打进去 |
| **P2** ✅ | **`SessionMutationGate(sessionId)`**：显式化 host 单 turn 语义 + client 写串行；关闭 `promptInternal` 与 foreground 写的重叠 | 已实现（`src/session/mutation-gate.ts`）：**admission/dispatch serializer，不是 long-running mutex**；`cancel`/`interrupt`/`cancelNamedSession` 走控制泳道，可抢占普通等待队列；每个写入口都被 `mutation` 事件记录（§6.3.1/§6.3.2）。**仍未做**：`runAction` 的 busy 信封仍是"拒绝第二个"而不是排队（P4 未完成部分） |
| **P3** ✅ | `CommandResult` + 判别联合 `ViewEffect`（数组即顺序）；消除两个 UI 触发效果（`answer`、`/cost` 的 `refreshCosts`）；按 13.2-D2 收敛错误通道 | 已实现：`CommandIntent` 删除；提问瀑布搬进 `Controller.answerQuestion`（键路径与命令行共用）；`/cost` 的刷新由 `execute` 经 `port.run` 起；`runCommand` 在本行已报告失败后清掉 action 信封里的同一次失败。**仍未做**：`state.operation.error` 仍是连接/动作信封的字段（未进一步删除或改名） |
| **P4** ✅ | `ForegroundOperation` 归 controller（含 AbortSignal）；`duringTurn`/`duringLoop` 按 kind（一期 `run/deny`）；Esc 表驱动；LoopRun 显式对象与 loop 发送排队；composer 聚焦策略（13.2-D1） | 已实现（§6.2/§3.4/§5.4/§13.2-D1）：槽位 + abort + `id/kind/label` 归 controller，`queries.foreground` 与 `actions.cancelForeground()` 是唯一读/取消入口；UI 的 `historyAbort`/`historyLoading` 已删除并由架构守卫禁止回归；嵌套认领用 `AsyncLocalStorage` 精确判定；loop 发送排队由用例固定；表单 Start 与命令行走同一套 `authorize`。A1（前台槽位排队）、A2（`during*` 的 `queue`）、A3（`state.lastFailure`）、A5（`/loop answer`、`/loop abort`、PAUSED）均已完成；D15（`dsht trace`）另见 §7.4 |
| **P5** ◐ | 只读输出源（§7.5）：`OutputSource` 注册表、`SessionPeek` 跟随、整屏 peek 视图、`peek begin/end`；随后点击 transcript 行打开指定源 | **机制 + 面板 ✅**（`src/session/peek.ts`、`Controller.outputSources()/openPeek/closePeek`、`src/ui/dialogs/peek.tsx`；用例见 §11）。**未做**：屏幕行坐标图与 SGR 左键命中测试，让"点某一行"打开那一条源 |

**每期先写不变量测试，再改实现**——否则"目标态"只会成为下一次事故的来源。

### 13.2 已拍板的决策（不再讨论）

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | foreground 期间 composer | **保持可编辑；Enter 拒绝提交并保留 draft；完成时绝不自动发送** | 核心场景是远程 SSH/手机控制：长 operation 期间用户完全可以把下一句先写好；失焦会明显变差。自动发送则等于替用户提交，违背其只编辑的意图。**已实现**：composer 的 `focus` 不再看 `busy`；被拒的行保留草稿（`whileBusy: 'run'` 的命令除外，见 §3.4）；一条命令结束时**只清掉它提交的那一行**——如果操作期间用户已经改了草稿，那是他的内容，不是这条结果的。
**【补充·不是例外】**：D1 禁止的是"把**被拒的草稿**在操作结束后自动发出去"。操作者按下 Enter、策略因 turn/loop 而 `queue` 的那一行不是草稿：它已经提交，前端在入队时就用掉了草稿，等到事实清零再执行——这是执行操作者的 Enter，而不是替他提交一段文本。 |
| D2 | 错误/提示 owner | **业务失败事实归 `CommandResult.outcome` + trace；UI 只拥有展示生命周期**；`state.operation.error` 最终删除或降级为内部 `lastFailure` | 否则会出现三套"用户可见错误事实"，必然互相矛盾。**已完成**：结果 + trace 同源；命令自行报告失败后不再留第二份（`clearFailure()`）；`state.operation` 这个信封整体删除——失败只剩 `state.lastFailure` 一条内部记录（连接、会话流、动作信封写它），"是否有操作在跑"不再有第二个布尔，唯一事实是 `queries.foreground`（`ControllerStore.busy()` 供领域层读取） |
| D3 | `/loop stop` 后显示 | **保留 terminal progress，直到下一次 loop 或显式清除** | 终态是最需要被看到的结果；配合 §8.3.1，只有 `active` 参与并发判断，终态残留不会污染授权 |
| D4 | `needs-human` | **已升级为 PAUSED**（`/loop answer` 落地后）：判断者弃权 = 暂停 + 可回答；验证进程/host 要人仍按终态（`terminalReason` 存在） | 暂停态必须真的能恢复，否则标成 PAUSED 只是暗示一个不存在的路径 |
| D5 | 只读输出源与 peek 视图（§7.5） | **源由 client 登记**（host 侧血缘另改上层仓库）；**与内联 `!` 块共存**（视图是展开，不是替换）；**点击粒度是 transcript 行**；**不做源切换 UI**；**整屏只读视图**，`Esc` 返回 | 多份"别人在说话"的输出必须能只读地看而不接管；点行是唯一"我知道我点的是哪一条"的入口，另做切换器等于在视图里再造一个选择器；整屏是读长输出的形态 |

### 13.3 实现后必须能回答的问题（验收口径）

```
1. 同 session 的两个 mutation，谁先 dispatch？（`mutation` trace 的行序 + `lane`/`waited`；控制泳道抢先）
2. 长 compact 期间 Ctrl+C，cancel 是否立即 dispatch？（是：取消走前台槽位的 abort，不等 compact 回包）
3. 终态 loop 残留时，/ws 是否仍被 duringLoop deny？（否：`during` 只看 `loop.active`，残留进度行不参与）
4. loop 因有待答 send-rejected 时，phase 与 terminalReason 是什么？（needs-human / send-rejected）
5. 命令失败时，用户看到的事实与 trace 是否同源？（是：`CommandResult.outcome` + 同文本 `error` effect + `command end` 的 `outcome`/`disposition`/`error`）
6. path 屏幕的文本是否会让 normalize 读到 screen？（否：Submission.path）
```
