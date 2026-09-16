# dsht verify loop 设计文档（评审稿）

> 状态（单一事实源）：**全部系统不变量已闭环并 live 验证**——verdict 由 child 从自己的回复解析、原子落盘到 client 侧路径并被父进程读回（`Turn finished` → `Verdict written to …/.dsht/verify/<runId>/…` → `score 8.8 · Loop passed · EXIT=0`）。早期现场记录见 §8 第 6 条；未验证的是另一种启动形态（`dist/cli/index.js`）与远端非共享文件系统。逐步状态见 §9「收敛进展（系统不变量）」。
> 目标：把「每一轮由谁来打分」从**被评审 session 自己 spawn 的子代理**，换成 **dsht 自己 fork 出的独立进程**，verdict 通过**文件**回传。

**读者**：改动 `tui/` 验证循环（`/design-review`、`/designdoc-review`、`/loop`、`/verify` 的评分与验证路径）的维护者与评审者。只想使用这些命令的人看 `README.md`（其命令表已登记 `/design-review`、`/loop`、`/verify`，尚无 `/designdoc-review` 行，见 §9）。

**本文记录**：为什么改（§1）、机制与依赖规则（§2–§3）、接口与 verdict 文件契约（§4）、受影响的模块（§5）、失败语义、闭环语义与取消（§6–§7）、测试覆盖（§8）、未完成项、系统不变量的最初问题与闭环进展、待决策（§9）、机制本身的能力边界（§10）。

**本文不记录**：面向使用者的命令用法与选项（`README.md`；本路径新增的内部开关与环境变量例外，见 §4.5、§6、§9）；`tui/` 整体架构与分层（`tui-design.md`；其中 §3.4 的循环协议一段仍描述旧的 subagent 路径）；贡献政策与提交／版本／发布／验证流程（父仓库 `CONTRIBUTING.md` 只声明贡献政策——当前不受理外部 PR；流程的事实源是 `tui-design.md` §7.4–§7.5、§7.7；文档集的登记与权威规则见其 §7.3，`tui/` 无独立 `CONTRIBUTING.md`）；计费（`cost.md`）；宿主协议字段的规范定义（父仓库 `docs/event-producer-consumer.md` 的事件索引与 `packages/api/session-controller/src/types.ts` 的字段类型；本文只记消费面）。

**单一事实源**：本文是这条验证路径（fork 验证 loop）具体机制的事实源；与 `README.md`、`tui-design.md` 就本路径的描述冲突时以本文为准——但这条主张目前是**单方**的：`tui-design.md` §7.3 的文档集登记未收录本文，其「维护者基线以本文件为准」也未回链本文（见 §9）。「本文不记录」让出的范围（`tui/` 架构与分层、贡献与发布流程、计费、宿主协议字段的规范定义）仍以各自文档为准，不因本行覆盖；接口签名以 `src/` 为准。**本文不是规范**：它是设计记录，§9 未定项在定稿前可变。

---

## 目录

| 想知道什么 | 看 |
| --- | --- |
| 为什么要 fork 验证（已修的真实故障） | §1 |
| 机制全貌与依赖方向 | §2 |
| 一轮的完整时序（含取消/替换） | §3 |
| 接口、port 与 verdict 文件契约 | §4.1–§4.4 |
| CLI 参数与子进程构造 | §4.5 |
| 改了哪些模块 | §5 |
| 出错时会怎样 | §6 |
| 验证意见怎么回灌、何时早停、各终止状态 | §6.1 |
| 状态归谁、怎么取消、子进程凭据 | §7 |
| 测试到什么程度 | §8 |
| 还没做什么、哪些决策悬而未决、系统不变量的最初问题与闭环进展 | §9 |
| 机制本身不能保证什么 | §10 |

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

另有一条架构动因：in-host subagent 与产出物在**同一进程、同一 session**，且 verdict 只能由被评审者自己复述（自我报告），独立性和速度都不理想。

---

## 2. 架构总览

