# dsht ↔ dsh 适配层方案（transport 门面化）

Status: **implemented（P0–P4 已实施）**。0.2 的兼容适配随 0.6.12 落地（§7.3 复盘）；本方案的门面化随 0.6.13 落地，实施结果见 §11。

范围：`src/` 内部"谁知道 dsh 的线格式"这件事的归属与迁移步骤。不改 wire 协议、不改 CLI 参数、不改命令语义、不改终端输出。

相关：`tui-design.md`（现行设计基线，§3.1.5/§3.1.6/§3.2.4 描述当前 wire 边界）、`tui-refactor-plan.md`（分层边界前作，本方案是它在 wire 方向的延续）、`.agents/notes/implemented/feature/2026-09-29-terminal-host-0.2-inbox-and-archive`（0.2 适配记录）。

---

## 0. 结论

**值得做，而且应该做——但只做"机制层"，不做"状态机层"。**

收益来自一个事实：宿主升级时真正变动的是**字段名、方法/载荷、帧形状**这三类知识，而它们今天分散在 7 个目录、19 个文件里；连接状态机、准入顺序、会话选择、transcript 折叠这些**不会**因为宿主改字段而变，把它们搬进 transport 只会放大影响面。

以刚落地的 0.1.7 → 0.2 为例：

| 0.2 的变更 | 今天落在 | 门面化后落在 |
| --- | --- | --- |
| `session/control` 的 `queues`/`jobs` 与 `queue`/`jobs` 帧删除，待发输入改走 `inbox` 投影 | [events.ts](<src/transport/events.ts>)、[telemetry.ts](<src/session/telemetry.ts>)、[runtime.ts](<src/session/runtime.ts>)、[host.ts](<tests/support/host.ts>)、3 个测试文件 | `dsh-contract.ts`（解码）+ `telemetry.ts`（状态归属不变）+ fixture |
| `workspace/archiveSession` 新增 `stopActivity` 与 `workspace/session-active` | [controller.ts:338](<src/session/controller.ts#L338>) | `dsh.ts` 的**一个参数**（领域只写"归档这个会话"） |
| `agentPresets/list` 去掉 `authorable`/`trust` | [controller.ts:126](<src/session/controller.ts#L126>)、fixture、1 个测试 | `dsh-contract.ts` 的 `PresetRow` |
| `SessionSummary.agentAvailable`、`ProjectionHints.kind`、`SessionAddress.mode:'unknown'` | 忽略（侥幸） | 契约类型显式标注"不用"，升级时一眼可判 |

**不能搬进 `transport/` 的三件事**（否则收益变负债）：

1. **准入顺序**：`SessionController.mutations` 的 per-session 闸门把"决定 steer/queue"和"发请求"合成一个原子步骤（[controller.ts:562](<src/session/controller.ts#L562>)）。门面只能提供"一次线往返"，闸门留在领域。
2. **会话选择与生命周期**：`selected()`/`generation`/`Client` 的哪一代在服务，是连接域的事。
3. **状态与折叠**：`Transcript`、`Telemetry`、`PromptIndex` 的内存模型与预算策略不因宿主改字段而变；它们消费门面的**语义帧**，不消费线格式。

---

## 1. 现状盘点

### 1.1 已经在 `transport/` 里的（机制层，无需迁移）

`Client`（HTTP 信封、cookie、mux、超时）、`events.ts`（`$events` 与 `session/control` 帧 → 语义）、`wire.ts`、`auth.ts`、`endpoint.ts`。目录自述"imports no Harness code"，架构测试也只允许它 import `transport/storage/json/text`。

### 1.2 wire 触点清单（今天分散的 29 个调用点）

| dsh 端点 | 请求在哪构造 | 响应在哪读 |
| --- | --- | --- |
| `session/list` | [client.ts:228](<src/transport/client.ts#L228>)、[cost/controller.ts:86](<src/cost/controller.ts#L86>) | `items` 行由 [navigation.ts](<src/session/navigation.ts>)、[navigation-model.ts](<src/ui/chat/navigation-model.ts>)、[app.tsx](<src/ui/app.tsx>)、[session/controller.ts](<src/session/controller.ts>)、[cost/scanner.ts](<src/cost/scanner.ts>) 各自读字段 |
| `session/create` | [navigator.ts:144](<src/session/navigator.ts#L144>)、[session/controller.ts:394](<src/session/controller.ts#L394>) | `.sessionId` |
| `session/rename` | [session/controller.ts:396](<src/session/controller.ts#L396>) | 忽略 |
| `session/search` | [session/controller.ts:482](<src/session/controller.ts#L482>) | `.items`/`.hasMore` |
| `session/page` | [history-reader.ts](<src/session/history-reader.ts#L78>)×3、[prompt-backfill.ts:58](<src/session/prompt-backfill.ts#L58>)、[cost/scanner.ts:78](<src/cost/scanner.ts#L78>) | `.records`/`.hasMore` → `Transcript.accept` |
| `session/prompt` | [session/controller.ts:574](<src/session/controller.ts#L574>) | `{accepted}` |
| `session/cancel` | [session/controller.ts](<src/session/controller.ts#L257>)×3 | 忽略 |
| `session/updateQueue` | [session/controller.ts:538](<src/session/controller.ts#L538>) | 忽略 |
| `session/modelCatalog` | [catalog/controller.ts](<src/catalog/controller.ts#L76>)×2 | 整块 raw → UI 读 `groups`/`failures`/`default`/`reasoning` |
| `session/selectModel` | [catalog/controller.ts:93](<src/catalog/controller.ts#L93>) | `.selected.provider/model/reasoningEffort` |
| `commands/execute` | [session/controller.ts:513](<src/session/controller.ts#L513>) | `{commandId, result.kind, result.text}` |
| `fileReferences/list` | [session/controller.ts:499](<src/session/controller.ts#L499>) | 已由 [references.ts](<src/session/references.ts>) 归一（3 处 raw） |
| `agentPresets/list` | [catalog/controller.ts:60](<src/catalog/controller.ts#L60>) | `.presets[].id/name/trust` |
| `workspace/create` | [navigator.ts:132](<src/session/navigator.ts#L132>) | `.workspace.workspaceId` |
| `workspace/delete` | [session/controller.ts:328](<src/session/controller.ts#L328>) | `.deleted` |
| `workspace/archiveSession` | [session/controller.ts:330](<src/session/controller.ts#L330>) | `.archivedSessionIds` |
| `workspace/follow`（流） | [client.ts:209](<src/transport/client.ts#L209>) | baseline 的 `items`/`archivedSessionIds` |
| `session/follow`（流） | [session/controller.ts:444](<src/session/controller.ts#L444>)、[peek.ts:83](<src/session/peek.ts#L83>)、[cost/scanner.ts:60](<src/cost/scanner.ts#L60>) | snapshot/event/assistant-stream **三处各自读** |
| `session/control`（流） | [connection-streams.ts:44](<src/controller/connection-streams.ts#L44>) | 已归一为 `ControlFrame` |
| `$events` + `$events/result` | [connection.ts:85](<src/controller/connection.ts#L85>)、[connection-streams.ts:37](<src/controller/connection-streams.ts#L37>) | 已归一为 `HostEvent` |

### 1.3 原始字段读取分布（真正的爆炸半径）

`object()/string()/array()` 调用点，按文件（不含 `transport/`）：

| 文件 | 次数 | 说明 |
| --- | --- | --- |
| [session/transcript.ts](<src/session/transcript.ts>) | 111 | 事件/记录解码器，宿主每次改事件字段都会命中 |
| [session/controller.ts](<src/session/controller.ts>) | 23 | prompt/queue/命令结果/投影 `title`/`agentPreset` |
| [ui/app.tsx](<src/ui/app.tsx>) | 21 | 会话/工作区行字段直接进 UI |
| [ui/dialogs/index.tsx](<src/ui/dialogs/index.tsx>) | 20 | 搜索结果行、模型目录 raw |
| [session/navigator.ts](<src/session/navigator.ts>) | 14 | 工作区/会话行 |
| [cost/records.ts](<src/cost/records.ts>) | 13 | 记录账本字段 |
| [cost/scanner.ts](<src/cost/scanner.ts>) | 11 | 分页行 |
| [catalog/controller.ts](<src/catalog/controller.ts>) | 10 | 目录/preset |
| [ui/chat/status.tsx](<src/ui/chat/status.tsx>) | 0 直接调用，但读 `view.values.*` | 6 个投影键的语义在这里被解释 |

（表只列前 9；另有 `cli/dsht.tsx` 6、`session/references.ts` 3、`cost/controller.ts` 3、`session/history-reader.ts` 2、`cost/pricing.ts` 2、`controller/controller.ts` 2、`controller/connection-streams.ts` 2、`session-title.ts`/`session/prompt-backfill.ts`/`session/navigation.ts` 各 1。）

合计 **29 个调用点 + 20 个文件在读宿主字段**；其中 `ui/` 的两个文件读原始宿主字段 **41 次**——这正是"改一个宿主字段名要改 UI"的原因。

### 1.4 结论

适配面 = ①方法名与载荷、②响应字段名、③流帧形状，共三类。它们在今天分散在 `transport/`（仅 ③ 的一部分）、`session/`、`cost/`、`catalog/`、`cli/`、`ui/`。本方案把 ①②③ 全部收进 `transport/`，并让 `ui/` 只看到语义行与语义帧。

---

## 2. 目标架构

### 2.1 目录与文件

```text
src/transport/
  client.ts          不变：HTTP/mux/cookie/超时（机制）
  wire.ts            不变：JSON 断言
  auth.ts            不变：凭据
  endpoint.ts        不变：地址
  events.ts          不变：$events 与 session/control 帧 → 语义（已合规）
  dsh-contract.ts    新增：**契约**——dsht 消费的 dsh 字段子集，纯类型 + 纯解码函数
  dsh.ts             新增：**门面**——每个 dsh 端点一个方法，签名是语义类型
```

`dsh-contract.ts` 与 `dsh.ts` 都不 import 领域代码（`session/`、`catalog/`、`cost/`、`ui/`），只 import `client.ts`/`wire.ts`/`json.ts`/`text.ts`，因此满足现有架构规则；`ui/` 依旧不能 import `transport/*`，它需要的类型由 `contracts.ts` 再导出（现状已如此：`QueuedInput` 就是经 `session/telemetry.ts` → `contracts.ts` 到 UI 的）。

### 2.2 归属判定表

| 问题 | 归属 |
| --- | --- |
| dsh 把待发输入放在哪个键、行上叫什么字段 | `dsh-contract.ts` |
| 请求该包 `{request:{...}}` 还是 `{_request:{...}}`、`agent` 在线上叫 `agentId` | `dsh.ts` |
| "运行中提交 = steer，空闲 = queue" | `session/controller.ts`（政策） |
| 闸门、代数、选中会话、超时/重试 | 领域（不变） |
| 待发输入存在哪、怎么冻结、怎么按 rpcId 退休 | `session/telemetry.ts`（不变） |
| 会话行显示成什么标题、什么状态点 | `ui/` + 语义行类型 |

### 2.3 一条硬边界

`dsh.ts` 的方法**只做一次线往返**：不重试、不缓存、不判断会话是否选中、不组合多请求。需要组合的地方（例如 `/resume` 先 `session/list` 再 `workspace/follow`）留在领域。

---

## 3. 契约文件设计（`transport/dsh-contract.ts`）

### 3.1 头部标注规范（升级时唯一要对齐的东西）

```ts
/**
 * 本文件是 dsht 消费的 dsh Remote 契约，**按端点组织**。
 * 校验版本：dsh 0.2.0-rc.2
 * 源类型：
 *   session/*   packages/api/session-controller/src/types.ts
 *   workspace/* packages/api/workspace-controller/src/types.ts
 *   commands/*  packages/interaction/commands/src/types.ts
 *   fileReferences/* packages/api/session-controller/src/file-references.ts
 *   presets/*   packages/preset/agent-preset-registry/src/types.ts
 *   envelope    packages/client/connection/src/rpc.ts、packages/api/gateway/src/stream-protocol.ts
 * 升级流程见 dsh-adapter-plan.md §7。本文件只解码 dsht 真正读取的字段，其余字段一律忽略。
 */
```

### 3.2 类型与解码（示例）

```ts
/** `session/list` 的一行：只保留 dsht 会显示或判断的字段。 */
export interface SessionRow {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
  /** 0.2 新增；0.1.x 没有这个字段时按"未知"处理，不当作 false。 */
  readonly agentAvailable?: boolean;
  readonly cwd?: string;
  readonly parentSessionId?: string;
  readonly origin?: 'subagent';
  /** 投影提示块；`kind` 决定 `asOfSeq` 能不能与会话基线比较（0.2 起才有）。 */
  readonly projections?: { readonly kind?: 'cached' | 'sequenced'; readonly asOfSeq: number };
}

export function sessionRow(value: Json | undefined): SessionRow;      // 抛错：协议漂移必须响
export function sessionRows(value: Json | undefined): SessionRow[];

/** `inbox` 投影格子：唯一保留"读不懂就跳过"姿态的解码器（纯展示能力）。 */
export function inboxInputs(value: Json | undefined): QueuedInput[];   // 0.2 已实现此姿态

/** `session/page`：记录仍是 raw（由 Transcript 折叠），但外层语义在这里定型。 */
export interface PageResult { readonly records: readonly Json[]; readonly hasMore: boolean }
export function pageResult(value: Json | undefined): PageResult;
```

姿态规则：**结构化契约（行、命令结果、模型目录、preset）在坏值上抛错**，让协议漂移立刻可见；**纯展示数据（`inbox` 行、未知投影值）跳过坏行**，不让一个字段拖垮整条流。这条规则要写进文件头。

### 3.3 投影值的语义化

今天 `TelemetrySnapshot.values` 是 `Record<string, ProjectionValue>`，`ui/chat/status.tsx` 自己解释 6 个键。目标：

```ts
export interface SessionMetrics {
  readonly title?: string;
  readonly agentPresetId?: string;
  readonly model?: { readonly current?: ModelSelection; readonly next?: ModelSelection };
  readonly context?: { readonly projected?: number; readonly window?: number };
  readonly usage?: { readonly uncachedInput?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
  readonly turns?: number;
  readonly inbox: readonly QueuedInput[];
}
export function sessionMetrics(values: Readonly<Record<string, ProjectionValue>>): SessionMetrics;
```

`Telemetry.view()` 之后只暴露 `metrics(id): SessionMetrics`（缓存按 key-level 水位失效，`values` 仍保留给诊断面板）。UI 不再出现 `record(view.values.tokenUsage).cacheReadTokens` 这类写法。

---

## 4. 门面设计（`transport/dsh.ts`）

```ts
export class Dsh {
  constructor(private readonly client: Client) {}

  // 读
  listSessions(signal?: AbortSignal): Promise<SessionRow[]>;
  workspaces(signal?: AbortSignal): Promise<{ items: WorkspaceRow[]; archivedSessionIds: string[] }>;
  search(query: string, signal?: AbortSignal): Promise<{ items: SearchItem[]; hasMore: boolean }>;
  page(request: PageRequest, signal?: AbortSignal): Promise<PageResult>;
  modelCatalog(signal?: AbortSignal): Promise<ModelCatalog>;
  presets(signal?: AbortSignal): Promise<PresetRow[]>;
  fileReferences(agentId: string, query: string, signal?: AbortSignal): Promise<FileReference[]>;

  // 写
  createSession(workspaceId: string, signal?: AbortSignal): Promise<{ sessionId: string }>;
  renameSession(sessionId: string, title: string, signal?: AbortSignal): Promise<void>;
  prompt(request: PromptRequest, signal?: AbortSignal): Promise<void>;
  cancel(sessionId: string, signal?: AbortSignal): Promise<void>;
  updateQueue(sessionId: string, itemId: string, action: QueueAction, signal?: AbortSignal): Promise<void>;
  selectModel(request: SelectModelRequest, signal?: AbortSignal): Promise<ModelSelection>;
  createWorkspace(path: string, signal?: AbortSignal): Promise<WorkspaceRow>;
  deleteWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void>;
  archiveSession(sessionId: string, signal?: AbortSignal): Promise<{ archivedSessionIds: string[] }>;
  executeCommand(agentId: string, line: string, attachments: readonly CommandAttachment[], signal?: AbortSignal): Promise<CommandOutcome | undefined>;

  // 流
  follow(request: FollowRequest, listener: FollowListener): Subscription;   // 解出 FollowFrame
  control(listener: ControlListener): Subscription;                          // 已语义化
}
```

### 4.1 改造前后（以 `session/prompt` 为例）

```ts
// 今天：领域自己知道 payload 形状、超时策略、mode 取值
const issued = this.host.require().call('session/prompt', { request: {
  sessionId, requestId, mode: this.running ? 'steer' : 'queue',
  content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
} });

// 目标：领域只表达"这一句、这一身份、这个投递意图"，线形状在门面内
const issued = this.dsh.prompt({ sessionId, requestId, delivery: this.running ? 'steer' : 'queue',
  text, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, signal);
```

闸门与 `this.admission` 的位置**不变**——门面不参与准入。

### 4.2 错误与取消

- `HttpError`/`RemoteError` 保持原样并从 `client.ts` 再导出；门面只保证"响应字段缺失"这类漂移统一抛 `ProtocolError`（新增，带端点与字段名），让 trace 能指到具体字段。
- 取消统一走 `AbortSignal`；`session/updateQueue` 等写方法沿用领域给的 signal，门面不自己造超时（`Client.call` 的默认 15s 仍然生效，`commands/execute` 由领域显式传 `null`）。

### 4.3 流

`follow` 的三种帧（snapshot/event/assistant-stream）在 `dsh-contract.ts` 解码为 `FollowFrame`，`Transcript.accept(frame: FollowFrame)` 接受语义帧而不再接受 `Json`。`session/peek.ts` 与 `cost/scanner.ts` 复用同一解码器（今天各自读 `records`）。

---

## 5. 分阶段迁移

每个阶段独立可发布（typecheck + 全量测试绿），可单独回滚。

| 阶段 | 范围 | 主要文件 | 验收 | 工作量 |
| --- | --- | --- | --- | --- |
| **P0 契约冻结** | 新建 `dsh-contract.ts`：类型 + 解码器（`sessionRow`/`pageResult`/`modelCatalog`/`presetRow`/`commandOutcome`/`workspaceRow`/`pageResult`），**逐个接上现有调用点**但保留旧代码路径 | 新增 1 文件；`telemetry.ts` 复用 `inboxInputs` | 新增 `tests/transport/contract.test.ts`：每个端点一组真实帧夹具（从 `../packages/**/tests` 与 0.2 探针取），断言字段与容错姿态 | 0.5–1 天 |
| **P1 方法门面** | 17 个 RPC 收进 `dsh.ts`；`client.call` 不再出现在 `transport/` 之外（含 `listSessions`/`listWorkspaces` 从 `client.ts` 移到门面） | `dsh.ts` + `session/controller.ts`、`navigator.ts`、`history-reader.ts`、`prompt-backfill.ts`、`cost/*`、`catalog/controller.ts`、`controller/connection*.ts` | 架构测试新增规则：`client.call(`/`client.subscribe(` 只允许出现在 `transport/` | 1.5–2 天 |
| **P2 流帧语义化** | `session/follow` 三种帧 + `workspace/follow` baseline 解码进契约；`Transcript.accept` 收 `FollowFrame` | `dsh-contract.ts`、`transcript.ts`、`session/controller.ts`、`session/peek.ts`、`cost/scanner.ts` | `transcript.test.ts` 改为语义帧；fixture 直接发 0.2 帧 | 1–1.5 天 |
| **P3 行与指标语义化** | `SessionRow`/`WorkspaceRow`/`ModelCatalog`/`SessionMetrics` 替换 UI 与 `state.ts`/`contracts.ts` 里的 `ObjectValue` | `state.ts`、`contracts.ts`、`ui/app.tsx`、`ui/dialogs/index.tsx`、`ui/chat/navigation-model.ts`、`ui/chat/status.tsx`、`session/navigation.ts`、`session-title.ts` | 架构测试新增规则：`src/ui/`、`state.ts`、`contracts.ts` 不得出现 `ObjectValue`（`Json` 仅限诊断面板） | 1.5–2 天 |
| **P4 守门与 SOP** | 契约覆盖率测试（RPC 清单 ↔ 解码测试一一对应）；`tui-design.md` §3.1.6 改为指向契约文件；本方案的 SOP 落到 `.agents/` 笔记与 README「宿主兼容」小节 | 文档 + `tests/transport/contract.test.ts`、`tests/architecture/dependencies.test.ts` | 故意删一个解码分支，覆盖率测试必须红 | 0.5 天 |

合计 **5–7 人日**。建议顺序 P0 → P1 → P4(a) → P2 → P3 → P4(b)：先冻结契约、再收调用点并在 P1 后立刻加"调用点唯一"规则，随后处理风险最高的 P2，最后一次性收 UI 的 raw 字段并上"raw 不进 UI"规则。

---

## 6. 守门机制

1. **架构测试**（[dependencies.test.ts](<tests/architecture/dependencies.test.ts>)）分两步加规则，避免大爆炸：
   - P1 后：调用点唯一——`client.call`/`client.subscribe` 只允许在 `transport/`；`ui/` 不得 import `transport/*`（已有）。
   - P3 后：raw 不进 UI——`ui/`、`state.ts`、`contracts.ts` 不得出现 `ObjectValue`；`Json` 只允许在 `transport/`、`session/transcript.ts`、`cost/records.ts`。
2. **契约黄金测试**：`tests/transport/contract.test.ts` 的每个用例注明"取自 dsh 哪个版本的哪个 type/测试夹具"。宿主升级时这个文件就是差异清单。
3. **fixture host 即规范**：[tests/support/host.ts](<tests/support/host.ts>) 必须与契约同版本；每条契约解码至少有一个 loopback 用例，避免"解码器正确但没人接线"。
4. **覆盖率清单**：契约文件顶部维护端点表（方法/流 × 已解码字段 × 测试名），P4 用测试断言表与实际导出一致。

---

## 7. 宿主升级 SOP

### 7.1 步骤（可直接执行）

1. 取宿主版本：`git -C ../ describe --tags`；记录旧版本。
2. 拉 diff（只关心 dsht 用到的包）：
   `git -C ../ diff <old>..<new> -- packages/api/session-controller/src packages/api/workspace-controller/src packages/interaction/commands/src packages/preset packages/context/file-reference/src packages/client/connection/src packages/api/gateway/src/stream-protocol.ts`
3. 对照 `dsh-contract.ts` 头部列出的源类型，逐项标注：**新增/删除/改名/可选性/语义变化**。
4. 改 `dsh-contract.ts`（字段与解码）、`dsh.ts`（方法/载荷）与 `transport/endpoints.ts` 的对应行（能力清单的唯一出处；
   读值可选读 `--auth-dir <path>     Private cookie directory (or DSHT_AUTH_DIR)` 之外的 `transport/decode.ts`）；领域文件预期**零改动**
   （若有改动，说明该知识还没收进来，补收）。新增/删除 endpoint 时 `tests/transport/endpoints.test.ts`
   会同时要求清单与源码一致、且行内读者确实被该模块导出。
5. 更新 `tests/support/host.ts` 到新 baseline/帧形状，跑 `npm test`。
6. 用真实宿主跑一次只读诊断：`npm run diagnose:host [sessionId]`。它逐个打印 dsht 用到的 endpoint 的**价值类型**、投影键里不是对象的值、历史记录的 `surfaceOp` 分布，以及"解码器必须容忍的非对象值"清单。契约与实机不一致时，先看这份输出，再改 `dsh-contract.ts`。
7. 更新契约头部版本号、端点表；补一条 Agent Note（`implemented/feature|bug-fix/<date>-terminal-host-<ver>.md` + `.zh.md` + `.i18n.yaml`）；`npm version <next> --no-git-tag-version`。
8. README 双语仅在**用户可见行为**变化时更新；纯字段迁移不写进 README。

### 7.1.1 值的 JSON 类型（0.2 实测，解码器的前提）

**信封永远是对象；值不一定是。** 下面每一条都实测于 `dsh` 0.2.0-rc.2（`npm run diagnose:host`）：

| 位置 | 0.2 的值 | 解码姿势 |
| --- | --- | --- |
| `fileReferences/list` | **数组** | `array()` |
| `session/projections` | `{asOfSeq, values}` 或 **`null`** | 未被 dsht 调用；调用前必须容忍 `null` |
| `commands/execute`（未解析该行） | **没有 `value` 键**（`undefined`） | 视为"宿主没有解析这条命令"，不是协议错误 |
| 投影块 `values.title` / `agentPreset` | **字符串** | `optionalString()` |
| 投影块 `values.turnOutline` / `subagentCatalog` | **数组** | 不该 `object()`；dsht 目前不读 |
| 投影块 `values.goal` / `subagent` / `todos` | **`null`** | 同上 |
| 记录 `event.surfaceOp` | 字符串 `'append'` **或对象** `{op:'replace',startSeq,endSeq}` | `surfaceOpOf()`／`surfaceAppends()`；展示与否只看 `surfaceAppends`，**任何 op 都保留 `data`**，读者仍不得假设 `data` 存在 |

**保留事件的形状不变量**：transcript 保留的事件是**约简**过的记录，可能没有 `data`（未知的 surface 操作、
不展示的记录）。所有读者走 `retainedData()`；`object(event.data)` 在保留事件上永远是错的。
这正是 0.2 首轮适配漏掉的一点：`replace` 记录被裸保留，`findPendingTool()` 于是 `object(undefined)`，
`Expected a JSON object from the server` 抛在会话帧里 → 整代连接重建。

### 7.2 版本矩阵（维护在契约头部）

| dsh | 关键差异 | 本客户端状态 |
| --- | --- | --- |
| ≤0.1.5 | `session/control` 带 `queues`/`jobs` 与对应帧 | 兼容（解码保留，显式上报优先） |
| 0.1.7 | 删除 `queues`/`jobs`；`projections.kind` 出现；`archiveSession` 无 `stopActivity` | 兼容 |
| 0.2.0-rc.2 | `archiveSession.stopActivity` + `workspace/session-active`；`presets` 去 `trust`；`SessionSummary.agentAvailable`；`AgentAddress.mode:'unknown'`；mux 支持上行 `item`/`end` 与 binary 结果；**`surfaceOp` 出现对象形式的 `replace`**；`session/projections` 可返回 `null` | 已适配（0.6.12）；`surfaceOp`/值的类型见 §7.1.1（0.6.15） |

### 7.3 0.1.7 → 0.2 复盘（为什么值得做）

这次改动的**净工作**是 4 个源文件 + fixture + 3 个测试文件；若已有门面，预期是 1 个契约文件 + `telemetry.ts` 的状态来源 + fixture，领域与 UI 不动。反过来看，`ui/app.tsx` 与 `ui/dialogs/index.tsx` 各有 20 次左右原始字段读取——只要 `session/list` 的行字段有一天改名，这两个文件就会被牵动，而它们与"dsh 怎么说话"毫无关系。

---

## 8. 风险与不做的事

| 风险 | 缓解 |
| --- | --- |
| 门面变成上帝对象，藏起顺序与重试 | 硬边界：门面只做一次线往返、无状态、无政策（§2.3），并在契约测试里断言"一个方法 = 一个端点" |
| 语义类型在 transport 与领域重复 | transport 只放**线上形状**（`SessionRow`、`ModelCatalog`）；领域继续拥有展示语义（`sessionLabel`、状态点） |
| P2 触及 `Transcript`，风险最高 | 单独阶段、单独测试夹具；先让 `accept` 同时接受两种形态一版，再删旧路径 |
| 一次性改 UI 的 41 处 raw 读取 | 拆成 P3 的 4 个独立提交（rows → metrics → dialogs → navigation-model），每个提交测试绿 |
| 迁移期间宿主又升级 | 契约文件是唯一的对齐点，先按 SOP 升契约，再做迁移 |

**不做**：不把 `Transcript`/`Telemetry`/`PromptIndex` 合并进 transport；不在本方案里新增宿主能力（附件/图片、`session/fork`、`job/*`、`terminal/*`、workspace pin/unarchive）——它们是独立课题，门面化之后各自只是"加一个方法 + 一个契约段"；不改 CLI、命令语义与终端输出。

---

## 9. 工作量与排期（建议）

| 顺序 | 阶段 | 人日 | 交付 |
| --- | --- | --- | --- |
| 1 | P0 契约冻结 | 1 | `dsh-contract.ts` + `contract.test.ts`（零行为变更） |
| 2 | P1 方法门面 | 2 | `dsh.ts` + 29 个调用点收敛 + 架构规则(a) |
| 3 | P2 流帧语义化 | 1.5 | `FollowFrame` + `Transcript.accept` 语义化 |
| 4 | P3 行与指标语义化 | 2 | `SessionRow`/`ModelCatalog`/`SessionMetrics` + 架构规则(b) |
| 5 | P4 守门与 SOP | 0.5 | 覆盖率测试 + 文档 + Agent Note |
|  | 合计 | **7** | 一次宿主升级的预期改动面：契约 1 文件 + fixture |

## 11. 实施结果（与本文的差异）

门面化实际落在 **P0–P4 全部**，但有两处与方案不同，记录在这里以便下次读方案的人不必猜：

1. **门面是函数模块，不是 `Dsh` 类**。`transport/dsh.ts` 导出 `createSession`/`prompt`/`page`/`follow`/… 以及 `stream()`，每个都接收调用方手里的 `Client`。理由：`Client` 已经是每连接一代的句柄（`HostAccess.require()`），再包一个类只增加所有权与生命周期，而不减少影响面；函数同样满足"一次线往返、无状态、无政策"。
2. **契约按端点组织在一个文件里**（`transport/dsh-contract.ts`），而不是"类型 + 解码器分家"；文件头按 §3.1 的规范记录校验版本（`dsh 0.2.0-rc.2`）与源类型路径。

落地清单（对应 §5）：

| 阶段 | 结果 |
| --- | --- |
| P0 契约冻结 | `dsh-contract.ts`（行/工作区/分页/搜索/preset/命令/文件引用/模型目录/投影指标/follow 帧/inbox）+ `tests/transport/contract.test.ts`（9 个用例，覆盖两种姿态） |
| P1 方法门面 | 17 个 RPC 全部走 `dsh.ts`；`client.call` 在 `transport/` 之外为 0（架构测试 `every dsh call goes through the transport facade`） |
| P2 流帧语义化 | `followFrame()` + `dsh.follow()`；`Transcript.accept(FollowFrame)`、新增 `Transcript.openPage(PageResult, cursor)`；三处会话流订阅（选中会话/peek/成本扫描）与通用 `stream()` 全部收口 |
| P3 行与指标语义化 | `SessionRow`/`WorkspaceRow`/`ModelCatalog`/`SearchItem`/`PresetRow`/`SessionMetrics`；`Telemetry.metrics()`；UI、`state.ts`、`contracts.ts` 不再 import 原始 JSON（架构测试 `the ui contract and the ui never read raw host JSON`） |
| P4 守门 | 两条架构规则 + 契约黄金测试 + 本节与 §7 的 SOP |

**未收进契约、仍留在领域的原始字段**（有意）：`session/transcript.ts` 的持久记录/事件/分块折叠（记录形状是会话域自己的内存模型）、`cost/records.ts` 与 `cost/pricing.ts` 的账本字段、`cli/dsht.tsx` 读取本地 manifest。它们不是"dsh 怎么说话"，而是"记录长什么样"。

**0.1.7 → 0.2 复盘**：这次改动若已有门面，预期是"契约 1 个文件 + `telemetry.ts` 的来源 + fixture"；现在读 `dsh-contract.ts` 的文件头即可定位到宿主源类型，实际落地也在该文件 + fixture + 测试三个位置完成。

---

## 10. 验收清单

- [x] `transport/` 之外没有任何 `client.call(` / `client.subscribe(`（架构测试）。
- [x] `ui/`、`state.ts`、`contracts.ts` 不再 import 原始 JSON 工具（架构测试）。
- [x] `dsh-contract.ts` 头部标注了校验版本与源类型。
- [x] 每条契约解码都有用例（`tests/transport/contract.test.ts`），且 loopback fixture 已发 0.2 帧。
- [ ] 故意破坏任一解码字段（改名/删除），`contract.test.ts` 与至少一个 loopback 用例变红 —— 可在 review 时手工做一次。
- [ ] 一次模拟升级演练（把 `session/list` 的 `blank` 改名）—— 留作 review 演练。
