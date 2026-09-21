# dsht verify loop 设计文档（评审稿）

> 状态（单一事实源）：**核心验证链路已实现**——verifier 由 dsht fork 出的独立进程承担（自己的 session、自己的上下文），verdict 由 child 从自己的回复解析、原子落盘到客户端路径并被父进程读回。文档记录了**部分** live 验证结果（§8 为现行机制的现场，§11 保留已被取代的现场）。**尚未闭环**：完成判定仍不绑定 host 的 turn 标识（G3 的**最小绑定**已实现）、产出物只读（G4 一期只能检测与作废，阻止修改需要 OS 级隔离）、验证者提前停下的**一期已实现而二期语义未落地**（G6：`cannot-fix`／`needs-human` 与硬校验已实现，`abstained` 只是终态、`code` 枚举与暂停/恢复待二期）、人工介入的**恢复路径**（G10 二期：`/loop answer`）、run 预算的重试**细分**分类（G8 主体已实现）、程序化验收组合的 host 侧检查（G11 二期）、发布入口（`dist/cli/index.js`）与本机之外的部署验证。**已实现**：验证任务的唯一身份（G1）、取消/超时边界（G2）、完成的最小绑定（G3）、运行中人工请求的检测/取消/报告（G10 一期）、验证者提前停下的一期语义（G6）、`passed` 的范围可见与整份记录的收尾复核（G5）、显式被评审 workspace + 产出物变化作废 + 验证期间不写入（G4 一期）、产出物形态硬条件纳入验收（G11 一期）、run 总截止时间与不可重试分类（G8）、命令面收敛为单一 `/loop <name>` 且协议/标准/`vars`/默认值都在 `loop.yaml`（G7）、run 内协议快照（G9）。逐步状态与证据范围见 §9。
> 目标（主路径已实现）：每一轮由 dsht **fork 出的独立进程**打分，verdict 通过**文件**回传，而不是由被评审 session 自己 spawn 子代理自评。

**读者**：改动 `tui/` 验证循环（`/loop <name>` 及其 `loop.yaml` 记录、verdict 通道与 fork 出的 verifier 进程）的维护者与评审者。命令面已经是单一 `/loop <name>`（§4.6）；只想使用这些命令的人看 `README.md`。

**本文记录**：为什么改（§1）、机制与依赖规则（§2–§3）、接口与 verdict 文件契约（§4）、受影响的模块（§5）、失败语义、闭环语义与取消（§6–§7）、测试覆盖（§8）、未完成项、系统不变量的最初问题与闭环进展、待决策（§9）、机制本身的能力边界（§10）。

**本文不记录**：面向使用者的命令用法与选项（`README.md`；本路径新增的内部开关与环境变量例外，见 §4.5、§6、§9）；`tui/` 整体架构与分层（`tui-design.md`；其中 §3.4 的循环协议一段仍描述旧的 subagent 路径）；贡献政策与提交／版本／发布／验证流程（父仓库 `CONTRIBUTING.md` 只声明贡献政策——当前不受理外部 PR；流程的事实源是 `tui-design.md` §7.4–§7.5、§7.7；文档集的登记与权威规则见其 §7.3，`tui/` 无独立 `CONTRIBUTING.md`）；计费（`cost.md`）；宿主协议字段的规范定义（父仓库 `docs/event-producer-consumer.md` 的事件索引与 `packages/api/session-controller/src/types.ts` 的字段类型；本文只记消费面）。

**单一事实源**：本文是这条验证路径（fork 验证 loop）具体机制的事实源；与 `README.md`、`tui-design.md` 就本路径的描述冲突时以本文为准——`tui-design.md` §7.3 已登记本文并声明本路径的机制以本文为准（原先的互认缺口已由对方文档补齐，见 §9）；其 §3.4 的循环协议一段仍是旧路径。「本文不记录」让出的范围（`tui/` 架构与分层、贡献与发布流程、计费、宿主协议字段的规范定义）仍以各自文档为准，不因本行覆盖；接口签名以 `src/` 为准。**本文不是规范**：它是设计记录，§9 未定项在定稿前可变。

---

## 目录

| 想知道什么 | 看 |
| --- | --- |
| 为什么要 fork 验证（已修的真实故障） | §1 |
| 机制全貌与依赖方向 | §2 |
| 一轮的完整时序（含取消/替换） | §3 |
| 接口、port 与 verdict 文件契约 | §4.1–§4.4 |
| CLI 参数与子进程构造 | §4.5 |
| 命令面（单一 `/loop <name>` 与记录） | §4.6 |
| 改了哪些模块 | §5 |
| 出错时会怎样 | §6 |
| 验证意见怎么回灌、何时早停、各终止状态 | §6.1 |
| 状态归谁、怎么取消、子进程凭据 | §7 |
| 测试到什么程度 | §8 |
| 还没做什么、哪些决策悬而未决、系统不变量的最初问题与闭环进展 | §9 |
| 待补契约与建议的实现顺序 | §9「待补契约」 |
| 机制本身不能保证什么 | §10 |
| 已被取代的机制与旧现场记录 | §11 |

---

## 1. 为什么改：真实故障

这一节的每条都有 live 运行证据，是本次设计的动因，也是评审时要保护的既有行为。

| # | 现象 | 根因 | 现状 |
|---|---|---|---|
| 1 | live 评审 `best 0/8`、`Loop exhausted`，但 session 里明明有合法的 ` ```dsht-loop ` 块 | host 的 `jobs` 控制帧字段名是 `jobs`，客户端读 `frame.items` → `array(undefined)` 抛 `Expected an array from the server` | 已修：读 `frame.jobs ?? frame.items`（`events.ts`） |
| 2 | 连接被杀后 client 进入重连风暴，loop 仍显示 running 却再也看不到转录 | `connection.ts` 把「一帧 live metrics 解析失败」当作**整个 generation 失败** | 已修：坏的控制帧降级为 `controlError`，不再断连 |
| 3 | 重连后 session 被 picker 顶掉，loop「活着但瞎了」 | `ready()` 只在 `screen === 'chat'` 时重新选回 session；`adoptLocalWorkspace()` 会清空选择 | 已修：`ready()` 用 `loop.sessionId` 兜底重挂 |
| 3b | **forked 子进程**启动即卡死：`screen=workspaces, session 已选, snapshot 已就绪`，等 180s 后超时 | `ready()` 在 `showPicker()` **之前**就发布 `online`；自动化调用（`runStartup`）看到 `online` 就开始 `selectSession`，随后 picker 的 update 把 `screen` 覆写回 `workspaces`，而 `sessionId`/`snapshot` 仍是上一次选择的 | 已修：新增 `queries.connectionSettled`（`begin()` 置 false，`ready()` 末尾置 true），自动化等它而不是只等 `online` |
| 4 | 偶尔凭空消耗一次 attempt | grace 定时器已触发但回调晚到，settle 掉了**下一个** attempt | 已修：只允许「确实结束的那一轮」被消费（`loopEndedAt` 门禁） |

另有一条架构动因：本仓此前那条 in-host subagent 路径里，打分者与产出物在**同一进程、同一 session**，verdict 只能由被评审者自己复述（自我报告）。注意这是**旧实现的具体情况，不是 subagent 的普遍性质**——用独立上下文的 subagent 并不必然如此；本文要解决的是当时那条路径的独立性与可审计性。

---

## 2. 架构总览

```
                       ┌─────────────────────────── parent dsht ───────────────────────────┐
                       │                                                                    │
  slash /loop <name> ──────▶ commands.runCommand ──▶ Controller.startLoop(protocol, limits) │
                       │                                      │                             │
                       │                            ScoredLoop（纯状态机，无 I/O）            │
                       │                                      │                             │
                       │   session/prompt ◀── flushLoop ──────┘                             │
                       │        │                                                           │
   host ◀──────────────┘        │ agent-status running:false                             │
                                ▼                                                        │
                        Controller.trySettleLoop()                                       │
                                │                                                        │
              verifier 已配置? ─┤ 否 ─▶ parseLoopResult(回复正文最后一块) ─▶ settleWith     │
                                │ 是                                                        │
                                ▼                                                        │
                     Controller.verifyRound()  ──▶ VerifierPort.verify(request, signal)   │
                                │                                    │                    │
                                │                          ProcessVerifier（cli）          │
                                │                                    │                    │
                                │              session/create + session/rename            │
                                │              shell.runProcess(node, argv)  ── fork ──▶ child dsht
                                │                                    │                    │
                                │              storage.readText(verdict 文件) ◀── 文件 ────┘
                                │                                    │
                                └──── verdict 文件 / unavailable ────┘
                                                │
                                          ScoredLoop.settle(result)
```

### 依赖规则（`tests/architecture/dependencies.test.ts` 强制）

* `child_process` **只能**出现在 `src/shell/`。→ fork 能力落在 `shell/runner.ts` 的 `runProcess()`。
* `fs` **只能**出现在 `src/storage/`。→ verdict 文件的读/删走 `storage`（`readText`/`removeFile`/`ensureDirectory`）。
* 特性之间不得互相 import；`controller/` 可以 import `session/`、`shell/`、`storage/`、`contracts.ts`。
* `cli/` 是组合根，可以 import 上述全部。→ `ProcessVerifier`（进程 + 存储 + 连接能力）放在 `src/cli/verifier.ts`。
* loop 只依赖 **port 类型**（`controller/verifier.ts`），不知道子进程、文件、session 的存在。

---

## 3. 一轮完整事件流

```
 1. parent: ScoredLoop.start() → protocol.brief()            （forked 模式下用 resultContract(..., 'forked')）
 2. parent: session/prompt  ──▶ host
 3. host:  agent 干活（读产出物、改文件、跑命令），subagent 被明确禁止
 4. host:  api-session/status(<本 session>, running=false)   （其他 session/子代理的 idle 被 sessionId 过滤掉）
 5. parent: Controller.settleLoop() → trySettleLoop()
            ↳ loop.protocol.verify 存在且 verifier 存在 → verifyRound()
 6. parent: seq = ++loopVerifySeq   ← 本次验证任务的序号；一次故障重试或人工恢复都是一次新任务
            file = verdictFile(verdictRoot, runId, kind, step, attempt, seq)
            = <verdictRoot>/.dsht/verify/<runId>/<kind>-<step>-<attempt>-<seq>.json   （CLI 把 verdictRoot 设为客户端进程 cwd，`DSHT_VERDICT_ROOT` 可改指）
 7. parent: VerifierPort.verify({verificationId,kind,step,attempt,prompt,title,file,workspace,artifact?}, signal)
            ↳ workspace = Controller.localDirectory：被评审 workspace 由调用方显式声明（G4），不靠验证进程的 cwd 推断
 8.   ProcessVerifier:
      a. signal 已 abort → 直接 cancelled（不建 session、不 spawn、不写文件）
      b. ensureDirectory(<verdictRoot>/.dsht/verify/<runId>) + removeFile(file)  ← 先删除，杜绝陈旧文件被读成本轮结论
      b2. artifact 存在 → SHA-256(join(workspace, artifact))            ← 变化即在读回 verdict 后作废本轮结论（G4）
      c. Actions.createVerifierSession('[dsht-verify] …')      ← session/create + session/rename（不切换父视图）
         ↳ 创建期间被取消/超时 → 取消刚创建的 session，直接返回，**不 spawn**
      d. runProcess(node, [...execArgv, entry, --url … --session <id> --prompt <brief> --verdict <file> --verdict-identity <id> --wait --headless --no-memory-log])
 9. child dsht: 选中该 session → 发送 prompt → --wait 等到本 session 的回合结束 → 自动退出
10. child 内的 agent: 读产出物、自己取证，把 verdict JSON 放在回复正文最后一块（§4.3）
11. child CLI: 等到**本 prompt 之后**有 assistant 回复 → parseVerdict → 原子写 file（先写 `.part` 再 rename）
12. parent: 子进程退出 → storage.readText(file) → parseVerdict(text, {verificationId,kind,step,attempt})
13. parent: verified → 用文件里的 verdict；unavailable → 重试 verifier（≤ VERIFIER_RETRIES=2，同一 attempt、新 seq，**不消耗评审次数**）；
    cancelled → 不判决。严格模式（CLI 默认）不回退父回复：重试用尽即 loop.unavailable()；只有显式传
    ControllerOptions.allowSelfFallback 时才用父回复块，并在进度行标 ⚠ verification fallback · self-reported。
14. parent: ScoredLoop.settle(result) → continue（发 followUp）/ passed / exhausted / stalled / blocked / unavailable
15. parent: loop.note(说明) → UI 进度行追加显示；下一次 sent() 时清空
```

取消/替换路径：`stopLoop()` / `forgetLoop()`（含切换 session）→ `abortVerification()` → `ProcessVerifier` 向 host 请求 `session/cancel(<verifierSessionId>)`，**最多等 `CANCEL_CONFIRM_MS`（1s）**确认，然后/同时终止本地子进程组（`SIGTERM`→2s→`SIGKILL`）；确认结果只影响 reason 文案（`remote cancel confirmed | rejected | unconfirmed after 1000 ms`），**本地回收从不等待 host**。验证回调返回时有两道门：`this.loopVerifyIdentity !== identity`（本次任务是否仍是被等待的那一个）与 `this.loop !== loop || !loop.active || !loop.settled`（loop 是否还在）。

**已收口的缺口（原 G1/G2/G3 的本地部分）**：重试与人工恢复各自换新 `seq`，因此旧任务既不能覆盖新文件、也不会被父进程接受（G1）；创建期取消会取消刚建立的 session 且不再 spawn，超时的任务即使写下了合法 verdict 也判 `unavailable`，`session/cancel` 变为有界确认（G2）；child 只接受 **prompt 基线之后出现的 assistant 回复**（G3 的最小绑定；仍未绑定 host 的 turn 标识）。

---

## 4. 接口（摘录：只列调用面与契约，完整签名以 `src/` 为准）

### 4.1 loop 侧（`src/controller/loop.ts`）

```ts
export interface LoopProtocol {
  marker: string; kind: string; title: string; steps: number;
  stepLabel?(step: number): string;
  brief(limits: LoopLimits, step: number, attempt: number): string;
  followUp(limits: LoopLimits, step: number, attempt: number): string;
  /** 新增：把本轮 verdict 交给外部验证进程；返回该 session 收到的 prompt。 */
  verify?(limits: LoopLimits, step: number, attempt: number, file: string): string;
}

/** 新增：回复块与 verdict 文件共用同一套字段校验。 */
export function readResultFields(parsed: object): LoopResult;