```
                       ┌─────────────────────────── parent dsht ───────────────────────────┐
                       │                                                                    │
  slash /designdoc-review ──▶ commands.runCommand ──▶ Controller.startLoop(protocol, limits) │
                       │                                      │                             │
                       │                            ScoredLoop（纯状态机，无 I/O）            │
                       │                                      │                             │
                       │   session/prompt ◀── flushLoop ──────┘                             │
                       │        │                                                           │
   host ◀──────────────┘        │ agent-status running:false                             │
                                ▼                                                        │
                        Controller.trySettleLoop()                                       │
                                │                                                        │
              protocol.verify? ─┤ 否 ─▶ parseLoopResult(回复正文最后一块) ─▶ settleWith     │
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
                                └──── outcome.result ?? 回复块兜底 ───┘
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
 6. parent: file = verdictFile(verdictRoot, runId, kind, step, attempt)
            = <verdictRoot>/.dsht/verify/<runId>/<kind>-<step>-<attempt>.json   （CLI 把 verdictRoot 设为客户端进程 cwd，`DSHT_VERDICT_ROOT` 可改指）
 7. parent: VerifierPort.verify({verificationId,kind,step,attempt,prompt,title,file}, signal)
 8.   ProcessVerifier:
      a. ensureDirectory(<verdictRoot>/.dsht/verify/<runId>) + removeFile(file)  ← 先删除，杜绝陈旧文件被读成本轮结论
      b. Actions.createVerifierSession('[dsht-verify] …')      ← session/create + session/rename（不切换父视图）
      c. runProcess(node, [...execArgv, entry, --url … --session <id> --prompt <brief> --verdict <file> --verdict-identity <id> --wait --headless --no-memory-log])
 9. child dsht: 选中该 session → 发送 prompt → --wait 等到本 session 的回合结束 → 自动退出
10. child 内的 agent: 读产出物、自己取证，把 verdict JSON 放在回复正文最后一块（§4.3）
11. child CLI: parseVerdict 解析该回复 → 原子写 file（先写 `.part` 再 rename）
12. parent: 子进程退出 → storage.readText(file) → parseVerdict(text, {verificationId,kind,step,attempt})
13. parent: result = outcome.result ?? parseLoopResult(父 session 回复最后一块)   ← 兜底
14. parent: ScoredLoop.settle(result) → continue（发 followUp）/ passed / exhausted / blocked
15. parent: loop.note(说明) → UI 进度行追加显示；下一次 sent() 时清空
```

取消/替换路径：`stopLoop()` / `forgetLoop()`（含切换 session）→ `abortVerification()` → 子进程收到 abort（`SIGTERM`→`SIGKILL` 宽限），且回调返回时用 `this.loop !== loop || !loop.active || !loop.settled` 拒绝「活过头的验证结果」。

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
  verificationId: string; // '<runId>/<kind>/<step>/<attempt>'，verdict 必须回述
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
export function verdictFile(directory: string, runId: string, kind: string, step: number, attempt: number): string;
```

### 4.3 文件契约（`src/controller/loop-contract.ts`）

```ts
export function resultContract(kind, limits, step, attempt, brief?, mode: 'subagent'|'forked' = 'subagent'): string[];
export function verdictBrief(brief: VerdictBrief): string;   // 子 session 收到的完整 prompt
export function parseVerdict(text: string, expect: {verificationId,kind,step,attempt}): LoopResult | undefined;
```

* `mode: 'forked'` 时：主 brief 明确「独立进程打分、禁止 spawn 子代理/自评」，**但保留 ` ```dsht-loop ` 块作为兜底**（第 4 条），这样兜底与主路径共用同一个 parser，不会漂移。
* `verdictBrief` 明确三件事：你没有本对话上下文；不许改产出物；**verdict 由客户端从你回复正文的 JSON 落盘**，并给出唯一允许的 JSON 形状。
* `parseVerdict` 把回复当**不可信输入**：枚举正文里每个顶层平衡 JSON 对象（最近的优先），先校验 `verificationId` 必须与本轮一致，再校验 `kind/step/attempt`，否则视为无 verdict（防陈旧文件误判）。

verdict 文件形状：

