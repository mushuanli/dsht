# Agent Note: 终端模型选择与 Agent preset 状态

Status: implemented

## Problem

终端已展示模型遥测，但没有模型选择入口；固定标题也未展示会话所用 Agent preset 的名称。

## Decision

沿用 Session Controller 的 `session/modelCatalog` 和 `session/selectModel` 接口。目录定义 provider／model ID 及可选思考强度。`/model` 打开模型选择器，支持思考强度的模型再打开强度选择器，也可直接接受 provider、model 和可选 effort ID。失败 provider 的提示与正常选项一起显示。服务端验证并规范化选择，记录为后续请求使用的模型，并尝试保存部署默认值。选择器在选择前说明作用范围，不修改服务端文件。

模型展示继续由 `modelSelection.next` 和 `lastUsed` 驱动，不伪造投影序号或在失败时乐观更新。目录读取和变更确认在影响 UI 前检查所选会话代次。切换会话、输入其他命令或按 Escape 时关闭选择器。

`agentPreset` 投影提供当前预设 ID，与网页 AgentPresetLabel 一致；`agentPresets/list` 提供信任来源及展示元数据。已知系统预设显示 Standard mode、PTC mode、Minimal mode、Creator mode，自定义元数据保持原样，缺失目录项时回退到 ID。所选会话存在 preset 时，每次连接按需读取一次可选目录，沿用目录任务的连接检查和退出等待机制。Plan 是独立功能，不作为模式标签。窄终端标题省略模式，`/status` 仍可查看。

## Alternatives considered

修改 provider 配置或猜测模型选择端点会绕过服务端选择验证和持久投影。硬编码强度会排除适配器自定义选项。将新模型显示为当前请求正在使用的模型，会误报服务端仅作用于后续请求的行为。

## Consequences

模型切换也会尝试更新服务端默认值，此 API 没有仅保存当前会话的选项。当前请求继续使用原选择。预设标签与网页会话标题一样只读，已开始对话不能切换 agent 组成。类型检查、构建、终端回归测试和 HTTP 测试夹具验证选择报文、可选强度、provider 失败、变更拒绝及四个内置模式名称、自定义名称、未知 ID 及目录请求复用。
