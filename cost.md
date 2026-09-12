# dsht 计费实现方案（评审用）

本文只描述**当前已实现**的费率决定方案，以及它在真实账本上的表现和已知风险，供评审决定是否改。代码位置：`src/cost/pricing.ts`（费率与决策）、`src/cost/config.ts`（价目表来源）、`src/cost/ledger.ts`（折叠与查询）、`src/cost/ledger-files.ts`（按会话落盘）、`src/cost/records.ts`（token 桶折叠）、`src/cost/scanner.ts`（历史读取）。

## 1. 数据流：一笔请求怎么变成金额

```
宿主会话日志                 dsht
session/follow + session/page
   ↓ costRecords()  只保留计费事件（request/context、assistant/message、assistant/attempt、llm/retry-started、session/end-seed、compaction/summary）
   ↓ foldSamples()  每个 attempt 折叠成一个样本：{ key: 首个事件 seq, time, provider, model, usage }
   ↓ chargeFor()    用当前价目表得到 { amount } 或 { reason }
   ↓ CostLedger.replace()  累加成会话总额与「本次扫描当天」分桶，写入 <state>/cost/<sha256(origin)>/<sha256(sessionId)>.json（SavedCost v3）
   ↓ total(sessionId) / today(now)  内存记忆化 → /cost 面板、状态栏、/status
```

关键点：**账本是宿主日志与价目表的投影**。落盘的只有每个会话的汇总（会话金额、请求数与未计价数、当天分桶、规则版本与价目表摘要），**不保存逐请求记录**。因此下一次扫描会用当时加载的价格表重新决定整个历史：修正价目表会在下一次扫描生效，此前没有条目覆盖的请求也会在出现覆盖后自动计价。

这样做的代价与收益：金额不再"一次决定、永不改变"，改表会移动历史总额（这正是自动修复）；账本文件从"每笔请求约 174 字节"降到"每会话约 200 字节"，本机 11,932 笔请求的账本从约 2 MB 降到几 KB。


## 2. 价目表结构

```ts
interface PriceVersion {
  id: string; provider: string; model: string;
  aliases?: string[];                    // 该版本额外覆盖的模型名，尾部 `*` 为前缀匹配
  from: string; until?: string;          // ISO 时间，半开区间 [from, until)
  currency: 'CNY'; source: string;       // source 固定为官方价目页
  timezone: string;                      // Asia/Shanghai
  peak: Rates; offPeak: Rates;           // 每百万 token 的价格
  weekdays: number[];                    // 0=周日 … 6=周六
  windows: [number, number][];           // 当日分钟数，半开 [a, b)
}
type Rates = { input: number; cacheRead: number; cacheWrite: number; output: number };
```

随包默认 `DEFAULT_PRICES`（2026-09-12 核对，来源 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>）：

| id | model | 高峰 input / cacheRead / output | 空闲 input / cacheRead / output |
|---|---|---|---|
| `deepseek-2026-09-10-flash` | `deepseek-flash` | 2 / 0.04 / 8 | 1 / 0.02 / 4 |
| `deepseek-2026-09-10-pro` | `deepseek-v4-pro` | 9 / 0.30 / 27 | 4.5 / 0.15 / 13.5 |

两张表的 `weekdays = [1,2,3,4,5]`、`windows = [[540,720],[840,1080]]`，即**北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余（含周六周日、以及工作日的 12:00–14:00 与 18:00–次日 09:00）为空闲**。空闲价恰为高峰价的一半。`cacheWrite` 当前等于同档 `input` 价（见风险 R5）。Pro 的区间是开放的——官方页脚注 (2) 说明 9-14 之后继续按原费率提供，所以原先那条"9-14 后按 Flash 计费"的条目已删除。

## 3. 模型 → 费率的选择规则（已按 R1/R2/R3 改造）

`priceAt()` 的匹配顺序（`candidates()`）：

1. **精确匹配**：`provider` 相同且 `canonicalModel(model)` 与 `canonicalModel(price.model)` 相等。
2. **显式别名**：`provider` 相同且该版本声明的 `aliases` 命中。别名以尾部 `*` 表示前缀匹配，其余为全等。
3. **都不命中 → `no price version`（不猜）**。

