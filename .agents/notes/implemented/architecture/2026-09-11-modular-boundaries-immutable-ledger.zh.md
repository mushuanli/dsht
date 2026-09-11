# Agent Note: 模块边界与不可重算的费用账本

Status: implemented

## Problem

本仓库把互不相关的职责集中在三个文件里：`controller.ts`（854 行）混合了连接生命周期、会话历史、模型元数据与计费；`app.tsx`（717 行）混合了命令知识、展示逻辑与界面状态机；`cost.ts`（285 行）混合了价格表、记录折叠、持久化与汇总。计费还会在每次扫描时按当前加载的 `prices.json` 重新计算全部已存请求，因此修改价格表会改写已经展示给用户的金额。

## Decision

源码在 `src/` 下按业务域组织。`transport/` 负责服务端 wire 协议与认证，`session/` 负责对话、排版、遥测、导航与交互，`cost/` 负责价格、记录折叠、存储、账本、扫描器及其控制器，`catalog/` 负责模型路由与 preset，`controller/` 是应用门面，`ui/` 承载全部 React 与 Ink，`cli/` 是组装入口。`state.ts` 保存共享的 `State` 与 `ControllerStore` 契约，`transport/host.ts` 保存 `HostAccess` 契约，`session/connection-view.ts` 保存会话域读取的连接事实。

`Controller` 现在是 `ConnectionController`、`SessionController`、`CatalogController` 与 `CostController` 之上的门面。它保留界面与测试原本使用的构造函数和全部公开方法、逐一委托，自身只负责状态发布、选择器世代与生命周期。连接世代、重连退避、`$events` 与 `session/control` 属于 `ConnectionController`；所选会话、follow 流、历史与交互属于 `SessionController`；模型与 preset 加载属于 `CatalogController`；后台扫描属于 `CostController`，单会话读取位于 `cost/scanner.ts`。

费用账本现在是不可重算的。每条 charge 记录首次求值时确定的 `priceId` 与 `amount`，之后扫描复用该决定，而不再按当前表重新计价。只有没有可用用量的样本保持开放，因为该请求尚未报告完 token；其余决定——已计价、估算或未计价——一律终局。落盘文件为第 2 代，不内嵌价格版本；其他世代的文件会被忽略，并由下一次扫描重建，而不做迁移。

`app.tsx` 保留界面状态机与键盘路由，展示与命令知识外移：`ui/commands/registry.ts` 负责命令目录、补全与候选，`ui/commands/parse.ts` 把一次提交归类为动作，`ui/dialogs/` 负责选择器、各面板与费用面板，`ui/chat/` 负责标题、视口与状态栏，`ui/input/` 负责输入框、回填、鼠标与引用菜单，`ui/mount.tsx` 是唯一通过 Ink 渲染的模块。

`tests/architecture/dependencies.test.ts` 强制该边界：每个单元只能导入为其列出的单元，React 与 Ink 只能出现在 `ui/` 下，且 `ui/` 不得直接调用传输层 client。包对外接口通过 `src/index.ts` 与内部布局解耦：`@itookit/dsht` 指向 `dist/index.js`，`@itookit/dsht/auth` 指向 `dist/transport/auth.js`，`dsht` 可执行文件指向 `dist/cli/index.js`。

## Alternatives considered

按操作把 `Controller` 拆成 `PromptService`、`QueueService` 等服务被否决：原问题是四个业务域，而不是许多小服务，按方法拆会把同一个状态机分散到总是一起改动的文件里。保留重新计价并增加失效键被否决，因为已展示的金额仍会在事后变化。迁移第 1 代缓存文件被否决，因为缓存可丢弃，下一次扫描会从服务端历史重建。

把费用面板留在 `cost/` 下被否决，因为它渲染 React；把命令归类留在 `app.tsx` 被否决，因为补全、帮助与提交会继续保留三份命令清单。把提交分发器进一步拆到 `ui/commands/execute.ts` 被推迟：它需要约二十个 React setter 组成的上下文，只会搬移代码而不会降低耦合。

## Consequences

wire 协议、slash 命令、CLI 参数、事件语义与终端输出均保持不变；唯一有意的变化是已确定的 charge 不再跟随 `prices.json`。`npm run typecheck`、`npm test`（129 项）、`npm run test:terminal` 与 `npm run test:package` 全部通过。测试现已镜像模块划分，两项新的费用测试固定不可重算性，另有一项新用例证明依赖门禁会拒绝被禁止的方向。

`README.md` 与 `README.zh.md` 配对文档记录了不可重算账本与模块布局，`README.i18n.yaml` 记录了重新评审后的哈希。`app.tsx` 仍在约 540 行：它是唯一的界面状态机，剩余部分是内聚的状态与路由，而不是混杂职责。费用缓存属于本地状态而非配置，丢弃旧一代只需一次重新扫描，不丢失用户数据。