export class ScoredLoop {
  note(text: string): void;   // 新增：一行说明，写进 progress.note，直到下次 sent() 清空
}
```

### 4.2 验证能力（`src/controller/verifier.ts`）

```ts
export interface VerifierRequest {
  verificationId: string; // '<runId>/<kind>/<step>/<attempt>/<seq>'，verdict 必须回述
  kind: string; step: number; attempt: number;
  prompt: string;      // 协议给出的验证 prompt（含评分标准）
  title: string;       // '[dsht-verify] <title> · <step>/<attempt>'
  file: string;        // verdict 绝对路径
}
export type VerifierOutcome =
  | { type: 'verified'; result: LoopResult; sessionId: string }   // 有独立 verdict，可判决本轮
  | { type: 'unavailable'; reason: string; sessionId?: string }   // 无 session/子进程/verdict 或超时
  | { type: 'cancelled' };                                        // 评审被取消，无可判决
export interface VerifierPort {
  verify(request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome>;
}
export function verdictDirectory(directory: string, runId: string): string;   // <dir>/.dsht/verify/<runId>
export function verdictFile(directory: string, runId: string, kind: string, step: number, attempt: number, seq: number): string;
```

### 4.3 文件契约（`src/controller/loop-contract.ts`）

```ts
export function resultContract(kind, limits, step, attempt, brief?, mode: 'subagent'|'forked' = 'subagent'): string[];
export function verdictBrief(brief: VerdictBrief): string;   // 子 session 收到的完整 prompt
export function parseVerdict(text: string, expect: {verificationId,kind,step,attempt}): LoopResult | undefined;
```

* `mode: 'forked'` 时：主 brief 明确「独立进程打分、不要 spawn 子代理替你评分」，并**仍要求结尾给出 ` ```dsht-loop ` 块**（`resultContract` 第 4 条）。注意实际默认行为与该措辞不一致：CLI 不传 `allowSelfFallback`，父进程在严格模式下**不使用**这个块——verifier 不可用即结束；只有显式打开 `allowSelfFallback` 时才回退并标注。这条一致性是本路径第 1 个待修项（§9）。
* `verdictBrief` 明确四件事：你没有本对话上下文；不许改产出物；**verdict 由客户端从你回复正文的 JSON 落盘**，并给出唯一允许的 JSON 形状；**本次 run 的记录变量原样带上**（`path=loop.md`），并要求产出物属于这组变量所指的同一个对象。最后一条是实测补的：verifier 的唯一输入是这段 prompt 与磁盘上的产出物，少了变量它只能从产出物猜评审对象——一次真实 run 里 `/loop designdoc-review` 把 `path` 改成 `loop.md`，标题与工作 brief 都对，但 verifier 看到的是上一轮为 `tui-design.md` 写的小节，于是连着两次都在评审 `tui-design.md`，还给了 8.4/9 分。**已补**：`designdoc-review` 的 `artifact` 现在也是模板——`{{path}}.review.md`，即**一份被评审文档一个文件、落在文档旁边**（默认 `tui-design.md.review.md`，换成 `loop.md` 就是 `loop.md.review.md`）。`artifact` 从"记录常量"变成"用 vars 渲染一次"的模板（`loop-prompts.ts`），schema 只允许它用记录的 vars、禁止 runtime 占位符（文件名不能随轮次移动）；`*.review.md` 进了 `.gitignore`。`artifactMarker` 是 `## 第 {{step}} 轮 · {{title}} · {{path}}`，brief/followUp 里那两处写小节也点明同一个标题，同一份标题再随 `VerdictBrief.marker` 交给 verifier——「本轮小节是哪一节」在两侧只有一个答案（`text.artifactMarker(step)` 与客户端检查用的是同一个值），标题里的文档名则让每个小节单独拿出来也自解释。
* `parseVerdict` 把回复当**不可信输入**：枚举正文里每个顶层平衡 JSON 对象（最近的优先），先校验 `verificationId` 必须与本轮一致，再校验 `kind/step/attempt`，否则视为无 verdict（防陈旧文件误判）。枚举**从 `{"` 开始**、并按字符串状态跳过引号内的花括号（`evidence` 引用记录时会带 `{{step}}` 之类的占位符）；`JSON.parse` 失败时**只把 JSON 未定义的转义补齐**再试一次——真实 run 里一份 `score 8.4 · done` 的完整 verdict 因为 `evidence` 写了一个没转义的正则 `\d+\.\d+` 整份被丢弃，白花一次 attempt。身份校验不放松，因此补转义不可能放进别轮的 verdict。

verdict 文件形状：

```json
{"verificationId":"<runId>/designdoc-review/2/1/1","kind":"designdoc-review","step":2,"attempt":1,"score":7.5,"status":"retry",
 "evidence":"跑过 npm test（3 处失败）…","top_findings":["…"]}
```

### 4.4 进程与存储（`src/shell/`、`src/storage/`）

```ts
// shell/runner.ts —— argv 形式，无 shell，参数原样传给子进程
export function runProcess(file: string, args: readonly string[], options: ShellRunOptions): Promise<ShellExit>;
// storage：沿用 readText / removeFile / ensureDirectory
```

### 4.5 CLI

| 位置 | 新增 | 说明 |
|---|---|---|
| `--prompt <text>` | 发送一条普通 prompt（`--command` 只接受 slash 行） | 供子进程使用，人也可用 |
| `--wait` | headless 下等这条 prompt 的回合结束再退出 | **子进程自动退出的实现** |
| `--verdict <path>` / `--verdict-identity <id>` | 子进程交付 verdict 的通道：等**本 prompt 之后**的 assistant 回复、解析正文最后一块、**原子写**到该路径；identity 即 `<runId>/<kind>/<step>/<attempt>/<seq>`，写入前必须与本轮一致（`seq` 让同一 attempt 的重试各自独立） | 模型只在回复里给 JSON，协议文件由 child CLI 写（`src/cli/startup.ts` 的 `writeVerdict`，解析不到时留空并记日志）；`--verdict` 缺 identity 直接拒绝（`src/cli/dsht.tsx`） |
| `DSHT_VERDICT_ROOT` | 改写 verdict 根目录（默认客户端进程 cwd） | 本路径新增的内部环境变量；被评审 workspace 在本机不可写时改指别处，落点见 §9 决策 B |
| `--deadline <minutes>` / `DSHT_LOOP_DEADLINE` | 整个 run 的预算 | 到期 → 终态 `deadline`：停止状态机、取消在飞验证、不消耗 attempt、不自动重试；非正数直接拒绝启动 |
| `queries.turnsCompleted` | 已结束回合的单调计数 | `--wait` 用它而不是轮询 `running`，否则短回合会被漏掉 |
| `Actions.createVerifierSession(title)` | `session/create` + `session/rename`，**不切换**父视图 | 命名即标记（host 不支持创建时命名，也无 subagent 命名能力） |

`session/rename` 已 live 验证：`{"title":"…","seq":3}`，标题出现在 session 列表的 `projections.values.title`。

### 4.6 命令面（**已实现**：单一 `/loop <name>`）

> 一条命令如何被解析、判定、执行、写事件，是所有 slash 命令共用的规则，见 **`slash.md`**。
> 本节只记录 `/loop` 自己的语法与记录装配。

```
/loop <name> [score] [tries] [--from N] [--to N] [--score X] [--tries N]
```

| 参数 | 含义 |
|---|---|
| `name` | `loop.yaml` 的 `protocols:` 键；未知名字报错并列出可用记录（当前 `design-review`、`designdoc-review`） |
| `score` / `tries` | 可位置传参也可用旗标；省略时用记录的 `defaults`，记录没有才落到全局 `defaults` |
| `--from` / `--to` | 本次运行的轮次区间覆盖，语义不变 |

**记录的 `vars`（如 `designdoc-review` 的 `path`）是本次运行的输入，不是记录的常量**：它在参数表单里逐行覆盖（见下），命令行没有对应语法——知道有哪些变量名的是记录，不是 `parse.ts`，所以语法层不为它造旗标。表单把覆盖值经 `LoopOptions.vars` 交回应用，`runCommand` 用记录的 `vars` 校验名字（未知名字报错并列出该记录接受的变量），再交给 `loopProtocolFor(name, forked, vars)`；标题、brief、followUp 与验证者提示里所有 `{{path}}` 都换成新值，`loop.yaml` 本身不动。

命令语法不变，但交互路径是"选"而不是"敲"（**已实现**）：

1. 草稿是 `/loop` 或 `/loop <前缀>` 时，输入框下方列出记录（名字 · 标题 · 轮数 · 默认及格线/尝试数 · 产出物 · 它指向的 `vars`）：↑/↓ 选择，Tab 把名字补进草稿（便于继续加旗标），Enter 确认高亮记录。Esc 只隐藏列表、不撤销选择——下一次 Enter 仍按当前候选确认，因为 `/loop` 单独出现没有别的含义。
2. 确认后打开参数表单：**先是该记录自己的 `vars`（每个名字一行，自由文本）**，**再是 `From`／`To`／`Pass`／`Tries`**（数字，与命令行共用 `validLoopOption` 校验）；选中某行后直接输入即覆盖，改过的行标 `· default <原值>`。**离开一行（方向键或 Enter）即提交该行内容**，所以不需要每个输入框各按一次回车；取值不合法（越界、反向区间、变量为空）时光标留在该行并给出原因，不会被静默丢弃。`Start run` 才开始，`← Choose another record` 回到记录列表。未按 Start 前不发送任何 prompt，因此每个默认值都在被花掉之前可见，改 `path` 就把这次审查指向另一份文档而不影响记录本身。
3. 命令行写了任一旗标（`/loop design-review 9 3`、`--from`…）即视为已经决定，跳过表单直接运行。**headless／脚本不变**：`runCommand` 只在调用方通过 `CommandPort.interactive` 声明"能显示面板并等人操作"时才返回表单结果（effect `{kind:'loop'}`），`cli/startup.ts` 的 port 不声明该字段，所以 `--command "/loop design-review"` 仍按记录默认值直接开跑；UI 则由 `ui/app.tsx` 声明。`/loop` 单独出现在无交互调用方时返回「Use /loop <name> · available: …」的报错。

命令名确定并跟一个空格后，输入框下方还会显示该命令的 usage 与说明（`slash/registry.ts` 的 `argumentHint`，数据来自 `COMMAND_HINTS`）；`/loop` 的记录列表比这条通用提示更具体，因此两者不叠加。

**可定位性（诊断日志）**：`/loop` 的每一步决策都写进默认开启的状态迁移日志（`<state>/trace.log`；`--trace`／`DSHT_TRACE` 改路径，`--no-trace` 关闭）：

| 事件 | phase | 含义 |
|---|---|---|
| `loop-ui` | `choose` / `open` / `start` | 记录列表选中的候选与下标、表单是否真的打开（`known`）、Start 时提交的四个值与变量名 |
| `loop` | `command` / `form` / `rejected` | 应用收到命令、返回表单意图、因未知记录或未知变量被拒（带 `reason`） |
| `loop` | `begin` / `verify-first` / `sent` | `startLoop` 拿到的 session、limits 与是否 forked；已发出 brief；或已转入先行验证 |
| `loop` | `refused` / `failed` / `not-started` | 没有 session、发送失败（带 `reason`），以及 `startLoop` 未成功时给操作者看到的原因 |
| `verify` | `begin` / `verified` / `retry` / `unavailable` / `fallback` / `needs-human` / `cancelled` / `stale` / `abandoned` | 每轮验证任务的生命周期；`verified` 带分数，`retry`／`unavailable` 带结构化 `reason`（退出码 + `stderrClass`：`auth`/`host`/`config`/`unknown`），子进程原话只在 `--trace-verbose` 下出现且先过 `sanitizeTraceText()`——交互式客户端不显示子进程输出，所以这一行是"为什么没有 verdict"的唯一线索 |
| `artifact` | `missing` | 验证者给了分但工作区产出物缺少本轮小节，该轮被客户端硬判不通过 |

`verify-first` 记录（`starts: verify` + 已配置 verifier + forked）意味着**主会话不会发出任何 turn**：父进程把这一轮交给独立子进程，因此当前 history 不会有输出，这是设计而非卡住。为避免误判，验证进行期间进度行显示 `verifying step N · attempt M`，状态栏也把它当作"忙"（`◐ <时钟> · review N/M · ^C`，取代 `● Ready`）；验证结束后按结果替换为分数／警告，或在耗尽重试后显示 `⚠ verification unavailable · <原因>`。状态栏的"忙"由宿主 turn 或 loop 决定（`StatusSource.loop`），loop 的时间来自 `LoopProgress.startedAt`。

因此"按了 Start 没反应"不再无声：日志能指出是没选中记录、表单没打开、命令被拒、没有 session，还是发送失败。事件只记录名字、阶段与 limits，不含 prompt 正文。

记录列表与运行共用同一份记录：`queries.loopRecords()` 与 `loopProtocolFor()` 都读 `loop-prompts.ts`，所以列表不会显示运行时不用的默认值；表单值与命令行旗标最终都由 `resolveLoop` 落成同一个 `LoopLimits`，`vars` 则由 `find(name, overrides)` 在渲染时合入（默认渲染按记录缓存，只有覆盖时才重渲染）。`LoopLimits` 放在 `contracts.ts`，因为 UI 叶子只能读契约、不能 import controller。

记录承载协议专属的一切，模板据此渲染：

| 记录字段 | 用途 |
|---|---|
| `title` / `brief` / `followUp` / `rounds` | 进度标题、目标、续跑文案、每轮 rubric；标题与模板可用记录自己的 `vars` |
| `starts` | `verify` = 每轮先验证现有产出物、通过就不花工作 turn；`work` = 先要一次工作（**默认**，不声明即保持原行为）。两条内置记录都是 `verify` |
| `standard` | **取代 `/verify`**：在每轮 rubric 之上叠加的附加要求；不再是会话状态 |
| `artifact` / `fallbackLabel` / `verifyFocus` | 被评审的工作区文件、范围外步骤的标签、验证者提示里的本轮焦点 |
| `vars` | 记录输入的**默认值**（如 `path: tui-design.md`），与运行时的 `step`／`attempt`／`score`／`tries`／`title` 一起填充占位符；相对被评审 workspace 解析。一次运行可用表单覆盖（`/loop` 表单里每个名字一行），记录本身不变 |
| `defaults` | 本记录的 `score`／`tries`，覆盖全局默认值 |

装配只有一处：`controller/loop-protocols.ts` 的 `loopProtocolFor(name, forked, vars)` 把记录（合入本次运行的 `vars`）变成 `LoopProtocol`，`/loop` 只是按名字取用。因此**新增一个审查协议 = 往 `loop.yaml` 加一条记录 + `npm run build:prompts`**，不需要新的命令、slash 语法或 UI 分支；记录声明了 `vars`，参数表单就自动多出可编辑行。

已删除（迁移对照）：

| 旧 | 现在 |
|---|---|
| `/design-review [flags]` | `/loop design-review [score] [tries] [flags]` |
| `/designdoc-review <path> [flags]` | `/loop designdoc-review …`；路径是该记录的 `vars.path`，在 `/loop` 参数表单里逐次覆盖（不再有命令行位置参数） |
| `/verify <criteria\|off>` | 记录的 `standard:`；会话级标准状态与命令一并删除 |
| `/loop <score> <tries> <prompt>` | 删除：loop 只执行记录。一次性目标写成一条记录，目标放进它的 `brief` |

`answer`、`abort` 与 `stop` 是保留给 `/loop` 子命令的名字，schema 拒绝同名记录（`stop` 已实现，见 §7 取消触发）；模板里出现未知占位符会在**发送 prompt 之前**报错（`loop-prompts.ts` 的渲染器），不会把 `{{name}}` 原样发给模型。子进程侧参数（`--wait`、`--verdict`、`--verdict-identity`、`DSHT_NO_VERIFY`、`DSHT_VERDICT_ROOT`，§4.5）与命令面无关，不受影响。
---

## 5. 模块改动清单

§5 的模块清单以「这条验证路径改了什么」为准，不随提交状态变化；**状态**：fork 验证的 `src/` 批次已作为 `6f67f87` 提交（写作时锚点 `b7c0230` 之前的历史见 §11），此后 prompt 文本外置到 `loop.yaml`（`src/controller/loop-prompts*.ts`，生成物提交进仓库），这些与本文本身的改动**尚未 commit**。

| 文件 | 改动 | 层次约束 |
|---|---|---|
| `src/transport/events.ts` | `jobs` 帧读 `frame.jobs ?? frame.items` | transport |
| `src/controller/connection.ts` | 控制帧解析失败 → 降级 `controlError`，不断连 | controller |
| `src/controller/controller.ts` | `ready()` 用 `loop.sessionId` 重挂；`turnsCompleted`；`verifier` 选项；`verifyRound`/`settleWith`/`abortVerification`；`queries.forkedVerification`、`queries.loopRecords`；`Actions.createVerifierSession`；`startLoop` 的 `loop` 迁移事件（`begin`/`verify-first`/`sent`/`refused`/`failed`）、`verifyRound` 的 `verify` 生命周期事件与 `artifact` 事件、公开的 `traceNote`（组合根记录 UI 决策），以及验证期间的 `verifying step N · attempt M` 进度注记 | controller |
| `src/controller/loop.ts` | `LoopProtocol.verify?`；`readResultFields`；`ScoredLoop.note()`；`ScoredLoop.startedAt`（`LoopProgress.startedAt`，供状态栏计时） | controller |
| `src/controller/loop-contract.ts` | `resultContract(..., mode)`；`verdictBrief`；`parseVerdict` | controller |
| `src/controller/verifier.ts` | **新增** port + verdict 路径 | controller |
| `src/controller/loop-protocols.ts` | **新增**：把 `loop.yaml` 记录装配成 `LoopProtocol`；`loopRecords()` 供记录列表读取同一份名字/默认值/产出物/`vars`；`loopRecordVars(name)` 供校验变量名；`loopProtocolFor(name, forked, vars)` 合入本次运行的覆盖；`design-review.ts` / `designdoc-review.ts` / `loop-prompt.ts` 已删除 | controller |
| `src/controller/loop-prompts.ts` | `find(name, overrides)` 把覆盖合进 `vars` 后再渲染（默认渲染按记录缓存，只有覆盖时重渲染）；`vars(name)` 暴露记录声明的名字与默认值；`LoopPromptText.vars` | controller |
| `src/controller/commands.ts` | 两个 review 命令传 `queries.forkedVerification`；`CommandPort.interactive` 让 `/loop <name>` 在可交互调用方返回表单意图、在脚本调用方直接运行；`loops` 命令列出可用记录；用 `loopRecordVars` 校验本次运行的变量名，未知变量报错并列出该记录接受的变量；`loop` 迁移事件（`command`/`form`/`rejected`/`not-started`），`startLoop` 失败时返回可读的 `error` 而不是静默 `undefined` | controller |
| `src/controller/index.ts` | 导出 `designdocReviewProtocol` 等 | controller |
| `src/slash/parse.ts` | `/loop <name> [score] [tries] [flags]` 语法；`/loop` 单独出现 → `loops` 命令；`LoopOptions.vars` 承载表单确认的记录变量（命令行无语法）；导出 `loopNameQuery`（记录名菜单）与 `validLoopOption`（表单与命令行共用校验）；`designReview`/`designdocReview`/`verify` 三个命令已删除 | slash |
| `src/slash/registry.ts` / `index.ts` | 命令表与导出各加一行；`/loop` usage 改为 `[name] [score] [tries]`，`COMMAND_POLICY.loops`；`argumentHint(line)` 给出「命令名 + 空格」后的用法提示 | slash |
| `src/ui/dialogs/loop.tsx` | **新增**：`LoopMenu`（输入框下方的记录列表，含记录指向的 `vars`）与 `LoopDialog`（参数表单：记录变量在前、四个数字在后；**离开一行即提交**，不合法则留在该行并说明；返回 `LoopRun{limits, vars}`） | ui |
| `src/ui/app.tsx` | 记录菜单的键处理（↑/↓、Tab 补名、Esc 仅隐藏）、`loopForm` 面板、应用 effect `{kind:'loop'}`、通用用法提示行；`/loop` 的 UI 决策迁移事件（`loop-ui` `choose`/`open`/`start`）；Start 无结果时给出可见原因；`/loop <name>` 的"确认默认值"由应用决定而非根组件 | ui |
| `src/session/controller.ts` | `createNamedSession()`（创建+命名，不选中） | session |
| `src/shell/runner.ts` / `index.ts` | `runProcess()`（`runShell` 与它共用 `spawnLines`） | shell |
| `src/cli/verifier.ts` | **新增** `ProcessVerifier`（fork + 读文件 + 超时 + 取消）；子进程退出却没有 verdict（或 verdict 不可用）时，把子进程最后一行输出并入 `reason`，因为交互式客户端不显示子进程输出 | cli |
| `src/cli/startup.ts` | **新增** `plan.prompt` / `plan.wait` / `plan.verdict` / `waitForTurn` / `writeVerdict`（解析回复后原子写 verdict 文件） | cli |
| `src/cli/dsht.tsx` | `--prompt` / `--wait` / `--verdict` / `--verdict-identity` 解析；构造 `ProcessVerifier`（`DSHT_NO_VERIFY=1` 可关掉）；verdict 根设为客户端进程 cwd（`verdictRoot`，`DSHT_VERDICT_ROOT` 可改指） | cli |
| `src/contracts.ts` | `LoopProgress.note?`、`LoopProgress.startedAt`；`LoopRecord`（记录列表的行）、`LoopLimits`（表单与运行共用）、`ViewEffect` 的 `{kind:'loop'}`、`PanelName` 加 `loop` | types |
| `src/ui/chat/loop-status.tsx` | 进度行追加 note | ui |
| `src/ui/chat/status.tsx` | `StatusSource.loop`（loop 在工作但没有宿主 turn 时），`busy = running \|\| loop` 驱动状态词／时钟／阶段／`^C`，展开面板同源 | ui |
| `.gitignore` | 忽略 `.dsht/` | — |

---

## 6. 失败语义

**唯一判定规则**：`score` 是唯一判决依据；`blocked`（`cannot-fix`）是唯一能覆盖 `score` 的事实；`status` 只作解释，不决定状态。**三种预算不要混用**：每 step 的**评审次数** `tries`、每次验证的**故障重试** `VERIFIER_RETRIES`、整个 run 的**截止时间**（§9 设计 8）；`unavailable` 与 `cancelled` 不产生分数、也不消耗评审次数。

| 情况 | 行为 | 结果 |
|---|---|---|
| verdict 文件合法且身份匹配 | `parseVerdict` 通过 | 按 `score` 判决（`blocked` 覆盖） |
| 文件缺失（子进程超时/被杀/没写） | `unavailable` → 重试 verifier，≤ `VERIFIER_RETRIES`(2) 次，同一 attempt、**不消耗评审次数** | 重试用尽：默认（CLI 不传 `allowSelfFallback`）→ `loop.unavailable()`，**不通过**；仅显式打开 `allowSelfFallback` 时用父回复块并标 `⚠ verification fallback · self-reported` |
| 文件非法 / `verificationId`、`kind`、`step`、`attempt` 不匹配 | 视为无 verdict（`unavailable`） | 同上（**不会**用陈旧结论得分） |
| 创建验证 session 失败 | 不 spawn，`note` 说明 | `unavailable` → 重试 |
| 子进程非 0 退出但写了合法文件 | 以文件为准（**仅 DSH 适配器**：结果由 child CLI 在 turn 完成后原子写；其他 harness 默认按执行异常处理） | 正常判决 |
| 评审被取消 / 切 session | `abortVerification()`：向 host 请求 `session/cancel`（**有界确认 ≤1s**，不阻塞本地）+ 本地终止子进程组 | `cancelled`，结果丢弃不 settle；reason 记录 `confirmed/rejected/unconfirmed` |
| 验证慢 | `DSHT_VERIFY_TIMEOUT_MS`，默认 20 分钟（`src/cli/dsht.tsx`） | 超时 → 取消（有界）→ 若远端已确认停止则按故障重试；**未确认/被拒绝则不重试**，直接 `unavailable`（`retryable: false`）；此文件里的迟到 verdict 一律不采用 |
| 产出物在验证期间被改动 | 在**请求声明的 workspace** 上做 before/after SHA-256 指纹（`src/cli/verifier.ts`；文件对客户机不可读时不比较） | 不一致 → 本次结论作废：`unavailable`（reason 写明文件与前后哈希）→ 按故障重试重新验证；仍不能归因，也检测不到「改完又改回」 |
| 验证期间 host 要求审批／提问 | child 在自己 session 上看到未决交互 → 打 `dsht-verify-needs-human:{kind,text}` 标记退出；父进程取消该 turn（有界确认） | `needs-human`：终态、不消耗评审次数、不自动重试；headless exit 3 |
| verifier 提前停下（无法改／需要人介入） | ✅ 一期已实现，见 §9 设计 | `blocked`（+`reason`）→ 终态 `blocked`；`abstained`（+`reason`/`needs`）→ 终态 `needs-human`（headless exit 3）。硬校验不合格按「无判定」处理，不能借用提前停下。**注意：没有**「当前 step 高分就跳过剩余 step」的路径 |

不变量：**任何路径都不会用「上一轮的文件」「别的 run 的文件」或「别的 session 的 idle」给本轮打分**（身份校验到 `runId/kind/step/attempt/seq`；同一 attempt 的旧验证任务即使后来写出合法文件也不会被接受）。

---

## 6.1 闭环语义（验证 → 订正 → 再验证）

一轮的循环是闭合的，且**验证意见会被回灌**：

```
agent 产出/更新产出物
      ↓  turn idle
独立验证进程打分（读同一份产出物）
      ↓  写出 verdict：score / status / evidence / top_findings
score >= 及格线 ──是──▶ 进入下一 step（换主题与 rubric）
      │
      否
      ▼
retry：followUp 附上验证者的原文意见（findingsLines）
      ├─ 逐条列出「验证者认为仍未解决的问题」
      └─ 并且把这些意见写进**下一个验证者**的 brief（verdictBrief.previous），
         要求它逐条确认是否真的解决、未解决继续扣分
      ↓  agent 在同一 session 里订正产出物
      ↓  turn idle → 再次验证（新 attempt，新的 verdict 文件）
```

* `LoopResult` 现在携带 `score / status / findings / evidence`（`readResultFields` 统一校验，findings 最多 8 条、每条 300 字，evidence 600 字——都是不可信模型输出，必须设上限）。
* 回灌点只有一处：`Controller.settleWith()` 在判定后把 `findingsLines(result)` 追加到 `loopPrompt`；`Controller.loopPrevious` 记住同一 step 上一次的 verdict 并交给 `protocol.verify(..., previous)`。换 step 时清空。
* **无进展早停（预算策略，不是收敛证明）**：`ScoredLoop` 记录「连续未超过本 step 历史最高分」的次数（`noProgress`）：`score > best` 时清零，否则 `attempt > 1` 时加一；累计到 `STALL_STREAK = 2` 进 `phase: 'stalled'`。
  * 为什么是 2：独立验证者对同一份产出物有抖动，一次持平可能是噪声。但「连续两次没有提高」只能说明**重试没有带来更高分**，不能证明产出物没有进展、更不能证明已经收敛——它是保守的预算停止策略，UI 必须显示停止原因。
  * 想改成「必须严格下降才继续」需要改比较条件（只有 `score < best` 才计数），**不是**把 `STALL_STREAK` 改成 1：改成 1 只是把「一次未提高（含持平）即停」变成默认行为，两者不是同一件事。
  * 第一个 attempt 永不早停（`attempt > 1` 才计数）；**没有有效 verdict 不算「不提高」，也不消耗评审次数**：严格模式（默认）下它是 `unavailable`（§6），故障重试不结算本轮。只有一种例外——`allowSelfFallback` 打开、且父回复块也缺失时，它才作为一次失败评审结算，从而消耗一次评审次数。
* `tries` 是硬上限：无论分数趋势如何，`attempt > tries` 即 `exhausted`。
* 终止状态（实现值）：`passed`（达标）、`exhausted`（用尽 tries，**不要求此前每次都在提高**）、`stalled`（连续两次未提高的提前停止）、`blocked`（验证者证明任务不可完成，带 `reason`）、`unavailable`（验证不可用）、`cancelled`（人为取消）、`needs-human`（验证者弃权或 host 要求人工介入；一期为终态，`reason`／`needs` 在 `progress.interaction`）、`deadline`（run 总时限用尽）。`--headless` 下 `passed` 是 exit 0，`needs-human` 是 exit 3，其余是 exit 1。

## 7. 状态所有权与取消

* loop 状态只存在于 client 内存（`Controller.loop`），host 不感知；进程退出即消失（沿用既有设计）。
* 取消触发：输入文字、`/loop stop`／`/loop abort`、`/cancel`、Esc、Ctrl+C、**切换 session**；**重连不取消**（host 还在跑，重连后按 §1#3 重挂 session）。弃权恢复引入后，`/loop answer` 与 `/loop abort` 必须在「输入文字即取消」这条通用规则**之前**被识别，否则恢复命令会先把 loop 取消。
* 验证进程与该次尝试同生命周期：`stopLoop`/`forgetLoop` 会 abort 本地子进程组，避免孤儿进程继续烧 token。**远端取消是请求 + 有界确认**：`session/cancel` 最多等 `CANCEL_CONFIRM_MS`(1s)，本地回收不等待 host；reason 如实区分 `confirmed / rejected / unconfirmed`，host 不支持取消时写 `host cannot cancel`。创建期取消会取消刚建立的 session 并**不再 spawn**。
* 子进程凭据：继承父进程环境（含 `DSH_TOKEN`），`--url` 用操作者原始写法，`--auth-dir` 显式透传；子进程额外带 `--no-memory-log`，避免污染父的 memory log。

---

## 8. 测试

`npm test` 全绿、`npm run typecheck` 绿（具体数字以命令输出为准，不在本文复制）。

| 文件 | 覆盖 |
|---|---|
| `tests/controller/loop.test.ts` | 判定语义：`score` 决定前进/重试而 `status` 不能否决分数、`blocked` 在任意分数下终止；`readResultFields` 对 findings（≤8 条）与 evidence 的上限；连续无提高达到阈值进 `stalled`（首个 attempt 不早停、分数提高即清零、下降同样计数）；`stepLabel` 快照 |
| `tests/controller/loop-contract.test.ts` | verdict 解析（裸 JSON/围栏/散文）、陈旧或非法文件被拒、`score:12` 被丢弃、prompt 含文件与身份、forked/subagent 两种措辞 |
| `tests/cli/verifier.test.ts` | 注入式 runner（不起真实进程）：文件回读并绑定轮次；陈旧文件不被读；argv 含 `--session/--prompt/--verdict/--verdict-identity/--wait/--headless`；无 session 时给 note；取消与超时都先请求 `session/cancel` 再 abort；子进程退出却没有 verdict 时 `reason` 带上它最后一行输出（交互式客户端的唯一诊断）。**它不覆盖**「spawn 前检查 aborted」——`run` 在 signal 已 abort 时仍会被调用，真实 runner 会先 spawn、随即 SIGTERM 进程组（见 §9 G2） |
| `tests/cli/startup.test.ts` | `--prompt` + `--wait`：busy→idle 才结束；仅 `running=true` 不算结束；idle 后 `writeVerdict` 以 5s/200ms 有界轮询等回复到达（**未绑定本回合的回复身份**，见 G3）；child 把回复里的 verdict **原子写**入 `--verdict` 文件（断言 `.part` 不残留） |
| `tests/controller/loop-run.test.ts` | idle 之后才提交的回复块仍被读到（**先等客户端发布 `status: 'Idle'`**，保证 `idle→reply` 顺序，否则测不到回归）；坏控制帧不杀死 loop；重连后按 loop 的 session 重挂 |
| `tests/controller/loop-verify.test.ts` | 假 port 驱动 `verifyRound`：forked verdict 决定轮次且主 brief 不再要求自评；无文件且 **`allowSelfFallback: true`** 时回退到回复块并记 note；两者都没有则消耗一次 attempt；取消后迟到的 verdict 不复活循环；无 verifier 的主机仍读回复块；验证期间进度行显示 `verifying…`，且 `verify` 生命周期按 `begin→retry→…→unavailable` 写入迁移日志（含最终 reason） |
| `tests/controller/loop-protocols.test.ts` | 记录 → 协议：名字表、未知名字、默认值、记录 vars 进入标题与模板、forked 记录带 `verify`；`roundStandard` 的叠加与不叠加；`loopRecords()` 的名字/产出物/默认值/`vars` 与 `loopProtocolFor()` 一致；`loopRecordVars()`；`loopProtocolFor(name, forked, vars)` 让覆盖值进入标题、brief 与 followUp 且记录默认值不再出现 |
| `tests/controller/commands.test.ts` | `/loop <name>` 启动记录：brief 含记录路径与 `"kind"`、progress 轮次标签、位置 score/tries 覆盖默认值、未知名字列出可用记录、反向区间在发 prompt 前被拒；`CommandPort.interactive` 下 `/loop <name>` 只返回表单意图且不发 prompt、带旗标仍直接运行；脚本 port 直接按记录默认值运行、`/loop` 单独出现报错；表单确认的 `vars` 重定向该次运行（brief 含新路径、标题含新路径、旧路径消失）、未声明的变量名在发 prompt 前被拒；迁移日志按 `command→begin→sent` 记录一次成功启动，表单路径与拒绝路径按 `command→form`／`command→rejected` 记录且不启动 |
| `tests/ui/commands.test.ts` | `/loop` 语法：位置 score/tries 与旗标、非法行与错误消息、保留前缀需打全、被取代的 `/design-review`／`/designdoc-review`／`/verify` 已成为未知命令；`/loop` 单独出现是 `loops` 命令并受 `chatOnly`/`blockedByPending` 约束；路由不决定"运行还是确认"；`loopNameQuery` 只在一个名字 Token 内成立、`validLoopOption` 与命令行同规则；`argumentHint` 只在「唯一命令名 + 空格」后给出、前缀也算、无歧义才给 |
| `tests/ui/loop-form.test.tsx` | `LoopMenu` 显示名字/轮数/默认值/产出物/记录指向的 `vars`；`LoopDialog` 显示默认值、初始光标在 Start、输入数字覆盖某行、越界与反向区间被拒、Esc 先撤销编辑再退出、返回记录列表；记录变量行以自由文本覆盖并经 `LoopRun.vars` 交给 Start、清空被拒、改过的行标 `· default <原值>`；**方向键离开一行即提交**（无需逐个回车）、不合法的待提交值让光标留在该行 |
| `tests/ui/app.test.tsx`（`/loop` 与提示条用例） | 端到端：`/loop` → Enter（列表）→ Enter（Start）在两次回车内以默认值启动（"`/loop` 无法执行"的回归）；`/loop` 显示记录列表 → ↑/↓ 选择 → Enter 打开该记录表单 → 覆盖 `path` 与 `Pass` → Enter 启动，断言 `queries.loop` 的标题/四个值与发往 host 的 brief；开启 `tracePath` 后断言 `loop-ui` 的 `choose/open/start` 与 `loop` 的 `command/begin/sent` 被写入；假 verifier 卡住验证时断言状态栏显示 `◐` 与 `review 1/10` 且不再出现 `● Ready`；`/think ` 显示用法提示，`/loop ` 用记录列表取代它；picker 的 Esc 退出 |
| `tests/transport/events.test.ts`、`tests/ui/status.test.ts` | `jobs` 与 `items` 两种字段名（transport 解析与 UI 投影各一侧） |

live 证据（真实 host `127.0.0.1:3080`，**现行机制**）：

1. **评分回读**：`--tries 1` → `best 4 / exhausted`，即 §1 的故障修复后 loop 能读到真实评分（修复前恒为 `best 0`）。
3. **命名生效**：`listSessions` 中该 session 标题为 `[dsht-verify] plumbing probe`，`cwd` 正确。
4. **forked 模式在 CLI 生效**：进度标题为 `Designdoc review · loop.md · forked`。

上述三条只证明「能读到分、session 命名正确、forked 模式已接通」。**当前 verdict 通道的完整端到端现场（含 `runId`/`verdictRoot` 段）尚未重新采集**；旧的现场记录（verdict 路径不含 `runId`、以及「无文件 → 回退父回复并通过」的旧语义）保留在 §11，不作为当前契约的证据。

---

## 9. 未完成 / 待评审决策（**评审重点**）

**P0 —— 仍未验证的一步（启动形态与部署）：**

**一期范围**：本机制只要求**在本机运行**——客户端与被评审内容在同一文件系统、同一 OS 用户。因此「远端非共享文件系统」「`dist/cli/index.js` 以外的部署形态」「跨进程恢复」属于后续阶段，**不列为一期缺口**；下面列出的是本机范围内仍缺的验证与实现。

fork 路径已在 tsx 启动方式（`npx tsx src/cli/index.ts`）下跑通过（§8 第 1／3／4 条为现行机制的现场）。**仍未验证**：另一种启动形态 `dist/cli/index.js`（自 fork 配方 `process.execPath + execArgv + argv[1]` 只在 tsx 下实跑过），以及当前 verdict 通道（含 `runId`/`verdictRoot`）的完整端到端重采。CLI 侧构造已完成：`src/cli/dsht.tsx` 构造 `ProcessVerifier`（`DSHT_NO_VERIFY=1` 关掉即无 verifier，`queries.forkedVerification` 随之为 false，此时按「无独立验证」路径由父回复块决定），超时取 `DSHT_VERIFY_TIMEOUT_MS`（默认 20 分钟）；controller↔verifier 的严格模式/取消/note 由 `tests/controller/loop-verify.test.ts` 用假 port 覆盖（见 §8）。

**待决策：**

| # | 问题 | 选项 |
|---|---|---|
| A | forked 是默认还是 opt-in？ | 建议先 `--forked` 显式开关，live 跑通后再翻默认。当前实现是「有 verifier 就 forked」（`controller.queries.forkedVerification`），CLI 默认构造 verifier，只能靠 `DSHT_NO_VERIFY=1` 关 |
| B | ~~验证用哪个目录~~ **已定（实现即结论）** | verdict 属于 **client 侧**：`src/cli/dsht.tsx` 传 `verdictRoot: process.env.DSHT_VERDICT_ROOT ?? localDirectory`（子进程所在机器的 cwd，`DSHT_VERDICT_ROOT` 可改指），不是远端 host 上被评审 workspace 的绝对路径——那条路径对 host 侧的 agent 不存在。实现与测试见 §4.5、§9「收敛进展」 |
| C | 验证超时是否与 `--timeout` 合并 | 默认值已定（`DSHT_VERIFY_TIMEOUT_MS`，20 分钟）；未定的是它是否该跟 CLI 的 `--timeout` 共用一个开关 |
| D | verdict 文件是否保留 | 现在读完不删（便于审计、便于人看）；落点是客户端进程 cwd 下的 `.dsht/verify/<runId>/`（`DSHT_VERDICT_ROOT` 可改指，§4.5），默认就落在被评审 workspace 里，由 `.gitignore` 的 `.dsht/` 排除。是否应清理旧轮次？ |
| E | ~~`/loop <score> <tries> <prompt>` 是否也 forked~~ **该形式已删除** | 见 §4.6：loop 只执行记录；记录是否用 forked 验证由 `queries.forkedVerification` 决定 |
| F | 子进程的模型/preset | 目前继承默认；是否允许 `--verify-model` 用更便宜/更快的模型做验证？ |
| G | 命名前缀 | 现为 `[dsht-verify] <title> · <step>/<attempt>`；是否需要可配置前缀（host 无 subagent 命名能力，只能用 session 标题做标记） |
| H | 验证者可以提前停下吗？怎么表达、怎么回到流程？ | 见下方「设计：验证者提前停下与人工介入」——**停下必须给理由**，但**不得跳过未验证的范围**：`cannot-fix`（无法改 → blocked）、`needs-human`（需要人介入 → 一期终态 + exit 3）；`no-change-needed` 只是解释字段。**一期已实现**（`reason` 必填、两种停下都不许带 `score`、label 必须自洽，否则整个块按「无判定」处理）；`code` 枚举与 `/loop answer` 恢复属二期 |
| I | 命令面是否收敛为单一 `/loop <name>`？ | 是（§4.6，**已实现**）：`/design-review`、`/designdoc-review`、`/verify` 已删除，协议、附加标准、`vars` 与默认值都由 `loop.yaml` 的记录承载 |

**其它未做（状态以本节「收敛进展」表为准，此处只记门禁与理由）：**`README.md`／`README.zh.md` 与 `tui-design.md` §3.4 已按现行命令面与失败语义同步（`README.i18n.yaml` 的配对哈希已重记）；`{{path}}.review.md`（设计文档审查的产出物，现在是每份文档一个文件）与本文一样**未纳入版本控制**；本批改动**尚未 commit**。

### 待补契约（建议的实现顺序：先统一语义 → 再身份与完成/取消边界 → 然后弃权恢复 → 最后发布入口与远端部署）

| # | 目标 | 现状与缺口 | 验收（必须由测试证明） |
|---|---|---|---|
| **G1** | **每个实际验证任务有唯一身份**：`runId` = 整个 loop，`step/attempt` = 产出物的评审进度，`verificationId` = **这一次启动的验证任务**，三者不可互相代替 | ✅ **已实现**：`seq` 每次实际启动验证都自增（含故障重试与人工恢复），身份为 `<runId>/<kind>/<step>/<attempt>/<seq>`，文件名含 `seq`；父进程用 `loopVerifyIdentity` 只接受「当前等待的那一个」结果 | `loop-verify.test.ts`「a verification retry is a new task with its own identity and file」+ 原有的陈旧/越轮 verdict 拒绝用例 |
| **G2** | **取消的边界可确认**：本地一定回收；远端取消有短等待上限并如实报告「未确认」；创建期取消不留孤儿 session；已废弃任务的结果永不复活 | ✅ **已实现**：`signal` 已 abort → 不建 session/不 spawn；创建期取消/超时 → 取消刚建的 session 并直接返回；超时任务即使落下合法 verdict 也判 `unavailable`；`session/cancel` 等待上限 `CANCEL_CONFIRM_MS = 1_000`，reason 区分 confirmed/rejected/unconfirmed；`spawnLines` 在 spawn 前检查 aborted | `verifier.test.ts`：cancel-before-start、abort-during-create、timeout-with-late-verdict、cancel-rejected、cancel-never-answered（有界）、超时也取消 host；`runner.test.ts`：aborted 不 spawn |
| **G3** | **「完成」= 本回合的最终回复已可读**，不只是观察到 idle 边沿 | 🟡 **最小绑定已实现**：child 记录 prompt 之前的消息基线，只接受**基线之后出现的 assistant 回复**；仍不绑定 host 的 turn/回复标识（协议没有），超时仍走有界 grace | `startup.test.ts`：prompt 前的旧 verdict 块（身份还完全匹配）不会被采用；prompt 后的回复正常写出 |
| **G4** | **分开两件事**：验证者不能写被评审对象；结论对应哪一份产出物 | 🟡 **一期已实现（能检测、不能阻止、不能归因）**：① 每个验证请求显式声明被评审 workspace（`VerifierRequest.workspace`，由 controller 的 `localDirectory` 给出），artifact 绝对路径由它拼出，不再靠验证进程的 cwd 推断；② 验证前后对产出物取 SHA-256，**变化即作废本次结论**（`unavailable`，reason 写明文件与前后哈希）并按故障重试，也就是重新验证；③ 验证在飞时 loop 不发送任何写入（`flushLoop` 门禁）。**未做**：阻止写入（需要 OS 级隔离——独立用户或只读挂载）、检测「改完又改回」、把变化归因到具体进程；跨 step 的被评审范围（代码/配置）也不在覆盖内 | 指纹在**请求声明的 workspace** 上生效（同名的进程目录文件不再被误判为目标）；模型改了产出物时该轮 verdict 被作废并重验；验证期间 loop 不产生新的写入 |
| **G5** | **`passed` 的含义要么是「整份产出物满足全部要求」，要么不再这么声称** | ✅ **已实现（范围语义 + 全量收尾复核）**：① `LoopProgress` 带 `scope`，`passed` 一律写成「本次 run 覆盖的轮次」（`rounds 1–3/10 · selected range` / `rounds 1–10/10`），UI 与 headless 都如此；② 只有 `from=1 && to=steps` 的 run 才会在**最后一轮**（记录的收敛轮）被标记为收尾轮：工作 brief 要求「改坏任何前序要求都要在这一轮修回」，verdict brief 拿到**前面每一轮的 rubric 全文**并被要求逐轮复核、把回归写进 `top_findings` 据此扣分。两者都由 `coversWholeProtocol(from,to,steps)` 机械决定，不是约定 | 「第 5 步改坏第 2 步要求」时：最后一次验证的 prompt 里必然含有第 2 轮的 rubric 与逐轮复核指令（测试见 `loop-protocols.test.ts`）；部分范围 / 从中间开始 / 非最后一轮都**不会**出现全量复核段 |
| **G6** | **验证者可提前停下，但不得跳过未验证的范围**：`cannot-fix` → blocked、`needs-human` → 一期终态 + exit 3（都必须给理由）；`no-change-needed` 只是解释字段、无控制力；`starts: verify\|work` 阶段顺序；`tries` = 每 step 评审次数 | 🟡 **一期已实现**：`abstained` 是第四种 `status`，`readResultFields` 把提前停下当**整体**校验（恰好一种判断、`reason` 必填 ≤300 字、两种停下都不许带 `score`、`exit_reason` 必须与 `status` 自洽），不合格即返回「无判定」→ 独立验证报 `unavailable` 并重试，**绝不静默当成提前停下**；`ScoredLoop.settle` 把 `abstained` 映射为终态 `needs-human`（`progress.interaction` + headless exit 3）、`blocked` 映射为 `blocked` 并把 `reason` 记进 `progress.exit`；`starts` 已生效（两条内置记录 `verify` 优先）；主 brief 声明「本轮通过 ≠ 整个目标通过」；`explanation` 只是字段，没有任何跳步路径。**二期**：`code` 次级枚举、`/loop answer` 暂停/恢复 | step 3 高分后 step 4 仍必须运行；只跑 `--from/--to` 时 `passed` 只报所选范围（尚未在 UI/headless 标注范围）；`explanation` 不改变控制流 |
| **G7** | **命令面收敛为单一 `/loop <name> [score] [tries]`**：协议、附加标准、`vars` 与默认值都由 `loop.yaml` 记录承载，`/verify` 删除 | ✅ **已实现**：`loop-protocols.ts` 装配记录，`/loop` 按名字取用；`design-review.ts`／`designdoc-review.ts`／`loop-prompt.ts` 与 `/design-review`、`/designdoc-review`、`/verify` 一并删除；自由 prompt 形式取消；`answer`／`abort` 为保留名，未知占位符在发送前报错 | 测试：`loop-protocols.test.ts`（记录→协议、vars、forked verify、`roundStandard`）、`commands.test.ts`（按名字运行/位置 score tries/未知名字列出记录/反向区间）、`ui/commands.test.ts`（新语法、保留前缀、旧命令已成未知）、`loop-prompts.test.ts`（schema 与 vars/defaults） |
| **G8** | **run 级预算**：每 step 评审次数 + 每次验证故障重试 + **整个 run 截止时间**；重试按责任分类；远端未确认停止时不得重试 | 🟡 **已实现**：`--deadline <minutes>`／`DSHT_LOOP_DEADLINE` → `Controller.deadlineMs`，到期即终态 `deadline`（不消耗 attempt、不自动重试、取消在飞的验证）；`VerifierOutcome.unavailable.retryable === false` 时 controller 直接报告、不花重试预算（远端取消未确认/被拒绝、缺 fork 入口）。**尚缺**：断连/配置错误的更细分类（目前除上述两类外统一按可重试处理） | 测试：`loop.test.ts` 的终态不变量、`loop-verify.test.ts` 的 deadline 中止与迟到 verdict、`retryable:false` 只验证一次、`verifier.test.ts` 的 unconfirmed → `retryable:false`、`cli.test.ts` 拒绝非法 `--deadline` |
| **G9** | **协议在 run 内冻结**；默认值优先级 命令 > 记录 > 全局；`vars` 相对被评审 workspace 解析；未知占位符在发送前报错；`answer`／`abort` 为保留名 | ✅ **已实现**：`loopProtocolFor` 启动时读一次记录并闭包保存（标题、rubric、standard、vars、默认值），`LoopLimits` 在 `startLoop` 解析一次；YAML 是构建期内联，运行中改磁盘本就不影响本次 run。**将来若启用运行时加载**，仍需保留这层快照 | `loop-protocols.test.ts`（协议字段来自记录）、`loop-prompts.test.ts`（未知占位符/保留名/默认值校验在生成期失败）、`commands.test.ts`（命令参数覆盖记录默认值） |
| **G10** | **运行中的人工请求通道** | 🟡 **一期已实现**：child 在自己 session 上看到未决审批/提问 → 打标记行退出；`ProcessVerifier` 解析标记、取消该 turn（有界确认）、返回 `needs-human`；controller 以终态 `needs-human` 结束（不消耗评审次数、不重试），headless exit 3。**尚缺**：`/loop answer` 恢复原 turn（二期，需要 App Server 类双向协议） | 已覆盖：child 检测、标记解析＋取消、loop 不重试、headless 映射 |
| **G11** | **验收由程序组合**：身份 ∧ 产出物版本 ∧ 覆盖范围 ∧ 必需检查 ∧ 评分；硬条件不被高分覆盖 | 🟡 **一期已实现（产出物形态硬条件）**：每次判定都过 `settleChecked`——身份/归属（G1／G3）、产出物未被改动（G4）、**本轮产出物小节存在**（记录声明 `artifactMarker`，由**客户端自己读文件**核对，不采信模型的说法）、分数达阈值；任一项不成立即不通过，`score` 被置空、缺少的小节作为 finding 回灌给下一次尝试，进度行写明「验证者给了 X 分，本轮不通过」。纯设计评审**不加强制测试门禁**：硬条件来自记录自己的 rubric（每轮必须写入 `artifact` 的对应小节），而「测试退出码」这类检查需要 host 侧执行，一期不做 | 「9 分但产出物里没有本轮小节」必须不通过（`loop-run.test.ts`／`loop-verify.test.ts`）；小节存在或产出物对本机不可读时判定照旧；纯设计评审不因缺少测试门禁被拒 |
| **G12** | **持久化（二期，可选）**：最小 run checkpoint + 按 `runId` 恢复；恢复前核对远端 turn 与产出物 | 一期明确只支持进程存活期间恢复 | 若做：恢复不得重发上次 prompt 或重放写操作 |

**一期建议顺序**（对应评审给出的五项）：① 删除 `no-change-needed` 全局捷径、明确 step 成功与 run 成功的范围（G6）：**一期已实现**（两种提前停下 + 硬校验 + `starts` 阶段顺序；范围标注见 G5）→ ② G1/G2/G3：**已实现**（验证任务唯一身份、取消/超时边界、完成的最小绑定；G3 仍不绑定 host turn 标识）→ ③ 运行中人工通道（G10）：**一期已实现**（检测→取消→`needs-human` 终态 + exit 3），`/loop answer` 属二期 → ④ 协议冻结（G9）与 run 总时限（G8）：**均已实现**（`--deadline`、`retryable:false`、run 内记录快照）→ ⑤ 最终检查当前产出物的完整要求（G5）：**已实现**（范围可见 + 收尾轮的逐轮回归复核；程序化硬条件仍属 G11），再用发布入口与远端部署做真实验收。G7（命令面）**已实现**；G12 属于下一阶段。

### 设计：验证者提前停下与人工介入（**一期已实现**，二期见每条的标注）

**问题**：verifier 今天只有三种出口（§4.2）：`verified | unavailable | cancelled`。当它**活着、能判断、但结论不是「再改一版」**时——产出物已经够好、要求在当前约束下无法满足、或需要操作者做一个取舍／补一份权限——它只有两条坏路：硬给一个分（把「没必要改」和「改不动」都伪装成「还不够好」，逼出无意义的订正），或落进 `unavailable`（那是基础设施故障，会被重试 2 次后按故障收尾）。两者都不表达「到此为止，理由是……」；headless 下也都退化成 `exit 1`，脚本无法区分。

**verifier 可以提前停下，但不能跳过未验证的范围**：停下的**范围**与**理由**必须分开表达，且理由必填（`reason` 非空、≤300 字 + `evidence`）。verdict 的判决语义固定为下表——**没有任何字段可以凭当前 step 的高分结束整个 run**：

| 判断 | verdict | 行为 |
|---|---|---|
| 当前 step 已满足要求 | `score ≥ 阈值`（verifier 通常把它标成 `status: 'done'`，但状态机不看这个标签） | **step 通过**，进入下一步；只有它已是本次范围（`--from/--to`）的最后一步时，本次 run 才 `passed` |
| 当前 step 不满足要求 | `score < 阈值`（`status` 通常是 `retry`，同样只是标签） | 回灌 findings，订正后重新验证；`tries` 用尽 → `exhausted` |
| 当前约束下不可完成 | `status: 'blocked'`（+ 可选 `exit_reason: 'cannot-fix'`）+ `reason` + `evidence`，**不得带 `score`** | run `blocked`（不需要人），`reason` 进 `progress.exit` |
| 缺少人的决定 | `status: 'abstained'`（+ 可选 `exit_reason: 'needs-human'`）+ `reason` + `needs`，**不得带 `score`** | 一期：终态 `needs-human`（headless exit 3），`reason`／`needs` 进 `progress.interaction`；二期：暂停等人，`/loop answer` 恢复 |
| 全部要求已被覆盖 | 协议里**显式的最终检查 step** 通过 | run `passed` |

- **`no-change-needed` 降级为解释字段**（`explanation`，可选、**无控制力**）：它只表示「本轮没有可改之处」，不产生 `passed`、不跳过任何 step。原稿那条「高分 + 没必要改 → 整个 loop 提前通过」是漏洞——当前 step 的高分不能替代尚未运行的验证范围。
- **全局提前成功只有一种合法形式**：一次**覆盖全部目标**的验证，且绑定**同一份产出物版本**；它就是协议里显式的收尾轮（`coversWholeProtocol` 为真的那次 run 的最后一轮），不是某个 verdict 字段的副作用。**范围可见（已实现）**：`--from/--to` 只跑部分步骤时 `passed` 的含义是「所选范围通过」，UI 与 headless 输出都带上 `LoopProgress.scope`（如 `passed · rounds 1–3/10 · selected range`），而不会读成整份产出物通过。
- **范围语义（已实现）**：`--from/--to` 只跑部分步骤时，`passed` 的含义是「所选范围通过」，不是「整个协议通过」；`LoopProgress.scope` 把范围渲染进 UI 与 headless（`rounds 1–3/10 · selected range`，整份记录时为 `rounds 1–10/10`）。
- `cannot-fix` / `needs-human` **不得给 `score`**（没有可评的产出）；两者的 `reason` 必填非空（≤300 字）；`needs-human` 的 `needs`（要人提供什么）在一期是**可选**字段——`code` 次级枚举与 `needs` 必填属二期，届时才有回答通道可以把它们变成动作。
- 契约措辞：`verdictBrief` 与主 brief 都用同一段 `earlyStopLines()`（`loop-contract.ts`）写明每种判断的适用与不适用、`explanation` 不改变控制流、以及「理由必须能让人复核」；主 brief 另有一行告诉被评审 agent「**本轮通过只代表本轮达标，不代表整个目标通过；尚未运行的轮次仍然必须运行**」（文案在 `loop.yaml`）。
- **实现位置（一期）**：硬校验在 `readResultFields`（`controller/loop.ts`），工作回复与 verdict 共用。子进程侧的 `writeVerdict` 也走 `parseVerdict`：不合格就**不落盘**，父进程于是报 `unavailable: 'verifier wrote no verdict (…)'`；文件存在但内容不合格（手改、旧版本写入）时报 `unavailable: 'verifier verdict was unusable'`。两种都按故障重试 `VERIFIER_RETRIES` 次后结束为 `unavailable`。工作回复块不合格只意味着「回复里没有可用判定」（严格模式下它本来就不参与打分）。

**1) 模型 → 文件的协议面**（**已实现**）：`status` 增第四值 `abstained`；`exit_reason` **只允许**出现在 `blocked`（`cannot-fix`）与 `abstained`（`needs-human`）上，出现即必填 `reason`，且必须与 `status`／`blocked` 自洽。`no-change-needed` 不再是 `exit_reason`，而是可选的 `explanation`。

