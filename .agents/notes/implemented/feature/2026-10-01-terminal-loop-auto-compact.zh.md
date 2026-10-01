# Agent Note：auto compact 是一次 `/loop` 运行自己确认的限制

状态：已实现

## 问题

评分循环是本客户端里跑得最久的东西。十轮的 brief、回复与验证判定都写进同一个 session，操作者没盯着的时候 history 只会单调增长——而它以最糟的方式失败：跑到一半、前几轮都通过的那一轮，宿主开始拒收或悄悄截断。`/compact` 本来就有，但它只是操作者得记得在轮次之间自己敲的一行，而那正是没人看屏幕的时候。

## 决定

auto compact 是**一次运行的限制**，不是客户端设置，并且和轮次、及格线一样在同一个参数表单里确认。表单多出第五个共享数字 `Auto compact`，单位千 token。分数在所有读它的地方都带着刻度——记录列表与启动提示里是 `pass 8/10`，表单里是 `8 / 10`——而每一行都写出它数的单位（`1 round`、`8 / 10`、`10 per round`，阈值则是 `off · K tokens` / `150K tokens`），没有哪个值是含义要靠记的裸数字；`0`（默认）表示从不压缩，所以没要求它的运行什么都不变。

阈值比较的是宿主自己对下一请求上下文的投影（`contextPressure`，也就是状态栏显示的那个数），而不是客户端对 transcript 的估算：`LoopHost.historyTokens(sessionId)` 读它，`LoopCoordinator.compactDue` 判它。判定发生在 prompt 已经等着、客户端其余条件都已就绪的位置——`flushLoop`，以及 `startLoop` 里的首发——因此压缩绝不会与某一轮交错：紧随其后的那一轮，就是写进压缩后历史的第一件事。压缩本身是 `LoopHost.compact`，即经由操作者同一行的会话层发出的宿主 `/compact`，跑在运行自己的 `AbortController` 下，所以 `/loop stop`、切换会话、截止时间或替换它的新运行都能取消它。

三个细节决定了这是功能而不是陷阱。宿主不发布上下文投影时无法判断，于是照常发送并记 `compact-skip`，不靠猜。压缩失败只写进进度行的 note，不算判定：这一轮仍然值得跑。而因为无事可做时判定是同步的（`compactDue` 返回 undefined），默认路径保持了原有的发送顺序——在那里插一个 `await`，长到足够第二个 `/loop` 抢走 session。压缩进行期间运行的 activity 是新增的 `LoopActivity` `compact`，因此状态栏如实显示 `Compacting` 而不是 `Agent`，哪怕它要跑几分钟。

命令行仍然没有这个旗标。它与记录的 `vars` 同类：这是对**这个** session 历史的按次决定，而表单是它在被花掉之前能被看见的地方；`LoopOptions` 像 `vars` 一样把它交回应用。

## 考虑过的替代方案

客户端级设置（`--auto-compact`、环境变量）被否掉：合适的阈值取决于这次运行——对小文档的十轮审查和对三次重试不是一回事——而全局默认要么对所有人关闭，要么吓到本不需要它的运行。用 transcript 自己的字节数或消息数代替宿主投影同样被否：宿主已经在度量它即将发送的东西，对同一件事的两套度量迟早会互相矛盾。定时压缩被否：它会在某一轮飞行途中重写历史。把阈值判断放进 `LoopHost` 被否，是为了让比较、note 和 trace 事件待在一处，紧挨着拥有这个数字的那次运行。在调用方的 `Starting loop…` 信封里、首发之前压缩是有意为之并写进文档的：替代方案是把第 1 轮发进刚刚被这次运行判定为不可工作的历史。

## 后果

`LoopLimits` 与 `LoopProgress` 带 `autoCompactK`（0 = 关闭），`validLoopOption('autoCompactK', …)` 是表单与命令行共用的那条规则，`ScoredLoop.compacting()` 是新的子状态。`tests/controller/loop-coordinator.test.ts` 固定判定（没有投影、低于、高于，以及失败后仍发送）；`tests/controller/loop-run.test.ts` 固定端到端接线——宿主投影 150k 时，运行在第一条 `session/prompt` **之前**发出 `commands/execute /compact`，并记录 `auto compact · 150k tokens · …`；`tests/ui/loop-form.test.tsx` 固定该行（`off · K tokens`、`150K tokens`、接受 `0`、拒绝小数）；`tests/ui/loop-status.test.tsx` 固定 `auto 150K tok` 后缀（状态栏自己的缩写，与 `1K tok` 并列）。`loop.md` §4.6、`slash.md` §2.4、`tui-design.md` §3.2 与 README 双语对记录了这个字段与它没有旗标这件事。版本 0.6.18。
