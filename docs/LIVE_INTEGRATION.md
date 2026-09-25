# 真实 Provider 与实体 TTY 联调 Runbook

本文件是**操作步骤 + 证据要求**，不是"已完成联调"的声明。当前仓库内已验证的最远边界是[本机真实 socket 联调](../test/provider-integration.test.ts)；外部托管 Provider 与实体终端**尚未执行**，原因见第 4 节。

## 1. 先跑准备检查（不需要凭据，不消耗 token）

```powershell
Set-Location D:\DSHXM\AgentKHD\personal-agent
npm.cmd run build            # 必须先过类型检查
npm.cmd start -- --preflight  # 联调准备检查
```

`--preflight` 只报告**观察到的事实**，并且：

- **不发送密钥**：可达性探测是 `GET {baseUrl}/models`，**不带 `authorization` 头**，因此不会意外产生一次已鉴权调用；401/403 同样算"可达"。
- **不读取响应正文**：只取状态码，正文一律 `cancel()`，避免把代理返回的错误页（可能回显凭据）带进终端。
- **不读取凭据文件**：只报告环境变量状态。因此"已保存 provider-config.json"不会被它代为保证。
- **不显示密钥**：不显示内容、长度或任何片段。
- **会真实执行一次 tokenizer 命令**（若已配置），因为它不可运行会让每次发送都失败。

退出码：`0` = 可以尝试；`3` = 不能尝试（缺完整环境变量配置，或已配置的 tokenizer 命令无法运行）；`2` = 参数/路径配置错误。

## 2. 真实 Provider 一次最小联调

用环境变量给出三项（不要写进文件，避免把密钥落盘）：

```powershell
$env:PERSONAL_AGENT_BASE_URL = "https://<host>/v1"
$env:PERSONAL_AGENT_MODEL    = "<model>"
$env:PERSONAL_AGENT_API_KEY  = "<key>"          # 仅本次会话
Set-Location D:\DSHXM\AgentKHD\personal-agent
npm.cmd start -- --preflight                     # 期望 exit 0
npm.cmd start -- --session live-1 "只回复：OK"    # 最小一次发送
```

**记录为证据的内容**（缺一不可，否则只能说"跑过"，不能说"验证过"）：

1. `--preflight` 的完整输出与退出码。
2. 那条发送的完整输出，**含**末尾 `[步骤 … ]` 预算行（它同时证明 usage 被 provider 上报）。
3. 退出码。
4. 会话日志路径（`<home>/live-1.jsonl`）与其中 `usage` 事件的 `inputTokens/outputTokens` 数值。**不要把密钥或完整响应正文贴进文档。**
5. 若失败：错误类别 + HTTP 状态码（例如 `HTTP 401`），**不要**粘贴响应正文。

可以据此声明：该 Provider 在本机、本次模型、本次网络下接受了本客户端的请求形状，并回报了 usage。

**不能**据此声明：其他模型/端点/代理/流式场景同样可行；限流与重试行为；TLS 之外的传输细节；计费正确性。

## 3. 实体 TTY 联调

必须在**真实终端窗口**中运行（不要在管道、CI 或任务捕获里跑——那样 `stdin.isTTY` 为假，本检查会如实报警）：

```powershell
npm.cmd start -- --session tty-1
```

逐项实测并记录：

| 项 | 期望 | 记录方式 |
|---|---|---|
| `/status` 显示上限 | 打印步骤/工具/字节/token/窗口/挂钟全部上限 | 粘贴该行 |
| 密钥隐藏输入 | 向导输入密钥时**终端不回显**，且不得把预输入内容当作密钥 | 文字描述 + 是否出现拒绝提示 |
| Ctrl+C 生成中 | 打印"正在取消本轮"并停止后续工具，**不**退出程序 | 文字描述 |
| Ctrl+C 空闲 | 退出程序 | 退出码 |
| `/exit` | 退出 | 退出码 |
| 中文/控制字符 | 终端不出现乱码或异常控制序列 | 截图或文字描述 |

`TerminalIO` 的行为在 `test/interactive.test.ts` 里由注入式 IO 验证，那只能证明**命令逻辑与输出文本**；回显抑制与 Ctrl+C 观感只有真实 TTY 能证明。

## 4. 为什么这两项在此前各批中仍未执行

- **外部 Provider**：本会话没有、也不应伪造任何外部服务凭据。没有凭据的"联调"只能是本机 socket（已完成），说成外部联调就是编造。
- **实体 TTY**：Node 无内置 pty，本项目也不为此引入第三方依赖；因此终端行为只能由注入式 IO 覆盖，真实观感留给操作者。

## 5. 与安全边界的关系

- 一次真实发送会把工作区文件内容与对话发往远端。用**专用可分享 workspace**，不要把整个用户目录或 DSH 目录作为工作区（见 [SAFETY](SAFETY.md)）。
- 探针与 tokenizer 命令都会启动/连接外部资源：探针只做**未鉴权** `GET`；tokenizer 是本项目目前唯一由配置引入的进程启动点，且只在你显式设置 `PERSONAL_AGENT_TOKENIZER` 时存在。
- 不要把"准备检查通过"当成"已获授权扩大权限"。权限门槛仍见 [STATUS](STATUS.md)。

## 6. 实测记录：本机回环真实端点（2026-09-25）

