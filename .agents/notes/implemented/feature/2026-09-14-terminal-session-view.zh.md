# Agent Note：阅读视图属于它自己的会话

Status: implemented

## Problem

阅读视图原先住在 `ui/app.tsx`：显示哪份记录（读者跳到旧历史时是一份独立的 `Transcript`）、读者往回滚了多远、哪些推理块被展开、以及回收是否被暂停。独立窗口只由一个以该组件状态为键的清理 effect 释放，而回收保护标志住在 `SessionController` 的私有字段里，其依据的视图却住在组件里，两者无法放在一起推理。

## Decision

`SessionInfo.view` 现在持有 `{ window, scroll, pinned, folds, liveReasoning }`，只由 `SessionController` 写入（`setViewWindow`、`setScroll`、`setFolds`、`setLiveReasoning`、`pinHistory`）。`setViewWindow` 会释放被替换的窗口（`releaseHistoryLayout` + `dispose`），`SessionInfo.reset()` 调用同一个 `closeWindow()`，因此切换会话不会泄漏一份记录。行缓存保持原位：`WeakMap<Transcript, LayoutIndex>` 不需要进状态，但需要它的键被强引用持有——`view.window` 现在就是那个强引用。

`view.pinned` 保留原来的两个写入者：`older` 在扩展实时记录时强制置位，UI 通过 `pinHistory` 发布它派生的规则。合并规则仍未定，因此这次迁移保持既有语义，而不是悄悄改变回收恢复的时机。

## Alternatives considered

把视图留在组件里、只把释放逻辑移进控制器被否决：窗口会有两个生命周期不同的所有者。把 `pinned` 完全从视图派生在这一步被否决，因为 `older` 也会为"回填在读者仍停在实时末端时取回的那一页"置位，而目前没有对应的视图谓词。把 `view` 放进 `State` 而不是 `SessionInfo` 里被否决：会话事实应当只有一个所有者。

## Consequences

`tests/ui/app.test.tsx` 新增一条：跳转到一个未加载的记录（会构建独立窗口），切到 `s2`，断言窗口已消失、`scroll` 与 `folds` 归零、旧窗口的 `ready` 为 false。`tui-design.md` 的 5.3 / 5.5 / 5.7 与附录记录了新的所有者。没有用户可见行为变化，因此 README 双语未改。尚未完成：`panels`、`answers`、`reference`，以及 `record` 的统一。