```json
// 当前 step 通过：正常推进；只有 step 3 是本次范围最后一步时 run 才 passed
{"verificationId":"…","kind":"design-review","step":3,"attempt":1,
 "status":"done","score":9,"explanation":"本轮三处接口问题已在前一轮修完，继续改只会扩大改动面",
 "evidence":"npm test 全绿；接口文件与文档已对齐"}

// 当前约束下不可完成：run blocked，不得给 score
{"verificationId":"…","kind":"design-review","step":5,"attempt":2,
 "status":"blocked","exit_reason":"cannot-fix",
 "reason":"宿主协议没有取消接口，当前约束下无法满足第 5 轮要求","evidence":"端点清单里没有对应端点（§3.1.5）"}

// 需要人介入：暂停或终态 abstained，不得给 score
{"verificationId":"…","kind":"designdoc-review","step":2,"attempt":1,
 "status":"abstained","exit_reason":"needs-human","code":"needs-decision",
 "reason":"README 双语对与 blob 哈希门禁冲突，需要操作者决定改哪一侧","evidence":"跑过 …；两侧哈希不一致",
 "needs":"请确认是否允许改 README.zh.md 并重记哈希"}
```

`needs-human` 的次级 `code`（**二期，尚未实现**：一期只保留 `reason` 与可选的 `needs`，因为没有回答通道可以把 `code` 变成动作）用封闭枚举，**按「谁负责、怎么恢复」分类，而不是按错误名分类**：

