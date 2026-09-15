# Agent Note：分层边界与朴素的 UI 契约

Status: implemented

## Problem

2026-09-11 的模块化拆分留下了五处目录结构无法表达的耦合，而每一处都已经产生过真实缺陷或擦边：

1. **UI 认识应用。** `StatusBar` 与 `CostPanel` 直接收下整个 `Controller`，`app.tsx` 里有 232 处 controller 调用。于是叶子组件手里握着切换会话、删除工作区、选择模型的能力。
2. **UI 导入传输域。** `safeText` 住在 `transport/wire.ts`，于是 `session/`、`ui/`、`cli/` 都要 import wire 才能清洗文本，"UI 不得调用传输 client"这条规则离失效只差一次改名。
3. **`session` 自己解析 wire。** `SessionController.waterfall(frame: ObjectValue)` 亲自读 `frame.event` 与 `frame.request`，而 `ConnectionController` 拥有 `Telemetry`、`runningUpdates` 与 `observedRunningAt`，于是宿主字段改名或 socket 变化会直接打到会话域。
4. **一个类装了三种生命周期。** `SessionInfo` 同时带着业务数据（`record`、`prompts`、`interaction`）、阅读状态（`view.scroll`、`view.folds`、`view.liveReasoning`）与纯键盘状态（`composer.cursor`、`reference.index`、`panels.*`），靠一次 `reset()` 重置，而行为取决于调用顺序。
5. **门面是第二个上帝对象。** `Controller` 暴露约七十个方法，其中很大一部分是 getter、格式化与一行的域透传；`perform(operation)` 还允许调用方把一段编排闭包交给应用。

## Decision

应用由**禁止边**描述，而不是由层级序号描述，因为真实依赖图是分叉的：`ui → controller`、`ui → contracts`、`controller → feature`、`feature → infrastructure`。`tests/architecture/dependencies.test.ts` 强制其中九条，每条一个合成拒绝用例，**且没有任何豁免**：

| # | 禁止 | 理由 |
| --- | --- | --- |
| B1 | `ui/*` → `controller`，除 `ui/app.tsx` 与 `ui/mount.tsx` | 叶子只收 props 与回调，不拿能力 |
| B2 | `ui` → `transport` | wire 不是表现层依赖 |
| B3 | `ui` → 任何 feature | 类型与 view model 走 `contracts.ts` 与 `src/*.ts` 叶子 |
| B4 | feature → `ui` | 业务域不知道有屏幕存在 |
| B5 | `controller` → `ui` | 不存在 `UiControl`：UI 自己持有机制 |
| B6 | feature → feature，**含 `import type`** | 跨 feature 由应用编排 |
| B7 | feature → `controller` | 业务域不依赖编排 |
| B8 | `transport`/`storage` → 任何上层 | 基础设施不认识上层名字 |
| B9 | `slash` → 自身以外 | 命令语法是纯叶子 |

配套决策：