```json
{"verificationId":"<runId>/designdoc-review/2/1","kind":"designdoc-review","step":2,"attempt":1,"score":7.5,"status":"retry",
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
| `--verdict <path>` / `--verdict-identity <id>` | 子进程交付 verdict 的通道：解析自己 session 回复正文最后一块，**原子写**到该路径；identity 即 `<runId>/<kind>/<step>/<attempt>`，写入前必须与本轮一致 | 模型只在回复里给 JSON，协议文件由 child CLI 写（`src/cli/startup.ts` 的 `writeVerdict`，解析不到时留空并记日志）；`--verdict` 缺 identity 直接拒绝（`src/cli/dsht.tsx`） |
| `DSHT_VERDICT_ROOT` | 改写 verdict 根目录（默认客户端进程 cwd） | 本路径新增的内部环境变量；被评审 workspace 在本机不可写时改指别处，落点见 §9 决策 B |
| `queries.turnsCompleted` | 已结束回合的单调计数 | `--wait` 用它而不是轮询 `running`，否则短回合会被漏掉 |
| `Actions.createVerifierSession(title)` | `session/create` + `session/rename`，**不切换**父视图 | 命名即标记（host 不支持创建时命名，也无 subagent 命名能力） |

`session/rename` 已 live 验证：`{"title":"…","seq":3}`，标题出现在 session 列表的 `projections.values.title`。

---

## 5. 模块改动清单

本批**未提交**改动（写作时点相对 `b7c0230` 这个固定锚点）；完整文件集要两条命令合起来才全：`git diff --stat b7c0230`（已跟踪改动）与 `git status --porcelain`（未跟踪的新文件——`git diff` 不显示它们）。下表只列与这条验证路径有关的文件。

| 文件 | 改动 | 层次约束 |
|---|---|---|
| `src/transport/events.ts` | `jobs` 帧读 `frame.jobs ?? frame.items` | transport |
| `src/controller/connection.ts` | 控制帧解析失败 → 降级 `controlError`，不断连 | controller |
| `src/controller/controller.ts` | `ready()` 用 `loop.sessionId` 重挂；`turnsCompleted`；`verifier` 选项；`verifyRound`/`settleWith`/`abortVerification`；`queries.forkedVerification`；`Actions.createVerifierSession` | controller |
| `src/controller/loop.ts` | `LoopProtocol.verify?`；`readResultFields`；`ScoredLoop.note()` | controller |
| `src/controller/loop-contract.ts` | `resultContract(..., mode)`；`verdictBrief`；`parseVerdict` | controller |
| `src/controller/verifier.ts` | **新增** port + verdict 路径 | controller |
| `src/controller/design-review.ts` / `designdoc-review.ts` | `forked` 参数 → `mode` + `verify()`；抽出 `standardFor()` | controller |
| `src/controller/commands.ts` | 两个 review 命令传 `queries.forkedVerification` | controller |
| `src/controller/index.ts` | 导出 `designdocReviewProtocol` 等 | controller |
| `src/slash/parse.ts` | `/designdoc-review <path>` 语法（复用 loop flags） | slash |
| `src/slash/registry.ts` / `index.ts` | 命令表与导出各加一行 | slash |
| `src/session/controller.ts` | `createNamedSession()`（创建+命名，不选中） | session |
| `src/shell/runner.ts` / `index.ts` | `runProcess()`（`runShell` 与它共用 `spawnLines`） | shell |
| `src/cli/verifier.ts` | **新增** `ProcessVerifier`（fork + 读文件 + 超时 + 取消） | cli |
| `src/cli/startup.ts` | **新增** `plan.prompt` / `plan.wait` / `plan.verdict` / `waitForTurn` / `writeVerdict`（解析回复后原子写 verdict 文件） | cli |
| `src/cli/dsht.tsx` | `--prompt` / `--wait` / `--verdict` / `--verdict-identity` 解析；构造 `ProcessVerifier`（`DSHT_NO_VERIFY=1` 可关掉）；verdict 根设为客户端进程 cwd（`verdictRoot`，`DSHT_VERDICT_ROOT` 可改指） | cli |
| `src/contracts.ts` | `LoopProgress.note?` | types |
| `src/ui/chat/loop-status.tsx` | 进度行追加 note | ui |
| `.gitignore` | 忽略 `.dsht/` | — |

---

## 6. 失败语义

| 情况 | 行为 | 结果 |
|---|---|---|
| verdict 文件合法 | 用它 | 正常 continue/passed/exhausted/blocked |
| 文件缺失（子进程超时/被杀/没写） | 回退到父 session 回复块 | 回复块也没有 → 本轮算失败，消耗一次 attempt |
| 文件非法 / `step·attempt·kind` 不匹配 | 视为无 verdict | 同上（**不会**用陈旧结论得分） |
| 创建验证 session 失败 | 不 spawn，`note` 说明 | 回退 |
| 子进程非 0 退出但写了合法文件 | 以文件为准 | 正常 |
| 评审被取消 / 切 session | `abortVerification()`，子进程进程组被终止 | 结果被丢弃，不 settle |
| 验证慢 | `timeoutMs`：`DSHT_VERIFY_TIMEOUT_MS`，默认 20 分钟（`src/cli/dsht.tsx`） | 超时 → 回退 |

不变量：**任何路径都不会用「上一轮的文件」或「别的 session 的 idle」给本轮打分**。

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
* **无进展早停**：`ScoredLoop` 记录「连续未提高」次数（`noProgress`）。`score > 该 step 此前的 best` 时清零；否则（`attempt > 1` 时）加一。累计到 **`STALL_STREAK = 2`** 时进入 `phase: 'stalled'`（`LoopStepResult.kind === 'stalled'`）。
  * 为什么是 2 而不是 1：独立验证者对同一份产出物本来就有抖动，一次持平可能是噪声；**连续两次**不提高（含严格下降）才说明确实不收敛。这也是「必须严格下降」与「连续两次无提高」两种激进程度之间的折中——严格下降等于容忍任意多次持平，对收敛的判定太弱。
  * 想切换成「必须严格下降」只需把 `const STALL_STREAK = 2` 改成 `1`（那样一次持平或下降即停），不需要改其它代码。
  * 第一个 attempt 永不早停（`attempt > 1` 才计数）；分数缺失（没有 verdict 也没有回复块）不算「不提高」，它照常作为一次失败尝试消耗预算，避免把解析失败误判成不收敛。
* 终止状态要区分开：`passed`（达标）、`exhausted`（用尽 tries 但分数每次都在提高）、`stalled`（连续两次没有提高）、`blocked`（验证者证明任务不可完成）、`unavailable`（验证不可用，见 §9「收敛进展」）、`cancelled`（人为取消）。`--headless` 下只有 `passed` 是 exit 0。

## 7. 状态所有权与取消

* loop 状态只存在于 client 内存（`Controller.loop`），host 不感知；进程退出即消失（沿用既有设计）。
* 取消触发：输入文字、`/cancel`、Esc、Ctrl+C、**切换 session**；**重连不取消**（host 还在跑，重连后按 §1#3 重挂 session）。
* 验证进程与该次尝试同生命周期：`stopLoop`/`forgetLoop` 一定会 abort 子进程，避免孤儿进程继续烧 token。
* 子进程凭据：继承父进程环境（含 `DSH_TOKEN`），`--url` 用操作者原始写法，`--auth-dir` 显式透传；子进程额外带 `--no-memory-log`，避免污染父的 memory log。

---

## 8. 测试

`npm test` 全绿、`npm run typecheck` 绿（具体数字以命令输出为准，不在本文复制）。

| 文件 | 覆盖 |
|---|---|
| `tests/controller/loop.test.ts` | 判定语义：`score` 决定前进/重试而 `status` 不能否决分数、`blocked` 在任意分数下终止；`readResultFields` 对 findings（≤8 条）与 evidence 的上限；连续无提高达到阈值进 `stalled`（首个 attempt 不早停、分数提高即清零、下降同样计数）；`stepLabel` 快照 |
| `tests/controller/loop-contract.test.ts` | verdict 解析（裸 JSON/围栏/散文）、陈旧或非法文件被拒、`score:12` 被丢弃、prompt 含文件与身份、forked/subagent 两种措辞 |
| `tests/cli/verifier.test.ts` | 注入式 runner（不 spawn）：文件回读并绑定轮次；陈旧文件不被读；**已 abort 的 signal 不 spawn**；argv 含 `--session/--prompt/--verdict/--verdict-identity/--wait/--headless`；无 session 时给 note；取消传导 |
| `tests/cli/startup.test.ts` | `--prompt` + `--wait`：busy→idle 才结束；仅 `running=true` 不算结束；child 把回复里的 verdict **原子写**入 `--verdict` 文件（断言 `.part` 不残留） |
| `tests/controller/loop-run.test.ts` | idle 之后才提交的回复块仍被读到（**先等客户端发布 `status: 'Idle'`**，保证 `idle→reply` 顺序，否则测不到回归）；坏控制帧不杀死 loop；重连后按 loop 的 session 重挂 |
| `tests/controller/loop-verify.test.ts` | 假 port 驱动 `verifyRound`：forked verdict 决定轮次且主 brief 不再要求自评；无文件回退到回复块并记 note；两者都没有则消耗一次 attempt；取消后迟到的 verdict 不复活循环；无 verifier 的主机仍读回复块 |
| `tests/controller/designdoc-review.test.ts` | 协议自述文档/轮次/marker；brief 只含一轮并带本轮 rubric；follow-up 指回产出物；`/verify` 标准叠加在轮次 rubric 之上 |
| `tests/controller/commands.test.ts` | `/designdoc-review` 启动 loop：brief 含文档路径与 `"kind":"designdoc-review"`、progress 轮次标签、反向区间在发 prompt 前被拒 |
| `tests/ui/commands.test.ts` | `/designdoc-review` 语法与选项：带引号路径、非法行与错误消息、`COMMAND_POLICY`、唯一前缀补全 |
| `tests/transport/events.test.ts`、`tests/ui/status.test.ts` | `jobs` 与 `items` 两种字段名（transport 解析与 UI 投影各一侧） |

live 证据（真实 host `127.0.0.1:3080`）：

1. **评分回读**：`--tries 1` → `best 4 / exhausted`，即 §1 的故障修复后 loop 能读到真实评分（修复前恒为 `best 0`）。
2. **fork 全链路**（`/tmp/fork.mts`，4 秒）：父进程 `createVerifierSession` → 子 `dsht`（`execPath + execArgv + argv[1]`，tsx 下）→ 子 session 自动退出（`Turn finished`）→ 文件 `.dsht/verify/probe-1-1.json` → `parseVerdict` 得到 `{"score":6,"status":"retry"}`。
3. **命名生效**：`listSessions` 中该 session 标题为 `[dsht-verify] plumbing probe`，`cwd` 正确。
4. **forked 模式在 CLI 生效**：进度标题为 `Designdoc review · loop.md · forked`。
5. **兜底生效**：子进程失败的那次整轮运行里，父进程用回复块（不存在的 verdict 文件 → fallback）判定并 `Loop passed`，没有卡死也没有误判。
6. **整轮 forked review 端到端成功**（`/designdoc-review --to 1 --tries 1 loop.md --headless`）：
   * 子进程输出 `Turn finished`（自己的 session 跑完并自动退出），不再有 snapshot 超时；
   * `.dsht/verify/designdoc-review-1-1.json`（5720 B）由**验证 session**写出；
   * 内容为 `{"kind":"designdoc-review","step":1,"attempt":1,"score":8.5,"status":"done","evidence":"独立复跑全部关键证据…（git log / git status / wc -l / npm run typecheck / npm test 两轮 352 passed）"}`；
   * 父 loop 随后 `Loop passed · Connected`，`EXIT=0` —— 与验证进程给出的 8.5 ≥ 8 一致。
   由于文件存在且 kind/step/attempt 全部匹配，`verifyRound` 走的是 `outcome.result`（文件）而不是兜底分支。

> 说明：以上 2、6 两条是 verdict 通道改为「child CLI 解析回复并原子写、路径移到 client 侧」**之前**的现场记录，其中的 verdict 路径不含 `runId`/`verdictRoot` 段；当前机制以 §4.5 为准，数字未重新采集。

---

## 9. 未完成 / 待评审决策（**评审重点**）

**P0 —— 仍未验证的一步（启动形态与部署）：**

fork 路径已在真实 host 上跑通（§8 第 6 条：`npx tsx src/cli/index.ts` 启动方式下整轮 forked review 端到端成功）。仍未验证的是另一种启动形态（`dist/cli/index.js`）与远端非共享文件系统：自 fork 配方 `process.execPath + execArgv + argv[1]` 目前只在 tsx 方式下实跑过。CLI 侧构造已完成：`src/cli/dsht.tsx` 构造 `ProcessVerifier`（`DSHT_NO_VERIFY=1` 关掉即无 verifier、回退到父 session 回复块，`queries.forkedVerification` 随之为 false），超时取 `DSHT_VERIFY_TIMEOUT_MS`（默认 20 分钟）；controller↔verifier 的回退/取消/note 由 `tests/controller/loop-verify.test.ts` 用假 port 覆盖（见 §8）。

**待决策：**

| # | 问题 | 选项 |
|---|---|---|
| A | forked 是默认还是 opt-in？ | 建议先 `--forked` 显式开关，live 跑通后再翻默认。当前实现是「有 verifier 就 forked」（`controller.queries.forkedVerification`），CLI 默认构造 verifier，只能靠 `DSHT_NO_VERIFY=1` 关 |
| B | ~~验证用哪个目录~~ **已定（实现即结论）** | verdict 属于 **client 侧**：`src/cli/dsht.tsx` 传 `verdictRoot: process.env.DSHT_VERDICT_ROOT ?? localDirectory`（子进程所在机器的 cwd，`DSHT_VERDICT_ROOT` 可改指），不是远端 host 上被评审 workspace 的绝对路径——那条路径对 host 侧的 agent 不存在。实现与测试见 §4.5、§9「收敛进展」 |
| C | 验证超时是否与 `--timeout` 合并 | 默认值已定（`DSHT_VERIFY_TIMEOUT_MS`，20 分钟）；未定的是它是否该跟 CLI 的 `--timeout` 共用一个开关 |
| D | verdict 文件是否保留 | 现在读完不删（便于审计、便于人看）；落点是客户端进程 cwd 下的 `.dsht/verify/<runId>/`（`DSHT_VERDICT_ROOT` 可改指，§4.5），默认就落在被评审 workspace 里，由 `.gitignore` 的 `.dsht/` 排除。是否应清理旧轮次？ |
| E | `/loop <score> <tries> <prompt>` 是否也 forked | 现为否（自由 prompt 无 rubric，独立验证价值低） |
| F | 子进程的模型/preset | 目前继承默认；是否允许 `--verify-model` 用更便宜/更快的模型做验证？ |
| G | 命名前缀 | 现为 `[dsht-verify] <title> · <step>/<attempt>`；是否需要可配置前缀（host 无 subagent 命名能力，只能用 session 标题做标记） |

**其它未做（状态以本节「收敛进展」表为准，此处只记门禁与理由）：**`README.md`／`README.zh.md` 尚未同步——命令表没有 `/designdoc-review` 行、`/design-review` 一段仍按 subagent 路径描述，双语对与 blob 哈希门禁见 `README.i18n.yaml`，宜独立提交；`tui-design.md` §3.4 的循环协议一段仍是旧路径，也未回链本文；其 §7.3 的文档集登记未收录本文，「维护者基线以本文件为准」与本文开头的单一事实源声明尚未互相确认。`DESIGN-DOC-REVIEW.md`（设计文档审查的产出物）与本文一样**未纳入版本控制**；本批改动**尚未 commit**。

---

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
| P2 | README / `tui-design.md` 未同步 | 实现收敛后统一更新 |


### 收敛进展（系统不变量）

| 不变量 | 状态 | 实现与证据 |
|---|---|---|
| **verifier 不可用 ≠ 评审失败** | ✅ 已闭环 | `VerifierOutcome = verified \| unavailable \| cancelled`；`unavailable` 不消耗 attempt、先重试 2 次（共 3 次）再置 `phase: 'unavailable'`；默认严格，只有调用方显式传入 `ControllerOptions.allowSelfFallback`（`src/controller/controller.ts`；CLI 不传，命令行上等同关闭）才允许回复块，且进度行固定显示 `⚠ verification fallback · self-reported`。测试：`loop-verify.test.ts`（重试次数/attempt 不变/标记精确匹配）、`verifier.test.ts`（三态各自断言） |
| **一次 verification 只属于一个 run** | ✅ 已闭环 | `runId`（loop 启动时 `randomUUID`）+ verdict 路径 `<verdictRoot>/.dsht/verify/<runId>/…`（CLI 把 `verdictRoot` 设为客户端进程 cwd，`DSHT_VERDICT_ROOT` 可改指，见 §4.5） + verdict 内嵌 `verificationId`（`<runId>/<kind>/<step>/<attempt>`），解析前先校验身份。测试：身份不符/无身份被拒、路径含 36 位 runId 且与 `verificationId` 前缀一致 |
| **cancel 必须同时终止 local waiter 与 remote generation** | ✅ 已闭环 | `ProcessVerifier` 在 abort **与** timeout 时先 `session/cancel(verifierSessionId)` 再终止 child；host 不支持取消时仍清理本地。测试：事件顺序 `['cancel:…', 'run:aborted=true']`、超时也取消、`stopLoop()` 后端口 signal 已 abort、`session/cancel` 以正确 sessionId 到达 host |
| **状态由状态机推导，而非模型自报** | ✅ 已闭环 | `score` 是唯一判决依据；`blocked`（接受 `blocked: true` 或 `status: 'blocked'`）是唯一能覆盖它的事实；`status` 降级为解释。测试：`9 + retry` 必须前进、`3 + done` 必须消耗 attempt、blocked 在任意分数下终止 |
| **`turnsCompleted` 只统计真实回合** | ✅ 已闭环 | 只计 `running=true → false` 的真实边沿（`busySessions`），新连接世代清空。测试：孤立 idle 不计数、真实边沿 +1、重复 idle 不计数 |
| **契约文件不由模型持久化** | ✅ 已闭环 | `verdictBrief` 只要求「在回复正文最后给出 JSON，不要用工具写文件」；child CLI 的 `writeVerdict` 解析该回复并**原子写**（先写 `.part` 再 rename）。verdict 根在 **client 侧**：`src/cli/dsht.tsx` 传 `verdictRoot: process.env.DSHT_VERDICT_ROOT ?? localDirectory`，`controller.ts` 在未注入时退回 `localDirectory`。测试：`tests/cli/startup.test.ts`「the child writes the verdict its own reply declared, through an atomic rename」（并断言 `.part` 不残留） |
| **独立评审不得修改被评审对象** | ✅ 已闭环（共享文件系统时） | 共享文件系统时可做 artifact hash before/after，不一致即 `unavailable`；远端 host 需要 host 侧只读工具权限，属于未闭环，必须如实标注 |
| verifier session / verdict 清理 | ⬜ 未做 | 一期明确「为审计保留、手动清理」；`runId` 目录已可整组删除 |
| README / `tui-design.md` 同步 | ⬜ 未做 | `loop.md`（本文件）已同步；`README.md`/`README.zh.md` 的命令表缺 `/designdoc-review`，`tui-design.md` §3.4 仍是 subagent 路径 |


**client 侧 verdict 路径**：默认 `<客户端目录>/.dsht/verify/<runId>/…`，`DSHT_VERDICT_ROOT` 可覆盖。默认值刻意选在客户端目录——这是客户端**始终被允许写入**的位置；把 verdictRoot 指到 state 目录时，运行环境的文件沙箱会以 `ENOENT: mkdir` 拒绝写入，表现为 `⚠ verification unavailable · verifier failed: ENOENT…`。也正因如此，`unavailable` 的原因必须出现在 headless 进度行里（已修），否则故障不可观测。
**已知残余风险**：若某次真实 turn 的 `running=true` 帧完全未被观察到，`--wait` 会等到超时而非立即返回。当前取舍是「宁可超时，也不把重放的 idle 当成完成」；超时走 `unavailable`，不消耗 attempt。探针中每次 turn 都能观察到 `true`。


## 10. 诚实边界

* dsht 无法证明验证者真的独立：它只能保证**独立进程、独立 session、无本对话上下文**，以及 verdict 文件的格式与轮次一致。`score`/`status` 终究是模型给出的判断。
* `--wait` 依赖 host 的 `api-session/status` 事件；若某 deployment 不发这个事件，子进程会等到超时（当前行为：超时 → 失败并记录日志），不会静默挂死。
* fork 自身依赖「能重新启动自己」：`execPath + execArgv + argv[1]`。在 `npx tsx src/cli/index.ts` 与 `dist/cli/index.js` 两种启动方式下都成立，但尚未在两种方式下都做过 live 验证。