| code | 谁负责／怎么恢复 |
|---|---|
| `needs-decision` | 操作者做一个取舍；回答后**重新验证**当前产出物 |
| `needs-credentials` | 操作者补凭据；补完后重新验证 |
| `needs-network` | 外部依赖恢复；可稍后重试（但要计入 run 预算） |
| `ambiguous-request` | 协议/标准需要澄清；澄清相当于修改协议，见 §9「冻结」 |
| `artifact-unreadable` | 可能是产出物格式错（有效低分／重试）、缺依赖（故障，`unavailable`）或路径错（人工），必须**分别归因**，不能只看错误名 |
| `out-of-scope` | 协议设计问题；改协议后重开 run，不是本轮继续 |

硬校验（**一期已实现，落在 `readResultFields`**）：`exit_reason` 只能取 `cannot-fix`（配 `blocked`）或 `needs-human`（配 `abstained`），省略时由 `status` 推导；`reason` 必填非空且 ≤300 字；这两个 verdict **不得带 `score`**；`abstained` 同时给了 `blocked` 或给了 `score` 都算不合格；`explanation` 任何情况下都不改变控制流。不满足即按「无判定」处理（verdict 侧回落 `unavailable`），**不得静默当成提前停下**；`needs` 可选，`code` 属二期。低分但带 `explanation` 就是普通重试，不特判。

