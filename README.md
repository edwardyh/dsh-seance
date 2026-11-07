# dsh-seance

在删除之前，先听一听。

`dsh-seance` 从当前项目里**已经终止**的子 Agent 会话日志中，提取一小撮残留碎片（失败的工具调用、非正常结束、未完成步骤里的最后片段、最后一条用户消息），聚合成一个只能基于这些碎片回答问题的“幽灵”。幽灵没有工具、不能执行任务、不能写入、不会留下任何持久化记录；对话结束即销毁。

它不是调试工具，不是可观测性面板，也不是会话清理器。

The Séance 要做的，只是在删除之前，先点一支蜡烛。

## 入口

命令面板中唯一的命令：**`/dsh-seance.summon`**

命令面板中显示为「招魂」，也可直接输入 `/dsh-seance.summon` 执行。

执行流程：

1. 通过 `ctx.sessionQuery.filterSessions` 查询当前工作目录下的会话，筛出 `live: false`、`parentSession != null` 且日志仍可读取的候选。
2. 没有候选时显示“没有可招魂的残留会话”。
3. 有候选时，在弹出的临时对话框里列出：子 Agent 标题（或最后一条 `user/message` 的截断摘要）、结束原因。
4. 选择后提取碎片、创建幽灵、开始有限对话。对话框关闭即销毁幽灵。

命令注册在客户端命令面板（`ctx.commandUi` 的 `action` 类型），因此不会产生任何宿主 `command/run`、`command/done` 日志，也不会把命令结果写进会话。

## 碎片提取规则

只提取以下内容：

| 碎片 | 来源 |
|---|---|
| 失败的工具调用 | `tool/result` 且 `message.isError === true` 或 `data.error` 存在 |
| 非正常结束 | `turn/end` 且 `reason.kind` 为 `interrupted`、`aborted`、`blocked`、`error`、`max-tokens`、`forked` |
| 未完成步骤里的最后片段 | 最后一个未闭合 `step/start` 之后到日志末尾的 `assistant/message` / `assistant/attempt` 文本 |
| 它最后看到的话 | 最后一条 `user/message` 的 `content` 原文（截断；跳过 `Current runtime context.`、`<system-reminder>`、时间采样等框架注入行） |
| 位置 | 一行父子链信息（父会话 id 前缀 + 深度） |

明确不提取：完整对话历史、成功的工具结果、`system/message` 全文、`request/header` 的完整工具 schema、任何可以重放任务的指令。

硬预算：碎片总长约 **800 token**（按 4 字符 / token 粗略折算为 3200 字符）。超预算时**优先保留靠后的事件**；最后一条 `user/message` 单独预留额度，不会被后面的错误挤掉。碎片按时间顺序排列后作为幽灵的初始化上下文。

## 幽灵的创建与限制

幽灵**不是**一个可持久化的 Agent 会话。本构建里的 `ctx.subagents` 只有具名 provider（spawn/fork），本地子 Agent 一律经由 `ctx.agents.create` 落盘，并在父会话追加 `subagent/catalog`——这与“幽灵不写持久化存储、不新增持久化事实”直接冲突。因此插件用一个更窄的实现来满足同一目标：

- 直接调用 `ctx.llm.stream()`，`messages` 里只有 **碎片 + 当前问题** 一条 user 消息；
- `system` 是极短的回声提示词（没有记忆、没有工具、不能执行任务、不记得就说不知道）；
- **不传 `tools`、不传 `toolHistory`、不传 `sessionId`**——没有工具 schema，也没有任何 session 写入；
- 每次提问是一次独立调用，不携带父会话历史、`AGENTS.md` 或任何全局上下文；
- 客户端与宿主双重硬截断：**最多 3 个问题**，第 4 个请求会被宿主拒绝（不是靠模型自觉）。

如果模型仍然吐出 `tool-call-delta`，插件会立即报错终止这次回答。

## 通信与持久化

