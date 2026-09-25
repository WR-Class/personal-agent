# 交互式 CLI 第一版实施与验收

2026-09-24。用户要求先解决“测试费劲、不是完整 CLI”的体验问题，因此本轮优先交付持续对话入口，附带必要响应校验与取消；不是宣称 PR2–PR5 全部完成。

## 使用入口

```powershell
Set-Location D:\DSHXM\AgentKHD\personal-agent
npm.cmd start
# 或：npm.cmd start -- --echo
```

无 prompt 时进入首次向导/持续对话；有 prompt 时保留单次模式。缺模型配置不再静默 Echo。无 API 可显式 --echo 或向导选择 echo。

支持 /help /new /sessions /resume <id> /history /compact /inspect [id] /recover [id] /status /exit。每次默认新唯一会话；已保存会话显式恢复，不自动将上次内容发送给新 Provider。`/inspect` 诊断损坏行和未完成工具组；`/recover` 只追加补齐消息，不重跑工具；`/compact` 显式压缩上下文（只缩短 prompt，原始消息全部保留，`/history` 仍完整），`/status` 现在会列出全部上限与按模型窗口。会话仍未绑定 Provider/workspace 元数据，恢复时需确认当前状态。

运行预算（标志与环境变量等价，标志优先；非法值退出码2）：

| 预算 | 标志 | 环境变量 | 默认 |
|---|---|---|---|
| 模型调用次数 | --max-steps | PERSONAL_AGENT_MAX_STEPS | 10 |
| 单步工具调用数 | --max-tools-per-step | PERSONAL_AGENT_MAX_TOOLS_PER_STEP | 8 |
| 整轮工具调用数 | --max-tools | PERSONAL_AGENT_MAX_TOOL_CALLS | 32 |
| 整轮挂钟上限(ms) | --max-send-ms | PERSONAL_AGENT_MAX_SEND_MS | 300000 |
| 单次 prompt 字节上限 | --max-context-bytes | PERSONAL_AGENT_MAX_CONTEXT_BYTES | 524288 |
| 单次 input token 上限 | --max-context-tokens | PERSONAL_AGENT_MAX_CONTEXT_TOKENS | 131072 |
| 按模型 token 窗口 | 无标志 | PERSONAL_AGENT_CONTEXT_WINDOWS | 无（用上一行全局值） |
| 精确 token 预判命令 | 无标志 | PERSONAL_AGENT_TOKENIZER | 无（显示"未测量"） |
| SSE 流式传输 | --stream | PERSONAL_AGENT_STREAM=1 | 关（非流式） |

**`--stream` 到底做了什么、没做什么（不要误读）**：它让请求体带上 `stream: true` 与 `stream_options.include_usage`，并把 SSE 分片**组装回与非流式完全相同的 `ChatResponse`**，因此回答文本、usage、工具调用、预算行**都不变**——已用真实端点验证两条路径输出逐字相同。它的价值是**兼容只支持流式的端点**，以及沿用同一套 1MiB 字节上限与 abort 能力。

它**不是**增量显示：本项目把响应体整段读入并受同一上限约束后才解析 SSE，所以**不会**逐字实时打印（`ponytail:` 记在 `parseSseCompletion` 上，升级路径是从 `for await` 循环喂同一个组装器）。默认关闭，因为流式会改变请求体，严格的服务器不该连默认路径都被拒绝。

**传输失败点名原因**：`fetch` 对一切传输失败都只抛一句 `TypeError: fetch failed`，真实原因藏在 `.cause` 里。适配器现在把它上浮——例如 `fetch failed: bad port`（fetch 按 WHATWG 禁连端口列表对某些端口**一律拒绝**，任何 I/O 之前就失败）、`ECONNREFUSED`（没有服务在听）、DNS/TLS 消息——而用户主动取消（abort）保持原语义，不被改写成传输原因。

`--preflight` 是**联调准备检查**（不与 prompt/`--list`/`--echo` 混用）：报告配置完整性、**未鉴权**端点可达性、tokenizer 命令可执行性、真实 TTY 状态。它**不发送密钥、不读响应正文、不读凭据文件、不消耗 token**；退出码 `0` = 可以尝试，`3` = 不可尝试（缺完整环境变量配置，或已配置的 tokenizer 命令无法运行），`2` = 参数/路径错误。分步操作与证据要求见 [联调 Runbook](LIVE_INTEGRATION.md)。

算子行（`[步骤 …]`）现在会在 provider 上报推理 token 时追加 `· 推理 N`；`N` 是**输出 token 中**由 provider 标为推理的部分，不是额外增量，也不参与上限计算。若 provider 给出推理文本（`reasoning_content`），会在答案**之前**以 `[思考] …` 打印；推理文本**不落盘、不回传**（见 [SAFETY](SAFETY.md)）。

超限时分别抛 `StepLimitError` / `ToolBudgetError(step|run)` / `DeadlineExceededError` / `ContextBudgetError` / `TokenBudgetError`；deadline 会送达 adapter 的 signal，但无法强杀忽略 signal 的进程内代码。上下文预算是**字节**上限，不是 token 计数，也不做截断：超限即报出实际字节数与上限并拒绝，且在写入用户轮次之前拒绝。