**2) 端口面（一期实现）**：`blocked + cannot-fix` 与 `abstained + needs-human` 都是**判断**，因此都走现有的 `{ type: 'verified'; result }`，`result` 里带 `exitReason` / `reason`（abstain 另带 `needs`）——一期不新增 `{ type: 'abstained' }` 分支。**独立分支只留给「验证者被 host 交互卡住」**（G10 一期）：`VerifierOutcome` 增 `needs-human`，由 child 打标记行、父进程取消那个 turn 并返回，**不重试**（它不是故障，也不消耗评审次数）。二期的 `abstained` 暂停才需要自己的端口分支（它要携带 `code` 并等待 `/loop answer`）。

**3) 状态机面（暂停 ≠ 终止）**：把「不再执行」拆成两个不同的判定，所有清理与新 loop 替换都只用后者：

- `active`：状态机**还会继续**，只有 `running` 为真。
- `terminal`（实现值）：`passed | exhausted | stalled | blocked | unavailable | cancelled | needs-human | deadline`。**一期 `needs-human` 也是终态**（没有回答通道），终态才允许被清理或替换（新增终态必须加进这一处，别让清理与恢复各自维护一份）。二期待 `/loop answer` 落地后，暂停态与终态才分开，那时 `abstained` 才成为一个终态名。