- **wire 解码只有一个归属。** `transport/events.ts` 把 `$events` 帧变成 `HostEvent`、把 `session/control` 帧变成 `ControlFrame`。`connection` 只负责解码并调 `listener.event(event)`，由 `Controller.event` 路由到 `session`、`catalog` 或 `cost`。于是 connection 不再出现任何会话概念，session 也不再读宿主字段名。未识别的 waterfall 变成 `waterfall-delegate`，保住"必须回 `{kind:'next'}`，否则宿主事件链阻塞"这条不变量——直接返回 `undefined` 会把它丢掉。
- **状态属于它的所有者，`AppState` 只做组合。** `connection`/`session`/`cost`/`catalog`/`shell` 各自持有自己的状态对象；`State` 装 `operation`（应用自己的 busy/error 信封）、各 feature 快照与 `session`。`Telemetry` 与 `runningUpdates` 移入 `session/runtime.ts`，`ConnectionView` 从六个成员缩到 `fail` 与 `reply`。
- **状态尽可能靠近使用者。** `SessionInfo` 只留 `sessionId`、`record`、`prompts`、`window`、`interaction`。输入框（草稿、光标、寄存草稿）、`@` 菜单高亮、五个面板开关与阅读视图（滚动、折叠、实时折叠模式）都是 `ui/app.tsx` 的组件状态，由一处切换会话的 effect 清理——这复现了原先"草稿不跟随切换"的行为，却不再有第二个所有者。`pinned` 变成 `SessionController` 的私有标志，因为它是回收策略的输入而非会话数据。
- **命令切三段。** `slash/parse.ts` 回答"这行文本是什么意思"，不带任何 UI 事实；`ui/routing.ts` 回答"Enter 此刻意味着什么"并施加 screen/pending 守卫；应用回答"当前能不能执行"。
- **门面暴露三个面。** 生命周期（`start`/`stop`/`shutdown`）、`actions`（改状态，各自持有 busy/error 信封并回报完成）与 `queries`（只读）。其余五十余个实现方法全部 `private`，`perform` 已删除：`runAction`/`runActionValue` 是私有的，调用方不再提供编排。
- **UI 读朴素数据。** `contracts.ts` 是只含类型的模块（机械校验不出现 `const`/`function`/`class`）；`StatusSource` 与 `CostSource` 取代了 `StatusBar`、`CostPanel` 的 controller 参数；`Queries.render` 返回 `SessionRender`，于是 UI 不再 import 投影引擎。原先住在 feature 里的呈现层搬到组件旁边：会话/工作区列表词汇 → `ui/chat/navigation-model.ts`，`costText` → `ui/status/model.ts`，`plainRows` → `ui/chat/shell-view.ts`。域与 UI 都要用的函数放进无依赖叶子：`json.ts`、`text.ts`（`safeText`/`errorText`/`toolLine`）、`session-title.ts`、`references.ts`。

## Alternatives considered

- **用一个 `stat/` 商店模块持有 `AppState` 与 `SessionInfo`。** 否决：把状态集中到一个技术模块，会让它依赖它所描述的每个 feature，于是它成为下一个耦合中心而不是基础层。
- **让 controller 持有 `UiControl`**（以便切换会话时关闭对话框）。否决：它让业务代码知道 modal、notice 与 copy mode，将来每个前端都会继承这份知识。UI 现在自己从 `state.sessionId` 关闭自己的界面。
- **把 `slash/` 做成带 `SlashHost { session, navigation, cost, ui }` 与独立执行器的域。** 否决：它同时知道 UI 与业务动作，那是应用的职责；只有语法值得做成叶子。
- **把 view model 放进 `stat/selectors/`。** 否决：那样状态栏改一次列顺序就得改状态层。它们住在组件旁边，只有跨 feature 的组合才属于应用。
- **保留一个 `core/types.ts` 放 `ObjectValue` 来绕开 state → transport 规则。** 否决：那只是把耦合换个位置；宿主行在类型化的 summary 落地前由 `json.ts` 的读取器读取。
- **允许 feature 之间"只是类型"的导入。** 否决：类型依赖同样是变更依赖。

## Consequences

`npm run typecheck`、`npm test`（265 项）与 `npm run test:terminal` 全部通过，终端黄金文件逐字节一致，因此没有用户可见的行为变化。有意的语义变化都在内部：action 失败时返回 `false`/`undefined` 并把文本写进 `operation.error`，而不再抛错；因此对话框、作答流程与输入框现在显式判断，而原先靠异常跳过后续语句。

`SessionController` 与门面删掉十六个会话状态方法，`ConnectionView` 删掉三个，门面的公开面只剩生命周期加两个具名契约。门禁为每个禁止方向配了合成用例，所以回归会以"违反了哪条规则"失败，而不是表现为一次渲染意外。

仍然未做、且明确记录而非悄悄丢弃的：UI 仍在传 `Transcript` 值（`Queries.render`、`older`、`historyAt`、`setViewWindow`），方案中的 `SessionSnapshot` 与 `HistoryPage` 尚未落地；宿主列表行在类型化 summary 之前仍是 `ObjectValue`；`operation.error` 仍把 connection、session 与 action 三类失败写在一行，因为拆分会改变 UI 的显示。`tui-design.md` 与 README 双语已在同一次变更中刷新。
