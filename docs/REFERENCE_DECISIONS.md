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

代码复制前另核对目标文件许可证、归属/NOTICE 与修改记录；本轮只借鉴机制，没有复制第三方实现。
