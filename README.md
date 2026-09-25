# Personal Agent

独立于 DSH 的个人 Agent，现已支持**持续对话的交互式 CLI**。当前仅提供只读文件工具，不执行 shell 或修改项目文件。

## 开始使用：一个命令

在 PowerShell 中：

```powershell
Set-Location D:\DSHXM\AgentKHD\personal-agent
npm.cmd start
# 离线体验：      npm.cmd start -- --echo
# 联调准备检查：  npm.cmd start -- --preflight   （不发密钥、不消耗 token；见下文）
```

已验证 Node 24.19.0 / npm 11.17.0。已有 node_modules 可直接启动；全新安装环境先执行 `npm.cmd ci`。

首次启动按向导输入：

1. 服务地址，例如 `https://你的服务/v1`（OpenAI 兼容 chat/completions）。
2. 模型名称。
3. API 密钥，输入不回显；请等密钥提示出现后再输入，不要一次粘贴多行配置。
4. 保存选择：**直接 Enter 只保存地址/模型**；输入 `key` 才连同明文密钥保存；输入 `no` 均不保存。

密钥默认不落盘，下次会再次隐藏询问。保存到当前 Agent home 的 `provider-config.json`；不是 OS 凭据库，Windows ACL 隔离未验证，请勿提交或分享这个目录。配置文件已存在时程序不会自动覆盖，变更配置可使用完整环境变量覆盖或先在本地审查/编辑该文件。

配置后直接聊天：

```text
你 > 调用 read_file 读取 README.md，告诉我这个项目做什么。
[正在请求模型……]
[工具 read_file：执行中]
[工具 read_file：完成]
Agent > ...
你 > 再总结成三点。
```

状态是执行进度，不是逐 token 流式输出。模型须支持工具调用。

### 暂时没有 API？先体验交互

```powershell
npm.cmd start -- --echo
```

Echo 是明确的离线回显，不是真实大模型，不会主动调用工具。首次向导也可输入 `echo`；此选择不保存，下一次可重新配置。

## 版本控制与 CI

仓库**只覆盖 `personal-agent/`**——工作区根目录下的 `_research/`、`restore/` 等外部参考树不在其中，也不应被纳入。`.gitignore` 排除 `node_modules/`、`.personal-agent/`（Agent home，保存明文密钥时密钥就在这里）、`.test-artifacts/`；`.gitattributes` 固定 LF，使文档里的完整性哈希在新克隆上**逐字节一致**（已验证：克隆后重算得到相同摘要）。