`ScoredLoop.settle(result)`（**已实现**）：**只用 `score`、`blocked` 与 `abstained` 判决**，`status` 只是标签（verifier 通常把达标写成 `done`，但状态机不看它）——`score ≥ 阈值` 才推进 step（或在本范围最后一步时 `passed`）；`blocked` → `phase: 'blocked'` 并把 `reason` 记进 `progress.exit`；`abstained` → `phase: 'needs-human'` 并把 `reason`／`needs` 记进 `progress.interaction`，两者都不消耗评审次数。**没有任何分支会因为当前 step 的高分而跳过剩余 step。**

`needs-human` 的**设计目标是暂停态**（`pause(...)`：`active = false`，不再发送与结算，`best`／`noProgress`／`step`／`attempt` 一律不变，`/loop answer` 恢复）。**一期实现为终态**：没有 answer 通道，`abstained` 的 verdict 与「验证者被 host 交互卡住」都直接结束本次 run（`phase: 'needs-human'`，带着 `progress.interaction`，headless exit 3）；二期待 `/loop answer` 落地后才改为暂停。

**4) 回到流程**：

- **交互模式（已实现）**：进度行显示 `needs you · /loop answer` 并附 `verdict: <text>`（host 交互则是 `question`／`approval`），状态栏显示 `⏸ … needs you`。判断者**弃权**时 run 进入**暂停**（`phase=needs-human` 且**没有** `terminalReason`、`active` 仍为 true）：`/loop answer <text>` **只补充判断条件并重新验证当前产出物**——生成**新的 `verificationId`**（G1）、不进入工作阶段、**不结算任何计数**（`tries` 是评审次数，消耗它的是修改之后的那次评审）；没有 forked verifier 时答案改为作为下一次尝试的指令发给 agent，同样不结算计数。`/loop abort`／Esc／`/cancel` → `cancelled`。验证子进程或 host 自己要求人工（子进程会话提问、发送被拒）仍是**终态** `needs-human`（带 `terminalReason`），因为本客户端无法代答那个 channel；外部条件处理完后重跑即可。
- **headless 模式（一期已实现）**：不交互。verdict 声明的 `abstained` 结束时打印 `Loop needs-human · verdict: <reason>`；验证者被 host 交互卡住时 `waitForTurn` 打印 `dsht-verify-needs-human:{kind,text}` 行。两者都以**独立退出码 3** 结束（`0` = passed，`1` = failed），verdict 文件保留供审计（沿用决策 D）。**退出前处理仍在等待的远端 turn**：一期不支持跨进程恢复，`ProcessVerifier` 会取消该 verifier session 并报告清理结果（`confirmed / rejected / unconfirmed`），不会留下一个还在烧 token 的 generation。
- **「用户没回答」不是故障**：交互模式下暂停等待是正常状态，不自动降级成 `unavailable`；只有实现了显式等待超时才允许转换，且必须在 UI 说明。
- **预算只按 step 清零（二期）**：每个 step 最多 **一次**人工补充；恢复后再次 `needs-human` → 终态 `abstained`，保留 `reason`／`needs`，**不复用 `unavailable`、也不走自动重试**；计数只在 step 前进时清零。`cannot-fix` 不需要人：直接结束为 `blocked`，并带着 `reason` 显示在进度行与 headless 输出里；普通通过只是推进 step，不是结束 run。

**5) 触及的接口与测试**：

| 位置 | 改动（✅ = 一期已实现，🕓 = 二期） |
|---|---|
| `src/controller/loop-contract.ts` | ✅ `LOOP_STATUSES` 增 `abstained`；新增 `earlyStopLines()`（工作 brief 与 verdict brief 共用同一段措辞）；`verdictBrief` 说明 `exit_reason`／`reason`／`needs` 与「不给 score」，并改为**不承诺**自评兜底（严格模式下 reply block 不参与打分）；`VerificationBrief.final` 与 `VerdictBrief.coverage` 承载收尾轮的回归复核（G5） |
| `src/controller/loop.ts` | ✅ `LoopResult` 增 `abstained`／`exitReason`／`reason`／`needs`／`explanation`，`readResultFields` 做整体硬校验（不合格返回 `undefined`）；`ScoredLoop` 把 `abstained` 映射为终态 `needs-human`（`interaction`）、`blocked` 映射为 `blocked`（`progress.exit.reason`）；`LoopProtocol.starts` 与 `LoopProgress.exit`；`coversWholeProtocol` + `progress.total`/`progress.scope`（G5） |
| `src/controller/loop-protocols.ts` | ✅ 记录 → 协议；`consolidates()`／`coverage()` 决定收尾轮（G5） |
| `src/contracts.ts` | ✅ `LoopProgress.phase` 增 `needs-human`／`deadline`，`interaction?`、`exit?`、`total`、`scope` |
| `src/controller/controller.ts` | ✅ `verifyRound` 的 `needs-human` 分支与 `verified` 结果直通；`deadlineMs`；verify-first（`startsByVerifying`／`verifyStep`）；每个请求显式带上被评审 workspace，验证在飞时 `flushLoop` 不发送写入（G4）。🕓 `loopOperatorNote`、`/loop answer` 动作（优先于通用输入取消） |
| `src/controller/verifier.ts` | ✅ `VerifierOutcome` 增 `needs-human`（host 交互）与 `unavailable.retryable`；`NEEDS_HUMAN_MARKER`／`needsHumanLine`／`parseNeedsHumanLine`；`VerifierRequest.workspace` 显式声明被评审 workspace（G4）。🕓 `abstained` 暂停分支（带 `code`） |
| `src/cli/verifier.ts` | ✅ `ProcessVerifier`：读回的 verdict 不合格 → `unavailable: 'verifier verdict was unusable'`（可重试；子进程侧不合格则不落盘，报 `verifier wrote no verdict`）；host 交互 → 取消该 turn 并返回 `needs-human`；有界取消确认；产出物指纹改在 `request.workspace` 上做，变化即作废该轮结论（G4；`directory` 选项删除） |
| `src/cli/startup.ts`、`src/cli/dsht.tsx` | ✅ `StartupOutcome` 增 `needs-human` → headless `exit 3`，并打印 `Loop needs-human · …`；`--deadline <minutes>`／`DSHT_LOOP_DEADLINE`；verifier 不再接收 `directory`（workspace 随请求走，G4） |
| `src/ui/chat/loop-status.tsx`、`src/cli/startup.ts` | ✅ 渲染 `interaction`（等人）、`exit.reason`（提前停下）与 `scope`（`passed` 的范围，G5） |
| `loop.yaml` | ✅ 两条记录的 brief 各加一行「本轮通过 ≠ 整个目标通过」；`verdictBrief`／`resultContract` 的提前停下文案由 `earlyStopLines()` 统一提供；两条记录声明 `artifactMarker`（G11），字段约束见 `loop-prompts-schema.ts` |
| 测试 | ✅ `loop`（硬校验全表：缺 `reason`／带 `score`／label 不自洽都得到「无判定」；`explanation` 不改变控制流；`coversWholeProtocol`）、`loop-contract`（`parseVerdict` 的整块校验 + brief 措辞）、`loop-protocols`（收尾轮的回归清单：整份记录才有、部分范围/中间开始/非末轮都没有）、`loop-verify`（verdict 声明的 `cannot-fix` → `blocked` 且 `exit.reason` 保留、`abstained` → 终态 `needs-human`、不消耗 attempt、host 交互不重试、端到端 `scope`）、`loop-status`（进度行与范围）、`startup`（退出码 3 与 headless 范围行）、`verifier`（指纹只认请求声明的 workspace：同名文件在进程目录里不再被误判，reason 带文件与前后哈希）。🕓 暂停/恢复与 `/loop answer` 的用例 |

**6) 边界与反滥用**：`reason`、`needs` 必填非空并有长度上限（各 300 字）；「理由是否成立、`needs` 是否可执行」是语义要求，普通字段校验无法证明，不能写成「程序已保证」。**当前 step 的高分不能结束 run**：`explanation` 与 `score` 都不具备跳步能力，`--from/--to` 之外的范围必须真的跑过，或者由一次覆盖全部目标的显式最终检查给出结论。`cannot-fix` 必须给证据；`needs-human` 必须给 `code` 与 `needs`；两次 `needs-human` 后终态 `abstained`，保留原因与独立退出语义，**不伪装成 `unavailable`**。提前停下的用途是「到此为止，理由是……」，不是「避免差评」，也不是「节省未做的验证」。

**7) 阶段顺序与预算命名**：

- 评审类协议**先验证、再订正**（critic 在前）：产出物已存在时，第一件事是把当前版本交给 verifier，而不是让工作 agent 先改一版。创建类协议**先生成一次**，再进入验证循环。协议用 `starts: 'verify' | 'work'` 声明，**默认 `work`**（不声明就是不改变现状）；两条内置记录都显式声明 `verify`，因为被评审的产出物本来就在工作区里。
- `tries` 固定为**每 step 的评审次数上限**（代码里的 `attempt` 就是评审序号）；不再使用「订正次数」这个说法。一次真正的订正体现在下一次评审的 attempt 上，不单独计数。
- **不能按「文件是否变化」计数**：agent 反复跑工具而不改文件同样消耗时间与费用，预算必须每次评审都记。

**8) 运行总预算与重试分类**：

- 三个预算各管一段：每 step 评审次数 `tries`、每次验证的故障重试 `VERIFIER_RETRIES`、**整个 run 的截止时间**（`--deadline <minutes>`／`DSHT_LOOP_DEADLINE`）。前两者只约束局部：5 step × 10 次 × 3 次验证 × 20 分钟 ≈ 50 小时的验证时间在没有全局预算时是规则允许的。
- 到期 → 终态 `deadline`（**已实现**）：停止状态机、取消在飞的验证（有界确认）、不自动重试；`--deadline` 不是正数时直接拒绝启动，而不是悄悄变成无界。
- 重试分类（**部分实现**）：暂时断连 → 有限重试；**远端取消未确认/被拒绝、缺 fork 入口 → 立即报告，不重试**（`VerifierOutcome.unavailable.retryable === false`）；等待人工 → `needs-human`，不算故障重试。更细的「固定目录不可写／认证错误」分类尚未实现，目前按可重试处理。
- **远端取消未确认时不得自动重试**：那可能让两份远端任务重叠，费用与副作用翻倍。等待上限到期仍未确认时，本次验证以 `unavailable` 收尾（reason 写明 `unconfirmed`），**不再自动启动第二个远端任务**；要继续只能由操作者显式重跑，或等取消确认后手动重试。
- 费用上限接现有 cost 能力，且必须汇总主 session 与验证 session；**账本归 `cost/`，loop 只消费预算检查接口**。

**9) 协议冻结与默认值优先级**：

- **run 启动时解析并冻结**协议、rubric、`standard`、`vars` 与预算快照，本次 run 一律用快照。今天 YAML 是**构建期内联**，运行中的进程读不到磁盘改动，所以「边跑边改 YAML」当前并不成立；冻结真正要挡住的是**运行参数与被评审对象在 run 中途变化**，以及在将来启用运行时加载后，工作 agent 顺带改评分标准。配置变更只影响后续 run。
- 默认值优先级：**命令参数 > 记录 `defaults` > 全局 `defaults`**。
- `vars.path` 相对**被评审 workspace（host 侧）**解析；它与客户端 verdict 目录是两个不同的根，不能互相推断。
- YAML 加载时机：现在是构建期生成 + 内联（运行时不读 YAML），所以从源码跑要 `npm run build:prompts`；若要「改完即生效」，需要显式选择运行时加载方案（它是产品决策，不是默认）。
- 子命令名保留：`/loop stop`（已实现）、`/loop answer`、`/loop abort` 不能被记录名占用；未知 name 报错并列出可用名字；**未知模板变量必须在发送 prompt 之前报错**，而不是把 `{{name}}` 原样发给模型。

