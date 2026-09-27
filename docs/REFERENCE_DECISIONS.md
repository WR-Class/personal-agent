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

代码复制前另核对目标文件许可证、归属/NOTICE 与修改记录；本轮只借鉴机制，没有复制第三方实现。
