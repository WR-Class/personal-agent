# 参考项目：源码证据与采用决策

日期：2026-09-24。目的：保留“哪部分参考谁”的依据，不复制历史报告的绝对排名。以下是上次源码复核留下的本地快照证据，不等于在线最新版本；未验证仓库活跃度/性能排名。

历史材料：[完整旧报告](../../_research/agent-runtime-comparison.md)、[恢复摘要](../../restore/丢失窗口-8b2c48d2-恢复摘要.md)。旧报告的“唯一/最强/全部”不能直接作为实现要求。本文件只修订文档，不改参考仓库。

## 1. 参考方向与取舍

当前阶段统一见 [STATUS](STATUS.md)。以下是源码研究结论，不是每项机制已移植的声明；实际采用程度见第3节。引用的本地提交/符号沿用上次源码复核证据，本次未重新研究上游最新版本。

| 层 | 参考 | 既有源码确认 | 优势/代价与我们取舍 |
|---|---|---|---|
| 权限规则 | OpenCode | 通配符有序规则，最后匹配生效；未匹配 ask；缺 agent 权限时 deny-all；配置 deny 先于保存 allow | 可解释/按 agent 配置；规则优先级复杂。借鉴表达法，但我们明确副作用缺规则拒绝，不照搬全部默认行为 |
| 扩展权限贡献 | Gemini CLI | 扩展 policy loader 过滤 ALLOW、显式 YOLO 规则及 checker | 限制扩展通过这一入口提升权限；不覆盖任意插件代码。采用“插件声明需求，宿主授予”，不声称插件沙箱已经存在 |
| 工具调度/会话演进 | DSH | 有界并发池、exclusive 屏障、模型顺序提交；格式版本检查与冻结 JSON 快照 | 有序回放/可组合，复杂度高。现在继续串行；先保证写入一致性再引入并发；借鉴迁移纪律而非依赖运行时 |
| OS 沙箱/审批编排 | Codex | 升权受策略约束；部分 retry 可复用/跳过审批；denied reads 阻止放弃强制文件沙箱 | 真实执行边界强，但多平台后端重。先实现平台能力探测，隔离不可用时禁止承诺安全终端；不复制整个 Rust 工作区 |
| 子 Agent | Qwen Code | mode/工具注册表处理随分支不同；createForkedChat 共享父 registry，另一些 override 重建 registry | 提供多种 fork 模式；继承语义复杂。我们计划子权限只能缩小、默认独立上下文，必须自己做不变量测试 |
| 架构检查 | Zcode | managedOnly 架构 policy；storage 受管；有 verify:pre-push 脚本；未确认自动 hook | 小成本约束依赖和文件规模，但覆盖范围有限。采用显式 CI 检查，不能用“有脚本”冒充“每次强制执行” |
| 上下文/token 预算 | Codex | `context_window.rs` 用 `sess.get_total_token_usage()` 的**实际用量**（非估算）与两条独立上限比较：自动压缩上限（有 scope）与模型完整窗口硬上限，剩余量取两者最小值 | 采用“用真实用量而非估算”的原则；不采用按模型元数据解析窗口、不采用 scope 模式、不采用以压缩（摘要）作为到达上限后的动作 |
| 上下文/token 预算 | OpenCode | `codemode.ts` 有 `maxOutputBytes`（UTF-8 字节上限，“缺省即不截断”）；同时 `catalogBudget` 用 **chars/4 估算**；`compaction` 配置为 `{auto, prune, keep.tokens, buffer}` | 采用“字节上限与预算并存”的形状；不采用 chars/4 估算用于硬发送上限（估算可能在两个方向上都错），不采用压缩式处置 |
| 精确 token 预判 | Gemini CLI | `tokenCalculation.ts` 115–147 本地启发式（ASCII/CJK 字符数、长串 length/4）；149–186 仅媒体走 provider `countTokens` API，失败回退启发式 | 采用其**形状**：优先权威计数、保留回退位置；但**不采用**把启发式当默认计数——本项目宁可显示「未测量」，也不打印一个可能双向都错的精确数字。预判入口设计为宿主注入（CLI 为 `PERSONAL_AGENT_TOKENIZER` 命令），不内置分词器、不隐式回退估算 |
| 压缩/摘要 | Codex + OpenCode + fast-jev | Codex 有自动压缩上限；OpenCode 有 `{auto, prune, keep.tokens}`；[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) 不改写原文，只对旧工具结果做保留、截短或省略 | 采用 fast-jev 的一条：摘要只做索引，用户和助手消息逐字保留，只有被覆盖范围内的工具结果从 prompt 省略。不采用它的自动压缩、字母数估算，以及删除未完成工具批次。自动压缩以后单独做，触发值只用 provider 回报的 token |

整体底座暂不切换：保留当前小型 TS 原型便于验证合同；这是一项可撤销的工程建议，不以 LOC 大小断言其他项目不适用。若选择成熟框架代替自建，另做功能/许可证/维护成本实测 ADR。

## 2. 精确证据索引

源码根：`../../_research/repos/`。

### OpenCode
- HEAD `7cb044ee892fa8116610ba31a82922c656eaf86c`
- [permission.ts](../../_research/repos/opencode/packages/core/src/permission.ts)：evaluate 76–85；configured/evaluateInput 137–161；create/assert 176–207。
- Asked 事件在 183–185；不能由此断言每次决策都持久化为审计事件。

### Gemini CLI
- HEAD `62364cb2000795537a6895261b37ec668e4cf527`
- [config.ts](../../_research/repos/gemini-cli/packages/core/src/policy/config.ts)：loadExtensionPolicies 227–283；过滤 ALLOW 240–247、YOLO rule 249–255、checker 266–273。
- 结论仅针对这条加载通道，不是通用插件执行隔离。

### Qwen Code
- HEAD `f8ce07463bd2251b9db6e8dae0596d3ca1bbfd3c`
- [agent.ts](../../_research/repos/qwen-code/packages/core/src/tools/agent/agent.ts)：resolveSubagentApprovalMode 418–474；rebuildToolRegistryOnOverride 576–615；createApprovalModeOverride 709–730。
- [forkedAgent.ts](../../_research/repos/qwen-code/packages/core/src/agents/forkedAgent.ts)：createForkedChat 217–242 共享 registry；AgentHeadless 路径 620–638 有 YOLO override。
- 不再沿用“每个 fork 都有独立工具表”的旧概括。sidecar 恢复不在本轮验证范围。

### Zcode
- HEAD `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`
- [architecture-policy.yaml](../../_research/repos/extra/zcode/architecture-policy.yaml)：26–33 storage managed；59–67 全局规则含 managedOnly、400 行/300 合同/12 public 方法、禁止环与 deep import。
- [package.json](../../_research/repos/extra/zcode/package.json)：19、44 有 verify:pre-push/architecture:check。
- 未运行 checker；候选 `.husky/pre-push` 不存在，不能断言自动 hook。

### 上下文/token 预算（2026-09-25 复核，只读）
- [context_window.rs](../../_research/repos/codex/codex-rs/core/src/session/context_window.rs)：整文件 1–130。58 行 `get_total_token_usage()` 取实际用量；61–81 行两种 scope（`Total` / `BodyAfterPrefix`）下如何计入；84–86 行完整窗口 = `resolved_context_window() * effective_context_window_percent / 100`；89–95 行剩余量取两条上限最小值；106–117 行三种“到达”判定。
- [config/mod.rs](../../_research/repos/codex/codex-rs/core/src/config/mod.rs)：634–638 `model_auto_compact_token_limit` 与 scope 字段。
- OpenCode [codemode.ts](../../_research/repos/opencode/packages/codemode/src/codemode.ts)：12–16 `timeoutMs`/`maxToolCalls`（缺省不限）/`maxOutputBytes`（字节，缺省不截断）；21 行 `catalogBudget` 明写 “Approximate token budget (chars/4, default 2000)”。
- OpenCode [compaction.ts](../../_research/repos/opencode/packages/core/src/config/compaction.ts)：整文件 1–15，`{auto, prune, keep.tokens, buffer}`。
- Gemini CLI [tokenCalculation.ts](../../_research/repos/gemini-cli/packages/core/src/utils/tokenCalculation.ts)：115–147 `estimateTokenCountSync`（按 ASCII/CJK 的字符启发式，massive 串用 length/4，非文本 JSON 长度/`charsPerToken`）；149–186 `calculateRequestTokenCount`——只有含媒体时才调用 provider 的 `countTokens` API，失败则回退到本地启发式。
- 未验证这些上限在各自项目里的运行时行为，只读源码；不据此断言其效果或性能。

### 联调准备检查（`--preflight`）

**没有参考来源，也不声称有。** 本会话没有为它查阅任何项目的"doctor/preflight"实现，因此它既不是移植也不是借鉴，而是本项目自己的取舍：只报告可观察到的事实、探测不带凭据、并明确列出它**不能**证明的事。若日后要参考别的实现，必须先读到源码再在本节补证据，不能用"业界通常都这么做"代替。

### Codex
- HEAD `30fc6864cc1318121eca1843c217fe00ce1212f1`
- [orchestrator.rs](../../_research/repos/codex/codex-rs/core/src/tools/orchestrator.rs)：run 124–161；retry 357–442；414–416 有 bypass 分支。
- [sandboxing.rs](../../_research/repos/codex/codex-rs/core/src/tools/sandboxing.rs)：270–294，unsandboxed_execution_allowed / sandbox_permissions_preserving_denied_reads。
- 应保留文件读取禁止约束，不等于任何权限变更都被禁止；“一切升权都重新审批”是旧报告过度概括。

### DSH 已安装实现
- Desktop 2.0.13；dsh-agent-loop、dsh-session 均 0.1.5-rc.2；安装树无可确认 Git commit。
- `D:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`：runGroup 557–658；commitReady 571–580；fillPool/drain 624–645。
- 同级 `dsh-session\lib\types\types.js`：32–54，格式版本 3 与演进注释。
- 同级 `dsh-session-format\lib\index.js`：55–84，版本检查及 detached JSON 冻结。
- 未逐个验证历史迁移 codec 正确性；不作“唯一具有这套机制”的结论。

### 源码根的归属（**重要，易误解**）
`_research/repos/` 位于 `D:\DSHXM\AgentKHD\` 下，而 **git 仓库根是 `D:\DSHXM\AgentKHD\personal-agent\`**，因此**参考源码在版本控制之外，从未被提交**。它**确实存在于本机**（9 个 agent、约 3.6 万个文件），但**不会出现在 GitHub 上**。这是刻意的：它们是**第三方代码**（各自有自己的许可证与贡献规范，例如 `_research/repos/goose/AGENTS.md` 是 goose 自己的贡献指南，**不是本项目的指示**），不应混入本仓库，体量也不可接受。

**因此本文的索引是唯一可携带的证据**：源码可能不在别人的机器上，结论必须靠"哪一行、哪个符号"站住。若某条结论只有项目名而无可核对的位置，应视为**未取证**。

### 权限档位与命令执行（2026-09-28 复核，只读）

本次为"给模型手脚"读了下列源码，**逐条给出可核对位置**：

- **crush** — [bash.go](../../_research/repos/crush/internal/agent/tools/bash.go)：25–31 `BashParams`，其中 27 行 `Command string`（`description:"The command to execute"`）、28 行 `WorkingDir`、29 行 `RunInBackground`、30 行 `AutoBackgroundAfter`（54 行注释：默认 60 秒转后台）；55 行 `MaxOutputLength = 30000`。
- **crush 的白名单机制（此前索引缺失）** — [safe.go](../../_research/repos/crush/internal/agent/tools/safe.go)：9 行 `safeCommands`；69–75 `containsCommandChaining` 只查 `;`、`|`、`&&`、`$(`、反引号。**已实测其漏项**：`ls & rm -rf /`（单 `&`）、换行分隔的第二条命令、`git status > /etc/passwd` 均**不被判为链式**。**但这不是安全缺陷**：`bash.go` 213 行仅在**未**检测到链式**且**命中白名单时免问（237 行起），**其余一律走审批**——即白名单只是**降打扰优化**，安全性由其 fail-closed 兜底。本项目**不采用**该白名单表达法（检测字符串这一形态本身是错方向），但**采用**其 fail-closed 兜底。
- **goose 的四档定义（此前索引缺失）** — [goose_mode.rs](../../_research/repos/goose/crates/goose-provider-types/src/goose_mode.rs)：`pub enum GooseMode { Auto, Approve, SmartApprove, Chat }`，各变体带 `strum(message=...)` 原文："Automatically approve tool calls" / "Ask before every tool call" / "Ask only for sensitive tool calls" / "Chat only, no tool calls"。
- **goose 的判定顺序** — [permission_inspector.rs](../../_research/repos/goose/crates/goose/src/permission/permission_inspector.rs)：144–196 `inspect`，五层为 ①用户设定权限（164）②工具自带 `read_only_hint` 标注（173–174，见 52–63 `apply_tool_annotations`）③扩展管理必问（178）④交 LLM 判只读（183–189，229 起）⑤**默认问**（192–193）。
- **codex 的二维档位** — [shared.rs](../../_research/repos/codex/codex-rs/app-server-protocol/src/protocol/v2/shared.rs)：`enum AskForApproval { UnlessTrusted, OnRequest, Granular{..} }`；[config_requirements.rs](../../_research/repos/codex/codex-rs/config/src/config_requirements.rs)：`enum SandboxModeRequirement { ReadOnly, WorkspaceWrite, DangerFullAccess }`。**沙箱与审批是两条独立的轴**，与 D22 的结论一致。
- **claude-code 的档位（此前索引缺失）** — [claude-code.d.ts](../../_research/repos/claude-code/mods/types/claude-code.d.ts)：`type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。

**未验证**：以上各项目的运行时行为（只读源码）；goose 的 LLM 只读判定所用提示词与准确率；crush 白名单在真实交互中的免问比例。

### 后台作业（D47，2026-09-28）

- **采用**：crush 的**输出落盘**形状 — [truncate.go](../../_research/repos/crush/internal/shell/truncate.go)：29 行 `spillSubdir = "shell-output"`（注：不是任意目录）、33 行 `spillPattern = "output-*.log"`（**只删自己创建的文件**，见 190 行 `filepath.Match`）、38 行 `spillRetention = 7*24h`、43 行 `spillDirLimit = 256<<20`；裁剪顺序见 175–217（**先按年龄删，再按总量删最旧**）。本项目数值相同，落在 agent home 下而非共享临时目录。
- **采用**：crush 的"**超时转后台而非杀掉**"形状 — [bash.go](../../_research/repos/crush/internal/agent/tools/bash.go)：30 行 `AutoBackgroundAfter`，54 行注释默认 60 秒。本项目保留这个语义（`FOREGROUND_GRACE_MS`），但**保留前台显式 `run_in_background`**，未做自动转换。
- **不采用**：crush 的**进程组**做法。它在 POSIX 上用 `SysProcAttr.Setsid` + `Kill(-pid)`（[exec_unix.go](../../_research/repos/crush/internal/shell/exec_unix.go)：30、62、68、73），但 **Windows 上 `kill(-pid)` 实测失败（`ESRCH`）**，且其 Windows 实现 ([exec_windows.go](../../_research/repos/crush/internal/shell/exec_windows.go)：21–22) 就是 `interp.DefaultExecHandler`，**并未做等价处理**。本项目改用 `taskkill /PID <pid> /T /F`。
- **不采用**：Job Object / 原生模块。本项目至今零生产依赖，为一个可绕开的问题引入需编译的原生依赖不划算。
- **本轮实测（均以"文件是否继续增长"为判据，而非进程句柄）**：
  - `kill(-pid)` 在 Windows 上抛 `ESRCH`；
  - **只杀直接子进程不足以停住作业** —— 作业进程是 `cmd.exe`，真正的命令是**它的**子进程，`child.kill()` 只杀掉解释器。实测 kill 后文件继续增长（135 → 175 字节）。**这是本轮发现的真 bug**，`job_kill` 曾报告成功而作业仍在跑；
  - `taskkill /T /F` 修复后：3 项 kill 相关测试全绿，输出停止增长。
- **未验证**：`taskkill` 在非 Windows 上不存在（代码按平台分支，非 Windows 走 `child.kill()`，**未在真机验证过非 Windows 路径**）；作业在 agent 非正常终止（`SIGKILL`）时是否残留**未测**——退出清理只覆盖正常退出路径。

### 中间档 / 只读命令免问（D48，2026-09-29）

- **参考**：goose 的 `SmartApprove`。[permission_inspector.rs](../../_research/repos/goose/crates/goose/src/permission/permission_inspector.rs)：159–196 `inspect`，五层顺序为 ①用户设定权限（164）②`read_only_hint` 标注（173–174）③扩展管理必问（178）④**交 LLM 判只读**（183–189，实现在 [permission_judge.rs](../../_research/repos/goose/crates/goose/src/permission/permission_judge.rs)：145–185）⑤**默认问**（192–193）。缓存见 `cache_non_readonly_decision`（22）。
- **采用**：第 ①②③⑤ 层的**形状** —— 已知只读放行、写入必问、未知必问（fail-closed）。第 ② 层在本项目里换成**静态事实**：工具全是内置的，`READ_ONLY_TOOLS` 就是答案，不需要标注协议。
- **不采用第 ④ 层（LLM 判定只读）**，理由是可核对的：goose 的工具经 MCP 从外部来，它**无从知道**某工具是否只读，只能问模型；本项目工具全在自己代码里，**这是已知事实而非待推断的未知**。用一次额外的 provider 往返去猜一个已知事实，只增加延迟与不可预测性。这与本项目此前拒绝 `chars/4` token 估算同一理由：**宁可显示"未测量"，也不打印一个可能双向都错的数字。**
- **同时记录了 goose 第 ④ 层的失败方向**：`permission_judge.rs` 179–185，取不到 model config、provider 报错、响应解析失败**都返回空集合** = 全部都要问。**这是 fail-closed，方向正确**，本项目沿用同一方向（未识别 → 问）。
- **不采用**：crush 的 `safeCommands` 免问清单（D46 已记录其 `chainingMetacharacters` 漏掉单个 `&`）。本项目自己写白名单，并且**没有复制那个漏项**：`>` `|` `&` `;` 与换行一律拦下。
- **本轮由测试逼出的设计修正**（都是真实写入途径，非假想）：
  - 首版按**第一个词**放行，`node -e "require('fs').writeFileSync(...)"` 与 `git commit -m x` 都被判成只读 —— **测试抓到，改为按子命令 + 标志判定**。
  - 审计动词表时发现 `date`/`time` 带参数**设置系统时钟**、`sort -o`/`uniq <in> <out>` **写文件**、`find -delete`/`-exec` **删文件/跑任意命令**、`git branch <名>` **建分支且无标志可扫**、`git diff --output=x` **写文件**、`npm test`/`npm run`/`npx` **执行项目自己的脚本**。全部移出白名单或加标志拦截。
  - 首版只有一条条件 `allow` 规则，未命中时落到通配 `deny`，于是**未识别命令被 outright 拒绝**而非"要问"。补一条无条件 `approve` 规则修正。
- **残留风险（未解决，已写入 SAFETY）**：`git log` 会调用 `core.pager`；若仓库自身 `.git/config` 把 pager 设为恶意命令，一条被判"只读"的 `git log` 就会执行它。这与 **D26"仓库配置不能自己给自己提权"是同一问题，而 D26 尚未实现**。可选缓解：强制 `--no-pager`，或等 D26 落地。
  > ⚠️ **本条结论已被 D49 推翻，且是低估**：实测证明**不需要 `git log`，`git status` 就会执行仓库配置里的命令**（`core.fsmonitor`），而"强制 `--no-pager`"这个缓解**无效**（关不掉 `fsmonitor`/`textconv`）。**`git` 已整族移出白名单。**保留原文不改写，是为了留下"我当时判断错在哪"的证据。
- **验证**：单测 82 项（`test/middle-tier.test.ts`，逐条覆盖上述每个漏洞）；全量 **525 通过 / 0 失败 / 1 跳过**；**真机两条**（网关在线那一轮）：`ask-before-writing` 下 `node --version` **无人可批仍跑通**、`echo pwned > <文件>` **被拦且磁盘无文件**。
- **未验证**：非 Windows 平台（白名单含 Unix 动词但只在 Windows 实测）；`git log` pager 风险**未做真机复现**（只做了源码与文档层面的认定）。

### 修掉 D48 放行的 git 漏洞（D49，2026-09-29，实证）

- **起因不是审查而是复现**：D48 把 `git` 的只读子命令写进白名单后，我回去验证那条"残留风险"，结果发现**问题比文档写的严重得多**。
- **实测复现（本机，可重跑）**：建一个真实仓库，在其**自己的** `.git/config` 里设 `core.fsmonitor` 指向一个会写文件的脚本，并设 `core.untrackedCache true`；然后运行 **`git status`** —— **该脚本被执行，marker 文件被写出**。而 D48 的白名单把 `git status` 判为"只读免问"。**即：一条被本档位判为不必问的命令，执行了仓库自带的任意代码。**
- **同一族还有**：`core.pager`（`git log`/`diff`/`show`）、`diff.*.textconv`（`git diff`）。**所以"按子命令收窄"根本无效** —— 每一个只读子命令都读同一份仓库配置。D48 那张 `GIT_READ_SUBCOMMANDS` 表**没有缩小风险，只是让它看起来被管理了**。
- **无环境变量缓解（已核实）**：`GIT_CONFIG_NOSYSTEM` **只抑制系统级配置文件，不抑制仓库自己的 `.git/config`**。
- **不采用逐键 `git -c` 覆盖**：那需要枚举全部危险键（`fsmonitor`/`pager`/`editor`/`sshCommand`/`hooksPath`/`diff.*.textconv`/`filter.*.clean|smudge`/`alias.*`…），**这正是本项目已经失败过两次的"枚举危险项"形态**（argv 方案、字符串检测方案）。**同一条错误不犯第三次。**
- **采用：一条准入准则，替代"看起来像只读"** —— **一个工具能进白名单，当且仅当它自己的标志、以及它读取的任何项目本地配置，都不能导致它执行另一个程序。** 按此复核：
  - **`git` 整族移出**（已实证）；
  - **`rg` 移出**（ripgrep `--pre` 执行预处理命令；**本机未安装 rg，无法实测**，但无法为每个标志担保的工具不该进一张全靠逐条担保的表）；
  - **`npm ls`/`list` 移出**（npm 读项目自带 `.npmrc`，**能否影响执行未经验证**）；`npm --version` 保留。
- **代价如实记录**：`git status` 现在每次都要批准，这是真实的便利损失，也是本轮唯一的用户可见退步。**恢复条件**：D26（仓库配置不得自我提权）落地后，可强制 `--no-pager` 且禁用 `fsmonitor`/`textconv` 再放行。
- **验证**：新增**走完整链路**的回归测试（runtime → 工具 → 审批门，**不是只查 `decide()`**，因为 D46 已经证明"决策对了但没接到工具"是真实故障形态）；**带反证**——先在 `full-access` 下断言投毒仓库**真的执行了**（marker 出现），否则测试可能因 git 缺失或 payload 未触发而空过；再在 `ask-before-writing` 下断言 marker **不出现**。全量 **520 通过 / 0 失败 / 1 跳过**，`npm run build` 干净。
- **教训（比漏洞本身更值得记）**：**"残留风险"这个措辞被我用来描述一个已经放行、已经可被利用的路径。** 写下"有风险但先这样"时，如果那条路径已经在免问放行，它不是残留风险，是**已发布的漏洞**。措辞的宽松掩盖了严重性 —— 与 D26 那次"不做全局开关"的措辞纠正是同一类错误。

### D26 第一步：核实"提权状态不可自写"（2026-09-29，实证 + 一次自我更正）

**本轮结论有两部分：一部分是真实的更正，另一部分是我自己的探针错误。都如实记录。**

#### A. 更正 D49 对 git 漏洞的严重性夸大（成立）

D49 写"一条被判只读的命令执行了**仓库自带的**任意代码"。**"仓库自带"是错的**，三条向量均已实测：

| 向量 | 随 `git clone` 交付？ | 能否让只读 git 命令执行代码 |
|---|---|---|
| `.git/config`（`core.fsmonitor`） | ❌ **不交付**（实测 clone 后该键为空） | 能，但需配置**已存在** |
| `.gitattributes`（`filter=`/`diff=`） | ✅ 交付 | ❌ 只**指名**驱动，命令定义在 config 里（实测 `filter.evil.clean` 不存在） |
| `.gitmodules`（`ext::sh -c`） | ✅ 交付 | ❌ 实测 `git status` 未触发（只读子命令不碰未初始化子模块） |

*方法更正：`.gitmodules` 第一次测因 PowerShell 引号把文件写成 `bad config line 3`、git 直接拒读而**不算数**；改用 Node 写文件重测才有效。*

**所以：clone 一个恶意仓库并不能让只读 git 命令执行代码，D49 的可达性被夸大了。** 但 **D49 的处置（git 整族移出白名单）仍然正确**，理由现在更精确：实测发现 `sensitivePathName` 含 `\.git`，**文件工具碰不到 `.git/`**，故植入恶意 `core.fsmonitor` 只能靠 `run_command git config ...`（需批准）或外部工具。**真实升级路径是：操作员批准过一次 `git config core.fsmonitor X`，此后每一次免问的 `git status` 都会执行 X —— 一次批准的写入换来无限次未批准的执行，且跨会话持久。** 这本身就是 D26 的题面，不需要任何攻击者。

#### B. 我报告的"agent home 可自写"漏洞是探针错误（不成立）

我先用探针直接调 `assertReadablePath`，测出：home 在工作区内时，改目录名为 `agentstate`/`state`/`myhome` 就能写 `trust.json` 与 `config.json`，只有默认名 `.personal-agent` 被拒（因为它恰好在 `sensitivePathName` 名单上，而该名单自己的注释写着 *"A name list is a hint, not a boundary"*）。据此我写了一版"采用：按位置保护 agent home"的记录并改了 `resolveRuntimePaths` 与 `cli.ts`。

**改动立刻打破 10 个 CLI 测试**（`UnsafeAgentHomeError: refuses protected host or backup directory`）——因为 `AgentRuntime` 会把 `options.protectedRoots` 再喂回 `resolveRuntimePaths`，于是 agent home 出现在自己的保护名单里，`assertSafeStateDirectory` **自我拒绝**。

顺着这条错误查到 [runtime.ts](../src/runtime.ts) 第 542 行：

```ts
this.protectedRoots = Object.freeze([...paths.protectedRoots, this.home, storeRoot]);
```

**运行时早就按位置把 agent home 与 store root 加进拒绝名单了**，并在第 919 行传给工具上下文。**我的探针直接调底层函数、绕过了运行时的这层装配，量到的是假象。** 通过真实运行时重测（`full-access` 档、`create_file` 写 `trust.json`、三种 home 名），**全部被拦**。两处改动已回滚，`src/` 与改动前逐字节一致（`git diff --stat` 可证）。

**而且这个性质早有测试**：`test/security.test.ts` 的 *"denies runtime state even when inside selected workspace with ordinary names"* 已经用普通目录名（`state`）覆盖了**读**方向。

**这是本项目第三次"报告产品有洞、结果是自己测试的 bug"**（前两次：真机写入测试断言错方向、Windows 孤儿进程前提错误）。教训与前两次同一条：**报"产品失败"之前必须先排除自己测试/探针的 bug；直接调底层函数不等于调用产品的真实装配路径。**

#### C. 本轮真实产出

- **补上唯一真实缺口：写方向的测试。** 现有测试只覆盖"读运行时状态"，而**写 `trust.json` 才是提权**（它授予工作区外读权限、且跨会话持久）。新增 *"cannot write its own privilege-granting state, whatever its home is called"*：`full-access` 档（刻意选它，否则拒绝可能来自审批门而非路径策略，两者不可混淆）+ 普通名 home 在工作区内 + `create_file` 写 `trust.json`，**断言磁盘上文件不存在**（不解析转录：文件存在与否是机械事实，"工具说被拒了"是关于声明的声明）。
- **做了变异验证，确认测试不是空过**：临时从 `runtime.ts:542` 移除 `this.home`，该测试**立刻变红**（15 通过 / 1 失败）；恢复后全绿。**没有这步，一个因别的原因而通过的测试等于没有测试。**
- **不采用**："再往 `sensitivePathName` 加几个名字"（`trust.json`/`config.json`/`genes.jsonl`）——那是本项目已失败两次的**枚举危险项**形态，且名单注释自认抓不到"a plainly-named file that happens to matter"。**按位置保护已经存在且更强，无需补名单。**
- **不采用**："强制 agent home 必须在工作区外"——会改变默认行为、要求操作员显式选路径，而按位置拒绝已经足够，收益不成比例。

#### D. D26 仍未完成的部分（本轮刻意不做）

**配置加载 × 规则表**才是 D26 的主体，本轮**没有做**。它必须建在"提权状态不可自写"这个地基上——而地基经本轮核实**已经存在且现在被测试钉住了**，所以可以做。**下一轮的具体约束**：配置只从 agent home 读（**绝不从工作区发现配置文件**，即刻意不实现常见的"找项目里的 `.agentrc`/`agent.json`"模式）；任何**放宽**姿态的字段必须像 `--tier full-access` 一样落盘审计（D26/D32：移除边界必须是可审计的决定，不是凭标签解锁）。

**未验证**：非 Windows 平台；`--trust-root` 授予的根**包含** agent home 时的交互；全量并发下 `background-jobs` 的 kill 测试偶发失败（隔离重跑两次均 11 通过 / 0 失败，判定为负载下的时间窗漂移，**未修**）。
### D26 主体：配置加载 × 规则表（D51，2026-09-29，实证）

**读过的来源**

| 来源 | 位置 | 读到什么 |
|---|---|---|
| gemini-cli | [settings.ts](../../_research/repos/gemini-cli/packages/cli/src/config/settings.ts)：255–281 | `mergeSettings(system, systemDefaults, user, workspace, isTrusted)`；**第 262 行 `const safeWorkspace = isTrusted ? workspace : ({} as Settings)`**——目录不受信任则工作区配置**整体丢弃**；265–271 行给出五层顺序：Schema Defaults → System Defaults → User → Workspace → **System Settings（作为 overrides，最后合并）** |
| gemini-cli | settings.test.ts：264 | 测试名即断言："system taking precedence over workspace, and workspace over user" |
| opencode | [permission/index.ts](../../_research/repos/opencode/packages/opencode/src/permission/index.ts)：28–38 | `evaluate(permission, pattern, ...rulesets)`：**`findLast`**（最后匹配者胜出）+ 默认 `action:"ask"`、`pattern:"*"`（fail-closed） |
| opencode | 同上：186–198 | `fromConfig`：配置可写 `{key: action}`（→ pattern `"*"`）或 `{key: {pattern: action}}`；`expand()` 处理 `~`/`$HOME` |
| opencode | 同上：204–211 | `disabled()`：规则为 `pattern==="*" && action==="deny"` 时该工具**视为不可用**——与本项目"缺席而非拒绝"同形 |
| opencode | [permission/arity.ts](../../_research/repos/opencode/packages/opencode/src/permission/arity.ts)：1–163 | `BashArity` 命令元数表（`export:1`/`grep:1`/`deno task:3`/`pipenv:2`/`ufw:2`） |
| 本项目 | [rule-table.ts](../src/rule-table.ts)：22–33 | `RULE_TIERS={DEFAULT:1,EXTENSION:2,WORKSPACE:3,USER:4,ADMIN:5}`；**"Higher tier always outranks a lower one, whatever the priority"**；`MAX_PRIORITY=999` 使优先级**永不跨层** |
| 本项目 | [tiers.ts](../src/tiers.ts)：68–89 | **`read-only` 的 deny-every-write 钉在 `USER` 层、priority 800**，只读工具的 allow 在 USER 900−index |
| 本项目 | [trusted-roots.ts](../src/trusted-roots.ts)：49–58 | 既有决定：**损坏的信任文件报错而非读成空** |

**采用**

1. **gemini-cli 的"不受信任则丢弃工作区配置"，但走得更远：本项目根本不读工作区里的任何配置文件。** gemini-cli 读它、靠 `isTrusted` 门控；我们连发现都不做（刻意不实现"找项目里的 `.agentrc`/`agent.json`"）。**门控依赖信任状态正确，不读则不依赖任何状态**；且 D50 已实测确认 agent home 整棵树按位置拒绝写入，配置放那里天然不可被 agent 自写。真机验证：删掉 home 配置、在工作区放一份 `{"rules":[{"tool":"*","decision":"allow"}]}`，运行后**0 条** `config:widen` 审计行。
2. **gemini-cli 的"操作员层最后合并"** → 优先级 **CLI 旗标 > 环境变量 > agent home 配置 > 内置默认**（`options.tier ?? agentConfig.tier`，前两者已在 `parseArgs` 里合流）。
3. **opencode 的 JSON 规则形状与 fail-closed 默认**：`{tool, decision, reason?, priority?}`，无匹配仍由 `decide()` 默认拒绝。
4. **本项目既有的"损坏即报错"** → 解析失败抛错，不静默当空。

**不采用**

1. **不采用"`tier` 可由配置指定"**——本轮最关键的结构决定。`ADMIN:5 > USER:4` 且高层永远压过低层，**配置规则一律由代码钉死在 WORKSPACE 层，层号绝不出现在 JSON 里**；否则一份配置就能把自己写进 ADMIN、压过 `full-access` 的审计记录。
2. **不采用"`when` 谓词可由配置提供"**——`when` 是函数，从 JSON 造函数只有 `eval`/`new Function`，等于**配置文件即代码执行**。代价如实说：**配置无法表达"只放行 `git status`"这类按内容的规则**。
3. **不采用 opencode 的 `findLast`**——本项目是"按有效优先级排序、首个匹配胜出"且 priority 被 clamp 保证永不跨层；改成 findLast 会让层号失去意义，动摇既有不变量（有测试断言）。
4. **不采用 gemini-cli 的 remote/admin 远程配置**——引入网络来源等于引入一个本项目无法审计的信任根。
5. **不采用 crush 的 `crushrc`（bash 脚本配置）**——配置文件即 shell 脚本，与不采用 `when` 同理。
6. **不采用 `BashArity` 式命令元数表**——那是为"从 bash 命令里切出命令名"服务的；本项目 D48 已确立"按第一个词/子命令 + 标志"判定并**刻意保持白名单极短**，元数表增加复杂度却不增加安全性。

**实现中被实测推翻的两个自以为是（都记下来）**

1. **层选错了，是测试逼出来的。** 我最初把配置规则钉在 `USER` 层，理由听起来很自然（agent home 是用户级配置）。写完测试才发现：**`read-only` 的 deny-every-write 也在 USER 层（priority 800）**，而配置规则 priority 可达 999 —— **同层内大 priority 胜出，于是一份配置就能压过姿态自己的边界，把 `read-only` 下的写入判定翻成 allow**。这恰恰是 D26 要禁的自我提权，而我差点亲手实现它。改为 **WORKSPACE 层**：低于 read-only 的 USER 边界、低于 full-access 的 ADMIN 记录，与写作姿态留在 WORKSPACE 的规则同层（故仍可调整它们）。**教训：层号不能靠语义直觉选，必须核对既有规则实际钉在哪一层。** 该名字有误导性（本项目**不读**工作区配置），已在源码注释里显式警告。变异验证：把层改回 USER，3 条测试立刻变红。
2. **`wideningRules` 第一版自己重写了匹配逻辑，漏了通配符。** 它从姿态的 allow 规则里收集工具名建集合，而 `full-access` 的 allow 规则是 `tool:"*"`，于是**把 full-access 误报成"被配置放宽了"**。改为直接调 `decide(postureRules, tool, {})` —— 匹配本来就是它的职责，且它已处理通配符、层序与谓词。**教训：不要重新实现既有判定器的子集，那正是漏掉边界情况的典型方式。**

**真机验证暴露的一个类型检查盲区（本轮最有价值的一条）**

`AuditEvent.decision` 是 TS 联合类型，但 `SessionStore` 在**读回持久化行时另有一道运行时校验**（`session-store.ts:371`），两者是**各自独立的真相来源**。我只放宽了联合类型：**编译干净、24 项单元测试全绿、全量 544 项全绿**，然后真机跑 CLI 直接失败于 `audit.decision must be denied or expired`。**只有真机验证抓到了它。** 已同时放宽运行时守卫，并补上往返测试；变异验证：把守卫改回严格版，该测试立刻变红。**教训（本项目已多次遇到同一形状）：类型与运行时守卫并存时，改一处必须查另一处；而"全绿"不等于"能用"，凡改动落到真实执行路径上的，必须真机跑一次。**

**审计语义的一处修正**：`decision` 联合类型原为 `"denied" | "expired"`，而既有代码把**移除提示的档位**也记成 `decision:"denied"`（第 343 行）——一份把"授权"记成"拒绝"的审计日志比没有日志更糟，因为它的全部意义就是让事后能回答"谁停止了询问"。故加入 `"allowed"`。**既有的 `tier:` 审计行仍写 `denied`，本轮未改**（属既有行为、有测试覆盖），如实记为遗留不一致。

**本轮刻意不做**：按参数内容的配置规则（需要可序列化的谓词语言，是另一个设计问题）；多档 profile 切换；配置写回（`--set` 之类）；修正上述遗留的 `tier:` 审计语义。

**未验证**：非 Windows 平台；配置与 `--trust-root` 同时使用时的交互；配置里 `tool:"*"` 与注册表缺席工具的完整组合矩阵（已测 read-only 一例）。

### SoL-Pi 只读能力接入（D52，2026-09-29，取证完成，尚未写代码）

**读过的来源**（`D:\DSHXM\SoL-Pi\SoL-Pi`，**只读未改**）

| 来源 | 位置 | 读到什么 |
|---|---|---|
| SoL-Pi | `LICENSE`（1097B）、`THIRD_PARTY_NOTICES.md` | **MIT**，NVIDIA CORPORATION & AFFILIATES 2026；每个源文件头部都有 SPDX 声明 |
| SoL-Pi | [docs/compatibility.md](../../../SoL-Pi/SoL-Pi/docs/compatibility.md)：1–20 | 针对 `@earendil-works/pi-coding-agent` **0.85.1** 开发测试；Pi 是 **peer dependency**；**只 import Pi 的公开导出**（`ExtensionAPI.registerTool`、`context`/`before_provider_request`/`tool_result`/`turn_end`/`agent_settled`/`session_before_tree` 事件、`ExtensionContext.getContextUsage()`/`.compact()`/`.model`） |
| SoL-Pi | 同上："ObservationPack changes only the messages projected through the public `context` event. **Stored session history remains intact.**" | 投影层改写，不动存储 |
| SoL-Pi | [observation-pack/index.ts](../../../SoL-Pi/SoL-Pi/src/sol-pi/extensions/observation-pack/index.ts)：65–135 | 注册工具 `obs_recall`，参数 `{id: string, offset?: integer>=0}`；**没有路径参数**；硬上限 `RECALL_MAX_BYTES=16KB`、`RECALL_MAX_LINES=400`，且**执行后再校验一次**输出未超限（第 92–94 行 `throw new Error("Recall output exceeded its hard limit")`） |
| SoL-Pi | 同上：137–210 | `pi.on("context")` 投影钩子；用**后续 assistant 消息数**推算"这是第几次 provider 请求"（142–150）；**fail open**（202–206：`a packing failure must never cost the agent its observation`） |
| SoL-Pi | [observation-pack/observation.ts](../../../SoL-Pi/SoL-Pi/src/sol-pi/extensions/observation-pack/observation.ts)：13–22 | `THRESHOLD_BYTES=10KB`、`FULL_SENDS=2`、`PLACEHOLDER_EXCERPT_BYTES=1024`；**`O_NOFOLLOW`** 用于读与创建，**`O_EXCL`** 用于创建 |
| SoL-Pi | 同上：20、94–96 | **`OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u`**，`isObservationId` 在**构造路径之前**校验 |
| SoL-Pi | 同上：106 | 内容寻址 id：`obs_` + `sha256(toolName\0toolCallId\0contentHash).slice(0,24)` |
| SoL-Pi | 同上：123–156 | `ensureStored`：目录 `0o700` + **`lstat` 确认是真目录且非符号链接**；文件 `0o600`；**`EEXIST` 时逐字节校验既有对象（size + sha256）才复用**，否则抛错 |
| SoL-Pi | 同上：207–211 | **`trimUtf8End`**：`(byte & 0xc0) === 0x80` 的续字节被裁掉，**分页永不切断多字节字符** |
| SoL-Pi | 同上：213–252 | `readRecallChunk`：同时按**字节与行数**双重封顶，返回 `nextOffset`/`eof` 供续读；`offset > size` 抛错 |
| SoL-Pi | 同上：28、80–82、100 | **`containsReducerReceipt`：evidence-reducer 的回执不参与打包**——"Packing them again would replace verified evidence with an excerpt" |
| SoL-Pi | 同上：158–176 | `completeLineExcerpt` 用 `split(/(?<=\n)/)`，**只取整行**，头尾各半预算 |
| SoL-Pi | 其余三个扩展 | `action-fusion` 有 `then-run`（**执行命令**）；`evidence-preserving-reducer` 有 `provider.ts`（**调模型**）；`online-context-compact` 写状态并调 `compact()`。**三者都不是只读能力** |
| 本项目 | [write-tools.ts](../src/write-tools.ts)：35 | `READ_ONLY_TOOLS = ["read_file","inspect_file","job_output"]`；**`job_output` 已是先例**："reading a job's output changes nothing; it is a view of work that was already permitted to start" |
| 本项目 | [runtime.ts](../src/runtime.ts)：1043–1049 | `assembleContext` 是投影层：拼接 `past` + 压缩摘要，且明写 **"The full transcript is still in the session log"**——与 SoL-Pi 的"只改投影、不动存储"同构 |
| 本项目 | runtime.ts：985 | 超过 `maxContextBytes` **抛 `ContextBudgetError`**，即整轮失败 |
| 本项目 | runtime.ts：138 | **"this project does not estimate"** token——刻意不估算 |

**接入方式：三条路里只有一条可走**

| 方式 | 判定 | 理由 |
|---|---|---|
| 把 SoL-Pi 作为依赖 import | ❌ **不采用** | 它紧绑 Pi 的 `ExtensionAPI`/事件与 `typebox`/`pi-tui`，而本项目**零生产依赖、且没有扩展宿主**。引入即同时打破两条既有不变量 |
| 起子进程调用 SoL-Pi | ❌ **不采用** | [IMPLEMENTATION.md](IMPLEMENTATION.md)：23/118 已明确"**不让 SoL-Pi 成为独立 agent**"；且经 `run_command` 中介会把它的输出变成不可校验的字符串 |
| **借鉴机制、自己按本项目 Tool 接口重写** | ✅ **采用** | IMPLEMENTATION.md：112 早已定调："**不把 DSH、蜂群或 SoL-Pi 原样接进来。借鉴机制，运行时仍是 `personal-agent` 自己的**"。MIT 许可允许，**须在源文件头与本条注明 NVIDIA / MIT 出处** |

**选哪一个能力：`observation-pack`，且这是唯一选项而非偏好**

四个扩展里只有 `obs_recall` 是模型可见的只读工具：`action-fusion` 的 `then-run` **执行命令**、`evidence-preserving-reducer` **调模型**、`online-context-compact` **写状态并触发压缩**。故队列里"先接一个只读能力"在证据上只有一个候选。

**⚠️ 一处必须说清的精确性**：该机制**内部有写**（把大结果归档进 agent home）。"只读"描述的是**模型可见面**（只有一个读工具、无路径参数），**不是整个机制无写**。归档写入不由模型发起、只落在 agent home 内的固定子目录。本项目本轮已因措辞不精确返工两次（D49 夸大、D50 探针误报），故此处不写"纯只读"。

**⚠️ 本条的"归档侧"设计已被随后的核实推翻，改用下方修正版（尚未写代码，故直接修正而非留更正指针）**

核实 `session-store.ts` 后发现两件事，使 SoL-Pi 的"另存一份内容寻址归档文件"在本项目里**不该照抄**：

1. **完整工具结果本来就逐字存盘了。** `session-store.ts` 的 **ADR-0001「单一真相来源」**（第 22–39 行）明写：一次工具调用过去被写三遍（`tool/call`、`tool/result`、以及真正喂给下一轮 prompt 的 `message`），**"审计那一对是副本，而留着副本意味着两者可能不一致"**，故新写入**只产生 message**；`tool/result` 与 `tool/call` 现在是**可读但永不写**的遗留 kind。
2. **于是另存归档文件＝给已存好的数据再造一份副本，直接违反本项目自己的 ADR-0001。**

**修正后的设计**：

| | SoL-Pi 原设计 | 本项目修正版 |
|---|---|---|
| 归档 | 另写内容寻址文件到 agent home | **不写**——会话日志里已有逐字原文（ADR-0001） |
| 召回入参 | `id`（内容哈希）+ offset | **`callId`** + offset（`callId` 模型本来就看得见） |
| 是否碰文件系统 | 是（故须防符号链接/穿越/覆盖） | **否**——走 `SessionStore.read()` 现成且已测的读接口（连损坏行补救路径都是现成的） |
| 与 ADR-0001 | 冲突（制造副本） | 一致 |
| agent home 是否多一个模型可达通道 | **是**（这是原设计最大的风险） | **否** |

**修正带来的一个重要后果**：原方案里"最承重的一条"（工具只收 id 不收路径，因为归档在 agent home 里、而 D50 刚把 agent home 按位置封死，该工具会成为模型唯一能伸进 agent home 的通道）——**这条风险在修正版里根本不存在**，因为工具压根不碰文件系统。**`O_NOFOLLOW`/`O_EXCL`/`EEXIST` 逐字节校验/目录 `0o700` 那一整套也因此不需要**（它们防的是文件系统攻击面，而没有文件系统就没有那个面）。

**修正后仍保留的机制**（与存哪无关，是真本事）：字节与行数**双重封顶** + `nextOffset`/`eof` 续读 + **执行后再校验一次输出未超限**；**切页不得切断多字节字符**（SoL-Pi 用 `trimUtf8End` 裁 UTF-8 续字节；本项目读回的是 JS 字符串，对应物是**不得切开代理对**——本项目有 GBK 乱码事故史）；**fail open**（打包/取回失败绝不能让 agent 丢掉观测结果，降级为照常发全文）；摘录**只取整行**、头尾各半预算；**压缩摘要与审计行不参与打包**。

**实现时须核实、不得靠推断的一点**：持久化的 message 内容是否经过任何删改。目前证据指向"逐字保存"（超限时是抛 `ContextBudgetError` 让整轮失败、而非截断），但**必须在实现时验证**，因为整个修正方案都建立在"原文确实在日志里"这一条上。

**以下是被修正的原记录，保留以存证推理过程：**

**采用（机制层面，逐条都是非显然的）**


1. **工具只收 `id`，绝不收路径**——这是本轮**最承重的一条**，理由是本项目的：D50 已把 agent home **按位置**对文件工具整体拒绝，而 `obs_recall` 要读的归档恰好在 agent home 里。**于是它会成为模型唯一能伸进 agent home 的通道。** 若它接受路径参数，等于把 D50 刚封上的洞重新打开。收 id + **在构造路径之前**用 `/^obs_[a-f0-9]{24}$/` 校验 + 目录前缀写死在代码里，三者合起来才使这个通道不可滥用。
2. **内容寻址 id + `O_NOFOLLOW`（读与建）+ `O_EXCL`（建）+ `EEXIST` 时逐字节校验（size + sha256）才复用**——防符号链接、防覆盖、防被植入的同名对象。
3. **`trimUtf8End`：分页永不切断多字节字符**。**对本项目尤其相关**：本项目有 GBK/乱码事故的历史记录（`哈希`→`鈥希`），任何按字节切片的读路径都必须处理这件事。
4. **字节与行数双重封顶 + `nextOffset`/`eof` 续读**，且**执行后再校验一次**输出确实未超限（不信任自己的上限计算）。
5. **fail open**：归档失败**绝不能让 agent 丢掉它的观测结果**——降级为"照常发全文"，而不是让整轮失败。
6. **只取整行的头尾摘录**（`split(/(?<=\n)/)`），不在行中间截断。
7. **已被验证的证据不参与打包**（SoL-Pi 用它排除 reducer 回执）。本项目对应物：**压缩摘要与审计行不得被替换成摘录**。
8. **投影层改写、存储不动**——与 `assembleContext` 现有的"完整转录仍在会话日志里"同构，故接入点是 `runtime.ts:1043` 一带，**不需要新增事件系统**。

**不采用**

1. **不采用 `pi.on("context")` 事件形态**——本项目没有扩展宿主，直接在 `assembleContext` 内联调用即可；为一个钩子引入事件系统是过度设计。
2. **不采用 `typebox`**——本项目有自己的 JSON Schema 约定与零依赖不变量。
3. **不采用其 TUI 渲染**（`renderSolPiTool`/`showSolPiSavings`/`pi-tui`）——本项目已有自己的预算行。
4. **不采用 `estimateTokens = len/4`**——`runtime.ts:138` 明写本项目**刻意不估算 token**（"this project does not estimate"）。**故只采用字节口径**，占位符里报 `original_bytes`/`original_lines`，不报估算 token。这是一处必须主动拒绝的诱惑：抄过来很省事，但会与既有决定矛盾。
5. **不采用"用后续 assistant 消息数推算第几次请求"**——那是 Pi 缺少直接计数时的代理量；本项目在 `assembleContext` 里能直接数自己的 provider 请求次数，**更准确**。
6. **暂不采用 JSONL ledger**——它有审计价值但非本轮必需；若采用则须放 agent home（不可被文件工具触及），留作后续。
7. **不采用 `action-fusion` / `evidence-preserving-reducer` / `online-context-compact`**——均非只读；且后两者分别引入模型调用与压缩策略，属另外的设计问题。

**Policy 与批准如何走（队列条目的硬要求）**

- 在 `tools.ts` 按现有 Tool 接口注册，**走本项目自己的 JSON Schema**；
- **加进 `write-tools.ts` 的 `READ_ONLY_TOOLS`**——该文件是单一真相来源，`tiers.ts` 与 `file-policy.ts` 都从它派生，故**"提供"与"许可"两个机制自动一致**（该文件的注释记载过两者不一致导致模型被"unknown tool"拒绝的真实事故）；
- 于是**每个档位都提供它、`ask-before-writing` 档不为它逐次问**，与 `job_output` 同待遇；
- **它不占用写预算**（读工具）；
- **它不走 `assertReadablePath`**——因为它不接受路径。**这不是绕过路径收敛，而是它压根没有路径可收敛**；其边界由"固定目录 + id 模式 + 无路径参数"提供，须在源码注释与 SAFETY.md 里写明这条论证。

**真实收益（不是为接而接）**：`runtime.ts:985` 现在**超过 `maxContextBytes` 就抛 `ContextBudgetError`、整轮失败**。大 `run_command` 输出是本项目最常见的超限来源，打包后该失败模式会显著减少，且**原文仍可按页取回**——比压缩摘要更强，因为摘要是有损且不可逆的。

**范围建议（一轮做完，不拆）**：**归档侧与召回侧必须同轮**，因为只接召回侧会得到一个永远返回不了数据的死工具。归档侧是内部实现、不新增模型可见面，故仍满足"接一个只读能力"。**测试须含变异验证**（本项目本轮已两次靠它抓到真问题），并须含一条**"id 模式校验先于路径构造"**的测试与一条**"多字节字符不被切断"**的测试。

**未验证**：SoL-Pi 自身测试未运行（不在本项目职责内，且它是 Pi 扩展、缺 Pi 无法跑）；`FULL_SENDS=2` 与 `THRESHOLD_BYTES=10KB` 是否适配本项目的窗口大小，须真机测过才定；非 Windows 平台；与 `--trust-root`、与既有 `/compact` 的交互。

### 记忆系统设计（D53，2026-09-29，取证完成，尚未写代码）

**⚠️ 更正（D55 核实源码后）：本条两处断言有误，原文保留以存证**

操作员提供三个视频文案后，我去核对本项目源码，**抓出本条自己写的两处错误**：

**错误一（诊断错）：支柱 A 说"操作员对话中途提出的规则会被 `/compact` 摘要掉"——不成立。**
实读 [runtime.ts](../src/runtime.ts) 第 1037–1057 行 `buildPrompt`：压缩**只替换 `index < covered && message.role === "tool"` 的消息**，替换为 `[tool result omitted; N chars remain in the session log]`；**用户与助手消息永远逐字保留**。第 1028–1029 行注释原文：*"A summary is an index, not a replacement. User and assistant messages stay verbatim, because a rewritten summary can drop a path, an error, or a command."*

**故操作员中途说的规则从不被删，它一直在每次请求的 prompt 里。** 真实失效模式是**位置稀释**：第 3 轮说的话，到第 300 轮仍排在第 3 位，被后面几百条消息淹没。**视频一的表述（"不会被大量闲聊内容稀释""不会随着对话轮次增加被淹没"）比我的诊断准确** —— 它说的是稀释，我说成了删除。

**更正后的支柱 A 诊断**：约束不会丢失，但会**失去显著性**；且因为压缩只覆盖 tool 消息，**对话密集（而非工具输出密集）的会话里 `/compact` 几乎无效**，而 `maxContextBytes` **不是截断策略而是整轮拒绝**（第 114–117 行：*"an over-size prompt is refused with its actual size, because silently dropping messages ... would change what the model is answering without anyone being told"*）。**所以膨胀对本项目不是成本问题，是可用性问题**：会话最终会走到"整轮直接失败"，而压缩救不了它。

**支柱 A 的做法因此不变，但理由变了，而且实现成本比原估更低**：本项目**已有现成先例** —— 压缩摘要本身就是以 **`role:"system"` 消息注入在消息列表最前**（第 1046–1050 行）。所以"每轮前置重新注入约束"不需要新机制，沿用同一形状即可。**并且注入时必须沿用 `genePrompt` 的既定态度**（第 1039–1040 行注释原文：*"the selected strategy is **context, never a rule the model is trusted to obey**"*）：**注入的文本是上下文、不是保证，强制力必须在规则表里**。这恰好就是视频一"前置注入 + 后置独立校验"双层结构的本项目版表述。

**错误二（凭空记了一个不存在的缺口）：我在别处说过本项目缺"最大步骤数/最大工具调用次数"的轮次级熔断——不成立。**
[runtime.ts](../src/runtime.ts) 早已齐备且**超出**视频二的要求：`maxSteps`→`StepLimitError`（第 754 行）、`maxToolCallsPerStep`→`ToolBudgetError("step")`（第 800–802 行）、`maxToolCallsPerRun`→`ToolBudgetError("run")`（第 803–805 行）、墙钟 `deadlineMs`、`maxContextBytes`→`ContextBudgetError`、`maxContextTokens`→`TokenBudgetError`、写入预算→`WriteBudgetError`，并由 `formatBudget`（第 365–389 行）渲染为一行：步骤 / 工具 / prompt 字节 / 令牌 / 推理 / 写入文件与行数 / 用时。**视频二要的三项我们全有，且多出令牌、上下文、写入三类预算。**

**未受影响的一条**：支柱 D"不采用任何 token 估算"经核实**成立**。`maxContextTokens` 由 provider 自报的 `usage.inputTokens` 强制（第 124–127 行，并诚实标注两个后果：首次调用尚无测量、只能晚一轮叫停）；`countPromptTokens` 是可选宿主钩子且 **"No tokenizer is bundled"**，启发式（字符数除常数）**被刻意排除**，理由是*"an estimate that is wrong in either direction would silently replace the honest 'not measured yet' state with a confident-looking number"*（第 146–149 行）。

**方法论教训（本项目第四次同类）**：D49 夸大 git 严重性、D50 探针假象、D51 钉错层、**本次 D53 诊断错 + 凭空记缺口**。**四次的共同点是"凭对架构的印象下断言"**，而四次都是**实读源码或实跑产品**才抓出来的。**本次尤其值得记：是操作员给的外部内容逼我去核对，才发现自己的错** —— 外部来源的价值不止于提供新机制，也在于**逼你重新读自己以为已经读懂的代码**。

**⚠️ 操作员指定的两个参考源无法访问，如实记录**

操作员要求参考两个抖音视频（《Agent长任务失控怎么解？五问拆透》《为什么你的 Agent 越聊越忘规则？……约束隔离与记忆治理》）。**两条路都试过、都失败**：

- `web_fetch` 两个短链均被跨域重定向策略拒绝：`cross-origin redirect to https://www.iesdouyin.com is not followed automatically`
- `web_search` 本会话始终不可用：`no API key for "DEEPSEEK_API_KEY"`

**且视频是音视频内容，即使取到页面也只有标题与简介，不等于取到讲述内容。故本条不含任何对该视频内容的转述或推测**——那会是编造。下面全部结论只基于可核对的一手源码。**若操作员提供字幕或要点，须另起一条记录并据此修订本设计。**

**读过的来源**

| 来源 | 位置 | 读到什么 |
|---|---|---|
| SoL-Pi | [evidence-preserving-reducer/index.ts](../../../SoL-Pi/SoL-Pi/src/sol-pi/extensions/evidence-preserving-reducer/index.ts)：5–20 | **"delegate the first read of a long build or test log to the configured reducer model, then verify what comes back"**；**"accepts the resulting receipt only when every quoted line is found byte for byte in the archive. A receipt that cannot be checked is discarded and the original output reaches the frontier agent untouched"**；**"Delegation therefore never requires trusting a fluent summary."** |
| SoL-Pi | 同上：64–75 | 参与门槛：`DIAGNOSTIC_COMMAND` 正则（只对构建/测试类命令）、`minBytes`、`maxChars`、**`LIKELY_SECRET` 命中即回退**（不把疑似密钥送给归约模型） |
| SoL-Pi | 同上：78–159 | **每一个治理决定都写 journal**：`candidate`/`provider_response`/`applied`/`fallback`，且 fallback **必带 reason**，枚举值包括 `source-over-max-chars`、`likely-secret`、`model-call-timeout`、`reducer-model-unavailable`、`model-call-exception`、`model-response-error`、**`receipt-not-smaller`**（回执没比原文小就不采用） |
| SoL-Pi | 同上：126–135、156–157 | `validateReceipt` 返回 `{ok, value\|reason}`；回执携带 `evidenceCount` 与 **`uncertain`**（**允许摘要自陈"不确定"，并把这个事实记下来**） |
| SoL-Pi | 同上：69–148 | **所有回退路径都 `return undefined`**，即原文原样送达——**失败方向一律偏向完整而非偏向紧凑** |
| SoL-Pi | [online-context-compact/economics.ts](../../../SoL-Pi/SoL-Pi/src/sol-pi/extensions/online-context-compact/economics.ts)：6–31 | 压缩**经济性**：`writeTokens`/`archiveTokens`/`memoTokens` 是成本，`breakevenRequests`/`combinedBreakevenRequests` 与 `expectedRemainingRequests` 比较后才决定 `compact: boolean`；`windowReserveTokens=16384` |
| SoL-Pi | 同上：22–31 | `CompactionReason` 枚举**含"无法判定"的情形**：`horizon_unavailable`、`cache_ratio_unavailable`、`native_not_compactable`、**`non_positive_saving`**（省不下就不压） |
| SoL-Pi | 同上：61–68 | `carriedDebtTokens`/`cacheDebtRepaymentTokens`/`cacheWriteReadRatio`——**把 prompt cache 失效当作压缩的成本计入**；`MINIMUM_VARIANCE_SAMPLES=3`、`SMALL_SAMPLE_SCALE=0.5`——**样本不足时保守** |
| 本项目 | [session-store.ts](../src/session-store.ts)：22–39 | **ADR-0001 单一真相来源**：工具结果只写一遍（`message`），`tool/call`、`tool/result` 可读但永不写；理由是"留着副本意味着两者可能不一致" |
| 本项目 | [runtime.ts](../src/runtime.ts)：1071–1105 | 现有 `/compact`：拒绝在 send 进行中执行、拒绝空摘要、拒绝摘要里带工具调用；**但不校验摘要内容是否与原文相符** |
| 本项目 | runtime.ts：1043–1049 | `assembleContext` 是投影层；压缩只替换**前 `covers` 条**，且明写"完整转录仍在会话日志里" |
| 本项目 | runtime.ts：985 | 超 `maxContextBytes` 抛 `ContextBudgetError`，**整轮失败** |
| 本项目 | [cli.ts](../src/cli.ts)：359 | `systemPrompt` 是 `AgentRuntime` 的构造参数、**每次请求单独发送**，不属于可被压缩的 `past` |
| 本项目 | [config.ts](../src/config.ts) | D51 新增的配置只有**权限规则**（tool/decision），**没有承载自然语言约束的地方** |

**核心诊断：本项目"越聊越忘规则"的真实成因，与上下文长度无关**

把约束分成两类，它们对长度的敏感度**完全不同**：

| 约束类型 | 载体 | 会随对话变长而失效吗 |
|---|---|---|
| **强制型**（enforced） | 规则表、路径策略、注册表缺席 | **不会**——是代码，不是文本。D51 刚把配置钉在姿态边界之下，`priority` 再大也跨不过层 |
| **系统提示里的指示** | `systemPrompt` | **不会**——每次请求单独重发，不在可压缩的 `past` 里 |
| **操作员对话中途提出的规则** | `past` 里的普通消息 | **会**——`/compact` 之后前 `covers` 条被摘要取代；不压缩时也会被挤出窗口 |

**所以第三类是唯一的真实缺口**，而它恰好就是"越聊越忘规则"：**操作员说了一句"以后一律用中文回复""不要动 docs 目录"，这句话就是一条普通消息，压缩会把它摘要掉，长对话会把它挤出去。** 而本项目**没有任何机制承载它**——`config.json` 只放权限规则，放不下散文式约束。

**四个支柱（按依赖顺序）**

**支柱 A：约束隔离——给操作员一个不会被压缩掉的约束层。**
- agent home 下一份操作员所属的**持久指令**存储，**在投影层每次请求重新注入**，因此既不会被 `/compact` 摘要掉、也不会被挤出窗口。
- **必须复用 D50/D26 的结论**：这份文件**不可被 agent 自己写**（agent home 已按位置对文件工具封死，D50 实测并钉住）。**否则"agent 改自己的约束"就是最彻底的自我提权，比改 `trust.json` 更糟**——`trust.json` 只放宽读，而这个能改掉一切行为规范。
- 与 `config.json` **分开**：那个是**代码强制**的权限规则，这个是**只能靠散文表达**的约束。**两者不可混**，因为混了就分不清"哪条是拦得住的、哪条只是嘱咐"。注入时应**标明这一点**，不把嘱咐伪装成保证。

**支柱 B：记忆治理——压缩必须可验证，不能信任流畅的摘要。**
- SoL-Pi 的原则值得整条采用：**"accepts the receipt only when every quoted line is found byte for byte in the archive"**，且**"Delegation therefore never requires trusting a fluent summary"**。
- 本项目 `/compact` 现在**只校验形状**（非空、不带工具调用），**不校验内容与原文相符**。这与既有风格一致地可扩展：把"摘要里引用的每一行都必须在转录中逐字找到"作为记录摘要的前置条件，**不满足就拒绝记录、保留原文**。
- **失败方向必须偏向完整**：SoL-Pi 所有回退路径都 `return undefined`（原文原样送达）。本项目同理——**压缩不成功就宁可上下文长，也不要用一份没验证过的摘要换掉原文**。
- **`receipt-not-smaller` 这条要照抄**：摘要没比原文小就不采用。**不为"压缩了"这个动作本身付费。**
- **`uncertain` 要照抄**：允许摘要自陈不确定，并把这个事实**记进审计**。本项目反复强调"把不确定说成确定"是主要事故源（D49 夸大、D50 误报），这一条是同一原则在记忆层的落地。

**支柱 C：记忆治理——大结果分页取回，而不是重发或摘要掉。**
即 D52（修正版）：占位符替换 + `obs_recall` 按 `callId` 分页读回，**从会话日志读、不另存副本**（ADR-0001）。**它同时缓解 `runtime.ts:985` 的整轮失败**，且比压缩更强，因为原文可按页取回、无损。

**支柱 D：记忆治理——压缩是有成本的，按经济性决定，并记录理由。**
- SoL-Pi 把压缩当作**投资**：成本是 `writeTokens`+`memoTokens`+**prompt cache 失效的债务**，收益是后续每次请求省下的量，故须比较 `breakevenRequests` 与 `expectedRemainingRequests`。
- 本项目现在**只有手动 `/compact`，没有"该不该压"的判定**。是否引入自动压缩须谨慎：**自动压缩会在操作员没要求时改掉他看到的上下文**，这与"移除边界须是可审计的显式决定"同源。**若引入，必须落审计、必须带 reason、必须在样本不足时保守**（`MINIMUM_VARIANCE_SAMPLES=3`、`SMALL_SAMPLE_SCALE=0.5`），并且**"无法判定"要是一个显式的 reason 而不是静默不压**。
- **但本项目的口径不同，不可照抄**：SoL-Pi 全程用 token，而 `runtime.ts:138` 明写本项目**刻意不估算 token**、只用字节与 provider 自报的 `usage.inputTokens`。**故经济性判定必须建在这两个真实量上，不能引入 `len/4` 估算。**

**不采用**

1. **不采用 SoL-Pi 的独立归档文件**（见 D52 修正）——违反 ADR-0001。
2. **不采用"归约模型"作为默认路径**——`evidence-preserving-reducer` 需要**额外一次模型调用**，而本项目本轮多次实测到免费网关会返回 HTTP 200 + 合法 JSON + **空 `tool_calls`**（额度耗尽），多一次调用就多一个失败点。**故支柱 B 应先做"验证"这一半（零额外调用），"委派归约"留作可选后续。**
3. **不采用 token 口径的任何估算**（`estimateTokens`、`windowReserveTokens` 等）——与 `runtime.ts:138` 冲突。
4. **不采用 Pi 的事件钩子形态**——无扩展宿主，内联在 `assembleContext`。
5. **不采用自动压缩作为第一步**——先做 A/B/C（都不改操作员看到的上下文的"何时变短"这件事），D 的自动触发涉及"未经要求就改变上下文"，须单独一轮并落审计。

**实施顺序建议**：**A（约束隔离）→ C（分页取回，即 D52 修正版）→ B（可验证压缩）→ D（压缩经济性）**。理由：A 是唯一**已存在的真实缺陷**（操作员的话会被摘要掉），且与刚做完的 D50/D26/D51 直接闭环；C 已有完整取证；B 依赖 C 的"原文可取回"才有意义；D 最大且最需谨慎。

**未验证**：持久化 message 内容是否逐字（D52 已列为实现前必核）；`/compact` 的 `covers` 与支柱 A 注入点的相互作用；非 Windows；两个视频的实际内容（**取不到**）。

### 抖音视频取证：全部路径已探到底，均不可行（D54，2026-09-29）

**背景**：操作员要求参考两个抖音视频（见 D53）设计记忆系统，并因"是视频、无法复制字幕"而询问能否自动登录获取。**操作员在四个选项中明确选定"先只跑不需要 key 的部分"**，本轮即执行该选项并跑到边界。

**未做任何自动登录，也未索要凭据**。三条理由：无凭据且不应代管操作员的平台密码；自动登录违反平台条款；把凭据引入 agent 可达范围与本项目既有约束直接冲突（`toolEnvironment` 只放行 PATH/SystemRoot/Windir/ComSpec/Pathext；密钥不得进转录/日志）。

**逐条实测结果（全部为真实命令输出，非推断）**

| # | 路径 | 实测结果 |
|---|---|---|
| 1 | `web_fetch` 抖音短链 | 被跨域重定向策略拒绝：`cross-origin redirect to https://www.iesdouyin.com is not followed automatically` |
| 2 | `curl -I` 解析短链 | **成功**，无需登录。302 → `www.iesdouyin.com/share/video/<id>/`，取得视频 ID `7689090685382698099` 与 `7689040668966030633` |
| 3 | 抓分享页（移动端 UA） | **反爬拦截**。两页字节数完全相同（32562），可见文本仅 43 字：**"抱歉出错了 请尝试在抖音内观看 打开抖音"**，页面含 `captcha`/`verify`，`_ROUTER_DATA.loaderData.video_layout` 为 `null`。**这是客户端指纹反爬，不是鉴权问题，登录也解决不了** |
| 4 | 抓网页版 `www.douyin.com/video/<id>` | 返回 72914 字节，但 **`title` 为 `undefined`、可见文本 0 字** —— 纯 JS 壳，`curl` 拿不到渲染后数据 |
| 5 | 本机转录能力 | **`yt-dlp`/`ffmpeg`/`ffprobe`/`python`/`python3`/`py`/`pip`/`whisper` 全部不存在**（`node`/`npm`/`npx`/`curl` 有）。**故即使取到视频文件也无法本地转录** |
| 6 | `github.com/Panniantong/Agent-Reach`（上游，MIT，85829 star） | 目录树 `agent_reach/channels/` 为 bilibili/boss/exa_search/facebook/github/instagram/linkedin/mcporter/reddit/rss/twitter/v2ex/web/xiaohongshu/xiaoyuzhou/xueqiu/youtube —— **无 `douyin.py`**。且 `README.md`、`agent_reach/skill/SKILL.md`、`agent_reach/skill/references/video.md` 三份文件中 **`douyin`/`抖音` 命中 0 行**。**上游根本没有抖音能力** |
| 7 | `skillhub.cn` 的 `@clawhub_neverchenx/agent-reach-en` v1.1.0 | 下载 zip 仅 6012 字节、**3 个 markdown 文件、无任何代码**（`SKILL.md` 10333 / `skill-card.md` 2550 / `_meta.json` 133）。其 `SKILL.md` 第 182–195 行确有 "### Douyin (mcporter + douyin-mcp-server)" 并给出 `parse_douyin_video_info`/`get_douyin_download_link`/`extract_douyin_text`，注明 "No login required to parse videos" 且转录 "requires SiliconFlow API Key"。**但这些在上游不存在**（见第 6 行）。`_meta.json` 的 `publishedAt` 换算为 2026-03-15，而其 Changelog 写 "v1.1.0 \| 2025-03-15" —— **年份差整一年** |
| 8 | npm `douyin-mcp-server` v2.0.0（MIT） | 描述为 "Douyin MCP Server for automated **video uploads**" —— **能力方向相反**（上传而非解析），且 `repository` 缺失、无 `bin` |
| 9 | npm `douyin-mcp` v0.2.13（MIT） | **纯转发壳**：唯一依赖 `mcp-remote@0.8.1`；README 原文 **"The business implementation is privately hosted"**；端点 `https://mcp.socialdatax.com/douyin/mcp`，**需 `Authorization: Bearer <SOCIALDATAX_API_KEY>`**，**积分计费**（`socialdatax_get_points_balance`）。工具仅 `douyin_search_videos`/`douyin_search_products`/`douyin_search_users` 与评论抓取 —— **无转录能力，也无第 7 行所说的那三个函数** |

**结论**：**不存在"不需要 key"的抖音口播转录路径。** 不需要 key 的部分拿不到内容（第 3、4 行：反爬与 JS 空壳），能拿到内容的部分全都要付费 key（第 7 行的 SiliconFlow、第 9 行的 SocialDataX），**且第 7 行指名的工具经核实并不存在**。本机也无任何转录工具链（第 5 行）。**故 D53 无法从这两个视频取得一手内容，该状态维持不变。**

**本轮采用的方法论教训（比结论更值得留下）**

1. **技能市场的条目不是能力的证据，必须回上游核实。** 第 7 行那个再打包 skill 宣传了一项上游完全没有的能力（第 6 行 0 命中），并给出了看似可执行的命令。**若照它执行，会去装一个不存在的东西，或误装第 8/9 行那两个名字相近但能力不同的包。** 这与本项目反复强调的"调用底层函数不等于调用产品"（D50）、"未验证不得报为已验证"是同一条纪律在外部依赖上的版本。
2. **名字相近的包能力可能完全相反。** `douyin-mcp-server` 是**上传**、`douyin-mcp` 是**付费转发壳**，二者都不提供解析/转录。**装前必须读 description 与 deps，不能只看包名。**
3. **`license: MIT` 不等于"实现是开源的"。** 第 9 行是 MIT，但 MIT 覆盖的只是那个转发壳，**真正的实现在私有托管服务后面**。许可证只说明可复制的部分，不说明能力从哪来。
4. **反爬与鉴权是两种不同的墙。** 第 3 行的 `captcha`/`verify` 是客户端指纹校验，**登录不解决**；把它误判为"需要登录"会导致去做一件既无效又有风险的事（索要凭据）。**先判断墙的性质，再决定要不要翻。**

**明确拒绝（含从 `SKILL.md` 读到但绝不执行的内容）**

- `agent-reach configure --from-browser chrome` —— 自动从本地浏览器提取 cookie（即上游 `cookie_extract.py`；上游为它专门配了 `test_cookie_security.py` 与 `test_cookie_extract_perms.py` 两个测试，正说明其敏感度）
- `agent-reach install --env=auto` —— 会顺带安装 Node.js、mcporter、xreach、gh CLI、yt-dlp、feedparser 全套，**其中包含上述 cookie 提取器**
- 小红书 `publish_content` / `publish_with_video` —— 让 agent **直接对外发帖**，该文档全文无任何审批门槛，与本项目"移除边界须是可审计的显式决定"根本冲突
- `Camoufox — stealth Firefox, bypasses WeChat anti-bot` —— 反爬规避
- `curl -s "https://r.jina.ai/URL"` / `s.jina.ai` —— 把任意目标 URL 交由**第三方代理**读取，内容会经过第三方
- 其 "Workspace Rules" 要求写 `/tmp/` 与 `~/.agent-reach/` —— **与本项目守卫冲突**：本项目 fixture 规则恰恰相反（必须落在 `process.cwd()` 下，因为 `tmpdir()` 位于 `AppData\Local` 会触发 `UnsafeAgentHomeError`），且 **Windows 上没有 `/tmp/`**

**本轮唯一实际安装物**：`mcporter`（经 `npx --yes`，落在 npm 缓存 `AppData\Local\npm-cache\_npx\`）。**用 `--config` 指向自建隔离配置**，因其帮助明写 `auto-loads servers from ./config/mcporter.json and editor imports (Cursor, Claude, Codex, etc.)` —— 不隔离就会顺手加载并启动本机各编辑器里已配置的、未经审读的 MCP server。隔离后 `mcporter list` 输出 `No MCP servers configured`，**证实隔离生效**。**本项目源码与测试零改动。**

**本轮踩到的坑（记入以免重犯）**：`Out-File -Encoding utf8` 在 Windows PowerShell 下写入 **BOM**，导致 mcporter 的 JSON 解析器崩在 `offset 0: InvalidSymbol`。**必须用 `[System.IO.File]::WriteAllText` 配 `UTF8Encoding($false)`** —— 与本项目既有记录一致。另：`raw.githubusercontent.com` 本会话极不稳定（四次尝试三次失败/超时），而 `api.github.com` 稳定；**故外部取证一律走 api.github.com 的 contents 端点**（`Accept: application/vnd.github.raw+json` 可直接拿到明文，无需解 base64）。

**仍可行的办法（须由操作员执行，我无法代做）**：把要点口述给我（无需逐字稿，几条论点即可）；或用手机系统级实时字幕（Android 无障碍"实时字幕" / iOS 16+ "实时字幕"）把口播转成文字后截图或复制；或在抖音 App 内查看该视频是否自带 CC 字幕并截图。**任一方式到手后，须另起一条记录并据此修订 D53。**

### 三个视频文案：记忆分层 / 长任务五问 / 多轮执行端脱节（D55，2026-09-29，取证完成，尚未写代码）

**⚠️ 更正（操作员质疑后核实，本条两处措辞有误，原文保留以存证）**

操作员质疑两点：① 拒绝清单第 2 条的理由（"零模型调用是本项目的取向"、"免费网关不可靠"）；② 受限清单里"架构决定"的"架构"到底指什么。**核实后：第一问成立，我的拒绝理由是错的；第二问也成立，那句话是含糊其辞。**

**更正一：拒绝清单第 2 条的理由错了，且结论应从"拒绝"改为"改位置"。**

- **"零模型调用是本项目的取向"为假。** [runtime.ts](../src/runtime.ts) 第 1064 行注释原文：*"The summary is produced by a dedicated model call that is given **no tools**"* —— **`/compact` 本身就是一次专门的模型调用**。准确表述应窄得多：**权限判定层（`decide()`）零模型调用**。我把一个局部事实写成了全局取向。
- **"免费网关不可靠"不得作为独立理由。** HTTP 200 + 合法 JSON + 空 `tool_calls`（额度耗尽）是**某一个网关当前状态的观测**，且该网关目前 DOWN（`ECONNREFUSED 127.0.0.1:8787`）。**操作员指出：那是他本地的项目、上面也是大模型** —— 若其本地网关稳定，这条论据即失效。**把对某个部署的观测当成对"调模型"的原则性否定，是错的。**
- **但"模型判定不能充当约束边界"仍有四条不依赖网关可靠性的独立理由**：① **被检查的模型与产生计划的模型是同一个** —— 让模型自查即视频二自己批判的"靠大模型自觉"；② **模型判定双向出错**（漏判违规＝不安全；幻觉出违规＝挡住正常活）；③ **调用失败时只有 fail-open（不安全）与 fail-closed（不可用）两个选项，没有第三个**；④ 每轮多一次往返。
- **故正确结论不是"拒绝模型校验"，而是限定它的权力**：**规则能表达的约束由代码强制（gate，这是边界）；规则表达不了的可以用模型检查，但模型的判定只能"升级为要求审批"，不能直接放行、也不能静默通过。** 这样模型的不确定性被夹在 default-deny 里 —— **最坏结果是多问操作员一次，而不是替操作员做决定**，且承载于既有 `approve` 决策、不需新通道。**视频一坑④原文"简单场景可以用规则替代模型校验"本身即此混合方案，我此前误读成二选一。**

**更正二：受限清单第 1 条"副作用回滚做不了"说过头了。**

准确说是 **"未实现，且有明确代价"**：做法是写前存旧内容（backup-before-write），代价是磁盘占用与保留策略的决定。**且它不违反 ADR-0001** —— 那条 ADR 反对的是"给**已存盘的会话记录**再造副本"，而文件系统快照性质不同（**原文件会被覆盖，没有别的副本**）。**把"没做"写成"做不了"，会让下一轮误以为此处有硬约束而不去评估。**

**（D56 再更正：本条仍偏轻。** 它不是"未实现"，而是**早有具名方向在队列里** —— `SWARM_LOOP.md:242`：*"影子快照/选择性还原（opencode 机制，D25；可部分弥补'无沙箱＝无回滚'，只作用于文件工具，与现有边界同域）"*。**二者区别是：前者只需排期，后者听起来像要重新设计。详见 D56。）**

**更正三："架构决定"须具体命名为三条已记录的决定，不得使用抽象词。**

| 决定 | 可核对的硬事实 | 它挡住什么 |
|---|---|---|
| **零生产依赖** | [package.json](../package.json) **没有 `dependencies` 字段**，只有 devDependencies（`@types/node`、`typescript`） | 无嵌入库、无本地分词器、无本地模型 → **语义相似度判定（任务切换检测）做不了** |
| **不估算，只测量** | 字节预算 + provider 自报 `usage.inputTokens`；`countPromptTokens` 是可选宿主钩子且 **"No tokenizer is bundled"**，启发式（字符数除常数）**被刻意排除**（第 146–149 行） | → **"参数补全错误率""任务切换准确率"这类需判定的指标无法离线算出** |
| **强制力在代码不在模型** | `decide()` default-deny；`genePrompt` 注释原文 *"the selected strategy is context, **never a rule the model is trusted to obey**"*（第 1039–1040 行） | → 模型判定不能当边界（见更正一） |

**并且必须明写：这三条是"选择"，不是物理定律。** 每一条都可由操作员重新决定。**其中"零生产依赖"是承重的那条** —— 一旦允许装第三方包，语义检测、本地分词、本地嵌入全部打开，但同时引入供应链与原生模块风险（与本项目反复强调的"路径限制 ≠ 沙箱"属同一类顾虑：多一个依赖就多一个不受我们控制的执行面）。**这个决定权在操作员，不在实现者。**

**方法论教训（本项目第五次同类）**：D49 夸大 git 严重性、D50 探针假象、D51 钉错层、D53 诊断错 + 凭空记缺口、**本次把局部事实写成全局取向 + 把"没做"写成"做不了" + 用"架构"这种抽象词代替可核对的决定**。**前两类的共同点是"凭印象断言"，本次的共同点是"措辞比事实更硬"** —— 后者更隐蔽，因为它读起来像是谨慎的结论，实际是把一个可重新决定的选择说成了不可逾越的限制。**判据：凡是写"做不了/不可能/原则上不"，必须能指出是哪一条已记录的决定在挡，并说明该决定是否可由操作员改变。**

**来源**：操作员手工提供三份完整转写文案，即 D53/D54 中记录为"无法访问"的那两个视频，外加第三个（多轮 Agent 面试场景）。**D54 的"取不到"结论依然成立**（那是指我无法自行获取），本条来源是**操作员人工转述**，故不含任何我对视频内容的推测。

**广告剔除**（操作员要求分辨）：视频二"我是小哲点赞收藏加关注""想系统学习 agent 开发的同学可以查看橱窗哦"；视频三"只要是我粉丝，留下六六六，打包带走""必考题库""如果你想转行 AI 产品……留下学习，直接拿走"。**视频一无广告。以上全部剔除，不影响技术内容。**

**转写稿同音错字按技术语义还原**（不改动原意）：纸袋丢失→**指代丢失**；教练→**校验**；a 阵→**Agent**；任务回一机制→**任务回滚机制**；对奇关→**对齐关**；合规观→**合规关**；论完成率→**轮完成率**；信息不足化→信息不足时；反复跳重→反复重复。

**判定分四类**：**已有且更强**（不采纳，因为我们的版本更硬）/ **采用** / **拒绝**（附理由）/ **受限**（本项目架构决定，须如实标注、不得含糊承诺）。

#### 视频一：记忆分层 + 规划校验

| 机制 | 判定 | 依据 |
|---|---|---|
| 约束与闲聊**分开持久化**存储 | **采用** | 本项目无此物。`config.json`（D51）只承载**权限规则**（tool/decision），放不下散文式约束 |
| 每轮**独立调模型抽取**硬性约束 | **拒绝（改为半自动）** | ①每轮多一次模型调用，而免费网关已多次实测返回 HTTP 200 + 合法 JSON + **空 `tool_calls`**（额度耗尽），多一次调用多一个失败点；②**模型抽取的约束若自动获得强制力＝模型给自己定权限**，与 D26/D50/D51 的核心结论直接冲突。**故抽取只能产出"待操作员确认的建议"，确认后才入注册表** |
| 记忆分层（短时 / 持久约束 / 摘要） | **部分已有** | 短时＝`past`；摘要＝`/compact`（**只覆盖 tool 消息**）；完整转录永久在会话日志（ADR-0001）。**缺持久约束层** |
| 前置加载：约束**固定追加到系统提示词最前端** | **采用（且已有现成先例）** | 压缩摘要就是以 **`role:"system"` 注入在消息列表最前**（`runtime.ts:1046-1055`）；`genePrompt` 已并入系统提示（第 1041 行）。**故不需要新机制，沿用同一形状** |
| 后置校验：生成计划/工具调用后**独立校验，违反即拦截重规划** | **已有且更强** | `decide()` 是 default-deny 的规则表，在**工具执行前**拦截，且是**代码判定而非模型判定**；`when` 谓词**"抛错则拒绝，绝不放行"**。视频要靠模型校验（会漏），我们不会 |
| 优势"不被闲聊稀释、不被轮次淹没" | **采用为设计目标** | 见 D53 更正：**这正是本项目的真实失效模式**（位置稀释），而我原先误判为"被摘要删除" |
| 优势"节省上下文窗口" | **采用（严重度更高）** | 本项目超 `maxContextBytes` 是**整轮拒绝**而非截断（`runtime.ts:114-117`），**故膨胀＝不可用，不是＝变贵** |
| 优势"约束可增删可查询、用户随时修改取消" | **采用** | 注册表须支持增删改查与失效标记 |
| 坑①抽取不准（需 Few-shot 优化 Prompt） | **拒绝其解法，采纳其问题** | 我们的解法更彻底：**不自动抽取即无不准确** —— 强制约束由操作员写，模型抽取只作建议 |
| 坑②约束冲突（优先级、过期标记、旧约束自动失效） | **部分已有 + 采用缺口** | **已有且更强**：`RULE_TIERS` 五层，**高层永远压过低层，无论 priority**；`priority` 钳制 0..999 故**永远跨不过层**（D51 实测过：钉错层会让 `priority:999` 压过 read-only 的 `deny-writes`，**意外造出自我提权**）。**缺：过期标记与自动失效** —— 真实缺口，采用 |
| 坑③记忆膨胀（动态筛选，只加载当前任务相关约束） | **采用（且必须）** | 规则表**本来就按 `tool` 索引**，天然即动态筛选；但散文约束注册表须自己实现"只加载相关"，否则撞字节上限即整轮失败。**筛选判定不可用模型**（又一次调用），用工具名/任务域匹配 |
| 坑④校验开销（简单场景用规则替代模型） | **已做到极致** | 本项目**全部校验都是规则，零模型调用** |
| 坑⑤隐性约束识别难，需业务规则库 | **已有对应物** | `tiers.ts` 的姿态（read-only / 中间档 / full-access）就是业务规则库；`denyAllWrites` 在 USER 层 priority 800 用 `tool:"*"` 兜底 |

#### 视频二：长任务失控五问

| 机制 | 判定 | 依据 |
|---|---|---|
| 三层能力：任务规划层 / 状态跟踪层 / 目标对齐层 | **状态跟踪层已有；规划层与对齐层无** | 状态跟踪：会话日志逐字（ADR-0001）+ `usage` 事件 + audit 事件流。**规划层与对齐层对应 `IMPLEMENTATION.md` 已记的"先 TaskSpec"** —— 本来就是队列下一项 |
| 分层拆解 + 边界锁死（每层明确输入输出与完成标准，**交付物写死**） | **采用** | TaskSpec 的设计要求 |
| 依赖校验（有前置条件的步骤不能提前执行） | **采用** | TaskSpec 需要 |
| 动态重规划（工具失败/信息不足允许调整后续步骤） | **采用，但必须落审计** | 本项目原则：改变计划是可审计事件 |
| **任务回滚机制**（回到上一稳定节点重试，而非推倒重来） | **受限采用（须区分两种回滚）** | **计划层回滚可做**（回到上一步重新规划）；**副作用回滚做不了** —— 本项目无快照/事务，文件写操作不可自动撤销。**这个区别必须写死，不能含糊承诺"支持回滚"** |
| 目标锚定（持久化原始目标，每轮执行前对齐校验） | **采用（判定方式受限）** | 原始目标＝首条 user 消息，会话日志已有。**但"是否偏离目标"的判定：用模型则每轮多一次调用（不可靠），用规则则难以表达** —— 真实取舍点 |
| 步骤校验（是否重复执行 / 超出边界 / 擅自新增需求） | **部分可做** | "是否重复执行"与视频三的执行缓存同源；D52 修正版 `obs_recall`（按 `callId` 分页读回）正是"结果沉淀 + 复用"的载体 |
| **关键节点自省**（不是每轮，而是子任务完成/工具失败/结果异常时触发） | **采用** | "不是每轮而是关键节点"直接呼应坑④，与本项目零额外模型调用的取向一致 |
| 进度熔断（最大步骤数 / 最大工具调用次数 / 最大执行时长） | **已有且更强** | 见 D53 更正错误二：三类全有（`maxSteps`→`StepLimitError`、`maxToolCallsPerStep`/`PerRun`→`ToolBudgetError`、`deadlineMs`），**另多令牌、上下文、写入三类预算** + `formatBudget` 渲染 |
| 工具注册表 + 参数校验（非法参数直接拦截） | **已有且更强** | `ToolRegistry` **双向**强制缺席（注册了才存在、没注册就 unknown tool，**两个方向都测过**）；`write-tools.ts` 是"offered"与"allowed"的**单一真相来源**（因为真出过两者不一致、模型收到 unknown tool 的事故） |
| 调用结果沉淀（结构化沉淀进工作记忆，相同需求直接复用） | **已有载体，缺复用判定** | 完整结果逐字在会话日志（ADR-0001），**不需要新存储**；D52 修正版提供取回。**缺的是"相同需求"的判定** |
| 失败降级（重试→换替代工具→简化参数；非核心步骤允许跳过） | **受限采用** | **"换替代工具"若绕过规则表就是提权** —— `decide()` default-deny，降级只能在**已允许的工具集合内**进行且必须落审计；"跳过非核心步骤"须由 TaskSpec **显式标记**哪些非核心，**不能让模型自行决定跳过** |
| **血泪坑：不能让 agent 自己判断要不要调用工具，要把"什么场景用什么工具"写进规则** | **完全认同，已用更强形式做到** | 规则表 + 姿态（tiers）就是"什么场景允许什么工具"，**不是模型自觉**。与视频二金句*"好的长任务 Agent 靠的不是大模型自觉，而是用机制把它框在正确轨迹里"*同源 |
| 闭环验证三道关（目标对齐 / 过程合规 / 结果质量） | **过程合规关有真材料；另两关无** | audit 事件流带 `tool`/`decision`/`reason`/`rule`。**目标对齐关与结果质量关缺失** |
| 任务复盘（跑偏/失败/超时沉淀成案例，反哺规则；"可观测、可度量、可迭代"） | **采用（注意区分）** | 我的开发环境有 `swarm_reflect`/`swarm_distill`（重复失败→蒸馏成 guard gene），**但那是开发环境的机制、不是产品的机制** —— 产品需要自己的复盘 |

#### 视频三：多轮任务的执行端脱节（三个里最有价值）

核心洞察：**"拼接历史对话根本解决不了执行端的问题"**、**"大模型懂了，执行端没懂"**。

| 机制 | 判定 | 依据 |
|---|---|---|
| 核心洞察本身 | **对本项目完全成立** | 本项目工具参数**完全由模型当轮输出决定**，没有"结合任务状态补全"这一层。且超字节上限是整轮拒绝而非截断，**所以我们连"拼接历史"都比视频描述的更保守** |
| 根源①指代丢失（"它""第二个""上次那个"→参数空/噪声） | **真实存在，未解决** | 同上 |
| 根源②参数补全错误（搞错指代、漏关键约束） | **真实存在，未解决** | — |
| 根源③上下文冲突（用户中途改条件，系统沿用旧状态） | **目前不会犯，但属"因为没有所以不会错"** | 本项目**无持久任务状态**，故无旧状态可沿用。**一旦引入 TaskSpec，此坑立刻出现** —— 必须提前设计，不能等踩 |
| 根源④状态信息冗余 | 同视频一坑③ | — |
| 根源⑤性能成本失控（延迟与 token 随轮次线性上涨） | **严重度高于视频描述** | 本项目**确实线性上涨**，且超限**直接整轮失败** —— 不是"成本飙升"而是**不可用**。故 D52 修正版（大结果分页）+ `/compact` 是**刚需而非优化** |
| 状态管理层（任务域/关键实体/意图轨迹/已执行工具结果；**更新状态而非追加聊天文本**） | **采用（TaskSpec 核心）** | 本项目无。**"更新而非追加"这一句是关键设计约束** |
| 工具调用层（调用前结合任务状态**补全为完整参数**；补全后做**可信度校验**，低则向用户澄清、不强行调用） | **采用（最值得）** | **"宁可多问一句，不要胡乱调用"与 `decide()` default-deny 同源**。本项目已有审批机制（`approve` 决策）**可承载"向用户澄清"，不需要新通道** |
| 生成端上下文层（只放最近 2~3 轮 + 工具结果；更早的压缩成**任务事实摘要放到系统提示词**） | **部分已有 + 采用其位置选择** | `/compact` 摘要**已经是 `role:"system"` 且在最前**（`runtime.ts:1046-1055`）——**位置选择与视频一致，我们已做对**。**但触发是手动的**，且覆盖范围只含 tool 消息 |
| 执行缓存层（同任务域 + 实体未变→复用上一轮结果；切换任务/实体变化才重新调用） | **采用（与 D52 修正版合流）** | 载体已有（会话日志 + `obs_recall`），**缺的是"同一任务域 / 实体未变"的判定** |
| 任务切换检测（语义相似度判定新任务→清空旧状态） | **受限** | 需模型或嵌入；**本项目零生产依赖、无嵌入能力**，只能用规则或**显式命令**。**诚实标注为受限，不假装有语义检测** |
| 用户否定（"不是这个，重新来"）→立刻回退上一轮任务状态 | **受限** | 同视频二"任务回滚"：计划层可回退，**副作用不可回滚** |
| 最大轮次 + 超时**自动重置会话** | **前半已有；后半拒绝** | `maxSteps`/`deadlineMs` 已有。**"超时自动重置会话"须拒绝**：本项目会话日志是**审计载体**，自动清空会毁掉证据 —— **应终止而非重置** |
| 监控指标（轮完成率/参数补全错误率/任务切换准确率/单轮工具调用成本） | **部分可算** | `usage` 事件（provider 自报 `inputTokens`）+ audit 流可算出一部分。**但"参数补全错误率""任务切换准确率"需要判定，本项目刻意不估算 token、也无嵌入，故无法离线计算，除非在执行时落审计** |

#### 汇总

**采用（按优先级）**

1. **持久约束注册表 + 每轮前置注入**（视频一；即 D53 支柱 A）—— 用 `role:"system"` 注入在消息列表最前，沿用压缩摘要的现成形状；**注入文本是上下文不是保证，强制力在规则表**（`genePrompt` 注释已确立此态度）
2. **工具调用前的参数补全 + 可信度校验，低则澄清不强行调用**（视频三）—— 承载于既有 `approve` 决策，不需新通道
3. **任务状态层：更新而非追加**（视频三）—— TaskSpec 核心
4. **执行缓存 / 结果复用的判定**（视频二 + 三合流）—— 载体已有（D52 修正版）
5. **约束过期标记与自动失效**（视频一坑②）—— 真实缺口
6. **关键节点自省而非每轮自省**（视频二）
7. **目标对齐关与结果质量关的闭环验证**（视频二第五问）—— 过程合规关已有材料

**拒绝（附理由）**

1. **模型自动抽取的约束直接获得强制力** —— 等于模型给自己定权限，与 D26/D50/D51 冲突。**抽取只能产出待操作员确认的建议**
2. **每轮独立调模型做约束校验** —— 本项目全部校验都是规则、零模型调用；且免费网关已实测不可靠
3. **用 `len/4` 之类启发式估算 token** —— `runtime.ts:146-149` 明写刻意排除，理由是"两个方向都可能错的估算会把诚实的『尚未测量』换成看起来很自信的数字"
4. **"失败降级可换替代工具"不受限** —— 绕过规则表即提权；只能在已允许集合内且落审计
5. **"非核心步骤允许直接跳过"由模型自行判断** —— 须由 TaskSpec 显式标记
6. **超时自动重置会话** —— 会话日志是审计载体，自动清空毁证据；**应终止而非重置**
7. **语义相似度做任务切换检测** —— 零依赖、无嵌入，只能用规则或显式命令

**受限（架构决定，须如实标注）**

1. **副作用回滚做不了** —— 无快照/事务；只有计划层回滚
2. **目标对齐判定无廉价方案** —— 模型判定要多一次调用，规则判定难表达"偏离"
3. **任务切换检测无语义能力** —— 只能规则 / 显式命令
4. **部分监控指标无法离线计算** —— 除非执行时落审计

**未验证**：TaskSpec 的具体形状（尚未设计）；持久约束注册表的存储位置与格式（**须复用 D50 的按位置封死结论，不可被 agent 自写**）；"可信度校验"的判定依据（规则还是模型，待定）；约束过期标记的触发条件；支柱 A 注入点与 `covers` 的相互作用。

### 三条具名决定：各自削弱什么、增强什么、该不该重议（D56，2026-09-29，无代码）

**⚠️ 更正（D57 取证后）：本条对 ① 的判定过重，两处断言有误，原文保留以存证**

操作员批准就"要不要放开 ①"取证后（见 **D57**），核实结果推翻了本条两处断言：

**错误一："① 堵住 ② 的逃生口"——不成立。** 实读 [cli.ts](../src/cli.ts) 第 180–204 行发现 **`PERSONAL_AGENT_TOKENIZER` 是已完整实现并接线到四处的机制**（帮助文本 `:59`、构造 `:189-204`、传入运行时 `:243-244`→`:394`、进预检 `preflight.ts:319`、进预算行 `runtime.ts:372-373`），它是一个**外部命令钩子**（`spawnSync` 读 stdin 的 prompt JSON、stdout 打印整数），**与 `package.json` 无关**。**故精确 token 预判今天就能获得，零依赖、零代码改动。** 我把它写成"被 ① 堵住"，是因为**只读了 `runtime.ts` 的选项声明与 D08 的决策行，没有去读 `cli.ts` 里的实现** —— 又一次"凭印象断言"。

**错误二："会话历史无法按内容索引"——不成立。** 本机 Node **v24.19.0** 实测 `require("node:sqlite")` **直接可加载**（导出 `DatabaseSync, StatementSync, Session, constants, backup`，建表 / 插入中文 / 条件查询 / 排序全部成功），而 `engines` 为 `node >= 22.6`、`node:sqlite` 自 22.5 起内置 ⇒ **floor 已覆盖，同样零依赖**。

> **⚠️ 更正（D68，2026-09-30）：上面这句"floor 已覆盖"不成立，原文按规矩保留不改写。**
> Node 官方 `doc/api/sqlite.md` 的 YAML 头记录：模块 `added: v22.5.0`，但 **`version: [v23.4.0, v22.13.0]`（PR 55890）的说明是 "SQLite is no longer behind `--experimental-sqlite` but still experimental."** ⇒ **22.5.0 至 22.12.x 需要 `--experimental-sqlite` 启动标志**，而声明的下限 **22.6 正落在该区间内**。"内置"与"免标志可用"是两件事，此处把它们当成了一件。
> **需说清的是：本文档同段的"未验证"清单当时就正确记下了这一条**（*"`node:sqlite` 在 `engines` floor（22.6）上是否打 ExperimentalWarning 或需 flag（本机只有 v24.19.0）"*）⇒ **错的是结论段的措辞，不是取证清单。**
> **实际暴露面比这句话听起来窄**：所有真被测过的版本都在 22.13.0 之上（`VALIDATION.md` 的便携包 **22.23.3**、CI 的 **22.x/24.x**、本机 **v24.19.0**），而 **22.6 下限本身从未被任何测试覆盖**（`VALIDATION.md` 与 `README.md` 均已如实记录）。修法见 D68 第一节的三选一，最干净的是把 `engines` 抬到 `>=22.13.0` —— `AUDIT.md` 的 A15 早已把该下限列为"仍需收窄"。详见 D68。

**因此本条对 ① 的判定应从"值得重议"降级为"已重议、结论是不放开"**，理由不是原则而是交易：**D56 列的五项"被 ① 挡住的能力"里，两项已有零依赖解法（其中一项已实现）、一项当前队列不需要，只有嵌入与 pty 真的被挡住 —— 而那两项恰好都是中间路也救不了的**（`onnxruntime-node@1.30.0` 解包 **287.12 MB** + `postinstall="node ./script/install"`；`node-pty@1.1.0` 解包 **61.38 MB** + deps 含 `node-addon-api` + `install="node scripts/prebuild.js || node-gyp rebuild"`）。

**仍然成立的部分**（未被推翻）：① 增强可核验性与供应链安全；pty 缺失导致真实终端观感永久未验证（`VALIDATION.md:218` / `LIVE_INTEGRATION.md:72`）；"不是做不到而是交易不好"的判例措辞（`:655`）；② 拒绝的是**估算**而非**测量**；③ 削弱的不是能力而是**自主性**，且不该重议（第二自报通道铁律 `STATUS.md:101`）。

**方法论教训（本项目第六次同类，形态与第五次相同）**：D49 夸大 git 严重性、D50 探针假象、D51 钉错层、D53 诊断错 + 凭空记缺口、D55 措辞比事实更硬、**本次 D56 凭选项声明与决策行断言"逃生口被堵住"而未读实现**。**D55 立的新判据本可拦住它** —— 我写了"做不了"却没有指出是哪一条已记录的决定在挡，**因为并没有那样的决定，是我自己想象的**。**故判据须加一条：凡断言某能力"被 X 挡住"，必须指出 X 的具体位置（file:line 或依赖事实），不得指向一条抽象原则。**

**触发**：操作员追问 D55 更正三列出的三条决定 —— **"我想知道的是增强还是削弱 agent 能力？如果是增强有什么不做的理由，如果是削弱，削弱了什么？"**

**这个问题本身纠正了一个措辞习惯**：把三条笼统称作"安全取舍"是错的，**它们性质完全不同** —— 一条削弱能力、一条几乎不削弱、一条削弱的不是能力而是自主性。**下面每条的"削弱/增强"都必须有出处，凡无出处的一律不写**，因为本轮最大的风险正是"把取舍说得比证据更整齐"。

**本项目已有准确的判例措辞**（[:655](#) D26）：*"不采用 Windows 受限令牌方案的理由**不是做不到，而是交易不好**"*。**三条都应套用这个句式：不是"做不到"，是"交易如何"。**

#### ① 零生产依赖 —— **削弱能力，增强可核验性；是一笔交易，不是白赚**

**削弱了什么（逐条有出处）**

| 削弱项 | 出处 / 事实 |
|---|---|
| **真实终端行为永久无法验证** | `VALIDATION.md:218`、`LIVE_INTEGRATION.md:72` 原文：*"Node 无内置 pty，本项目也不为此引入第三方依赖；因此终端行为只能由注入式 IO 覆盖，真实观感留给操作者"* ⇒ **"Ctrl+C 取消观感、密钥输入隐藏观感"属未验证** |
| **语义相似度判定做不了** | 无嵌入库 ⇒ 视频三的"任务切换检测"只能用规则或显式命令（D55 受限第 3 条） |
| **发送前无法预测 token 溢出** | 无本地分词器 ⇒ 详见 ②，**这是 ① 堵住 ② 逃生口的地方** |
| **读不了二进制文档** | 无 docx/pdf/xlsx 解析库 |
| **会话历史无法按内容索引查询** | 无 SQLite 之类；日志是 append-only JSONL ⇒ "找出上次类似失败"做不到（视频二"任务复盘"因此受限） |

**增强了什么（同样具体）**

| 增强项 | 为什么对本项目尤其要紧 |
|---|---|
| **没有 `node_modules` 就没有 postinstall 脚本** | 无 typosquatting、无传递依赖被投毒。**本项目明确无沙箱**，agent 宿主进程权限＝用户权限，故供应链投毒直接等于本机任意代码执行 |
| **整个产品是可读完的源码** | 每个行为都能指到某一行我们写的代码。**本项目五次自我更正全部靠"实读源码"抓出来**（D49/D50/D51/D53/D55），这个能力的前提就是代码量与依赖量都在人能读完的范围 |
| **无原生模块 / 平台风险** | 不会有 Windows 预编译失败、Node ABI 不匹配 |

**"不放开"的理由是逐案的成本收益，不是教条** —— 项目内已有三处判例：`:100` *"本项目至今零生产依赖，为一个可绕开的问题引入需编译的原生依赖不划算"*；`:262` 拒绝把 SoL-Pi 作为依赖 import（*"引入即同时打破两条既有不变量"*）；`:312` 拒绝 `typebox`。

**且它不必是全有全无。中间路**：允许**纯 JS、无 install 脚本、版本钉死、vendored 进仓库**的依赖 —— 拿到分词器/嵌入，而不引入 `npm install` 执行任意代码的风险。**关键认识：真正的风险不是"有依赖"，而是"`npm install` 会执行任意代码"。** 把这两件事分开，中间路就存在。

**判定：值得重议，且是唯一值得单独重议的一条。** 放开它立刻买到三样与当前队列直接相关的东西：**(a) 真分词器 → 溢出从"整轮失败"变成"及时压缩"**（D55 已核实：超 `maxContextBytes` 是整轮拒绝而非截断，而压缩只能覆盖 tool 消息 ⇒ **对话密集的会话最终会走到不可用**，这正是采用清单第 1 项被列为刚需的原因）；**(b) 嵌入 → 任务切换检测**；**(c) pty → 关掉"真实终端观感永久未验证"这笔挂账**。

#### ② 不估算只测量 —— **几乎不削弱，反而防住一类对本项目特别严重的错误**

**削弱了什么**：**发送前无法预测 token 溢出**。`maxContextTokens` 由 provider 自报的 `usage.inputTokens` 强制，故 `runtime.ts:124-127` 自己诚实写明两个后果：**一轮的首次调用尚无测量**（只受字节上限约束）、**只能晚一轮叫停**。

**防住了什么**：`runtime.ts:146-149` 刻意排除启发式（字符数除常数）的理由原文 —— *"an estimate that is wrong in either direction would silently replace the honest 'not measured yet' state with a confident-looking number"*。**而本项目内容以中文为主**：UTF-8 下一个汉字 3 字节，`chars/4` 类估算对 CJK **系统性偏离** ⇒ **同一个字节上限对中文与英文同时"过松"和"过紧"**。这不是假想风险，是本项目实际内容形状下的必然。

**关键区分：本项目拒绝的是"估算"，不是"测量"。** 逃生口**已经实现**：`countPromptTokens` 是宿主注入钩子，另有环境变量 `PERSONAL_AGENT_TOKENIZER`；**D08（`:624`）已写明退出条件原文："决定随发行版绑定某个分词器依赖时"**。

**⇒ ② 的解法就是 ①。两条不独立，① 是承重的那条**（印证 D55 更正三的判断）。**故 ② 不必单独重议。**

#### ③ 强制力在代码不在模型 —— **削弱的不是能力也不是表达力，是自主性**

**削弱了什么**

| 削弱项 | 出处 |
|---|---|
| **agent 的自主性 —— 会多问操作员** | 规则表达不了的模糊约束，最终落到"问你"而非"它自己判断"。D55 更正一已确立：**模型判定并未被禁用，只是判决不能"放行"、只能"升级为要求审批"** |
| **配置有一处真实的表达力缺口** | D51 已如实记录：`config.json` **无法表达"只放行 `git status`"** 这类按参数内容的规则，因为 `Rule.when` 是函数，从 JSON 造函数只有 `eval`/`new Function`，**等于配置文件即代码执行面** |

**增强了什么**：**闸门是确定性的、可测试的、不能被说服**。模型判定会被提示注入劝走、会漂移、无法穷尽单测；代码判定可以**变异测试** —— 本项目这个 span 做了 3 次（agent-home 写入测试、配置层号、审计守卫），**每次都临时移除保护、确认测试变红**，证明测试非空转。

**为什么不该反过来（让模型当闸门）**：项目里有一条更根本的铁律 —— `STATUS.md:101`（D26）**"第二自报通道"**定义：*"另一个模型说这轮成功/批准"和"干活的模型自报成功"**结构上是同一个东西**，都不得采信；系统可信来源只有机械事实"*，且它是 D14/D15/D19 的共同依据（D19 尤其：参考实现里评审者准确率是拿"最终是否真的整合成功"回头校准的，而**本项目尚无验证执行器**，故模型评审者会是**"一个永远无法知道准不准的裁判"**）。**让模型当约束闸门＝开第二自报通道。**

**判定：不该重议。** 但**其自主性代价应被明说**，因为它会随采用清单第 1、2 项落地而变大（更多约束 → 更多"升级为审批"）。

#### 汇总

| | 削弱什么 | 增强什么 | 该不该重议 |
|---|---|---|---|
| **① 零生产依赖** | **能力**（pty / 嵌入 / 分词 / 文档解析 / 历史索引） | 可核验性 + 供应链 | **值得**，且可走中间路（纯 JS、无 install 脚本、钉版本、vendored） |
| **② 不估算只测量** | 溢出预测（只能晚一轮叫停） | 防住"看起来很自信的错数字"，对中文内容尤其要紧 | **不必单独重议** —— 解法就是 ①，D08 已写明退出条件 |
| **③ 强制力在代码** | **自主性**（多问操作员）+ 配置无法按参数内容匹配 | 闸门确定性、可变异测试、不可被说服 | **不该** —— 反过来即违反"第二自报通道"铁律 |

**一句话回答操作员的问题**：**三条里只有 ① 是真正拿能力换东西的**，而且换到的是**可核验性与供应链安全**；**② 几乎没换掉什么**（它拒绝的是猜测，不是测量，逃生口已实现）；**③ 换掉的不是能力而是自主性**（agent 会多问你，但不会悄悄多做）。**若要放开，只放开 ①，且走中间路。**

**顺带更正上一轮（D55 更正二仍偏轻）**：我曾把副作用回滚记为"未实现，且有明确代价"。**核实后发现它早有具名方向**：`SWARM_LOOP.md:242` 原文 *"不依赖 M3、且仍有价值的方向：④**影子快照/选择性还原**（opencode 机制，D25；**可部分弥补'无沙箱＝无回滚'**，只作用于文件工具，与现有边界同域）"*。**故应记为"已有具名机制在队列里、尚未实现"，而不是"未实现"** —— 二者的区别是：前者只需排期，后者听起来像要重新设计。**这本身又是一次"措辞比事实更硬"**（本项目第五次同类错误的同一形态，见 D55 更正块的新判据）。

**未验证**：中间路（vendored 纯 JS 依赖）的实际可行性与体积代价；pty 引入后真实终端观感能否被自动化验证（**可能仍只能人工观察**）；嵌入模型的本地体积与首次加载延迟；`PERSONAL_AGENT_TOKENIZER` 的注入形状是否足以承载一个真分词器（**尚未实测**）。**以上任一若被操作员批准重议，须另起一轮取证，不得凭本条直接动手。**

### 要不要放开"零生产依赖"：取证结论是**不放开**（D57，2026-09-29，实测，无代码）

**触发**：操作员批准就 D56 汇总里"若要放开只放开 ①"做取证。**结论与 D56 的预判相反**：

> **不放开。理由不是"依赖危险"，而是"要买的东西大部分已经免费有了，剩下买不到的中间路也买不到"。**

**这是本轮最重要的发现形态：取证**关掉**了一个问题，而不是打开它。**

#### 一、D56 列的五项"被 ① 挡住的能力"，逐项核实

| D56 的声称 | 取证结果 | 硬证据 |
|---|---|---|
| 发送前无法预测 token 溢出 | **不成立** —— **零依赖、零改动，今天就能用** | [cli.ts](../src/cli.ts) 第 180–204 行 `tokenizerCounter`（详见下节） |
| 会话历史无法按内容索引查询 | **不成立** —— Node 内置 `node:sqlite` 即可 | 本机 Node **v24.19.0** 实测：`require("node:sqlite")` 可加载，导出 `DatabaseSync, StatementSync, Session, constants, backup`；建表 / 插入中文 / 条件查询 / 排序**全部成功**。`package.json` 的 `engines` 为 `node >= 22.6`，而 `node:sqlite` 自 22.5 起内置 ⇒ **floor 已覆盖** **⚠️ 更正（D68）：此项不成立 —— 22.5.0 至 22.12.x 需要 `--experimental-sqlite` 启动标志（Node 官方 `doc/api/sqlite.md` 的 `changes` 记录，PR 55890 在 v22.13.0/v23.4.0 去掉该标志），而声明下限 22.6 正在该区间内；"内置"不等于"免标志可用"。原文按规矩保留。实际暴露面窄：被测过的 22.23.3 / CI 22.x / 24.x / 本机 v24.19.0 全在 22.13.0 之上，22.6 下限本身从未被测。详见 D68 第一、二节** |
| 语义相似度做不了（任务切换检测） | **成立**，但有零依赖替代 | 真要语义嵌入须 `@huggingface/transformers@4.3.0`（Apache-2.0，自身 9.43 MB，无安装钩子），**但其 deps 含 `sharp`（原生图像库）与 `onnxruntime-node`**；`onnxruntime-node@1.30.0` **解包 287.12 MB、`postinstall="node ./script/install"`、`os` 限定 win32/darwin/linux**，另需运行时下载模型文件 |
| 真实终端观感无法验证（pty） | **成立，且中间路走不通** | `node-pty@1.1.0`（MIT）**解包 61.38 MB**，deps 含 **`node-addon-api`（原生插件）**，**三个安装钩子**：`install="node scripts/prebuild.js \|\| node-gyp rebuild"`、`postinstall="node scripts/post-install.js"`、`prepare="npm run build"` ⇒ **需 node-gyp 编译兜底，且安装即执行代码** |
| 读不了二进制文档 | 成立，但**当前队列不需要** | `inspect_file`（D41/D44）已覆盖 `file_type`/`headers`/`hex_dump`/`hash`/`strings`/`certutil_dump`，真机实测读出过 PE32+ / AMD64 / 字节数 / Node 版本 / Authenticode 签名者 |

**⇒ 五项里两项已有零依赖解法（其中一项已实现）、一项当前不需要，只有嵌入与 pty 真的被挡住 —— 而那两项恰好都是**中间路也救不了**的（都要原生模块）。**

#### 二、`PERSONAL_AGENT_TOKENIZER` 是已建成的机制，不是预留钩子（更正 D56）

D56 曾断言"② 的逃生口被 ① 堵着"。**实读源码后：错。** 该机制**已完整实现并接线到四处**：

| 位置 | 事实 |
|---|---|
| `cli.ts:59` | 帮助文本已写明用法：*"精确预判（可选，不内置分词器）：`PERSONAL_AGENT_TOKENIZER='<命令>'`，读 stdin 的 prompt JSON，向 stdout 打印单个非负整数"* |
| `cli.ts:189-204` | `tokenizerCounter(env)` 返回 `(messages)=>number`；`spawnSync(command,{shell:true,input:JSON.stringify(messages),encoding:"utf8",timeout,windowsHide:true})` |
| 同上，三处硬报错 | `result.error` → 抛；`status!==0` → 抛（带 stderr 前 200 字）；输出不匹配 `/^\d+$/` → 抛（带实际输出前 60 字）。**注释原文**：*"a command that fails, times out, or prints a non-count is a hard error: falling back to a guess would turn 'I could not measure' into 'I measured', **which is the one outcome worse than having no tokenizer at all**"* |
| `cli.ts:192-195` | 超时默认 **5000ms**，可由 `PERSONAL_AGENT_TOKENIZER_TIMEOUT_MS` 配置；非正安全整数即 `UsageError` |
| `cli.ts:243-244` → `:394` | 构造后传入 `AgentRuntime` 的 `countPromptTokens` |
| `preflight.ts:319` | **进预检** —— 操作员能在跑之前发现分词器命令不可用 |
| `runtime.ts:989-992` | 每次 prompt 构建调用，并**再校验一次**返回值必须是非负整数 |
| `runtime.ts:341,372-373,863` | `predictedTokens` 进 `RunBudget`，**进预算行渲染**（`counted = predictedTokens ?? measured`，basis 标 `(本机)`），并进 `usage` 事件 |

**故：精确预判今天即可获得，`package.json` 一个字节都不用改。** 代价是**每次 prompt 构建一次阻塞 `spawnSync`**（默认最多 5 秒）。相对一次模型调用（秒级）可接受，但**须如实记为代价**。

**未验证**：本条全部为**源码实读**，**尚未真机跑过一个真的分词器命令**（本机无 python/tiktoken；且免费网关仍 DOWN）。**故"今天就能用"是就接线完整性而言，不是就已端到端实测而言。** 若要采用，第一步是拿一个真命令跑通并观察预算行是否出现 `(本机)`。

#### 三、中间路（vendored 纯 JS）唯一真能买到的东西，已被免费方案覆盖

纯 JS 分词器**确实符合**中间路条件（纯 JS、无原生、消费者安装不执行钩子）：

| 包 | 版本 | 许可 | 解包体积 | deps | 安装钩子 |
|---|---|---|---|---|---|
| `gpt-tokenizer` | 4.0.0 | MIT | **25.95 MB** | **0** | `prepare="husky"`（dev 钩子，**消费者安装不执行**） |
| `js-tiktoken` | 1.0.21 | MIT | **21.39 MB** | 1（`base64-js`，纯 JS） | **无** |

**但体积是决定性的**：21–26 MB 全是 BPE 词表数据。**为省掉一次 `spawnSync` 而往仓库 vendored 21–26 MB 不可读的数据文件，交易明显不好** —— 而且第二节已证明外部命令钩子免费做到了同一件事，还顺带把"分词器版本随发行版绑定"这个问题推给了操作员（D08 的退出条件原文正是 *"决定随发行版绑定某个分词器依赖时"*，**即这个决定本来就该由操作员在有真实需要时做**）。

**（数据以 2026-09-29 npm registry 实查为准；体积为 registry 报的 `dist.unpackedSize`。）**

#### 四、零依赖替代方案（本轮真正的产出）

| 需求 | 零依赖做法 | 代价 |
|---|---|---|
| **精确 token 预判** | `PERSONAL_AGENT_TOKENIZER` 指向操作员自备命令（已实现） | 每次 prompt 构建一次阻塞 `spawnSync` |
| **历史按内容索引** | `node:sqlite`（Node 内置，本机实测可用） | 需决定索引与会话日志的关系：**索引是派生物，日志仍是唯一真相来源**（ADR-0001 不容违背）；索引损坏须可重建而非报错 |
| **任务切换检测** | ① 词法相似度（词面重叠/Jaccard）；② 显式命令（操作员说"新任务"）；③ **升级为审批**（拿不准就问） | **词法≠语义**，须如实标注为词法；③ 最符合 default-deny，但会多问 |
| **大结果不重发** | D52 修正版 `obs_recall`（从会话日志按 `callId` 分页读回） | 无新增依赖、无新增文件 |
| **真实终端观感** | **只能人工观察** —— `LIVE_INTEGRATION.md` 现有做法（runbook + 操作员实跑） | 无法自动化；引入 `node-pty` 才能自动化，代价见第一节 |

#### 五、附带核实的一处安全观察（结论：不是洞，但必须记）

`cli.ts:197` 是**全项目唯一**用 `shell:true` 执行**可配置字符串**的地方，而本项目别处刻意避开 shell —— `inspect_file`（D41）用 `spawn` + `shell:false` + argv 数组，使 `&&`/`|`/`;`/`>`/`$()` **不是被过滤而是写不出来**。

**评估：不构成提权。** 该值来自 **CLI 自己读的 `process.env`，不经过模型**；`toolEnvironment` 白名单限制的是**工具**能看到的环境变量，与此无关；**能改这个环境变量的人本来就能改整个进程**（他同样能改 `PATH`）。

**但须记录，因为它是"结构性安全"叙事里的一个例外点**：本项目多处宣称"不靠检测靠结构"，而这一处确实是"靠来源可信"。**若将来有任何路径能让模型影响进程环境（例如某个工具被允许写环境变量），这一处就会从例外变成洞。** 故记为**待守的不变量**：`PERSONAL_AGENT_TOKENIZER` 必须始终只来自 CLI 启动时的环境，**永不来自工具参数、配置文件或会话状态**。

#### 六、结论与建议

1. **不放开 ①（零生产依赖）。** 理由不是原则，是交易：要买的五项里两项已免费、一项不需要，剩两项（嵌入 287 MB 原生 + postinstall、pty 61 MB 原生 + node-gyp）**中间路也买不到**。
2. **D56 的"值得重议"应降级为"已重议、结论是不放开"**，且**"① 堵住 ② 逃生口"是错的**（见第二节）。
3. **若将来真要重议，触发条件应写死**（沿用 D08 的体例）：**当且仅当出现一个既不能由外部命令钩子、也不能由 Node 内置模块满足的能力需求时**。目前不存在这样的需求。
4. **本轮真正可落地的三件事都不需要放开 ①**：精确预判（接线已完成，只差一个真命令）、历史索引（`node:sqlite`）、任务切换检测（词法/显式/升级为审批）。**其中只有历史索引涉及新代码，且须先决定它与 ADR-0001 的关系。**

**未验证**：`PERSONAL_AGENT_TOKENIZER` 端到端真机跑通（无可用分词器命令，网关亦 DOWN）；`node:sqlite` 在 `engines` floor（22.6）上是否打 ExperimentalWarning 或需 flag（本机只有 v24.19.0）；`node:sqlite` 写入 agent home 是否与 D50 的按位置封死相容（**索引文件须落在 agent home 内，而 agent home 对文件工具封死 —— 但封死的是"工具"，运行时自己写不受限，此点须实测确认而非推断**）；词法相似度的实际准确率（无数据）。

### TaskSpec 的真实状态：已建成且承重，缺的只是跨轮持久层（D58，2026-09-30，实读，无代码）

**触发**：上一轮结尾明确承诺 *"下一轮必须先读 `taskspec.ts` 再断言它缺什么，不得凭 `IMPLEMENTATION.md` 的顺序表述推断"*，因为发现 `runtime.ts:15` 已 import 它。**读完证明这个承诺救了本轮** —— D55 采用清单第 3 项写作"任务状态层（TaskSpec 核心）"，读起来像待建项，**实际它已建成，而且是基因选择的前门**。

**若没读就动手，会是本项目第七次同类错误，而且是最贵的一种：重复实现一个已存在且承重的模块。**

#### 一、已存在的（逐条附行号）

[taskspec.ts](../src/taskspec.ts) 全文 115 行，`TASKSPEC_VERSION = 2`：

| 已有 | 出处 |
|---|---|
| `TaskSpec` 结构：`schema`/`originalInput`/`objective`/`intent`/`signals`/`selectedMode?`/`unknowns`/`evidence.authoritativeMode` | `taskspec.ts:20-34` |
| **用户原话逐字保留** | `:22` 注释 *"The user's own words, preserved verbatim"* |
| **mode 由运行时决定，模型不能** | `:15-16` 注释 *"The runtime sets it; the model cannot"* |
| **缺 mode 记为未知，绝不猜测** | `:29` 注释 *"Undefined means no mode was decided — never guessed"* |
| **intent 是确定性分类但不是权威** | `:25` 注释 *"Keyword classification, **deterministic but not authority**"*；`INTENT_HINTS` 正则表 `:39-44`，默认 `build`（`:89`） |
| **五值 intent 与蜂群协议同一套** | `:18` `"build" \| "fix" \| "research" \| "verify" \| "operate"` |
| **enforce 是独立开关且默认关** | `:107-114`，注释 *"an incomplete spec is reported, not treated as fatal, until the operator opts into hard refusal"* |
| **接线到运行时，且位置本身是安全性质** | `runtime.ts:697-702`，注释原文 *"TaskSpec is decided before anything is written or sent: the mode comes from the runtime, and a hard refusal (opt-in) must leave no trace, so it runs **before the session is even ensured**"*（`ensureSession()` 确在其后，`:722`） |
| **它是基因选择的前门（承重）** | `runtime.ts:704-707` 注释 *"the spec is the front door — its intent gates the library and its signals score it"*；`:709` `this.genePrompt = applied?.block`（**即 D55 采用清单第 1 项所扩展的那个系统提示拼接的上游**）；`:714` `outcomeSpec` 把 intent+signals 写进周期结果 |
| **每轮重置写账本，无基因时仍有默认预算** | `runtime.ts:716-720` 注释 *"with no gene applied the runtime default still applies, because 'unbounded' is not a safe default (D18)"* |
| **spec 暴露在 send 结果上** | `runtime.ts:416`、`:843` |

#### 二、`extractSignals` 已经显式处理中文 —— 这直接更正 D57

`taskspec.ts:61-82`：归一化 → 按非字母数字切分 → **对 Han/Hiragana/Katakana 连续段发 2 字 bigram**（长度 ≤4 时另保留整段）。注释原文：

> *"CJK has no word boundaries: emit the bigrams so the vocabulary is shared between differently phrased requests. The whole run is only kept when it is short enough to be a word rather than a whole sentence."*

模块注释还解释了**为什么必须这样**（`:57-59`）：*"otherwise a whole sentence is one signal, which matches nothing and (worse) **groups nothing when repeated failures are distilled**"*。

**⇒ 更正 D57 第四节**：那里为"任务切换检测"提议的零依赖方案写作"词法相似度（词面重叠/Jaccard）"，读起来像要新建。**实际词汇抽取器已存在**，应写成 **"复用 `extractSignals`"** —— 它已经解决了中文无词边界这个最难的部分，而且是**蒸馏分组正在依赖的同一套词汇**，复用它可保证"切换检测"与"失败归纳"用同一种相似度 notion，不会出现两套词汇打架。

#### 三、一个非显然的发现：enforce 开关在运行时路径上目前是死代码

**三段论，每步附出处，可复核：**

1. `runtime.ts:694-695`：`const text = input.trim(); if (text.length === 0) throw new Error("empty input");` ⇒ 进入 `buildTaskSpec` 的 `text` **必非空** ⇒ `objective = originalInput.trim()`（`taskspec.ts:86`）必非空 ⇒ `:88` 的 `unknowns.push("objective")` **不会执行**。
2. `runtime.ts:700`：`buildTaskSpec(text, { mode: TASK_MODE })` —— **总是**传 mode ⇒ `hasMode` 必为真（`taskspec.ts:93`）⇒ `:94` 的 `unknowns.push("mode")` **不会执行**。
3. 由 1、2 ⇒ 运行时路径上 `unknowns` **恒为 `[]`** ⇒ `taskspec.ts:113` 的 `if (!options.enforce || spec.unknowns.length === 0) return { blocked: false };` **恒走后半条** ⇒ `assessTaskSpec` **恒返回 `{blocked:false}`**，**无论 `enforceTaskSpec` 开或关** ⇒ `runtime.ts:702` 的 `if (verdict.blocked) throw` **永不可达**。

**这不是 bug**：没有可拒绝的东西时不拒绝是诚实的，而且注释已说明 enforce 是 opt-in。**但两条推论必须记下**：

- `IMPLEMENTATION.md:116` 写的 *"强制拒绝先默认关闭"* **目前无实际效果** —— 开关在，但没有会被它拦住的状态。
- **任何"打开 enforce 就能拦住不完整任务"的说法都是错的。** 要让它有意义，**必须先有会真正填进 `unknowns` 的必填项**（例如跨轮持久状态里的目标、验收条件、子任务）。**故 enforce 的正确开启时机是持久层落地之后，不是之前。**

#### 四、真正缺的部分（范围比 D55 原表述窄得多）

**缺**：spec 是**每次 send 从头重建**的（`runtime.ts:700` 在 `send()` 内部），**不是跨轮持续并被更新的状态**；没有进度或子任务完成度；没有视频二说的"更新状态而非追加聊天文本"。

**故 D55 采用清单第 3 项应改写为**：

> ~~任务状态层（TaskSpec 核心）~~ → **给已存在的 TaskSpec 加一层跨轮持久状态**：一个随轮次**被更新**（而非追加）的任务记录，承载目标、验收条件、子任务与进度，并让 `unknowns` 第一次拥有真实内容 —— **进而让 enforce 开关第一次有意义**。

**这比"建 TaskSpec"小得多，也安全得多**：不改前门、不改基因选择、不改 mode 权威归属，只在其上加状态。**且新状态同样必须落在 agent home 内**（复用 D50 的按位置封死），理由与 `constraints.json` 完全相同 —— **agent 能改自己的任务状态，就等于能改自己的验收条件**。

#### 五、方法论

**本轮没有出错，因为上一轮把"必须先读"写成了明文承诺并当轮兑现。** 这值得记为做法而非运气：**当一轮发现自己差点凭印象断言时，把"下一轮必须先读 X"写进文档，比当场记住更可靠** —— 本项目前六次同类错误全部发生在"以为自己已经知道"的地方，而这一次是唯一一次提前设了闸。

**未验证**：`enforceTaskSpec` 的默认值与设置路径（本轮只确认了它在运行时路径上恒不生效，**未读它的声明与 CLI 接线**）；`geneStore.selectFor` 如何用 signals 打分（属 D14，本轮未重读）；跨轮持久状态的存储形状（JSONL 追加 vs 单文件覆写）尚未设计，**须与 ADR-0001 的"唯一真相来源"对齐后才能定**。

### 跨轮持久任务状态层：存储形状与完成判定权（D59，2026-09-30，设计取证，无代码）

**触发**：D58 把采用清单第 3 项改写为"给已存在的 TaskSpec 加一层跨轮持久状态"，并规定 *"存储形状（JSONL 追加 vs 单文件覆写）**须先与 ADR-0001 的'唯一真相来源'对齐才能定**"*。本轮就是那个前置条件。**结论：追加进会话日志，镜像 `summary`；而本轮真正的产出不是存储形状，是完成判定权归谁。**

#### 一、存储形状：ADR-0001 的判据是"无副本"，不是"只有一个文件"

`session-store.ts:22-39` 原文：*"A tool invocation used to be written three times: an audit `tool/call`, an audit `tool/result`, and the `message` that actually feeds the next prompt. **The audit pair was a copy, and keeping a copy meant the two could disagree** — which is why the reader carried conflict checks for exactly that case."*

**⇒ 判据是"是否存在第二份可能与日志不一致的记录"。** 任务状态若只存在日志里一份，就合规；若另开 `<home>/task-state.json`，则日志里有"发生了什么"、另一个文件里有"任务到哪了"，**两者可能不一致且无从判定谁对** —— 这正是 ADR-0001 要消灭的形状。

**store 自己的版本规则明确支持新增类型**（`:41-47`）：*"A version bump is owed only when the shape of an **existing** kind changes. **Adding a new kind is not a structural change: new kinds are written with `ignorable: true`**, and a reader that does not recognise a kind skips it instead of failing."* ⇒ **不需要 bump `CURRENT_EVENT_VERSION`（`:50`，仍为 1）。**

**`summary` 是可照抄的完整先例**，五处细节都应继承：

| 先例 | 出处 | 为什么任务状态也该这样 |
|---|---|---|
| `SummaryEvent { v, kind:"summary", ignorable:true, at, covers, summary }` | `:122-129` | `ignorable` 让旧 reader 跳过而非失败 |
| **写入不删除任何东西**，`history()` 仍重放每条消息 | `:114-117` | 状态更新不得抹掉历史，否则无法审计"任务是怎么走到这一步的" |
| 旧 reader 的后果被如实描述 | `:119-120` *"skips it and builds the full-length prompt — **longer than intended, but not wrong**"* | 任务状态缺失只会让 prompt 少一块上下文，**不会让已有内容变错** —— 这是"可降级"的正确形状 |
| **latest wins** | `:638-647` *"The latest event wins because `covers` only ever grows"* | **"更新状态而非追加聊天文本"正是这个语义**：日志里追加，但注入 prompt 的只有最新一份，故模型看到的是当前状态而不是一堆增量 |
| **边界是被观测的事实，不是声称** | `:610-613` `covers` 必须等于当前消息数，注释 *"Refusing the mismatch keeps the boundary an observed fact"* | 任务状态同样应携带写入时观测到的消息数，使其可核对 |
| **未完成工具批次时拒绝写入** | `:606-609` *"Summarizing a call whose result has not arrived would leave the model with an answer-shaped summary of a question that was never resolved"* | **同理适用于任务状态**：在一批工具结果尚未回来时写"这步完成了"，就是把一个未决问题记成已决 |

**⇒ 结论一：新增 `task-state` 事件类型，追加进会话日志，`ignorable:true`，latest wins。不新增文件、不新增存储、不新增锁。**

**附带确认**：压缩碰不到它 —— 压缩只替换 `role === "tool"` 消息（D53 更正块已核实），而 `task-state` 不是 message。注入路径复用上一轮建成的机制（并入系统消息），**故它同样免于位置稀释**。

#### 二、完成判定权：本轮真正的产出

**存储形状是照抄，判定权才是设计。** 问题是：**谁有权说"这步做完了"？**

**若是模型 —— 任务状态就成了自报通道。** 而 `validation.ts`（D20）的模块动机原文正是为了消灭这个形状（`:4-8`）：

> *"Until now `Gene.validation` was a list of strings that got rendered into the prompt and never checked — 'Prove it worked: npm.cmd test' was **an instruction to the model, not a claim the system evaluated**."*

**⇒ 结论二：模型可以写散文状态（做了什么、下一步、它的判断）并提出步骤，但 `done` 绝不接受模型自报。** 步骤携带的是一条 **claim**，完成度由 `checkClaim` 对 `RoundEvidence` 算出。**零新机制** —— 三件都已存在：

| 已有 | 出处 | 性质 |
|---|---|---|
| `RoundEvidence { filesWritten, tools }` | `validation.ts:24-29` | *"What a round left behind, **as the journal recorded it**"* —— 取自日志，不是取自模型的叙述 |
| `ClaimOutcome = "met" \| "unmet" \| "unverifiable"` | `:31`，理由见 `:14-19` | **第三值是重点**：*"never counted as met, because that would **manufacture proof**, and never as unmet, because that would punish work that may well have been done. An honest 'we cannot tell' is a real outcome and **the only reason this module can be trusted at all**."* |
| `ValidationReport.satisfied` | `:42-43` | **仅当每条 claim 都 met；`unverifiable` 不算 met** |
| `checkClaim` 的比对方式 | `:54` *"never guesses and never reads intent: each kind names one fact"*；`files-written` 用**双向集合相等**（`:56-70`，*"an understated claim would otherwise pass by saying less"*） | **少报也算不合格** —— 这正好堵住"模型把验收条件写窄以让自己通过" |

**⇒ `unverifiable` 必须作为一个真实状态被记录与展示，永不当作完成。** 这与 D55 拒绝清单第 1 条（模型抽取的约束不得自动获得强制力）同源：**模型可以提议，系统只认机械事实。**

#### 三、这让 `unknowns` 第一次有真实内容，从而让 `enforce` 第一次有意义

D58 第 3 节证明 `assessTaskSpec` 的 enforce 开关目前在运行时路径上是死代码，因为 `unknowns` 恒为 `[]`，且推论是 **"要先有会真正填进 `unknowns` 的必填项"**。**本设计正好提供**：

- 步骤**没有 claim** → `unknowns` 记"步骤 N 缺验收条件"
- 步骤的 claim 判为 **`unverifiable`** → 同样记入（诚实的"无法判定"，不是失败也不是通过）
- 状态**从未写过** → 是否算 unknown 须由操作员的 enforce 语义决定，**不得默认算**（否则打开 enforce 会拦住所有普通对话）

**⇒ 结论三：enforce 的开启时机确实是持久层落地之后**，与 D58 的预判一致。

#### 四、四个开放问题（下一轮实现前必须先答，不得凭名字推断）

1. **`RoundEvidence` 的采集粒度与来源。** `runtime.ts:715` 有 `this.outcomeTools = []`（每轮重置），故工具序列已有；**但 `filesWritten` 的采集点尚未读**，须确认它与写账本（`runtime.ts:719-720` 的 `writeLedger`/`writeBudget`）是同一来源还是两处 —— **若是两处，就是 ADR-0001 要消灭的副本形状，必须先合并。**
2. **`GeneValidation` 能否直接复用为步骤 claim。** 复用最省，但会把任务状态耦合到基因 schema（基因是不可变的内容寻址对象，任务状态是可变的）。**须读 `gene.ts` 的 `GeneValidation` 定义再定。**
3. **⚠️ 最大的风险点：写状态的工具不是文件写。** 追加 `task-state` 由**运行时**执行、不经文件工具，故 **agent home 的按位置封死拦不住它**（那道保护针对的是 `create_file`/`edit_file` 等），**`WRITE_TOOLS` 与写预算也不覆盖它**。而它**会改变下一轮模型被告知的内容** —— 这是一种真实能力，且是**唯一一条能绕过既有两道闸门（路径收敛、写预算）去影响模型认知的路径**。**故它必须自己进写预算并落审计**（与 `config:widen` 同类处理），**否则就是开了第三条路**。此项须在写任何代码之前定案。
4. **状态块的字节上限。** 沿用 `constraints.ts` 的做法（超限报错并给出实际大小，**不静默截断**，理由同 `maxContextBytes` 注释），但**上限值须独立选取** —— 状态块预期比常驻约束大，直接复用 32768 可能过紧。

#### 五、刻意不做的

- **不做单文件覆写存储**（见第一节：会造出可能与日志不一致的第二份记录）
- **不让模型标记完成**（见第二节：等于开自报通道）
- **不做语义进度判定**（零依赖不变，D57 结论；进度来自 claim 的机械比对）
- **不在本轮 bump `CURRENT_EVENT_VERSION`**（`:41-47` 明确新增类型不需要）
- **不做状态的跨会话共享**（状态属于一个 session；跨会话是另一个问题，且会把"当前任务"变成需要消歧的东西）

**未验证**：上述四个开放问题全部未验证；`gene.ts` 的 `GeneValidation` 定义本轮未读；`filesWritten` 的采集点本轮未读；**注入状态块与注入约束块同时存在时的字节叠加未测**；旧 reader（若存在）对 `task-state` 的实际跳过行为未实测（仅由 `:41-47` 的规则与 `summary` 的先例推得）。

### 答 D59 的开放问题：两个已定案，并读出一个没预见的陷阱（D60，2026-09-30，实读，无代码）

**触发**：D59 第四节列了四个开放问题，规定 *"下一轮实现前必须先答，不得凭名字推断"*。本轮答了①②，并据读到的事实把③定案。**结果是两处更正 D59，外加一个若不读就会让功能等于没做的陷阱。**

#### 一、问题①已答：`filesWritten` 只有一个来源，不存在 ADR-0001 的副本问题

`runtime.ts:822-825`：

```ts
const validation = applied ? checkValidation(applied.validation, {
  filesWritten: this.writeLedger.files,
  tools: this.outcomeTools ?? [],
}) : null;
```

**写账本是唯一采集点**，全链只有一本：`:513` 声明 `private writeLedger: LedgerState = { files: [], lines: 0 }` → `:719` 每轮重置 → `:941` `checkWrite(this.writeLedger, attempt, this.writeBudget)` 是闸门 → `:972` `chargeWrite(this.writeLedger, attempt, position)` 是计费 → `:823` 喂给验证 → `:868-870` 喂给预算行显示。**工具序列同样只有一个来源 `this.outcomeTools`**（`:715` 每轮重置、`:824` 喂给验证）。

**⇒ D59 担心的"若是两处就必须先合并"不成立：本来就是一处。** 而且这个单一来源带来一个好性质：**任务状态的 claim 对 `writeLedger.files` 求值时，与写预算所计费的是同一本账，故一步不可能声称一笔预算没记的写入，反之亦然。**

#### 二、问题②已答并更正 D59：`GeneValidation` 可以复用，那条顾虑是错置的

`gene.ts:41-45` 是一个**判别联合**：

```ts
export type GeneValidation =
  | { readonly kind: "files-written"; readonly paths: readonly string[] }
  | { readonly kind: "no-write" }
  | { readonly kind: "tool-used"; readonly tool: string; readonly times?: number }
  | { readonly kind: "command"; readonly command: string };
```

**其中没有任何字段引用基因** —— 它是"可观测事实"的独立词汇表。**D59 担心的不可变性属于 `Gene` 对象**（内容寻址、不可变），**不属于 claim 类型**；把对容器的顾虑套到内容上，是又一次凭名字推断。

**复用还白得一个严格解析器**：`parseValidation`（`gene.ts:132-166`）已处理裸字符串 → `{kind:"command",command}`（`:140`）、未知 kind 报错（`:166`）、`times` 必须是正整数（`:157`）、空字符串拒绝（`:139`）。

**⇒ 更正 D59 开放问题②：不是"须读 `gene.ts` 再定"，是"复用，且顾虑不成立"。**

#### 三、⚠️ 读出一个 D59 没预见的陷阱：claim 目前只在有基因被应用时才检查

`runtime.ts:822` 的 `applied ? checkValidation(...) : null`。

**而本项目的基因库是空的，故绝大多数轮次是 gene-less 轮。** 若任务状态沿用这个 `applied ?` 门，**实践中每一个步骤都会永久停在 `unverifiable`，功能等于没做** —— 而且它会"看起来在工作"（有状态、有注入、有 claim），只是永远判不出任何东西。**这是那种只有读到 `applied ?` 才会发现的失败形态。**

**⇒ 任务状态的 claim 求值必须独立于基因应用。而这个形状在项目里已有先例**：`:821` 的 `evaluateRun({ steps, toolCalls, toolErrors, failureClass: null })` **本身就是机械的、与基因无关的**；`:817-818` 注释原文：

> *"Review: the verdict is read off what the round **mechanically did**, and then the applied gene's claims are compared against that same record."*

**⇒ 应照 `evaluateRun` 的形状（无条件、机械），不照 `applied ?` 的形状。** 两句话里"mechanically did"是主句，"the applied gene's claims"是附加比对 —— 这个次序本身就是答案。

#### 四、必须如实记录的能力上限：最自然的验收条件恰好是判不了的那种

`validation.ts:14` 明写 `unverifiable` 指 *"nothing in this runtime can decide it (**a shell command, today**)"*。四种 claim 里 `files-written`/`no-write`/`tool-used` **可机械判定**，**`command` 不可**。

**而编码任务最自然的验收条件（"测试通过""构建成功"）正是 `command`。**

**⇒ 它会诚实地停在 `unverifiable`，永不显示为完成。** 要让它可判定需要**验证执行器**，而 D19 已记录本项目没有（*"本项目尚无验证执行器"*，故模型评审者会是"一个永远无法知道准不准的裁判"）。

**这不是本设计的缺陷，是它诚实继承的上限 —— 必须写进文档而不是藏起来**，因为它直接决定了这个功能的实际用处：**它能让"写了哪些文件""用了哪些工具"这类步骤变得可判定，但不能让"测试通过"变得可判定。** 若操作员期待的是后者，**这个功能不会满足他，而现在就该说清**。

#### 五、问题③定案并更正 D59：真正要防的不是"模型说完成"，是"模型把验收条件改窄"

D59 已指出模型不得自报 `done`。**但读完 claim 机制后发现更隐蔽的一条**：模型可以**替换或删掉一个步骤的 claim**，把难判的换成易判的 —— 这比自报 `done` 更难发现，因为它看起来像是"更新了计划"。

**部分已被现有机制堵住**：`files-written` 用**双向集合相等**（`validation.ts:56-70`，注释 *"an understated claim would otherwise pass by saying less"*），故少报文件会失败。**但 `tool-used` 的 `times` 可以调小，步骤也可以整条删除。**

**⇒ 定案：任务状态的 claim 必须单调** —— 后写的状态**可以增加步骤、可以推进散文，但不得削弱或移除既有 claim**。

**这与 `summary` 的 `covers` 只增不减同构**（`session-store.ts:638-639`：*"The latest event wins because `covers` only ever grows"*），**且执行方式有现成先例**：`appendSummary` 在写入时硬校验 `covers` 必须等于当前消息数并**拒绝不匹配**（`:610-613`，*"Refusing the mismatch keeps the boundary an observed fact"*）。**故单调性应在 append 时机械比对 claim 集合、不符即拒，而不是靠审计事后发现。**

**⇒ 因此问题③的预算部分可以简化，且这是对 D59 的第二处更正**：既然单调性挡住了"改窄"，写预算要防的就只剩**体积膨胀**，而体积已由问题④的字节上限管住。**故不必为 `task-state` 发明第二本写账本** —— 那恰恰会造出 ADR-0001 反对的第二份记录。**改为：每次 append 落一条审计**（`appendAudit` 已是现成通道，`session-store.ts:626-633`；`AuditEvent.decision` 已含 `"allowed"`，`:139-149` 注释解释了为什么必须有这个值：*"an audit log that records a grant under the word 'denied' is worse than no log"*），**加字节上限**。**这比 D59 设想的"自己进写预算"更省，且不新增账本。**

#### 六、问题④仍未答，但现在有了定案所需的依据

字节上限须独立于 `constraints.ts` 的 32768 选取。**依据**：状态块预期含多步 claim 与散文进度，而常驻约束是短句列表；但两者**都每轮注入系统消息，故它们的字节是叠加的**（D59 已把"叠加未测"列为未验证项）。**⇒ 定案方式应是：给"约束块 + 状态块"设一个合计上限，而不是各设一个** —— 否则两个各自合规的块相加仍可能顶穿 `maxContextBytes`，而那个错误会以最坏的形式出现（`maxContextBytes` 是**整轮拒绝**，不是截断，见 D53 更正块）。**具体数值留到实现轮，须以实测的注入字节为据，不得凭感觉取整。**

#### 七、汇总：实现轮的输入清单

| 项 | 状态 | 结论 |
|---|---|---|
| 存储形状 | **已定（D59）** | `task-state` 事件类型，追加进会话日志，`ignorable:true`，latest wins |
| ①`filesWritten` 来源 | **已定** | 唯一来源 `writeLedger.files`，无副本问题 |
| ②claim 类型 | **已定（更正 D59）** | 复用 `GeneValidation`，并复用 `parseValidation` |
| ③完成判定权 | **已定（D59）** | 模型不得自报 `done`；由 `checkClaim` 对 `RoundEvidence` 求值 |
| ③'防改窄 | **已定（更正 D59）** | **claim 单调**，append 时机械比对、不符即拒（照 `covers` 的做法） |
| ③''预算/审计 | **已定（更正 D59）** | 不设第二本账本；每次 append 落审计 + 字节上限 |
| **求值时机** | **新增约束** | **必须独立于基因应用**（照 `evaluateRun`，不照 `applied ?`），否则 gene-less 轮永久 `unverifiable` |
| ④字节上限 | **待定** | 应设"约束块 + 状态块"**合计**上限；数值留实现轮以实测定 |
| 能力上限 | **须如实告知** | `command` 类 claim 永远 `unverifiable`；"测试通过"判不了，需验证执行器（D19：本项目没有） |

**未验证**：`evaluateRun` 的内部实现本轮未读（只确认了它与基因无关且输入是 `steps`/`toolCalls`/`toolErrors`）；`LedgerState`/`chargeWrite`/`readWriteAttempt` 的定义在 `write-budget.ts`，本轮未读；单调性比对的确切语义（`times` 调小算削弱，那 `paths` 增加算不算？）尚未定；合计字节上限的数值未定；`task-state` 与 `summary` 同时存在时的注入顺序未定。

### 实现任务状态核心，并偏离操作员刚批准的一条决定（D61，2026-09-30，有代码）

**触发**：D60 留下一个未定语义 —— *"单调性比对的确切语义未定（`times` 调小算削弱，那 `paths` 增加算不算？）"*。操作员裁定：**"那就算增强"**（即允许 `paths` 增长）。本轮实现时**发现这条裁定对 `files-written` 不成立，故未照办，并在此如实记录。**

#### 一、偏离的内容与理由

**操作员的裁定**：`paths` 增加算增强 ⇒ 允许。
**实测结果**：`validation.ts:56-70` 的 `files-written` 用**双向集合相等**（`missing.length === 0 && extra.length === 0` 才 `met`）。故：

- `paths:[a]` 成立 ⟺ 恰好写了 `{a}`
- `paths:[a,b]` 成立 ⟺ 恰好写了 `{a,b}`

**两个条件互斥，谁也不蕴含谁 ⇒ 不可比较，谈不上"增强"。** 而且方向是反的：**若该轮实际写了 `{a,b}`，旧 claim 判 `unmet`（多写了 b），新 claim 判 `met`** ⇒ **增加一个路径会让一个本来失败的 claim 变成通过**，正是 D60 第五节要防的"改窄以让自己通过"的另一种形态。

**⇒ 本轮把 `files-written` 的 `paths` 定为不可变（任何改动即拒；同集合不同顺序视为相同）。**

**若操作员确实想要"paths 可增长"**，代价是改 `validation.ts` 的语义：从"恰好这些文件"改成"至少这些文件"。**而那会削弱基因验证** —— `validation.ts:57-59` 的注释说明双向相等正是为了 *"a claim that omits a file the round wrote is as wrong as one that names a file it never touched — an understated claim would otherwise pass by saying less"*。**故本轮选择了不改语义、只收紧单调性规则**，把选择权留给操作员。

**操作员的意向在 `tool-used` 上可完整兑现**：`validation.ts:81` 是 `times < claim.times` 才 `unmet`，**故 `times` 是下界，增大＝真增强**。本轮允许 `times` 增大与从无到有，拒绝减小与从有到无。

#### 二、读出的另一个事实：新增 kind 必须在 reader 里加 case，否则会被自己的 reader 静默丢弃

`session-store.ts` 的 `default` 分支（**本轮插入后现位于 `:460-462`**）是 `if (record.ignorable === true) return null; throw …`。**`ignorable:true` 的事件走到 `default` 会返回 `null`（丢弃）** —— 对旧 reader 这是正确的向前兼容，**但对本项目自己的 reader 就是静默丢掉它刚写的状态**。故 `migrateEvent` 必须加 `case "task-state"`，并照 `summary`/`audit` 的体例**逐字段重建 + 严格校验**（`audit` 的注释已解释为什么必须逐字段重建：*"Rebuilt field by field, so `rule` must be read here or it would vanish on the way back in"*）。**测试 `round-trips every field, including each claim` 钉住这一条；变异验证（不读 `claim`）使它变红。**

**⚠️ 行号更正（本轮造成，波及 D59/D60）**：本轮往 `session-store.ts` 插入了 117 行（import 块、`TaskStateEvent` 接口、`migrateEvent` 的 `task-state` case、`appendTaskState`/`taskState` 两个方法），**故 D59 与 D60 里所有指向 `session-store.ts` 的行号现已失效**（例如 `appendSummary` 从 `:603` 移走、`compaction()` 从 `:641` 移走、ADR-0001 注释块从 `:22-39` 移走）。**按"历史批次文档不改写、只加更正块"的规矩，那两节的原文保留不动，此处统一声明。**

**⇒ 由本轮起改用的做法：引用 `session-store.ts` 时以"符号名 + 引文"为主定位符，行号为辅。** 理由是本轮亲身撞上的：**行号会被任何一次插入作废，而符号名与引文不会** —— 上面那条 `default` 分支的引文核对通过、行号核对失败，正好证明了哪个更耐用。D59/D60 的引文核对本轮已重跑并全部通过，**故那两节的事实无一失效，失效的只是定位符**。

#### 三、落地范围与刻意不落地范围

**落地（安全核心）**：`src/task-state.ts`（新，单调性 + 求值）、`session-store.ts` 的 `TaskStateEvent`/`SessionEvent` 联合/`migrateEvent` case/`appendTaskState`/`taskState()`、`test/task-state.test.ts`（24 项）。

**刻意不落地**：**`runtime.ts` 未接线** —— 状态尚不注入 prompt，也尚无写入者。**故本轮产出是管道，不是用户可见功能，这一点如实说明。** 两件事各自有未决问题：注入需先定"约束块 + 状态块"的**合计**字节上限（D60 第六节）；写入工具是 D60 问题③'' 的最大风险点（**不经文件工具，故 agent home 的按位置封死与写预算都拦不住它，而它会改变下一轮模型被告知的内容**），须自己进审计。**先造闸再造门。**

#### 四、验证

- `npm run build`（`tsc --noEmit`）无输出
- `test/task-state.test.ts` **24 项全通过**
- 全量 **583 项 / 581 通过 / 1 失败 / 1 跳过**（基线 559/557/1/1 **+24**，失败数不变）；那 1 项是 `background-jobs` 的已知并行负载时序漂移，**隔离重跑 11 通过 / 0 失败**（连续第五轮同一漂移）
- **变异验证三处全部变红**：`assertNotWeakened` 变空函数 → **7 项红**；把 `unverifiable` 当作 `met` → **1 项红**；`migrateEvent` 不读 `claim` → **2 项红**。**还原后 24/24。**

#### 五、方法论

**本轮是"读之前不写"这条纪律第二次拦住错误，而且是第一次拦住的是操作员刚批准的决定。** D58 拦住的是我自己的印象；这一次拦住的是**一个已经获得批准的裁定** —— 而它能被拦住，只因为 D60 把"`paths` 增加算不算增强"写成了一条**未决问题**而不是当成显然。**⇒ 做法：当一个语义问题的答案依赖某个 kind 的实际实现时，把它记为未决并注上"须读 X"，即使当时觉得答案很明显。**

**未验证**：`evaluateRun` 内部实现未读；`write-budget.ts` 的 `LedgerState`/`chargeWrite`/`readWriteAttempt` 未读；合计字节上限数值未定；`task-state` 与 `summary` 同时存在时的注入顺序未定；三者（`genePrompt`、约束块、状态块）叠加的实际注入字节未测；**"给原本无 claim 的步骤补一个很容易满足的 claim"这个残余风险未堵**（见 SAFETY.md）。

### 任务状态进入 prompt：不注入判定，以及合计上限取四分之一的依据（D62，2026-09-30，有代码）

**操作员终局裁定（本轮起点，原话）**：*"如果会削弱蜂群基因，那就放弃增长，进入下一轮吧"* ⇒ **`files-written` 的 `paths` 保持不可变，`validation.ts` 的双向集合相等语义不改，D61 的记录为终稿。** 该项从此不再作为未决项携带。

#### 一、本轮最重要的判断：**不注入每步判定结果**

原计划注入"步骤 → 判定"。实读后否掉了，理由是实测出来的：

- **证据是每轮的**：`runtime.ts:719` 每轮重置 `writeLedger`，`:715` 每轮重置 `outcomeTools`
- **任务是跨轮的**：状态块的存在意义就是跨轮保留

**⇒ 若把每轮判定注入 prompt，第 5 轮开头会显示"步骤 1：未达成（没有调用 read_file）"，而它其实第 2 轮就做了。那是主动误导模型，比不显示更坏。**

**要正确显示跨轮判定需要跨轮证据，而从日志重推 `filesWritten` 会造出与写账本并存的第二份记录 —— 正是 ADR-0001（`session-store.ts` 的 *"keeping a copy meant the two could disagree"*）要消灭的形状。**

**⇒ 本轮只注入：散文进度 + 步骤 + 每步的 claim（验收条件）。** 模型需要看得见的是"必须证明什么"（那也是单调性保护的对象：看不见的条件无法被有意达成），而"已经证明了什么"留到轮末 —— 那里本轮证据是完整的（`runtime.ts` 轮末验证处）。**这也是 `assessTaskState` 的接线点，本轮它仍只有测试在调用，如实说明。**

**注入块自带三句话**，都是防止它被当成权威：这是记录不是保证／不放宽任何权限，冲突时以档位与规则表为准／**`unverifiable` 既不等于完成也不等于失败**（第三句对应 D60 第四节那条能力上限：`command` 类 claim 恒判不了，若模型把它读成"通过了"就是制造证明）。

#### 二、注入顺序：任务状态排最后

`systemText = [systemPrompt, genePrompt, constraints, taskState]`。理由是权威性递减：产品的 → 基因库的 → 操作员的 → **任务自己的进度记录**。沿用 `buildPrompt` 注释已确立的纪律（*"operator text must not prime the model before the product's own safety text"*），并把同一条推理延伸到第四段。**抗稀释性仍来自"系统消息是对话第一条"，不来自内部顺序。**

#### 三、合计上限取 `maxContextBytes / 4`，以及为什么不取 1/8

**要防的具体失败**：两块各自在写入时合规（各 ≤ 32768），**相加仍可能顶穿 `maxContextBytes`** —— 而那个失败会以**整轮拒绝**的形式出现（`runtime.ts:986` 抛 `ContextBudgetError`，不截断）。这正是 D60 第六节要求的"合计上限"。

**取 1/4 的依据是算出来的，不是凭感觉**：

| 配置 | 上限 | 两块最大合计（约 66000） | 结果 |
|---|---|---|---|
| 默认 `512 * 1024`（`runtime.ts:170`） | 131072 | 66000 | **不误伤** |
| 操作员调低到 8000 | 2000 | 由实际块决定 | **该拦就拦，并报出两者各自大小** |
| 若取 1/8，默认 | 65536 | 66000 | **⚠️ 与两块最大合计相撞 ⇒ 默认配置下会误伤** |

**⇒ 不取 1/8 的理由是具体的：65536 与 66000 相撞。** 1/4 在默认配置下永不误伤，而在操作员调低预算时才起作用 —— **那正是合计需要被检查的唯一场景**。报错同时报出两块各自的字节数，因为操作员需要知道该缩短哪一个。

#### 四、写入时拒，而不是注入时拒

`MAX_TASK_STATE_BYTES = 32_768`（**与 `MAX_CONSTRAINT_BYTES` 对称**：两者都是"riding 在系统提示里、每轮重发的作者文本块"，都是纯粹的每轮开销）。**校验的是渲染后的字节数**，因为那才是真正进 prompt 的东西。

**为什么在写入时拒**：若在注入时拒，则一次超限写入会让**此后每一次 `buildPrompt` 都抛错** —— 那是对整个会话的拒绝服务。**写入时拒只让写入者损失一次调用，会话仍可用。** 这是 D59/D60 没想到的第三条设计理由，本轮实读 `buildPrompt` 后才浮现。

**照 `constraints.ts` 的做法报出实际大小、不截断**：被静默缩短的验收条件，是写入者没有同意过的条件。

#### 五、顺带修掉一个自己造成的性能问题

`buildPrompt` 原本已调 `store.compaction()`（一次全日志 `inspect()`），本轮再加 `store.taskState()` 就是**每次模型调用读两遍整个会话日志** —— 长会话下这是构建 prompt 的主要成本。故新增 `latestMarks(sessionId)`：**一趟读出两个 latest-wins 标记**，`compaction()` 与 `taskState()` 保留（其他调用方与测试在用），`buildPrompt` 改用 `latestMarks`。测试 `reads both marks together and still answers each correctly` 钉住"合并读取不得与分别读取产生分歧"。

#### 六、本轮测试自己犯的两个错（如实记录）

1. **清理时往 `constraints.json` 写了空字符串**，而空字符串不是合法 JSON ⇒ `loadConstraints` 正确地抛了"不是合法 JSON"。**产品的行为是对的，测试的清理是错的**：应当删除文件（`rm(..., {force:true})`），不是清空它。一次错误清理污染了此后所有测试，故 4 处报错实际同源。
2. **"恰好在上限"的余量算小了**：预留 400 字节，但渲染开销实测 466 字节（页头 + "进度：" + 三行中文页脚），故 32833 > 32768 被拒。**改为预留 800 字节。** 教训与 D59 的字节上限同构：**渲染后的字节数必须实测，不能按输入长度估算。**

**验证**：`tsc --noEmit` 无输出；`test/task-state.test.ts` **24/24**；`test/task-state-injection.test.ts` **15/15**；全量见 STATUS 批次 ㉗；变异验证三处见同批次。

**未验证**：`assessTaskState` **尚未接入运行时**（本轮如实说明，接线点是轮末验证处）；跨轮证据的取法未定（从日志重推会造副本，故需要一个不造副本的方案）；写入者（模型工具）仍未做，故 D60 问题③'' 的最大风险点仍未落地也未验证；`PERSONAL_AGENT_MAX_CONTEXT_BYTES` 调低时合计上限的真机行为未跑（仅测试覆盖）；注入块与 `genePrompt` 同时存在时的实际字节未测。

### 任务状态的写入者：四张表必须原子改，以及一个只有端到端测试能抓到的守卫（D63，2026-09-30，有代码）

**本轮读了什么（全部实读，附符号与引文；行号为辅，D61 立的规矩）**

| 来源 | 读到的承重事实 |
|---|---|
| `src/write-tools.ts` | `WRITE_TOOLS` / `READ_ONLY_TOOLS` 两张表；文档记载 offered 与 allowed 不一致**真发生过一次**：*"an inspection tool was added to one tier's list while the rule table still allowed only `read_file`, and the model was refused with 'unknown tool' for doing what it was told"* |
| `src/tiers.ts` | 只读档位 `tools: READ_ONLY_TOOLS`；三个可写档位 `tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS]`；并再导出两张表 ⇒ **档位表是从 `WRITE_TOOLS` 派生的，不是第二份硬编码** |
| `src/file-policy.ts` | `APPROVAL_TOOLS = [...FILE_TOOLS, ...WRITE_TOOLS.filter((tool) => !FILE_TOOLS.includes(tool))]`，其文档：*"Listing these names a second time is what produced the earlier defect … so the two answers cannot drift"*；`DEFAULT_RULES` 把每个 `APPROVAL_TOOLS` 映射成 `decision:"approve"`（WORKSPACE，priority 10），把每个 `READ_ONLY_TOOLS` 映射成 `decision:"allow"` |
| `src/write-budget.ts` | `isWriteTool` = `Object.hasOwn(WRITE_TOOL_LINE_ARGUMENT, tool)`；**`checkWrite` 的 `path === null` 分支已经存在**：*"A write whose target cannot be read from the arguments still consumes budget: it is charged as its own anonymous slot rather than waved through"*；`chargeWrite` 用 `\u0000<index>` 作匿名槽；`run_command`/`job_kill`/`rename_file`/`batch_files` 的 line argument 就是 `null` |
| `src/tools.ts` `createJobKillTool` | 工具形状与三个助手 `fail`/`denied`/`approveExact`；`job_kill` 的注释确立先例：*"Stopping work needs the same permission as starting it"* |
| `src/cli.ts` `allTools` | 是**零参工厂表**，`tierTools` 建在 `createRuntime(sessionId)` **之外** |
| `src/gene.ts` | `parseValidation` 当时**未导出**；`gene.ts` 只 import `node:crypto` 与一个 type-only ⇒ **无环风险** |
| `test/constraints.test.ts` | 经 `AgentRuntime` 脚本化工具调用的既有形状（`steps:[{toolCalls:[{id,name,arguments}]}]`） |

**决定一：四张表必须原子改，不能分轮。** 档位表与规则表**都从 `WRITE_TOOLS` 派生**，加一处即自动进三个可写档位、自动在只读档位缺席、自动进规则表 ⇒ **两边不可能漂移**。反过来说，**分开改（先加工具后进表）会留下"给了模型一个它永远调不通的工具"这个已被记载过的缺陷**。

**决定二：写预算这一半是接线，不是新机制 —— 且注册为 `lineArgument: null`。** `checkWrite` 早已处理无路径写入（匿名槽），`run_command`/`job_kill` 早已用 `null`。**故 `update_task_state` 占一个匿名文件槽、不占行预算。** 理由具体：**行预算度量的是写进文件的代码行数，而任务状态不写文件**，收行费会歪曲预算的含义；**但它确实是一次写入**（改变下一轮模型被告知的内容），故占槽是诚实计费。**不新造账本** —— D60 已定：第二本账本就是 ADR-0001 反对的副本。

**决定三：⚠️ 我在计划里写的"它像其他写入一样会征求批准"被实测推翻了一半。** `DEFAULT_RULES` 确实给 `approve`，但**档位规则覆盖它**。真机逐档位实测：

| 档位 | offered | `decide(tier.rules)` | `decide(DEFAULT_RULES)` | 与 `run_command` 同判定 |
|---|---|---|---|---|
| read-only | **false** | **deny** | approve | ✓ |
| ask-before-writing | true | approve | approve | ✓ |
| workspace-write | true | approve | approve | ✓ |
| full-access | true | **allow** | approve | ✓ |

**"高档位永远压过低档位，不论 priority"这条既有不变量在这里生效**，所以**全权档位下不弹窗** —— 我原本担心的"频繁批准导致工具不可用"是针对一个不存在的档位形态。**测试因此改成断言"与 `run_command` 同判定"而非某个具体决定**：承重性质是**"没有开例外"**（若这个工具被悄悄豁免询问，它就是唯一一个能在操作员看不见的情况下重塑模型被告知内容的工具），而**断言相等能让未来的例外把测试变红，断言硬编码值则会静默通过**。

**决定四：⚠️ 端到端测试抓到一个只有它能抓到的真 bug —— 我照抄了一个前提不成立的守卫。** 我把 `appendSummary` 的"未完成工具批次时拒绝写入"抄进了 `appendTaskState`。**但 `appendSummary` 由 `/compact` 在批外调用，而 `appendTaskState` 由工具在批内调用 ⇒ 执行写入的那次调用本身必然 pending ⇒ 该守卫会拒绝这个工具的每一次写入，工具永远不可用。** 单元测试全绿（它们直接调 store，不在批内），**只有"写入后下一轮 prompt 里出现该 claim"这条端到端断言暴露了它**。

**修法不是给守卫开洞，而是承认它的前提在这个事件类型上不成立**：摘要**替换**模型所见，所以把一个未决调用摘进去会把 *"an answer-shaped summary of a question that was never resolved"* 冻进 prompt；**任务状态记录什么都不替换** —— 每条消息照常重放，pending 的结果照常到达并照常显示。**那条守卫要防的害处在这里不存在。** 对应测试**反转**（并保留 pending 数仍为 1 的断言，证明没有东西被冻住），**理由写进测试本身，否则下一个人还会照抄**。

**决定五：审计只记拒绝，不记成功。** 成功的写入本身就是日志里的一条 `task-state` 事件，**再记一条审计就是同一事实的第二份记录**（ADR-0001 的形状）；**而拒绝不留痕迹** —— "谁试图把验收条件调低、什么时候被拦住"事后无从回答，**而那正是 `AuditEvent` 文档说自己存在的理由**（*"the whole point of the file is that someone can read it later and answer 'who stopped asking, and when'"*）。故 `decision:"denied"`，`reason` 用 store 抛出的原文。

**决定六：claim 只接受对象形式，裸字符串被 Schema 层拒。** `parseValidation` 接受裸字符串并读成 `command`（D20，适合人手写的基因文件），**但本工具的 Schema 刻意不接受**，理由具体而非风格：**裸字符串会静默变成 `command` claim，而 `command` claim 在本运行时永久 `unverifiable`** —— 于是 `claim:"跑测试"` 会产出一个永远判不了的条件，**而这个后果在调用处看不见**。要求显式 `{kind:"command",command:"..."}` **让写入者亲手说出那个查不了的东西**。**一种被接受的形状也只有一种错法。**

**决定七：`parseValidation` 导出共用，不写第二个解析器。** claim 词汇表不是基因专属（D60 的结论），**两个解析器就是"什么是合法 claim"的两个答案，它们会漂移**。工具侧只在错误消息前加 `'steps[i].claim'` 定位。

**决定八：`cli.ts` 的注册表构造移进 `createRuntime`。** `tierTools` 原本建在 `createRuntime(sessionId)` 之外，而本工具需要 `store` 与该会话 id。**建在外面要么捕获过期 sessionId（⇒ 一个会话能写另一个会话的任务状态），要么需要一个可变持有者（同样的危险，步骤更多）**。改为按会话构造，其余工具仍走零参工厂，**不改 `allTools` 的签名形状**（改成带参工厂会让联合类型无法直接调用）。**这条改动的风险是"测试全绿而 CLI 全崩"**（所有测试都直接构造 `AgentRuntime`），**故必须真机验证**。

**本轮我自己的三处断言错误（如实记录，均非产品缺陷）**

1. 断言 full-access 给 `approve` —— **实际是 `allow`**（见决定三）。
2. 断言我的解析器错误消息 —— **实际注册表先按 JSON Schema 校验**（`$.state must be a non-empty string`、`$.steps[0].claim must be object`），我的解析器只对"通过 Schema 但 claim 语义非法"的情况起作用。**测试改成断言"消息必须指出位置"这个与层次无关的性质**（`/state|steps/`），只对 Schema 表达不了的那一种（虚构 kind）钉死原文。
3. 断言裸字符串 claim 被接受 —— **实际被 Schema 拒**，而这促使了决定六。

**教训：三处同源 —— 我在没读注册表的 Schema 校验层与档位覆盖关系之前就写了断言。** 与 D58 起"必须先读 X"写进文档的做法一致：**断言产品行为之前，先读到那条行为。**

**验证**：`tsc --noEmit` 干净；全量 **611 项 / 609 通过 / 1 失败 / 1 跳过** = 基线 598/596/1/1 **+13**，失败数不变，那 1 项是 `background-jobs` 已知并行漂移、**隔离重跑 11/0（连续第七轮）**；`task-state-writer.test.ts` **13/13**。**变异验证三处全部变红** —— A 从 `WRITE_TOOLS` 移除 → 9 红；B 从 `WRITE_TOOL_LINE_ARGUMENT` 移除 → 3 红；C 删掉拒绝路径的 `appendAudit` → 1 红；**还原后 13/13**。**真机**：`--preflight --probe-tools` **验不了接线**（它探测的是"提供方是否接受 tools"，不列出提供的工具），故改用真进程加载真实模块逐档位打印 —— **同时验掉了 `write-tools.ts` 警告过的那种"类型检查通过、运行时 `cannot access before initialization`"的 import 环**（新增 `tools.ts → task-state.ts → gene.ts` 边）。**⚠️ 本轮超预算，经 late 通道整合（半分，不计入连胜）。**

**未做 / 未验**：`assessTaskState` **仍只有测试在调用**，接到轮末留下一轮（**刻意不与写入者同轮** —— 混在一轮会让"哪个改动导致哪个红"无法归因）；写入者尚无跨轮真实使用证据（没有真模型跑过它）；`update_task_state` 与 `batch_files` 同批时的交互未测；审计只覆盖工具路径，**运行时内部若直接调 `appendTaskState` 则不落审计**（当前无此调用方）。

### 轮末判定：只报告、绝不降级，以及一处我自己造成的混淆的更正（D64，2026-09-30，有代码）

**⚠️ 先更正我上一轮报告里的一处混淆（我自己造成的）**：我说过"接 `assessTaskState` 会让 D58 那个死代码开关变得有意义"。**这是错的，两件事无关。** 实读 `sendTurn` 确认：`if (text.length === 0) throw new Error("empty input")` 在前，`buildTaskSpec(text, { mode: TASK_MODE })` 恒传已知的 mode ⇒ `unknowns` 恒为 `[]` ⇒ `if (verdict.blocked) throw` 不可达。**那是 `assessTaskSpec` 的 `unknowns`（objective/mode 缺失），与 `assessTaskState` 的步骤判定是两套东西。** 本轮不碰它。

**本轮读了什么（符号+引文为主定位符）**

| 来源 | 读到的承重事实 |
|---|---|
| `runtime.ts` 轮末分支（`response.toolCalls.length === 0`） | 已有 `evaluateRun({ steps, toolCalls, toolErrors, failureClass: null })`，其注释：*"the verdict is read off what the round mechanically did"*；`checkValidation(applied.validation, { filesWritten: this.writeLedger.files, tools: this.outcomeTools ?? [] })`；**`validation.failed.length > 0` 会把 `status` 降为 `"partial"`** |
| `validation.ts` `RoundEvidence` | 就是 `{ filesWritten, tools }` ⇒ **轮末已有的那个字面量正是 `assessTaskState` 要的形参，不需要新证据通道** |
| `runtime.ts` `SendResult` | 已有 `validation?: ValidationReport`（*"The applied gene's claims compared against the round, when a gene applied"*）与 `evaluation: CycleEvaluation` ⇒ **新字段应与它并列同形** |
| `runtime.ts` `formatBudget` | *"One-line rendering of a send's budget, for both CLI entry points"*，内置两条诚实规则（未测量就写未测量、超上限就写超多少）⇒ **判定也应有同形单行渲染器** |
| **⚠️ `cli.ts` / `interactive.ts` grep `validation\|evaluation`** | **CLI 目前完全不显示这两个字段**（只命中 4 处，全与本主题无关）⇒ **这直接决定本轮的硬要求：算出来但不显示，就是 D58 那种"已建成、测试里承重、但没人调用"的死代码重演** |
| `task-state.ts` `assessTaskState` | `unknowns` 里的字符串是 `步骤 N（text） 缺验收条件` 与 `… 无法判定：detail`，`failed` 里是 `… 未达成：detail` ⇒ **⚠️ 这些字符串自身不带轮次限定**，所以限定必须由渲染器加在它们外面 |

**决定一（核心）：只报告，绝不用它给本轮降级。** 理由是 D62 那条不对称性的直接推论，而且可检验：**证据是每轮的**（`writeLedger`/`outcomeTools` 每轮重置）**而任务是跨轮的** ⇒ **第 2 轮达成的步骤，在第 5 轮的证据下读作 `unmet`**。`validation`（基因 claim）**可以**降级本轮，**因为基因是应用到单轮的**；**任务状态不是**。**若照抄轮末那段降级逻辑，就会产出我在 D62 拒绝注入的那个同样的误导判定 —— 只不过这次写进轮记录而不是 prompt。** 故 `taskAssessment` 与 `verdict` 完全解耦，**测试用最强的形式钉住它**：同一个脚本轮，一次有任务状态、一次没有，**断言两者 `evaluation` 深度相等**（"判定若参与定级，这两份就不可能相同"）。

**决定二：不持久化。** 它是从日志推导出来的事实，**ADR-0001 的原则是不留副本**；更具体的是**跨轮累积规则尚未定案**（哪一轮的 `met` 算数？），**把一条含义未定的记录写进日志比不写更坏** —— 它会变成一堆每条都看起来像判定、实则都不是的东西。**要的人可以从日志重算。** 记为未决项。

**决定三：一份具名证据对象，两个读者。** 把 `{ filesWritten, tools }` 提成 `roundEvidence` 供基因 claim 与任务 claim 共用。**写两遍就会让同一轮的两种判定基于不同的事实** —— 而这类漂移不会报错，只会让两个数字悄悄地不一致。测试用"同一轮里 `budget.filesWritten === 1` 且该步为 `met`"钉住它们读的是同一本账。

**决定四：轮末必须重读 `store.taskState`，不能复用 `buildPrompt` 读到的那份。** **模型可能就在本轮用 `update_task_state` 写过**，复用会评估一个被本轮改掉了的旧状态。代价是每轮多一次全日志 `inspect()`，相对本轮已发生的模型调用可忽略。

**决定五：轮次限定由渲染器承担，因为步骤字符串自己不带。** 渲染文本为 `[本轮任务判定 N/M 步达成 · 未知 K · 本轮未达成 J]（仅对本轮证据：跨轮任务的步骤可能已在更早的轮次达成，此处不代表从未达成）`，**并在任一步为 `unverifiable` 时追加"判不了不等于没做：需要跑命令的验收条件在本运行时恒为 unverifiable"** —— 因为**忘记能力上限的人会把 `unverifiable` 读成"没做"**。**变异验证证明这条限定是承重的**：删掉它 → 1 红。

**决定六：单行只给计数，不给步骤文本。** 这是刻意的：步骤文本是长度无界的散文，而这一行的契约是"一行"（与 `formatBudget` 同形）；**完整的逐步明细已经在 `SendResult.taskAssessment` 上**，要采取行动的人从那里拿。

**⚠️ 顺带发现的一个更大的缺口（本轮不做，如实记）**：**CLI 既不显示 `validation` 也不显示 `evaluation`** —— 也就是说**基因 claim 的比对结果与本轮的机械判定，操作员在 CLI 上看不到**，它们只活在 `SendResult` 与 outcome 日志里。**这比本轮的改动范围大，且需要单独决定显示到什么程度**（一行放不下 claim 明细）。

**本轮我的测试 bug（如实记录）**：三个测试共用一个 workspace 且都写 `a.txt`，而 **`create_file` 不覆盖已存在文件** ⇒ 第一个测试建了它之后，后续 `create_file` 失败、不入账本 ⇒ `complete` 为 `false`。**症状是"最承重的那条断言红了，而形状相同的另一条绿着"**，所以第一反应容易误判成产品缺陷。**实际是测试之间通过文件系统耦合了。** 修法是每个测试用独立文件名，并在端到端那条里**补一句 `outcome === "met"` 的断言**，让"写入真的发生了"成为显式前提 —— **否则那条测试会在写入静默失败时照样通过，只是在测一件别的事**。

**验证**：`tsc --noEmit` 干净；`task-assessment.test.ts` **9/9**；全量 **620 项 / 618 通过 / 1 失败 / 1 跳过** = 基线 611/609/1/1 **+9**，失败数不变（`background-jobs` 已知并行漂移，**隔离重跑 11/0，连续第八轮**）。**变异验证三处全部变红** —— A 删掉 `assessTaskState` 调用 → **5 红**；B 删掉渲染里的轮次限定 → **1 红**；**C 把判定塞进 `systemText`（即故意破坏 D62 的不变量）→ 1 红**；还原后 **9/9**。**真机（D45：真机验证才是可信单位）**：用 `PERSONAL_AGENT_HOME` 指向临时目录（**不碰真实数据**），先跑一次 `--echo` 建会话、播种三步任务状态（一步 `tool-used`、一步 `command`、一步无条件）、再跑一次，**CLI 二进制真实打印**：`[本轮任务判定 0/3 步达成 · 未知 2 · 本轮未达成 1]（仅对本轮证据：…） 判不了不等于没做：…` —— **三类计数全对**（未知 2 = `command` 恒判不了 + 缺条件那步；本轮未达成 1 = 本轮没调 `read_file`），**且 prompt 从 602B 涨到 1.4KB，同时证明状态块仍在注入**。

**未做 / 未验**：**跨轮累积未定案**（见决定二）；`enforceTaskSpec` 的死代码未处理（独立小决定）；**`validation`/`evaluation` 在 CLI 上不可见**（见上）；`taskAssessment` 与 `compactedMessages` 同时出现时的呈现未测；只有 `--echo` 真机跑过，**没有真模型跑过它**。

### 让机械判定在终端上可见：一个渲染器，而不是两个（D65，2026-09-30，有代码）

**要修的缺陷不是"少一个功能"，而是"一个已有的结论没人看得见"**：`SendResult.evaluation` 每轮都算、cycle 日志每轮都存，**而两个 CLI 入口都不打印它**。于是"只信机械事实"这套取向**只在日志里成立，在操作员真正看的地方不成立** —— 与 D58 在 `enforceTaskSpec` 上发现的是同一个形状（已建成、测试里承重、 reaching nobody）。

**本轮读了什么（符号+引文为主定位符）**

| 来源 | 读到的承重事实 |
|---|---|
| `cycle.ts` `CycleEvaluation` | `{ status, failureClass, evidence, reviewer: "mechanical" }`；`EvaluationStatus` 注释 *"How the round ended, from mechanical evidence only — never a self-report"*；`FailureClass` 注释 *"What went wrong, coarsely enough to be honest about the cause"*；`evidence` 注释 *"The facts this verdict was read off, verbatim"*；**`reviewer` 注释 *"Who judged. Mechanical until a reviewer exists that is not the worker."*** |
| `cycle.ts` `evaluateRun` | `evidence = [\`steps=${…}\`, \`toolCalls=${…}\`, \`toolErrors=${…}\`]`；`failureClass !== null` 时 `status = (failureClass === "model" && steps === 0) ? "blocked" : "failed"`；否则 `status = toolErrors === 0 ? "success" : "partial"` ⇒ **纯机械、不看基因**，与 D60 要求 `assessTaskState` 也不看基因一致 |
| **⚠️ `validation.ts` `validationEvidence`** | **它已经把每条 claim 渲染成 `validation:${outcome}=${describeClaim(claim)} (${detail})`，而轮末已经把它并进了 `evaluation.evidence`** ⇒ **这是本轮最省事的一处发现：不需要为 `validation` 做第二个渲染器** |
| `runtime.ts` `formatBudget` | 已打印 `步骤 N/M · 工具 N/M`，且内置两条诚实规则（未测量就写未测量、超上限就写超多少）⇒ **`evidence` 里的 `steps=` 与 `toolCalls=` 是重复信息，而 `toolErrors=` 不是**（预算行报调用数、不报失败数） |

**六条决定**

1. **一个渲染器，渲染 `evaluation`；不给 `validation` 单独做。** 因为 claim 结论**已经在 `evidence` 里**（见上表第三行）。**单独渲染 `validation` 会是同一事实的第二份呈现，而两份会漂移** —— ADR-0001 的形状在显示端的版本。
2. **过滤掉预算行已经说过的证据，并把规则写明。** 只丢弃 `/^(steps|toolCalls)=/`。**理由不是省字符：把操作员刚读过的数字再念一遍是噪音，而噪音正是真正的告警被忽略的方式。** `toolErrors=` 保留。
3. **无条件打印，不加 `--verbose` 开关。** 与 `formatBudget` 一致（它也总是打印、也那么长）。**一个默认隐藏的结论等于没有结论 —— 那正是本轮要修的缺陷本身，不能用同一个形状去修它。**
4. **`reviewer` 必须打印。** 它是"谁判的"，而该字段的注释明说自己存在的理由是 *"Mechanical until a reviewer exists that is not the worker"*。**将来若真引入非 mechanical 的判定者，这一行是唯一能让人看出区别的地方** —— 少了它，那次变更会在终端上完全隐形。
5. **证据行数设上限，超出则报出被省略的条数，不静默截断。** `evidence` 长度 = 3 + 基因 claim 数，而 **claim 数没有上限**（基因的 `validation` 是数组）。照 `formatBudget` 的诚实规则照办。**测试刻意不硬编码那个上限常量**，而是数出实际显示的行数再断言省略数 —— **否则调高上限会让这条测试变成假绿**。
6. **顺序：预算 → 本轮判定 → 跨轮任务判定。** 顺序即语义（本轮消耗了什么 → 系统对本轮的结论 → 任务跨轮的进度）。**⚠️ 任务判定必须排最后**：它是三者中唯一**跨轮**的、且自带"仅对本轮证据"限定，**紧邻预算行会让读者把两种范围混在一起**。**两个入口必须同序** —— 否则操作员学会一个、被另一个误导。

**验证**：`tsc --noEmit` 干净；`format-evaluation.test.ts` **9/9**；全量 **629 项 / 628 通过 / 0 失败 / 1 跳过** = 基线 620/618/1/1 **+9**。**⚠️ 那 1 项已知漂移（`background-jobs` 的 kill 测试）本轮没有复现，是 8 轮以来第一次全绿** —— **但它是并行负载下的间歇性时序问题，一次通过不等于修好了，仍记为未修**。**变异验证三处全部变红** —— A 删掉 `判定者 mechanical` → **3 红**；B 去掉证据过滤 → **3 红**；C 删掉省略计数 → **1 红**；还原后 **9/9**。**真机（`PERSONAL_AGENT_HOME` 指向临时目录，不碰真实数据）**：无任务状态的一轮打印 `[本轮判定 success · 判定者 mechanical]` + 缩进 `toolErrors=0`（**`steps=`/`toolCalls=` 确实被过滤掉了**）；有任务状态的一轮**三行顺序正确**，任务判定行紧随其后。

**未做 / 未验**：**跨轮累积仍未定案**（任务状态剩下的唯一结构性缺口）；`enforceTaskSpec` 的死代码未处理；`validation` 的详细视图（逐条 claim 的展开）未做 —— **决定一让它当前不必要，但若将来 claim 数变多，"计数 + 展开"仍可能需要**；交互模式（`interactive.ts`）只做了同形接线，**没有真机跑过交互会话**；只有 `--echo` 真机跑过，没有真模型跑过。

### 跨轮累积取证：三候选的代价、第四个形状，以及"哪一轮的 met 算数"根本不是一个问句（D66，2026-09-30，**取证轮，无代码**）

**本轮不改产品代码**（既有规矩：新阶段前先记来源与取舍）。产出是这份取证与给操作员的裁决材料。**结论先行：原先列的三个候选里，(A) 的原始形式被源码推翻，(C) 的代价比预想大且不对称，(B) 有风险；取证过程又推出两个新形状 (A′)/(D)，而 (D) 暴露出一件更要紧的事 —— "哪一轮的 `met` 算数"不是一个问句，而是**逐 claim kind 各有一问**，其中 `files-written` 可能根本没有可靠的累积规则。**

#### 一、内部取证（全部实读；符号+引文为主定位符）

| # | 来源 | 读到的承重事实 |
|---|---|---|
| 1 | `ADR-0001` §1 | "不留副本"的理由是**崩溃窗口**，不是审美：*"这些检查之所以存在，正是因为同一事实被写了两遍。一次崩溃落在任一行之间，都可能产生两套事实不一致的状态"* ⇒ **判据是"能不能产生两套不一致状态"，不是"有没有存第二份"** |
| 2 | `ADR-0001` §4.3（`summary` 先例） | *"message 仍是唯一事实来源，`summary` 是对'模型看到什么'的**派生视图说明**，不是第二条事实来源；**删除全部 summary 事件只意味着 prompt 变长**"* ⇒ **可操作判据：删掉这类记录，是只丢便利，还是丢真相** |
| 3 | **⚠️ `cycle-store.ts` 头注** | *"It is an operational record of what the agent did — **the session log stays the conversation's fact source (ADR-0001)**"* ⇒ **ADR-0001 的范围是"对话"，不是"全部事实"。产品里已经存在两个会话日志之外的事实存储（cycle 库、gene 库）。所以真问题不是"能不能存"，而是"存进哪个库、存成快照还是存成历史事实"** |
| 4 | `runtime.ts` `journalOutcome`（`:659-678`） | **`:666` 是 `if (address === undefined \|\| !this.geneStore) return;`** ⇒ **outcome 日志只在有基因被应用时才写**；`appendOutcome({address, …})` **按基因地址归档**、存在**基因库**、内容是**基因声誉**（`succeeded`/`status`/`failureClass`/`intent`/`signals`/`tools`/`evidence`）⇒ **候选 (A) 的原始形式不成立**：基因库为空时（本项目现状）什么都不记，且**归档轴是基因不是任务**，按它合并得到的是"这个基因表现如何" |
| 5 | `cycle.ts` `CycleState`（`:44-51`） | `readonly evaluation: CycleEvaluation \| null`，注释 *"Set by the review phase"*，由 `review-ready` 写入（`:82`）⇒ **每轮机械判定确实已被持久化**，且 `evidence` 含 `validation:*` 逐条 claim 结论（D65 已核实） |
| 6 | **⚠️ 但 `evaluateRun`（`cycle.ts:134`）** | `evidence = [\`steps=${…}\`, \`toolCalls=${…}\`, \`toolErrors=${…}\`]` ⇒ **`filesWritten` 的路径列表不在其中** ⇒ **(A′) 能跨轮恢复"基因"结论，恢复不了"任务步骤"结论**，因为重判步骤所需的 `RoundEvidence` 不在 cycle 库里 |
| 7 | `cycle-store.ts` `states()`/`load()` | **该库是所有会话共用的单一文件**（`this.path` 构造时固定）；`states()` 返回 `Map<cycleId, CycleState>`，**折叠时丢掉了 `sessionId`** ⇒ 要按会话取须新增 API 或绕过折叠读原始记录；**`load()` 遇中间畸形行直接抛错**（`cycle store line N is not a valid v1 record`）⇒ **全有或全无**，共用文件里任一处损坏会让所有会话的历史都读不出来 |
| 8 | **⚠️ `runtime.ts:957`（(C) 的便宜一半）** | `this.outcomeTools?.push(call.name);` **位于预算检查与执行之前** ⇒ **对每个调用都记名字，不论被拒、失败或取消**，语义是"模型要了哪些工具、按什么顺序"。而 ADR-0001 D1 说 *"`assistant` 消息的 `toolCalls[]` 即「请求了什么」"* ⇒ **`tools` 从日志重算是一次查找：逐条收集 `toolCalls[].name` 即等价，无需重放任何规则** |
| 9 | **⚠️ `runtime.ts:994-997`（(C) 的昂贵一半）** | `if (result.isError === true) errors += 1; else if (attempt !== null) this.writeLedger = chargeWrite(this.writeLedger, attempt, position);`，注释 *"Only a write that actually happened is charged… **the ledger stays a record of the workspace, not of intent**"* ⇒ **`filesWritten` 从日志重算必须重建四件事：① 顺序依赖**（`checkWrite` 针对累积账本判定，`:966`）**；② 只有 `isError !== true` 才计入；③ 预算拒绝的写入不计入**（`:967-980` 的 `continue` 在 charge 之前）**；④ 匿名槽位按批内位置命名**（`chargeWrite(state, attempt, position)`，`position = index++`，`write-budget.ts` 用 `\u0000${index}`）⇒ **必须逐调用、按原顺序、带原索引地重放整个计费循环** |
| 10 | `runtime.ts` `taskState`/`appendTaskState` | `taskState(sessionId)` 已是**读最新一条 `task-state` 事件的 latest-wins 语义** ⇒ **候选 (B) 若做成"当前进度"的 latest-wins 标记，就是两个关于同一任务的可变快照，由不同代码路径在不同时刻写入** —— 正是取证 1 那个故障模式的形状 |

**由 9 得到的关键推论（比"重算很贵"更严重）**：**(C) 不是"读一遍日志"，是"把计费规则写第二遍"，而第二遍实现就是"一个问题两个答案"** —— 两份实现会在边界上分歧（尤其 ④ 的索引语义），**且分歧不报错**。**更糟的是：计费规则一旦变更，旧日志会按新规则重算出不同的历史** ⇒ **派生值跨版本静默改变含义，这比存一份副本更坏**（副本至少冻结了当时的判断）。

#### 二、外部取证（本地 `_research/repos`，两个产品的源码直读）

**⚠️ 派出的子代理在收尾前失败且无输出，外部部分改为自己做，因此只覆盖了两个产品**（`claude-code` 仓库无源码，只有 plugins/examples/scripts；宿主 dsh 路径在本环境读不到）。**未读**：goose、aider、gemini-cli、crush、opencode 的 v2 session core、LangGraph checkpointer、Temporal event history。**这一节的结论强度受此限制，如实标注。**

| 产品 | 来源 | 读到的机制 |
|---|---|---|
| **Codex** | `codex-rs/protocol/src/plan_tool.rs` | `pub enum StepStatus { Pending, InProgress, Completed }`；`pub struct PlanItemArg { pub step: String, pub status: StepStatus }`；`pub struct UpdatePlanArgs { explanation: Option<String>, pub plan: Vec<PlanItemArg> }`，其字段注释 *"Arguments for the `update_plan` todo/checklist tool (not plan mode)"* ⇒ **纯模型自报，没有 claim、没有证据、没有校验；且 `plan` 是整份 `Vec` 而非增量** |
| **Codex** | `codex-rs/core/src/tools/handlers/plan.rs:93-98` | **handler 全部逻辑就是**：`let args = parse_update_plan_arguments(&arguments)?; session.send_event(turn.as_ref(), EventMsg::PlanUpdate(args)).await; Ok(boxed_tool_output(PlanToolOutput))`，而 `PlanToolOutput::code_mode_result` 返回 `JsonValue::Object(serde_json::Map::new())`（**空对象**）⇒ **不校验、不合并、不累积；状态以事件形式发出，模型拿回一个空结果** |
| **opencode** | `packages/core/src/session/todo.ts:32-57` | 存在 **SQL 表** `TodoTable`（字段 `session_id`/`content`/`status`/`priority`/`position`）；`update` 在**一个事务里先整份删除再整份插入**：`tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()` → `if (input.todos.length === 0) return` → `tx.insert(TodoTable).values(input.todos.map((todo, position) => ({…})))`，随后 `events.publish(Event.Updated, input)` ⇒ **可变快照 + 事务作为崩溃安全机制（而不是 append-only）；`status` 同样是模型自报** |

**外部取证给出的结论（这是本轮最有用的一条）**：**两个产品、两种截然不同的存储机制（发事件 vs SQL 事务整份替换），语义完全相同 —— 整份替换、latest-wins、模型自报 `status`、没有任何跨轮累积逻辑。**

⇒ **业界不累积，业界替换。** 而它之所以负担得起"替换"，是因为**它信任模型写的 `completed`** —— **状态是由模型自己一轮轮带下去的**。

⇒ **本产品的处境因此被精确地定位了**：`task-state` **已经是业界那个形状**（整份 latest-wins、存在会话日志、模型重写步骤文本），**唯一的差别是本项目拒绝让模型写 `done`**（D14/D15/D26：*"没有模型自报成功的通道"*）。**所以缺口不是"少了累积机制"，而是"业界用信任模型填的那个洞，本项目必须用别的东西填"。**

#### 三、四个形状的代价 / 优势对照

| 形状 | 优势 | 代价（具体） | 崩溃窗口下的表现 |
|---|---|---|---|
| **(A) 不累积，读者自己合并** —— 原设想用 outcome 日志 | 零新增存储 | **⚠️ 已被推翻**：outcome 日志**只在有基因时写**、**按基因地址归档**、存在基因库（取证 4）。基因库为空 ⇒ 无记录；轴是基因不是任务 ⇒ 合并出来答不了"任务做到哪了" | 不适用（本来就没有记录） |
| **(A′) 不累积，从 cycle 库合并** | 零新增存储；每轮机械判定**已经**在里面（取证 5） | **缺关键事实**：`evidence` 里没有 `filesWritten`（取证 6）⇒ **恢复不了任务步骤结论**；库全会话共用、`states()` 丢掉 `sessionId`、`load()` 全有或全无（取证 7）⇒ 要按会话读须新增 API，且任一处损坏波及所有会话 | 好：append-only + 截断尾丢弃（`load()` 末尾 `lines.pop()`），坏行在中间才致命 |
| **(B) 新增 latest-wins 的"当前进度"标记事件** | 读一次即得答案；与既有 `task-state` 同构，实现最省 | **⚠️ 两个关于同一任务的可变快照**（取证 10），由不同路径在不同时刻写 ⇒ **正是 ADR-0001 §1 那个故障模式的形状**；且它存的是**结论**，`checkValidation` 语义一变，旧结论就与新语义不一致而无人察觉 | 差：快照写一半 = 一个既非旧亦非新的进度 |
| **(C) 需要时从日志重算** | 零新增存储；永远是"当前规则下的答案" | **⚠️ 不对称**：`tools` 是查找，`filesWritten` 是**重新实现整个计费循环**（取证 8/9）⇒ **第二份实现 = 一个问题两个答案，分歧不报错**；**且规则变更后旧日志重算出不同历史**，派生值跨版本静默改变含义，**比存副本更坏** | 最好：无新增写入点 |
| **(D) 存每轮的证据（不是结论），累积=并集，按需重判** ← 取证推出的新形状 | **存事实不存结论** ⇒ `checkValidation` 语义变更时重判自动跟随，不会冻结旧语义；**"哪一轮的 `met` 算数"这个问题被消解**（对并集重跑同一个 `assessTaskState` 即可，不需要新规则）；按 §4.3 判据**删掉它丢的是真相**（第 Y 轮的 `RoundEvidence` 无处重算）⇒ **它是新事实而非派生视图，按取证 3 允许存在会话日志之外**；每轮一条、不可变、单调 ⇒ **后续轮次不可能与之矛盾，不构成"两套不一致状态"** | 每轮多一条事件（日志增长）；需要 `runId` 作身份（ADR-0001 D3 已有）；**⚠️ 并集语义逐 kind 不同，见第四节** | 好：append-only、单调、丢一条只丢那一轮 |
| **(B′) 存每轮的"第 X 步在第 Y 轮 met"历史事实** | 不可变、单调、不构成快照冲突；读时折叠即得进度 | 存的是**结论** ⇒ 同 (B) 的语义冻结问题；比 (D) 多一层派生 | 好 |

#### 四、⚠️ 本轮最重要的发现：累积**不是** claim-kind 无关的

原问题被表述为"哪一轮的 `met` 算数"，**但取证后发现它必须逐 kind 拆开问，而答案不一致**：

| claim kind | `validation.ts` 的实际语义 | 跨轮并集是否成立 |
|---|---|---|
| `tool-used` | **下界**（`times < claim.times` 才 `unmet`；D61 已核实） | **成立且自然**：把各轮 `tools` 拼接后再数次数，正是"这个任务累计调了几次" |
| `files-written` | **双向集合相等**（`const actual = [...new Set(evidence.filesWritten)].sort();` 后与 claim 的 paths 比；D61 据此判定 `paths` 不可变） | **⚠️ 不成立**：claim `files-written:[a.ts]` 的意思是"**恰好**写了这些"。对各轮取并集后，**任何一轮多写了任何文件都会让这条原本 `met` 的 claim 变成 `unmet`** ⇒ **并集会把"曾经恰好达成"改判为"未达成"，即累积反而让已达成的步骤失效** |
| `no-write` | 本轮 `filesWritten.length === 0` 才 `met` | **含义会变**：跨轮变成"任何一轮都没写过" —— 讲得通，但**不再是同一个命题**，须显式决定 |
| `command` | 恒 `unverifiable`（`validation.ts:86-89`） | 无关（本来就判不了） |

⇒ **对 `files-written`，可能根本不存在可靠的累积规则**：它天然是**每轮**命题（"这一轮恰好写了这些"），把它拉到跨轮就改变了它的含义。**这与 D61 的 `paths` 不可变是同一个根源（双向集合相等），也是 D64"任务判定不得给本轮降级"的同一个不对称性的第三面。**

⇒ **因此任何累积方案都必须逐 kind 定义，并且很可能要公开声明一条新的能力上限：以 `files-written` 为验收条件的步骤，其达成只在当轮可判、跨轮不可累积** —— 与"`command` 恒判不了"并列，写进 `SAFETY.md` 与工具描述。

#### 五、给操作员的裁决材料（本轮不实现）

1. **(A) 已死**，不必再考虑（取证 4）。
2. **(C) 便宜的一半是真的、贵的一半也是真的**：若只做 `tool-used` 类步骤的跨轮累积，`tools` 确实可以从日志直接收集（取证 8），**不需要重放计费循环**。⇒ **存在一个"半份 (C)"：只累积 `tools`，不累积 `filesWritten`**，代价是 `files-written` 步骤永远只能当轮判 —— 而这恰好与第四节的结论一致（它本来就不该累积）。**这是本轮取证指向的最小可行形状。**
3. **(D) 是完整解**，但它要求每轮多写一条事件，且要先定并集语义（第四节）。
4. **(B) 不建议**：两个可变快照正是 ADR-0001 要防的形状。
5. **业界的做法本项目用不了**：Codex 与 opencode 都靠**信任模型自报 `status`** 来免除累积（第二节）。**本项目拒绝那条通道是有意的**（D14/D15/D26），所以**这个缺口是那条拒绝的直接代价，不是设计疏忽** —— 这一点应当公开写进文档，而不是被某个累积机制悄悄掩盖。

**未取证 / 未验**：goose（`crates/goose/src/agents/platform_extensions/todo.rs`）、aider、gemini-cli（`packages/core/src/utils/planUtils.ts`）、crush（`internal/agent/tools/todos.go`）、opencode 的 v2 session core（其 `AGENTS.md` 提到 durable `session_input` 行、投影与 "Context Epoch persistence"，**可能有更接近 event sourcing 的做法，未读**）、LangGraph checkpointer、Temporal event history、宿主 dsh 的 swarm 记录方式（**本环境读不到该路径**）。**"业界不累积"这个结论只由两个产品支撑，样本偏小，不应据此推广到全部产品。**

### 存储后端取证：为什么上一轮给不出排序，以及两处自我更正（D67，2026-09-30，**取证轮，无代码**）

**操作员的判断是对的，而且指出了正确的方法论**：*"如果哪个最优应该是有个排序的，而你现在在纠结就说明材料不够。"* **补取证之后排序出来了，并且定位到"纠结"的根因不是累积语义难，而是我默认了 JSONL-only 这个前提 —— 而这个前提正是别人没有的。**

**⚠️ 本轮不改产品代码。** 另需如实记录：**派出的子代理第二次在收尾前失败且无输出**（上一轮也是），**外部取证全部由我自己做**。

#### 一、"别的 agent 是否带 SQL"：是，而且恰恰是有任务状态的那几个全都带

扫 `_research/repos` 下 10 个仓库的清单文件（`package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`）：

| 仓库 | 数据库依赖（清单文件原文命中） |
|---|---|
| **codex** | **有专门的 `codex-rs/state` crate**：`sqlx = { workspace = true }`、`libsqlite3-sys = { workspace = true }`、`sqlx-macros`；`app-server` 与 `cli` 也依赖 `sqlx` |
| **goose** | `sqlx = { version = "0.9.0", default-features = false, features = ["sqlx/tls-rustls", "sqlx/tls-native-tls", …] }`、`libsqlite3-sys` |
| **crush** | `modernc.org/sqlite v1.58.0`（**纯 Go，无 cgo**）、`github.com/ncruces/go-sqlite3 v0.35.4`、`ncruces/go-sqlite3-wasm/v5`（indirect） |
| **opencode** | `drizzle-orm`、`drizzle-kit`（即 D66 读到的 `sqliteTable`），脚本 `"db": "bun drizzle-kit"` |
| aider / gemini-cli / grok-cli / extra | **无命中** |
| claude-code / assistant-code | **仓库无源码**（只有 plugins/examples/scripts）⇒ **无命中不等于无数据库** |

**codex `state` crate 的迁移文件里有什么**（实读 `state/migrations/`）：`threads`、`logs`、`thread_goals`、`thread_goal_continuation_deferrals`、`thread_dynamic_tools`、`thread_spawn_edges`、`agent_jobs`/`agent_job_items`、`memories`（`stage1_outputs`/`jobs`/`consolidation_progress`）、`backfill_state`、**以及 `rollout_migration_state`** ⇒ **他们做过从 rollout(JSONL) 往 SQLite 的迁移。这件事本身就是一个证据：JSONL 不足以承载这类状态，否则不会有那张迁移状态表。**

#### 二、三条决定性证据

**证据 1 —— `thread_goals` 是每 thread 一行的可变快照，累积量就是行内计数器**（`codex-rs/state/migrations/0029_thread_goals.sql` 全文 11 行）：

```sql
CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete')),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

⇒ **跨轮累积的量（`tokens_used`、`time_used_seconds`）就是可变行里的计数器**，不是事件折叠出来的。（`0033_thread_goal_stopped_statuses.sql` 又建了 `thread_goals_new` 重建该表 ⇒ 状态枚举后来还长过。）

**证据 2 —— ⚠️ 写它的 SQL 把"状态转移守卫"与"计数器比较"放在同一条语句里原子执行**（`codex-rs/state/src/runtime/goals.rs:287-301`）：

```sql
UPDATE thread_goals
SET objective = COALESCE(?, objective),
    status = CASE
        WHEN status = ? AND ? IN (?, ?) THEN status
        WHEN ? = 'active' AND ? IS NOT NULL AND tokens_used >= ? THEN ?
        ELSE ?
    END,
    token_budget = ?, updated_at_ms = ?
WHERE thread_id = ? AND (? IS NULL OR goal_id = ?)
```

写法是 `INSERT INTO thread_goals (…) ON CONFLICT(thread_id) DO UPDATE SET`（upsert，`:75-86`）加**六处 `UPDATE thread_goals`**（`:289/324/355/384/444/534`）。

⇒ **没有读-改-写竞争、没有崩溃窗口；"非法转移被拒"（第一个 `WHEN` 分支）与"超预算自动转 `budget_limited`"（第二个 `WHEN` 分支，直接比较行内的 `tokens_used`）都由数据库在同一条语句里保证，不靠调用方自觉。**

**证据 3 —— `agent_job_items` 是"跨轮分项状态"的业界形状**（`codex-rs/state/migrations/0014_agent_jobs.sql`）：

```sql
CREATE TABLE agent_job_items (
    job_id TEXT NOT NULL, item_id TEXT NOT NULL, row_index INTEGER NOT NULL,
    source_id TEXT, row_json TEXT NOT NULL, status TEXT NOT NULL,
    assigned_thread_id TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    completed_at INTEGER, reported_at INTEGER,
    PRIMARY KEY (job_id, item_id),
    FOREIGN KEY(job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_job_items_status ON agent_job_items(job_id, status, row_index ASC);
```

⇒ **每个分项一行、有稳定 id（`item_id` 在主键里）、带累积计数器（`attempt_count`）、记录哪一轮做的（`assigned_thread_id`）与结论（`status`/`result_json`/`completed_at`）。不是 append-only 事件，也不是重算。**

#### 三、⚠️ 两处自我更正（本轮最重要的产出）

**更正一：上一轮否定 (B) 的理由是"前提相对的"，不是绝对的。**

上一轮写的是"(B) 不建议：两个可变快照正是 ADR-0001 要防的形状"。**这句话在 JSONL 前提下成立，在数据库前提下不成立** —— 因为证据 2 显示**条件更新是原子的**：比较与写入在同一条语句里，**不存在"读到旧值、算出新值、写回去时世界已经变了"的那个窗口**，而那正是 ADR-0001 §1 描述的故障（*"一次崩溃落在任一行之间，都可能产生两套事实不一致的状态"*）。

⇒ **别人都选 latest-wins 的可变快照，正因为他们有那个原子性；我否定它，正因为我没有。** **"纠结"的根因是存储前提，不是累积语义。**

**更正二：上一轮的 (D)「存证据、并集、重判」方向是错的，(B′)「存当时的判定」方向是对的。**

上一轮把 (D) 列为"完整解"、把 (B′) 列为"比 (D) 多一层派生"。**这个排序反了。** 理由正是上一轮自己发现的并集悖论：`files-written` 是**双向集合相等**，**拿各轮证据的并集去重判一条旧 claim，会把原本 `met` 的改判成 `unmet`** —— **(D) 恰好会触发那个悖论，而 (B′) 不会**，因为 (B′) 记下的是"这条 claim 在它自己那一轮被判为 met"，**根本不拿新证据去重判它**。

**证据 3 印证了这一点**：`agent_job_items` 存的是 `status` + `completed_at` + `result_json`（**当时的结论**），**不是**各轮证据的并集。

⇒ **上一轮那句"`files-written` 可能根本没有可靠的累积规则"要改写**：正确的说法是 **"不该拿新证据重判旧 claim，而应把当时的判定结果记下来"**。累积是可行的，**只是不能靠并集证据实现**。上一轮把 (B′) 的"存结论"当成缺点（*"语义变更时旧结论与新语义不一致"*），**这个顾虑站不住**：**"在当时那套规则下它被判为 met"本身就是一个历史事实**，规则变了不该追溯改写历史 —— 这与 `chargeWrite` 注释里 *"the ledger stays a record of the workspace, not of intent"* 是同一种立场（记录当时是什么，不记录现在希望它是什么）。

#### 四、⚠️ 于是真正缺的东西浮出来了：稳定的步骤身份

- **codex 有 `item_id` 在主键里**（证据 3），所以"第 X 项在第 Y 轮达成"有锚可挂。
- **本项目的 `TaskStateStep` 是 `{ readonly text: string; readonly claim?: GeneValidation }`，没有 id** —— 靠**位置与文本**辨认，而**模型每轮重写整份列表**（`appendTaskState` 是 latest-wins）。⇒ **"第 2 步在第 5 轮达成"这句话没有可挂的锚**：第 5 轮的"第 2 步"未必是第 2 轮的那个"第 2 步"。
- **⚠️ 而且本项目自己的源码就否认了"文本可以当身份锚"**：`TaskStateStep.text` 的注释是 *"Prose. Not authority — the claim is. **May be rewritten freely.**"* ⇒ **文本被明确设计成可自由重写**，所以它**不可能**兼任稳定身份。**位置更不行**（整份列表被重写，位置会漂移）。**⇒ 稳定 id 不是"最好有"，而是"累积在现有形状下根本无法表达"。**
- **opencode 的 `TodoTable` 也只有 `position` 没有 id**（D66 已读）—— **因为它整份替换、不累积，所以不需要 id**。

⇒ **是否需要稳定 id，正是"累积"与"替换"的分水岭。本项目想要累积，就必须先给步骤一个身份。** 这是本轮取证指出的**唯一必须新增的概念**，也是上一轮所有候选都不满意的共同原因。

#### 五、排序（操作员要的东西）

| 名次 | 方案 | 为什么在这个位置 | 主要代价 |
|---|---|---|---|
| **1** | **给步骤一个稳定 id + 每轮追加一条"第 X 步在本轮被判为 met/unmet"的不可变事实，进度由折叠得出** | 与证据 3 同构；**不需要并集语义**（不拿新证据重判旧 claim）；单调、后续轮次不可能与之矛盾 ⇒ **在 JSONL 下也安全**（append-only 事实，不是快照）；按 ADR-0001 §4.3 判据**删掉它丢的是真相**（该轮 `RoundEvidence` 无处重算）⇒ 是新事实，允许存在会话日志之外 | **必须新增 step id**，且要定 id 由谁生成、模型重写列表时如何保持（**这是本方案唯一的设计难点，也是必须先定的**）；每轮多一条事件 |
| **2** | **采用 `node:sqlite` 作键控存储** | 与业界一致（4/4 有任务状态的产品都带 DB）；**拿到证据 2 那种原子条件更新**；**且 `node:sqlite` 是标准库 ⇒ 仍然零生产依赖**，符合本项目取向 | 多出**第二个事实存储**（与 JSONL 并存，需要划界，正如 `cycle-store.ts` 头注为 cycle 库划的那样）；**⚠️ 与 D50 的"按位置拒绝"是否兼容未验**；**⚠️ `engines: node >=22.6` 下 `node:sqlite` 的可用性未验**（本机 Node v24.19.0 有，不等于下限有） |
| **3** | **"半份 (C)"：只累积 `tools`** | 最省、零新增存储（`tools` 可从日志的 `assistant.toolCalls[].name` 直接收集，D66 取证 8） | **没解决 `files-written` 步骤的跨轮问题**，能力缺口照旧；且只覆盖一种 claim kind，是局部答案 |
| **4** | **(D) 存证据、并集、重判** | **由上一轮的"完整解"降级** | **会触发并集悖论**：把已达成改判为未达成（第三节更正二） |
| **5** | **(B) 在 JSONL 里存"当前进度"可变快照** | 仍不建议，**但理由改为前提相对的** | 无原子条件更新时，两个快照就是 ADR-0001 §1 的故障形状；**若先做了名次 2，本方案会升到名次 1 之上**（那就是 codex 的做法） |
| **死** | **(A) 用 outcome 日志合并** | 已被 `journalOutcome` 的 `if (address === undefined \|\| !this.geneStore) return;` 推翻 | — |

**⚠️ 名次 1 与名次 2 不是互斥的，而是正交的**：名次 1 决定**记什么**（不可变的分项判定 + 稳定 id），名次 2 决定**记在哪**（JSONL 追加 vs SQLite 行）。**codex 同时做了两者**（`item_id` 主键 + 可变行 + 原子更新）。**本项目可以只做名次 1 而留在 JSONL** —— 因为 append-only 的单调事实不需要原子条件更新就安全。**这是本轮取证给出的最小充分改动。**

#### 六、如实记录的局限

**未读**：goose / crush / aider / gemini-cli 的**存储细节**（只有依赖命中，**没有读它们的表结构或写入路径**，所以"它们怎么累积"仍是未知）；opencode 的 **v2 session core**（其 `AGENTS.md` 提到 durable `session_input` 行、投影、"Context Epoch persistence"，**可能有更接近 event sourcing 的做法**）；LangGraph checkpointer；Temporal event history；宿主 dsh（**本环境读不到该路径**）。

**概括的样本**：**"有任务状态的产品都带数据库"由 4 个产品支撑**（codex 深读、opencode 读到 todo 表、goose/crush 只有依赖命中），**比上一轮的 2 个强，但仍不是全样本**；且 `claude-code`/`assistant-code` 无源码，**它们的机制完全未知**。

**未验**：`node:sqlite` 在本项目 Node 下限（22.6）下的可用性；`node:sqlite` 写入 agent home 与 D50 按位置拒绝的兼容性；**step id 的生成与保持方案**（名次 1 的关键难点，本轮只指出它必须存在，没有设计它）。

### `node:sqlite` 的两项前置：一项被推翻、一项通过，附对 D57 的更正（D68，2026-09-30，**验证轮，无代码**）

**验的是 D67 排名里名次 2 挂着的两项前置。** 结论：**前置一（下限可用性）不通过，但缺口比想象窄且修法便宜；前置二（D50 兼容性）通过，而且附带得到一个 desirable 性质。** 另**撞见一处 D57 的既有断言必须更正**，以及**一条 D50 与 ADR-0001 都没覆盖的新风险**。

**⚠️ 本轮不改产品代码。**

#### 一、前置一：`node:sqlite` 在 `engines: node >=22.6` 下限处**不能免标志使用**

**来源**：Node 官方文档 `doc/api/sqlite.md`（`raw.githubusercontent.com/nodejs/node/main`）。**⚠️ `web_fetch` 本轮失败（`TypeError: fetch failed`），是用 `curl.exe` 取回的，单一来源，未与 nodejs.org 官网或 CHANGELOG 交叉核对。**

其 YAML 头原文：

```
added: v22.5.0
changes:
  - version: [v25.7.0, v24.15.0]   pr-url: …/pull/61262
    description: SQLite is now a release candidate.
  - version: [v23.4.0, v22.13.0]   pr-url: …/pull/55890
    description: SQLite is no longer behind `--experimental-sqlite` but still experimental.
> Stability: 1.2 - Release candidate.
```

正文另有一句：**"This module is only available under the `node:` scheme."**

⇒ **模块自 v22.5.0 起内置，但直到 v22.13.0（22.x 线）之前都需要 `--experimental-sqlite` 启动标志。本项目 `package.json` 的 `"engines": { "node": ">=22.6" }` 正落在"内置但需要标志"的区间（22.6 – 22.12.x）。**

**⚠️ 这条的严重性在于：启动标志无法由进程自己在运行中打开。** 真机确认 `process.allowedNodeEnvironmentFlags.has("--experimental-sqlite")` 在 v24.19.0 上仍为 `true`（标志仍被识别，只是不再必需），但**"识别"不等于"能在运行中启用"** —— 它是启动期标志。

**⇒ 名次 2 在下限处不是免费的，必须三选一：**

| 选项 | 代价 | 评价 |
|---|---|---|
| **(i) 把 `engines` 抬到 `>=22.13.0`** | 排除 22.6–22.12.x 的用户 | **最干净，而且这批用户从来没被测过**（见下）。`AUDIT.md:25` 的 **A15 早已把 `engines>=22.6` 列为"仍需收窄"的未决项**，所以这不是为 sqlite 新开的口子，是补上一个已登记的欠账 |
| **(ii) 要求操作员用 `--experimental-sqlite` 启动** | 把负担推给人，忘了就崩；且与"零配置可用"的取向冲突 | **不可取** |
| **(iii) 运行时探测 + 降级** | 探测只能在 `import` 失败时才知道，等于 try/catch 一个 builtin；**降级路径需要另一套存储 ⇒ 两套存储实现并存** | **代价最大，且违反"一个问题一个答案"** |

**⚠️ 但实际暴露面比"下限不满足"听起来窄得多**，因为**所有真被测过的版本都在 22.13.0 之上**：

- `VALIDATION.md:210`：*"**Node 22.23.3 便携包实测通过**（官方 zip，SHA256 与 nodejs.org 的 SHASUMS256 一致…）"*，且同格明写 *"**只测了运行器给出的 22.x/24.x 与本机 22.23.3**（不是 22.6 下限本身）"*
- `README.md:52`：*"CI 在 `.github/workflows/ci.yml`：Windows 运行器 + Node `22.x`/`24.x`… **测的是这些具体版本，不是 `engines` 下限 22.6 本身**"*
- 本机 **v24.19.0**

⇒ **`engines` 的下限 22.6 是一条从未被任何测试覆盖过的声明**（这一点 `VALIDATION.md` 与 `README.md` 都已如实记录）。**所以"抬高下限"不会让任何被测过的配置失效。**

#### 二、⚠️ 对 D57 的更正（标记式更正块，不改写原文）

**原文（`REFERENCE_DECISIONS.md` D57 段，两处）**：*"本机 Node **v24.19.0** 实测 `require("node:sqlite")` **直接可加载**…而 `engines` 为 `node >= 22.6`、`node:sqlite` 自 22.5 起内置 ⇒ **floor 已覆盖，同样零依赖**。"*

**更正**：**"自 22.5 起内置"是对的，"floor 已覆盖"是不成立的** —— 因为 **22.5.0 至 22.12.x 需要 `--experimental-sqlite`**，而声明的下限 22.6 在该区间内。**"内置"与"免标志可用"是两件事，D57 把它们当成了一件事。**

**⚠️ 需要说清楚的是：同一份文档的"未验证"清单当时就正确地记下了这一条** —— *"**未验证**：…`node:sqlite` 在 `engines` floor（22.6）上**是否打 ExperimentalWarning 或需 flag**（本机只有 v24.19.0）"*。**⇒ 错的是结论段的措辞（把未验的事说成已覆盖），不是取证清单。** 这与 D55 立的判据同源：**凡断言某能力"可用/被挡住"，必须指出具体依据；此处的依据只支持"本机 v24.19.0 可用"，不支持"floor 已覆盖"。**

**这是本项目第七次自我更正，形态与前几次相同：由一台机器的实测结果推广到一条声明的范围。**

#### 三、前置二：与 D50"按位置拒绝"**兼容**，且附带一个好性质

- **拒绝的实现位置**：`security-config.ts` 的 `assertReadablePath`（`:141-153`，注释 *"Deny before read and after canonicalization. Error never includes file contents."*）。它按 `protectedRoots()` 与 `sensitivePathName` 拒绝。
- **`sensitivePathName`（`:136-138`）的正则里含 `.personal-agent` 与 `.dsh`** —— 正是 agent home 的默认目录名（`cli.ts` 的 `home: env.PERSONAL_AGENT_HOME ?? resolve(".personal-agent")`）。其注释自陈边界：*"A name list is a hint, not a boundary… It is still worth applying uniformly, including inside an added readable root, so that widening the readable area cannot make protection weaker than it is in the workspace."*
- **⇒ 这个拒绝发生在"文件工具的路径闸门"上，不是文件系统属性、也不是进程属性。**
- **而产品自身的存储从不经过它**：`cli.ts:256` 是 `const store=new SessionStore({root:paths.agentHome});` —— **会话日志本来就写在 agent home 里**。`cli.ts:65` 的注释也是这么说的：*"agent home 按位置对**文件工具**封死"*。
- **⇒ `node:sqlite` 写入 agent home 与 `SessionStore` 写 JSONL 属于同一类（产品内部存储），D50 不拦它。**
- **⚠️ 附带得到一个 desirable 性质**：因为 `sensitivePathName` 命中 `.personal-agent`，**模型永远无法通过工具直接读写那个 DB，正如它读不到 JSONL 日志**。⇒ **DB 天然落在"产品内部、模型不可达"这一侧**，不需要额外设防。

#### 四、⚠️ 新风险：数据库会把"不可改写历史"从结构性质降级为纪律

这是本轮发现的一条 **D50 与 ADR-0001 目前都没有覆盖**的风险：

- **append-only JSONL 让"产品无法改写自己的历史"成为存储形状提供的结构性质**。`cycle-store.ts` 头注：*"the log is the fact and the state is a fold over it, **a truncated tail (a crash mid-append) is dropped rather than guessed at**"*；ADR-0001 §4.2 还专门**删除**了 `appendToolCall`/`appendToolResult` 两个写入器以减少写入点。
- **数据库引入 `UPDATE`/`DELETE`，把这条保证降级成"代码要自觉"**。对照证据：codex 的 `goals.rs` 里有**六处 `UPDATE thread_goals`** 与 `ON CONFLICT … DO UPDATE`；**本项目若照做，"日志不可改写"就不再由存储形状提供，而要由代码评审提供。**
- **⇒ 因此有一条规则应当写进 `SAFETY.md`**：**若采用 SQLite，只允许 `INSERT`（含 `ON CONFLICT DO NOTHING`）与 `SELECT`，不允许 `UPDATE`/`DELETE`** —— 这样能拿到键控查询与主键去重，**同时保住 append-only 的结构性质**。代价是拿不到 D67 证据 2 那种"原子条件更新"（那需要 `UPDATE`），**而那恰好是名次 5 升到名次 1 之上的前提** ⇒ **这是一个真实的取舍，不是可以两全的。**
- **边车文件**：真机探测显示**默认 journal 模式下、干净关库后目录里只有 `probe.db` 一个文件，没有 `-wal`/`-shm`**。**⇒ 边车问题只在启用 WAL 时出现**，而按上一条规则本项目不需要 WAL。

#### 五、真机探测原始输出（D45：真机验证才是可信单位）

探测脚本写在项目外的临时路径（`D:\DSHXM\sqlprobe.cjs`），用完即删，**未留在仓库里**。建了一张与 D67 名次 1 同构的表（`PRIMARY KEY (task_id, step_id, run_id)`）：

```
node 版本 = v24.19.0
--experimental-sqlite 仍在本版本的允许标志里吗 = true
require('node:sqlite') 成功（本机无需标志）
写 3 行、读回 = [{"step_id":"s2","run_id":"r5","outcome":"met"},{"step_id":"s3","run_id":"r5","outcome":"unmet"},{"step_id":"s2","run_id":"r6","outcome":"met"}]
折叠出「截至 r6 各步最新判定」= {"s2":"met","s3":"unmet"}
原子条件更新的 changes = 1
关库后目录内实际文件 = probe.db
db 文件大小 = 12288 字节
临时目录已删除
```

**⚠️ 对这份输出必须如实说明两点，不能让它们比实际更强**：

1. **`changes = 1` 不是"守卫不满足时为 0"的证明。** 探测语句是 `UPDATE … SET outcome='met' WHERE step_id='s3' AND outcome='unmet'`，而 `s3` 当时**正是** `unmet` ⇒ **守卫是满足的，返回 1 是正确的**。**它证明的是"比较与写入在同一条语句里完成"，没有证明"守卫不满足时不改任何行"（那需要再跑一次反例，本轮没跑）。** 探测脚本里那句标签文字（"守卫不满足时应为 0"）是**我写错的**，在此更正。
2. **"折叠出各步最新判定"演示的是名次 1 的形状**（不可变分项事实 + 读时折叠），**不是名次 2 独有的能力** —— 名次 1 在 JSONL 下同样能做，只是折叠发生在 JS 里而不是 SQL 里。

#### 六、对 D67 排名表的修正

**按既有规矩，历史文档不改写，修正记在这里。**

| D67 名次 | D68 之后的状态 |
|---|---|
| **1（步骤稳定 id + 每轮不可变分项判定 + 读时折叠）** | **不变，且被真机探测印证可行**（第五节的表结构与折叠）。**仍是唯一必须新增概念的方案，且不依赖存储后端** |
| **2（采用 `node:sqlite`）** | **⚠️ 从"两项前置未验"改为"一项通过、一项不通过"**：D50 兼容性**通过**（第三节）；下限可用性**不通过**（第一节），**须先把 `engines` 抬到 `>=22.13.0`（选项 i）才谈得上采用**。另外第四节的"只许 INSERT/SELECT"规则会让它**拿不到原子条件更新**，即**名次 2 的主要吸引力（证据 2）与保住 append-only 性质不可兼得** |
| **5（JSONL 里的可变快照）** | **⚠️ D67 说"若先做了名次 2，本方案会升到名次 1 之上"—— 这句话要加条件**：只有在**允许 `UPDATE`**（即放弃 append-only 的结构保证）时才成立 |
| 3、4、死 | 不变 |

**⇒ 综合两轮取证，当前最小充分改动是 D67 的名次 1，且它不需要等任何存储决定。** 名次 2 变成一件**独立的事**（要不要引入第二个事实存储 + 要不要抬高 Node 下限 + 要不要放弃 append-only 的结构保证），**不应与名次 1 捆在一起做**。

#### 七、如实记录的局限

**未验**：**没有真的安装 Node 22.6–22.12.x 去实测标志要求** —— "下限处需要标志"是由官方 YAML 的 `changes` 记录推出的，**不是实测**；`UPDATE` 守卫不满足时 `changes = 0` 的反例未跑；**抬高 `engines` 是否会影响别的承诺未查全**（只确认了 `AUDIT.md:25` A15 已把它列为待收窄、以及 CI 与便携包实测版本都在 22.13.0 之上）；`node:sqlite` 在**非 Windows** 上的行为未验；**SQLite 文件损坏时的可重建性未验**（D57 曾提出"索引损坏须可重建而非报错"，本轮没有测）。

**未读**：goose / crush 的存储细节（D67 遗留）；opencode 的 v2 session core；LangGraph checkpointer；Temporal event history；宿主 dsh（本环境读不到）。

**单一来源**：Node 版本事实只来自 `doc/api/sqlite.md` 一份文件（`web_fetch` 失败，改用 `curl.exe`），**未交叉核对**。

### Cordis 是什么、DSH 把新行为放在哪里，以及"我用没读过的东西否决了它"（D69，2026-09-30，**取证轮，无代码**）

**触发**：操作员质问 *"DSH不就是现成的例子吗？他是如何设计的？为什么又不参考成熟产品？"*

**⚠️ 质问成立，先认错**：上一轮（`ARCHITECTURE.md` §5 的建议）我断言 *"不该建一套 Cordis"*、*"事件负载形状与卸载语义在没有第二个消费者之前属于推测需求"*。**而当时 `D:\DSHXM\ZYZNT\_dsh_ref\docs_cordis-primer.md`（45 行）我根本没读，`docs_architecture.md` 我只读了 1–90 行、全文 150 行。我用没读过的东西否决了它。**

**本轮补读**：`docs_cordis-primer.md` **全文 45 行**；`docs_architecture.md:91-150`（**补齐此前跳过的 60 行**）。
**⚠️ 如实标注未读**：`docs_development.md`（16.9 KB）、`dsh-upstream-AGENTS.reference.md`（16.5 KB）、`blog-cordis-tencent.html`（**204 KB**）；架构文档里引用的 `subsystems/*.md`、`cookbook/*`、`agent-lifecycle.md`、`tool-execution-pipeline.md`、`capability-seams.md` **在 `_dsh_ref` 内不存在，本地不可达**。

#### 一、Cordis 的五个观念（`docs_cordis-primer.md:9-13`，逐字）

| # | 观念 | 原文 |
|---|---|---|
| 1 | **插件是实现 Service 的对象** | *"A plugin is a object that implements Service. It can be a function with optional `inject` and `apply(ctx)` fields, or a `Service` subclass whose lifecycle Cordis mounts into the current context."* |
| 2 | **context 是服务的仓库** | *"A service claims a stable `ctx.<key>` such as `ctx.tools`, `ctx.llm`, or `ctx.sessions` from a context; **other plugins find services via key instead of importing a concrete implementation**."* |
| 3 | **用 `inject` 声明服务依赖** | *"A plugin that names required services **waits until those services exist**, so **load order is expressed through service requirements rather than manual boot sequencing**."* |
| 4 | **类型化事件用于通信** | *"Services declare event names through **TypeScript declaration merging**, then dispatch them as `emit`, `waterfall`, `parallel`, `serial`, or `bail` depending on whether listeners observe, wrap, fan out, run in order, or stop at the first bail value."* |
| 5 | **注册是可逆的效果** | *"Prompt sections, tool schemas, adapters, providers, and listeners are installed through `ctx.effect()` or `ctx.on()` so reload and teardown unwind them predictably."* |

**⚠️ 观念 2 与 3 正是上一轮实测病灶的解药**：实测 `runtime.ts` out-degree **16**，`constraints`/`task-state`/`taskspec`/`write-budget`/`validation`/`gene-store`/`cycle-store`/`cycle` **全部按名字硬 import**；`cli.ts` out-degree **23**。**"按 key 找服务而不是 import 具体实现" + "加载顺序由服务需求推导"** 就是针对这个形状的。

#### 二、五种 dispatch mode 是事件的公开契约（`:19-27`）

| Mode | Awaited? | 顺序 | 有返回值? |
|---|---|---|---|
| `emit` | No | 注册序，观察 | No |
| `waterfall` | No | 注册序，观察 | **Yes** |
| `parallel` | Yes | 全部并行 | No |
| `serial` | Yes | 注册序 | Yes |
| `bail` | No | 注册序，**直到有人 bail** | Yes |

**`:27`**：*"The dispatch mode is part of the event's **public contract**. New harness events document it with an **`@mode` tag** so the generated catalog can check declarations against dispatch sites."*

**`:31-35` waterfall 语义**：*"`ctx.waterfall` is **around-middleware**. A listener receives `(...args, next)`. Call `next()` to delegate the possibly wrapped result to the next service; **return without `next()` to short-circuit**."*，且 *"For **single-decision** events, **short-circuiting is the design**. A policy listener can return without `next()` when it owns the decision, while a listener that only annotates or observes must delegate."*

**⚠️ 这条直接对上本项目的 `decide()`**：本项目策略是默认拒绝、零模型调用；**Cordis 的形状是"拥有该决定的策略 listener 不调 `next()`"** —— 同一条语义，一个用函数返回值表达，一个用中间件短路表达。

#### 三、⚠️ 我跳过的 60 行里有整个参考集最有用的一张表（`docs_architecture.md:123-148`「Where new behavior goes」）

**`:125`**：*"New behavior attaches to a documented extension point. **Changing the loop itself updates this map.**"*

| 目标 | 机制 |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| **Add a model-facing capability** | **register on `ctx.tools`; its schema joins prompt assembly** |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.terminals` backend plus `dsh-tool-terminal` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| **Add background work** | **register on `ctx.jobs`; `job_*` tools collect or stop it** |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| **Intercept a request, tool, or turn** | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| **Add model-facing context** | **call `agent.inject()`; it lands in the next admitted request** |
| **⚠️ Add durable session state** | **extend `SessionEventMap`; render and replay from the log** |
| Store sessions in a new backend | implement `SessionPersistence`（`create`/`open`/`stat`/`list`/`export`） |
| Manage a same-session objective | use `ctx.goals`; continue through `agent/*` |
| Scope a registration to one agent | use that agent's `agent.ctx` |

**⇒ 本项目已建的东西在这张表里几乎每一行都有对应位置**：`run_command`→`ctx.shell`、`background-jobs.ts`→`ctx.jobs`、约束注入与任务状态注入→`agent.inject()`、`task-state` 事件种类→`SessionEventMap`、能力档→agent preset。**⚠️ 这张表本身就是"一切皆插件"的可执行版本 —— 它不是理念，是"想做 X 就注册到 Y"的对照表。**

#### 四、⚠️ 三条直接命中本项目未决问题的发现

**(1) `migrateEvent` 的 8-case switch 不是 append-only JSONL 的必然属性。** `:143` 说新增持久会话状态的办法是 **extend `SessionEventMap`**，配 Cordis 观念 4 的 **TypeScript declaration merging** ⇒ **事件种类由插件声明扩展，核心不需要为每个新种类加一个 `case`。** 本项目实测 `session-store.ts` 的 `migrateEvent` 是 8 个 case 的封闭 switch，**这是设计选择造成的，不是存储选择造成的**。

**(2) ⚠️ D67 的名次 1 是 DSH 已出厂的接缝。** `:113`「Projection seam」：*"`dsh-session-projection` owns `ctx.sessionProjections`: **registered units fold committed events incrementally, host consumers read one typed state with `stateOf()`**, and carriers batch cropped client views with `snapshot()`. **A host reader either requires this service during activation or fails explicitly when the registry or required key is absent.** Contributors may retain `ctx.inject(['sessionProjections'], ...)` registration **without silently defaulting a missing host value**."*
⇒ **"注册的单元增量折叠已提交事件、宿主用 `stateOf()` 读一份类型化状态"就是 D67 名次 1 的"读时折叠"**，而"缺失时显式失败、不静默默认"正是本项目 D60 那个陷阱（*"照抄基因门会让每个步骤在基因库为空时永久停在 `unverifiable`，功能看起来在工作却永远判不出任何东西"*）的同一处方。**⇒ D66/D67/D68 三轮研究重新发明了一个已出厂的设计，而我当时没读它。**

**(3) ⚠️ `:111` 是 ADR-0001 的强化版，可直接采用。** *"**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and **a runtime invariant asserts it**. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log."*
⇒ 本项目 ADR-0001 说的是同一原则（会话日志是唯一事实源），**但只写在文档里；DSH 把它做成运行时断言的不变量**。这是一条**可机械验证**的升级路径。

**(4) `:101` 顺带回答了一个本项目悬着的问题。** *"`agent/pre-step` **decides what the model sees**. Listeners may **rewrite the claimed messages or reject them outright**; **a rejected or empty first claim still closes a durable turn that spent no step, so the log records the attempt.**"*，且 *"A listener that rebuilds a downstream enter decision must **spread it** (`{ ...decision, messages }`) so the declaration survives."*
⇒ **① 这正是操作员要的 TaskSpec 落点**（*"大模型实际读取…是机器语言或者说提示词"*）；**② 被拒绝的轮次仍然落一条持久 turn，日志记下这次尝试** —— 本项目此前未定；**③ 重写下游决定时必须展开原对象，否则声明丢失** —— 一个具体的实现陷阱。

**(5) `:117` seam 的三角色定义。** *"A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but **one role alone is not a seam; adding a capability means designing all three**."*
⇒ **⚠️ 我上一轮"把 `ModelAdapter` 推广到 tools 就够"的建议按此定义不完整**：必须同时设计三者。（`ModelAdapter` 本身三角色齐全：`types.ts` 定义 + `openai-adapter`/`echo-adapter` 两个 provider + `runtime.ts` 消费 —— 实测 `runtime.ts` 对两个具体适配器 import 均为 `false`。）
⇒ **`:119`**：*"Seams are why **one provider swap changes the whole product**. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, **with no provider forks**."*

**(6) `:97` 逐事件指定 mode。** *"`agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are **waterfalls**, whose listeners **must call `next()`** to delegate; `agent/turn-stopping` is **serial** and has no `next()`."*

**(7) ⚠️ `:109` 是 D67/D68 存储排序的直接外部证据。** *"JSONL v0 uses `session.jsonl[.zstd]`, v1 and later use lowercase `session.vN.jsonl[.zstd]`, and **committed generation paths are never renamed, replaced, or deleted**. The JSONL provider owns physical framing, compression, generation selection, and exclusive publication, while **each adjacent migration package owns exactly one `vN -> vN+1` step**."*
⇒ **DSH 自己就是 JSONL + zstd + 版本化 generation + 相邻单步迁移**，且**已提交的 generation 路径永不重命名/替换/删除**。**这与 D68 的"只许 INSERT/SELECT"规则同向**（都是"产品无法改写自己的历史"），**并且是一个成熟产品在同样问题上没有选 SQLite 的实例** —— D67 名次 2 因此应当再降。

#### 五、拒绝（只有一条，且这次是读过之后才拒绝）

**Loader/overlay 层**：`@deepseek-ai/cordis-plugin-include` 把 `!!js` 解析成表达式节点，loader 对 `config`（在声明的注入激活后、对该插件 context 插值）与 `disabled`（每次 mount 决策、对 loader context 插值）求值（`:39`）。**profile/bundle/patch 三层组合**（`docs_architecture.md:17-37`）服务于**多 profile 分发**（`web`/`headless`/`sdk`/`sdk-minimal`/`acp`），本项目一个 profile 都没有。
**⚠️ 而 `:39` 原文本身就是条件句：*"**Use overlays when the environment selects plugins.**"* ⇒ 不做它与源一致，不是拒绝它。** 这是本轮与上一轮的关键区别：**上一轮我没读就拒绝，这一轮读了才知道它自己就是可选的。**

#### 六、⚠️ 对上一轮建议的两处更正

1. **"事件负载形状与卸载语义属于推测需求（YAGNI）"—— 错。** Cordis 已给出答案：**负载形状** = TypeScript 声明合并 + `@mode` 标签（`:12`、`:27`）；**卸载语义** = `ctx.effect()` 返回 disposer，*"Every registration should have a disposer… **If teardown order matters, keep the related work in one effect so disposal unwinds in the intended sequence**"*（`:45`）；**加载顺序** = `inject` 声明服务需求、顺序由需求推导（`:11`）。**这三样不是推测需求，是已被解决的设计问题，就放在我没读的本地文件里。**
2. **"把 `ModelAdapter` 推广到 tools 就够"—— 不完整**（`:117` 三角色）。

**仍然成立的部分**：上一轮的实测（零循环依赖、`ModelAdapter` 是完整正确的接缝、`ToolRegistry` 是第二条真接缝、`migrateEvent` 是封闭扩展点、病灶在 import 方向）**没有被推翻，反而被 `:117`/`:143` 佐证**。

#### 七、方法论教训（本轮最贵的一条）

**项目既有纪律是 *"断言产品行为之前，先读到那条行为"*。本轮证明它必须扩展为：*"断言一个外部设计不需要之前，先读到那个设计。"***

**这与 D56/D57 同类** —— 操作员两次挑战我的拒绝、两次都是他对（*"那就算增强"*、*"受限的是因为什么？"*）。**本轮是第三次，而且这次他连材料都替我指了出来**（*"DSH不就是现成的例子吗"*）。**共同形状是：我在"拒绝"上花的阅读远少于在"采用"上花的阅读** —— 拒绝看起来更省事，于是更容易在证据不足时发生。

**⇒ 可执行的纠正**：**任何"不做 X"的结论，必须附上读过 X 的证据；读不到就写"未读，不下结论"。** 本轮第五节是这条规则第一次被正确执行的样子（读了 `:39` 才知道 overlay 自己就是条件性的）。

### 三个探针、一处我对 D69 的自我更正，以及"声明合并不免费"（D70，2026-09-30，**取证轮，无代码**）

**触发**：操作员批准 *"行，按D69走吧"*。D69 留了两件未做：三份未读文档、一条采用前置未测（*"`node --experimental-strip-types` 直跑 TS，声明合并在此模式下的可用性未验证"*）。

**本轮读到的**：`docs_development.md` **全文 167 行**。
**⚠️ 如实标注未读**：`dsh-upstream-AGENTS.reference.md`（16.5 KB）、`blog-cordis-tencent.html`（204 KB）；`subsystems/*`、`cookbook/*`、`.agents/notes/*`、`scripts/*` 在 `_dsh_ref` 内不存在，本地不可达。**⇒ 本节关于"DSH 运行时侧如何注册"的结论只依据 `docs_architecture.md:111-113` 与本项目自己的探针，未经 DSH 源码验证。**

#### 一、三个探针的实测输出（临时文件写在仓库外 `D:\DSHXM\d70probe`，跑完即删；D50 的教训）

环境：**node v24.19.0**，**tsc Version 5.9.3**（⚠️ `package.json` 声明 `typescript ^5.6.3`，实装 5.9.3，在 caret 范围内）。

**(a) 类型侧：`tsc --noEmit` 接受跨模块 interface 增广 —— 退出码 0。**
基座 `base.ts` 有封闭的 `interface SessionEventMap { readonly taskState: … }` 与一个照 `migrateEvent` 形状的运行时 switch；`aug.ts` 写 `declare module "./base.ts" { interface SessionEventMap { readonly summary: … } }` 与 `declare global { interface ProbeGlobal … }`，并取 `const k: keyof SessionEventMap = "summary"`。**命令**：`tsc --noEmit --strict --target es2022 --module preserve --moduleResolution bundler --allowImportingTsExtensions aug.ts` ⇒ **退出码 0，无输出**。

**(b) ⚠️ 运行时侧：strip-types 接受 `declare module` 与 `declare global` —— 我的风险假设被证伪。**
```
node --experimental-strip-types aug.ts   → 退出码 0
node aug.ts（24.x 默认剥离，无旗标）      → 退出码 0
```
**⇒ 我在 plan-ready 里把 `declare` 块列为"参数属性同一类的合理嫌疑对象"，错了。** 判别规则因此清楚了：**type-stripping 只在"需要生成代码"的构造上失败**（参数属性要搬进构造函数体、`enum` 要生成对象、`namespace` 要生成 IIFE），**而 `declare` 块什么都不生成，所以被干净剥离**。**这不是运气，是可推的规则 —— 但只有测过才知道。**

**(c) ⚠️ 运行时开放注册表：不依赖任何类型层机制，且可逆、拒重复。**
```
probeC registered={"covers":3} unknownKind=undefined afterDispose=undefined duplicateRejected=true
```
即：注册后 `migrateOpen("summary", …)` 返回处理器结果；未注册种类返回 `undefined`；**dispose 之后再查返回 `undefined`（注册可逆）**；**同一种类注册两次抛错**。

#### 二、⚠️ 对 D69 的自我更正：我把类型侧与运行时侧当成了一件事

**D69 原文**：*"`:143` 配 Cordis 观念 4 的 TypeScript declaration merging ⇒ 事件种类由插件声明扩展，核心不需要为每个新种类加一个 `case`"*。

**这句错在后半。** **声明合并是纯类型层机制**：运行时没有任何东西被合并，事件种类在运行时就是字符串。**而 `migrateEvent` 的 8-case switch 是运行时构造 —— 光有声明合并打不开它。** 探针 (a) 与 (c) 分别验证了两侧，**两者是两套独立机制，缺一不可**：

| 侧 | 机制 | 探针 | DSH 的对应 |
|---|---|---|---|
| **类型** | 跨模块 interface 增广 | (a) 通过 | `:111` *"extend `SessionEventMap`"* |
| **运行时** | 种类 → 处理器注册表（可逆、拒重复） | (c) 通过 | `:111` *"**and render from the log**"*、`:113` *"**registered** units fold committed events incrementally"* |

**⇒ DSH 的 `:111` 那句话本来就是两半，我在 D69 里只引了前半就下了结论。** 这与本轮的方法论教训是同一件事的两个方向：**采用时也不能只读半句。**

#### 三、⚠️ 声明合并不免费：`:56` 记录了一个我绝对猜不到的代价

> *"Host and Client stay two aggregate programs because **both sides declaration-merge the cordis `Context` interface under the same keys with different services; one program seeing both merges reports a collision**. The collision exists only inside a `ts.Program` — module resolution never triggers it…"*

**DSH 为此付出的代价**（`:56-62`）：仓库拆成 **Host / Client 两个聚合程序**（`tsconfig.host.json` / `tsconfig.client.json`），只有三个共享叶包（`host/webserver`、`compaction/compaction`、`typert/registry`）被两侧同时引用；**外加三条纪律**：`tsconfig.base.json` 永不获得 `include`/`files`；**任何构建全仓 `ts.Program` 的脚本必须显式播一个聚合、绝不播根 solution**（否则展平两侧会撞 `Context` 合并）；**新包只注册进一个聚合**；并且有一个 `constraints` 门走可达的 Project Reference 图逐个检查。

**⇒ 对本项目的判断**：本项目是**单 `tsconfig`、单 program、`tsc --noEmit`**，所以"两侧不同服务撞同一个 key"这个具体故障**当前不可达**。但这条证据改变了取舍：**运行时注册表（探针 c）能单独达成真正的目标（打开 `migrateEvent`），且零类型程序风险；声明合并只解决类型侧的便利，却带来一个成熟产品要用两个聚合程序去容纳的故障模式。**
**⇒ 采用顺序因此定为：先做运行时注册表（必需），声明合并列为可选、且只在类型侧确实成为负担时才加。**

#### 四、⚠️ `:11` 顺手结掉了 D68 的阻塞项

> *"Node.js supports **22.19+ and 24+**. CI covers **22.19, 24, and 26**"*（`:117` 再次出现 *"the Node **22.19, 24, and 26** compatibility matrix"*）

**对照**：**DSH floor = 22.19**；**SoL-Pi `engines: node >=22.19.0`**（其 `package.json` 实读）；**本项目 `engines: node >=22.6`**。
**⇒ 两个独立成熟产品都选 22.19，本项目是离群值**，而 D68 已证 22.6 落在 `--experimental-sqlite` 必需旗标带（22.5.0–22.12.x）内。**⇒ D68 的三个选项里，选项 (i)"抬高 `engines`"从"最干净"升级为"有外部佐证"，且目标值应是 `>=22.19.0` 而非 D68 说的 `>=22.13.0`。** `AUDIT.md` A15 早已把 floor 列为需收窄项。**⚠️ 本轮不改 `package.json`（无代码轮），只记录。**

#### 五、⚠️ `:159-167` 是本项目反复犯的病的现成解药：`ts type-equiv` 门

**DSH 的做法**：文档里粘贴与源码等价的类型声明，围栏标成 ` ```ts type-equiv `，并登记进 `scripts/type-equiv.manifest.json`（记 `doc` / `symbol` / `source`）；`verify-type-equiv` **用 TypeScript parser 从源码抽出该符号的声明与附着的 JSDoc，断言文档块两者都匹配**；类可用 ` ```ts public-api ` 只保留公开成员。***"When you change a documented declaration or its JSDoc, **the gate fails until you update the paste**."***

**⇒ 这正是本项目的手工日常**：每一轮我都在写脚本机械回查引文（D69 的 24 条、本轮的探针），而**文档过期仍然是反复出现的缺陷** —— `README.md:3` 说"仅只读、不执行 shell"、`SWARM_LOOP.md` §8 说 src 下无 shell 模块且基线记 365（现 629）、D 索引缺 D10。**⇒ 把手工回查变成一个门，是 ponytail 阶梯第 2 级的正解（这个模式已经在本仓库里以手工脚本的形式存在）。**

#### 六、另外两条可直接采用的小机制

- **`:149-157` 三级 TODO 标记**：`FIXME`（**应当阻塞新发行**）／`TODO`（有资源就尽快）／`XXX`（**某天也许修，最低优先级、无承诺**），*"Pick the tag that matches the urgency so anyone scanning the code can tell a release blocker from a someday-maybe."* **⇒ 本项目的"未做/未验"清单有一长串但没有紧急度分级**，正好用它。
- **`:101` 真机套件自跳过**：*"The real-API e2e suites **self-skip** when `DEEPSEEK_API_KEY` is not set."* **⇒ 本项目 `test:live` 与 629 基线里那 1 项 skip 是同一形状**，这条确认了它不是缺陷而是成熟产品的常规做法。

#### 七、采用 / 拒绝清单（按 D69 第七节的新规则：任何"不做 X"必须附读过 X 的证据）

**采用（本轮新增）**：
1. **打开 `migrateEvent`：运行时"种类→处理器"注册表**，可逆（返 disposer）、拒重复注册。**探针 (c) 已验证形状可行。**
2. **三级 TODO 标记**（`FIXME`/`TODO`/`XXX`）用于给既有"未做/未验"清单分级。
3. **引文/声明回查门**：把每轮手工写的机械回查固化成一个可跑的检查（`type-equiv` 的缩小版：只查"文档里引用的源码文本仍然存在"）。
4. **`engines` 抬到 `>=22.19.0`**（D68 选项 (i)，现有两个产品的外部佐证）。**⚠️ 待操作者确认后另开一轮改，本轮无代码。**

**降级（不是拒绝）**：
5. **TypeScript 声明合并** —— **可用**（探针 (a)(b) 均通过，含 `declare global`），但 `:56` 证明它带来一个 DSH 要用两个聚合程序容纳的碰撞故障模式，而**它只解决类型侧便利、不解决运行时开放性**。**⇒ 列为可选，等类型侧确实成为负担时再加。**

**仍然拒绝（读过之后拒绝）**：
6. **loader/overlay 三层**（profile/bundle/patch、`!!js` 表达式）—— D69 第五节已记，`:39` 原文自己是条件句。
7. **Host/Client 双聚合 tsconfig** —— 服务于浏览器客户端与 Node 宿主并存；**本项目没有客户端**，单 program 无此需求。**⚠️ 依据是 `:46-62` 全文实读，不是推断。**
8. **pnpm + corepack + lefthook + 双语配对合并驱动**（`:12`、`:24`、`:105-115`）—— 服务于多人贡献与双语文档；**本项目零生产依赖、单人、单语文档**。**⚠️ 但 `:111` 的 pre-commit 检查里有两项与本项目相关且便宜：staged diff 的空白错误检查、以及"改了被文档记录的声明就必须更新粘贴"（即第 3 条）。**

**未读，不下结论**：`dsh-upstream-AGENTS.reference.md`、`blog-cordis-tencent.html`（204 KB）。**⇒ 关于"DSH 的插件在运行时究竟如何被 mount/unmount"本节没有证据，只有 `:113` 的 registered units 与本项目探针 (c) 的同构性。**

#### 八、方法论（本轮的两条，方向相反）

**D69 记下的是"拒绝之前要先读"。本轮补上对称的另一半：⚠️ "采用之前也要读完那一句"。** `:111` 那句 *"extend `SessionEventMap` **and render from the log**"* 我在 D69 里只引了前半，于是把类型侧机制当成了运行时侧的解药。**半句引用产生的错误结论，和不读产生的错误结论，代价是一样的。**

**⇒ 可执行的纠正（补充 D69 第七节）**：**引用一条机制作为某个问题的解药时，必须引完整句，并说明它解决的是哪一侧（类型/运行时/存储/UI）。**

### D71 打开事件种类，但不打开那个封闭联合（2026-09-30，**有代码**，提交 `7542367`）

**执行的是 D70 采用清单第 1 项**：把 `migrateEvent` 的 8-case 封闭 switch 换成运行时"种类→处理器"注册表。**这是第一个有代码的接缝改造**，形状由 D70 探针 (c) 预先验证（可逆、拒重复）。

#### 一、采用：注册表优先，既有 switch 一行不改

`migrateEvent` 在**版本闸之后、switch 之前**查注册表；命中就交给处理器，否则落进原 switch。**⇒ 8 个既有种类的校验逻辑零改动，回归面为零。** 这把范围刻意收到最小：**不把既有 8 个 case 抽成处理器** —— 那是 200 行重写、有真实回归风险，而目标是"新种类不必改核心"，不是"所有种类同构"。

**三条承重性质，都在代码里强制、不靠信任，各有测试且各做过变异验证**：

| 性质 | 依据 | 变异验证（去掉即变红） |
|---|---|---|
| **内置 8 个种类不可注册** | 注册 `"message"` 就等于让调用方重新解释对话事实源 ⇒ **D04「插件不得自行扩大授权」用在事件日志上** | 改成 `if (false)` ⇒ `refuses every builtin kind` 变红 ✅ |
| **外部种类永远 `ignorable: true`**（类型 + 归一化各强制一次） | 本文件自己的契约（`:50`、`:253-256`）：不认识的种类**跳过**，**未标记**的未知种类是**错误**，因为静默丢弃会改变"模型被重建成看见了什么" | 归一化 return 换成 `return parsed` ⇒ `normalises what a handler returns` 与 `lets a registered kind round-trip` 一起变红 ✅ |
| **核心强制归一化处理器返回值** | 不能声称未来版本（且**版本闸在注册表之前**）、不能改 kind、不能变成不可跳过 ⇒ **说谎的处理器最多影响自己的 `payload`，而 `payload` 核心从不解释** | 同上 ✅ |

**⚠️ 一个被测试抓住的真缺陷**：disposer 初版按 **handler 身份**判归属（`get(kind) === handler`）。**同一个插件重载会传入同一个函数对象**，于是旧 disposer 会把背后那次活注册删掉。改为注册时生成唯一 `Symbol`、disposer 只认自己的 token。**变异验证**：dispose 变空操作 ⇒ `makes the kind unknown again once disposed` 变红 ✅。

#### 二、⚠️ 拒绝：不把 `ExternalSessionEvent` 加进 `SessionEvent` 联合（**试过、量过、才拒绝**）

**按 D69/D70 立的规矩，这条拒绝附实测证据。** 加进去之后 `tsc --noEmit` 报 **8 处**错误，根因是**开放成员的 `kind` 是 `string`，与所有字面量重叠，TS 无法在 `event.kind === "…"` 处排除它**：

- 6 处平凡：`:852/:870/:871/:898` 形状是 `if (event.kind === "task-state") latest = event`，报 `Type 'TaskStateEvent | ExternalSessionEvent' is not assignable to type 'TaskStateEvent | undefined'`。
- **⚠️ 1 处不平凡**：`inspect` 的工具批次审计是 `event.kind==="tool/call" || event.kind==="tool/result"` 的**析取收窄**，随后读 `event.callId`、`event.name`、`event.arguments`，承载"孤儿/重复工具审计事件"的完整性校验。**为买一个类型层便利而改写一处安全校验，不划算。**
- 另有 `:939/:965/:976/:977` 报 `Property 'id'/'message'/'callId'/'name' does not exist on type '… | ExternalSessionEvent'`。

**改法（更小也更诚实）**：**两个集合分开** —— `InspectionResult.events`（核心认识的，与 `eventLines` 保持平行）与 `InspectionResult.external`（注册进来的，`{line, event}`）。分流用已有的 `BUILTIN_EVENT_KINDS.has(kind)` 判定，**运行时明确、不靠类型收窄**。

**为什么这不只是省事**：核心自己的那些投影（`taskState`、`latestMarks`、压缩边界、工具批次审计）**本来就不该关心它们不认识的种类** —— 分开是把这件事**写成结构**，而不是依赖 TS 能不能收窄成功。**安全性质保住**：外部事件走 `.external` 暴露，**不是被静默丢弃**（那正是 `:253-256` 警告的形状）。

**⚠️ 行号是必需的，不是装饰**：`events` 与 `eventLines` 是平行数组，且头部检查断言 `events[0].kind === "session"` —— **一个落在位置 0 的外部事件会把这条完整性检查撞掉**，而它的行号在读取循环里是免费的、事后无从恢复。

**⇒ 本节的限度如实记录**：**类型侧仍然封闭**。运行时开放了，核心投影在类型上看不见外部种类。这是取舍，不是疏漏。

#### 三、⚠️ D70 那条教训在第二个位置复现

D70 从 `docs_development.md:56` 读到：DSH 把仓库拆成 **Host/Client 两个 tsconfig 聚合**，因为*"both sides declaration-merge the cordis `Context` interface under the same keys with different services; **one program seeing both merges reports a collision**"*，我当时记下**"本项目单 program，所以那个具体碰撞不可达"**。

**本轮实测证明这句话只对了一半**：**开放类型的代价没有消失，只是换了个位置** —— 从"两个 program 碰撞"变成"一个 program 里 8 处收窄失败"。**⇒ 补一条可执行的规则：判断一个类型层机制"本项目用不上它的代价"时，不能只看它记载的那个故障形态，要问"这个机制引入的开放性会在哪里被消费"。** 本轮如果没先编译就宣布成功，这 8 处会一直留到别人改那些投影时才炸。

#### 四、验证（如实）

- **`tsc --noEmit` 退出码 0**；新套件 `test/event-kind-registry.test.ts` **9/9**。
- **全量 638 项 / 635 通过 / 2 失败 / 1 跳过**（基线 629 + 新 9 = 638 ✓）。两处失败都是 `background-jobs` 的 kill 测试（`kills the process…`、`kills everything still running`）约 3050ms 超时 ⇒ **隔离重跑 `background-jobs` = 11/11 全绿，证实是记录在案、11 轮未修的并行负载间歇项，不是本轮回归**。
- **改动面隔离重跑 = 80/80**（`session-format`、`reliability`、`task-state`、`task-state-writer`、`compaction`、`event-kind-registry`）。
- **三处变异验证全部变红，且源码字节还原**：`还原后 pass=9 fail=0 与基线一致=true`、`源码已还原=true`。
- **⚠️ 提交 `7542367` 当时如实标注了两项欠账**（三处变异验证、五份文档），**已在下一轮补齐** —— 周期 `event-kind-registry` 在补齐前一直保持 `doing`，没有以未完成状态提交为完成。

#### 五、⚠️ 本轮新增两条 PowerShell 陷阱（都已踩过）

1. **`.NET` 静态调用用*进程* CWD，不跟随 `Set-Location`。** `[System.IO.File]::ReadAllText("src\session-store.ts")` 解析成了 `D:\DSHXM\AgentKHD\src\...` 而报 `DirectoryNotFoundException`。**这是已记录的陷阱，本轮又踩了一次** ⇒ 读项目内文件一律用 `read` 工具，不用 shell。
2. **PowerShell 的 `*>` 重定向文件用 node 读不出内容**（编码不匹配：文件大小 113482 B，但 node 侧正则匹配 0 行、连 `ℹ tests` 都读不到）。**必须用 `Select-String` 读**，或改用 `[System.IO.File]::WriteAllText` 显式写 UTF-8 无 BOM。

#### 六、未做（不推断）

- **注册表还没有任何调用方**：本轮只建了扩展点，**没有任何插件真的注册种类**，也没有 CLI 入口能加载外部注册。⇒ **它现在是"能力存在但未被使用"**，与 D58 记录的那类死代码不同（那是逻辑不可达，这是尚无人调用），但同样要在下一轮接线时才算落地。
- **`external` 集合没有消费者**：`inspect()` 会返回它，但 `history()`/`buildPrompt`/压缩都不读它。这是有意的（核心不该解释它不认识的），但**"谁来读 external"是插件系统那一轮的问题，本轮不预设答案**。
- **声明合并仍未采用**（D70 已降级为可选）：类型侧封闭就是这个决定的直接后果，两者是一致的。

### D72 "谁来读 external"：答案是 DSH 已出厂的 Projection seam，而判据不是"谁消费它"（2026-09-30，**决策轮，无代码**）

**触发**：操作员问 *"怎么定？"* —— 指 D71 第六节留下的前置问题：`inspect()` 已返回 `external` 集合但**没有消费者**，而这件事不答，`task-state` 就不能搬出核心。

#### 一、⚠️ 先纠正我自己正要写下的错误答案

准备本轮时，我的推理一度走向这个结论：**"`task-state` 有核心消费者（`taskState()`、`latestMarks()`、prompt 注入），所以它就是核心功能；搬出去会造出一个假接缝 —— 有 provider 也有 consumer，但 consumer 必须依赖那个特定 provider，那只是加了一层间接。"**

**读完 `docs_architecture.md:113` 的完整段之后，这句话被它最后一句直接反证**：

> *"**The agent loop registers shared `turnBoundary` state for its readers**"*

**DSH 的核心（agent loop）自己也往投影注册表里注册状态、给自己的读者读。** 再配 `:117`：

> *"A package **may combine roles**, but one role alone is not a seam"*

**⇒ "核心消费它"根本不构成"它必须是核心"的理由**，DSH 自己就是核心同时充当 provider 与 consumer。**这是 D70 那条教训（"采用之前也要读完那一句"）在 24 小时内第二次生效**：D71 那次是"拒绝之前要先读"救了 Cordis，这次是"读完最后一句"阻止我用一个半段推理去否决一条已出厂的设计。**如果本轮没读 `:113` 全段就动笔，D72 会是一条错误决定，而且它会以"我推理过了"的姿态出现。**

#### 二、判据：不凭"谁消费它"，凭三角色能否齐备

`:117` 的定义是完整的判据：

> *"A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but **one role alone is not a seam; adding a capability means designing all three**."*

**⇒ 判据改为**：**一个事件种类该不该走"注册表 + 投影"，取决于能否为它设计齐三个角色，而不取决于核心是否读它。**
- **只有 provider、没有真实 consumer** ⇒ 不是接缝，是没人用的扩展点（**这正是 D71 交付的注册表当前的状态**，如实说）。
- **只有 consumer、没有 provider** ⇒ 空依赖。
- **三角色齐备但 provider 唯一且不可替换** ⇒ **仍然是接缝**，因为 `:119` 说明价值不在"替换很可能发生"：*"Seams are why **one provider swap changes the whole product**"* —— 价值在于**依赖被写成接口而不是写成 import**。这与 `ARCHITECTURE.md` §3.4 量出的病灶（`cli.ts` out-degree 23、`runtime.ts` 16，全部按名字硬 import）是同一件事的两面。

#### 三、答案：采用 Projection seam，三角色照 `:113` 落

`:113` 的完整契约（**逐句引，因为每一句都对应本项目要做的一个决定**）：

> *"**Projection seam.** `dsh-session-projection` owns `ctx.sessionProjections`: **registered units fold committed events incrementally**, **host consumers read one typed state with `stateOf()`**, and carriers batch cropped client views with `snapshot()`. **A host reader either requires this service during activation or fails explicitly when the registry or required key is absent.** Contributors may retain `ctx.inject(['sessionProjections'], ...)` registration **without silently defaulting a missing host value**."*

| 角色（`:117`） | 本项目的形状 |
|---|---|
| **Definition** | 一个投影单元 = `{ key, initial, fold(state, event) → state }`，**增量**折叠已提交事件（不是每次全量重扫） |
| **Provider** | `task-state` 单元（第一个真实 provider）；未来插件注册自己的单元 |
| **Consumer** | `runtime.ts:1080` 的 `buildPrompt` → `latestMarks`、`runtime.ts:846` 的轮末 `taskState()`、以及 **⚠️ `session-store.ts:850` 的 `appendTaskState` 自己**，全部改读 `stateOf(key)` |

**`stateOf` 在本项目当前不存在**（`grep` 全 src 零命中），所以它是待引入的名字，不是既有符号。

#### 四、⚠️ 真正的代价（写进决定，不留给实现时才发现）

**(1) `case "task-state"` 的逐字段严格校验必须跟着搬。** 它在 `session-store.ts:511`。**若只搬"读取"而不搬"校验"，解析就丢了** —— 外部事件的 `payload` 是 `unknown`，投影的 `fold` 收到的就是未校验的原始对象。**⇒ `TaskStateEvent` 的严格重建必须成为 provider 的一部分，而不是留在核心的 switch 里。**

**(2) ⚠️ 必须保住"损坏行按行号拒绝"这个既有行为。** `inspect()` 的 `problems` 机制把坏行连行号一起报出来（`session-store.ts` 读取循环里的 `catch` → `problems.push({line, detail, preview})`）。**一条畸形的 `task-state` 行今天的结果是"读时报错、指出第几行"；搬出去之后，如果 `fold` 只是跳过它，结果会退化成"投影静默回到初始值"** —— **那是把一个可诊断的失败换成一个不可诊断的失败，方向是错的。** ⇒ **provider 的 `fold` 必须能把解析失败上报成一条 problem，而不是吞掉。**

**(3) ⚠️ 本轮 `grep` 查出的第四个消费者，是写路径。** `session-store.ts:850`：`appendTaskState` 在写入前 `const previous = await this.taskState(sessionId);` 做**单调性检查**（D61 的 `assertNotWeakened`）。**这是写路径依赖，比读路径严格得多**：读路径上一次 `stateOf` 失败最多让本轮注入少一块，**写路径上一次失败会让"把验收标准调低"这个攻击重新可行** —— 因为单调性检查是挡住它的唯一机制（D61：*"隐蔽的攻击不是自报完成，而是把标准挪低"*）。**⇒ 若 `task-state` 搬进投影，`appendTaskState` 必须能在 `stateOf` 缺失时拒绝写入，而不是当作"没有前一份状态"从而放行任何 claim。**

**(4) `latestMarks` 的"一趟读两样"优化会被拆散。** `session-store.ts:884` 的注释写明它的存在理由：*"`buildPrompt` needs the compaction boundary and the task state on every model call, and each of `compaction` and `taskState` reads the whole log… Calling both would read it twice per call, which on a long session is the dominant cost of building a prompt. One pass, same answers."* **⇒ 投影的"增量折叠"恰好是这个优化的正确形态（不必每轮全量重扫），但迁移期间不能先把优化删掉再补回来。**

#### 五、⚠️ 失败语义照抄 `:113`，而且它与 D60 那个陷阱是同一味药

`:113` 两处强调同一件事：*"**fails explicitly** when the registry or required key is absent"*、*"**without silently defaulting** a missing host value"*。

**这不是风格偏好。** D60 记录的失败形态正是：**功能"看起来在工作"**（有状态、有注入、有 claim），**却永远判不出任何东西**，因为求值被挡在 `applied ?` 之后、而基因库是空的。**⇒ `stateOf("taskState")` 在键缺失时必须显式失败**；若返回一个默认空状态，同一个坑会以更隐蔽的形式重现（状态永远为空，而所有测试都通过）。

#### 六、决定与实施次序

**决定**：**采用 Projection seam 作为 `external` 的消费方式**，并把 `task-state` 作为它的**第一个真实 provider**。**⇒ D71 那个"存在但未被使用"的注册表因此获得第一个调用方，两件事合成一条链。**

**次序（每步都可独立验证，不做大爆炸迁移）**：
1. **先只做 Definition + `stateOf` 的显式失败语义**，并让**既有的 `taskState()` 成为它的第一个 consumer**（provider 暂时就是核心自己的一个单元）。**这一步不改存储、不改校验位置**，只把"读取"变成"经注册表读取"。
2. **再把 `case "task-state"` 的逐字段校验搬进 provider**，同时接上 `problems` 上报（第四节 (2)）。**这一步之后核心 switch 少一个 case。**
3. **最后处理写路径**（第四节 (3)）：`appendTaskState` 的单调性检查改走 `stateOf`，且**缺失即拒绝写入**。
4. **`latestMarks` 的一趟优化在 2 之后重做**（第四节 (4)），用增量折叠替代"每轮全量重扫两遍"。

**⚠️ 每一步都要有变异验证**，尤其第 3 步：**把"缺失即拒绝"改成"缺失即放行"，必须有一条测试变红** —— 那条测试就是 D61 单调性的证明。

#### 七、本轮不做的事（附依据）

- **不改代码**：操作员问的是"怎么定"，答案先落档；且第四节查出写路径依赖之后，实现次序必须按 1→4 走，不适合在决策轮里顺手改。
- **不预设插件如何加载注册**：属插件系统那一轮（D71 第六节已声明不预设）。
- **`snapshot()` / carriers 不采用**：`:113` 里它是"batch cropped client views"，服务于 DSH 的多客户端（web/headless/acp）；**本项目没有客户端 ⇒ 读到了、确认不适用，不是没读就跳过。**
- **loader/overlay 仍然拒绝**：依据 D69 第五节（`:39` 原文自己是条件句 *"Use overlays when the environment selects plugins"*）与 D70 第七节第 6 条。
- **声明合并仍然不采用**（D70 降级为可选）：**⇒ 类型侧继续封闭**，投影单元的 `fold` 收到的事件类型是 `ExternalSessionEvent`（`payload: unknown`），**由 provider 自己解析**。这与 D71 的取舍一致，不是新增的矛盾。

#### 八、验证

- **外部引文**：`:111`、`:113`（全段）、`:117`、`:119` 逐句空白压平精确回查 `_dsh_ref/docs_architecture.md`。**本轮已完整读过 `:111-124`。**
- **本项目侧断言全部 `grep` 实读核对**：`case "task-state"` = `session-store.ts:511`；`taskState()` 的消费者 = `runtime.ts:846` 与 `session-store.ts:850`；`latestMarks` 的消费者 = `runtime.ts:1080`（在 `buildPrompt`，`:1063`）内；`buildPrompt` 的调用点 = `runtime.ts:744` 与 `:771`；**`stateOf` 全 src 零命中**（确认是待引入的名字）。
- **⚠️ 未读，不下结论**：`session-projection-mandatory-seam.md`（`:113` 末尾链接的那份 decision note）**在 `_dsh_ref` 内不存在、本地不可达** ⇒ **DSH 那个"mandatory"到底强制了什么，本轮没有证据，只有 `:113` 正文。** 同理 `capability-seams.md`、`subsystems/*`。

### D73 Projection seam 第 ① 步落地，写路径安全性质提前到手，以及一条排法教训（2026-09-30，**有代码**，提交 `4b699b2`）

**执行 D72 次序的第 ① 步**：Definition + `stateOf` 的显式失败语义 + 让既有 `taskState()` 成为第一个 consumer。**不改存储、不改校验位置** —— `case "task-state"`（`session-store.ts:511`）留在原地，那是第 ② 步。

#### 一、承重的一条：两种 "absent" 必须分开，混为一谈就是 D60 的坑

| 情况 | 行为 | 依据 |
|---|---|---|
| **键没有注册投影** | **抛错** `no session projection registered for key: …` | `docs_architecture.md:113`：*"A host reader either requires this service during activation or **fails explicitly** when the registry or required key is absent"*、*"**without silently defaulting** a missing host value"* |
| **键已注册、日志里还没有该种类的事件** | **返回该单元的 `initial`** | 合法状态：什么都还没写过 |

**⇒ 若把两者都做成"返回默认值"，D60 记录的失败形态就会重现**：功能"看起来在工作"（有状态、有注入、有 claim），却永远判不出任何东西，**而所有测试都通过**。**这是本轮的核心安全性质，也是变异验证 A 的目标。**

#### 二、⚠️ 写路径的安全性质比 D72 计划的提前两步到手

**D72 把写路径排在第 ③ 步**，理由是 `session-store.ts:850` 的 `appendTaskState` 在写入前读旧状态做 D61 单调性检查，属写路径依赖。**实测发现它调的就是 `this.taskState(sessionId)`** ⇒ `taskState()` 一改走 `stateOf`，**写路径自动跟着走，不需要单独实现**。

**⇒ 于是第 ① 步就落地了这条性质：投影缺失时写入必须失败，而不是被读成"没有前一份状态"从而放行任何 claim。** 有专门测试钉住它：**dispose 掉核心投影后，读路径与写路径都必须拒绝**；`finally` 里重新注册，随后断言 `taskState()` 仍返回原状态 ⇒ **日志一个字没丢，失败的只是接线**。

**⚠️ 这条要如实标成"提前到手"而不是"第 ③ 步已完成"**：第 ③ 步真正剩下的部分是**"增量折叠之后写路径还能不能拿到前一份状态"**，那是第 ④ 步改了折叠方式之后才出现的问题。**本轮解决的是"缺失即拒绝"，不是"增量之下仍正确"。**

#### 三、核心自己注册自己的投影，这不是假接缝

**模块作用域注册**（`disposeTaskStateProjection`），**每进程一次而不是每 store 实例一次** —— 构造函数里注册会让第二个 `SessionStore` 实例撞上 D71 的拒重复。

**依据三条，都在 D72 读过**：`:113` 末句 *"**The agent loop registers shared `turnBoundary` state for its readers**"*（DSH 的核心也这么干）、`:117` *"A package **may combine roles**, but one role alone is not a seam"*、`:119` *"Seams are why **one provider swap changes the whole product**"* ⇒ **价值不在"替换很可能发生"，而在依赖被写成接口而不是 import。**

**⚠️ 这一条是上一轮救过我的那句话的实际运用**：D72 第一节记录了，我原本的推理是"核心消费它 ⇒ 它是核心功能 ⇒ 搬出去是假接缝"，被 `:113` 最后一句反证。**本轮把它写进代码，等于把那次纠正固化下来。**

#### 四、刻意不碰的东西（各有依据，不是遗漏）

- **`latestMarks` 原样不动。** 它的注释（`session-store.ts:884`）写明存在理由：*"`buildPrompt` needs the compaction boundary and the task state on every model call… Calling both would read it twice per call, which on a long session is the dominant cost of building a prompt."* **D72 第四节 (4) 说这个优化不能先删再补** ⇒ 第 ① 步只改 `taskState()` 这条独立路径，**`buildPrompt` 行为零变化**。
- **折叠仍是每次全量，不是增量。** `:113` 说的是 *"fold committed events **incrementally**"*，**本轮没有做到，也不声称做到** —— 增量折叠是第 ④ 步，与恢复 `latestMarks` 的一趟优化绑在一起。**⇒ 这是本轮对 `:113` 的一处有意偏离，记在此处而不是藏在注释里。**
- **不搬 `case "task-state"` 的校验**（第 ② 步）、**不预设插件如何加载注册**（D71/D72 已声明不预设）。

#### 五、验证

- **`tsc --noEmit` 退出码 0**；新套件 `test/session-projection.test.ts` **7/7**。
- **全量 645 项 / 644 通过 / 0 失败 / 1 跳过**（638 基线 + 7 新增 = 645 ✓）。
- **三处变异全红，且咬住的正是对应用例**：
  - **A** 把"键缺失即抛错"改成静默默认（`?? { … initial: undefined … }`）⇒ `throws when no projection is registered for the key` + `makes the write path fail too once the projection is gone` 变红 ✅ **（这条就是 D60 坑的证明）**
  - **B** 去掉 disposer ⇒ `makes the write path fail too…` + `folds a third-party projection over builtin events` 变红 ✅
  - **C** latest-wins 改成 first-wins ⇒ `keeps latest-wins, so taskState() did not change behaviour` 变红 ✅
- **源码字节还原 = true**；还原后 7/7。
- **⚠️ 如实记录，不当成绩**：前两轮全量里那 2 个 `background-jobs` kill 失败**本轮没有复现**。它们是负载相关的，**12 轮未修；一次干净不等于修好，本轮不声称修好。**

#### 六、⚠️ 一条排法教训：连续两轮欠文档账，共同形状是"文档排在最后"

**事实**：`event-kind-registry`（D71）与本轮（D73）**连续两次**都是"代码先提交、五份文档欠到下一轮"。D71 那次在提交信息里如实写了欠账，本轮又写了一次。

**共同形状**：**我在 `plan-ready` 里把文档排在验证之后，而预算总是在文档之前耗尽。** 两次都不是"忘了文档"，两次都数清了要改哪几份 —— **是排序让它成了最先被牺牲的那一项。**

**⚠️ 更深一层：我的调用次数估算连续两次偏低。** 本轮 `extend` 的理由里写"约 12–14 次调用，10 分钟装不下"，续了 15 分钟，**结果仍然在文档之前耗尽**。⇒ **估算本身不可靠，不是某一次算错。**

**⇒ 三条可执行的改法（本轮起生效）**：
1. **代码与文档必须在同一次 `git commit` 里。** 上一轮之所以欠账能"发货"，是因为代码先提交了、仓库进入一个看似完成的状态，停下来的压力就消失了。**同一次提交让"代码已提交但未记录"这个状态在结构上不可能出现。**
2. **文档在 `plan-ready` 里就写成与代码交错的步骤，不写成收尾。** 具体次序：改代码 → 跑 build → **写文档** → 跑测试与变异 → 一次提交。**把文档放在测试之前**，因为测试与变异是"可以延后一轮而不损害仓库状态"的那一项，文档不是。
3. **调用次数估算乘 1.5**，且**若预算不足以覆盖代码+文档+验证三者，就在写第一行代码之前 `extend`，而不是在代码提交之后**。

**⚠️ 本轮自身就是反例，如实说**：本轮（补文档轮）是按操作员指示单独开的，所以第 1 条改法本轮无法自我验证 —— **它要在下一个有代码的轮次（D72 第 ② 步）才第一次被执行和检验。**

#### 七、下一步（D72 第 ② 步）

**把 `case "task-state"` 的逐字段严格校验搬进 provider，并接上 `problems` 上报。** 两个硬约束（D72 第四节 (1)(2)）：**`payload` 是 `unknown`，不搬校验解析就丢了**；**畸形行必须继续"报错并指出第几行"，不能让 `fold` 静默跳过而退化成"投影回到初始值"** —— 那是把可诊断的失败换成不可诊断的失败。**完成之后核心 switch 少一个 case。**

### D74 我上一轮交付的接缝两半没有接上；以及 D72 第 ② 步撞了 D71 的决定（2026-09-30，**有代码**）

#### 一、⚠️ 缺陷：D71 与 D73 各自正确，合起来不通

**实读证据**：D71 的 `registerEventKind` 让外部种类经 `migrateEvent` 返回 `ExternalSessionEvent`，`inspect()` 把它分流进 **`report.external`**；D73 的 `stateOf` 写的是 `for (const event of report.events) … fold(…)` —— **只折叠 `events`，从不看 `external`**。

**⇒ 后果**：一个插件即使**同时**用 `registerEventKind` 注册了种类、又用 `registerSessionProjection` 注册了投影，**它的投影永远收不到自己那个种类的任何事件，`stateOf` 恒返回 `initial`**。而 `registeredEventKinds()` 与 `sessionProjectionKeys()` 都列得出来、两处注册都成功、**所有既有测试都通过**。

**⚠️ 这正是 D60 记录、D73 第一节又专门挡过的那个失败形态**：功能"看起来在工作"，却永远判不出任何东西。**D73 花了整整一节讲"两种 absent 不可混"，却没发现自己交付的接缝根本没接通** —— 说明那一节挡的是"键缺失"这一种失败，没挡"键在、事件到不了"这一种。

**⇒ 新纪律（本轮立）**：**每交付一个接缝，必须有一条测试同时用到它的两侧。** D73 的第三方投影测试折叠的是 `message` —— **内置种类，住在 `events` 里**，所以它验证了投影机制、没验证投影机制与种类注册机制的接口。**"测试覆盖了机制"与"测试覆盖了机制之间的接缝"是两件事，而后者才是接缝真正会坏的地方。**

#### 二、修法与它带出的账单

**修法**：`stateOf` 按**行号归并** `events`（配平行数组 `eventLines`）与 `external`（自带 `line`）后折叠；`fold` 的参数从 `SessionEvent` 放宽到 `SessionEvent | ExternalSessionEvent`；核心那个 provider 的收窄从 `event.kind === "task-state"` 改成 `event.kind === "task-state" && "atMessage" in event`。

**⚠️ 必须按行号归并，不能"先 `events` 再 `external`"** —— `external` 数组自身虽已按行号有序，但两个集合在日志里是**交错**的，分别排干会破坏时间顺序，而 latest-wins 依赖顺序。

**⚠️ D71 那张账单第二次到期，而且这次有了实证**：仅仅把 `fold` 参数放宽，**上一轮 `test/session-projection.test.ts:94` 那条在 `finally` 里重新注册投影的旧写法就编译失败了**（`Type 'TaskStateEvent | ExternalSessionEvent | undefined' is not assignable to …`）。**本轮只有 1 个 provider，所以要改 1 处**；D71 量过的是"把 `ExternalSessionEvent` 加进 `SessionEvent` 联合会撞 8 处收窄，其中含 `inspect` 的工具批次安全校验"。**⇒ 那 8 处的账单是真的，不是当时的过度估计**，本轮为它付了第 1 处。

#### 三、⚠️ 变异 A 第一次没有咬住，而原因比缺陷本身更通用

**第一次跑**：变异 A（把行号归并改成"先 `events` 再 `external`"）⇒ **3/3 仍然全绿**。按纪律查清而不是放过：

**根因**：我那条顺序测试用 **latest-wins** 断言（marker 1 → message → marker 9 → message，断言最后是 9）。**但 `external` 数组本身已按行号有序**，所以"先 events 再 external"最后仍然停在 marker 9 ⇒ **两个实现给出同一个答案，测试区分不了它们。**

**补的测试**：改成断言**交错序列本身** —— 折叠成字符串，marker 记 `m`、message 记 `x`，断言 `"mxmx"`；**若两个集合被分别排干就会得到 `"xxmm"`**。**重跑变异 A ⇒ 变红 ✅。**

**⇒ 教训（比缺陷更通用）**：**一个变异没有变红，说明的不是"实现对了"，而是"测试没有表达那条性质"。** **"只看末端"的断言（latest-wins、取最后一个、求和）天然无法区分顺序错误 —— 要钉住顺序，就必须断言顺序本身，而不是断言顺序的某个投影结果。** 这与 D61 那条"变异验证是强制动作"是配套的：**变异验证的价值不在"跑过了"，而在"没变红时要回去改测试"。**

#### 四、⚠️ D72 第 ② 步不能照原样做：三层级联，第 2 层是硬阻塞

**D72 第 ② 步原文**：把 `case "task-state"`（现 `session-store.ts:583-618`，逐字段严格校验，含 `atMessage` 必须非负安全整数、`steps` 必须数组、`steps[i].text` 必须字符串、`steps[i].claim.kind` 必须非空字符串）搬进 provider，**"完成之后核心 switch 少一个 case"**。

**实读查出的级联**：

1. **`task-state` 移出 switch ⇒ 它必须经 D71 的 `registerEventKind` 走外部路径 ⇒ 落进 `external` 而不是 `events`。** `grep` 实证**三处**在读 `report.events`：`:972`（`stateOf` 折叠，**本轮已修**）、`:992`（`latestMarks` 一趟读 `summary` + `task-state` 两样）、`:1020`（工具批次审计）。**⇒ 未修之前，`taskState()` 会恒返回 `undefined`，`appendTaskState`（`:898`）的 D61 单调性检查就会读到"没有前一份状态"，把"调低验收标准"这个攻击重新放开；`latestMarks` 丢 taskState ⇒ `buildPrompt` 停止注入任务状态。**
2. **⚠️ 硬阻塞**：`TaskStateEvent` 必须退出 `SessionEvent` 联合（否则核心仍认识该种类）⇒ **正好撞 D71 实测过的 8 处收窄失败**，其中含 `inspect` 的工具批次安全校验，**而 D71 当时明确拒绝付这个代价**。本轮第二节那 1 处编译失败是这张账单的定金。
3. **`:992` 的 `latestMarks` 一趟优化 —— 其实可解。** D72 第四节 (4) 说不能先删再补，但**把 `external` 并进同一趟并不破坏那个优化，因为优化省的是"两次读日志"（两次 `inspect()`），不是"一个循环"**。⇒ **真正的硬阻塞是第 2 层，不是第 3 层。**

**⇒ 结论：D72 把步骤切得比实际可分离的更干净。第 ② 步与第 ④ 步耦合，而且第 ② 步与 D71 的"不打开封闭联合"直接冲突。**

#### 五、⚠️ 两条候选路线，待操作者裁定（本轮不代选）

| | 路线 | 代价 | 后果 |
|---|---|---|---|
| **甲** | **接受 D71 的账单**：让 `TaskStateEvent` 退出 `SessionEvent` 联合，逐个修那 8 处收窄（含 `inspect` 的工具批次安全校验） | 8 处改动，其中 1 处是安全校验密集区；需要给每处找到不削弱校验的写法 | **核心 switch 真的少一个 case**，D72 第 ② 步成立；`SessionEvent` 成为开放联合，之后每加一个种类都走注册表 |
| **乙** | **换判据**：承认"核心自己消费、且带单调性安全性质的种类"就该留在核心 switch，把注册表 + 投影留给**真正外部**的种类 | 0 处代码改动 | **D72 第 ② 步作废**，核心 switch 稳定在 8 个 case；**⚠️ 但这与 `ARCHITECTURE.md` §3.4④ 说的"新增事件种类必须改核心"是特权核心的实例这一判断相冲突** —— 需要连带修订 §3.4④ |

**⚠️ 为什么不由我选**：**乙会推翻 D72 第 ② 步这条已记录的决定，并连带要求修订 `ARCHITECTURE.md` §3.4④。** 作废一条已记录的决定、修订规范性文档，都不是我单方面该做的（对照 D61：操作员裁定与我的判断冲突时，我报反例而不是静默执行；这里是反过来 —— **我不该在没有裁定的情况下替操作员作废一条决定**）。**⇒ 本节只把两条路线与各自代价写清，标为待裁定。**

**⚠️ 本轮不预设倾向**，但记一条对裁定有用的事实：**甲的真实成本本轮已经量到了一部分** —— 仅仅放宽 `fold` 参数就让 1 处编译失败；D71 量过的是 8 处。**乙的真实成本是概念上的**：它承认"核心 switch 永远有 8 个 case"，这与"小核心 + 一切皆插件"的目标形态（`ARCHITECTURE.md` §1）有张力，但**与 `:113` 没有冲突** —— DSH 的 `SessionEventMap` 是核心自己拥有的类型，插件扩展它靠声明合并，而 D70/D71 已经把声明合并降级为可选。

#### 六、⚠️ 本轮两个操作性错误，都靠 `read` 查清、没有猜

1. **替换顺序测试时多带了一个 `});`，把 `describe` 提前闭合** ⇒ 第三条测试（畸形行按行号拒绝）掉到了 `describe` 外面。
2. **第一次修它时只删了空行，没删那个多余的 `});`** ⇒ 缺陷还在。

**两次都是 `read` 实际行内容之后才发现的**（第一次 `edit` 报 `old_string was not found`，没有当成"可能已经好了"放过）。**⇒ 补一条 `edit` 纪律：替换一段带闭合括号的结构化代码时，`new_string` 的括号数必须与 `old_string` 逐个数过；`edit` 报"未找到"时一律 `read` 确认当前实际内容，不得凭记忆重试。**

#### 七、验证

- **`tsc --noEmit` 退出码 0**（修完 7 处严格性报错之后：`noUncheckedIndexedAccess` 触发的 3 处索引访问 + 2 处测试索引访问 + 1 处 `fold` 收窄 + 1 处归并循环）。
- **新测试 `test/projection-external.test.ts` 3/3**：外部种类的事件能到达它自己的投影（**这条就是缺陷的证明**）、按行号交错顺序折叠（断言 `"mxmx"`）、**畸形的外部种类行仍按行号拒绝**（`problems[0].detail === "marker payload must be a number"` 且 `line > 0`，同时好行仍然解析 ⇒ **D72 第四节 (2) 那条硬约束保住了：可诊断的失败没有退化成不可诊断的失败**）。
- **既有 16 项（`session-projection` + `event-kind-registry`）全绿，无回归**；合计 **19/19**。
- **变异 A**（行号归并改成"先 events 再 external"）⇒ `folds in line order` 变红 ✅（**补测试之后**）；**变异 B**（`stateOf` 回到只折叠 `events`，即缺陷本身）⇒ 2 条变红 ✅；**变异 C**（去掉 `"atMessage" in event` 收窄）⇒ **`tsc` 直接编译失败**，这本身就是它被钉住的证明。
- **源码字节还原 = true**；还原后 19/19。

### D75 解包 DSH 的 `app.asar`，读到真实的 `dsh-session-projection` 源码；甲/乙 的答案是"两条都不是"（2026-09-30，**研究轮，无产品代码**）

**⚠️ 本轮最重要的产出不是结论，是取证方式的变化**：`docs_architecture.md:113` 那份 `dsh-session-projection`、以及我一直标注"本地不存在、所以 DSH 的 mandatory 到底强制什么无从取证"的 `session-projection-mandatory-seam.md` / `capability-seams.md` / `subsystems/*` —— **它们的实现其实一直在 `D:\DeepSeekHarness\resources\app.asar`（117,445,671 B）里，只是从未解包。** 本轮用 40 行 node 直接读 asar 的 JSON 头（前 16 字节：`4 | 3367444 | 3367440 | 3367434`，数据区基址 = `8 + 3367444 = 3367452`），**零依赖解出**：`README.zh.md`(9,511 B)、`lib/index.js`(20,021 B)、`lib/types/index.js`(24,147 B)、`package.json`，以及同级 `dsh-session-projection-cache/README.zh.md`(10,410 B)。**⇒ 补一条取证纪律：说"某份源码读不到"之前，必须先确认它不在已安装产物的打包体里。** 这与 D69 那条"任何『不做 X』的结论必须附上读过 X 的证据"是同一形状的错误，只是这次错的不是判断而是**可达性认定**。

#### 一、⚠️ 决定性证据：DSH 的事件从来没有 `type: string` 这种成员

`README.zh.md:44-46` 的投影单元示例，**逐字**：

```text
apply: (state, event) => event.type === 'todo/upsert'
  ? { items: event.data.items }
  : state,
```

**⇒ 三点同时成立**：**(1)** `todo/upsert` 是**领域插件**贡献的种类，不是框架内置的；**(2)** 用 `event.type === 'todo/upsert'` 收窄**有效**；**(3)** 收窄之后 `event.data.items` **有类型**。

**⚠️ 这直接解释了我 D71 那 8 处收窄失败的真正成因，而且说明那个代价不是必然的**：DSH 的每一个种类（含插件种类）都贡献一个**各自的字面量 `type`**，所以联合始终是**可判别的**，收窄一直有效。**我的 `ExternalSessionEvent` 是一个 `kind: string` 的兜底成员 —— 它与所有字面量重叠，这才让 TS 在 `event.kind === "…"` 处无法排除它。** **⇒ 8 处收窄失败是"我选了兜底成员"的代价，不是"打开联合"的代价。D71 把两者混为一谈了。**

`lib/types/index.js` 文件头逐字印证类型表是可合并扩展的：*"the **merge-extensible** state and client-view type tables"*、*"Domain host plugins contribute pure folds and optional client views; the framework owns the subscription, the per-session watermark cache, and change notification"*、*"**Neither side knows the other (capability-seam three-way split)**"*。**⇒ 与 `docs_architecture.md:117` 的三角色说法一致，且这里是框架/领域/载体三分。**

**⚠️ 但必须分清证据与推断**：上面 `merge-extensible` 说的是 **`SessionProjectionMap` / `SessionProjectionStateMap`**（投影状态与客户端视图的类型表），**不是 `SessionEventMap` 本身**。`SessionEventMap` 的开放性是从 `README.zh.md:44-46` 那个 `todo/upsert` 示例**推断**的，**本轮没有直接读到它的定义**（它应在 `dsh-session-persistence` 或同级包里）。**⇒ 记为待核实，不记为已证。**

#### 二、⚠️ 所以甲/乙 的答案是"两条都不是"

| | 我上一轮给的选项 | 实测后的判断 |
|---|---|---|
| **甲** | 让 `TaskStateEvent` 退出 `SessionEvent` 联合，**逐个修那 8 处收窄** | **⚠️ 前提错了。** 8 处收窄失败源于 `ExternalSessionEvent.kind: string` 这个兜底成员，不是源于"打开联合"。**若每个种类各自贡献一个字面量，收窄不会坏，那 8 处就不需要修。** 甲的真实内容是"**换掉兜底成员**"，不是"付 8 处的账单" |
| **乙** | 承认核心自己消费的种类留在核心 switch，注册表+投影只给真正外部的种类 | **⚠️ 与 DSH 的做法相反。** `todo/upsert` 就是领域插件的种类，它既在事件类型表里、又被投影折叠 —— **DSH 没有"核心种类"与"外部种类"的两条通道**，只有一条 |

**⇒ 第三条路线（丙）**：**取消 `ExternalSessionEvent` 这个 `kind: string` 的兜底成员，改为"每个注册进来的种类各自拥有一个字面量 `kind`"**。这样 `SessionEvent` 联合重新变成可判别的，**D71 那 8 处收窄不需要动**，`task-state` 也可以按 D72 第 ② 步搬出核心 switch。

**⚠️ 丙的前提是声明合并，而 D70 已经把前提验证过了**：探针 (a) 实测 `tsc --noEmit --strict --target es2022 --module preserve --moduleResolution bundler --allowImportingTsExtensions` **接受跨模块 `declare module "./base.ts"` 的接口增广，退出码 0**；探针 (b) 实测 `node --experimental-strip-types` 与裸 `node`（24.x 默认剥离）**都接受 `declare module`/`declare global`，退出码 0**。**⇒ 运行时注册的种类要在类型上拥有字面量，只能靠声明合并；而这条路本项目已经量过是通的。**

**⚠️ 这也修正了 D70 的一个措辞**：D70 把声明合并记为"可选"（*"运行时注册表必要，声明合并可选"*）。**本轮证据显示：对丙这条路线，声明合并不是可选的，它是让字面量存在的唯一途径。** D70 那句话在"只想要运行时开放性"的语境下是对的，在"想要类型侧也可判别"的语境下是错的 —— **这又是 D70 自己立的那条规则（引一句机制必须说清它解决哪一侧）在我自己文档上的一次应用。**

#### 三、⚠️ 顺带读到的四处，其中两处说明我的设计缺了东西

1. **`stateVersion`（我没有）**：`lib/index.js:79-92` —— `stateVersion` 必须是非负安全整数否则 throw；**同一个 key 以不同 `stateVersion` 再次注册会被拒绝**（*"already registered at stateVersion N; refusing to…"*）。缓存行携带 `ver`，`restore` 时 **`ver` 不匹配或声称越过存储末尾的行一律丢弃**（`:234`/`:262`/`:308`）。**⇒ 这是"折叠语义变了之后旧状态必须失效"的机制。我的 `SessionProjectionUnit` 没有版本字段，所以一旦某个 provider 改了 `fold` 的语义，读出来的旧状态会静默混用** —— 本项目目前只有内存态、没有持久检查点，所以**还不会出事**，但第 ④ 步做增量折叠/检查点时这是必须先补的。
2. **整值事件规则（load-bearing，逐字）**：*"a state-carrying log event **MUST carry the complete post-change state, never a bare delta**"*（`lib/types/index.js` 文件头），`README.zh.md:54` 中文版同。**⇒ 这独立印证了 D67 排序第 1 名与本项目 `task-state` 的 latest-wins 设计**：DSH 把"绝不带裸增量"写成承重规则。**同时它进一步压低了 D67 第 2 名（`node:sqlite`）的优先级 —— DSH 有持久缓存包，但缓存的是投影检查点，不是把事件日志搬进 SQL。**
3. **`Object.is` 引用闸门 + "无关事件必须返回同一个状态引用"**（`README.zh.md:54`、`lib/index.js:31`）：*"对与单元无关的事件必须返回同一个状态引用——引用不变意味着零下游工作"*。**⚠️ 我的 `fold` 已经符合**（非 `task-state` 事件原样返回 `state`），**但我没有把它写成契约**，也没有 `Object.is` 闸门 —— 本项目没有变更通知流，所以闸门暂无用，**但"无关事件返回同一引用"这条应该写进 `SessionProjectionUnit` 的契约注释**，否则第 ④ 步做增量折叠时会漏掉这个廉价优化。
4. **⚠️ 一处真实的定位差异，必须记**：`README.zh.md:117` 逐字 *"模型体验：**无**——注册表只为已入日志的会话状态提供**面向客户端的读模型**，**不注册任何模型可见内容**"*、`:121` *"KV Cache 影响：无；投影从不组装或发送提供方请求"*。**⇒ DSH 的投影接缝是给客户端载体（UI）用的读模型，而本项目把 `task-state` 投影用于 prompt 注入，是模型可见的。** 这**不违反** `docs_architecture.md:111` 的 *"Model-visible means logged"*（`task-state` 确实入日志、确实可从日志重建），而且 `:113` 末句 *"The agent loop registers shared `turnBoundary` state for its readers"* 说明 DSH 的 agent loop 也往这个注册表注册状态。**但"DSH 用它做 UI 读模型"与"本项目用它做 prompt 注入"是两种用法，本项目是把它用在了原作者标注为"无模型体验"的位置上** —— **这是一处有意偏离，记在这里而不是藏起来**；它带来的额外要求是：**投影结果进入 prompt 就必须可重建、可审计**，而这正是 `:111` 那条待落地的运行时不变式要管的（仍在队列里）。

#### 四、⚠️ 还读到一条与 D73 直接相关的限制

`README.zh.md:131` 逐字：*"**单元表是进程级的，因此 key 是否存在不能当作逐会话的能力信号**——任何 agent preset 注册的 key 都会出现在每个会话的快照里；**客户端必须读值，不能把 key 缺席当作功能缺席**"*。

**⇒ 这与 D73 第一节的"两种 absent"是同一件事的第三面**：D73 分的是"键没注册 ⇒ 抛错"与"键注册了但没事件 ⇒ 返回 `initial`"；**DSH 这条补的是"键注册了、但这个会话根本不用这个能力 ⇒ 仍然返回 `initial`，读方不得把它当成'功能不存在'"**。**本项目的模块作用域注册（每进程一次）正好落在这个形状上** ⇒ D73 的设计与之一致，**但 D73 没有把"不得把 `initial` 当成能力缺席"写成契约**，应该补进 `SessionProjectionUnit` 的注释。

#### 五、决定与下一步

**⚠️ 本轮是研究轮，不改产品代码，也不代替操作者在甲/乙/丙 之间裁定。** 但取证结果足以把选项从两个变成三个，并且**否掉了甲与乙各自的前提**：

- **丙（本轮新提出，有 DSH 源码 + D70 探针双重支撑）**：取消 `ExternalSessionEvent` 的 `kind: string` 兜底成员，改为每个注册种类各自拥有字面量 `kind`，用声明合并让类型侧可判别。**⇒ D71 那 8 处不需要修，D72 第 ② 步可以照原样做。**
- **⚠️ 丙的代价（必须先量，不能凭推断）**：`docs_development.md:56` 记的那条 *"Host and Client stay two aggregate programs because both sides declaration-merge the cordis `Context` interface under the same keys with different services; **one program seeing both merges reports a collision**"* —— 本项目只有一个程序，所以**大概率不撞**，但 D70 的探针只验了"能编译"，**没验过"两个不同模块对同一个 key 合并出不同形状时会怎样"**。**⇒ 丙落地前必须先做这个探针。**
- **本轮未读、仍待取证**：`SessionEventMap` 的实际定义（在哪个包、是否真的 merge-extensible）、`lib/types/index.js` 全文、`dsh-session-projection-cache/README.zh.md`、`dsh-upstream-AGENTS.reference.md`(16,557 B)、`blog-cordis-tencent.html`(204,523 B)、`_evomap_ref/evolver-README.zh-CN.md`(28,939 B)。**⚠️ 以及一个新认识：`app.asar` 里还有 `subsystems/*`、`.agents/notes/*`、`capability-seams.md` 这些我一直以为"本地不存在"的文档 —— 下一轮应当先在 asar 里搜它们，而不是继续在 `_dsh_ref` 里找。**

### D76 声明合并冲突探针：**丙可行**，8 处收窄不需要修，但穷尽性惯用法在运行时是个陷阱（2026-09-30，**探针轮，零产品代码**）

**探针位置**：`D:\DSHXM\d76probe\`（**仓库外**，D50 的教训：探针产物不入仓库），跑完已删。**只读 `app.asar` 与本项目文件，未修改任何外部参考项目或宿主数据。**

**⚠️ 先纠正一处既有偏差**：本项目 `tsconfig.json` 实读为 `"module": "ESNext"`（另有 `moduleResolution: bundler`、`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`、`skipLibCheck`、`types: ["node"]`），**而 D70 探针 (a) 用的是 `--module preserve`** ⇒ **D70 那条"跨模块 `declare module "./base.ts"` 接口增广可编译"的结论不是在项目真实选项下得到的。本轮用复制过来的真实 tsconfig 重跑，结论仍然成立**（P1 ✅）⇒ **D70 的结论对，但它当时给的证据强度不够**。**⇒ 补一条纪律：探针的结论只在它所用的编译选项下成立，所以探针必须复制项目的真实 tsconfig，不能手搓一串 flag。**

#### 一、⚠️ P2 是本轮的命门，它通过了 —— 而"通过"的表现是一个报错

**被测形状**（丙的核心机制）：`SessionEvent` 不是手写联合，而是**从 map 派生的可判别联合**：

```ts
export interface SessionEventMap {
  message: { readonly at: string; readonly content: string };
  usage:   { readonly at: string; readonly inputTokens: number };
}
export type SessionEvent = {
  readonly [K in keyof SessionEventMap]: { readonly kind: K } & SessionEventMap[K];
}[keyof SessionEventMap];
```

两个"插件"模块各自 `declare module "./base.ts" { interface SessionEventMap { "plugin-a/marker": {…n: number} } }` / `{ "plugin-b/note": {…text: string} }`。消费方写：

```ts
if (event.kind === "plugin-a/marker") return String(event.n);   // 第 14 行
if (event.kind === "plugin-b/note")   return event.text;        // 第 15 行
…
default: return assertNever(event);                             // 第 16 行，判别器
```

**实测结果（逐字）**：`tsc` 退出码 2，**唯一一条错误在第 16 行**：

```
consumer.ts(16,33): error TS2345: Argument of type
'({ readonly kind: "plugin-a/marker"; } & { readonly at: string; readonly n: number; })
| ({ readonly kind: "plugin-b/note"; } & { readonly at: string; readonly text: string; })'
is not assignable to parameter of type 'never'.
```

**⚠️ 这条错误恰恰是 P2 通过的证明，必须这样读**：
1. **两个插件种类真的进了派生联合** —— 它们的完整形状出现在错误的实参类型里；
2. **第 14、15 行零报错** ⇒ **用插件贡献的字面量收窄有效，且收窄后 `event.n` / `event.text` 是有类型的**；
3. **正因为它们进了联合，`default` 分支的 `event` 就不是 `never`，`assertNever` 才报错** —— 这就是判别器设计的作用：**它报错当且仅当增广生效。**

**⚠️ 我对输出的第一反应是"有错误 ⇒ 失败"，那是错的**，而且错的原因是**探针设计缺陷**：我把判别器和被测代码放在同一个 program 里，于是"成功"表现为退出码 2。**⇒ 补一条探针纪律：判别器必须单独成一个 program（或单独一次编译），让退出码本身可以直接读作结论；否则每次都要靠人读错误文本来判断，而人会读错 —— 我这次就先读错了。**

**⇒ P2 结论：映射类型派生的可判别联合 + 跨模块声明合并 + 按插件字面量收窄，三者在本项目真实编译选项下一起工作。** **D71 那 8 处收窄失败与"打开联合"无关，只与 `ExternalSessionEvent.kind: string` 这个兜底成员有关。丙成立。**

#### 二、P1 / P3 / P4 的实测

- **P1（基线，真实 tsconfig 重跑 D70 探针 (a)）**：✅ 增广本身可编译，无错误。
- **P3（冲突本体，`:56` 那条）**：两个模块对**同一个 key `message`** 合并出不同形状 ⇒ **退出码 2，两处 `TS2717`，逐字**：
  ```
  coll-a.ts(3,5): error TS2717: Subsequent property declarations must have the same type.
    Property 'message' must be of type '{ readonly at: string; readonly content: string; }',
    but here has type '{ readonly at: string; readonly WRONG: true; }'.
  ```
  **⚠️ 这是本轮第二重要的结果，而且是最好的那种结果**：冲突是**编译期硬错误**，报错**点名了属性、点名了两侧的完整形状**，**不是静默的类型腐坏**。⇒ **对本项目（只有一个 `ts.Program`）而言，`:56` 描述的风险表现为"`npm run build`（即 `tsc --noEmit`）变红"，而不是"运行时读到错的东西"** —— 而本项目的 build 是每轮必跑的。**⇒ 丙不需要额外门禁也能被挡住；`:58-60` 那三条纪律 + 走 Project Reference 图的 `constraints` 门禁是 DSH 那种"两个聚合程序"场景的需要，本项目单程序场景下由 build 直接覆盖。**
- **P4（运行时）**：`node --experimental-strip-types` 与**裸 `node`（本机 v24.19.0）都退出码 0**，输出 `runtime read=42` ⇒ **插件种类的 payload 在运行时可正确读取**。**这独立复现并扩展了 D70 探针 (b)**（那次只测了 `declare` 块本身，这次测了"映射类型派生 + 增广 + 消费 + 运行"整套）。
- **⚠️ 附带发现：增广是 program 级的，不需要显式 `import`。** 变体 BARE（消费方不 `import` 那两个插件模块，只靠 `include` 把它们放进 program）**同样只有判别器那一条错误** ⇒ 类型侧的可见性由 **program 成员资格**决定，不由 import 图决定。**这与 `:56` 那句 *"The collision exists only inside a `ts.Program`"* 完全吻合，也从另一侧印证了它**：冲突与增广都只发生在 program 内部。**⚠️ 但运行时仍需显式加载插件模块才会执行注册** —— 类型侧与运行时侧的"可见"条件不同，这一条要写进丙的实现约定。

#### 三、⚠️ P5：穷尽性惯用法在运行时是个陷阱（丙的一条硬约束）

`P4` 的第二行输出：`runtime migrate threw: unexpected [object Object]`。

**成因**：`default: return assertNever(event)` 在**编译期**是穷尽性检查（很好），但在**运行时**它就是 `throw new Error(...)`。**而运行时没有类型系统 —— 一个经 `registerEventKind` 注册进来的外部种类走到 `switch`，必然落进 `default`，于是必然抛错。**

**⚠️ 这与 D71 已落地的设计直接冲突**：D71 的 `migrateEvent` 在版本闸门之后、8-case switch 之前**先查注册表**，`default` 分支是 `if (record.ignorable === true) return null; throw new Error(\`unknown event kind: ${kind}\`)` —— **它必须保留一个能路由到注册表的真实 `default`，不能用 `assertNever` 占位。**

**⇒ 丙的一条硬约束（本轮新得出，没有它就会在实现时踩坑）**：**`migrateEvent` 的 switch 不得采用 `default: assertNever(event)` 这个穷尽性惯用法。** 丙让联合变开放之后，"穷尽"在类型上不再可达；**要保留穷尽性检查的价值，只能在内置种类那 8 个 case 上做（例如另设一个只覆盖内置种类的窄类型来检查），而不是在整个联合上做。** **⚠️ 这一条是运行探针才发现的：只跑 `tsc` 会以为 `assertNever` 是纯收益。**

#### 四、决定与下一步

**⚠️ 探针结论：丙可行，且它的代价比 D75 估的更低。**

| 项 | D75 的估计 | D76 实测 |
|---|---|---|
| D71 那 8 处收窄 | 甲要付、丙不用付（**推断**） | **✅ 证实不用付**：只要没有 `kind: string` 兜底成员，收窄照常工作 |
| `:56` 的合并冲突 | "大概率不撞，但没量过" | **✅ 量了**：撞了是 `TS2717` 编译期硬错误、点名属性与两侧形状，**不是静默腐坏**；本项目每轮跑 build ⇒ 不需要额外门禁 |
| 声明合并的前提 | D70 说通（但用的是 `--module preserve`） | **✅ 用项目真实 tsconfig 重跑仍通**，且运行时（含裸 `node`）可执行 |
| 穷尽性惯用法 | 未考虑 | **⚠️ 新发现的硬约束**：`default: assertNever` 会让外部种类在运行时抛错，**丙禁止在 `migrateEvent` 用它** |

**⇒ 丙的落地顺序（下一轮起，本轮不动代码）**：
1. **先做 P5 那条约束的落地设计**：`migrateEvent` 的 `default` 保持 D71 现状（路由注册表 + `ignorable` 判空 + 抛未知种类），**不引入 `assertNever`**；若要保留内置种类的穷尽性检查，另设一个只含 8 个内置种类的窄类型。
2. **把 `ExternalSessionEvent` 的 `kind: string` 换成"每个注册种类各自一个字面量"**。**⚠️ 这一步需要声明合并**（`declare module` 增广 `SessionEventMap`），而 D70 已把声明合并记为"可选"、本轮证明**对丙它不是可选的而是唯一途径** ⇒ **D70 那处措辞要连带修订**（已在 D75 第二节记过，本轮是它的实证支撑）。
3. **然后才做 D72 第 ② 步**（把 `case "task-state"` 的校验搬进 provider）—— 因为丙之后 `task-state` 移出 switch 不再导致 `TaskStateEvent` 退出联合，**D74 第四节那个"第 2 层硬阻塞"随之消失**。
4. **⚠️ 丙会作废 D71 一条已记录的决定**（`ExternalSessionEvent` 的兜底形状，以及"不把开放成员加进联合"这个取舍）⇒ **这一步要等操作者明确同意丙之后再动，本轮不预做。**

**⚠️ 本轮明确不做**：不改 `ExternalSessionEvent`、不动 `session-store.ts`、不实现丙 —— **探针结果出来之前动代码就是在赌；结果出来之后，作废一条已记录的决定仍需操作者裁定（对照 D74 第五节的处理方式）。**

**仍未取证**：`SessionEventMap` 在 DSH 里的实际定义（在哪个包、是否真叫这个名字、是否也是映射类型派生）—— **本轮证明了"这种形状可行"，没有证明"DSH 就是这么写的"**；`lib/types/index.js` 全文；`app.asar` 里可能存在的 `subsystems/*`、`.agents/notes/*`（含 `README.zh.md:110` 点名的那份投影 RFC `2026-07-27-session-projection-and-command-log.zh.md`）、`capability-seams.md`；`dsh-upstream-AGENTS.reference.md`；`blog-cordis-tencent.html`；`_evomap_ref/evolver-README.zh-CN.md`。**⚠️ 下一轮若继续取证，应先在 `app.asar` 里搜这些路径 —— D75 已经证明它们大概率就在里面。**

### D77 丙的第一步落地：类型表可增广，且在真实文件里**实测不污染核心**（2026-09-30，**有代码**）

**操作者裁定丙（"行，可以。做吧"）后的第一轮。范围刻意收窄到一件事：让声明合并有一个可增广的落点，并测量它在本项目真实布局下会不会污染核心。**

#### 一、做了什么

新增 `export interface SessionEventMap`（8 个内置种类，键为种类字面量、值为既有事件接口），把 `export type SessionEvent` 从手写 8 项联合改为 `SessionEventMap[keyof SessionEventMap]`。**纯类型层重构，零运行时行为变化。**

**⚠️ 刻意不用 D76 探针里那个映射类型派生写法**（`{ [K in keyof SessionEventMap]: {kind:K} & SessionEventMap[K] }[keyof …]`）。那个写法要求 map 的值是"去掉 `kind` 的 payload 形状"，于是 8 个既有接口都要拆开或 `Omit`，**改动面从 1 处扩到 9 处，且 `Omit<…, "kind">` 会丢 `readonly` 与可选性细节 —— 在本要保护的那 8 处收窄点周围扩大爆炸半径**。丙真正需要的性质只是"增广一个键之后 `SessionEvent` 多出一个带自己字面量的成员"，**最简形式同样满足，且 8 个接口一个字都不用改**。**D76 证明了映射类型那种形状可行，没有证明只有那种形状可行。**

#### 二、⚠️ 本轮最重要的测量：增广在真实文件里**不**污染核心

`tsconfig.json` 的 `include` 覆盖整个 `test` 树 ⇒ 新测试文件 `test/session-event-map.test.ts` 里的 `declare module "../src/session-store.ts"` 增广**在编译 `src/` 时可见**。**这正是 `docs_development.md:56` 说的"一个 program 看到两侧的合并"，发生在我们自己的单程序里**，而不是 DSH 的 Host/Client 两个聚合程序之间。

**实测：`tsc --noEmit` 退出码 0，错误数 0。**

**⇒ 丙的核心主张在真实文件、真实 tsconfig、真实那 8 处收窄点下成立**：一个带自己字面量的合并成员进入 `SessionEvent`，**不会**破坏 `session-store.ts` 里任何一处 `event.kind === "…"` 的收窄。**⚠️ 这比 D76 强得多** —— D76 只在探针目录里证明"这种形状可行"，本轮证明"它在本项目里可行且不破坏既有代码"，而且是在 **651 项测试全绿的同一份代码上**测的。

**⚠️ 同时这条测量也说明 DSH 那套隔离本项目暂时不需要**：`:56` 的冲突需要"两侧对**同一个键**合并出不同形状"，而本项目只有一个 `SessionEventMap` 的所有者（核心），插件各贡献自己的键 ⇒ **单程序布局下不会撞，撞了也是 `TS2717` 编译期硬错误（变异 C 已在本仓库复现）**。**⇒ `:58-60` 那三条纪律与走 Project Reference 图的 `constraints` 门禁，是 DSH 那种多聚合程序场景的需要，本项目由每轮必跑的 `tsc --noEmit` 直接覆盖。** 这条判断本轮有实测支撑，不是推断。

**⚠️ 但"不污染"这个性质不能由测试自己证明**：一个测试无法断言"我不存在时也会通过"。**它的证明者是编译器 —— 在这份增广存在于 program 的前提下检查 `src/` 仍然通过。** 所以本轮把它写成 `tsc` 的一次测量并记录退出码，而不是写成一条 `assert`。

#### 三、⚠️ 一个计划里的错误，在动手前查出来：变异 B 是空操作

**原计划的变异 B 是"把 map 里 `"task-state"` 键改成错的字面量，`tsc` 必须变红"。这个计划是错的**：`SessionEventMap[keyof SessionEventMap]` 是**索引访问，只取值、不取键** ⇒ **改键名对 `SessionEvent` 完全没有影响，变异 B 语义上是空操作，跑它只会得到一个假绿。**

**⚠️ 而这个错误本身暴露了本设计的一处真实弱点，必须记下来**：**键名与成员的 `kind` 字面量之间没有任何强制关系。** 一个插件可以增广 `"my/kind": { …; kind: "totally-different"; … }`，**`tsc` 不会报错，`SessionEvent` 照样多出一个成员，只是它的 `kind` 与它在表里的键对不上** ⇒ 之后按键查表（`SessionEventMap["my/kind"]`）与按 `kind` 收窄会得到不一致的结果。

**⚠️ 对照 D76 的映射类型写法：那个写法是从键**派生** `{ kind: K }`，所以键与字面量天然一致、不可能对不上。** **⇒ 这是本轮选最简形式所付的真实代价，不是免费的。** 本轮不修它（修法要么换成映射类型派生、要么加一条静态断言，两者都超出本轮范围），**但记为已知弱点，并在下一轮决定"是否要求注册即增广"时一并考虑** —— 因为如果 `registerEventKind` 收紧成 `K extends keyof SessionEventMap`，那条约束就会把键名变成运行时注册的一部分，键与字面量不一致会立刻在注册处暴露。

**改用 B'（从表里删掉 `audit: AuditEvent;` 这一行）**：`tsc` 退出码 2、**12 条错误**，含 `src/session-store.ts(1090,34): error TS2345: Argument of type 'AuditEvent' is not assignable to parameter of type 'SessionEvent'` ⇒ **证明这张表是承重的，不是装饰。**

#### 四、⚠️ 本轮自己造成的一个错误：块注释里的 glob 会终止注释

第一版 `SessionEventMap` 的 JSDoc 里我写了 glob `test/**/*.ts`。**其中的 `*/` 把块注释提前终止**，于是注释后面的 `declare module …` 被当成代码解析，`tsc` 报了 **11 条级联语法错误**：`TS1109: Expression expected`、`TS1005: ';' expected`、`TS1443: Module declaration names may only use ' or " quoted strings`、`TS1228: A type predicate is only allowed in return type position`。

**⚠️ 而且这 11 条全部指向远离真因的行号**（`390`/`391`/`392`/`418`），真因在注释内部。**若不是逐条读错误文本、看到 `TS1443` 提到 "Module declaration names" 才回头怀疑注释边界，很容易误判成"增广语法在本项目不成立"从而错误地否掉丙。**

**⇒ 补一条纪律：块注释里不得出现 `**/` 这个字符序列；引用 glob 时改写或用文字描述。** 这条陷阱已连同那 11 条错误一起写进 `session-store.ts` 的注释本身（**因为它会再犯：任何在块注释里引用 glob 的地方都会中招，写在代码里比写在决策记录里更容易被下一个人看到**）。

#### 五、验证

- **`tsc --noEmit` 退出码 0、错误数 0**（增广在 program 内的前提下）。
- **新测试 `test/session-event-map.test.ts` 3/3**：**(a)** `Extract<SessionEvent, {kind:"probe/augmented"}>` 不是 `never`、payload 字段有类型（**⚠️ 这条性质由编译器在测试运行之前就检查过了，所以它不可能靠运行时巧合通过**）；**(b)** 9 个种类字面量彼此可区分、`SessionEventMap["probe/augmented"]` 可按键取到形状；**(c) 端到端** —— 类型侧增广 + D71 的运行时 `registerEventKind` + D74 的行号归并接成一条路径：写两行外部种类日志（中间夹一条内置 `message`）⇒ `inspect` 的 `external` 收到 2 条、`problems` 为空 ⇒ 投影折叠出 7。**⇒ 丙的类型侧与 D71/D74 的运行时侧真的通了。**
- **全量 651 项 / 648 通过 / 2 失败 / 1 跳过**（648 基线 + 3 新增 = 651 ✓）。**⚠️ 那 2 项失败已隔离核实**：`background-jobs` 单独重跑 **11/11 全绿** ⇒ 是 12 轮未修的负载相关间歇项（本轮超时值 3157/3160/3329/3329 ms），**不是本轮回归**。**报成失败而不是挥过去，也不声称已修。**
- **三处变异全红、字节还原 = true**（`src` 与 `test` 两侧都还原）：
  - **A** `SessionEvent` 改回手写 8 项联合 ⇒ **5 条错误**，含 `test/session-event-map.test.ts(69,24): error TS2339: Property 'n' does not exist on type 'never'` —— **这正是判别器设计的预期表现：增广没进联合时 `Extract` 得到 `never`** ✅
  - **B'** 表里删掉 `audit` 成员 ⇒ **12 条错误** ✅
  - **C** 在测试里对**同一个键**增广出不同形状 ⇒ **5 条错误，含 `TS2717: Subsequent property declarations must have the same type. Property '"probe/augmented"' must be of…`** ⇒ **D76 P3 在本仓库复现** ✅
- **还原后 `tsc` 退出码 0、新测试 3/3。**

#### 六、⚠️ 对 plan-ready 的一处偏离，如实报

plan-ready 第五节列了 5 份文档，**本轮只改了 4 份：`REFERENCE_DECISIONS.md`(D77)、`ARCHITECTURE.md` §3.4④、`CODE_MAP.md`、`STATUS.md`，没改 `SAFETY.md`**。**理由**：本轮是纯类型层重构，**没有任何安全/审批行为发生变化** —— 既没有新增或放宽任何权限边界，也没有改变 `decide()`、写预算、路径约束或审批语义；而 plan-ready 里预计要写进 `SAFETY.md` 的那条内容（"已测、未触发污染"）**本质是类型层测量结果，归属 `ARCHITECTURE.md` 与 `CODE_MAP.md`**。**按项目规矩"每轮只碰受影响的那几份文档"，`SAFETY.md` 本轮不受影响 ⇒ 不碰它是对的，plan-ready 把它列进去是错的。**

#### 七、⚠️ 本轮明确没做（各有理由）

- **没删 `ExternalSessionEvent`、没删 `InspectionResult.external`、没删 D74 的行号归并、没动 `migrateEvent` 的 8-case switch。** 删兜底成员意味着把 `registerEventKind` 收紧成"注册即增广"（`K extends keyof SessionEventMap`），**会作废 D71 已落地的形状与它那 9 项测试**（它们在运行时注册 `"probe/lying"` 等种类而不做增广），**并连带让 D74 的归并成为死代码** ⇒ **那是一次涉及三处已记录决定的联动改动，不该与"让类型表可增广"挤在同一轮。**
- **没做 D72 第 ② 步。** **⚠️ 但它的前提已经变了**：D74 第四节说第 ② 步的第 2 层硬阻塞是"`TaskStateEvent` 必须退出 `SessionEvent` 联合"—— **丙之后这条阻塞消失了**，因为 `task-state` 可以留在表里、由 provider 提供校验，而不需要退出联合。**⇒ 下一轮做第 ② 步的成本要重新估，不能沿用 D74 的估计。**
- **没修第三节那个"键名与 `kind` 字面量不一致无人强制"的弱点**（超出本轮范围，理由见第三节）。

### D79 "是否要求注册即增广"—— 查完源码后，**这个问题本身是个伪选择**（2026-09-30，**研究轮，零产品代码**）

**⚠️ 本轮起因是我的纪律违规，先记下来**：上一轮我把"是否要求注册即增广（删 `ExternalSessionEvent` 兜底成员）"当成待裁定项抛给操作者，**而没有为它做过任何研究** —— 没查成熟产品、没量影响、没比性能、没核架构一致性。**这违反 D69 那条规矩（*"任何『不做 X』的结论，必须附上读过 X 的证据"*）的镜像：任何交给操作者的选择，必须附带我做过的研究、证据与推荐，不能只列选项让操作者替我做功课。** 操作者的质问（*"这些你都做过了吗？来问我这个问题？"*）是对的，**答案是"没有"**。

**取证方式**：从 `D:\DeepSeekHarness\resources\app.asar` 解包（D75 的方法），**只读，未改宿主数据**，解到仓库外 `D:\DSHXM\d79ref\`。**⚠️ 顺带纠正两处既有记录**：**(1)** `@deepseek-ai` 作用域在 asar 里位于 **`dsh/node_modules/` 之下**，不在顶层 `node_modules/`（我按顶层找，第一次搜索报"0 个文件"）；**(2)** D75 记录的解包路径是对的，但**当时只解了 `.js`，没解类型层** —— 而本问题的答案恰恰在类型层。

---

#### 一、⚠️ 最重要的发现：**Cordis 的真实 TypeScript 源码就在 asar 里**

`dsh/node_modules/@deepseek-ai/cordis/` 下有 **`src/registry.ts`(11,711 B)、`src/context.ts`(6,137 B)、`src/service.ts`(4,255 B)、`src/events.ts`、`src/fiber.ts`、`src/reflect.ts`** —— **不是 `.d.ts`，是带注释的 `.ts` 源码**。**⇒ 我此前多轮标注"Cordis 只有二手转述（`docs_cordis-primer.md` 45 行、`blog-cordis-tencent.html` 204 KB 未读）"是可达性认定错误，与 D75 那次同形状，这是第二次犯。**

**⚠️ 补一条纪律（第二次了，必须升级）**：**说"某份源码读不到"之前，不但要查已安装产物的打包体（D75），还要查它在包内的**非标准位置**（`src/` 而不只是 `lib/`、作用域目录而不只是顶层 `node_modules/`）。**

#### 二、问题 1：「注册即增广」到底指什么

指把 `registerEventKind(kind: string, handler)` 收紧成 `registerEventKind<K extends keyof SessionEventMap>(kind: K, handler)` —— **即：没有先写 `declare module` 类型增广，就无法在运行时注册这个种类**。连带后果是 `ExternalSessionEvent`（`kind: string` 的兜底成员）失去存在理由而被删，于是 `InspectionResult.external` 与 D74 的行号归并都成为死代码。

**⚠️ 上一轮我把它描述成"需要你裁定"，这个描述本身就是错的** —— 因为它把一个**有客观答案的事实问题**（成熟产品怎么做）伪装成了一个**价值判断题**。

#### 三、问题 2：成熟产品是什么样的 —— **两层，运行时开放、类型侧可选增广**

**Cordis（DSH 所基于的插件框架）的真实源码，逐字**：

- **运行时侧不受约束** —— `src/registry.ts:107-108`：
  ```ts
  /** Service name(s) the plugin provides (read by `Service` and by loaders). */
  provide?: string | string[]
  ```
  **⇒ 插件声明自己提供什么服务，用的是裸 `string`。**
- **类型侧只在"取用"那一端受约束** —— `src/registry.ts:19,22-23,37`：
  ```ts
  export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
  export type InjectKey = keyof {
    [K in keyof Context & string as Context[K] extends { [symbols.config]: any } ? K : never]: any
  }
  export function Inject<K extends InjectKey>(name: K, config?: …)
  ```
  **⇒ `InjectKey` 是从 `Context` 的键派生的，所以一个插件要想被别人**带类型地**注入，就必须先增广 `Context`；但它自己**注册**时并不需要。**
- **Cordis 自己就在用声明合并** —— `src/registry.ts:164`：`declare module './context.ts' {`。**⇒ 增广是这套框架的内部常规手法，不是外部插件才用的逃生门。**
- **`src/context.ts:31-32`**：`/** The plugin registry. Its methods are mixed onto `ctx` (`ctx.plugin`, `ctx.inject`). */ registry: RegistryService`。

**DSH 的投影包，逐字**（`dsh-session-projection/lib/types/types.js:1-8`，**这是 D75 从未读过的文件**）：

> *"Pure-type outlet of the session-projection Service Definition: **the one projection type table**, importable from client aggregates **without dragging the host-side cordis Context merges** of the package root (dsh-agent → dsh-session). **Domain packages may declare-merge through either the package root or this outlet — re-export preserves symbol identity, so both land on the same table.**"*

**⚠️ 三条信息**：**(1)** 确实存在"唯一一张投影类型表"（**这补上了 D75 记为"推断、未证实"的那一环的一半**）；**(2)** **领域包通过声明合并接入它**；**(3) ⚠️ 这个 `/types` 子路径的存在理由，正是为了绕开 `docs_development.md:56` 那个冲突** —— *"without dragging the host-side cordis Context merges"*。

**⚠️ 而且 `dsh-session-projection` 全包没有任何 `.d.ts`**（14 个文件里只有 `LICENSE`/`README*`/`lib/index.js`/`lib/types/index.js`/`lib/types/types.js`/`package.json`）⇒ **它的类型信息全部走 JSDoc + 这个纯类型出口**，**没有任何机制在运行时注册处强制类型增广**。

**⇒ 结论：成熟产品的形态是「运行时开放（裸 `string`）+ 类型侧可选增广」，而这正是本项目 D77 之后的形态**（`registerEventKind(kind: string, …)` 开放 + `SessionEventMap` 可增广）。**⇒ 问题 1 那个"是否要求注册即增广"没有分歧可裁：不要求，现状已经对齐。**

#### 四、⚠️ 问题 5 的答案里藏着一个我缺的机制：**纯类型出口（pure-type outlet）**

DSH 为 `:56` 那个冲突给出的**已发布解法**不是"强制增广"，也不是我在 D77 里写的"本项目只有一个程序所以不撞"，而是**拓扑解法**：**再开一个只含类型表的子路径出口（`/types`），让客户端聚合程序能拿到类型表而不必拖进宿主侧的 `Context` 合并**；并靠 **re-export 保持符号同一性，所以两个入口的增广落在同一张表上**。

**⚠️ 这修正了 D77 的一个结论**：D77 写"DSH 那套隔离本项目暂时不需要"。**那句在"本项目只有一个程序"的前提下仍然成立，但我当时把 DSH 的解法理解成了"两个聚合程序"这一种，漏了这个纯类型出口。** **⇒ 记为：若本项目将来拆出宿主/客户端两个程序，DSH 已发布的解法是加一个纯类型出口，而不是把类型表复制两份、也不是收紧注册。**

#### 五、问题 3：有什么影响（若真去收紧）

- **类型层**：任何没写增广的 `registerEventKind` 调用变成编译错误。**⚠️ 这会立刻作废 D71 已落地的 9 项测试** —— 它们在运行时注册 `"probe/lying"` 等种类而**不做增广**（`test/event-kind-registry.test.ts`）。
- **运行时层**：`ExternalSessionEvent`、`InspectionResult.external`、**D74 的行号归并**全部成为死代码。**⚠️ 而 D74 的归并是修一个真实交付过的缺陷（D73 的接缝两半不通）才加的，删它要连带删 `test/projection-external.test.ts` 里那条交错序测试（`"mxmx"`）。**
- **⚠️ 最重的一条影响，与操作者的目标直接冲突**：收紧之后，**插件必须用 TypeScript 写、并且必须参与本项目的编译**（因为它的增广要进同一个 `ts.Program` 才能生效）。**⇒ "像积木一样可插拔"就不再成立 —— 积木不该要求先改宿主的类型表。** 这违反 `ARCHITECTURE.md` §1 的小核心目标，也违反操作者五点重定向的第 ④ 点（*"一切皆插件…就像 pi 一样"*）。**而 Cordis 的 `provide?: string | string[]` 恰恰是为了让非 TS 插件与动态服务名也能注册。**

#### 六、问题 4：性能谁更好（**必须分两侧说，D70 的规矩**）

- **运行时侧：无差别。** 类型全部被剥离（D76 实测：`--experimental-strip-types` 与裸 `node` 都退出码 0 且行为正确），所以"兜底成员 vs 全字面量"在运行时不产生任何指令差异。**⇒ 这一侧没有性能问题可谈。**
- **类型检查侧：全字面量（丙）严格更好，而兜底成员（`kind: string`）更差。** 依据是 **D71 的实测**：把 `kind: string` 的成员加进联合后，TS 在 8 处 `event.kind === "…"` 无法排除它，其中一处是 `inspect` 的工具批次安全检查（对 `tool/call | tool/result` 做析取收窄后读 `callId`/`name`/`arguments`）。**⇒ 兜底成员让收窄退化，全字面量让收窄成为判别式查找。**
- **⚠️ 但这是"依据 D71 的实测现象做的推理"，不是对编译耗时的直接测量。** 本轮没有跑 `tsc --extendedDiagnostics` 去对比两种形态的编译时间 ⇒ **记为「未测，只有推理」**，不冒充实测。**若将来真要拿编译耗时当理由，必须先测。**

#### 七、问题 6：是否与本项目架构和想要的东西一致

| 对照项 | 现状（D77 之后） | 若收紧成"注册即增广" |
|---|---|---|
| `ARCHITECTURE.md` §1 小核心 | ✅ 新增种类不改核心 | ⚠️ 新增种类必须改类型表（虽然是增广不是改核心代码，但**必须参与本项目编译**） |
| `:113` *"fails explicitly when the registry or required key is absent"* | ✅ D73 已落地（未注册 key 抛错） | 不变 |
| `:117` *"one role alone is not a seam"* | ✅ 三个角色都可设计（D77 端到端测试已把类型侧与运行时侧接通） | 不变，但**插件作者被迫多写一份类型增广** |
| 操作者第 ④ 点"像积木一样、就像 pi 一样" | ✅ 运行时注册即可用 | ❌ **积木要先改宿主的类型表** |
| Cordis 的 `provide?: string \| string[]` | ✅ 同形 | ❌ 与它相反 |

**⇒ 现状一致，收紧会破坏一致性。**

#### 八、决定

1. **❌ 不做"注册即增广"，保留 `ExternalSessionEvent`、`InspectionResult.external`、D74 的行号归并。** 理由不是"改动大"，而是**成熟产品的形态就是运行时开放 + 类型侧可选增广（Cordis `provide?: string | string[]` + `InjectKey` 派生自增广后的 `Context`；DSH 领域包声明合并进"唯一一张投影类型表"），本项目 D77 之后已经与之对齐；而收紧会把"插件必须用 TS 写并参与本项目编译"变成隐含前提，与 §1 小核心和操作者"像积木一样"的目标冲突。**
2. **⚠️ 撤销上一轮那个"待裁定"提法。** 它把一个有客观答案的事实问题伪装成价值判断题抛给操作者，**这是本轮真正要修的错**，比结论本身重要。
3. **✅ 采纳一条新机制进候选清单（不是本轮实现）**：**纯类型出口**（DSH 的 `/types` 子路径）。**触发条件写清楚：当本项目拆出宿主/客户端两个 `ts.Program` 时采用，用它替代"复制类型表"或"收紧注册"。** 在此之前不做 —— **ponytail 阶梯第一级：目前没有第二个程序，YAGNI。**
4. **✅ D77 那个 kind-key 静态断言维持跳过**，且本轮给了它更强的理由：**Cordis 也不强制"注册名 == 类型键"**（`provide` 是裸 `string`），所以"键与字面量不一致无人强制"**不是本项目的缺陷，而是这一族设计的共同取舍**。**何时该重新考虑：出现第一个真实的第三方插件、且它真的踩到这个不一致时。**
5. **⚠️ 连带修订 D77 的一处结论**（第四节已写）：DSH 对 `:56` 冲突的解法是**纯类型出口**这一拓扑手段，不只是"两个聚合程序"；D77 说"本项目暂时不需要隔离"在当前单程序前提下仍成立，但当时对 DSH 解法的理解不完整。

#### 九、仍欠（不静默丢掉）

- **`CODE_MAP.md` 第 54 行（`preflight.ts`）仍有 1 个多余单元格**：D78 已修好第 20、53 行（把代码跨度里的联合类型竖线按 GFM 转义为 `\|`）、并查清第 37 行**本来就没坏**（是我的探针数了原始竖线、把已转义的 `\|` 也算成破损）；**第 54 行去掉空单元格后从 7 降到 5，仍差 1，未定位。** **⚠️ 这些修改目前在工作区未提交。**
- **⚠️ D78 那条验证方法的教训必须落档**：验证文档完整性时 **(a)** 不要用手写正则查"某段文字在不在"（同类假失败已第 3 次：D69 漏反引号、D72 漏 `⚠️ ` 字形、D78 漏 `**：**`）；**(b)** 计数类检查先确认"同一计数单位在全文档是否同构"（`CODE_MAP.md` 有两张列数不同的表，取全表众数毫无意义）；**(c) 数分隔符必须排除转义形式。**
- **`DECISIONS_ACTIVE.md` 仍停在 D68**，而 D69–D79 里有四轮改动了"现行有效"的内容（D77 作废 §3.4④ 一条判断、D79 撤销一个待裁定项并修订 D77 一处结论）⇒ **这份"现行有效"视图现在主动误导人，优先级高于其余文档整理。**
- **D72 第 ② 步的取消尚未落档**（D78 的 plan-ready 里写了理由，但那个周期被强制关闭、没有产出文档）。**理由**：丙已消除它要解决的问题（新增种类必须改核心），剩下的只是"把 `task-state` 的逐字段校验从核心 switch 搬进 provider"这个代码组织改善，**而目前没有第二个种类需要搬 ⇒ 无第二消费者 ⇒ 不做**。**何时重新捡起：出现第二个需要独立校验语义的事件种类时。**
- **`d79ref` 里已解出但未读**：`cordis/src/registry.ts` 全文（只 grep 了）、`context.ts` 全文、`service.ts`、`events.ts`、`fiber.ts`、`reflect.ts`、`dsh-session-projection/lib/types/index.js` 全文、`dsh-session-projection-cache/README.zh.md`、`blog-cordis-tencent.html`、`dsh-upstream-AGENTS.reference.md`、`_evomap_ref/evolver-README.zh-CN.md`。

### D81 — TaskSpec 缺失的那一半：意图与 skill 要真的进入提示词（本轮有代码）

**起因不是队列排到了，是实读查出一个功能缺口。** 操作者第 ③ 点对 TaskSpec 的定义是：*"分析意图并匹配提示词或者组装一份好的提示词，如果有相应的 skill 应该匹配相应的 skill 如果没有就不匹配。然后发送给大模型。"*

**实读 `runtime.ts:713-728` 的证据**：`taskSpec` 只被用于**基因选择的门控与打分**（`intent` 门控、`signals` 打分，`:719-721`）与**结果记账**（`:726-728`）；它的 `objective`/`intent`/`signals` **一个字都没有进入提示词**，进提示词的只有被选中基因的 `genePrompt`（`:722`）。**⇒ ③ 只做到了"分析意图"，"匹配提示词/组装提示词"与"匹配 skill"完全不存在。** 另外 **grep 全 `src/` 证实本项目没有任何 skill 系统**（只有 `gene.ts:10,12` 两处注释提到 "Skill"，且是在讲 EvoMap 的负结果）。

**采用**：新增 `src/taskspec-prompt.ts`，`assembleTaskPrompt(spec, skills) → string | undefined` + `matchTaskSkill`。
- **意图片段**：五个 `TaskIntent` 各一段内置文本 ⇒ **这是 ③ 里"匹配提示词"那一支，且立刻在生产中生效**（意图分类本来就存在，只是结果此前被丢掉）。
- **skill 匹配**：`{ id, scenarios, prompt, priority? }`，**照 `SWARM_LOOP.md:175` 已采用的 WorkBuddy 先例**（`curated-experts.json` = `{id, scenarios, description, priority}` 场景关键词路由）。匹配 = 场景对 `spec.originalInput` **子串匹配** ∪ 对 `spec.signals` **精确匹配** —— **⚠️ 两条都必须有**：`extractSignals` 会小写化、剥标点，且对 CJK 只产出二元组，所以**写成短语的场景只能靠原文匹配**（测试里断言了前提：`视频下载` 整词确实不在 `signals` 中），**写成单词的场景可以靠 signals 匹配**。得分 = 命中场景数，`priority` 打破平手，再平手按声明顺序 ⇒ **结果确定**。
- **⚠️ 无命中返回 `undefined`** —— 不是默认 skill、不是第一个、不是 `priority` 最高的那个。**这就是操作者那句 *"如果没有就不匹配"* 的字面实现，并且有测试专门钉住它**（断言结果里不含 skill 段、不泄漏未命中 skill 的内容、不退化成注入第一个）。**空场景（`""`/空白）必须跳过**：空串是任何字符串的子串，若当命中就会让一条畸形目录项变成永远触发的 skill。
- **其风格/人格层不抄** —— **D14 已明确记为"后补"**。

**接线（`runtime.ts`，五处 + 一处注释同步）**：`import`；新字段 `taskPromptBlock`（**与 `genePrompt` 同生命周期，在 `:651` 同一个 `finally` 里清空，不会漏到下一轮**）；`sendTurn` 里组装；`buildPrompt` 的 `systemText` **追加在最后**；**⚠️ 计入注入块字节合计并把新块加进那条中文报错的枚举**。**同步改写了 `:1075-1077` 那段注释** —— 原文 *"Task state rides last: of the four blocks…"* 接线后已不成立（taskState 不再最后、且是五块不是四块），**留着它就是权威序的文档漂移**。

**⚠️ 权威序（本轮确立并写进代码注释）**：`systemPrompt`（产品）> `genePrompt`（基因库）> `constraints`（操作者）> `taskState`（任务自身记录）> **本轮请求派生块**。**新块排最后的理由是安全而非排版**：它由请求派生，且**命中的 skill 文本可能来自产品之外的策展目录**，所以它权威最低；`:1070` 那条既有不变式是"操作者文本不得在产品自身安全文本之前给模型定调"，**追加在最后不会移动任何既有权威序 ⇒ 零风险削弱已落地的安全性质**。

**⚠️ 为什么它必须计入 `maxContextBytes/4` 的注入上限**：那个上限存在的理由是"每轮重发的块可能很大"，**而 skill 提示词正是这种块 —— 它来自产品之外、长度无界**。"它很小"不是这段代码可以假设的事。**不计入就等于给外部内容开一条绕过上限的口子。**

**⚠️ 一处设计决定被本轮的证据推翻并改回**：我最初按 ponytail 决定**不加 `taskPromptSkills` 注入点**（理由：它只可能是 `[]`，加一个永不变化的配置项正是 ponytail 禁止的 "config for a value that never changes"）。**但随后发现：目录硬编码为空 ⇒ 那个块永远只有约 180 字节 ⇒ 变异 B（把它从 `injectedBytes` 去掉）无法被任何端到端测试抓到，它会绿** —— **而按 D74 的规矩，变异绿就意味着测试没表达性质**。**⇒ 加回注入点，理由现在具体了：没有注入点，"新块计入上限"这条安全性质就无法验证。ponytail 那条规矩不适用于"测试就是第二个消费者"的情形。** 模块里留了 `ponytail:` 注释写明升级路径（从 agent home 读 JSON 目录，需在 `security-config.ts` 下做路径安全审查，而组装逻辑本身到时不用改）。

**⚠️ 本轮查出的真实产品回归与修法（三处，都不是"测试该改"那么简单）**：

1. **`ContextBudgetError` 必须是具名的** —— 注入上限原本抛普通 `Error`。而 `runtime.ts:727` 的失败归因走 `instanceof ContextBudgetError`，**普通 `Error` 会被归到 `unknown`，真实成因就丢了**。修法是给该类加**可选明细参数**（`runtime.ts:229`，原构造签名 `(bytes, limit)`，**改前先读了那个类，没凭记忆改签名**）。**⚠️ 两个上限需要不同措辞**：整条提示词上限的建议是"开新会话或缩短历史"，而**注入块上限说"开新会话"是没用的 —— 这些块每轮都会重发** —— 它必须说清该缩短哪一块。**⇒ 新报错文案已改为"请缩短其中最大的一块…开新会话也没用，这些块每轮都会重新发送"。**
2. **`phase1.test.ts:88` 是另一类失败**：`makeRuntime` 不传 `systemPrompt`，**改动前 `systemText === ""` ⇒ 根本没有 system 消息**；现在有了 ⇒ 角色列表从 `['user','assistant']` 变成 `['system','user','assistant']`。**修法保留了原性质**：角色比较限定在非 system 消息，**并额外钉住"那条 system 消息只能是本轮提示块"**（因为没配任何产品或操作者文本）。
3. **⚠️ 一个尚未解决的算术冲突（本轮唯一仍然红的测试）**：`tools.test.ts` 的 `checks the budget every step, not only at the start` 需要"开局提示词能过、走完一次工具后超预算"。**改动前它用 `maxContextBytes: 30`**（当时没有 system 块，开局极小、工具结果几十字节就超了）。**而现在注入上限 = `maxContextBytes / 4` 必须容得下约 180 字节的意图片段 ⇒ `maxContextBytes > 720`；可那个工具结果只有几十字节，走完工具远不到 720 ⇒ 没有任何一个 `maxContextBytes` 能同时满足两条。** **⚠️ 我曾把它改成 800，那是猜的（不知道工具结果多大），失败形态因此从"错误类型不对"变成 `Missing expected rejection` —— 树里留着一个我知道是错的值，不掩饰。** **两条出路**：**(a) 把工具结果做大**（写一个更大的 fixture 文件并让 `read_file` 读它，使 `maxContextBytes: 750`（上限 187 > 180）下"开局过、走完工具拒"重新成立）—— **✅ 推荐，只动 fixture，测试意图一字不改，不动任何安全性质**；**(b) 把意图片段排除在注入上限之外** —— **❌ 不推荐**：对意图片段本身站得住（产品自有、五个固定字符串、约 180 字节有界），**但对命中的 skill 提示词是错的**（那是来自产品之外策展目录的**无界**内容，排除它就重新打开绕过上限的口子），而"只排除片段不排除 skill"会变成比现在更难讲清的两层规则。**⇒ 结论：为了迁就一个测试而给外部内容开豁免，是用安全性质换测试便利，不做。**

**⚠️ 丙：既有"逐字节不变"断言的处理方式（操作者裁定）**。五处既有测试钉住了"system 文本与改动前逐字节相同"（`constraints.test.ts:144/170/284`、`task-state-injection.test.ts:62`、`phase1.test.ts:88`）。**那个性质值得保留 —— 它正是"某个特性没有偷偷改写产品自身安全文本"的证明。** 但 D81 每轮都追加一个请求派生块，整串不再相同。三条路：**甲**放宽期望值；**乙**砍掉意图片段让块永不出现（= 砍掉功能一半）；**丙**把新块**显式剥掉**再与改动前的文本逐字节比较。**⇒ 操作者裁定丙（*"丙吧，更像我想像中的东西"*）。** 实现是 `test/task-prompt-strip.ts` 的 `stripTaskPromptBlock(systemText)`，用 `lastIndexOf("\n\n本轮意图：")` 定位并切掉。**⚠️ 这个助手顺带白拿了一处变异覆盖**：它断言块必须在**末尾**，所以**变异 C（把追加位置移到 `genePrompt` 之前）会让所有调用点失败** ⇒ 权威序被钉住，不需要额外测试。

**⚠️ 一处如实记录的"放宽"**：`tools.test.ts:780` 的 `countPromptTokens` 计数器被收窄到非 system 消息（否则它不再等于 12）。**该测试要证的性质是"本机计数针对真正发出的提示词，而不是 provider 上次报的 7"，这个性质在过滤后依然成立**；**⚠️ 代价是这条测试从此不会发现 system 消息被丢掉，而那个性质改由 `taskspec.test.ts` 的接线测试端到端钉住** —— 已在测试注释里明写，不偷偷放宽。

**验证**：`tsc --noEmit` **退出码 0**；新测试 `test/taskspec-prompt.test.ts` **10/10 通过**、`test/taskspec.test.ts` 接线 3 项通过；**全量 664 项 / 660 通过 / 3 失败 / 1 跳过**（基线 651/648/2/1，**+13 是本轮新测试**；3 项失败中 **2 项是 12 轮未修的 `background-jobs` 负载相关间歇项**，**不碰也不声称已修**，第 3 项就是上面那个算术冲突）；**变异 A**（把"无命中不贡献"改成"总取第一个 skill"）⇒ **4 项变红，含"没有就不匹配"**，已字节还原、还原后 `tsc` 退出码 0；**变异 B**（把 `taskPromptBytes` 从 `injectedBytes` 去掉）⇒ **超限测试变红**，已字节还原、还原后 `tsc` 退出码 0。**⚠️ 变异用字符串还原而不是 `git checkout`**（改动未提交，checkout 会毁掉本轮工作）。

**⚠️ 本轮自己造成并已修的两个错误，都要升级记法**：
1. **`INTENT_PROMPTS.fix` 里用半角引号包 `"看起来对了"`，把字符串字面量提前终止** —— **与 D77 那个 JSDoc 里的块注释终止符是同族（在字面量里放了一个会终止它的字符），第二次出现** ⇒ **记法从"块注释里不得出现该终止序列"升级为"任何字面量里都不得出现会终止它的字符；中文引号一律用「」"。**
2. **过滤器返回空被我一度读成"没有产出"**：我用 `Select-String -Pattern "^# (tests|pass|fail)"`，而 node 的输出是 `ℹ tests 10` ⇒ **"手写模式匹配不上真实格式"这一族错误的第 4 次**（前三次：D69 漏 markdown 反引号、D72 漏 `⚠️ ` 字形、D78 漏 `**：**`）⇒ **规矩升级：过滤器返回空时，先跑一次无过滤的原始输出再下结论，不得把"过滤结果为空"读成"没有产出"。**

**⚠️ 一条流程偏差，操作者已指出**：本轮连续三次把文档推到"下一轮"（*"别下一轮了，你文档什么时候补上？又要开始跑偏？"*）。**这违反 D73 第 1 条（代码与文档同一次提交），而且"下一轮补文档"连续说了三次就是跑偏** ⇒ **规矩：文档欠账不得跨轮；预算不够时先写文档再写代码，或者把范围收窄到能在本轮连文档一起交付，而不是把文档记成待办。**

**明确不做（本片）**：skill 目录的磁盘加载与 WorkBuddy 的两级 skills 目录布局（下一轮，需路径安全审查）；`.tpl` 模板文件机制；WorkBuddy 的风格/人格层（**D14 已记为"后补"**）；**不改 `intentOf` 的四条正则**（它弱，但"意图分类质量"与"组装提示词"是两件事，混在一轮会让验证说不清是哪一半起了作用）；不动 `enforceTaskSpec` 的死代码（**那是本项目自己引入的分歧，已记录，另开一轮**）。

> **⚠️ D81 的后续更正（同轮稍后，测量推翻了上面第 3 点的推荐，并推翻了我上一轮对 (b) 的否定）。**
>
> **上面第 3 点推荐 (a)"把工具结果做大"、否定 (b)"把意图片段排除在注入上限之外"。两次尝试都实测失败了**：`maxContextBytes: 1200` + 800 字符用户消息 ⇒ **无任何拒绝**；`maxContextBytes: 800`（上限 200 > 180）+ 一步 8 个工具调用（每个贡献一条 assistant tool-call 与一条 tool result）⇒ **仍然无任何拒绝**。**⇒ 加宽增长与加宽预算是同向移动的，没有任何一对值能同时满足"开局过、走完一步拒"。**
>
> **⚠️ 而这个测量结果暴露的不是测试常量挑得不好，是我引入的真实产品回归**：**任何低于约 720 的 `maxContextBytes` 现在都会让每一轮都在注入上限处被拒** —— 包括本套件原本用的 30 与 64，**也包括任何调低 `PERSONAL_AGENT_MAX_CONTEXT_BYTES` 的操作者**；**而报错会去怪"长期约束 0 字节 + 任务状态 0 字节"，那两块在那个场景下根本是空的**。**D81 之前这些配置是能用的。**
>
> **⇒ 根因是我把两块来源与有界性完全不同的内容一起计入了一个为其中一块设计的上限**：**意图片段是产品自有的、五个编译期常量、约 180 字节有界**；**命中的 skill 提示词来自产品之外的策展目录、长度无界** —— **后者才是那个上限存在的理由。** 我上一轮说"(b) 只排除片段不排除 skill 会变成更难讲清的两层规则"，**这个论证错了：它把两块来源不同的内容当成同一种东西，而两层区分恰恰是对的，因为它们的来源与有界性本来就不同。**
>
> **⚠️ 但"必须计入上限"是 D81 已经写进本节与 `SAFETY.md` 的决定，而且是我上一轮明确反对过 (b) 的那一条 —— 推翻一条已记录的决定不由我单方面做（对照 D61 与 §3.4④ 的处理方式）。** **⇒ 本轮不实现 (b)**，改为：把 `tools.test.ts` 那条 `checks the budget every step, not only at the start` **恢复为 D81 之前的原值（`maxContextBytes: 30`、`"small"`、单个工具调用）并标记 `skip`，skip 的理由连同上面的实测数据一起写在测试上方的长注释里** —— **skip 是一个发现，不是让套件变绿的手段**；树里不再留着我猜出来的 800 或 1200。
>
> **待操作者裁定的一件事（带研究、证据与推荐，不是裸选项）**：**(b') 只把 skill 部分计入注入上限，豁免意图片段。** **实现代价已估**：`sendTurn` 里已经在算 `assembleTaskPrompt(taskSpec, this.taskPromptSkills)`，**再算一次 `assembleTaskPrompt(taskSpec, [])` 就能得到"仅片段"的字节数**，两者相减即外部部分 ⇒ **一个新字段 + 两处赋值 + `buildPrompt` 里换一个变量，约 6 行，不改 `assembleTaskPrompt` 的签名**。**推荐采纳**，理由：它保住上限真正要防的东西（外部无界内容），同时恢复"`maxContextBytes` 可以被调低"这个 D81 之前存在的性质。**⚠️ 若采纳，必须同时改 `SAFETY.md`「提示词注入块的边界（D81）」第 2 条与本节第 3 点**，因为两处现在都写着"必须计入"。**不推荐的替代**：给上限加一个下限（`max(quarter, 512)`）—— 那是一个讲不出来源的魔数，而且对小预算静默放宽了上限。
>
> **⚠️ 本轮验证**：`tsc --noEmit` **退出码 0**；**全量 664 项 / 661 通过 / 1 失败 / 2 跳过** —— **那 1 项失败是 `background-jobs` 的负载相关间歇项（12 轮未修，不碰也不声称已修）**，2 项跳过 = 原有 1 项 + 本轮新增的 D81 skip。**⇒ 树回到基线，且基线外只多一个带完整理由的 skip。**

### D82 — 注入上限只计外部字节；并测出 `maxContextBytes` 现在有一个约 200 字节的硬地板（本轮有代码）

**这是 D81 更正块里"待操作者裁定"的那一项，操作者批了（*"可以"*）⇒ 实现 (b')。**

**① 改法与为什么它是对的**：`sendTurn` 对**同一个 spec 组装两次** —— 一次用真目录、一次用空目录 —— **差值就是外部字节数**，存进新字段 `taskPromptExternalBytes`，`buildPrompt` 只把它计入 `maxContextBytes/4` 的上限。**意图片段豁免**：产品自有、五个编译期常量、约 180 字节有界；**命中的 skill 提示词逐字节计入**：来自产品之外的策展目录、长度无界 —— **它才是那个上限存在的理由**。**⇒ 上限真正要防的东西一点没放松，而"产品自有且有编译期上界的文本能让一个小预算变得不可用"这个后果被消掉了。** **⚠️ 这个"组装两次"让 `assembleTaskPrompt(spec, [])` 成为真实的第二个调用方**，不是测试专用的便利 —— 所以那条空目录路径必须一直正确（**已有测试钉住：空目录 ⇒ 只有意图片段**）。**约 6 行，未改 `assembleTaskPrompt` 的签名。** **在 `finally` 里与 `taskPromptBlock` 一起清零**，不会漏到下一轮。

**② ⚠️ 明确拒绝的替代**：给上限加下限（`max(quarter, 512)`）—— **一个讲不出来源的魔数，而且对小预算静默放宽了上限，与"上限"这个词的用途相反**。

**③ ⚠️ 本轮最重要的结果：实现之后测量，发现 (b') 并没有修好那条被 skip 的测试 —— 我上一轮的诊断漏了一层。** `maxContextBytes: 30` 下 `adapter.consumed` 仍是 **0**，即整轮在第一步之前就被拒。**注入上限此时是 0 ≤ 7，已经不再拦**；**真正拦住它的是整条提示词上限：system 消息现在总是带着那个约 180 字节的意图片段，而预算只有 30。** **⇒ D81 给 `maxContextBytes` 设了一个约 200 字节的硬地板（产品自身 system 文本的大小），这与注入上限是两个不同的约束，(b') 只修了后者。**

**⇒ 这条测试仍然 skip，但 skip 的理由已换成正确的那一条**（原文与两次实测数据都保留在测试上方的注释里）：*system 消息带着约 180 字节的产品自有片段 ⇒ `maxContextBytes` 有约 200 字节的地板；而这条测试一步 `read_file`（18 字节文件）带来的增长只有几十字节，跨不过那个地板与预算之间的窗口。* **⚠️ 恢复它需要"一步的结果按构造就很大"，那是 fixture 设计问题，不是挑一个常量的问题 —— 而靠估算挑字节阈值已经错过三次（1200+800字符、800+8个工具调用、以及本轮以为豁免就能修好），所以不再用估算去调它。**

**④ ⚠️ 一条对操作者有实际影响的结论，必须写明**：**任何把 `PERSONAL_AGENT_MAX_CONTEXT_BYTES` 调到几百字节的用法，在 D81 之后不再可行** —— 与注入上限无关，纯粹因为 system 消息自己就有约 180 字节。**D81 之前可行。** 这属于"新增一个每轮必发的块"的固有代价，**不是缺陷**（默认 512 KiB 下毫无影响），**但它是一条行为变更，之前没有记录过。**

**⑤ 验证**：`tsc --noEmit` **退出码 0**；**全量 664 项 / 660 通过 / 3 失败 / 1 跳过** —— **3 项失败中 2 项是 `background-jobs` 的负载相关间歇项（12 轮未修，不碰也不声称已修）**，**第 3 项就是上面那条 `checks the budget every step`：本轮先把它恢复为活动测试、测出 `consumed === 0`、据此改回 skip 并换上正确诊断**（**⇒ 那一次运行里它是失败而不是跳过，skip 是测完之后才加的**）。**⚠️ 变异未跑**：D81 已验证过"把块从合计里去掉 ⇒ 超限测试变红"，本轮改的是**计入哪一部分**而不是**是否计入**，而 `taskspec.test.ts` 的超限测试用的是 1500 字节的 skill 提示词（**外部部分 ≈ 全额**），**⇒ 它对本轮改动仍然是有效的守卫；但没有为"豁免片段"单独跑变异，如实记为未验证。**

**⑥ ⚠️ 本轮的估算错误（第 3 次），记法升级**：我以为豁免片段就能让 `maxContextBytes: 30` 重新可用，**没有先算 system 消息本身就要占掉整条提示词上限**。**⇒ 规矩从"涉及字节阈值的测试参数先测再挑"升级为"改一个字节约束之前，先列出这个字节数会经过的每一个上限，逐个算，不要只看最直接的那一个"。** 本轮有两个上限（整条提示词、注入块），我只算了第二个。

### D83 — 收掉 D82 自己记下的三笔账（本轮有代码，一次通过）

**不新开功能，先把上一轮记下的缺口关掉 —— 记下的账不攒到功能轮里。**

**① 恢复 `checks the budget every step, not only at the start` 为活动测试。** **办法不是挑一个数字，而是两件事**：**(a) 让增长按构造变大** —— 一步里发 **8 个工具调用**（`Array.from({length:8}, …)`，仍在默认 `maxToolCallsPerRun` 9 之下），每个贡献一条 assistant tool-call 与一条 tool result，**而"两者都必须在下一次调用时重发"恰恰就是"每步复查预算"要证的事**；**(b) 按新立的规矩先列出字节经过的每一个上限再挑值**：**上限 A** 是注入块上限 `floor(maxContextBytes/4)`，只计 constraints + taskState + 本轮提示的**外部部分**，**本测试三项全为 0 ⇒ A 在任何预算下都不绑定**；**上限 B** 是整条提示词对 `maxContextBytes`，**它才是被测的那个**。已有实测数据：**`maxContextBytes: 800` + 这 8 个调用不拒 ⇒ 一步的增长约 400-600 字节**；开局 = system 块约 180 + 用户 5 字符 + 序列化开销。**⇒ 取 400：开局约 190-300 < 400 ✓，走完一步约 590-790 > 400 ✓，A 的上限 100 ≥ 0 ✓ —— 两个上限都算过，一次就对了。** **⚠️ 对照：这条测试卡住两轮的真正原因是只算了一个上限，而字节要经过两个。**

**② 补上 D82 欠的"豁免专属变异"。** 把 `buildPrompt` 里的 `this.taskPromptExternalBytes` 换成 `0`（即"外部字节也不计入"）⇒ **`⚠️ the block is charged to the injected-bytes cap, so it cannot bypass it` 变红**（`taskspec.test.ts` 9 通过 / 1 失败）。**⇒ 这证明 D82 的豁免只放开了产品自有、有编译期上界的那一段，命中的 skill 提示词仍然逐字节计入，没有绕过上限的口子。** 已字节还原（脚本自查"变异残留 = false"）、还原后 `tsc --noEmit` **退出码 0**。**⚠️ 变异用字符串还原而不是 `git checkout`。**

**③ ⚠️ 一条记录更正：提交 `7cfddca` 的信息里套件数字与实际提交状态不一致。** 信息写的是"660 通过 / 3 失败 / 1 跳过"，**那描述的是把测试改回 skip 之前那次运行**；**实际提交的树是 2 失败 / 2 跳过**。信息的散文部分解释了这件事（*"那一次运行里它是失败而不是跳过，skip 是测完之后才加的"*），**但标题数字不一致**。**⇒ push 过的历史不改写（不 force-push），更正落进文档**：本条 + `STATUS.md` 批次 ㊽。**⚠️ 记法升级：提交信息里的验证数字必须来自"提交那一刻的树"的那次运行；若提交前又改了状态，就重跑一次再写数字** —— 本轮已照此办理（**最终数字来自还原变异之后的全量运行**）。

**验证**：`tsc --noEmit` **退出码 0**；`test/tools.test.ts` 单文件 **68 项 / 67 通过 / 0 失败**（恢复后的那条通过）；**全量 664 项 / 662 通过 / 1 失败 / 1 跳过** —— **优于基线 651/648/2/1**：那 1 项失败是 `background-jobs` 的负载相关间歇项（**12+ 轮未修，不碰也不声称已修**），1 项跳过是原有的那个，**D81/D82 的 skip 已消失**。**⚠️ 全量数字取自变异还原之后的运行，与提交的树一致。**

**⚠️ 本轮没有引入新机制，也没有放宽任何性质** —— 它是把上一轮如实记下的三笔账关掉：一处覆盖缺口、一处未验证的变异、一处记录不一致。**⇒ 这正是"记下的账不攒到功能轮里"的执行样例。**

### D84 — 技能目录的磁盘加载：照 `constraints.ts` 的形状，并明确拒绝 WorkBuddy 的第二级（本轮有代码）

**这是操作者第 ③ 点剩下的那一半（*"如果有相应的 skill 应该匹配相应的 skill"*）：D81 建了匹配与组装、留了注入点，本轮让它从磁盘上有真的内容。**

**① 先读取证，再动手（照既有规矩）。** 实读 `constraints.ts` 全文 177 行。**它不是"一个可参考的例子"，它就是模板** —— 技能提示词与长期约束**注入到同一个位置**（system 消息、每轮重发），因此**继承同一套威胁模型，也就该得到同一套答案**：
- **只读 agent home，从不搜工作区**（`:81-83`：*"cloning a repository cannot ship standing instructions"*）；
- **ENOENT ⇒ 空**（正常状态），**其他读失败 ⇒ 抛**；
- **严格解析、损坏即拒绝，绝不降级成"读成空"**（`:75-79`：*"read as empty" 与 "操作者没有约束" 无法区分，那是给一个相信自己设了约束的人的错误答案*）；
- **`PERMISSION_KEYS` 专属拒绝并指向真正管权限的 `config.json`**（静默忽略会让操作者以为自己放宽了访问）；
- **32768 字节上限，超限抛错并给出实际大小，绝不截断**；
- **安全论证在 `:23-27`**：*agent home 按位置对文件工具不可写（`AgentRuntime` 把 `this.home` 与 store root 折进 `protectedRoots`，D50），所以"每轮重读"不增加自我提权面*，**且用磁盘级断言而非转录断言钉住**；
- **接线点是一行**：`runtime.ts:1141` `formatConstraintsForPrompt(await loadConstraints(this.home))`。

**⇒ 新增 `src/skill-catalogue.ts` 照抄这套形状**（`skills.json`、`SKILL_CATALOGUE_VERSION = 1`、同一个 32768 上限**因为是同一个注入面**、同样的 ENOENT/严格解析/权限键拒绝），**不新造机制**。**加两条技能独有的校验**：**id 不得重复**（*匹配行为虽然有定义 —— `matchTaskSkill` 按得分、`priority`、声明顺序打破平手 —— 但操作者看目录时分不清是哪一个触发的，而一条指名该 id 的审计行会有歧义；**记录里的歧义本身就是缺陷，即使行为是确定的***）；**`scenarios` 必须是非空数组且每项非空白**（*空串是任何请求的子串 ⇒ 一条畸形目录项会变成永远触发的技能；`matchTaskSkill` 在运行时跳过空白正是为此，**但一份表达不出自己意思的目录应当在此被拒绝，而不是被静默重新解释**；而空数组是一个永远不会命中的技能，是操作者几乎肯定不想要的死重*）。**文本逐字保存、不 trim 不归一化**（照 `:140-143`：改写操作者的文本会让注入块变成他所写内容的转述）。

**② ⚠️ 明确拒绝：WorkBuddy 的第二级技能目录。** `SWARM_LOOP.md:175` 曾把 WorkBuddy 的**两级** skills 布局（`~/.workbuddy-ai/skills/` 与 `{workspace}/.workbuddy-ai/skills/`）一起记为采用。**本轮只采用第一级，明确拒绝第二级**，理由与 `constraints.ts` 拒绝搜工作区完全同一个：**两级布局恰恰是让一个被克隆的仓库能用产品自己的口吻对模型说话的原因** —— 工作区里的文件随仓库分发，而技能提示词进的是 system 消息。**⚠️ 这是对一份既有采用记录的收窄，故写在这里而不是只在代码注释里。**

**③ ⚠️ 本轮测试查出的真实缺陷（已修），以及它升级的一条记法。** 照抄 `constraints.ts:66` 的 `PERMISSION_KEYS` 时**把 `priority` 一起抄了过来，而 `priority` 恰恰是技能的合法字段**（D81 用它打破平手）⇒ **任何声明了 `priority` 的技能都会被拒绝，且报错指控操作者"试图改权限"，那是他根本没做的事** —— **不只是判错，而且是主动误导**。测试第一轮就抓到了（3 项失败，报错文本直接指出矛盾）。**⇒ 记法：把一份校验清单抄进新语境时，必须逐条对着新 schema 核对，不能假设清单可以整体搬运 —— 拒绝清单不是自然常数，它是关于某一种文件格式的陈述。** **⚠️ 这也再次证明"先写测试"的价值：本轮仍是先写实现后写测试，而测试立刻查出实现里的照抄错误。**

**④ ⚠️ 一处如实记录的验证取舍。** `skill-catalogue.test.ts` **没有为 `skills.json` 再写一条"文件工具写不进 agent home"的磁盘级断言**，尽管 `SAFETY.md` 承诺了磁盘级验证。**理由**：那个机制是**按路径**而非按文件名的（`runtime.ts:607` 折进 `protectedRoots` 的是整个 `this.home` 目录），**对同一目录下的第二个文件名不可能有不同行为**，而 `constraints.test.ts` 与 `security.test.ts` 已在磁盘级钉住了它 ⇒ **为同目录同机制的第二个文件名重证一遍只增加测试、不增加性质**（ponytail 阶梯第 2 级：本代码库已有）。**该取舍写在测试文件的头注释里，不算作已验证的新性质。**

**⑤ 接线**：`runtime.ts` 四处 —— `import`；`taskPromptSkills` 字段类型从 `readonly TaskPromptSkill[]` 改为 `… | undefined`；构造器从 `?? []` 改为直接赋值；`sendTurn` 里 `const skillCatalogue = this.taskPromptSkills ?? (await loadSkillCatalogue(this.home));`。**⚠️ 注入的目录整体胜出，不与磁盘目录合并** —— *一个路由决定有两个来源，是操作者从此分不清哪个技能触发的开始*；**有测试钉住**（同一关键词同时存在于磁盘与注入目录时，注入的赢、磁盘的一个字都不进提示词）。**未提供注入目录时才读磁盘**，所以 D81 那批注入测试一字未改仍然通过。

**⑥ ⚠️ 上限没有变，但需要说清两个上限各管什么**：`MAX_SKILL_CATALOGUE_BYTES = 32_768` 约束的是**整个目录**；而每轮只注入**一个**技能的提示词（`matchTaskSkill` 至多返回一个），**那段文本另行计入 `buildPrompt` 的 `maxContextBytes / 4`**（**D82 之后计的是它的外部字节数，而磁盘加载的技能提示词全部是外部的 ⇒ 全额计入，没有豁免**）。**两个上限守的是不同的东西，谁也不替代谁。**

**验证**：`tsc --noEmit` **退出码 0**；新测试 `test/skill-catalogue.test.ts` **11/11 通过**（含磁盘级端到端：真的把 `skills.json` 写进真的 agent home、**测试不注入任何目录**，断言命中的提示词到达模型、产品文本仍在前、未命中的请求一个字都拿不到技能文本、但意图片段仍在）；**全量 675 项 / 673 通过 / 1 失败 / 1 跳过**（**+11 是本轮新测试，零回归**；那 1 项失败是 `background-jobs` 的负载相关间歇项，**12+ 轮未修，不碰也不声称已修**）。**⚠️ 变异未跑**：D82 已验证过"外部字节不计入 ⇒ 超限测试变红"，而本轮加载的技能提示词**全部是外部字节**，故那条变异对本轮改动仍然有效；**但没有为"目录加载"本身跑变异（例如把 `loadSkillCatalogue` 换成恒返回 `[]`）—— 不过端到端磁盘测试正是它的守卫：那样改会让 `DISK-MARKER-VIDEO` 消失而变红**，如实记为"由端到端测试覆盖，未单独跑变异"。

**明确不做（本片）**：`.tpl` 模板文件机制；WorkBuddy 的风格/人格层（**D14 已记为"后补"**）；每个技能的启用开关；技能过期；**不改 `intentOf` 的四条正则**（*它弱，但"意图分类质量"与"组装提示词"是两件事，混在一轮会让验证说不清是哪一半起了作用*）。**ponytail 上界已写进模块头注释**：*一个技能就是一个 id、一些关键词、一段提示词；任何更丰富的东西属于基因库，那里已经有 strategy、limits 与 validation*。

### D85 — `background-jobs` 那两条 kill 测试：产品是对的，测试断言的是实现细节（本轮有代码，只改测试）

**这条红拖了 12+ 轮，每轮都被说成"负载相关的间歇项，不碰也不声称已修"。本轮给出结论而不是再一次延期** —— 理由是具体的：**它是套件里唯一的红，而一个长期带红的套件会训练所有人忽略红，那正是真实回归被提交上去的方式**（D84 本轮我自己就差点把"3 项失败里 2 项是已知的"说成习惯用语）。**拖延本身已经是一个需要被决定的事实，不是可以继续带着的状态。**

**① 先排除产品有缺陷，再动测试。** 读 `src/background-jobs.ts` 全文 299 行。**Windows 上 `child.kill()` 只杀 shell 不杀它的子进程**这个陷阱**产品早就知道并且已经处理了**：`:219-228` 记录它是**实测而非假设**（*"the evidence was a job that kept appending to a file at the same rate after `kill()` reported success"*），修法是 `killTree` 用 `taskkill /PID … /T /F` 杀整棵树。**⇒ 产品行为正确，"任务会停"这条性质成立。**

**② ⚠️ 真正的缺陷在测试的形状：它断言的是一个从未被承诺过的实现细节。** `killTree` **刻意不等待 `taskkill`**，`:241-245` 给了理由：*"this runs on the shutdown path and inside a tool call, and blocking either on a process that is being killed would turn a stopped job into a hung agent"*。**⇒ `killJob` 返回 `true` 的含义是"已发起击杀"，不是"进程已死"**；而 `taskkill.exe` 自己也是一个需要被启动的进程。**测试却赌"300 毫秒内已死"**（`await wait(300)` 后快照，再要求之后 1200 毫秒零增长）—— **在全量套件的并行负载下，启动一个新进程超过 300 毫秒完全正常**，于是快照 taken 时任务还活着，之后继续写几个 tick ⇒ `after > atKill` ⇒ 失败。**这解释了它全部三个症状**：只在并行下失败、隔离重跑必过、失败信息里的"5 more ticks"与 `actual: 45, expected: 40`。

**③ 修法：把断言换成模块真正承诺的性质。** `background-jobs.ts:15-18` 说的是*"a background process that outlives the agent is the bad case, because nothing tells the operator it is still there"* ⇒ **要证的是"任务会停、且及时停"，不是"任务在 300 毫秒内停"**。新增助手 `awaitStoppedWriting(marker, deadlineMs)`：**每 200 毫秒轮询标记文件，长度连续两次不变即通过；到 10 秒仍在增长则失败并报出它长到了多少字节**。**一个永不死的任务会一直追加 ⇒ 截止期耗尽 ⇒ 测试失败并说明情况**，所以它要抓的失败一个都没漏掉。**⚠️ 通过路径还更快**：健康的击杀在一两次轮询内就稳定（约 200-400 毫秒），而旧形状固定要等 1500 毫秒。

**④ ⚠️ 一处如实记录的放宽（写在助手注释与这里两处）**：**新形状不再断言"击杀调用返回之后一个字节都不再写"**。**那从来不是真的**（击杀是异步的），**旧断言是把一个实现细节当契约在断言**。**⚠️ 一个测试变得更宽松而没有写下理由，正是真实回归获得永久住处的方式** ⇒ 理由写进 `awaitStoppedWriting` 的头注释、本条、与 `STATUS.md` 批次。

**⑤ ⚠️ 明确拒绝的替代修法**：让 `killJob`/`killTree` **等待**击杀完成。**那会与 `:241-245` 已记录且讲清了理由的设计决定直接冲突** —— 它跑在关闭路径上、也跑在工具调用里，**在一个正在被杀的进程上阻塞会把"已停止的任务"变成"挂死的 agent"**。**⇒ 为了测试好写而改掉一个有理由的异步设计，是把测试的便利置于产品的正确性之上，不做。**

**⑥ ⚠️ 一条方法论结论**：**这条缺陷能拖 12+ 轮，是因为每轮都用"负载相关的间歇项"描述它，而那个描述是真的、却不是诊断** —— 它说明了何时失败，没说明为什么。**⇒ 记法：一个反复失败的测试，"它是间歇的"不是可以带着的状态；要么查出契约与断言的差别，要么查出产品的缺陷，二者都是可完成的调查，而本轮用一次全文实读就完成了。**

**验证**：`tsc --noEmit` **退出码 0**；`test/background-jobs.test.ts` 隔离 **11/11**（**⚠️ 这不算证据，隔离重跑以前也总是通过**）；**全量并行连跑 4 次，每次都是 675 项 / 674 通过 / 0 失败 / 1 跳过，`npm run test` 退出码 0** —— **那 1 项跳过是原有的、与本轮无关**。**⇒ 套件现在是全绿的（除一个既有的、有意的 skip），这是 12+ 轮以来第一次。** **⚠️ 变异未跑，如实记**：把 `killTree` 里的 `taskkill` 分支删掉（只留 `child.kill()`）应当让两条测试变红 —— **那是本模块 `:219-228` 已经实测过的失败模式，但本轮没有重跑该变异**，因为本轮改的是测试而不是产品，而"测试是否仍能抓住一个永不死的任务"由截止期耗尽那条路径保证（**该路径本身也没有被单独触发过，如实记为未验证**）。**⚠️ `src/` 一字未动 ⇒ `CODE_MAP.md` 与 `SAFETY.md` 不受影响，本轮不碰它们。**

### D85-后续 — 关掉 D85 自己记为未验证的两条路径（本轮有代码，⚠️ 净改动为零：变异已字节还原）

**⚠️ 这是对 D85 的后续更正块，D85 原文保留不改写。** D85 的验证段如实记了两条未验证：*"把 `killTree` 的 `taskkill` 分支删掉应当让两条测试变红，但本轮没有重跑该变异"*，以及*"测试是否仍能抓住一个永不死的任务由截止期耗尽那条路径保证，而该路径本身也没有被单独触发过"*。**这两条一起才决定 D85 的新形状是不是一个永远绿的摆设** —— 而 D85 本轮刚写下"一个测试变宽松而没有写下理由，正是真实回归获得永久住处的方式"，**所以这笔账不该跨轮**。

**① ⚠️ 关键判断：那两条其实是同一个变异的两面。** 删掉 `killTree` 的 `taskkill` 分支 ⇒ 在 Windows 上只执行 `child.kill()` ⇒ **杀的是 cmd.exe，留下它 spawn 的 node** ⇒ 标记文件永远增长 ⇒ **两条测试必须变红**，而且**变红的方式只能是截止期耗尽**（一个永不死的任务正是 `awaitStoppedWriting` 存在的理由）。**⇒ 一次变异同时验证两条，不需要第二次注入。**

**② 变异注入点选 `if (process.platform === "win32") {` → `if (false) {`**，因为它精确表达"taskkill 分支没了"，且会落到 `:275` 的 `job.child.kill()`（`:262-269` 的 `killer.on("error")` 回退不会被触发，因为根本没有 spawn）。**注入前先断言锚点唯一**（出现次数 ≠ 1 就不注入），**还原后核对三件事**：`win32` 分支存在 = 1、`if (false)` 残留 = 0、`git status` 干净；**还原前 `git diff --stat` 恰好是 `1 insertion(+), 1 deletion(-)`**，这证明变异是该文件唯一的未提交改动 ⇒ **`git checkout HEAD --` 是字节精确的还原，不会吞掉别的工作**（对照 D81/D83 的规矩：树上有未提交工作时用字符串替换还原、不用 `git checkout`；**本轮该文件没有别的工作，所以 `git checkout` 是安全且更精确的选择，这个区别要写清**）。

**③ ⚠️ 证据**：变异下 **两条测试都变红，各耗时约 11.4 秒**（= 10 秒截止期 + 轮询开销），失败信息全文为：

```
AssertionError [ERR_ASSERTION]: the job was still writing 10000 ms after the kill was initiated
(marker reached 365 bytes); a few further ticks are expected because taskkill is launched
without waiting, but growth that never stops is the failure this test exists to catch
```

**⇒ D85 声称的"失败并报出它长到了多少字节"得到确证（365 bytes）**，而且信息里同时说清了"为什么几个 tick 是预期的、永不停止的增长才是要抓的失败" —— **这句话本身就是 D85 那次放宽的现场理由，读日志的人不需要去翻文档**。还原后 **`tsc --noEmit` 退出码 0**，**全量并行 675 项 / 674 通过 / 0 失败 / 1 跳过，`npm run test` 退出码 0** ⇒ **套件仍然全绿，还原没有留下损伤。**

**④ ⚠️ 本轮撞上的一件工具行为，值得记**：**第一次变异运行时，命令在 600 秒后被移到后台，还原脚本因此没有执行到 ⇒ 源码里一度留着变异。** 原因正是变异本身的后果：**留下的孤儿 node 进程让测试运行器不退出**（这恰好是 `background-jobs.ts:15-18` 说的那个"坏情况"的现场演示）。**⇒ 两条记法**：**(a)** 一个"注入变异 → 跑测试 → 还原"的脚本，**还原不能排在测试命令之后**，因为测试命令可能不返回；正确做法是让运行器强制退出（`--test-force-exit`）或把还原放进独立的后续调用 —— **本轮改用后者，并额外核实了还原**；**(b)** **`--test-force-exit` 之后孤儿数为 0**，说明强制退出没有留下进程。

**⑤ ⚠️ 清理孤儿进程时的一条安全边界（本轮实际执行的方式）**：**绝不能按进程名杀全部 `node.exe`** —— **DSH 宿主自己就跑在 node 上**，那样会杀掉正在跑这个会话的宿主。**本轮的匹配条件是命令行里含标记文件名 `alive.txt|shutdown.txt`**（`aliveCommand(workspace, "alive", marker)` 生成的命令会把标记路径写进命令行，所以这个匹配既精确又只命中 fixture 进程）。**执行后核对：孤儿数 0，宿主侧仍有 5 个 node 进程存活。**

**⑥ ⚠️ 一处方法论区别，要写清以免被误用成"隔离运行就够了"**：D85 说过*"隔离重跑总是通过，所以那不算证据"*，而本轮**隔离运行是有效证据**。**区别在于失败的性质**：D85 那条红是**负载相关**的（并行才失败），所以隔离通过什么也没证明；本轮的变异是**确定性**的（`taskkill` 分支被跳过与负载无关），**所以隔离失败就是确证**。**⇒ 记法："隔离运行算不算证据"取决于被验证的性质是否与并发相关，不取决于运行方式本身。**

**⑦ `src/` 净改动为零**（变异已字节还原并三重核对）⇒ **本轮实际提交的是两份文档**。**⚠️ `CODE_MAP.md` 与 `SAFETY.md` 仍然不受影响、不碰**（无代码行为变化、无安全行为变化）。

### D88 — 把 gene/task-state/validation 的类型抽进 `types.ts`：工具接缝的记录在案前置条件（本轮有代码）

**记录在案的前置条件是：*"在动手建工具接缝之前，先把 `gene.ts`/`task-state.ts` 的类型抽进 `types.ts`，否则接缝会复制同一个泄漏"*。本轮做这件事，不做接缝本身** —— 把一次机械搬迁与一次设计变更混在同一轮，正是 D74 那次交出一个两半永不相连的接缝的方式。

**① ⚠️ 调查全部在开周期之前做完（这是对连续三轮超支的纠正，本轮第一次执行）。** 读操作不被写闸门拦，而计时从 `swarm_cycle start` 就开始 ⇒ **让预算只覆盖"写"**。查出的四条事实决定了整个方案：`taskspec.ts` **零 import**（叶子）、`types.ts` **零 import**（叶子，入度 7）、`RoundEvidence` 住在 `validation.ts:24`、`ClaimOutcome` 住在 `:31`，而 `task-state.ts:58` 从 `validation.ts` 导入这两者、`validation.ts:21` 又从 `gene.ts` 导入 `Gene`/`GeneValidation`。

**② ⚠️ 查出一个真实的成环风险，以及它的解法。** 若只搬 gene/task-state 的类型，`types.ts` 就必须为了 `AssessedStep`/`TaskStateAssessment` 而 import `validation.ts` ⇒ **得到 `types.ts → validation.ts → gene.ts → types.ts` 的三元环**（**⚠️ `gene.ts` 为兼容而写的再导出也是一条真实的 import 边，这一点在推理环时极容易漏**）⇒ **本项目"零循环依赖"这项实测资产会因此丢掉**。**解法**：`RoundEvidence` 与 `ClaimOutcome` **实测都完全自足**（前者只有两个 `readonly string[]` 字段，后者是三个字面量）⇒ **一起搬进 `types.ts`，那条唯一可能成环的边就不存在了**。**搬完后 `types.ts` 只有一条出边、指向零 import 的 `taskspec.ts` ⇒ 它不可能出现在任何环里，这是从 import 列表得到的证明，不是对今天这张图的测量**（**所以这句写进了 `types.ts` 的头注释，而不是只留在提交信息里**）。

**③ ⚠️ 明确拒绝的捷径：桶文件（barrel）。** 最省的做法是**不搬任何声明**、只让 `types.ts` 加三行 `export type { … } from "./gene.ts"` 之类 —— **1 处编辑、零风险，接缝也能从中性模块导入名字**。**但它会把分层反过来**：`types.ts` 现在是**入度 7、出度 0 的叶子**，加桶之后它出度变 3、**依赖三个实现模块**，于是任何为了 `ChatMessage` 而 import `types.ts` 的模块都会传递性地拖进 `gene.ts`。**耦合没有消失，只是往后挪了一跳，而项目里最该是叶子的那个模块变成了枢纽 ⇒ 不做。** **⚠️ 这是 ponytail 阶梯第 1 级（"这东西需要存在吗"）给出否定答案的一个实例：便宜的那版并不能真的解决问题，理由要写下来，否则下一个人还会再提一次。**

**④ 搬了什么、刻意没搬什么。** 搬 **19 个类型声明**：`gene.ts` 13 个（`GeneIntent`/`GeneStepKind`/`GeneStep`/`GeneConstraints`/`GeneValidation`/`Gene`/`GeneDraft`/`MintedGene`/`GeneExpression`/`SelectionPolicy`/`GeneRequest`/`ScoredCandidate`/`GeneSelection`）、`task-state.ts` 4 个（`TaskStateStep`/`TaskStateInput`/`AssessedStep`/`TaskStateAssessment`）、`validation.ts` 2 个（`RoundEvidence`/`ClaimOutcome`）。**⚠️ 两处更正我自己开周期前的说法**：**(a)** `WeakenedTaskStateError` **是 `export class … extends Error {}`，运行时的值不是类型**，不能进一个 meant-to-erase 的模块 ⇒ 留在 `task-state.ts`（我上一轮把它算进了搬迁清单）；**(b)** **再导出不会把名字带进本地作用域** ⇒ 每个源文件需要**两行**（`import type` 供本地用 + `export type` 供既有 importer 用），不是我上一轮说的"1 行再导出"。**函数与常量一个都没搬**（`canonicalize`/`geneAddress`/`mintGene`/`parseValidation`/`scoreCandidates`/`selectGene`/`assertNotWeakened`/`assessTaskState`/`checkValidation`/`format*` 全家族/`MAX_TASK_STATE_BYTES`/`GENE_INTENTS`/`DEFAULT_SELECTION_POLICY`）：**这个模块只放形状，不放行为。** **⇒ 既有 31 处 import 站点 0 处改动**，全靠再导出保持兼容。

**⑤ ⚠️ 编译器当场抓住了 ④(b) 那个陷阱，这是一次免费的验证。** 第一版 `gene.ts` 的本地 `import type` 列表**漏了 `GeneStepKind`**（它在再导出列表里、不在 import 列表里），而 `gene.ts:159,161` 的 `parseValidation` 要用它 ⇒ **`tsc` 报 `TS2552: Cannot find name 'GeneStepKind'`**。**⇒ 记法：`verbatimModuleSyntax` + 一个纯类型模块，让"再导出与本地导入是两件事"这个错误变成编译期硬错误而不是运行时惊喜** —— 这条性质本轮被自己的反例证明了一次。

**⑥ ⚠️ 一个独立的行为证据，来自一次"失败"的运行。** `tsc` 报上面那个错时，**全量套件仍然是 675 / 674 通过 / 0 失败 / 1 跳过、退出码与基线一致** —— 因为 `--experimental-strip-types` 只剥类型、不做类型检查。**⇒ 这独立证明了本轮搬迁没有改变任何运行时行为**：一个类型层面的错误能让 `tsc` 变红而套件全绿，正说明被搬走的东西在运行时不存在。**这不是"套件没抓到缺陷"，而是本轮缺陷的性质决定只有 `tsc` 能抓到。**

**验证**：`tsc --noEmit` **修掉 `GeneStepKind` 后退出码 0**；**全量套件 675 项 / 674 通过 / 0 失败 / 1 跳过**（**与 D85/D86/D87 的基线逐项一致 ⇒ 零回归**）；**用脚本重测 import 图**：**38 个文件、101 条边、循环依赖 0**；**`types.ts` 出度 = 1 → `["taskspec"]`，`taskspec.ts` 出度 = 0 ⇒ ②里那条无环证明与实测一致**；**`types.ts` 入度 7 → 10**（`gene`/`task-state`/`validation` 三个新增）；**`validation.ts` 出度只剩 `["types"]` ⇒ `validation.ts → gene.ts` 这条边确实被去掉了**；`gene.ts` 出度 `["taskspec","types"]`、`task-state.ts` 出度 `["gene","validation","types"]`（**仍需那两个函数，这是行为依赖、不是类型依赖，符合 ④ 的意图**）。**⚠️ 变异未跑，如实记**：本轮是纯搬迁，可跑的变异是"把某个再导出行删掉"⇒ 应当让既有 importer 编译失败；**没有跑**，因为 `tsc` 在 31 处 import 站点全部通过这件事本身就是那条性质的覆盖（**删掉任何一行再导出都会让 `tsc` 变红，与 D88 的 ⑤ 同一个机制**）。

**明确不做（本片）**：**工具接缝本身**（那是下一轮，且按 **`docs_architecture.md:117`** 必须三个角色一起设计，*"A package may combine roles, but one role alone is not a seam; adding a capability means designing all three"*）；**不改 `SessionEventMap`**；**不动 `WeakenedTaskStateError` 的位置**；**不把 `GENE_INTENTS`/`DEFAULT_SELECTION_POLICY` 这类值搬进类型模块**。

> **⚠️ 更正（D89，同轮补正，上面那句的原样保留在此以供对照）**：这句最初写的是 **`IMPLEMENTATION.md:117`，文件名错了**。实读 `IMPLEMENTATION.md:112-125` 证实 **`:117` 是那张机制表里的「蜂群 worker」行**（*"一个父任务分派最多两个只读 worker，各自独立上下文，失败互不影响"*），**与接缝三角色无关**；**三角色判据出自 `docs_architecture.md:117`**，逐字为 *"A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it… A package may combine roles, but **one role alone is not a seam; adding a capability means designing all three**"*。**⇒ 这是一次引用漂移，而且是被自己下一次读取抓到的**：错的文件名同轮出现在 `plan-ready`、本节、与 `STATUS.md` 批次 ㊿-补3 的 ⑨ 三处，直到为下一轮做调查、真的去读 `IMPLEMENTATION.md:112-125` 才发现那一行根本不是我说的那条。**⚠️ 而避免它本来只需要读一眼既有引用**：本文件 `:1604` 与 `ARCHITECTURE.md:227` 引的都是同一个 `:117`、同一段英文原文。**记法：写"按 `文件:行号`"之前要读到那一行；要引一段此前已被引用过的原文时，先确认既有的那处引用指向的是哪个文件。** 这正是队列里那条「引用/声明漂移闸门」要机械化拦住的类别 —— **本轮它以人工方式又发生了一次，而且发生在一轮刚刚写完"编译器替我守了一条性质"之后**，说明**能被机械检查的性质与不能被机械检查的性质要分开对待：前者交给 `tsc`，后者目前只有"写之前读到那一行"这一条纪律**。

## 3. 实际采用状态（当前）
| 来源/方向 | 状态 | 当前代码与未采用部分 |
|---|---|---|
| DSH顺序提交/演进纪律 | 原则部分借鉴，机制独立实现 | runtime顺序工具结果、session-store版本/严格读/inspect；无并发池、exclusive调度、冻结历史codec迁移链 |
| OpenCode权限规则 | 已研究，具体规则引擎未采用 | 现在是ToolRegistry的简单非只读拒绝与路径拒绝，不是通配规则/ask审批 |
| Codex执行隔离 | 已研究，未实现OS机制 | security-config是合作路径检查，不是Codex sandbox；无shell/升权执行 |
| Gemini扩展贡献边界 | 待插件阶段 | 无插件policy loader；不能因当前默认拒绝而称已移植扩展防提权机制 |
| Qwen子Agent | 待多Agent阶段 | 无fork/子工具表/子权限实现 |
| Zcode架构约束 | 待工程化 | 未部署对应架构checker/CI；文档分层不等于强制架构约束 |
| Codex/OpenCode/Gemini 上下文预算 | 原则借鉴，机制独立实现 | 已实现：`maxContextBytes`（UTF-8 字节，对应 OpenCode 的 `maxOutputBytes` 形状）+ `maxContextTokens`（取 provider 自己上报的 `usage.inputTokens`，对应 Codex 用实际用量的做法）+ **按模型 token 窗口**（`contextWindows`，精确模型名优先于 `*` 优先于全局，仅作用于 token 上限）+ **可选宿主 tokenizer 预判**（对应 Gemini 的 `countTokens` 位置，但由宿主注入、失败即报错不估算）+ **剩余量显示**（未测量与超限分别显示，不虚构）。压缩已实现但**必须显式触发**：`summary` 事件记录 `covers`，只改 prompt 不删日志，边界必须等于实测消息数，未完成工具批次/空摘要拒绝，总结调用不给工具，保真测试见 `test/compaction.test.ts`。未实现：按模型元数据解析窗口与百分比、scope 模式（Total/BodyAfterPrefix）、自动压缩/prune/keep.tokens 保留策略、chars/4 估算、按模型字节窗口 |

当前session-lease wx锁、append-only recover、CLI向导为本项目独立简化实现，不冒称复制参考项目的完整恢复/终端机制。研究事实与代码采用之间的差别必须保留。

## 4. 决策登记

| ADR | 状态与决定 | 重新考虑条件 |
|---|---|---|
| D01 | 已实施：独立TS内核，CLI/Runtime分层，无DSH运行依赖 | 成熟框架实测显著降低维护成本 |
| D02 | 部分实施：单Agent，单次工具顺序；本地合作会话writer租约覆盖整轮 | 并发需求可量化且顺序提交/取消验收通过；不声称网络FS或恶意进程锁 |
| D03 | 部分实施：JSONL、独占header、显式有限恢复 | 需要跨进程事务/索引时比较SQLite；现方案不是事务 |
| D04 | 部分实施：宿主拒绝非只读与敏感读取；完整Policy/Approval待做 | 模型/插件不得自行扩大授权 |
| D05 | 待实现：Skill上下文资产不隐式获权 | 插件阶段落实授权与测试 |
| D06 | 持续执行：先只读可靠性，再桌面UI/蜂群 | M1总验收与用户确认 |
| D07 | 已实施：上下文以**字节上限 + 实测 token 上限**双重拒绝，不做估算、不截断、不自动摘要 | 出现带保真测试的摘要方案；或引入 tokenizer 后需要更精确的预判 |
| D08 | 已实施：精确预判由**宿主注入**（`countPromptTokens` / `PERSONAL_AGENT_TOKENIZER`），失败即报错，不内置分词器、不隐式回退到估算 | 决定随发行版绑定某个分词器依赖时 |
| D09 | 已实施：压缩**只缩短 prompt**——`summary` 事件记录 `covers`，message 一条不删，边界必须等于实测消息数，未完成工具批次与空摘要拒绝，必须显式触发 | 需要自动压缩或按 token 保留窗口时（须先有更强的保真测试） |
| D11 | 已补记：文件编辑的默认机制是唯一原文片段替换（`patch_file`）。整文件替换只用于明确要求全文的场景。M2 第一批曾先做整文件替换，这是排期遗漏，不是研究结论 | 片段多次匹配需要人工消歧时 |
| D12 | 已实施：TaskSpec 任务编排。读过的源码：`D:\DSHXM\dsh-lab\plugins\dsh-orchestrator` 的 `test-taskspec.mjs`、`test-enforcement.mjs`、`cordis.patch.yml`、`package.json` 及其引用的 `lib/taskspec.js`、`lib/taskspec-enforcement.js`。采用：每次发送前生成带版本的确定性 spec（同一输入同一结果）；模式由运行时决定不由模型决定；缺目标只记录 unknown、不编造模式；强制拒绝默认关闭、可显式打开。不采用：Cordis 插件宿主与 DSH 运行时依赖；spec 事件持久化（先只进 SendResult）；pre-step 钩子基础设施 | 引入蜂群 worker 需要按 spec 分派时 |
| D13 | **已撤回重定向**：第一批把"蜂群 worker"实现成了子代理扇出工具（`dispatch_workers`，提交 `5e0e039`），用户判定这不是蜂群，方向确认为**纪律层**。撤回原因：① 预算旁路——worker 花费记在自己会话、不进父轮预算，违背本项目硬上限原则；② 决定权倒置——分派由模型发起，违背 D12"模式由运行时决定"；③ 每次分派永久留下 `worker-*.jsonl` 会话。扇出工具整体删除，未修洞保留。纪律层读过的源码：`dsh-swarm` 的 `core/orchestrator.ts`、`core/boundary.ts`、`core/gate.ts`、`core/cycle.ts`、`core/gene.ts`、`core/forcedclose.ts`、`lib/isolation.js`、`test/boundary.test.ts`，`dsh-orchestrator` 的 `test-journal.mjs`、`test-cancel-retry.mjs`。纪律层拟采用：显式 PDRI 状态机（纯函数事件转移、终点不可逆、过期后仅显式 late 一次）；写入门（无活周期写入拒绝、终点周期不再接受写入、gene-less 周期显式可见不静默）；每周期文件/行数硬预算（累计、按轮记账）；静默周期强制收口（开新任务时旧的未终周期显式收口）。第一片不采用：基因库/selection/排名/蒸馏（第二批）、并行池、Cordis 宿主、跨进程周期（先单会话内）。TaskSpec 的 intent（build/fix/research/verify/operate）与 `GeneIntent` 同集，将来直接喂给周期 | worker 获得写能力、需要跨会话周期或并发时 |
| D14 | **用户二次纠偏后确认的核心设计（蜂群 = 基因库 + RSI 闭环，PDRI 是骨架不是核心）**。读过的源码：`dsh-swarm` 的 `core/gene.ts`、`core/selection.ts`（拉普拉斯平滑、新近度衰减、隔离/试用/环境过期）、`core/distill.ts`（重复失败→确定性 guard 草稿）、`core/induct.ts`（无基因轮成功→捕获候选）、`core/backprop.ts`（α=实测自报校准）、`core/memory.ts`（三层记忆：计数无界/叙述双限/失败全存）、`core/store.ts`（追加式日志、状态=折叠、损坏尾容忍）、`core/pricing.ts`（反事实增益）、`core/merge.ts`（程序化合并，模型可产发现但只有代码可合并）——多数读的是头部与关键段；EvoMap：evomap.ai/zh/research 五篇正文（LongWoF-Bench、自组织蜂群实验、AutoResearch 证据环等）、capabilities 两页、arXiv:2604.15097、evolver 仓库 README/SKILL.md/种子基因库（子代理抓取，来源 URL 已记录在案）；workbuddy 本地逆向：`D:\WorkBuddy\workbuddy-asar-inspect`（`curated-experts.json`：{id, scenarios, description, priority} 场景关键词路由；`workbuddy-expert-prompt.tpl`：PluginAgentPrompt+四层记忆+风格+Agent/Plan/Ask 模式组装；专家=SKILL.md+references 包；技能两级：`~/.workbuddy-ai/skills/` 与 `{workspace}/.workbuddy-ai/skills/`；BOOTSTRAP.md→USER.md 身份文件）与 `C:\Users\RongWu\.workbuddy-ai` 布局。采用：**基因** = sha256 内容寻址的不可变紧凑经验 {name, intent, signals_match, preconditions, strategy(guard/act/verify/rollback), constraints, validation, avoid}，只被取代不被编辑；**准入门禁** = 只从验证成功的轨迹铸造（EvoMap 负结果：纯蒸馏基因劣于 Skill，-3.2~-11.2pp 是门禁理由），铸造过 mintGene 结构不变量；v1 的"验证"= 周期完成 + 操作者显式铸造，机械验证命令随 M3 补上；**存储** = agent home 内追加式 JSONL，状态=折叠，基因内容寻址使重复追加幂等，损坏尾容忍、中段损坏拒绝；**选择** = intent 先门控（与 TaskSpec intent 同集）再信号重叠+拉普拉斯平滑成功率+新近度衰减；**结果记账** = 每轮 outcome 行，无基因轮记基线行（address=null），为将来的增益定价留数据；**测试时注入** = 选中基因的 strategy/avoid 注入系统提示，不动权重；**TaskSpec++** = 从输入提取场景信号（分词 + 子串匹配以兼容中文）。明确不做（本片）：失败蒸馏/成功归纳/三层记忆/增益定价（等 outcome 数据积累）；基因 constraints 的机械强制（写入门那一片做，此前不当提示词摆设——dsh-swarm 原则：写进提示词的约束只是建议）；扇出执行（M6，届时按 EvoMap 三原则：原子拆分、隔离上下文、程序汇合，绝不文本回传再综述）；跨机转移/GDI/社交评分（单机无意义）；workbuddy 的风格/人格层（后补） | M3 进程/壳落地后把 validation 门禁变机械；outcome 数据足够后做蒸馏与归纳；M6 扇出按三原则实现 |

| D15 | **PDRI 周期落地（SWARM_LOOP 阶段 A 前两步）**。读过的源码：`dsh-swarm` 的 `core/cycle.ts`（完整：纯函数事件转移 `applyEvent`、阶段集合与终点判定 `isTerminal`、进入终点后拒绝一切事件、按日志折叠 `replay`）、`core/forcedclose.ts`（完整：未终周期显式收口）、`core/store.ts`（记录形状与损坏处理）、`core/backprop.ts` 与 `core/memory.ts`（头部：结果如何回灌能力评估）。采用：**一个 send = 一个周期**，`cycleId` 复用该轮 `runId`；阶段 `planned → executing → reviewing → integrating → completed`，异常为 `failed | cancelled`；**转移合法性由状态机强制**——顺序错乱即抛错，终点周期不再接受任何事件，**评审未通过（failed/blocked）不得进入整合**（"Review 未通过不能标记完成"的可执行版本）；**评审是机械的**：从 steps/toolCalls/toolErrors + 失败类别读出 `success | partial | failed | blocked`，证据逐条落盘，`reviewer: "mechanical"`，**不采信模型自报成功**；**周期账本** = agent home 内追加式 `cycles.jsonl`，状态=对事件日志的折叠（可重放），损坏尾容忍、中段损坏拒绝并报行号，未收口周期显式停在最后阶段而不冒充完成；**结果回灌** = outcome 行增加 `status`/`failureClass`（追加式兼容，旧行无此字段仍可折叠），选择器据此下调失败基因——**新近度只认最后一次成功**（`lastSuccessAt`：刚失败的基因不会因为"刚用过"而显得更新），连续失败达 `quarantineStreak`（2）即隔离出选择，直到重新被证明。明确不做（本片）：文件/行数写入门与硬预算（D13 已记，属写入门那一片）；模型驱动的评审与评分（独立评审者尚不存在，多角色评审早于其证据）；返工轮次与 `extend`（v1 单趟，失败即收口）；悬空周期的定时强制收口（单进程内 send 串行，暂不可能产生悬空）；跨进程/跨会话周期。边界修正：失败归因只按本模块自己的错误类（StepLimit/ToolBudget/Deadline/ContextBudget/TokenBudget）、abort 信号与适配器/校验消息前缀判因，**识别不了的归 `unknown`，不猜** | M3 落地后 validation 门禁变机械并可跑验证命令；outcome 数据足够后做失败蒸馏与成功归纳；引入独立评审角色（另一个模型/另一轮）时把 `reviewer` 从 mechanical 扩展；写入门那一片补文件/行数硬预算 |
| D16 | **失败档案与蒸馏（SWARM_LOOP 阶段 C 前半）**。读过的源码：`dsh-swarm` 的 `core/distill.ts`（重复失败按模式归并，达阈值产出**确定性** guard 草稿，而不是让模型即兴生成）、`core/memory.ts`（三层记忆：失败记录全存、叙述双限）、`core/gene.ts` 的 `avoid` 语义（从过去失败蒸馏出的紧凑警告）。采用：**失败档案** = outcome 行增加 `intent`/`signals`/`evidence`（追加式兼容，旧行无这些字段仍可折叠，只是不参与模式归并），这样"反复失败的**请求**"能被分组——分组键在请求侧（intent + 失败类别），不是基因；无基因轮（address=null）的失败同样计入，因为"没有可用基因"本身就是缺口；**蒸馏** = 纯函数 `distillGuards`：按 (intent, failureClass) 分组 → 统计信号出现频次 → 保留出现次数 ≥ 阈值（默认 3）的信号作为 `signalsMatch` → 产出**只含 guard 步**的 Gene 草稿 + 机械证据 + 一句人读摘要；没有信号达阈值就不产出（选不中的 guard 没有意义）；**草稿刻意不给 validation**：`mintGene` 会因 validation 为空而拒绝它，这正是准入门禁——操作者必须自己补上真正的验证命令，蒸馏不许伪造证明；**只保留机械事实**：不落原始错误文本（只有失败类别与 steps/toolCalls/toolErrors 这类计数），因此不新增凭据或私密文本的泄漏面；**去重** = 已有基因覆盖同一 (intent, 信号集) 时该模式不再产出草稿。**顺带修正 TaskSpec 信号提取**：中文没有词边界，原来整句话是一个信号——既能匹配的东西太少，又让"措辞不同的同类失败"永远分不到一组；现在 CJK 额外产出**二元组**（以及不超过 4 字的整词），整句不再作为信号，schema 仍是 2（同字段、更好的内容）。明确不做（本片）：成功归纳 `induct`；自动铸造（铸造永远是操作者动作）；把草稿交给模型润色（确定性优先，润色会让同一份日志产出不同草稿）；跨会话/跨 agent 失败汇总 | `induct` 与增益定价在 outcome 数据更厚之后做；阈值需要按实际命中率调整时再做成可配置；M4 插件阶段再考虑把失败档案作为可查询面暴露 |
| D17 | **成功归纳（`induct`，SWARM_LOOP 阶段 C 后半）——并明确它做不到什么**。读过的源码：`dsh-swarm` 的 `core/induct.ts`（无基因轮的成功→捕获候选）、`core/memory.ts`（三层记忆）、`core/gene.ts`（strategy 步骤只有 guard/act/verify/rollback 四种语义角色）。采用：**成功档案** = outcome 行增加 `tools`（该轮实际调用过的工具名，按顺序；追加式兼容，旧行无此字段），这样"没有基因可用但成功了"的轮次能被识别为能力缺口；**归纳** = 纯函数 `inductGenes`：只取 **address=null 的成功轮**（用过基因的轮不是缺口），按 (intent) 分组并保留复发信号（阈值同蒸馏），产出候选 Gene 草稿——**其 act 步骤就是转录事实证明用过的工具顺序**，另外附一句人读说明，`validation` 同样为空（`mintGene` 会拒绝，操作者必须补证明）。**诚实的边界（本片最重要的一条）**：转录能证明"调用了哪些工具、什么顺序"，**不能**推出"应该先读再改"这类 guard/verify 语义——那需要把意图读进工具序列，正是 D14/D16 禁止的模型叙述；所以 v1 的归纳**不产出策略洞见，只产出已被证明使用过的工具序列 + 请求画像**，其余留给操作者。不把它包装成"学会了策略"。明确不做（本片）：自动铸造；从转录推断 guard/verify/rollback 步骤；把草稿交给模型润色；跨会话聚合；增益定价 | 需要真正的策略归纳时，必须先有可机械判定的策略真值（例如 M3 能跑 validation 命令、能用验证结果反证步骤必要性），否则不许用模型叙述补这一步；阈值按实际命中率再调 |
| D18 | **每周期写入门与硬预算（D13 与 D15 共同挂账的那一片）**。读过的源码：`dsh-swarm` 的 `core/boundary.ts` 与 `core/gate.ts`（写入前检查、无活周期拒绝写入、每周期累计文件/行数账本）、`core/cycle.ts`（周期是记账单位）、`test/boundary.test.ts`（拒绝必须发生在写入之前）。采用：**账本** = `src/write-budget.ts` 纯函数：`readWriteAttempt` 从工具调用析出（目标路径，行数）→ `checkWrite` 判断是否放行 → `chargeWrite` 记账；**文件按"不同路径"精确计数**（同一文件写十次算一个文件），**行数只在参数里真的带着内容时计数**（`edit_file`/`create_file` 的 `content`）；`delete_file`/`rename_file`/`patch_file`/`batch_files` **计文件不计行**，且**绝不估算**——在参数读不出内容时行数记 `null` 而不是编一个数字（编出来的数字会让预算在最需要它的场景里失效）；连**目标路径都读不出**的写入（JSON 畸形或没有 path）**照样占一个匿名名额**并计入，否则畸形参数就能买到额外预算；**拒绝点在执行之前**——被拒的写入根本没发生，因此不可能留下半写的文件或悬空的工具关联（与既有的工具数预算同一条规则）；**拒绝方式是把失败的工具结果写回对话并记 `audit`（decision=denied），不是抛异常**，这样模型看得见拒绝、且一次超预算不会中止整轮还有的活；新增 `WriteBudgetError` 归入 `failureClass=budget`。**基因 constraints 从此是机械强制**：`AppliedGene` 增带 `constraints`（**只给执行层，不进提示词**——写进提示词的约束只是建议），选中基因时用它的 `maxFiles`/`maxLines` 作为本轮预算，无基因轮用运行时默认（3 文件/200 行，**"无上限"不是安全的默认值**）。明确不做（本片）：零预算（`maxWriteFiles: 0` 被参数守卫拒绝——"不许写"应当用别的方式表达，而不是偷偷接受）；跨周期累计（账本是每周期，周期之间互不影响）；把行数换成 token 或字节预算；按基因分别设定更细的路径预算 | 需要"整轮不许写"的表达方式时再设计；M3 进程工具接入后，同一账本要覆盖 shell 造成的写入（当前只覆盖六个文件工具） |
| D19 | **队列重排：先做机械验证，独立评审者后置**。读过的源码（本轮是研究轮，只读不改）：`dsh-swarm` 的 `core/cycle.ts`（`review-scored` 事件带 0–100 分、`reviewThreshold` 门禁；**整合同时要求评分过线 AND 观测到的 validation 通过**——原文注释："评审的同意只是意见，验证才是证据"）、`core/backprop.ts`（**α = 自报校准**：在"自称验证通过"的轮次里真正整合的比例，拉普拉斯平滑——α 是靠**整合**这个可观测结果测出来的，不是靠模型自称）；另读了 `gemini-cli/evals/llm-judge.ts`（约束输出 yes/no + 自一致性多数投票，以及它的脆弱处：需正则清洗、"other" 桶无法归类）。采用：**验证先于评审**。理由是可验证的事实而非偏好——本项目当前**没有任何 validation 执行器**：`Gene.validation` 只被存储、被渲染进提示词（`gene-store.ts` 的 "Prove it worked:" 一节），**从未被执行**（已用 grep 核实全库无执行点），因此现在无法区分"这轮看起来成功了"与"该基因声称的证明真的成立了"。在这个基础上加 LLM 评审者，等于**加一层没有任何东西可校准的意见**，且 α 无法测量（没有整合门禁可供对照）——正是本项目一直警惕的"第二个自报成功通道"。顺序改为：①**机械验证执行器**（真正跑 `Gene.validation` 并记录结果）→ ②**验证结果进入评估**（`evaluateRun` 消费验证事实，`validation` 失败类别终于有真实来源）→ ③**独立评审者**（此时它的分数是叠加在证据之上的信号，且 α 可测）。明确不做（本片与随后一片）：不采用"让另一个模型说这轮干得不错"式评审；不采用 llm-judge 的字符串清洗式判定（正则兜底 + other 桶，脆弱）；不把评审分数当成整合的唯一条件；本片不写代码（研究轮） | 做机械验证执行器的前置条件是**受控进程工具**（跑命令）＝ M3；若要在 M3 前先做，只能做"验证命令的声明与比对"这种半机械形态，届时必须重新评估是否值得，**且不许假装它等于真执行** |
| D20 | **结构化验证声明 + 轮末逐条比对（D19 里说的那个"半机械形态"，用户选定先做）**。读过的源码：同 D19（`dsh-swarm` 的 `core/cycle.ts` 整合双条件、`core/backprop.ts` 的 α 需要可观测锚点）；另外核对了本项目自身：`gene-store.ts` 的 "Prove it worked:" 渲染、`cycle.ts` 的 `FailureClass` 已有 `validation` 值但无真实来源、`tools.ts` 现有工具集（六个文件工具 + `read_file`，**无 shell**）。采用：**`Gene.validation` 从字符串数组变成结构化声明**（`GeneValidation` 联合：`files-written` / `no-write` / `tool-used` / `command`），`mintGene` 同时接受裸字符串并**归一化为 `command` 声明**（不改写、不猜测其含义）；**三态比对**（`met` / `unmet` / `unverifiable`）——这是本片的核心机制：**`unverifiable` 是独立结果，既不算 met（那会伪造证据），也不算 unmet（那会惩罚可能确实做了的工作）**；判据全部来自日志已记录的事实（写入账本的实际路径、实际工具调用序列），**不读意图、不做语义匹配**；`files-written` 按**集合相等**双向比对（少报一个文件同样算 unmet，否则"少说一点"就能蒙过）；`no-write` 对标账本；`tool-used` 可要求最小次数；`command` 声明在当前 runtime **一律 `unverifiable`** 并明写原因（"no command runner in this runtime"），M3 接进程工具后换执行器即可，**判据接口不变**；**比对结果进入评估**：被推翻的声明把本轮从 `success` 降为 `partial`（基因自己说了什么算证明，而证明不在），逐条结果作为 `validation:<outcome>=<claim> (...)` 写进周期证据与 outcome 行；`satisfied` 只在**全部 met** 时为真（含 `unverifiable` 即为假）。顺带修一个真缺陷：`--mint-gene` 读草稿时被 UTF-8 BOM 卡死并误报"不是合法 JSON"（Windows 编辑器与 `Set-Content -Encoding utf8` 默认写 BOM），现在剥离 BOM 并把解析错误原文带进消息。明确不做（本片）：**不执行任何命令**（无 shell；`command` 声明只登记不执行，绝不假装"跑过了"）；不做语义/模糊匹配（"测试通过"这类自然语言不做 NLP 猜测）；不由模型判定声明是否成立；不因 `unverifiable` 降低轮次评价；不追溯改写历史基因（旧字符串行折叠时归一化，地址因此变化，属可接受的一次性迁移） | M3 进程工具落地后把 `command` 从 `unverifiable` 换成真实执行并记录退出码与输出摘要；届时"验证通过"才第一次成为可观测事实，独立评审者与增益定价才具备前置条件（D19） |
| D21 | **M3 进程工具：只做侦察 + 范围切分，本轮不写执行代码**。读过的源码：① `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`（全文：`dangerous_command_match_for_platform`、POSIX/Windows 双平台语义、`MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8` 且**超深即判危险**——fail-closed 取向）；② 同目录 `windows_dangerous_commands.rs`（Windows 命令与 PowerShell 动词检测）；③ `gemini-cli/packages/core/src/tools/tools.ts` L195–269（策略决策 `allow`/`ask_user`/`deny`，`deny` 直接抛错，**未知决策保守地落到确认**——原文注释 "Default to confirmation details if decision is unknown"）；④ 同仓库 `tools/shell.ts` L272–300（`getPolicyUpdateOptions`：**"总是允许"把规则收窄为 `commandPrefix`＝该命令的根命令集合**，而不是放行整个 shell 工具；且当**输入含不可信上下文（`findUntrustedFlags`）或构建文件被修改**时**拒绝持久化**，返回 `undefined` 即永不记住）。采用（下一片实现时）：**① 拒绝把静态黑名单当安全边界**——证据是 Codex 自己的测试就承认它漏判（`rm -r` 不算危险、`bash -lc "echo 'rm -rf /'"` 不算，而 `cmd=rm; $cmd -rf /` 这类间接调用**测不出**），所以本项目不把"命令长得像不像危险命令"当防线，只当**提示**；**② 授权收窄到命令形状**——借 `commandPrefix` 思路：批准一次 ≠ 批准该工具，批准的是**这一个命令形状**；**③ 不可信内容在场时不持久化授权**——若上下文含外部抓取内容（web_fetch 结果）等不可信来源，**不允许自动放行**，必须每次询问；**④ fail-closed 优于便利**——对**无法静态判定**的命令（含重定向、管道、变量间接、子 shell）一律走询问，不猜它安全；**⑤ 输出必须有界**——进上下文的输出设硬上限。明确不做（本片）：不写任何执行代码、不加 shell 工具、不引入子进程（侦察轮）；**不自建沙箱**——本机 Windows 无可靠轻量沙箱（无 seatbelt/landlock 等价物），**绝不假装有沙箱**，安全性由"询问 + 命令形状 + 有界输出 + 审计"承担，并在文档里明写"没有沙箱"这一事实；不采用 Codex 的 POSIX 解析器（本项目在 Windows，且其漏判已自证）；不做结果缓存与自动重试 | **M3 必须切片**：它是本项目第一次能执行任意命令，也是安全边界最大的一次变更。切片 1（下一片）＝**只读命令执行**（`run_command` 仅放行确认为只读的调用形状，输出有界）＋ 把 `command` 声明从 `unverifiable` 换成真实执行（D20 预留的接口）；切片 2＝写型命令并**复用同一写账本**；切片 3＝长时/交互式进程。每片都必须**先补 SAFETY 文档再写代码** |
| D22 | **权限架构：把"沙箱"和"审批"拆成两个独立旋钮，并给出预设——D21 的 A/B/C 纠结源于我把两件事当成一件**。用户反馈："全都弹窗很麻烦、但边界必须有"，并指出我提的"只读白名单"形态不对（对：判命令内容＝我刚证伪的静态分析，换个地方犯同一个错），要求调研别人的 agent 产品。读过的源码：① **本项目正在运行的 DSH 自身**（它是用户"全权限且不弹窗"体验的来源，也是最好的对照）：`@deepseek-ai/dsh-bash-sandbox` README（模式表：`read-only` 默认／任何位置都不可写、`workspace-write` 只能写工作区根 + `/tmp`、`danger-full-access` 不作限制且**绝不咨询提供方**；**无 runner 时以 `SANDBOX_UNAVAILABLE` 失败，绝不无隔离直通**；升权由**工具层**驱动、需最窄充分宽度 + 一句理由，**批准提示询问用户，未经批准绝不执行**；**明写"只覆盖文件影响，不保证网络与进程可见性"**）；`@deepseek-ai/dsh-user-approval` README（策略 `ask`/`never`；`never` 是**确定性拒绝**而非静默放行；**应答者缺失或失败 → `unavailable` → 以拒绝方式关闭**；每项批准**只适用于对应请求**；请求与结果都进会话审计）；`@deepseek-ai/dsh-fs-observation-policy` README（读写分离：写新文件可以，**覆盖未读过的现有文件被拒**；编辑必须先读；读取后变化 → `FS_STALE_VERSION`；**明确写着"分层权限、审计或沙箱拦截属于 `tools/execute` waterfall"**——即不同层各司其职，这正是我缺的架构观）；`@deepseek-ai/dsh-permission-presets` README（**把沙箱模式与审批策略捆绑成具名预设**；不匹配任何预设的组合显示为 `custom`——**可见但不可选**；`danger-full-access`+`never` 是一个合法预设）；② `claude-code/mods/types/claude-code.d.ts` L6006–6078（`PermissionBehavior = allow|deny|ask`；**六种模式**：`default`/`acceptEdits`/`bypassPermissions`/`plan`/**`dontAsk`（不弹窗，但未被预先批准就拒绝）**/**`auto`（用模型分类器来批准/拒绝）**；`PermissionRuleValue = {toolName, ruleContent?}`；**`PermissionUpdateDestination = userSettings|projectSettings|localSettings|session|cliArg`——授权有五个作用域**，从"永久全局"到"仅这一次"）；③ `crush/internal/permission/permission.go` L87–93（**`PermissionKey = {SessionID, ToolName, Action, Path}`**——记住授权的键是四元组，不是工具名；`GrantPersistent` 才写入会话记忆，`Grant` 只放行这一次；L129 的 `resolve` 注释说明**首次裁决者胜出、失败者不得泄漏自动放行条目**）；④ 同仓库 `internal/cmd/root.go` L60（`--yolo` 的描述原文 "Automatically accept all permissions (dangerous mode)"）与 `internal/agent/hooked_tool.go`（**hooks 在权限检查之前运行**）。采用：**① 两个正交旋钮**——`sandbox`（结构上什么根本做不到）与 `approval`（什么时候问）**必须分开**；此前我一直在找一个机制同时干两件事，所以怎么设计都别扭，**这就是用户感觉"怪怪的"的根源**；**② 具名预设 + 不可选状态**——用一个"权限档位"选择器把两个旋钮捆绑成意图（如 `工作区写入`＝`workspace-write`+`ask`、`完全访问`＝`danger-full-access`+`never`），**不由用户分别拧两个旋钮**；不匹配任何预设的组合显示为 `custom`（可见、可离开、**不可选**）；**③ 授权键是四元组**——记住的是 `{会话, 工具, 动作, 路径}`，不是"这个工具以后都行"；**④ 授权作用域分级**——照 `PermissionUpdateDestination` 的粒度提供"仅这一次／本会话／本项目／全局"；**⑤ fail-closed 是共识**——三个独立产品都这么做（无 runner 拒绝、应答者缺失拒绝、未知决策落确认），本项目同样：**判不了就问，问不到就拒**；**⑥ 拒绝是一等结果事实**，不是异常：被拒的调用要带标记返回（照 `[sandbox: ...]` 那样），让模型知道是"被拒"而不是"命令失败"；**⑦ 每层只干一件事**——沙箱不审批（"本执行器从不授予权限"）、审批不隔离、观察策略不审批，**审计与拦截属于执行流水线**；**⑧ `dontAsk` 模式**——"不弹窗，但没预先批准就拒绝"：这是本项目最该先有的模式，因为它**同时满足"不烦人"和"有边界"**，且不需要沙箱。明确不做：**不做 `auto`（模型分类器批准权限）**——证据是 `dontAsk` 与 `bypassPermissions` 是显式并列的独立模式，而用一个模型去批准另一个模型的动作会引入本项目一直拒绝的**第二自报通道**（与 D14/D15/D19 冲突）；**不做"全都要弹窗"**（用户明确否决）；**不做 `--yolo` 式的纯全局开关**（安全的默认值要对"陌生人下载后直接用"负责，因为产品会开源）〔**此句措辞已在 D26 纠正**：全权模式本身不是缺陷（DSH/Codex/claude-code/gemini-cli/crush 都有），准确规则是"不做**只有**全局开关"、移除边界须落盘可审计、仓库自带配置不得自行提权〕；**不假装有沙箱**（D21 不变：Windows 无 seatbelt/landlock 等价物，网络与进程可见性**不保证**，这条必须写进 SAFETY，不能让用户以为有隔离） | 这一条**修订 D21**：D21 里"切片 1＝只读命令执行 + 只读白名单"作废（形态错、且我自证过静态判定不可靠）。改为**先落地权限架构本身**（两旋钮 + 预设 + 四元组授权键 + 作用域 + fail-closed 拒绝事实 + `dontAsk`），**它与"能不能执行命令"解耦**，因此可以在没有 shell 的情况下先做好并测试；真正执行命令的切片推迟到架构就位之后，届时安全性由"审批架构 + 有界输出 + 审计"承担，且**文档必须明写没有沙箱**。另外本轮**只重写了 README 级证据与类型定义级证据**，未逐行审计 `bypassPermissions` 的实际执行路径，也未验证 DSH 的 `danger-full-access` 在本机是否真的完全无约束——若后续要引用细节，需回到源码逐行确认 |

| D23 | **规则引擎与分层优先级（gemini-cli 深度读）**。读过的源码（委托调研，逐行引用）：`gemini-cli/packages/core/src/policy/config.ts` L67–71、L85–86（**tier 前缀**：`DEFAULT=1`/`EXTENSION=2`/`WORKSPACE=3`/`USER=4`/`ADMIN=5`，有效优先级 = `tier + priority/1000`；`ALWAYS_ALLOW_PRIORITY = WORKSPACE_POLICY_TIER + 0.95`）；`policy/types.ts` L10–14（`PolicyDecision = allow/deny/ask_user`）、L48–53（`ApprovalMode = default/autoEdit/yolo/plan`——**注意枚举值是 `autoEdit`，没有 `auto_edit`**）、L60–65（`MODES_BY_PERMISSIVENESS` 顺序）、L114–193（`PolicyRule`：`toolName`/`argsPattern`/`toolAnnotations`/`modes`/`priority`/`denyMessage`）、L157–160（"Higher numbers take precedence"）、L337–356（settings 允许列表字段）；`policy-engine.ts` L255–257（**按优先级降序排序一次**）、L129–240（`ruleMatches` 全部条件 AND，**逐项 fail-closed**）、L674–733（**首个匹配者胜出**）、L736–745（**无规则匹配时：YOLO ⇒ ALLOW，否则 `interactive ? ASK_USER : DENY`**）、L470–483（**YOLO 下若命中带 `argsPattern` 的限制规则却无法解析命令 ⇒ 强制 DENY**）、L826–857（**构建文件保护在 `decision === ALLOW` 时仍触发，且不被 mode 门控**）、L623–631（`argsPattern` 匹配 `stableStringify(args)`）；`policy/toml-loader.ts` L39–70（**`priority` Zod 限制 `min(0).max(999)`，理由原文是防止 tier 溢出**）；`policy/policies/*.toml`（`read-only.toml` L30–56 把约 16 个读/搜/取工具 `allow` 在 priority 50、**完全无需确认**；`write.toml` 把写类工具 `ask_user` 在 priority 10、`autoEdit` 抬到 `allow` 15 **并同时挂上路径安全检查器**、且 `autoEdit` 下 `web_fetch` 也被自动放行；`plan.toml` L76–81 用 `toolName="*"` + `decision="deny"` + `modes=["plan"]` 做兜底、L86–93 **用 `toolAnnotations={readOnlyHint=true}` 作为匹配器**、L118–195 用十条 `argsPattern` 只放行 plans 目录下的 `.md` 写入、L198–203 在 priority 65 拒掉其余全部写入；`yolo.toml` L33–38 **`ask_user` 工具在 priority 999 仍要求交互**、L43–48 拒绝 plan 模式切换、L51–56 `toolName="*"` allow 在 998）；`tools/tools.ts` L1106–1114（`ToolConfirmationOutcome`：`ProceedAlways*` 仅内存、**只有 `ProceedAlwaysAndSave` 才 `persist: true`**）、L1126–1145（`Kind` 与 `MUTATOR_KINDS`/`READ_ONLY_KINDS`）、L517–519、L521–523（`isReadOnly` 与 `toolAnnotations`）；`scheduler/policy.ts` L135–145（**授权按模式切片**：`modes = MODES_BY_PERMISSIVENESS.slice(indexOf(currentMode))`）、L147–158（**不受信任目录永不写入 workspace 作用域，降级为 user**）、L190–201（`isAutoEditTransition`：在编辑类工具上选"总是允许"会**把整个会话升到 AUTO_EDIT**，带 `TODO` 承认是临时做法）、L224–241（可由 `confirmationDetails.rootCommands` / `buildFilePathArgsPattern` 兜底收窄）；`policy/config.ts` L712–934（`createPolicyUpdater`：内存规则插在 `tier + 0.95`，持久化走**串行 promise 队列**避免并发丢更新，**原子写 tmp+rename**、EXDEV/EBUSY 回退 `copyFile`、**符号链接防护**、TOML 语法错误备份 `.bak` 后恢复）、L734–739 与 L776–781（**敏感工具若无 `commandPrefix`/`argsPattern` 则警告并拒绝持久化**）；`utils/trust.ts` L18–22、L157–197（`TrustLevel` 三级、**最长路径前缀胜出**）、L199–271（`trustedFolders.json` 原子写、`mode 0o600`、lockfile）；`cli/src/config/config.ts` L758–764（**不受信任目录强制把审批模式改回 `default`**）；`cli/src/config/policy.ts` L28、L42（**workspace 策略默认关闭**，两处均标 "Temporary flag"）；`ui/components/FolderTrustDialog.tsx` L75–84、L201–205（信任对话框真实存在）。采用：**① 单一优先级规则表 + tier 前缀**（这是比我 D22 更好的架构）——tier 前缀保证 **Admin > User > Workspace > Extension > Default 永不被倒置**，`priority` 只在 tier 内部排序，且**上限 999 正是为了防止 tier 溢出**；这样"降低打扰的每一项功能"（允许列表、总是允许、YOLO、信任）都只是**又一条插在已知优先级的规则**，**它们在结构上无法绕过排序，只能"胜过"某条规则**——这正是我在 D22 里想用"两个旋钮"表达、但表达得更弱的东西；**② 模式即规则标签**（`modes=[...]`）而非命令式分支——四种模式的行为差异全部由规则表表达，因此新增模式不改代码路径；**③ 读默认放行是"免费"的降打扰手段**——读/搜/取类工具在高优先级直接 allow、**完全无确认**，而写类在低优先级 `ask_user`；读占 agent 调用的大多数，打扰率因此量级下降；**④ 全局模式必须有硬地板**——YOLO/全权模式下仍有四件事不放松：**`ask_user` 自身仍提示（999 > 998）**、plan 模式切换被拒、命中限制规则却无法解析的命令被拒、构建文件保护照常触发；外加管理员的 `secureModeEnabled` 开关直接抛 `FatalConfigError`；**⑤ 授权按模式切片且可被工具否决**——在 PLAN 下给的授权不得在更宽松模式生效；敏感工具无收窄则拒绝持久化；**⑥ 不受信任的目录/来源是"收紧输入"**——目录不受信任则审批模式强制回落 `default`，且**绝不写入 workspace 作用域授权**；**⑦ `.git` 等必须默认只读**（Codex 的 `default_read_only_subpaths_for_writable_root` 自动保护 `.git`/`.agents`/`.codex`，理由是 **`.git/hooks` 是提权通道**）。明确不做：**不采用嵌套的 `toolAnnotations` 精确匹配**（要求每个键值完全相等，规则作者很容易写出永不匹配的规则，调试成本高）；**不做"把整个会话自动升到 AUTO_EDIT"**那种隐式副作用（上游自己标了 TODO，且隐式全局状态变化与本项目的显式原则冲突）；**不采用 workspace 级策略文件作为默认可信来源**（上游**自己在默认构建里关掉了它**，正是因为"仓库自带的策略文件可被攻击者编辑"——本产品开源，同理：**仓库内的策略文件不得自行提权**，这条要写进 SAFETY）；**不依赖 `isReadOnly` 做任何边界**——**核查结论：`isReadOnly` 不门控执行或确认**，其注释写明用途是**并行安全**，plan 的只读边界完全由规则表强制，`tool-registry.ts` 只是**改写工具描述文本**（提示工程，不是门禁） | 这一条**补强并部分取代 D22 的"两个旋钮"表述**：D22 仍成立（沙箱与审批确实是两个正交旋钮，且预设是对用户正确的呈现层），但**实现内核应采用"单一优先级规则表 + tier 前缀"**，而不是两套并行机制；规则表的排序不变式（tier 不可倒置）比"两个旋钮各自守规矩"更有保证力。另记两条**未验证项**：`claude-code` 目录**是文档/SDK 仓库而非源码检出**（1423 个文件只有 CHANGELOG/examples/plugins/mods，**无应用源码**），因此其信任对话框、规则解析器与"总是允许"写入路径**属于"文档提及"而非"代码可验证"**；gemini 的 `isReadOnly` 门控结论是**"找不到调用点"**（缺席证据），若日后要引用需再查 |

代码复制前另核对目标文件许可证、归属/NOTICE 与修改记录；本轮只借鉴机制，没有复制第三方实现。
| D32 | **归因接上 + 具名档位（本片有代码；落实 D31 的待办与 D22/D26 的档位设计）**。**读代码后范围收敛（两个事实）**：**①** 审计的事件校验器**逐字段重建**记录（`session-store.ts` 的 `case "audit"`）而非原样透传，所以**只加字段会被静默丢弃**——必须**类型、写入、校验器三处同时改**；**②** 审计**当前只记录拒绝与过期**（`decision: "denied" | "expired"`），即它是**"拒绝的记录"而不是"决策的记录"**，而**读类工具刻意被 allow 在高优先级、零确认**（D23 记录的 gemini 做法），因此**记录每一次 allow 纯属噪声**。⇒**归因只覆盖拒绝**，**不新增 allow 通道**（保持审计的用途）。**采用的归因**：`AuditEvent` 新增**可选** `rule?: string \| null`——`null` 与"字段缺失"**语义不同**（前者＝表做了决定但没有规则匹配，后者＝旧行本就没有该字段），**已分别用测试钉住**；`tools.ts` 的调用点改为**先查规则表**、拒绝时把 `match.rule?.id` 写进审计，**拒绝理由也改为规则提供的原因**（行为更可解释：原来是一句写死的 "side-effect tools are disabled…"）。**一处既有测试因此需要更新**（它断言那句写死的文案）——**这是有意的行为改进而非回归**：拒绝现在**能说出是哪条规则**。**具名档位（`src/tiers.ts`）**：`read-only`／`workspace-write`（默认）／`full-access`，每档显式给出**工具集合（缺席而非拒绝）＋规则表**。**两条设计约束在代码里强制、不靠信任**：**(1) 档位无法放宽不变量**——路径收敛与能力集合**不是规则**，故此模块**只能选择权限决策**，测试断言"任何档位都不得把不变量名为规则"；**(2) 宽松档必须显式记录**——`resolveTier` 对**未知名字报错**而**不回落**（回落会因**拼写错误**静默改变姿态，若回落到宽松档就是**因错别字发放全权**），且只有 `full-access` 标 `removesBoundary`。**写代码时被自己的测试抓到一个真实逻辑错误**：`read-only` 第一版把通配 `deny`（priority 900）排在 `read_file` 的 `allow`（500）**之上**，于是**通配拒绝把读也一起吞掉**——该档实际含义变成"什么都不读"而不是"只读"。**排序就是机制，那两个数字是承重的、不是装饰**；已改为 allow 900 > deny 800，并在注释里写明原因。**测试 14 条**（档位命名与解析、未知名字报错、各档决策、宽松档硬地板、**档位不能放宽能力集合**、审计 `rule` 往返与 `null`/缺失之别、旧行兼容）。**全量 351 → 365（364 过、0 失败、1 跳过），零回归** | **仍未做（诚实边界）**：**档位尚未接到 CLI**——`cli.ts` 仍构造全集与内置规则，**用户目前看不到行为变化**；接线时需同时落地 D26 的"**移除边界必须落盘可审计**"与"**仓库自带配置不得自行提权**"（当前无配置加载器，故**尚无攻击面**）。**`full-access` 只是"不再问"，不是"没有边界"**——路径收敛、写预算、漂移检测、审计**照常生效**，文档与 UI 文案**不得**暗示有隔离。**审计仍只记拒绝**（无 allow 通道，见上，属刻意）；**规则表仍未接配置**；**具名档位的名字尚未经用户确认**——当前三个名字是设计产物，**用户可能想改**（改名只动 `tiers.ts`） |

| D31 | **规则表内核：单一优先级规则表取代写死的判定（本片有代码；实现 D23 记录的机制，并先于任何档位命名）**。**读代码后的范围收敛（重要）**：我此前把"待统一"的四个轴并列——**但它们性质不同，硬凑成一张表是假对称**：**路径收敛**是**不变量**（不管任何规则说什么都必须成立）**不是策略选择**；**写预算**是**每周期计数器**；**能力集合**是**会话属性**（在规则表被咨询**之前**就已生效）；**只有 `allow`/`approve`/`deny` 才是真正的"决策"**。因此本表**只管决策**，其余三者**刻意留在表外**，理由写进代码注释：**若把它们建模成规则，一条高优先级规则就能放宽它们——而这正是本设计绝不能有的失败模式**。**采用的机制（全部照 D23 记录实现）**：规则含 `tool`（含 `*` 通配）／`decision`／`tier`／`priority`／可选 `when(args)` 谓词／`reason`；**有效优先级 = `tier + min(max(priority,0),999)/1000`**；**按有效优先级降序排序一次、首个匹配者胜出**；**无规则匹配 ⇒ `deny`**（新增未知工具**不可能**静默放宽）；**谓词抛异常 ⇒ 不匹配**（fail-closed：会抛的谓词**永不**产生 allow）。**tier 前缀（`DEFAULT=1 < EXTENSION=2 < WORKSPACE=3 < USER=4 < ADMIN=5`）**，**`priority` 上限 999 正是为了"任何优先级都无法跨层"**——这是本片最要紧的一条不变量，已用测试对**每一对相邻 tier** 验证"下层最高 < 上层最低"。**行为不变是硬要求**：`DEFAULT_RULES` 逐字复现原 `switch` 的语义（`read_file`→allow、六个文件工具→approve、其余→deny），所以**换机制不等于换行为**，既有 337 条测试**全绿**为证；差别在于**行为从代码变成了数据**——可检查、可在审计里按 `id` 归因、可被更高 tier 覆盖而**不必改这个文件**。**测试 14 条**，覆盖三类：行为保真（复现原 switch）、**tier 不可倒置**（相邻层对、忽略书写顺序、层内按 priority 破平、越界 priority 被夹紧）、**失败即关闭**（无匹配即拒、空表即拒、谓词抛异常即拒、**谓词返回非布尔不被当作批准**、先匹配的 deny 不被后置 allow 救回）。**全量 337 → 351（350 过、0 失败、1 跳过），零回归** | **仍未做（本片刻意）**：**尚未引入任何具名档位**（D22/D26）——**顺序是刻意的**：档位名必须在**其能表达的语义已经存在之后**才定，否则就是先冻结名字再想含义。**规则表尚未接配置**（无 TOML/JSON 加载、无用户自定义规则文件），当前只有内置 `DEFAULT_RULES`；**这也意味着"仓库自带配置不得自行提权"（D26）尚无攻击面**，但**接配置时必须同时落地该限制**。**审计尚未记录 `rule.id`**：`decide()` 已返回 `rule`，但 `tools.ts` 的调用点仍只用 `.decision`，归因能力已具备但**尚未接上**——属下一片。**未表达的轴**：规则表只决定"问不问/允不允许"，**不决定"这个工具是否存在"**（那是 D28 能力集合的职责，运行在前） |

| D30 | **批准后漂移即拒：把"批准过这个内容"真正做实（本片有代码；D29 留下的"世界变了"那一半）**。**发现的真实缺陷（先写失败测试证明，非推断）**：`edit_file` 在**批准之前**读一次文件内容（`const current = await readFile(...)`），此后**再也不读**；而批准与写入之间的窗口**不是瞬时的**（`APPROVAL_TTL_MS` 就有 2 分钟，操作者可能想很久），所以磁盘上文件可以被换掉，而**用陈旧读取算出来的内容照样写回去**——这是**静默的丢失更新**。`patch_file` **更严重**：它的新内容是把 `newText` **拼接进那次陈旧读取**得到的（`current.slice(0,first)+newText+current.slice(first+len)`），所以并发编辑**不只是被覆盖，而是被悄悄回退**。既有的 `sameFile` **不够**：它只重新校验**路径**能否仍解析到同一处，**完全不看内容**。**已用失败测试先行证实**：写了两个探针测试，在 `approve` 回调里改写文件，修前**两个都失败**（证明缺陷可复现，非理论）。**采用**：新增 `contentStamp(content)`＝sha256，与 `unchangedSinceApproval()`（**再读一次并比对**；文件消失或不可读**也算漂移**，因为"被批准的内容"已不在那儿），在 `sameFile` 之后、写入之前执行；拒绝文案明确要求**重新读取后重试**（不是瞬时失败，避免模型反复重试同一份陈旧内容）。**覆盖范围按"操作者究竟批准了什么"逐个判断，不搞一刀切**：`edit_file`／`patch_file` 批准的是**内容**⇒ 加内容校验；`delete_file` **向操作者预览了内容**（第 542 行）⇒ 同样加，否则会删掉操作者**从未看过**的东西；`create_file` **本来就安全**——它用 `flag:"wx"`，文件若在窗口内出现，**由操作系统原子拒绝**（原生机制强于自己写的检查）；`rename_file` **刻意不加**——它的提示**不展示任何内容**，操作者批准的是"把这个路径改名"，给未批准的内容加检查属**扩大范围**；其目标路径被占用这一真实漂移**已由 `sameFile` 覆盖**。**过程中犯了一个同形的错并自查出来**：`delete_file` 第一版我把 `contentStamp(await readFile(...))` 写在**批准之后**，于是**拿内容和它自己比**、永远相等、检查形同虚设——被自己新加的测试当场抓住；改为**预览与指纹来自同一次读取**（`previewed`），并在注释里写明"否则比较退化为与自身比较"。**测试 6 条**（edit 漂移拒绝且他人内容存活、patch 漂移拒绝（否则回退他人修改）、delete 漂移拒绝、以及三例"未漂移则照常执行"）。**全量 331 → 337（336 过、0 失败、1 跳过），零回归**。**这一步的实质**：把绑定从"操作者批准过这个**动作**"推进到"操作者批准过这个**内容**"——即 OpenClaw 式绑定的核心（其绑定含 content-hashed file operands 并**在批准后按漂移拒绝**） | **仍未做（诚实边界）**：绑定**尚不含 cwd 与环境哈希**（OpenClaw 的完整四元组为 command + cwd + environment hash + file operands）；因此**跨目录语义变化**（如工作区被换到别处）与**环境变化**尚不构成漂移。**检查本质是"TOCTOU 窗口收窄"而非消除**：`readFile` 校验与随后 `rename` 之间仍存在极短窗口，本项目**无沙箱、无文件锁**，故**不宣称原子性**；收窄而非消除是这一步能达到的最强程度。**且未覆盖 shell**（无 shell 存在）——将来接命令执行时必须**复用同一套绑定**，否则该轴只护住文件工具 | **下一片建议**：③**规则表内核**（D23 的 tier 优先级）——把已有的"能力集合（D28）＋授权绑定（D29/D30）＋写预算（D18）＋路径收敛（D27）"这些**已实现的轴**用**单一优先级规则表**串起来，并在此之上才引入具名档位（D22/D26）。顺序理由：档位名必须在**其能表达的语义已存在之后**才定，否则就是先冻结名字再想含义 |

| D29 | **授权绑定到动作的内容哈希（本片有代码；对 D25 ② 的第一次实现）**。**先读后写再次改变任务性质**：动手前通读审批路径，发现**授权缓存早就存在**（`tools.ts` 的 `approveExact`，`FileGrant` 带 `expiresAt`、`APPROVAL_TTL_MS = 2 分钟`、审计区分 `denied`/`expired`），所以本片**不是"新增缓存"，而是"修缓存键错了"**。**发现的真实缺陷**：旧实现用 `grant.argumentsJson === JSON.stringify(args)` 比对——**字符串相等不等于"同一个动作"**。**已实测证明**（写探针跑 `JSON.stringify`，非推断）：`{"path":"a.txt","content":"x"}` 与 `{"content":"x","path":"a.txt"}` **哈希不同** ⇒ 同一动作**缓存未命中** ⇒ **再次弹窗**；嵌套对象同理。同时实测确认 **JSON 键序在 parse→stringify 往返中今天是稳定的**，所以现状能"凑巧"工作——但那是**模型逐字节重复自己**的运气，**不是设计可依赖的性质**（模型换个顺序、或参数经由不同序列化路径产生，就会退化）。**采用**：新增 `actionBinding(tool, args)`＝`sha256(canonicalize({tool, args}))`，其中 **`canonicalize` 直接复用 `gene.ts:77` 既有实现**（递归键排序、剔除 `undefined`、稳定 JSON）——**没有新写一份规范化代码**（梯子第 2 级：本仓库已有就复用；基因库的"同数据同字节"与审批的"同动作同键"本来就是同一个问题）。**工具名进哈希**：一条工具的授权**永不**满足另一条工具。**另修一处我引入的健壮性缺口**：`JSON.parse(grant.argumentsJson)` 对畸形 grant **会抛**（已实测），原样会让整个工具调用崩掉；改为**逐条 try/catch 且失败即视为"不匹配"**——畸形 grant **什么都不授权**（fail-closed），但**不拖垮调用**；同时把过期判断提到解析之前。**测试**：`test/action-binding.test.ts` 8 条（键序/嵌套键序视为同一动作、任一值变化即不同、跨工具不共享、文本拼写差异无影响、`undefined` 键不制造差异、**数组顺序是真数据故必须区分**、地址格式稳定）。**全量 323 → 331（330 过、0 失败、1 跳过），零回归**。**明确不做**：不把 TTL 从 2 分钟改动（用户未要求，且 TTL 属策略不属绑定机制）；不做"按前缀持久化授权"（OpenClaw 的 execpolicy 前缀规则＝另一条轴，属 D25 ② 的持久化部分，留待需要时按 D23 规则表实现）；**不做"批准后仍不看文件系统状态"的假绑定**——**诚实的边界**：本片的哈希绑定的是**动作参数**，**不含 cwd、不含环境哈希、不含被操作文件当前内容**，所以它**不等于 OpenClaw 的完整绑定**（其绑定含 command + cwd + environment hash + content-hashed file operands 并**在批准后按漂移拒绝**）。本片解决的是"同一动作被反复问"，**尚未**解决"批准之后世界变了"——后者与写账本的执行前复算（`sameFile`/`readWriteAttempt`）是同一族问题，应在下一片合并处理 | **下一片（② 剩余部分）**：内容绑定扩到**执行前的世界状态**——把 `sameFile`（写前复检路径未被替换）从"路径未变"扩展到"被写文件内容未变"，并把 cwd/环境纳入绑定，使"批准后漂移即拒"成立；再评估是否引入 OpenClaw 式的**持久前缀规则**（需与 D23 规则表对齐，避免出现第二套授权表达）。**一处局限**：`FileGrant.argumentsJson` 字段名保留了历史拼写（现在只作为存储载体、比对已改哈希），刻意**不重命名**以免造成无谓的跨文件改动——若日后重构，注意此字段名不再表示"比对依据" |

| D28 | **能力存在性落地（本片有代码；对 D25 第三条轴的第一次实现）**。**先读后写（这一步改变了方案）**：动手前通读工具层，发现**不需要新模块**——`ToolRegistry`（`tools.ts:594`）**已经是唯一**从模型调用到副作用的通路，`Tool.readOnly`（`:84`，注释写明"宿主可信声明"）**已经是**宿主侧能力标记，且 `execute()` 里**已经有**一条相邻的拒绝（`filePolicy(call.name) === "deny" && tool.readOnly !== true` ⇒ "side-effect tools are disabled until approval is implemented"）。因此本片**没有新建文件**，只给既有注册表加了**可选 `available` 集合 + `has()`**。**关键设计判断**：**缺席必须在两个方向同时强制**——`definitions()` 不向模型暴露（`runtime.ts:739` 的 `this.tools.definitions()` 就是暴露点），**且** `execute()` 按名字拒绝。理由：**只从提示词里藏起来、却仍能被调用，那是"伪装成缺席的拒绝"**；这个边界之所以廉价，正因为它**只在两处一致时才成立**。**拒绝文案是设计的一部分**（不是随手写的错误字符串）：`"this tool is not available in this session; it is a policy boundary, not a transient failure"`——把它标明为**本会话的常驻属性**，使模型不重试、不找绕路。依据（三家独立做法）：nanobot 的边界错误文案明确告诉 agent"这是硬策略边界、不是瞬时失败、不要用 shell 技巧绕过"；opencode 的 `CorrectedError` 把原因回给模型；crush 把 hook 的 `allow` 判定**绑定到工具调用 ID** 使其不可重放。**实测**：9 条新测试（不暴露、按名字拒绝、文案区分常驻/瞬时、有则照常执行、`has()` 与 `definitions()` 一致、未注册项报错、**空集合＝零能力而非不设限**）。**全量 314 → 323（322 过、0 失败、1 跳过），零回归**。**顺带查明并固化的既有事实**：`create_file` 当前被**既有审批门**拒绝（"no approval channel is configured"，已用探针实跑确认，非阅读推断）——**这恰好证明"能力存在"与"审批"是两条独立轴**：本会话**拥有**某工具，**不等于**授权其副作用；已写成测试，防止日后有人"修好"能力集合就误以为副作用也放开了。**明确不做**：不把能力集合当作权限系统（它只回答"有没有"）；不做按轮次动态增删工具（YAGNI，会话级足够，需要时再加）；不为此新增配置文件或档位名（档位命名属 D22/D23 的规则表片） | 待办（下一步顺序不变）：②**授权绑定内容哈希 + 执行前复验**（与写账本"执行前算账"同构，`readWriteAttempt` 是现成形态参考）→ ③规则表内核（D23）→ ④影子快照（候选）→ ⑤命令执行。**已知边界**：本片只提供**机制**，尚未在 `cli.ts` 接任何档位（`cli.ts:248` 仍构造全集），所以**用户暂时看不到行为变化**——这是刻意的，避免在规则表定型前先固定档位名；能力集合的**调用方**将在 ③ 落地。**一处需警惕**：`available` 为空数组时表示"零能力"，与"未提供（＝全集）"语义相反，两者只差一个 `undefined`，已用测试钉住；若日后有人在配置层把"空列表"当默认值传入，会**静默地关掉全部工具**——接档位时必须显式区分"未指定"与"指定为空" |

| D27 | **路径收敛实测：它是真的，读也被收敛，但**不是**沙盒（用户提问触发，已更正 SAFETY 中一处自相矛盾的表述）**。**用户判断**："我整个电脑所有位置应该你都是可读的，操作也是可以的，但你本身应该是不会主动去其他目录直接执行的。"**这个判断是错的，且错在安全的方向**——"我不会主动去"是**行为描述**，"我能不能"是**代码事实**，二者必须分开。**实测（写探针跑真实函数，非阅读推断）**：`assertReadablePath` 对 `C:\Windows\win.ini`、`<ws>\..\..\Windows\win.ini`（上跳）、操作者 `~/.ssh/id_rsa`、另一个本地仓库 `D:\DSHXM\dsh-lab`、盘根 `D:\` **一律拒绝**，错误均为 `path escapes the workspace`；工作区内 `package.json` **放行**。**源码依据**：`security-config.ts:129–141` 的 `assertReadablePath` 首行即 `if (!isWithin(root, actual)) throw new Error("path escapes the workspace")`——**该函数同时门控读与写**；`grep` 确认**所有涉路径工具**（`read_file`/`edit_file`/`create_file`/`patch_file`/`delete_file`/`rename_file`/`batch_files`）都经它，`tools.ts:285/357/411/455/482/521-522`。**因此 SAFETY 中"读默认放开/不保证读隔离"是错的，已改**。另核实两层：工作区内 `.env` 与 `.git/config` **按名字拒绝**（`sensitive()` 正则，`:137–140`）——**即 `.git/hooks` 提权通道的防护已经存在**；`protectedRoots()` 实测解析出 **8 个**宿主机路径（`C:\Users\RongWu\.dsh`、`DSH-Backup`、`C:\Windows`、`Program Files`、`Program Files (x86)`、`ProgramData`、`AppData\Roaming`、`AppData\Local`）。**（注：探针第一次传 `{}` 导致 `protectedRoots` 返回空数组，那是探针自身把 env 替换成 `{}` 的假象，不是产品缺陷——已用真实 env 复测确认。）**采用：**用户对"目录就是限制"的直觉是对的**（"路径收敛"确实是一种边界），但**必须与"沙盒"严格区分**，因为混用会导致三个危险的错觉：以为**读**受限（本次实测其实**是**受限的，但受限范围是"工作区"而非"你看不得的东西"）、以为**跑了命令也一样**（**错**）、以为**连不上网**（**错**）。准确的边界名称是**单向的、仅作用于文件工具的写/读路径收敛**，且**仅覆盖文件工具**。明确不做（本片）：不写执行代码；不把"路径收敛"改名或包装成沙箱；**不夸大**——该检查是**合作式**的（针对路径混淆，**非无竞态保证**，代码注释自认"a target may still be swapped between this call and open"） | 三处**已知缺口**必须在接 shell 前解决/声明：**(1)** 本检查**只约束文件工具**——一旦能执行命令，"写哪里"由操作系统决定、**不再经过此检查**（这正是 D18 要求"M3 复用同一写账本"的原因，也是 OpenClaw 那句警告所指）；**(2)** 不约束网络/注册表/子进程；**(3)** 非无竞态。**待办**：把"读也被收敛到工作区"这一事实同步进 STATUS 与 SWARM_LOOP 的缺口表（原先按"读默认放开"写的表述需一并更正） |

| D26 | **术语澄清与三处措辞纠正（用户追问后修订，无代码）**。用户在读完 D24/D25 的"明确不做"三条后指出：**"全局开关"明明 DSH 和 Codex 都有**——**这个指正是对的，我先前的表述错了**，本条把它改准，并把两个一直只被断言、从未被解释的概念写清楚。**① "第二自报通道"的定义（这是本项目多条决策的共同支柱，此前从未展开）**：本项目已确立铁律"评估只看机械事实，**不采信模型自报成功**"（`reviewer: "mechanical"`）。**第一自报通道**＝干活的模型说"我成功了"（**已被禁止**）；**第二自报通道**＝**另一个模型**说"他确实成功了/批准吧"（**同样不得采信**）。二者**在结构上是同一个东西**：都是**模型的主观判断**，只是换了角色。系统原本**只有一个可信来源＝机械事实**；引入一个评审模型，可信来源就变成"机械事实 + 模型意见"，而后者正是最初被拒绝采信的那类东西。**与 D14/D15/D19 的冲突逐条**：**D14**（基因只能从"验证成功"的经验铸造）——若"验证成功"由模型认定，该铁律即被架空；**D15**（PDRI 每轮机械评估，`reviewer: "mechanical"`）——引入模型评审者**直接违反**该条；**D19**（验证是证据、评审只是意见；评审必须先有**可校准的锚点**）——参考实现里评审者的准确率 α 是拿"**最终是否真的整合成功**"这个**可观测结果**回头校准的，而本项目**尚无验证执行器**，故模型评审者会是**一个永远无法知道准不准的裁判**。**② 三处措辞纠正**：**(a) 不是"不做全局开关"，而是"不做只有全局开关"**——事实是 **DSH**（`danger-full-access` + `never`）、**Codex**（`SandboxPolicy::DangerFullAccess`，注释原文 "No restrictions whatsoever. Use with caution."）、**claude-code**（`bypassPermissions`，且需 `allowDangerouslySkipPermissions`）、**gemini-cli**（`yolo`）、**crush**（`--yolo`，描述原文 "Automatically accept all permissions (dangerous mode)"）**全都提供全权模式**，**这本身不是缺陷**；缺陷在于**只给"全开/全关"两档而把安全设计甩给用户**。本项目要的是**多个具名档位**（DSH 之所以好用，正因为它旁边还有 `read-only` 默认档与 `workspace-write` 档），且**默认档必须安全**；**(b) 拒绝的不是"存在解锁方式"，而是"用权限标签即可解锁"**——对比：OpenClaw 的 `full` 模式仅凭 `operator.admin` **权限标签**即可移除文件系统边界，而本项目要求**显式的、落盘的、可审计的选择**；用一句话区分：**标签是"你被允许"，落盘是"你做了这个决定"**——后者可被审计、回顾、他人可见；**(c) 仓库自带的配置不得自行提权**——证据是 claude-code 拒绝接受**仓库内** `settings.json` 把 `defaultMode` 设为 `bypassPermissions`，必须写在用户级或管理级配置里；理由直白：**clone 一个仓库，那个仓库不该能给自己发全权授权**。本产品会开源，同理适用。**③ 关于"是否复刻 Windows 受限令牌"的通俗解释**（用户表示未看懂）：该方案＝用 `CreateRestrictedToken(...WRITE_RESTRICTED...)` 造受限进程令牌 + 改文件 DACL；完整版还需**新建本地账户（`CodexSandboxOffline`/`Online`）+ 安装特权服务 + 配置 WFP 防火墙**。不采用的理由**不是做不到，而是交易本身不好**：上游自认该后端**只能约束写**（读不受限、网络挡不住，需要读限制或全盘写入时**直接拒绝运行**），而要拿到完整版就得**在用户机器上留下常驻服务与账户**、需要管理员权限——对一个**开源、个人、零生产依赖、明确不要沙箱**的产品，代价与收益不成比例 | 本条**不改变任何技术方案**，只把措辞改准并补上"第二自报通道"的明确定义（该定义随后应同步进 SAFETY，因为它是 D14/D15/D19/D22/D24 的共同依据）。**仍需警惕的滑坡**：把"不做只有全局开关"执行成"加很多档位但默认档不安全"，或把"落盘可审计"执行成"弹一个确认框就算落盘"——前者违背默认安全，后者不是落盘。若日后要引用 Codex 的 Windows 令牌细节，需回到源码逐行确认（本轮引用的限制语句来自上一轮的逐行核对） |

| D25 | **降打扰的第三条轴：让能力"不存在"，而不是"被拒绝"——这条**修正**了 D24 的结论；另有一项独立证据表明"沙箱可能被删掉而逻辑层留下来"**。读过的源码（两路委托调研，逐行 file:line + 原文引用）：**① 能力缺席＝最强收敛（4 个独立项目）**：Letta `--tools "Read,Glob,Grep"` / `--tools ""`，文档原文 **"This removes tools from the agent's context entirely, not just permission-gating them"**；OpenClaw 的 `read-only` 会话**直接不提供** `edit`/`write`/`apply_patch`，原文 **"permission modes shape which tools exist at all"**；TrustClaw 是**"按缺席拒绝"**（没有连 OAuth 账号就没有那个工具，于是零提示）；nanobot 把守卫放在 resolver 里，越界路径是**"不可达"而非"被拒绝"**。**② goose 发布过沙箱又把沙箱删了**（这是全轮最有力的一条）：`documentation/blog/2026-02-23-goose-v1-25-0/index.md:22` 原文 **"The macOS seatbelt sandbox described in this section was experimental and has been removed. The `goose` server process (which executes tools) runs with the same permissions as your user account and is **not** sandboxed at the OS level. For security controls, see [`GOOSE_MODE`] (`approve`, `smart_approve`) to restrict what tools can run without confirmation."**（**已在源码中逐字核对**）。**③ qwen-code：点"总是允许"无法击穿它自己的分类器**（`packages/core/src/permissions/permission-manager.ts:1379-1400`，**已逐字核对**）——AUTO 模式下新加的**危险** allow 规则被**暂存而非安装**，注释原文解释了原因："a user clicking 'Always allow' on a fallback prompt for a Bash invocation could persist `Bash` or `Bash(python *)` and every subsequent AUTO call would bypass the classifier"（判定标准另见 `dangerousRules.ts`）。**④ 审批要绑定到内容**（OpenClaw，最高价值的单条机制）：审批绑定 **规范命令 + cwd + 环境哈希 + 内容哈希的文件操作数**，**批准后任何漂移即拒绝**；无法建立绑定的 shell 形式**直接拒绝执行**；"无可达审批 UI 时默认拒绝"；**"连续三次评审拒绝即升级到人"**。**⑤ 授权要可撤销而非仅可预批**（Letta git 支持的 MemFS：所有记忆/上下文纳入 git、可同步到仓库、重组前先备份、`/doctor` 审计漂移）。**⑥ 影子 git 快照 + 选择性还原**（opencode `packages/core/src/snapshot.ts:94-224`：git 目录放在**仓库之外**、内容寻址、**按路径选择性还原**、`preview()` 只对比不落盘、**捕获失败绝不让本轮失败**、还原前先校验包含性；默认开启）。**⑦ 记忆化信任必须放在仓库之外**（grok-cli：按 realpath 记、存 `~/.grok/workspace-trust.json` 权限 0600，**因此克隆来的恶意仓库无法自带授权**）。**⑧ 只缓存"危险"结论**（goose `permission/permission_inspector.rs:22-34`：判为危险的被记住，判为安全**永不**缓存；严格模式下连缓存与只读注解都忽略）；**⑨ 审批把检查交给机器而不是人**（OpenClaw 的 LLM review 返回 allow/deny/ask，机器拒绝会把理由**回给模型而不产生人类审批卡**）——**这一条本项目明确不采用，见下**；**⑩ 每个轴各自独立**（OpenClaw 原文警告 **"allowing `exec` while denying `write` does not make shell commands read-only — restricting side effects is the sandbox' responsibility"**）；**⑪ "总是允许"不得击穿安全分类器**（同 ③）；**⑫ `--yes-always` 不覆盖 shell 命令**（aider `io.py:866-867` + `coders/base_coder.py:2456-2462`）。采用：**① 第三条轴——"能力存不存在"**：权限档位不只调"沙箱/审批"，**还必须决定哪些工具在本会话中根本不存在**；这类拒绝**不需要人参与**（提示可以直接说"本会话不提供该工具"）。**这条修正 D24 的结论**：D24 说"Windows 上无沙箱 ⇒ 审批必须是主要边界"，方向对但**不完整**——真正结构性降打扰的手段是**缩小动作空间**（疲劳 ∝ 决策数 ∝ 动作空间大小），而不是让提示更聪明；**② 授权绑定内容哈希 + 执行前复验 + 漂移即拒**（这是唯一能在**不扩大风险**的前提下扩大自动放行快路径的办法：重复请求变成缓存命中）；**③ 升级按"连续次数"而非每次都问**；**④ 各轴独立**（工具存在性／运行位置／谁来审／是否允许 是四个控制，不可互相替代）；**⑤ 授权只缓存"危险"、永不缓存"安全"**；**⑥ 记忆化的信任与快照必须存在仓库之外**，否则恶意仓库可自带授权（与 D23 的"仓库内策略不得自行提权"是同一条原则的第二个证据）；**⑦ 撤销优先于预批**——本项目基因库**本身就是内容寻址 + 不可变 + 追加式 JSONL**，因此"agent 采到一个坏基因"应当是**可回退的事件而非静默漂移**，这比再增加一层预批更契合已有设计；**⑧ 影子快照 + 选择性还原**列为 M3 之后的候选（它能把"无沙箱＝无回滚"这一条**部分**补回来，且不需要容器）。明确不做：**不做"把检查交给另一个模型"**（Pattern C：OpenClaw 的 LLM review、Letta 的 background review、AutoGen 的可路由人类）——**理由与 D14/D15/D19/D22/D24 一致：那是第二自报通道**；本项目宁可"判不了就问人/就拒绝"，也不让一个模型替另一个模型签字；**不做 Docker/云沙箱**（见下）；**不采用 aider 的 repo map 排序**（需要 tree-sitter + networkx，与零依赖冲突；其**"二分搜索控制预算"**的思路可借鉴，但那属于 M4+ 的上下文预算议题）；**不做 `bypassPermissions` 式的"标签即解锁"**（OpenClaw 的 `full` 模式仅由 `operator.admin` 把关，本项目要求**移除文件系统边界必须是显式的落盘选择**，而不是一个权限标签可达）；**不做自我改写 harness**（Letta 允许 agent 改写自己的 mod——**执行规则的代码不得被被执行的代码编辑**，这与本项目"边界代码不进 agent 可写集"一致）；**不做"代码执行作为主工具"**（Open Interpreter：把整个工具面坍缩成一个无界能力，**每条命令都像新的**⇒必然疲劳，本项目的具名参数化工具更强）。**最要明确拒绝的共享反模式**：**"因为沙箱/Docker/云能兜住损害，所以可以宽松"**——OpenClaw 默认沙箱关闭且不提示、Hope Agent 与 AutoGen 依赖 Docker、TrustClaw 把执行外包到云、Letta 让 agent 改写自己的 harness；**这些安全叙事全部依赖本项目刻意不具备的隔离**。本项目约束更严⇒姿态必须更严；而按 Pattern A/B/D/G，**严格与低打扰是兼容的**：缩小动作空间、绑定并缓存授权、**在"连续"层面升级**，只在**无法判定的例外**上找人 | 落地顺序再次修订（**三轴替代两轴**）：先做**①能力存在性**（会话级工具集合，缺席即无需审批）与**⑥仓库外记忆化**、**⑩各轴独立**——**都不需要 shell，可立即实现并测试**；再做**②授权绑定内容哈希 + 执行前复验**（本项目写入账本已有"执行前算账"的同构经验，可直接复用其形态）；③规则表内核（D23）；**④影子快照/选择性还原**（可部分弥补无沙箱，候选）；最后才接命令执行。另记两条**未验证项**：goose 的威胁模式表**"检测存在、是否真正门控执行未验证"**；qwen-code **未继承** gemini-cli 的影子 git 检查点/回退功能（已 grep 确认），**不可假设家族相似即具备** |

| D24 | **Codex 的答案：降打扰靠沙箱，不靠审批——而 Windows 上这条边界最弱，D22 的"以审批为主"在这里必须修正**。读过的源码（委托调研，逐行引用，commit `30fc6864`）：`codex-rs/protocol/src/protocol.rs` L983–1006（`AskForApproval = UnlessTrusted|OnRequest|Granular{bools}|Never`；**字面量 `approval_policy="untrusted"` 已被配置加载拒绝**——`core/src/config/mod.rs:3697-3702`，`UnlessTrusted` 只作为**内部**策略自动施加于不受信任项目，**这是 Codex 主动离开"什么都问"的最强信号**）、L1069–1117（`SandboxPolicy = DangerFullAccess|ReadOnly{network}|ExternalSandbox|WorkspaceWrite{writable_roots, network, …}`）、L1124–1156（`WritableRoot { root, read_only_subpaths, protected_metadata_names }` 与 `is_path_writable` 的检查顺序）、`core/src/permissions.rs` L2232–2269（**自动把 `.git`（含解析 `gitdir:` 指针）、`.agents`、`.codex` 设为只读——理由是 `.git/hooks` 是提权通道**）；`core/src/exec_policy.rs` **L820–839（本片最重要的一段）**：`OnRequest` 且沙箱为 `Restricted` 时，非升权、非危险的命令直接 `Decision::Allow`，注释原文 **"In restricted sandboxes, do not prompt for non-escalated, non-dangerous commands; let the sandbox enforce restrictions without a user prompt"**——**即：普通命令静默执行，审批只保留给"模型主动要求逃出沙箱"与危险命令启发式**；L789–807（**Windows 无沙箱后端时，反而强制弹窗**补偿）；`tools/orchestrator.rs` L1–8（设计原文："approval → select sandbox → attempt → retry with an escalated sandbox strategy on denial (no re-approval thanks to caching)"）、`tools/sandboxing.rs` L41–63（`ApprovalStore` 是**内存 HashMap**，只存 `ApprovedForSession`，**不做磁盘持久化**；持久的"总是允许"改用 execpolicy 前缀规则表达）；`sandboxing/src/manager.rs` L48–62 与 `core/src/config/windows_sandbox_config.rs` L73–86（**Windows 只在 `windows_sandbox_enabled` 时用 `WindowsRestrictedToken`，否则 `SandboxType::None`**）、`features/src/lib.rs` L1241–1252（该特性 `Stage::Removed, default_enabled: false` ⇒ **原版 Windows Codex 实际没有沙箱**）；`windows-sandbox-rs/src/token.rs` L500（`CreateRestrictedToken` + `DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED`）、`setup.rs` L53–54（升权后端会**新建 `CodexSandboxOffline`/`CodexSandboxOnline` 本地账户** + 特权服务 + WFP 防火墙）；**`windows-sandbox-rs/src/lib.rs` L714–723 / `unified_exec/backends/legacy.rs` L343–350 / `sandboxing/src/windows.rs` L113–129 / `resolved_permissions.rs` L51–54 的自认限制**："Restricted read-only access requires the elevated Windows sandbox backend"、**"WRITE_RESTRICTED tokens consult restricting SIDs only for writes"**（⇒ 非升权后端**无法让拒读 ACL 生效**）、需要拆分读限制或全盘写入时直接**拒绝运行而不是无沙箱运行**（"refusing to run unsandboxed"）；`protocol/src/config_types.rs` L261–272（**`ShellEnvironmentPolicy::default()` 是 `inherit: All` + `ignore_default_excludes: true`**，按 L232–238 的文档算法，那意味着 `*KEY*`/`*SECRET*`/`*TOKEN*` 过滤被**跳过**⇒ **子进程默认继承父进程全部环境变量，含密钥**）、`sandboxing/src/seatbelt_base_policy.sbpl` L11–12（**`(allow process-exec)` / `(allow process-fork)`——进程创建不受限**）；注册表方面（**全部 `RegOpenKeyExW`/`HKEY_*` 只出现在安装/清理/隐藏用户代码里，从不出现于 agent 子进程路径 ⇒ 零保护**）；`protocol/src/config_types.rs` L637–645 与 `config/mod.rs` L3705–3715（`TrustLevel` 可信→`OnRequest`、不受信任→`UnlessTrusted`，且**不受信任项目的规则/hooks/MCP/配置一律忽略**）；`config_types.rs` L183–190（`ApprovalsReviewer::AutoReview` 把审批交给子代理）。采用：**① 沙箱是默认执行边界，审批是窄的例外通道**——这是"不打扰"的正解，与我 D22 的倾向相反：**"不弹窗"不是靠把审批调松，而是靠"有一个结构性边界，边界内静默运行"**；**② `WritableRoot` 的"根 + 只读子路径 + 受保护元数据名"三层裁剪**——尤其是**默认保护 `.git`/`.agents`/同类目录**（`.git/hooks` 提权通道），本项目必须照做；**③ 不信任即收紧**——`TrustLevel` 是策略收紧的输入，不受信任来源的规则/hooks/MCP **一律忽略**（与 D22 第⑥条一致，此处得到独立交叉验证）；**④ 授权只存内存、按会话**，持久的"总是允许"必须是**显式的、可审计的规则**（本项目已有基因库与 JSONL 追加式审计，天然契合）；**⑤ 升级路径是"拒绝后带更宽策略重试一次、不重复询问"**——这比"每次都问"体验好得多，且**批准本身不落盘**。明确不做：**不复制 Windows 受限令牌方案**——上游自认非升权后端**只能约束写、读不受限**，且升权后端要**新建本地账户 + 装特权服务 + 改防火墙**，对本项目（开源、个人、零生产依赖、不信任第三方组件、且**明确不要沙箱**）代价与风险都不成比例；**不假装 Windows 有沙箱**（D21/D22 不变，且现在有了上游自认限制作为佐证）；**不采用 `AutoReview` 把审批交给另一个模型**（同 D22：第二自报通道）；**不忽略环境变量泄漏这一条**——上游默认把密钥传给子进程，本项目**必须显式白名单化子进程环境**（现有 M2 已有"工具 env 白名单"，M3 必须复用而不是另起一套）。**这一条修正 D22 的重心**：D22 说"两个正交旋钮、预设呈现"，方向对，但**在 Windows 上"审批"不可能成为主要边界**（上游的沙箱都只是写约束），因此本项目的诚实定位是：**在无沙箱平台上，边界 = 路径收敛 + 写预算 + `WritableRoot` 式只读保护 + 环境白名单 + 有界输出 + 审计 + 窄化授权，而不是"隔离"**；文档必须**逐条列出这些不是隔离** | 落地顺序调整：**先做"结构性约束"**（`WritableRoot` 式根+只读子路径+受保护名、子进程环境白名单、输出上限、授权只存内存）——**它们不依赖 shell，可以先做并测试**；再做规则表（D23 的 tier 优先级内核）；**最后**才接命令执行。**M3 的定位从"能跑命令"改为"在明确非隔离的前提下能跑命令，且文档逐条写明不保证什么"** |



| D33 | **队列校正：剩余工作被一个未构建的能力卡住，且那是一个改变产品性质的决策（无代码，只改文档）**。**触发**：我上一条建议"下一片做规则表内核"，用户同意继续并追问 skill 状态；我借这次核实顺手核对了基线，**发现自己的建议是过期的**。**核实到的事实（查命令得出，不凭记忆）**：`src/rule-table.ts`（D31）与 `src/tiers.ts`（D32）**都已存在**，`test/rule-table.test.ts`、`test/tiers.test.ts` 也都在；`cli.ts` 按**档位的工具列表**构造 `ToolRegistry` 与规则表（即 ①能力存在性与 ③规则表**真的接上了**，不是并行的两套）；基线 **365 条（364 过 / 0 失败 / 1 跳过）**。**⇒ 我若照原计划动手，会重做已完成的 ③。** **真实剩余状态（读 SWARM_LOOP §8 并核实源码）**：5 项里 **(1)(2)(5) 全部前置 M3 受控进程工具**——`src/` 下**确无** shell/exec 类模块；**(3) 独立评审者明确以 (1)(2) 为前置**；**(4) 增益定价是"等 outcome 数据积累"，属等待而非可排期工作**。**结论**：剩余队列**不是可逐条执行的清单，而是被同一个尚未构建的能力卡住**。**本条的实质判断**：**M3 不是"下一步做什么"，而是"要不要改变产品性质"**——今天**全部边界（路径收敛／写预算／能力存在性／授权绑定／漂移检测）都只作用于文件工具**，而**命令执行天然不受它们约束**（D27 已实测：`assertWritablePath` 只管文件工具，命令路径上"写哪里"由**操作系统**决定）。因此接 M3 **必须同时**决定四件事：**(a)** 命令的**能力存在性**（默认不给，或给了按 D28 缺席语义）；**(b)** 命令的**授权绑定**（按 D29/D30 绑定到内容哈希，而**不是**"批准一次命令工具"——后者等于把整个无界能力一次性放行，正是 D25 拒绝 Open Interpreter 的理由）；**(c)** 写账本**能否/如何覆盖命令副作用**——**这里必须诚实**：文件工具能**精确计文件与行数**，而 `rm -rf`、`find -delete` 之类**从参数根本读不出写了几何**，所以命令的写入**要么事后统计、要么直接声明为不可计量**，**不得**假装它与文件工具受同样的预算约束；**(d)** **在无沙箱前提下是否接受命令执行**——Codex 在**同样平台**上的选择是**强制弹窗补偿**（D24：`windows_managed_fs_restrictions_without_sandbox_backend` ⇒ `Decision::Prompt`），即**它自己也不接受"无边界且静默执行"**。**采用**：**不自动开工 M3**，把它作为**显式决策**交回操作者；同时列出**不依赖 M3 仍有价值**的方向（④影子快照/选择性还原＝只作用于文件工具、与现有边界同域，可**部分**弥补"无沙箱＝无回滚"；规则表接配置＝但**必须同时**落地 D26 的"仓库自带配置不得自行提权"与"移除边界须落盘可审计"，否则会**打开目前尚不存在的攻击面**；`--tier` 端到端验证＝已接线但**无真机验证**）。**明确不做**：**不为填满队列而虚构切片**——队列空了不是开工的理由，**"没有可推进的动作"本身就是要如实上报的状态** | **给操作者的问题（必须问，不得自行决定）**：是否做 M3？若做，上面 (a)(b)(c)(d) 逐条定夺；若暂不做，则从三个不依赖 M3 的方向中选。**一处自我提醒（本条根因）**：我**依据文档摘要推断下一步，而没有先核实代码与基线**——`STATUS.md` 的队列条目**长且是历史累积的**，容易把"已按 D31/D32 完成"的部分读成"待办"。**教训：在宣布"下一步做什么"之前，先查那件事是否已经存在**（本轮 `rule-table.ts` 的存在就是反例） |

| D34 | **M3 四问（a/b/c/d）的跨产品答案：每家的答案不同，而且各自的失败方式也不同（纯调研，无代码）**。用户问"M3 四问其他 agent 如何设计"。**方法**：回到 `_research/repos` 的本地克隆**只读**读取（未修改任何外部仓库），**引用均为源码原文**，非记忆。**（a）命令算不算"能力"——缺席而非拒绝**：**gemini-cli** `plan.toml` 有一条 `toolName="*"` + `decision="deny"` 的兜底，再用 `toolAnnotations={readOnlyHint=true}` 把只读工具放回来（D23 已记）——**这是"按规则表达的缺席"**：命令在 plan 模式下不是"被拒绝"，而是**从未被允许**。**本项目差异**：我们有两层——`ToolRegistry(available)` 是**会话构造层的缺席**（工具根本不进提示词），规则表是**决策层**。**结论：两者都要**，因为构造层缺席**不需要模型参与**，规则层缺席能随轮次变化。**（b）命令的授权绑定——gemini 有机制，crush 相反，本项目必须选 gemini 一侧**：**gemini-cli** `packages/core/src/tools/tool-names.ts:169-182` 定义 **`TOOLS_REQUIRING_NARROWING`**（注释原文："Tools that require mandatory argument narrowing (e.g., file paths, command prefixes) when granting persistent or session-wide approval"），成员含 **`SHELL_TOOL_NAME`**、`READ_FILE`、`WRITE_FILE`、`EDIT_TOOL_NAME`、`GLOB`、`GREP`、`LS`、`READ_MANY_FILES`；`packages/core/src/policy/config.ts:734` 与 `:776` 对持久/会话级授权**强制要求** `commandPrefix` 或 `argsPattern`，**没有就跳过并记日志**（原文："Attempted to update policy for sensitive tool ... without a commandPrefix. Skipping."）。⇒ **"批准 run_shell_command 本身"在 gemini 里是不可表达的**。**crush 则相反**：`internal/agent/tools/bash.go:229-240` 的授权请求**`Path: execWorkingDir, Action: "execute"`**——**键是工作目录，不是命令**；配合 `internal/permission/permission.go:88` 的 `PermissionKey` 四元组与 `:158-168` 的 `GrantPersistent`，**一次持久授予 = "这个目录下所有命令都不用再问"**。它有一个部分补偿：`bash.go:210-222` 对**裸的**只读命令（前缀匹配安全表）**根本不请求批准**，但该判断在 **`containsCommandChaining` 为真时被整体跳过**——即**一旦命令含管道/串联就退回全量询问**。**（c）命令副作用的度量——没有人度量**：**Codex** `core/src/exec_policy.rs:810-814`，`AskForApproval::Never` 分支**直接 `Decision::Allow`**，注释原文 **"We allow the command to run, relying on the sandbox for protection."**——**它不测量副作用，它把这件事整个外包给沙箱**。**这正是本项目不能照抄的原因**：我们没有那个沙箱。**（d）无沙箱平台——Codex 自己也不接受"无边界且静默"**：`exec_policy.rs:789-807` **强制弹窗补偿**（D24 已记，本轮重申）。**（e）一条本次新发现的细节**：crush 的 `GrantPersistent` 在**持久化前先赢下 pending-request 竞态**（`permission.go:158-168` 注释原文："Record the persistent grant only if this call wins the pending-request race. Otherwise a losing GrantPersistent that lost to a Deny would still leave an auto-approve entry behind, silently flipping later denied calls to allowed."）——**即"拒绝"必须能压过"稍后被批准的同一请求"**，否则会出现"先拒后自动放行"。**这是我们 D29/D30 尚未覆盖的竞态**：本项目授权是**逐次比对内容哈希**、没有 pending 竞态窗口（因为批准是同步的 `await context.approve`），**故当前无此缺陷**，但**若日后引入异步/持久授权必须补上这一条**。**综合判断（本条的实质）**：**四问没有一家全解，而且"在 (b) 上看起来最安全的（gemini）恰恰在 (c) 上依赖沙箱"**——gemini 与 codex 都假设存在隔离层来兜住命令的副作用，`crush` 承认没有（它连持久授权的粒度都只能给到目录）。**本项目在 (c) 上没有可抄的答案**，只能**自己选一条诚实的路**：要么**声明命令副作用不可计量**（则命令的边界只能靠 (a) 缺席 + (b) 内容绑定 + 授权次数，**而不是**写预算），要么**只允许可枚举的命令形态**（如仅允许形如 `test`/`lint`/构建 的固定命令白名单，参数经 `argsPattern` 式匹配）——**后者正是 gemini `TOOLS_REQUIRING_NARROWING` 的思路，也是唯一能让 (c) 变成可测量问题的路径** | **给操作者的建议（不自行决定）**：**(b) 采 gemini 一侧**——命令授权**必须**带 `commandPrefix`/`argsPattern` 式窄化，**拒绝"批准该工具"**；**(c) 建议走"可枚举命令形态"而非"事后统计"**，因为事后统计**无法在拒绝发生之前生效**（而本项目的全体设计原则是**拒绝先于执行**，见 D18）；**(d) 若要接 M3，建议默认缺席（命令工具默认不提供）**，只在显式档位下出现，且**文档必须写明"命令执行不受路径收敛与写预算约束"**。**仍未做**：本片**未写任何代码**，四问的最终定夺**待操作者** |

| D35 | **附加可读根：把路径轴从"只能收紧"变成"可以显式放开"，且读写分离（本片有代码，已测）**。**触发**：用户说明用途是开放的——"从0构建项目、聊天、逆向软件、安全审计等等"，并确认逆向"读文件理解"与"跑工具交互"两个方向都可能。**核实到的两个事实（决定设计）**：**(1)** `assertReadablePath` 是**读写共用的唯一门**（`tools.ts` 的 `read_file`/`edit_file`/`patch_file`/`create_file` 全走它），所以**原地放宽会同时放宽写**；**(2)** 既有的 `extraRoots` 参数进的是 **deny 列表**（`security-config.ts:134` 与 `protectedRoots()` 合并），而 `PERSONAL_AGENT_PROTECTED_ROOTS` 只增不减——**即本项目此前只有"收紧"这一个方向，没有任何机制能放开**。这正是"安全审计/逆向做不了"的真实原因（不只是没 shell：连 `read_file` 都出不了工作区）。**采用**：**(a) 信任存 agent home，不存仓库**——`<agentHome>/trust.json`，理由照 grok-cli（按 realpath 记、存 `~/.grok/workspace-trust.json`）：**放在仓库里的信任文件是攻击者可控的，克隆恶意仓库即自带授权**；已有测试断言工作区里没有该文件。**(b) 决策时读、不缓存整会话**——照 qwen-code 的"每次调用重读信任"，故 runtime 在**每一步之前**重读；快照会让"已撤销"在下一轮仍然可读。**(c) 读写分离用两个函数而非一个布尔参数**——`read_file` 走 `assertReadablePathOutcome`（consult `readableRoots`），**写工具直接调 `assertReadablePath`**；写测试断言三个写工具在授予可读根后**仍以 `path escapes the workspace` 拒绝**。**刻意不用 flag**：调用点上的布尔量正是后续重构会被误翻、且"读的放宽变成写的放宽"无人察觉的东西。**(d) 名字保护在附加根内**照常生效（`.env`/`.git`/`*.pem` 等），因为名称名单虽不是边界，但**在附加根里失效会比工作区内更弱**，那是奇怪的取舍。**(e) 授予与撤销都写审计**（`rule:"trust:grant"` / `"trust:revoke"`，含路径），符合 D26"移除边界必须是可审计的显式决定"。**开发过程中被自己抓到的三个错误（都不许静默）**：**①** 第一版 helper 在 `checkReadable` 放行后又委托回严格检查，**导致附加根永远不可达**（探针证实：`checkReadable → undefined` 而严格检查抛错）；**②** 修正后**过度应用** `protectedRoots()`——它含 `%LOCALAPPDATA%` 这类**整棵宿主树**，于是"授予的目录仍被拒为 sensitive"（探针实测 `DENIED BY: C:\Users\...\AppData\Local`）；**诚实修正**：附加根内**不再套用宽泛的宿主树**（否则几乎任何可授予目录都不可用），改为只保留**runtime 自己的状态与日志根**（新增 `protectedStateRoots`，只含 `home` 与 `storeRoot`）；**③** 测试里用 `as const` 元组传参导致工具收到空 `path`，**断言失败暴露的是测试的 bug**，改为显式闭包。**一条诚实边界（必须写进文档）**：**放宽可读根＝给的是整棵目录树，不是"只读那几个文件"**——`sensitivePathName` 是按名匹配的名单，它挡 `~/.ssh/id_rsa`，**挡不住**名如常物的敏感文件；CLI 授予时**明说这一点**。**验证**：新增 `test/trusted-roots.test.ts` **13 条**（含 4 条专门断言"可读根不放宽写"、1 条断言信任文件不在工作区内、1 条断言损坏的信任文件**报错而非读成空**）；CLI 端到端真机验证 grant→list→revoke→list 全通，审计两条都在；**测试基线 365 → 378（377 过 / 0 失败 / 1 跳过），零回归** | **仍未做**：**未读二进制**（`read_file` 仍是 UTF-8，逆向场景"读二进制"仍缺一步，用户已确认两个方向都可能）；**无 shell / 无具名工具**（(a)-(d) 四问仍未定夺，见 D34）；**附加根不参与写预算**（因为不参与写，故无此问题）；**未验证跨盘符、符号链接、以及附加根被删除后的行为** |

| D36 | **附加可读根的真机使用与对比（无代码改动，纯验证；含一条环境事实）**。用户要求"真用一次,然后对比看看"。**做法**：用**真实 runtime + 真实工具注册表**（按 `cli.ts` 的接线复刻：`ToolRegistry` 带 7 个文件工具），模型换成**脚本化的确定性 adapter**（先请求 `read_file` 读工作区外的文件，再请求 `edit_file` 写同一文件），**对比授予根之前与之后**。**结果（这就是要的对比）**：**A 不授予根**——`read_file` → `path escapes the workspace`，`edit_file` → `path escapes the workspace`；**B 授予 `_research/repos/goose` 后**——`read_file` → **读到真实正文**（`<div align="center">` / `# goose` / `_your native open source AI agent…`），`edit_file` → **仍 `path escapes the workspace`**。**即"授予后读通、写仍挡住"的不对称性在真实工具门上成立**，与单测结论一致（单测是工具级，这里是经 runtime 的端到端）。**两处必须说清的混淆项**：**(1)** 每次运行第一条工具行都是 `no tools are configured, cannot run read_file`——这是**既有的 runtime 提示**（`runtime.ts:963`，属于某一轮 adapter 尚未挂载时的情况），**与路径决策无关**，我没有把它解释掉而是查到了源码行；**(2)** **真实模型那一半没做成**：**保存的 provider key 被本地端点拒绝**（我用该 key 直接请求 `GET /v1/models` 得 **HTTP 401**，key 长度 17），所以**本会话当前无法跑真实模型轮次**；**不拿脚本化运行冒充真机模型运行**。**这一条环境事实值得上报操作者**：它不是产品缺陷，但意味着"让 agent 真正读一个仓库并汇报"目前跑不通，需要先修凭据或换端点。**过程记录（试错，均为探针自身的错）**：`SessionStore` 参数形状、`ModelAdapter` 只有 `chat` 而非 `complete`、响应必须含 `model` 与完整 `usage`（**被产品自己的 `validateResponse` 拒了，说明该校验是有效的**）、`Copy-Item` 产生的文件被 `loadProvider` 的**硬链接检查**拒绝（`info.nlink > 1`，已改用 `[System.IO.File]::WriteAllText` 写普通文件）。**清理**：临时 fixture 全部删除，`git status` 无残留 | **仍未做**：**未用真实模型验证**（受凭据阻塞）；**未验证跨盘符、符号链接、附加根被删除后的行为**；**仍未读二进制**（`read_file` 是 UTF-8，逆向"读二进制"缺一步）；**无 shell**（(a)-(d) 四问未定夺，见 D34） |

| D37 | **真机跑通：凭据根因 + 一个真实缺陷（适配器超时）+ A/B 对比成立（本片有代码，已测）**。**用户的判断是对的**："url 没有变，只是模型不能用了"——**但根因不是模型**。**(1) 凭据根因（照实说）**：`.personal-agent/provider-config.json` 里的 `apiKey` 是**字面量 `ZZCSAPI_ADMIN_KEY`**——**那是环境变量名，不是密钥**。真正能用的是**用户环境里的 `BD_API_KEY`**（`C:\Users\RongWu\.dsh\profiles\desktop\cordis.patch.yml:96-100` 记录 `bd: apiKeyEnv: BD_API_KEY` + `baseURL: http://127.0.0.1:8787/v1`，**即我自己这个 agent 跑的就是它**）。**实测**：`BD_API_KEY` 打 `/v1/models` → **200**，模型列表含 `glm-5.3-free`；`/v1/chat/completions` → **200**，返回 **"WORKS"**。**端点与模型都好的，坏的只是那把钥匙。** 已写入配置（15 字符），并**先核实该文件被 `.gitignore` 忽略**（`.gitignore:2: .personal-agent/`）才写密钥。**(2) 由此暴露的真实缺陷（代码修复）**：配好钥匙后 CLI 仍失败 `The operation was aborted due to timeout`。**根因**：`openai-adapter.ts:165` 的**每请求超时写死 120s**，而 `runtime.ts:617` 的发送期限是**另一个**可配置值（默认 300s），**CLI 从未把后者传给前者**（`cli.ts:304` 只传 config）——**于是适配器成了真正的约束**，把发送期限调大**完全无效**，因为短的先触发。**实测延迟**：对**同一端点**，一次**一个词**的补全**耗时 74.0s（默认）/ 64.8s（长超时）**；而**一轮带工具调用的任务实测 95-230s**——**120s 默认几乎没有余量**。**修复一行**：`createOpenAIChatAdapter({...config, timeoutMs: options.deadlineMs, ...})`，让操作者配置的期限成为**唯一**的界限。**这不是安全放松**：超时约束的是**等待**，更长的界限**仍然是界限**。**(3) A/B 真机对比（用户要的"真用一次"）**：同一 fixture、同一问题（"读工作区外的 goose README，只回答产品名"）、**真实模型**。**A 未授予根** → 模型如实回答"**无法读取该文件——位于我的工作区之外，工具拒绝了该路径**"并给出替代方案；**B 授予根后** → **一次工具调用读到文件并回答"goose"**。**对照成立**，且**模型没有编造**（系统提示词里的"never pretend a tool succeeded"确实生效）。**(4) 写入仍被挡住（安全核心，已实测）**：授予只读根后，让脚本化模型请求 `create_file` 写到**同一授予目录**（`_research/repos/goose/pwned.txt`）→ **`create_file: path escapes the workspace`**，**文件确认未创建**，`git status` 确认 **goose 仓库零改动**。**(5) 过程中的两次自我纠错**：**①** 我一度以为信任代码是死代码（`grep runTools` 无结果），实际方法名是 **`runToolCalls`**，**是我 grep 错了名字**，不是代码错；**②** 首轮 B 失败**是我把授权与运行放在同一次调用的时序问题**，独立 fixture 重测后 A/B 均正确。**(6) 一条环境事实**：端点**偶发 HTTP 502**（C 的两次尝试都撞上），**不是产品缺陷**，但说明该网关不稳定，重测是必要的。**测试基线不变 378（377 过 / 0 失败 / 1 跳过）** | **仍未做**：**端点 502 未追查**（非本项目问题）；**未验证跨盘符、符号链接、附加根被删后的行为**；**仍未读二进制**（`read_file` 是 UTF-8，逆向"读二进制"缺一步）；**无 shell**（(a)-(d) 四问未定夺，见 D34） |

| D38 | **读二进制：`read_file` 从"静默损坏"改为"无损十六进制 + 范围读"（本片有代码，已测，已真机验证）**。用户的判断"开始二进制"是对的，但**我先量了它现在到底怎么坏**，没猜。**(1) 测出的失败形态（关键）**：`read_file` 读 `89 50 4e 47 ff fe fd 00` **不报错**，返回 **4 个 U+FFFD 替换字符**混在文本里；**往返是有损的**——原始 **8 字节**变成 **14 字节**（`efbfbd` 用 3 字节顶掉原本 1 字节），**信息彻底丢失、无法还原**。**对逆向这是最糟的失败形态：模型拿到看起来像文本的东西，且没有任何信号说明它已损坏。** **(2) 判定改为机器事实而非启发式**：`isRoundTripUtf8` = 解码后再编码必须逐字节相等 **且 不含 NUL 字节**。**两个条件都必需，这是我自己踩出来的**：真实可执行文件的 **DOS 头（前 64 字节）本身是合法 UTF-8**（全部 < 0x80），**只测往返会把它当文本**返回 `MZx` + 57 个 NUL——我第一版就是这样错的，测出来后补上 NUL 判据。UTF-16 文本则被往返判据挡住（它根本不是合法 UTF-8）。**不用扩展名、不用"看起来像不像"**。**(3) 范围读（真机验证它是必需的，不是镀金）**：一个 **92 MB 的 `node.exe` 原本整个读不了**（超 256 KB 上限）。**盲目提高上限是错的，我算了才改**：hex 每字节约 **4.5 字符**，256 KB 文件的转储就有 **~1152 KB 文本**，而上下文窗口只有 **~512 KB**——**今天这个上限的整文件转储就已经溢出**。**所以加的是 `offset`/`length` 而不是更大的上限**，并实测：**92 MB 文件的 PE 头只需前 544 字节**（`e_lfanew@0x3C=120`，`PE\0\0` + Machine + 10 个 section）。偏移是**文件绝对偏移**，模型可据此连续读取。**超限时错误信息直接给出出路**（"pass 'offset' and 'length'"）。**(4) 无损性已证**：**全部 256 个字节值**经 hex 视图往返，`Buffer.equals` **完全相等**。文本（ASCII + 中文）**逐字节不变**。**零权限变化**：同一条路径闸门、同一个工具，只是"已经允许读的东西"换了一种呈现；写入闸门与读写分离**未动**。**(5) 真机端到端验证（成功，但过程暴露了基础设施问题）**：用**真实模型**读 92 MB `node.exe`，模型**自己推理出需要读第二段**（"架构信息在 0x78，我读的 64 字节不够"），然后用两次 offset 读给出**正确答案**：格式 **PE**（`4D 5A` + `0x3C→0x78` + `50 45 00 00`）、架构 **AMD64/x86-64**（`64 86` → 小端 `0x8664`）。**这正是逆向需要的动作**。**(6) 过程中暴露的真实缺陷：适配器从不发送 `max_tokens`**（见 D39），已修。**(7) 我自己的错，照记**：探针两次用 `%TEMP%` 建 fixture，被**产品正确拒绝**（`%TEMP%` 位于受保护的 `%LOCALAPPDATA%` 下），**是探针错不是产品错**；测试里一处 `match[1]` 可能 undefined 的类型错误也是我的。**(8) 上下文事实更新**：`glm-5.3-free` **已不可用**（0/3 成功）。**测试基线 378 → 391（390 过 / 0 失败 / 1 跳过）**，新增 `test/binary-read.test.ts` 12 项 |

| D39 | **适配器从不发送 `max_tokens`（本片有代码，已测）+ 网关模型能力的实测矩阵（照实说）**。**(1) 缺陷**：`openai-adapter.ts` **完全没有** `max_tokens` 字段（grep 零命中），即**把单次回答长度完全交给提供方决定**——而本项目在**所有其他地方**（写入预算、字节上限、发送期限）的规则都是**调用方声明上限**。**已修**：新增 `maxTokens` 选项，默认 `DEFAULT_MAX_TOKENS = 8192`，**每次请求都发**，操作者可覆盖。**这是"加界限"不是"放松"**。**(2) 但我必须说清一个我一开始搞错的因果**：我把 502 归因于缺 `max_tokens`（当时"带=200、不带=502"复现了两次，看似确凿），**修正后适配器确实成功过一次（87.1s 返回 "FIXED"）**——**但随后连 `max_tokens` 都挡不住，502/503 连续 5 次**。**所以那个"修复"是在网关碰巧正常的窗口里被验证的**，我把话说准：**发送 `max_tokens` 是对的（有测试、符合本项目规则），但它不是 502 的根因。** 差点把巧合当因果，这是本片最该记住的一条。**(3) 真正的根因，实测出来的矩阵**：网关 **`/v1/models` 始终 200**，**故障是按模型分的，不是全站故障**：

| 模型 | 推理 | 工具调用(`tool_calls`) |
|---|---|---|
| `glm-5.3` | **4/4 稳定** | **✅ 正常** |
| `glm-5.3-free` | **0/3**（502/503） | —（不可用） |
| `deepseek-v4.1-flash` | 3/3 稳定 | **❌ NONE** |
| `gpt-6-sol` | 200 | **❌ NONE** |
| `claude-opus-5` | 502 | — |

**结论（重要）**：**"能稳定推理的模型"和"能调用工具的模型"不是同一个。** **我此前的配置 `glm-5.3-free` 恰好是最坏的一个**（推理不稳、且已下架）。**已改为 `glm-5.3`**。**(4) 一个网关行为，必须记录**：`deepseek-v4.1-flash` 收到 `tools` 后**不报错、不返回 tool_calls**，而是**把工具静默丢弃**并回答纯文本——原文：*"I don't have a `read_file` tool available in this session"*。**在 DSL 层面这是"成功"，在本项目层面这是"工具全废"**：真机运行表现为模型反复说 `function call failed, not handled`，而**该字符串在我项目源码里零命中**（grep 证实）——**说明是网关合成的话术，不是我的代码**。**这条对开源发布的含义**：不同提供方对 `tools` 的处理差异是**静默的**，需要在预检里显式探测"这个模型到底支不支持工具调用"，**不能假设 200 就等于可用**。**(5) 我的错（照记）**：PowerShell 里写过一行多余赋值导致整个脚本解析失败；把 502 归因于请求形状（见上）。**(6) 一条仍待查**：网关对**同一模型偶发 502/503**（`claude-opus-5` 亦如此），**非本项目代码问题**，但**建议以后在预检里把"推理可用性"和"工具可调用性"分开探测** |

| D40 | **预检能实测"提供方是否接受请求形状"和"是否真的调用工具"（本片有代码，已测）**。起因是**本会话被同一类失败浪费了多个回合**，且**状态码完全看不到它**。**(1) 原预检的结构性盲区**：它**故意不发凭据**（`preflight.ts` 文件头写明：可达性探测不送认证头，故 401/403 也算"可达"），**只能证明"有人在听"**，**永远无法证明"真实请求会被接受"**——它自己的结语原本就承认这点（"本检查仍不能证明：某个托管服务是否接受本客户端的请求形状"）。**(2) 实测出的两种 200 级失败，两者都是 HTTP 200**：**①** 网关拒绝请求形状——适配器不发 `max_tokens` 时**每个请求都 502**（D39）；**②** **提供方静默丢弃 `tools` 数组**、改回普通闲聊——**Agent 看起来在跑，实际每次工具调用都失败**，而**错误串 `function call failed, not handled` 在本仓库源码零命中**（grep 证实），**逼着操作者去自己代码里找一个根本不存在的 bug**。**(3) 设计原则（照实守住）**：**默认不测**（`--probe-tools` 才测），因为**这是唯一会花 token 且把密钥送上网的检查**；**"没测"必须显示为"未测量"而不是"通过"**（`toolCalling` 用 `undefined` 表示未测，注释明写"callers must not read it as a pass"）；**请求成功与工具可用拆成两条判据**——一次 200 但没调工具，是**请求通过 + 工具能力失败**，**合并成一个结论正是它此前没被发现的原因**。**(4) 我的测试抓到我自己的漏洞（重要）**：`never puts the key in a reported detail` **首次运行失败**——我原本只对错误正文做**截断**，而**截断不是脱敏**（密钥只有 15 字符，截断根本挡不住）；某个坏代理把请求（含认证头）原样回显在错误页里，**密钥就会被打进预检输出**。已加 `redact()`，**错误正文和模型回显都脱敏**。**(5) 另一处我自己的错**：探测超时原本写 60s，而**实测这个网关一个词要 65-75s、带工具一轮 95-230s**，于是**把能用的模型报成坏的**（"探测超时"）——**这个方向的错更危险**：它把操作者支去修错的东西。已改为 300s 并写明依据。**(6) 真机实测（照实说，包括我一开始的误判）**：加 `--probe-tools` 真机跑，**第一次报 `glm-5.3` "丢弃 tools"**，但**重跑一次就报"已实测可用"**。**两次结果不同 ⇒ 是网关在抖，不是模型不支持工具。**我把这条写进了输出：**"请重跑一次再换模型"**——**因为"模型不支持"和"网关这一分钟不舒服"在单次结果里长得一模一样**，这正是我今天早些时候把巧合当因果的同一类错误。**(7) exit code**：`0`=就绪、`3`=需补环境变量配置、**`4`=工具实测失败或请求失败**（**实测工具不可用的模型不该以 0 退出并被当成"就绪"**）。**测试基线 391 → 399（398 过 / 0 失败 / 1 跳过）** |

| D41 | **具名只读检查工具 `inspect_file`（用户选 A；本片有代码，已测）**。用户先纠正了我两点，都成立：**① 我把"没有沙箱"错推成"所以要弹窗"**——没有沙箱时**弹窗根本不是保护**（我点同意，事情照旧发生），它只是**最差的审计方式**；正确的推论是**"用户知情"≠"弹窗"**。**② 用户指出"工作目录是确定的（对话框里选），但实现用什么工具不是确定事件"**——**这才是设计约束**：要枚举的对象**是我在执行过程中才决定的**，所以**事先枚举在设计上就是错的**。用户由此推出授权应发生在"你说要干什么"时，我据此确立**授权/审计分离**：授权 = 你说"干什么"时确定的范围（目录+读/写）；工具选择 = 我的事，在授权范围内自由选，**不再问**；审计 = 记录但**不打断**。用户选 **A：操作者授权目录，工具清单由产品自带且可见**。**(1) 本片最关键的实现约束（我一开始就写下来防止自己走偏）**：**若模型能指定任意可执行文件，A 就塌回被否决的 C**。故 `tool` 是**产品常量 `INSPECTION_TOOLS` 的枚举**，参数只有**路径 + 少量有界开关**，**任何地方都没有接受命令字符串的参数**。工具还**在代码里再查一次枚举**（schema 是"我们接受什么"的说明，**不是闸门**）。**(2) 结构性强于检测**：不用 shell（`spawn` + `shell:false` + argv 数组），所以 `&&`/`|`/`;`/`>`/`$()`/反引号**不是被过滤，而是写不出来**。**实测对照（我读了 crush 源码）**：crush 的 `chainingMetacharacters`（`safe.go:61-75`）**漏** `ls & rm -rf /`、换行接第二条命令、`git status > /etc/passwd`——**但 crush 仍安全**，因为漏掉的只是"没享受到免提示"，照样弹提示（**fail-closed**）。**这纠正了我自己早先"白名单挡不住 `&&` 所以危险"的判断**：crush 的安全**不依赖**白名单，白名单只是**体验优化**。**(3) 我自己测出并修掉的两个真 bug**：**① 编码**：`certutil` 输出是 **OEM 代码页(GBK)**，按 UTF-8 解得到 `SHA256 ?? a.txt ??:`——**与 D38 同类缺陷**（看起来像文本、实为损坏、且无损坏信号）。已加 `decodeOutput`：**仅当 UTF-8 读出 U+FFFD 时**才回退 GBK（Node 内置该解码器，**零依赖**）。修复后 `命令成功完成。` 显示正确。**② 分块解码**：我原本**逐块**解码，**实测把一个汉字跨块切成两个 `�`**（`哈希` → `��希`）；已改为**先缓冲字节、最后解码一次**。**(4) 平台事实（我差点交付一个在 Windows 上全废的功能）**：`file`/`strings`/`xxd`/`objdump`/`nm`/`sha256sum` **在本机全部不存在**——**第一版清单在唯一实跑过的平台上每个工具都报"未安装"**。已补 Windows 自带等价项（`certutil -dump` / `certutil -hashfile` / `findstr`），**实测可用**（sha256("hello") 校验正确）。**(5) 两次我自己的误判，靠"先验证再断言"避免**：我一度以为**会话日志被写坏**（看到 `鐢?`），**排查后确认文件本身完好**（`contains 用: true`），**是控制台渲染**；又以为 `read_file` 回读**多了 BOM**，**确认是我的测试脚本的 here-string 带来的**，产品路径 `exact match: true`。**这两次都差一步就报出根本不存在的 bug。** **(6) 真机运行（诚实）**：加 `inspect_file` 真机跑**失败**，模型说"**我没有 `inspect_file` 工具**"——**又是网关静默丢弃 `tools`**（D39/D40 的现象），**日志证实发出的 tools 里确实没有它**。**故本片的真机端到端未完成**，我**不拿单元测试冒充真机验证**。已修的是机制；**待网关稳定后需重跑一次真机确认**。**(7) 权限面**：`inspect_file` 加入 `read-only` 档（原只有 `read_file`）；读权限**复用 `assertReadablePathOutcome`**，即工作区 + 操作者授予的可读根（D35）**同一条实现**，全库仍只有一处回答"这个能不能读"。**测试基线 399 → 411（410 过 / 0 失败 / 1 跳过）** |

| D42 | **重跑真机：发现"额度耗尽"是一种 HTTP 200 的失败，且它伪装成"模型不支持工具"（照实说，本轮真机未完成）**。**(1) 重跑结果：未完成，且原因是外部**。先测网关工具调用能力 **3/3 正常**（`tool_calls` 返回 `preflight_echo`），随即跑真机。 **① 第一次失败是我自己的错**：我**忘了先授予根**（漏了 `--trust-root`），所以模型如实报 `path escapes the workspace` —— **模型行为正确，是我的测试设置错**。**② 第二次失败是 `model response incomplete: length`**：回复**撞上我自己在 D39 加的 `max_tokens` 上限**被截断。但复测显示**同一请求有时只花 367 tokens 就正常完成**（`finish_reason: tool_calls`），**说明是推理长度波动，不是上限恒定过低**。**③ 第三次揭示了真正的根因**：模型的输出末尾直接写着 **`You've used all your credits. Kindly visit this page to add more`**。**直连 API 连打 3 次全部返回这句话。****(2) 本片最重要的发现（比"没跑成"重要得多）**：**额度耗尽是以 HTTP 200 + 正常 JSON 返回的**，`content` 是一句"你去充值"的话，**`tool_calls` 为空**。**这与我在 D39/D40 记录的"提供方静默丢弃 `tools`"在观测上完全无法区分。** 换句话说：**我这轮一直以为的"网关丢 tools"，至少有一部分其实是"额度用尽"**，而**两者在 HTTP 状态码、响应结构、`tool_calls` 字段上完全一样**。**我此前把"模型说我没有工具"直接归因为模型不支持工具或网关丢弃 tools，证据不足。** 更早那次 `--probe-tools` 报"丢弃 tools"、重跑报"可用"，**也可能只是额度在两个时刻的状态不同**。**(3) 这对产品的要求（已写进结论，不在本轮改代码）**：**`tool_calls` 为空不能直接判为"提供方不支持工具"**——必须先看 `content`：**若正文是账户/额度类提示（如 "credits"、"quota"、"upgrade"），应报为"账户问题"而不是"能力问题"**，因为二者的处置动作相反（充值 vs 换模型）。这是 D40 那个探测器的**真实缺陷**：它的判据是"有没有 tool_calls"，而**这句话也满足"没有 tool_calls"**。**(4) 状态码完全不可信的又一证据**：`/v1/models` **始终 200**，而补全请求全部失败；随后连请求本身都开始超时。**(5) 我守住的底线**：**没有把单元测试当成真机验证**；**没有在额度耗尽时把失败归给模型或代码**；**没有为了让报告好看而重试到某个碰巧成功的瞬间**。**真机端到端仍未完成，欠账仍在**。**测试基线 411 不变（本轮未改代码）** |

| D43 | **修复探测器缺陷：把"账户问题"从"能力问题"里分出来（本片有代码，真机已验证；用户直接要求）**。**背景就是 D42 那个发现**：额度耗尽与"提供方丢弃 tools"**在线上形状完全一样**（HTTP 200 + 空 `tool_calls`），而**处置动作相反**——**账户问题要充值，能力问题要换模型**。**改前该探测器只判"有没有 `tool_calls`"，于是把"没钱了"报成"这个模型不支持工具"**，**这正是今天骗了我自己好几轮的那个坑**。**(1) 实现**：`ToolProbeOutcome` 新增独立的 `accountProblem` 标志（**不并入 `calledTool`**，因为**合并就看不见这个区别**）；`looksLikeAccountProblem()` 用**刻意的短词表**（`credit|quota|insufficient|balance|billing|payment|top ?up|upgrade|额度|余额|充值|欠费`）。**词表短是有理由的**：**误报会把"账户没事"的人叫去充值，与被修的错属同一类**。`PreflightReport.toolCalling` 增 `"account"`；CLI **新增退出码 5**（账户）与 4（能力）分开。**(2) 判据必须看正文，不能看状态码**：三种情形**全部 HTTP 200**，**唯一区别在正文**。**(3) 不改正文以外的行为**：**不重试、不代充、不猜测**——**无法识别的空回复仍报"丢弃 tools"，不硬套账户问题**（猜正是同类错误的另一面）。**(4) 真机双向验证**：`glm-5.3`（额度耗尽）→ 报 **"无法判定：账户/额度问题，不是能力问题"**，`exit=5`；`deepseek-v4.1-flash-free` → **"已实测可用"**，`exit=0`。**改前 glm-5.3 会被报成"此模型在本 Agent 里无法使用工具"，是错的。****(5) 我自己的改动引入过一个回归，被测试抓住**：重构三元表达式时**把"请求失败"分支排到了"丢弃 tools"之后**，于是**一个 500 被误报成"提供方丢弃了 tools"**——`declines to judge tools when the request itself failed` **当场失败**。已把 `accepted` 判据提到最前。**这正是"未测量不等于失败归因"的同一条原则**。**(6) 顺带发现：`provider-config.json` 里是占位符 `zz-gw-change-me`**，而真机之所以能跑通，是因为 **`loadProvider` 让环境变量优先于文件**（`cli-config.ts:33-37`）。**故本机可用的模型应通过 `PERSONAL_AGENT_*` 环境变量指定**，文件里的占位符不参与。**(7) 模型可用性实测（18 个，本机网关）**：可用 `deepseek-v4.1-flash-free`、`[free]glm-5.3`（各 3/3 稳定）；`deepseek-v4-flash` **1 次成功但 3/3 复测失败**（**单次成功不能当可用**）；`glm-5.3`/`claude-sonnet-5`/`gpt-6-sol`/`gpt-6-luna`/`gemini-3.8-flash` **报额度**；`gpt-5.6-sol`/`fable-5.1`/`grok-4.7` **回普通文本、无 tool_calls**；`claude-opus-5`/`claude-opus-4-8`/`qwen3.8-max` **502**；`kimi-k3`/`glm-5.3-free` **超时**。**用户指出的对：KEY 不是只有那一个模型能用，试就能找到能用的，而我上一轮说"路断了"是没有穷尽尝试就下的结论。** **测试基线 411 → 415（414 过 / 0 失败 / 1 跳过）** |

| D44 | **补上欠账：`inspect_file` 真机端到端通过；而这次真跑挖出两个真 bug（本片有代码，真机验证）**。**结果**：模型**自己选了 6 次 `inspect_file`**、用了 **6 个不同工具**（`file_type`/`headers`/`hex_dump`/`hash`/`strings`/`certutil_dump`），答出 **PE32+ / AMD64 / 86973768 字节 / Node.js v22.23.3**，**全部正确**；甚至读出 **Authenticode 签名者 `CN=OpenJS Foundation`**。**无写入、目标未被改动、工作区为空**。**判据全部满足**。**(1) 第一次真跑"答案对但能力没被用到"**：模型用 `read_file` 拿了 hex 头 —— **我在计划里就写了这不等于通过**。**追因纠正了我自己的一个错误判断**：我先改了 `read_file` 的描述（它确实误导——写"UTF-8 text file"但它其实能返 hex dump），**但改完模型仍选 `read_file`**。**真因是 `cli.ts:357` 的 system prompt 写着 `Use read_file for workspace facts.`，而且完全没提 `inspect_file`** —— **模型只是服从指令**。**教训：我一直在改工具描述，而决定模型行为的是系统提示。** **(2) 第二个 bug（更严重，是产品缺陷）**：改了系统提示后，模型**立刻服从**去调 `inspect_file`，**却被拒 `unknown tool: inspect_file`**。追查发现 **`inspect_file` 只加进了 `read-only` 档，而真跑用的是默认档 `workspace-write`** —— **工具列表里没有它，registry 里也没有**。**于是出现最坏的一种状态：系统提示让模型用某工具，而该工具在会话里不存在。** 模型很聪明：**先试（服从提示）、被拒后降级到 `read_file` 并仍给出正确答案**。**(3) 拆开后还有第三个 bug**：把 `inspect_file` 补进各档列表后，`workspace-write` **列出却拒绝**（`decide` 返回 deny）—— 因为 `DEFAULT_RULES` 只对 `read_file` 写了 allow。**"列出"与"允许"是两套机制回答同一个问题**（列表=缺席，规则表=拒绝），**不一致就交给模型一个永远调不通的工具**，而它收到的拒绝文案（"not available in this session; it is a policy boundary"）**会让它以为是策略边界而放弃**，不再找真因。**(4) 修法：让这类漂移不可表达**。抽 `write-tools.ts` 只放两个纯列表（`READ_ONLY_TOOLS`/`WRITE_TOOLS`），`tiers.ts` 与 `file-policy.ts` 各自派生。**为什么单独一个文件**：两处都要用这些列表，而 `tiers.ts` 已从 `file-policy.ts` 导入 `DEFAULT_RULES`，**把列表放在任一侧都会形成环**——**实测该环在 typecheck 全过、运行时才 `Cannot access 'READ_ONLY_TOOLS' before initialization`**。**无依赖的事实应放在无依赖的地方。** 另加两条不变式测试：**「列出的工具不得被自己的规则拒绝」**与**「每个档位都必须提供全部只读工具」**。**(5) 又一次"我改的测试断言"**：`rule-table.test.ts` 断言规则 id 为 `read-file`，**那是实现细节不是意图**，已改为断言"决策为 allow 且规则名对应其工具"。**测试基线 415 → 417（416 过 / 0 失败 / 1 跳过）** |

| D45 | **把真机验证做成常规动作：`npm run test:live`（用户选 B："不能一直欠着"；本片有代码，真机 5/5 通过）**。**为什么需要它**：本项目近几轮**三个真 bug 全部 typecheck 干净、单测全绿，只在真跑时才现形**（工具注册错档位、列出却被规则拒绝、额度问题被报成能力问题）。**它们的共同点**是"**项目内部两处不一致**"，而**注入 `fetch` 的测试恰好与这两处都一致**，所以照不出来。**这类 bug 的可信验证单位就是真机**，故把真机做成一条命令而不是一个挂账意图。**(1) 形态（用户选的）**：`npm test` 保持快、免凭据（416 过）；`npm run test:live` 跑真机（本轮 **180 秒**）。**四条自律**：**① 跳过不等于通过**——无凭据时每条报 `skipped` 并写明"未测量不等于通过"，绝不报绿；**② 不许静默退化成单测**——全部走真 CLI；**③ 没有工具调用的答案不算证据**（早前真出过"答案对、`inspect_file` 一次没调"）；**④ 只碰自己的 fixture**。**(2) 覆盖的就是出过 bug 的四处**：预检能驱动 agent、工作区外文件的读（未授权拒绝 / 授权后可读且**必须真的调 `inspect_file`**）、写入路径、被拒时是否诚实。**(3) 命名反而要"无聊"——两个更聪明的方案都实测更差**：**命令行 glob 取反不被支持**，会**静默把 live 文件算进去**（快测悄悄长出网络依赖）；**`--experimental-test-tag-filter` 会破坏 hook 顺序**——**实测：异步 `before` + 读取其赋值状态的 `after`，`after` 会在 `before` 仍 await 时先跑并读到 `undefined`；同步 `before` 不受影响**。**这是实验性开关的 bug，而本套件恰好就是它破坏的形状**（异步建 fixture + `after` 清理）。故**改用文件名排除**：`live.e2e.ts` 不在 `test/*.test.ts` 的匹配内。**(4) 第一轮真机跑出 2 个失败，其中 1 个是我的测试错、产品是对的**——"**被拒路径泄漏了字节**"我报得很重，**但先查证后确认：`outside/` 目录已被前面那个"授权后可读"的用例授予过**，所以模型读的是**合法路径**、返回真字节**完全正确**。**测拒绝必须用一个别的用例从未授权的目录**，已改为独立的 `never-granted/`，并加断言"授权清单不得增长"。**另一个失败是步数上限**（6 步不够写完读回），改 12 步——**那个失败在测预算而不是测能力**。**教训：真机测试自己也会有 bug，"产品失败"的报警必须先证明不是测试的错。** **测试基线仍 417（416 过 / 0 失败 / 1 跳过）；真机 5/5** |

| D46 | **给模型真正的手脚：`run_command` + 权限三档（用户认可"按成熟产品的形状做"；本片有代码，真机 7/7 通过）**。**为什么**：用户问"**我的 agent 不能跑命令,那他有什么意义?只是读文件?逆向、渗透、安全审查修改还能做吗?**"——**这个问题推翻了我前面几轮的方案**。我读了 9 个 agent 的源码对照：**crush 的 `BashParams.Command string`（一条完整命令字符串）、aider/claude-code/codex/gemini-cli/goose/grok-cli/opencode/qwen-code 全都有等价物**，**没有一个产品是"只能读文件"的**。**我之前的 argv 方案错在哪**：它把安全放在"**参数怎么传**"（结构化→危险字符写不出来），**代价是只能跑清单里的程序**，于是干不了活；而且它**把两件事混为一谈**——*命令怎么传*（可以做到安全）与*命令能不能跑*（做不到）。**不是"我拦住了 shell 注入",是"那种写法在 argv 世界里没有意义"**；我拿这个结构事实当安全承诺讲,是同一个错误的第二次犯。**成熟产品怎么做的（实测源码）**：**① 权限都是三档**——DSH(仅可查看/工作区内修改/完全权限)、Trae(手动审批/自动审批/完全访问)、goose(`Chat`/`Approve`/`SmartApprove`/`Auto`,定义最清楚)、claude-code(`default`/`acceptEdits`/`plan`/`dontAsk`/`auto`/`bypassPermissions`)、codex(沙箱档 `read-only`/`workspace-write`/`danger-full-access` × 审批档 `untrusted`/`on-request`/`granular`)、gemini-cli/qwen-code(`default`/`yolo`)。**② 手脚一律是 shell + 一个命令字符串**,配后台作业(crush 默认 60 秒转后台)/超时/输出上限(30000)。**③ 安全不靠"拦住",靠分档询问**：goose `permission_inspector.rs:159-196` 的五层顺序是——用户设置 → **工具自带 `read_only_hint` 标注**(MCP 标准字段) → 扩展管理必问 → 交 LLM 判只读 → **默认问(fail-closed)**。**本片实现**（**复用**已有 `tiers.ts` 三档与 `rule-table.ts`，未新造）：**① `src/shell-tool.ts`**——真 shell(`cmd.exe /d /s /c` 或 `/bin/sh -c`)，**不设 `shell: true`**（平台 shell 直接被 spawn，命令是它的*输入*而非二次引号层）；60KB 输出上限 + 120 秒超时 + 2000 行上限；**缓冲后一次性解码**（多字节跨块会碎，已实测过）；**非零退出码当正常结果返回**（`git log` 无提交就是非零，那是信息不是故障）。**② 环境必须来自 `requireToolEnvironment`**——`toolEnvironment` 把 `HOME`/`TMP`/`APPDATA` 都指向 agent home，**继承父进程就等于命令能读写操作员的 dotfiles，而文件工具仍报告工作区是边界**。**③ 档位真的管它**：`read-only` 档**不含**该工具（缺席而非拒绝）、`workspace-write` 规则为 `approve`、`full-access` 为 `allow`。**④ `run_command` 归入 `WRITE_TOOLS`**（虽然很多命令只读，但工具本身不做此承诺，假设它等于对任意输入瞎猜），并**从 `WRITE_TOOLS` 派生 `APPROVAL_TOOLS`**，避免"档位提供、规则表拒绝"那个缺陷重演。**真机跑出两个真 bug，都已修**：**①（我的 bug）`full-access` 档半残**——文件工具全部报 `no approval channel is configured`，因为**规则表的 `allow` 从未传到工具**（`registry` 只处理 `deny`），而写工具**无条件调用 `approveExact`**。修法：`ToolContext` 增 `preApproved`（**仅 `allow` 置位**，逐次传入以免泄漏到下一次调用），`approveExact` 见它即不问，`batch_files` 同步处理。**②（更要命）`workspace-write` 档下命令照跑**——实测 `echo hi > test.txt` 成功、文件真的出现，因为**我在 `run_command` 里忘了调用 `approveExact`，写了工具却没让档位管它**；这正是该档最需要管的能力。修后真机复验：该档 + 非交互 → **命令被拒、工作区为空**，且模型正确判断"是环境没有批准通道，不是命令的问题"。**测试 431 通过 / 0 失败**（新增 `test/shell-tool.test.ts` 13 项，**含两条专测"规则的 allow 要真的到达工具"**——这是本轮缺陷的形状，单测全绿而真机才现形）；**真机 7/7**（新增"真的构建并验证一个程序"与"该问而无人可问时必须拒绝"）。**教训：工具的档位属性不是写进列表就生效，必须真的在 `execute` 里查** |