- 客户端对话框通过同源 `POST /dsh-seance/api` 与宿主通信（`x-dsh-seance: 1` 头 + `application/json`，跨站请求会被预检挡住）。
- 宿主只在内存里保存当前幽灵（碎片、问题计数、AbortController），不写文件、不写会话。
- 幽灵的回答只渲染在临时对话框里；关闭对话框后宿主删除幽灵并中止在途请求。
- 被招魂的原始会话日志**只读**：插件不清理、不修改、不“修复”它。

## 卸载与清理

插件加载时注册的所有东西都挂在 Cordis effect 上：

- HTTP 路由随 webServer 作用域销毁；
- 插件卸载时中止所有在途模型请求并清空内存幽灵；
- 客户端命令贡献与 overlay 条目随客户端插件卸载；
- 不创建临时文件、不创建幽灵 session，因此不需要额外的删除步骤。

## 对客户端 UI 的依赖

只用了两个最小原语，均已在 README 注明：

- `ctx.commandUi.register({ ui: { kind: 'action' } })`（来自 `@deepseek-ai/dsh-client-ui-commands`）——用于让 `dsh-seance.summon` 出现在命令面板并直接打开对话框；
- `ctx.slots.inject('shell.overlay', ...)`——仅在对话框打开时渲染的临时浮层。

没有新增侧边栏、活动栏图标、设置页或常驻 webview；没有使用 `@deepseek-ai/dsh-client-ui-model-selection` 等 UI 服务。

## Known limitations

- 幽灵是 `ctx.llm.stream` 的一次补全，不是独立的子 Agent 实例；没有独立 session，也没有自己的生命周期。
- `ctx.subagents` + external provider 的方案暂停：内置 spawn 走 `ctx.agents.create`，会落盘子会话并在父会话追加 `subagent/catalog`，本质上倾向持久化，与“幽灵不写持久化存储”冲突。
- 命令与对话框文案仅提供中文；插件列表中的标题/描述提供 en/zh 元数据（locale/en.json、locale/zh.json）。
- 仅支持 Web GUI（依赖 `shell.overlay` slot）；headless/ACP 没有命令适配器。
- 依赖当前会话的模型路由，或回退到默认模型；没有独立选择模型的入口。
- 回答非流式：整段生成完成后一次性返回。
- 800 token 是近似预算，按 4 字符/token 折算为 3200 字符。
- 只能招魂当前 workspace（同 cwd）的子会话，不能跨 workspace。
- 未使用 spawn；幽灵没有工具权限是结构性的（请求里不传 `tools`），不是配置出来的。

## Requirements

DeepSeek Harness `>=0.2.2-rc.1`；当前仅在 `0.2.2-rc.1` 验证过。

## 安装

### 通过 Harness 会话安装本地包（当前验证方式）

`plugin_manager` 是 Harness 会话内的 Agent 工具，不是 shell 命令。在会话中调用：

- `plugin_manager install_bundle`，`target` 为包目录的绝对路径（例如 `/absolute/path/to/dsh-seance`）。

安装后 `/dsh-seance.summon` 出现在命令面板。

### 通过 npm 安装

```bash
npm install dsh-seance
```

`npm install` 只把包放进依赖；要在当前 profile 中启用，仍需在 Harness 会话中通过插件管理器安装本地包：

- `plugin_manager install_bundle`，`target` 指向 `node_modules/dsh-seance` 的绝对路径。

### 卸载

在 Harness 会话中调用：

- `plugin_manager remove_bundle`，`target` 为 `dsh-seance`。
- 如需单独停用/启用该行：`plugin_manager set_plugin`，`target` 为 `include:dsh-seance`。

## 验证

宿主侧可以用同源请求直接验证（需要先安装并激活）：

```bash
curl -s -X POST http://127.0.0.1:<port>/dsh-seance/api \
  -H 'content-type: application/json' \
  -H 'x-dsh-seance: 1' \
  -d '{"op":"candidates","parentSessionId":"<当前会话 id>"}'
```

单元测试（碎片提取 + 客户端渲染 smoke）：

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