**10) 运行中的人工请求（与最终 verdict 并列的第二个入口）**：

- 除了最终 verdict 里的 `needs-human`，验证 turn **进行中**也可能需要人：host 要求工具审批、验证 agent 调用提问工具、某操作等待确认、headless child 无法处理交互。
- 两个入口的恢复方式不同：**运行中暂停** → 优先回答原 session 的原请求，再继续原 turn，不新建 session；**最终 verdict 需要人** → 补充条件后启动**新的验证任务**（新 `verificationId`）。不能把两者都实现成「新建 session 重跑」。
- 必须堵住今天的失败模式：child 一直等人 → 超时 → 当成 `unavailable` → 再起一个 verifier，同一个人工阻塞被重复执行三次。规则：verifier session 存在未决交互时，父进程**不得**把它当作故障重试，应转入 `needs-human`。
- 归因按责任与恢复方式（§1 的 `code` 表），不按错误名：环境损坏、缺用户配置、产出物本身格式错，分别可能属于故障、人工输入或有效低分。
- **一期实现（已完成）**：`waitForTurn` 在轮询里检查本 session 的 `state.pending`，命中即输出 `dsht-verify-needs-human:{kind,text}` 并退出；`ProcessVerifier` 解析该行、取消该 verifier session 的 turn（有界确认）、返回 `needs-human`；controller 以终态 `needs-human` 结束且**不重试**（`attempt` 不变），headless 父进程退出码 3，进度行显示 `needs-human · <kind>: <text>`。**回答并恢复原 turn（`/loop answer`）仍属二期**，届时 `needs-human` 从终态改为暂停态。

**11) 持久化与恢复（分两阶段）**：

- **一期明确限制**：只支持**进程存活期间**的恢复；headless 因 `needs-human` 退出即表示本次 run 终止。verdict 文件只是审计材料，不是 checkpoint。
- **二期待做（可选）**：保存最小 run checkpoint（协议与预算快照、已完成 step、已用预算、待答问题、产出物版本、工作与验证 session id），提供按 `runId` 恢复的入口；恢复时**先核对远端 turn 与产出物状态**，不得直接重发上一次 prompt 或重放写操作。

**12) 验收由程序组合，分数只是其中一项（**一期已实现**）**：

- 最终接受 = **身份与回复归属有效**（G1／G3）∧ **产出物版本一致**（G4：验证前后指纹相同）∧ **所需范围已覆盖**（G5：`passed` 只声称跑过的轮次，整份记录的最后一轮带全量回归清单）∧ **必需检查通过**（G11：本轮产出物小节存在）∧ **评分达阈值**。硬条件不得被高分覆盖；`evidence: "测试全绿"` 只是模型陈述，能用工具结果的地方一律用真实结果。
- **实现**：三处判定都汇进 `Controller.settleChecked()`：先跑协议自带的产出物检查（`artifactMarker` 渲染成「## 第 N 轮 · 主题」，客户端读 `join(localDirectory, artifact)` 自己核对），不满足就把 `score` 置空、把「缺少本轮小节」并进 findings、把原因写进进度行，于是它按一次失败尝试计入 `tries`，与低分走同一条路——**不存在「分数高就跳过」的分支**。产出物对本机不可读时不做检查（与 G4 同一边界），判定照旧。
- **仍未做**：必需测试退出码、必需接口存在性等需要**在 host 侧执行**的检查（客户端只能读文件，不能假定 workspace 在本机），以及把检查结果持久化为可审计记录。这些属二期；纯设计评审不强行加测试门禁：用明确 rubric、可定位的问题与可核查证据即可。
- 上一轮 findings 允许被新 verifier 依据证据纠正，不要求无条件维护旧判断。

**13) `passed` 的范围与收尾复核（**已实现**，G5）**：

- **绝不夸大范围**：`LoopProgress` 带 `total`（记录定义的总轮数）与 `scope`（`rounds 1–10/10` 或 `rounds 1–3/10 · selected range`），进度行与 headless 输出在 `passed` 时都打印它。因此「跑 3 轮通过」永远不会读成「整份产出物通过」。
- **整份记录才有全量复核**：`coversWholeProtocol(from, to, steps)`（`from === 1 && to === steps`）为真时，`step === steps` 这一轮被标记为**收尾轮**：
  * 工作 brief 多一段：本轮改动不得破坏前面每一轮已满足的要求，破坏了必须在本轮修回；
  * verdict brief 收到**前面每一轮的标题与 rubric 全文**，并被要求逐轮复核、把回归写进 `top_findings` 并据此扣分，明确「本轮通过意味着整份产出物通过」。
- **记录侧的约定**：记录的最后一轮必须是覆盖全部要求的收敛轮（两条内置记录都是），因为全量复核挂在这一轮上；这条约定写在 `loop.yaml` 的文件头。
- **能力边界**：这是**提示词层面的强制**——dsht 保证「最后一轮一定拿到了全部前序 rubric 与逐轮复核指令」，但「验证者是否真的逐条复核」仍取决于模型，和 `score` 本身一样属于 §10 的诚实边界。真正的程序化组合验收是 G11。

---

### 设计：接入其他 harness（以 Codex CLI 为例；**未实现**）

现状：`ProcessVerifier` 里混着三件 DSH 专属的事（`session/create` + `session/rename`、child CLI 写 verdict、`session/cancel`）——它本质上就是一个 **DSH 适配器**。接入第二个 harness 时按下面的最小切分走，**不新建「harness 框架」**：

| 层 | 负责 | 不负责 |
|---|---|---|
| `ScoredLoop` | step／attempt／评分／停止条件 | harness 事件、进程、文件路径 |
| controller | 驱动、预算、当前 `verificationId`、人工恢复 | 猜某家日志字符串的含义 |
| 适配器（`DshVerifier`／`CodexExecVerifier`） | 启动、解析原生协议、取消、提取结果 | 决定整个 loop 是否通过 |
| `shell/` | 进程与字节流、退出与回收 | 理解 `turn.completed` |
| 结果落盘 | 校验后的标准 `verdict.json` + 原始日志 | 从自然语言推断运行状态 |

一期只做 `codex exec --json`（本地、一次性），App Server 留到 G10：

```bash
codex --ask-for-approval never exec --json --sandbox read-only \
  --cd <workspace> --output-schema <run>/verdict.schema.json \
  --output-last-message <run>/result.raw.json - < <run>/prompt.txt
```

上述参数形状已在本地 `codex-cli 0.154.0` 的 `--help` 上核对通过：`-a/--ask-for-approval never` 是**顶层**选项、必须写在 `exec` 之前（写成 `exec --ask-for-approval` 会失败）；`exec` 支持 `--json`（JSONL 到 stdout）、`-s/--sandbox read-only`、`-C/--cd <DIR>`、`--output-schema <FILE>`、`-o/--output-last-message <FILE>` 与用 `-` 从 stdin 读 prompt。**事件名与 JSONL 具体字段尚未实跑核对**（需要一次真实调用），适配器必须把它们当作本层知识并用注入夹具测试，不能靠文档字符串判断。另有 `codex exec review` 子命令，但它是面向代码变更的审查输出，**不符合本路径的评分契约**，接入需单独适配。

- `never` = 不请求审批，**不是**放开权限；`read-only` 适合阅读型审查，需要构建/测试的可放隔离副本，**不能把受限环境导致的失败当成代码失败**。
- 三个通道分开：stdout JSONL 跟踪活动、stderr 诊断、`result.raw.json` 候选结论；JSONL **按行组装**，stdout/stderr 不混读，未知事件保留并忽略、损坏行记诊断。
- **原始结果不是正式 verdict**：适配器先核验运行与 JSON 内容，再由公共层写 `.dsht/verify/<runId>/…`（DSH 由 child CLI 写，Codex 由适配器写）。
- 严格完成判定：未取消、未过期 ∧ 观察到本次 `turn.completed` ∧ 进程正常退出且输出读完 ∧ 结果通过 schema 与业务校验 ∧ 产出物指纹未变。**「非 0 退出但文件合法就以文件为准」只适用于 DSH**（结果由 child CLI 在 turn 完成后原子写）；其他 harness 默认按执行异常处理。
- 本地范围：Codex 必须在**能读到本次产出物**的环境里运行；`artifactVersion` 用现有的 SHA-256 指纹，无法比对的环境不启动验证。
- 一期**不做**：`start()`／`job` 接口、事件总线、`answer()`、多 harness 注册表、多评委投票。只有真正需要运行中审批（G10）时，才加 `CodexAppServerVerifier` 与 `answer(requestId, answer)`。

### 系统不变量：最初的问题与修法方向

下表是这些系统级不变量**最初**提出的问题与修法方向；**当前状态以下一节「收敛进展（系统不变量）」为准**，本段不再重复判定。

| 级别 | 问题 | 方向 |
|---|---|---|
| **P0** | **验证不可用被静默降级成自评**：verdict 缺失时用父 session 回复块，甚至可以 `Loop passed`。这把「独立验证」变成「尽量独立，失败就自评」 | `VerifierPort` 改三态 `verified / unavailable / cancelled`；`unavailable` **不消耗评审 attempt**、**不允许自评直接 PASS**；默认严格，旧行为需显式打开 `allowSelfFallback`（CLI 未暴露，见「收敛进展」），且 UI 必须显示 `⚠ verification fallback · self-reported` |
| **P0** | **verdict 路径并发碰撞**：两个 dsht 评同一 `kind/step/attempt` 会互相 `removeFile`／读到对方的分，身份校验挡不住 | loop 启动生成 `runId`，路径变 `.dsht/verify/<runId>/…`，verdict 内嵌 `verificationId` 并参与校验 |
| **P0** | **杀 child ≠ 取消 host 的 verifier turn**：agent 不是 child 的 OS 子进程，`SIGTERM child` 只证明 CLI 死了 | abort/timeout 先 `session/cancel(verifierSessionId)` 再终止 child；补 abort 与 timeout 两个「host 收到 cancel」测试 |
| P1 | agent 负责写控制面文件（路径/打开/写 JSON） | child CLI 解析 agent 的结构化结果并原子写 verdict：模型负责判断，程序负责协议 |
| P1 | verdict 路径假设父子共享文件系统 | verdict 属于 **client 侧**，不属于 host 上被评审 workspace 的路径；产出物仍由 host 上的 agent 写 |
| P1 | `score` 与 `status` 双事实源（9+retry？3+done？） | 模型只给事实 `score` + `blocked`；`passed/continue/exhausted` 一律由 `ScoredLoop` 推导 |
| P1 | 「verifier 不得改产出物」只是 prompt | 共享文件系统时做 artifact hash before/after，不一致即 `unavailable`；远端 host 需 host 侧只读权限（未闭环，如实标注） |
| P1 | `turnsCompleted` 可能被 reconnect/重复 idle 帧多加 | 绑定到本客户端发出的那次 prompt（prompt epoch）+ `true→false` 真实边沿去重 |
| P2 | verifier session 只增不减 | 一期明确「为审计保留、手动清理」 |
| P2 | verdict 清理 | 由 `runId` 目录整组管理 |
| P2 | README / `tui-design.md` 未同步 | ✅ 已同步（命令面 + 提前停下语义 + 配对哈希重记） |


### 收敛进展（系统不变量）