对 `http://127.0.0.1:8787/v1`（该端口由 `wslrelay.exe` 转发到 WSL 内进程）、模型 `glm-5.3-free` 执行了以下步骤，全部为真实网络调用：

| 步骤 | 命令要点 | 观察到的结果 |
|---|---|---|
| 准备检查 | `--preflight`，三项环境变量齐备 | exit 0；`GET .../models` 得 **HTTP 200**；端点协议警告（明文 HTTP，仅本机回环被接受）；终端警告（非 TTY） |
| 真实发送（无工具） | `--session live1 "只回复四个字符：OK"` | exit 0；`[步骤 1/10 · 工具 0/32 · prompt 152B/512.0KB · 令牌 222/131072(剩130850) · 用时 30.7s/300.0s]`；正文为 `Okay` |
| 真实工具往返 | `--session live1 "请用 read_file 工具读取 note.txt…"` | exit 0；`[步骤 2/10 · 工具 1/32 · 令牌 276/131072(剩130796)]`；回复正文为文件中的标记 `LIVE-PROBE-CONTENT-4412` |
| 落盘检查 | 读 `<home>/live1.jsonl` | `session` 1 + `message` 6 + `usage` 3；**无** `"tool/call"` 遗留审计行；**不含**所用密钥字符串 |

由此**可以**声明：该端点在本机、该模型、本次网络下接受了本客户端的请求形状（含 `tool_calls` / `tool_call_id` 往返），并回报了 `usage`；真实工具调用闭环成立。

由此**不能**声明（本次实测暴露的两个限制）：

**鉴权实测结论（2026-09-25 修正）**：操作者说明该环境变量名即真实密钥值，因此本次发送携带的是**真实管理员密钥**并被接受（HTTP 200）。但同一端点对**不带 `authorization` 头**、以及**伪值 `Bearer X`** 的请求同样返回 200（`/v1/models` 与 `/v1/chat/completions` 都如此，均为实测）。因此正确结论不是"密钥可用"，而是：**该服务在这两条路径上未校验鉴权**——任何调用方都能直接使用它。这是被调用服务自身的配置问题，本项目不能替它判断其预期，也不作为本项目的安全保证。**真实密钥值不记录在本仓库任何文件中**；本文件、[STATUS](STATUS.md) 与所有提交内容都不含该值。

给操作者的动作：若该聚合站不应该对本地无鉴权开放，请在服务侧开启校验；若该密钥曾被用于任何可外泄的位置（包括本会话的命令行与终端输出），请轮换它。
2. **推理 token 计入输出，客户端只呈现正文。** 首轮正文仅 `Okay`，`usage.outputTokens` 却为 1082；第二、三轮为 35 与 68。这说明该模型的推理过程被计费为输出 token，而本客户端当时只显示 `content`，不显示也不计推理过程。**此项已在"推理可见性"批中处理**：实测字段为 `message.reasoning_content` 与 `usage.completion_tokens_details.reasoning_tokens`，现在推理文本在答案之前以 `[思考] …` 打印，预算行追加 `· 推理 N`。复测（`glm-5.3-free`，问"中国的首都"）：正文 `北京`，预算行 `令牌 226/131072(剩130846) · 推理 47 · 用时 1.9s/300.0s`，日志中 `usage` 记为 `{"inputTokens":226,"outputTokens":47,"reasoningTokens":47}`，日志内**不含**推理文本。注意该端点此次上报 `输出 47 / 推理 47`，即按它的口径可见答案占 0 个输出 token——本项目照报不解释。

另：`/models` 在**不带** `authorization` 头时同样返回 200，所以本项目的准备检查在该端点上无法用状态码区分"有凭据/无凭据"——这与第 1 节的说明一致：探针只证明可达，不证明鉴权。

### 6.1 SSE 流式实测（同端点）

先用原始请求取证（不经过本项目），再走 `--stream`：

| 观察 | 结果 |
|---|---|
| `stream: true` | HTTP 200，`content-type: text/event-stream` |
| 分片结构 | 每个分片都带 `usage` 键，**除最后一个空 `choices` 分片外全为 `null`**；真实 usage 在该最后分片 |
| 推理 | 以 `delta.reasoning_content` 分片流式到达（59 片） |
| 可见答案 | 该端点把 `delta.content` **一次**给出（1 片），并非逐字——所以"流式=逐字显示"在本端点不成立 |
| 工具调用 | `delta.tool_calls[{index,id,type,function:{name,arguments}}]`，`finish_reason: "tool_calls"` |
| 结束 | `data: [DONE]` 存在；`stream_options.include_usage` 加上与否，该端点都返回 usage |

本项目 `--stream` 实测（`glm-5.3-free`）：普通问答 exit 0，正文 `你好啊`，预算行含 `推理 81`；**流式工具往返** exit 0（`步骤 2/10 · 工具 1/32`），模型经流式 `tool_calls` 请求 `read_file` 并返回文件内标记 `LIVE-PROBE-CONTENT-4412`。两个流式会话的日志均含 `usage`（含 `reasoningTokens`）且不含推理文本。

**仍然未验证**：TLS/代理下的流式、限流、`[DONE]` 之外的非标准结束帧、服务端中途断流（本项目会拒绝，但只用构造的分片测过）、增量显示（本项目不做）。