`canonicalModel()` = `NFKC` 规范化 + 把 CJK 句号（`。`／`．`／`｡`）映射为 `.` + 去首尾空白 + 转小写。NFKC 不会折叠 CJK 句号，所以显式映射——真实账本里出现过 `deepseek-v4。1-flash-expires-on-0910` 这种带全角句点的模型名。

随包表声明的别名：

| 版本 | model | aliases |
|---|---|---|
| `deepseek-2026-09-10-flash` | `deepseek-flash` | `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4-flash*`、`deepseek-v4.1-flash*`、`deepseek-v4.1-flash` |
| `deepseek-2026-09-10-pro` | `deepseek-v4-pro` | `deepseek-v4-pro`、`deepseek-v4-pro*`、`deepseek-v4.1-pro*` |

**已删除**：`priceFamily()`（按名字是否含子串 `pro` 归类）。旧规则会把 `deepseek-v4-flash-prod`、`proxy-*`、`prompt-*` 判成 Pro（高估约 4.5 倍），也会把任何未列出的官方模型静默按 Flash 计费。现在未声明即 `no price version`，由 `/cost` 如实报告。

**前缀别名的边界**：`deepseek-v4-flash*` 是有意声明的前缀，会覆盖宿主为旧别名编造的 `-expires-on-0910` 之类后缀，因此 `deepseek-v4-flash-prod` 仍按 Flash 计费——这是声明过的意图，而不是子串巧合。正因如此，别名必须窄到"落到它下面的名字确实是该模型"：一度写过的 `deepseek-pro*` 会吞掉 `deepseek-proxy-*`，已删除（这个错误是测试抓出来的）。别名越宽，越像旧的子串启发。

## 4. 金额公式与 token 桶语义

```ts
amount = (input * rates.input + output * rates.output
        + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) / 1e6;
```

四个桶由 `records.ts` 的 `validUsage()` 校验，要求：

- 四者都是非负安全整数（`cacheReadTokens`/`cacheWriteTokens` 缺省视为 0）；
- 若样本带 `totalTokens`，必须 `totalTokens === input + output + cacheRead + cacheWrite`。

第二条意味着 **`inputTokens` 是"未命中缓存的输入"，四个桶互斥**。这与宿主 `packages/llm/token-meter` 的 `normalizeUsage()` 一致（它要求 `input + cacheRead + cacheWrite === totalTokens - output`），所以公式不会把命中部分按未命中价重复计费。

## 5. 没有金额的情形

| `reason` | 触发条件 | 下一次扫描 |
|---|---|---|
| `missing usage` | 样本没有合法 token 桶（请求还没报完） | 拿到 token 后定价 |
| `missing time` | 事件没有结算时间（真实宿主日志里计费事件 100% 带 `time`，出现即数据异常） | 有 `time` 后定价 |
| `unsupported usage` | `deepseek-official` 且 `cacheWriteTokens != 0`：官方价目表只有缓存命中/未命中/输出三维，第四维说明 usage 映射有误 | 表覆盖该桶后定价 |
| `no price version` | 没有 `provider + model + 时间区间` 命中（含非官方 provider、早于 `from` 的请求） | 表覆盖后可自动定价 |
| `invalid estimate` | 金额非有限数 | 重新决定 |

整个决定规则只有一条：**每次扫描用当前加载的价格表重新决定每个样本**（`CostLedger.replace()` → `chargeFor()`）。没有"已定价即终局"的状态，也没有 `--reprice`：一次普通扫描就是一次重新决定。未计价请求因此自动受益于后来覆盖它的表，修正后的表也自动改写历史。

**客户端离线期间的账由下一次扫描补齐。** `dsht` 只是客户端，它不运行时宿主照常工作，因此"这个会话的更新时间没变"并不能证明这期间没有新用量：每个连接世代开始时 `CostController` 丢弃跳过表（`start()` 里 `updates.clear()`），第一次扫描把全部会话的历史重读一遍；进程重启后这张表本来就是空的。跳过表只用于让同一次连接内每 60 秒的定时扫描不必重读没有变化的空闲会话。`tests/cost/cost.test.ts` 用"宿主在断开期间写入、却不改更新时间"的固定用例锁住这条恢复路径。