CI 在 `.github/workflows/ci.yml`：Windows 运行器 + Node `22.x`/`24.x`。步骤已在干净克隆上手工实跑，并且 GitHub Actions [首跑成功](https://github.com/WR-Class/personal-agent/actions/runs/36145175526)（22.x 与 24.x 都是 `npm ci`、类型检查、测试成功）。本机另用官方 Node **22.23.3 便携包**测过一次，解压在 `.test-artifacts/toolchain/`，没有改全局 Node。测的是这些具体版本，不是 `engines` 下限 22.6 本身，也不是非 Windows。

首次提交使用的是**仓库局部**身份（`personal-agent <personal-agent@localhost>`，未改动你的全局 git 配置）。要换成你自己：

```powershell
git config user.name "你的名字"; git config user.email "你的邮箱"
git commit --amend --reset-author --no-edit   # 只改最近一个提交的作者
```

## 对话中的命令

| 命令 | 用途 |
|---|---|
| `/help` | 帮助 |
| `/new` | 切换到新会话，旧会话保留 |
| `/sessions` | 列出当前 home 中已落盘的会话 ID |
| `/resume <id>` | 恢复指定会话；不跨 home 查找 |
| `/history` | 查看当前历史（可能包含工具结果） |
| `/compact` | 显式压缩上下文：只缩短发给模型的 prompt，原始消息全部保留，`/history` 仍可见完整对话 |
| `/inspect [id]` | 检查当前或指定会话的损坏行、未完成工具组 |
| `/recover [id]` | 显式追加补齐未完成工具结果，不重跑工具；坏行仍拒绝 |
| `/status` | 当前模型、工作区、会话，以及全部上限（含按模型窗口） |
| `/exit` | 退出 |

启动交互模式默认新建唯一会话，第一次发消息才写日志；不会静默加载旧对话。恢复可用 `/sessions` + `/resume`，或启动时传 `--session <id>`。

**Ctrl+C**：生成时取消本轮、等待已开始执行结束，然后回到提示符；空闲时退出。取消不删除已保存消息，不强杀进程内工具。当前内置工具只有 read_file。

## 指定工作区或单次发送

```powershell
npm.cmd start -- --workspace D:\some\shareable-project
npm.cmd start -- --session demo "你好"
npm.cmd start -- --session demo --list
npm.cmd start -- --help
```

`--list` 不需要模型配置。单次离线发送须显式 `--echo`。以 `-` 开头的 prompt 使用 `--` 分隔。

| 参数 | 对应环境变量 | 默认 |
|---|---|---|
| --home | PERSONAL_AGENT_HOME | 当前目录/.personal-agent |
| --workspace | PERSONAL_AGENT_WORKSPACE | 当前目录 |
| --session / -s | 无 | 交互模式唯一 ID；单次 default |
| --max-steps | PERSONAL_AGENT_MAX_STEPS | 每轮最多 10 次模型调用 |
| --echo | 无 | 关闭 |
| --totals | 无 | 单次发送输出累计用量 |

也可设置 `PERSONAL_AGENT_BASE_URL`、`PERSONAL_AGENT_MODEL`、`PERSONAL_AGENT_API_KEY` 三个环境变量。**三者须同时配置**，不与磁盘配置混用；配置缺失会明确报错，不再静默回退 Echo。远端只允许 HTTPS，本机回环服务允许 HTTP。

## 安全范围与已知限制

- 保留 PR1 环境白名单、保护根、敏感路径/凭据/活动日志拒读和硬链接拒读；旧自定义 home 的 provider-config.json 也拒读。
- 额外备份目录用 `PERSONAL_AGENT_PROTECTED_ROOTS` JSON 绝对路径数组配置。
- 非只读工具默认拒绝；没有 shell、写文件、审批 UI 或不可信插件沙箱。
- 本地文件系统上同会话单 writer 租约覆盖整轮发送；其他实例或合作进程会明确拒绝，不排队、不抢锁。异常退出遗留 `.jsonl.lock` 须人工核实后处理，不自动删除。
- `/inspect [id]` 可诊断损坏行和未完成工具组；`/recover [id]` 只追加补齐完整 JSONL 末尾的未完成工具消息，不重跑工具。损坏文件保留，不静默删行。
- 事件角色、用量、header、尾行及工具配对已加强校验；这些措施仍不是数据库事务、断电持久性保证或恶意进程隔离。
- 明确标记 `length` / `content_filter` 的模型回复会拒绝，不保存回复或执行其工具调用；用户输入仍保留。缺失结束原因保持兼容。
- Provider 配置读写统一 16 KiB 上限，保存前按实际 UTF-8 字节计算，超限不创建配置目录。
- 工具参数按所声明的受支持 Schema 子集校验；不支持的关键字（如 `oneOf`）明确拒绝，不会静默放行。
- 单次模型响应体上限 1 MiB，单文件读取上限 256 KiB，均按实际收到的字节判定，不信任 `content-length`。

- 完整 JSON Schema 语义（组合关键字、格式校验等）仍待实施。
- 一次 send 有六类预算：模型调用 10 次、单步工具 8 次、整轮工具 32 次、挂钟上限 300000 ms、单次 prompt 字节上限 524288、单次 input token 上限 131072。
  可用 `--max-steps` / `--max-tools-per-step` / `--max-tools` / `--max-send-ms` / `--max-context-bytes` / `--max-context-tokens`，或对应的
  `PERSONAL_AGENT_*` 环境变量调整。deadline 会作为 signal 送达 adapter，但无法强杀忽略 signal 的进程内代码。
- 上下文预算分两条且互不替代：**字节**上限不做截断或摘要，超限抛 `ContextBudgetError` 并报出实际字节数与上限，
  拒绝发生在写入用户轮次之前（会话头可能已建，但不会留下永远无法回答的消息），每一步复查。
  **token** 上限用的是 provider 自己上报的 `usage.inputTokens`，即实测值而非估算，因此不需要内置 tokenizer；
  代价是首轮尚无测量值（只有字节上限生效），且只能在数字上报后的下一次调用前停下。参考来源与未采用项见 [REFERENCE_DECISIONS](docs/REFERENCE_DECISIONS.md)。
- 路径检查和环境白名单不是 OS 隔离；不保证抵御本地恶意并发替换。任意普通文档中的秘密不能靠文件名检测。
- 真实 API、实体终端隐藏输入/Ctrl+C 和跨平台行为尚需手动联调；自动化用模拟 IO、确定性模型与合成文件。

## 开发验证

```powershell
npm.cmd run build
npm.cmd test
```

build 是类型检查，不生成发行包。测试显式发现 TS 文件，不需要 API；所有 fixture 保留在 `.test-artifacts/`，无递归清理。

## 项目文档

**当前阶段与剩余任务的唯一入口：[STATUS](docs/STATUS.md)。当前处于M1，尚未总验收；M2–M6未开始。**

- [Ponytail 已完成代码审查](docs/PONYTAIL_REVIEW.md)（PT01/PT02/PT03/PT05已完成；PT04/PT06/PT07待实施）
- [会话可靠性实施/验收](docs/SESSION_RELIABILITY.md)
- [CLI 实施/验收](docs/CLI_STATUS.md)
- [PR1 安全基线](docs/PR1_STATUS.md)
- [实施计划](docs/IMPLEMENTATION.md)
- [当前代码地图](docs/CODE_MAP.md) / [审计修复映射](docs/AUDIT.md) / [当前安全纪律](docs/SAFETY.md)
- [参考源码与实际采用状态](docs/REFERENCE_DECISIONS.md) / [验证证据与限制](docs/VALIDATION.md)
- [ADR-0001 会话事实来源与 Run/Step/Call 身份](docs/ADR-0001-session-fact-source.md)（已决定、未实施）

主文档已统一；PR1_STATUS、CLI_STATUS、SESSION_RELIABILITY是各批历史记录，旧测试数/剩余项不可覆盖STATUS当前表。没有改动外部参考项目或DSH数据。

## 上下文与 token 上限（三层，来源各自声明）

1. **字节上限**（`--max-context-bytes`，默认 524288）：对即将发送的 prompt 按 UTF-8 字节计数，超限在**写入用户轮次之前**拒绝。
2. **本机 tokenizer 预判**（可选，`PERSONAL_AGENT_TOKENIZER='<命令>'`）：命令读 stdin 的 prompt JSON、向 stdout 打印一个非负整数，用于判断"即将发送"的 prompt。命令失败/超时/输出非数字一律报错，**不会静默退回估算**。**本项目不内置分词器。**
3. **provider 实测值**：没有本机分词器时，用 provider 自己上报的 `usage.inputTokens`。它只能晚一轮生效，且首次调用没有任何测量值——此时剩余量显示"未测量"，而不是编一个数。

`PERSONAL_AGENT_CONTEXT_WINDOWS='{"<model>":<tokens>,"*":<tokens>}'` 为指定模型**替换**全局 token 上限（精确模型名 → `*` → 全局）。它只作用于 token 上限，不派生字节上限。每次发送后会打印一行剩余量，例如：

```text
[步骤 1/10 · 工具 0/32 · prompt 141B/512.0KB · 令牌 36/131072(剩131036) · 用时 0.1s/300.0s]
```

**推理内容**：若 provider 提供推理（`reasoning_content`），会在答案**之前**以 `[思考] …` 打印，预算行追加 `· 推理 N`（N 是输出 token 中由 provider 标为推理的部分，不是额外增量）。推理文本**不写入会话日志、不回传给 provider**；`/history` 只显示答案。理由与边界见 [docs/SAFETY.md](docs/SAFETY.md)。

**持久性的准确范围**：每次写事件都调用一次 flush，flush 失败会让这次写入失败上抛。这**不等于**"数据能扛住断电"——Windows 上目录本身无法 fsync，目录项持久化不在保证内，本项目也**没有做过掉电实验**。

**流式**：`--stream`（或 `PERSONAL_AGENT_STREAM=1`）用 SSE 传输，适用于只支持流式的端点。它把分片组装回与普通响应**完全相同**的结果——回答、用量、工具调用、预算行都不变。**它不是逐字实时显示**：响应体仍整段读取并受同一 1MiB 上限约束。默认关闭。

## 准备真实联调

`--preflight` 把"能不能真的联调"变成可检查事实，并如实报告**做不到**的部分：配置完整性、**未鉴权**端点可达性（探测不带密钥、不读响应正文）、tokenizer 命令能否执行、stdin/stdout 是否真实 TTY。退出码 `0` = 可以尝试，`3` = 不可尝试，`2` = 参数/路径错误。

外部托管 Provider 与实体终端的**分步操作与必须记录的证据**见 [docs/LIVE_INTEGRATION.md](docs/LIVE_INTEGRATION.md)。仓库内已验证的最远边界是本机真实 socket（`test/provider-integration.test.ts`）；外部 Provider 与实体 TTY 尚未执行，原因也在该文档中写明。