| 不变量 | 状态 | 实现与证据范围 |
|---|---|---|
| **verifier 不可用 ≠ 评审失败** | ✅ 已实现（live 未覆盖该分支） | `VerifierOutcome = verified \| unavailable \| cancelled \| needs-human`；`unavailable` 不消耗评审次数、重试 ≤2 次（共 3 次）后置 `phase: 'unavailable'`（`retryable: false` 直接报告）；默认严格，只有显式传 `ControllerOptions.allowSelfFallback`（CLI 不传）才允许父回复块并标 `⚠ verification fallback · self-reported`。证据：`loop-verify.test.ts`、`verifier.test.ts` |
| **一次 verification 只属于一个验证任务** | ✅ 已实现 | `runId`（`randomUUID`）+ 路径 `<verdictRoot>/.dsht/verify/<runId>/<kind>-<step>-<attempt>-<seq>.json` + verdict 内嵌 `verificationId = <runId>/<kind>/<step>/<attempt>/<seq>`，解析前校验；父进程另用 `loopVerifyIdentity` 只接受当前等待的任务。**重试与人工恢复各自换新 `seq`**，因此旧任务既不能覆盖新文件、也不会被接受。测试：重试换新身份、越轮/陈旧文件被拒 |
| **cancel 必须同时终止 local waiter 与 remote generation** | ✅ 已实现（远端为「有界确认」而非强保证） | 本地：`abortVerification()` 终止子进程组（SIGTERM→2s→SIGKILL），`stopLoop()` 后端口 signal 已 abort。远端：请求 `session/cancel` 并最多等 1s 确认，结果写进 reason（`confirmed/rejected/unconfirmed` / `host cannot cancel`），本地从不阻塞。测试：cancel-before-start 不建 session/不 spawn、abort-during-create 取消新 session、超时也取消 host、host 拒绝或永不回答仍有界返回、`runner` 对已 abort 的信号不 spawn。**仍不保证** host 一定停了那个 generation |
| **状态由状态机推导，而非模型自报** | ✅ 已实现 | `score` 是唯一推进依据；`blocked`／`abstained` 是仅有的两种能覆盖 `score` 的事实；`status` 只是标签。测试：`9 + retry` 前进、`3 + done` 消耗 attempt、`blocked` 终止、`abstained` 终止为 `needs-human` |
| **验证者可以提前停下，但拿不到分也跳不过范围** | 🟡 一期已实现（`code`／暂停属二期） | 两种停下（`blocked`＝不可完成、`abstained`＝需要人）都必须给 `reason` 且**不许带 `score`**；`readResultFields` 整块校验，不合格 → verdict 报 `unavailable` 重试而不当成停下；`settle` 只把它们映射到终态，`explanation` 与 `score` 都没有跳步能力。证据：`loop.test.ts` 硬校验表、`loop-verify.test.ts` 两种 verdict 的端到端、`loop-status.test.tsx` 的 `exit.reason` |
| **主 brief 与 verdict brief 用同一段提前停下措辞** | ✅ 已实现 | `earlyStopLines()` 由两处共用，避免工作侧与验证侧对同一字段给出不同规则；测试：`loop-contract.test.ts` 断言 `verdictBrief` 含该段 |
| **`turnsCompleted` 只统计真实回合** | ✅ 已实现，完成判定另加最小绑定（G3） | 只计 `running=true → false` 的真实边沿（`busySessions`），新世代清空；测试：孤立 idle 不计数、边沿 +1、重复 idle 不计数。child 侧再要求「**prompt 基线之后有 assistant 回复**」才解析 verdict；仍不绑定 host 的 turn/回复标识 |
| **契约文件不由模型持久化** | ✅ 已实现 | `verdictBrief` 要求「在回复正文最后给 JSON，不要用工具写文件」；child CLI 的 `writeVerdict` 解析后**原子写**（`.part` → rename）。verdict 根在客户端：`verdictRoot: process.env.DSHT_VERDICT_ROOT ?? localDirectory`。测试：`startup.test.ts`（并断言 `.part` 不残留） |
| **独立评审不得修改被评审对象** | 🟡 已检测 + 已验证期间不写入（G4 一期） | 请求显式声明被评审 workspace，指纹在该 workspace 上做 before/after SHA-256，变化即作废该轮结论并重验；验证在飞时 loop 不发送任何写入（`flushLoop` 门禁）。**仍不阻止**修改（需要独立用户/只读挂载）、不能检测「改完又改回」、不能归因；跨 step 的被评审范围不在覆盖内 |
| **`passed` 表示整份产出物满足全部要求** | 🟡 提示词层面已保证（G5 已实现；真正的程序化验收属 G11） | 整份记录（`from=1 && to=steps`）的最后一轮被标记为收尾轮：工作 brief 要求不得破坏前序要求，verdict brief 拿到前面每一轮的 rubric 全文并被要求逐轮复核、把回归计入扣分。**但「验证者是否真的逐条复核」取决于模型**，与 `score` 一样属于 §10 的诚实边界；dsht 保证的是「指令与 rubric 一定送达」+「范围不被夸大」 |
| **step 通过 ≠ run 通过，范围必须可见** | ✅ 已实现（G5） | `LoopProgress.scope`（`rounds 1–3/10 · selected range`）由 `coversWholeProtocol` 推导，UI 与 headless 在 `passed` 时都打印；部分范围、从中间开始、非最后一轮都不会出现全量复核段。测试：`loop.test.ts`（谓词）、`loop-protocols.test.ts`、`loop-verify.test.ts`（端到端 scope）、`loop-status.test.tsx`、`startup.test.ts`（headless 行） |
| **run 有全局预算** | ✅ 已实现 | `--deadline <minutes>`／`DSHT_LOOP_DEADLINE` → `Controller.deadlineMs`，到期为终态 `deadline`（不消耗 attempt、取消在飞验证、迟到 verdict 不复活）；另有每次验证的故障重试 `VERIFIER_RETRIES` 与不可重试分类。测试：`loop.test.ts`、`loop-verify.test.ts`（deadline 中止 + 迟到 verdict）、`cli.test.ts`（非法值） |
| **协议在 run 内冻结** | ✅ 已实现 | 启动时 `loopProtocolFor` 读一次记录并用闭包固定（标题、rubric、standard、vars、默认值），`LoopLimits` 只解析一次；YAML 在构建期内联进 `loop-prompts.generated.ts`，运行中改磁盘不影响本次 run。测试：`loop-protocols.test.ts`、`commands.test.ts` |
| **验收由程序组合** | 🟡 一期已实现（G11） | 判定 = 身份/归属 ∧ 产出物未被改动（G4）∧ 本轮产出物小节存在（`artifactMarker`，客户端自己核对）∧ 分数达阈值；缺小节时 `score` 被置空并按失败尝试处理，任何分数都不能覆盖。**未做**：需要 host 侧执行的必需测试/接口检查 |
| **人工阻塞不重复消耗评审次数** | ✅ 一期已实现 | child 检测未决审批/提问 → `needs-human` 终态（不重试、不消耗 attempt、headless exit 3）；测试：`startup.test.ts` 的 child 检测、`verifier.test.ts` 的标记解析＋取消、`loop-verify.test.ts` 的不重试与 headless 映射。**二期**：`/loop answer` 恢复原 turn |
| **run 有全局预算** | 🟡 已实现（缺细分分类） | `--deadline`／`DSHT_LOOP_DEADLINE` → `deadlineMs`；到期终态 `deadline`，取消在飞验证、不重试、不消耗 attempt。`retryable:false` 的失败直接报告。**尚缺**：断连与配置错误的更细重试分类 |
| **协议是记录，命令只有一个** | ✅ 已实现（G7） | `/loop <name>` 从 `loop.yaml` 取记录，`controller/loop-protocols.ts` 是唯一装配点；`/design-review`、`/designdoc-review`、`/verify` 与三个协议文件（`design-review.ts`／`designdoc-review.ts`／`loop-prompt.ts`）已删除。测试：`loop-protocols.test.ts`、`commands.test.ts`、`ui/commands.test.ts` |
| **run 内协议冻结** | ✅ 已实现（G9；YAML 为构建期内联） | 记录在 `loopProtocolFor` 里读一次并由闭包保存（标题/rubric/standard/vars/默认值），`LoopLimits` 在 `startLoop` 解析一次；未知占位符与保留名在生成期失败。**将来若启用运行时加载**，仍需保留这层快照 |
| verifier session / verdict 清理 | ⬜ 未做 | 一期明确「为审计保留、手动清理」；`runId` 目录已可整组删除 |
| 一份被评审文档一个产出物文件 | ✅ 已实现 | `designdoc-review` 的 `artifact` 是模板 `{{path}}.review.md`（落在被评审文档旁边），换文档重跑不会把两次审查写进同一个文件；schema 只允许 `artifact` 用记录 vars（`{{step}}` 会被拒），`*.review.md` 已被 `.gitignore` 覆盖；用例：`loop-prompts.test.ts`、`loop-protocols.test.ts`（记录列表按默认值与覆盖各渲染一次） |
| verifier 知道它在评审哪一份文档 | ✅ 已实现 | `verdictBrief` 带上本次 run 解析后的记录变量（`path=…`）并要求产出物属于同一对象；`designdoc-review` 的 `artifactMarker` 与小节写入指令都把文档写进标题，客户端与 verifier 用的是同一个标题（`VerdictBrief.marker`）；用例：`loop-protocols.test.ts`（默认值、`vars` 覆盖、prompt 里的 marker == `protocol.artifactMarker(step)`）、`loop-prompts.test.ts`（换文档后标题随之改变）、`loop-contract.test.ts` |
| 一份完整 verdict 不会因为转义/占位符被丢弃 | ✅ 已实现 | `parseVerdict` 从 `{"` 起按字符串状态取候选，并对 JSON 未定义的转义做一次补齐；用例：`loop-contract.test.ts` 的两种真实形态 |
| 缺失 verdict 的原因来自子进程自己的诊断 | ✅ 已实现 | `childFault()` 认出本进程自己写的那两句（`no JSON verdict in the reply` / `no reply committed after the turn`），不再退化成 `stderrClass unknown`；用例：`cli/verifier.test.ts` |
| verifier 会话可只读观察、不必接管 | ✅ 已实现 | 会话由 client 登记为一个只读**输出源**（`createdBy: 'verifier'`、parent = 被评审会话、detail = verifier 名），`Ctrl+O`／整屏 peek 视图用 `session/follow` 跟随它，不选中、不写入；运行停止后源仍在列表里（`state: 'ended'`）。`/loop` 启动时会在 transcript 留一条**回显栏**（`ShellBlock.kind: 'note'`），每次创建验证会话都把这条栏重指到新会话，所以点它总是打开当前那一次验证。证据：`tests/controller/sources.test.ts`、`tests/ui/shell-blocks.test.ts`、`tests/ui/app.test.tsx`；机制与取舍见 `slash.md` §7.5 |
| README / `tui-design.md` 同步 | ✅ 已做（G7 同批） | `README.md`/`README.zh.md` 命令表改为 `/loop <name>`（删除 `/design-review`、`/verify` 行）并重记 `README.i18n.yaml` 哈希；`tui-design.md` §3.4／附录 A 已按新命令面与文件集更新 |


**client 侧 verdict 路径**：默认 `<客户端目录>/.dsht/verify/<runId>/…`，`DSHT_VERDICT_ROOT` 可覆盖。默认值刻意选在客户端目录——这是客户端**始终被允许写入**的位置；把 verdictRoot 指到 state 目录时，运行环境的文件沙箱会以 `ENOENT: mkdir` 拒绝写入，表现为 `⚠ verification unavailable · verifier failed: ENOENT…`。也正因如此，`unavailable` 的原因必须出现在 headless 进度行里（已修），否则故障不可观测。
**已知残余风险**：若某次真实 turn 的 `running=true` 帧完全未被观察到，`--wait` 会等到超时而非立即返回。当前取舍是「宁可超时，也不把重放的 idle 当成完成」；超时走 `unavailable`，不消耗评审次数。探针中每次 turn 都能观察到 `true`。


## 10. 诚实边界

* **定位**：本机制是叠在 DSH 内层 agent loop 之上的 **evaluator–optimizer 外层循环**——内层由 host 的工作 agent 与验证 agent 自己选工具、执行、读结果；外层由 dsht 的确定性状态机分配步骤、调用验证、回灌意见、控制预算与终止。外层用确定性状态机是刻意的，不需要让模型决定每次状态转移，也不需要引入规划器或多代理框架。
* dsht 无法证明验证者真的独立：它只能保证**独立进程、独立 session、无本对话上下文**，以及 verdict 文件的格式与轮次一致。`score`/`status` 终究是模型给出的判断。
* **进程与 session 的隔离不等于权限隔离**：独立进程仍以同一 OS 用户运行、继承同一环境（含 `DSH_TOKEN`），因此**不能**单独保证「verifier 不能写被评审对象」。一期能做的是：请求显式声明被评审 workspace、在验证前后比对产出物指纹、发现变化就作废该轮结论并重验，且验证期间 loop 不写入（G4）；**阻止**修改需要 OS 级隔离（独立用户或只读挂载），**归因**与「改完又改回」的检测都做不到，而且指纹只在产出物对客户机可读时有效。
* **收尾轮的回归复核是提示词层面的强制，不是程序化验证**：dsht 保证「整份记录的最后一轮一定拿到前面每一轮的 rubric 与逐轮复核指令」，也保证 `passed` 的范围不被夸大（`scope`）；但「验证者是否真的逐条复核、是否把回归算进分数」仍取决于模型，和 `score` 本身一样不可证明。真正的程序化组合验收（必需测试/接口的硬条件）属 G11。
* **产出物形态检查也只能证明形态**：`artifactMarker` 能证明「这一轮的结论写进了那份文件」，不能证明写进去的内容正确——内容仍由验证者的 `score` 判断，而 `score` 是模型给的。需要 host 侧执行的必需测试/接口检查（G11 二期）才能真正把「硬条件」变成客户端可验证的事实。
* `--wait` 依赖 host 的 `api-session/status` 事件；若某 deployment 不发这个事件，子进程会等到超时（超时 → `unavailable`，不消耗 attempt），不会静默挂死。
* fork 自身依赖「能重新启动自己」：`execPath + execArgv + argv[1]`。**tsx 方式（`npx tsx src/cli/index.ts`）已实跑；`dist/cli/index.js` 尚未验证**，远端非共享文件系统下的 verdict 路径也未验证。

---

## 11. 历史附录（已被取代的机制与现场记录）

正文只描述**当前行为**；本节保留旧机制与旧 live 记录，供追溯用，**不作为当前契约的证据**。

**旧目标（本文第 1 版）**：把每一轮的打分者从「被评审 session 自己 spawn 的 subagent」换成「dsht fork 出的独立进程」。`resultContract(..., 'subagent')` 的措辞仍保留给无 verifier 的环境，但 CLI 默认构造 verifier，forked 才是主路径。

**旧失败语义（已废弃）**：

| 情况 | 旧行为 | 现行为 |
|---|---|---|
| verdict 文件缺失 | 回退到父 session 回复块 | `unavailable` → 重试 ≤2 次 → 默认结束，**不通过**（§6） |
| 文件非法 / 轮次不匹配 | 视为无 verdict，**消耗一次 attempt** | 视为无 verdict → `unavailable`，不消耗订正次数（§6） |
| 子进程超时 | 回退 | 取消 → `unavailable` → 重试（§6） |
| 兜底与主路径 | 第 4 条要求结尾块「共用 parser，不会漂移」 | 严格模式不使用该块；G6 一期已把措辞改成「结尾仍需给出块（自述记录），评分以独立验证为准，不要自评」（§4.3、§9） |
| 取消 | 记为「同时终止 local waiter 与 remote generation，已闭环」 | 本地已回收、远端只是请求（§7、§9 G2） |

**旧现场记录（verdict 路径不含 `runId`/`verdictRoot` 段）**：

- **fork 全链路**（`/tmp/fork.mts`，4 秒）：父进程 `createVerifierSession` → 子 `dsht`（`execPath + execArgv + argv[1]`，tsx 下）→ 子 session 自动退出（`Turn finished`）→ 文件 `.dsht/verify/probe-1-1.json` → `parseVerdict` 得到 `{"score":6,"status":"retry"}`。
- **兜底生效**：子进程失败的那次整轮运行里，父进程用回复块（不存在的 verdict 文件 → fallback）判定并 `Loop passed`，没有卡死也没有误判。这是旧语义（默认严格之前）的现场，**不能**用来证明当前默认行为。
- **整轮 forked review 端到端成功**（`/designdoc-review --to 1 --tries 1 loop.md --headless`）：
  * 子进程输出 `Turn finished`（自己的 session 跑完并自动退出），不再有 snapshot 超时；
  * `.dsht/verify/designdoc-review-1-1.json`（5720 B）由**验证 session**写出；
  * 内容为 `{"kind":"designdoc-review","step":1,"attempt":1,"score":8.5,"status":"done","evidence":"独立复跑全部关键证据…（git log / git status / wc -l / npm run typecheck / npm test 两轮 352 passed）"}`；
  * 父 loop 随后 `Loop passed · Connected`，`EXIT=0` —— 与验证进程给出的 8.5 ≥ 8 一致。

> 说明：以上记录取自是 verdict 通道改为「child CLI 解析回复并原子写、路径移到 client 侧」**之前**的运行；其中的 verdict 路径不含 `runId`/`verdictRoot` 段，数字未重新采集。当前机制以 §4.5 与 §6 为准。

**旧固定锚点**：`b7c0230`（fork 验证的 `src/` 批次在 `6f67f87` 落地之前的写作锚点）；`git diff --stat b7c0230` 之类的对比只对那一段历史有意义。