**已删除**：`lowestPrice()` 与 `estimated` 语义。旧实现给无结算时间的请求取"最低空闲价"作下限并计入 lifetime，却不计入任何按天区间，于是 `Σ 每日 ≠ 总计`；现在这类请求记为 `missing time`、不产生金额，只计入 `unknown`。`CostTotal` 因此不再有 `estimated` 字段（面板与状态栏同步）。

## 6. 配置来源与自我保护（`config.ts`）

- 目录：`DSHT_CONFIG_DIR` 或 `~/.config/dsht/`；账本目录按 origin 哈希分：`<state>/cost/<sha256(origin)>/`。
- `prices.json` **整体覆盖**随包表（不是合并）。缺失时用 `createPrivateFile`（`wx`，0600）种下当前 `DEFAULT_PRICES`，并写 `prices.seed.json = { revision, hash }`。
- 载入时：文件摘要 == 戳记 → 判定为"工具所有"，用本次构建的随包表重写（若内容不同）；否则视为用户自维护，**永不覆盖**，并让 `/cost` 显示 `Rates come from prices.json, not the shipped table`。
- 没有戳记的旧文件只在与"被取代的那版种子"（`3/9/0.1`、`1.5/4.5/0.05`，即 `isUncorrectedSeed`）完全一致时才替换。这是针对 2026-09-10 那次费率修正的历史迁移。
- 内容无变化时不落盘，因此只读配置目录也能启动。

## 7. 本机账本的真实模型名（重要输入）

| provider \| model | 笔数 | 已定价 | 结果 |
|---|---|---|---|
| `deepseek-official \| deepseek-v4.1-flash-expires-on-0910` | 6,558 | 1,452 | 别名命中 → flash |
| `deepseek-official \| deepseek-v4-flash` | 5,384 | 5,142 | 别名命中 → flash |
| `deepseek-official \| deepseek-v4-flash-expires-on-0910` | 1 | 0 | `missing usage` |
| `deepseek-official \| deepseek-v4。1-flash-expires-on-0910` | 1 | 0 | `missing usage` |

观察：**至今没有任何 Pro 请求**，所以 pro/flash 分支的实践路径只走了一半；且宿主给出的名字并不规范（出现带 `expires-on-0910` 后缀、甚至**全角句点 `。`** 的变体），说明"模型名"不是稳定标识符——这正是别名表 + 规范化必须存在的原因。未定价的 5,350 笔全部早于 `from: 2026-09-10`（官方费率表覆盖不到），并非规则失败；在新状态机下它们会在表覆盖后自动定价。

## 8. 风险清单（含会审结论与实施状态）