token 上限有三层，声明各自来源，不混成一个数字：**本机 tokenizer 计数**（宿主通过 `PERSONAL_AGENT_TOKENIZER` 提供命令：读 stdin 的 prompt JSON、向 stdout 打印一个非负整数；可判断"即将发送"的 prompt，失败/超时/非数字一律报错，不静默退回估算）→ 否则 **provider 自己上报的 `usage.inputTokens`**（实测值，代价是首轮尚无测量、且只能在数字被上报后的下一次调用前停下）→ 两者都没有时显示"未测量"。`PERSONAL_AGENT_CONTEXT_WINDOWS='{"<model>":<tokens>,"*":<tokens>}'` 为指定模型**替换**全局 token 上限（精确模型名优先于 `*` 优先于全局），但它只作用于 token 上限，**不派生字节上限**（那需要 bytes/token 假设）。每次发送后会打印一行剩余量，超限显示"超N"而不是负剩余。**本项目不内置分词器**。

压缩（`/compact`）语义：追加一条 `summary` 事件记录 `covers`（= 当时的 message 数，由 store 实测），只改变 prompt 的构造，message 一条不删；未完成工具批次、空摘要、`covers` 与实际数量不符都会被拒绝；总结调用不给任何工具。**摘要质量无自动判定**，本批只保证不改写、不越界、不丢消息。

## 模块增量地图

| 文件 | 职责/变化 |
|---|---|
| src/terminal.ts | 可注入 TerminalIO、readline 输入队列、秘密输入禁回显/拒绝提前输入、终端控制字符转义、EOF/显式退出区分 |
| src/cli-config.ts | 模型配置 Schema/URL 检查，环境优先且三项完整，安全普通文件读取、独占保存、明确明文密钥保存选择 |
| src/interactive.ts | 持续对话、会话命令、串行发送、取消控制和提示 |
| src/cli.ts | 默认交互入口，--echo/--help/-- 分隔、严格缺值检查、预算标志与环境变量；历史无需 Provider |
| src/response-validation.ts | 自定义及 HTTP adapter 的响应结构/调用 ID/用量检查 |
| src/runtime.ts | activity 回调、单实例 busy guard、取消边界；已持久化工具组补齐未执行工具的取消结果 |
| src/openai-adapter.ts | unknown JSON 校验，不再缺省合成不可靠 ID；错误正文不打印 |
| src/security-config.ts | provider-config.json 在旧/其他 home 也视为敏感文件 |
| test/interactive.test.ts | 9 个新增顶层回归，涵盖对话/配置/错误/取消/外发边界 |
| package.json | npm test 显式启用 TS 剥离并发现 test/*.test.ts |

## 凭据与保存语义

- Enter 默认只保存 URL+model；下一次隐藏询问 API key。no 不保存；key 才明文保存密钥。
- 文件在 Agent home/provider-config.json，wx 独占写、不覆盖现存路径，拒绝读取链接/多硬链接/超大文件，POSIX 创建 mode0600。
- Windows 不声称 mode0600 等于私有 ACL；不是系统凭据库。文件请勿提交或分享。
- 任一 Provider 环境变量非空时须三者齐备，绝不把旧密钥与新环境 URL 自动混合。
- URL 不允许账号密码、query、fragment；远程 HTTPS，本机回环允许 HTTP。
- 所有保存路径沿用 PR1 保护规则；配置损坏不回显原文。手工改配置后下次启动生效；暂时无 /config 更新命令。
- 伪造 ToolEnvironment/非只读工具仍拒绝，旧自定义 home 的配置也不可被 read_file 外发。

## 取消语义与限制

- 入口预取消不写会话；模型返回后验证取消与形状，再落 assistant/usage。
- 中断已开始工具时等待它 settle，不通过 Promise.race 让后台继续修改；未开始工具不执行，但追加取消结果补齐本批 call IDs。
- 空闲 Ctrl+C 关闭输入并清除排队行；自然 EOF 则排空管道输入。
- 取消不撤销已执行/已保存内容。若磁盘写失败，仍可能留不完整组；这是后续事务/恢复任务，不属于本次“正常取消配对”保证。
- 单实例 busy guard 不等于跨实例/跨进程锁；Mock 忽略 signal 时不能强制终止，必须等返回。

## 验证结果

Windows / Node24.19.0，npm11.17.0：

- npm.cmd run build：通过（tsc --noEmit）。
- npm.cmd test：97 tests，96 pass，0 fail，1 skip；旧符号链接用例受环境权限限制。（这是本文件对应批次的历史值；当前总数为122项，见 [VALIDATION](VALIDATION.md)。）
- --help 实际入口退出0。
- PowerShell 管道向实际 CLI --echo 输入 hello、/status、/sessions、/exit：显示状态/回显/会话列表后退出0，fixture 独立保留。
- 无真实网络调用；所有测试 synthetic key/mock adapter。测试目录不删除。
- 独立只读审查发现并修复：旧 home config 可读、秘密输入部分 type-ahead、JSON 解析错误泄漏片段、显式退出残留队列。回归覆盖前两类配置泄漏，终端输入保护经源码复核。

**未验证**：实际 TTY 密钥回显/Ctrl+C、真实 Provider、跨平台、Windows 8.3 专项。当前工具接口没有 PTY，因此没有把 fake IO 的 secret 标志测试冒充真实终端验证。使用者应在 PowerShell 完成首次手动体验。

## 后续顺序

1. 收集实际 PowerShell 使用反馈、真实 Provider 联调与可选流式输出。
2. 补完整事件/参数 Schema、session 并发锁和崩溃恢复。
3. 再考虑权限审批与受控写入；没有开放 shell 或删除工具。

本轮不修改 DSH/外部参考项目，不安装新依赖，不初始化 Git，不自动清理数据。