| 编号 | 风险 | 状态 |
|---|---|---|
| **R1** | 子串 `pro` 判定会把 `flash-prod`/`proxy-*`/`prompt-*` 判成 Pro（≈4.5 倍高估） | **已修**：显式 aliases，删除启发式 |
| **R2** | 未知官方模型静默按 Flash 计费 | **已修**：未声明即 `no price version` |
| **R3** | 模型名不规范（全角句点、后缀、大小写） | **已修**：`canonicalModel()`（NFKC + CJK 句号映射） |
| **R4** | 高峰归属按单点时间判定；跨峰谷请求不拆 | **保持不变**：官方未定义跨界拆账；本机 11,932 笔按结算时间重算与平台偏差 0.0%，在有官方依据前不动锚点 |
| **R5** | `cacheWrite` 按输入价计费 | **已修**：`deepseek-official` 且 `cacheWrite != 0` → `unsupported usage` |
| **R6** | `from: 2026-09-10` 之前的请求无价 | **保持**：`no price version`，由 `/cost` 报告 |
| **R7** | 用户表整体覆盖，缺家族时整族无价 | **部分**：面板已按 `unknown` 计数（尚无按模型聚合的明细） |
| **R8** | 改表不移动已封存金额；运行中进程持旧表会写回旧值 | **改为按投影处理**：改表在下一次扫描重算历史总额；`saveLedger` 仍拒绝较低 cut 或较低 `engine` 的写入，持旧表的进程无法覆盖较新的一次 |
| **R9** | 离线补账 | **确认无需修**：每次扫描全量重读 + 幂等替换，离线期间请求按原始时间入账 |
| **R10** | fork seed 重复计费 | **原本已实现**：`inheritedCut` 跳过继承请求 |
| **R11** | **`compaction/summary.usage` 未计费**（新发现） | **已修**：纳入 `BILLING_EVENTS`，按 summary 自带的 provider/model/usage 计价；无 usage 的模板摘要不算请求 |
| **R12** | **`loadLedgers` 删除无法解析的账本**（新发现，等价静默 reprice） | **随投影模型消失**：切片只存汇总，读不出的文件由下一次扫描重建，不再有需要抢救的字节 |
| **R13** | `request/header` 不能当逐请求时间锚点 | **证实**：真实日志 2,224 次请求只有 5 个 `request/header`、1 个 `request/context` |
| **R14** | `step/start` ≠ 每次请求（retry 在同一 step 内） | **证实**：`step()` 内部 `while (true)` 重试；若将来改锚点，首次 attempt 用 `step/start.time`、重试用 `llm/retry-started.time` |
| **R15** | fork/retry 的样本身份 | 保持 `key = 首个事件 seq`；将来迁 SQLite 时更名 `attempt_key_seq`，与 cursor 区分 |

## 9. 现有测试覆盖

- `tests/cost/cost.test.ts`：官方费率逐项断言（含被取代的别名必须能定价）、高峰/空闲边界（08:59/09:00/12:00/14:00/18:00、周六）、未声明模型不被猜测、`pro` 子串不再决定费率、规范化（含全角句点与大小写）、决策只返回金额或原因、价目表摘要随费率变化、`cacheWrite` 不被定价、无时间样本只计未计价、未计价请求在表覆盖后自动定价、改表在下一次扫描重算历史、切片文件只含汇总字段且不含提示词/供应商/用量。
- `tests/cost/config.test.ts`：首次种下、未编辑文件随随包表刷新、已编辑文件被保留、被取代种子被替换、无戳记的手写表不动、只读目录。
- `tests/cost/ledger-files.test.ts`：较旧 cut 与较旧 `engine` 的写入被拒绝、其他代数与外来文件被忽略、陈旧扫描无法覆盖较新切片。
- `tests/ui/app.test.tsx`：状态栏显示会话费用与括号内当天合计、`prices.json` 自定义时的标注、跨零点只移动当天分桶。

## 10. 结论与阶段状态

会审结论（2026-09-12 复核）：**账本改为宿主日志与价目表的投影后，落盘只保留会话汇总；原先"账本原子是一笔 attempt"的前提由"金额已封存、只能靠导入迁移"支撑，现在不再成立。**

```
① 计费语义（已完成）  aliases / 不猜 / NFKC / cacheWrite unsupported / missing time /
                      compaction 计费 / 自动重定价
                              ↓
② 账本投影（已完成）  每会话只存 会话总额 + 当天分桶 + cut/engine/catalog + 未计价原因；
                      逐请求记录、priceId/matchedBy/engine/catalog 逐笔审计、--reprice 全部删除
                              ↓
③ JSON → SQLite      可选：投影可重建，因此只需导入汇总；导入前后金额由同一张表决定
                              ↓
④ 增量扫描            未做：需要"安全 cut"（完整 step 边界）与小范围重扫，风险高一个量级
```

原则（复核后确认）：

- **Harness 事件日志是事实源**；账本是可重建的 projection，不是第二份 Session 数据库。落盘的汇总是缓存，删掉只会让下一次扫描重算。
- **金额由"当前加载的价格表 + 宿主日志"决定**，因此改表即改历史；这是自动修复的代价，也是它被接受的原因。
- **状态是每会话一行汇总**（会话总额、当天分桶、cut、规则版本、价目表摘要）；session／day 是仅有的两个查询维度，不再需要汇总表。
- **增量扫描与存储重构分离**：后者已完成，前者会把"纯函数全量重建"变成"有状态增量 fold"，风险高一个量级。
