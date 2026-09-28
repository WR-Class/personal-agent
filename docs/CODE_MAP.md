# 当前代码地图

更新：2026-09-25，M1 协议与硬字节边界首批后。当前阶段统一见 [STATUS](STATUS.md)。使用文件/符号定位，不再将最初审查行号冒充当前代码位置。

## 1. 项目边界与目录

- `src/`：16 个 TypeScript ESM 模块，Node 直接运行。
- `test/`：13 个 .test.ts + `fixtures.ts` 与 `server-fixture.ts` 两个 helper。
- `scripts/show-tool-environment.mjs`：显示环境字典的诊断脚本，不是进程隔离验证。
- `.personal-agent/`：默认会话、Provider 配置和 scratch；独立于 DSH home。
- `.test-artifacts/`：保留的独占测试目录/归属标记；不自动递归清理。
- `../_research/`：参考快照；`../restore/`：历史恢复材料；均非运行依赖，不执行其中脚本。
- package 是 private 源码运行应用，build=tsc --noEmit，无 bin/main/发行 JS；没有生产 npm 依赖。

## 2. 源码模块

| 文件/符号 | 当前职责 | 边界/未实现 |
|---|---|---|
| [cli.ts](../src/cli.ts)：parseArgs/main | --help/--echo/参数校验、单次或交互入口、组装依赖、活动显示、预算标志与环境变量、`--mint-gene <file>` 从 JSON 草稿铸造基因入库（不需要模型）、`--distill` 打印蒸馏出的 guard 草稿、`--induct` 打印归纳出的候选草稿（都只读，不自动铸造） | 不是 UI 框架；无 prompt 时进入交互；基因库在 `<home>/genes.jsonl`，周期账本在 `<home>/cycles.jsonl`；`--distill`、`--induct`、`--mint-gene` 三者互斥 |
| [config.ts](../src/config.ts)：loadAgentConfig/parseAgentConfig/configRules/wideningRules/configPath | **操作员配置（D26 主体）**：`<agentHome>/config.json` 设默认档位与规则；`{"version":1,"tier":"…","rules":[{"tool","decision","reason?","priority?"}]}`。**只读 agent home，绝不发现工作区里的任何配置文件**（gemini-cli 读工作区配置再靠 `isTrusted` 丢弃；本项目连读都不读——门控依赖信任状态正确，不读则不依赖任何状态）。损坏/未知键/未知档位名**一律报错**，不静默当空（同 `trust.json` 的理由：配置是用来放宽的，"读成空"与"仍然受限"无法区分） | **两条自我提权路径按结构封死，不靠检查**：**(1) `tier` 不是配置字段**——`configRules` 把每条规则钉死在 `RULE_TIERS.WORKSPACE`，代码里没有让调用方改层的参数；配置里出现 `tier` 键直接报错（`RULE_TIERS` 中高层永远压过低层，若配置能自选层号就能压过所选档位与 `full-access` 的审计记录）。**(2) `when` 不是配置字段**——`Rule.when` 是函数，从 JSON 造函数只有 `eval`/`new Function`，等于配置文件即代码执行；故**配置规则只能按工具名匹配，不能按参数内容匹配**（代价如实说：无法表达"只放行 `git status`"）。**选 WORKSPACE 层是承重的**：它低于 `read-only` 钉在 USER 层的 deny-every-write、低于 `full-access` 钉在 ADMIN 层的 allow-all，故配置压不过姿态自己的边界；同层内大 priority 胜出，所以层号不能用 priority 代替。**配置放宽必须落审计**：`wideningRules` 用 `decide()` 问姿态本来怎么判（**不自己重写匹配逻辑**——第一版按工具名建集合，漏了 `tool:"*"`，把 full-access 误报成被放宽），凡把"要问"变成"不问"的，逐条 `appendAudit` 写 `rule:"config:widen"`、`decision:"allowed"`，并把操作员自己的 `reason` 带进去。**配置加不回工具**：它只到规则表，碰不到注册表，`read-only` 缺席的工具仍然缺席 |
| [cli-config.ts](../src/cli-config.ts)：providerConfig/loadProvider/saveProvider/configureProvider | HTTP(S)配置校验、向导、显式密钥保存、wx配置创建 | 不是凭据库；已有文件不自动覆盖；环境配置必须三项完整 |
| [terminal.ts](../src/terminal.ts)：TerminalIO/createTerminal/safeText | 可注入终端输入、隐藏输入、防预输入、控制字符转义、队列/EOF | 实体TTY行为未全覆盖；不做逐token渲染 |
| [interactive.ts](../src/interactive.ts)：runInteractive/listSessions | 连续对话、new/resume/history/status、inspect/recover、Ctrl+C | 会话切换仍需用户确认当前 workspace/Provider |
| [runtime.ts](../src/runtime.ts)：AgentRuntime.send/sendTurn/runToolCalls/compact/formatBudget | 持锁整轮、预检查、`sendTurn` 在写任何日志前生成 TaskSpec（可 `enforceTaskSpec` 硬拒，默认关）、基因选择（TaskSpec 的 intent/信号喂 GeneStore.selectFor，选中块注入系统提示=测试时进化）、**每轮一个 PDRI 周期**（用户轮落盘后才开周期，故拒绝不留痕；execute-start → 模型工具循环 → review-ready(机械评估) → integrate-ready → complete；任何异常都发 fail 收口并记 outcome）、可选周期账本、模型工具循环（统计工具错误数供评估）、activity、取消关联补齐、预算（模型调用/每步工具/整轮工具/整轮deadline/prompt字节/input token/按模型窗口/可选本机tokenizer）、每次send生成runId、`compact()` 生成并记录摘要边界、`RunBudget` 报告已用与上限 | 默认10步、每步8次、整轮32次、deadline 300000ms、prompt 524288字节、input 131072 tokens；deadline送达adapter但无法强杀忽略signal的进程内代码；字节上限不是token计数；token上限优先取本机tokenizer计数（需宿主注入，不内置分词器），否则取provider实测值因此首轮无测量；按模型窗口只作用于token上限，不派生出字节上限；outcome 记账失败会让该轮报错（库是进化的账本，不静默丢行）；失败归因只按本模块错误类/abort/适配器消息前缀，其余归 unknown（D14/D15） |
| [types.ts](../src/types.ts)：ChatMessage/ModelAdapter/ToolCall | TypeScript协议接口；`ChatUsage.reasoningTokens` 为 provider 上报的子集标记；`ChatResponse.reasoning` **刻意不放在 ChatMessage 上**，使"推理不落盘、不回传"成为类型形状的性质 | ChatMessage 仍非角色判别联合；类型不等于运行时校验；无流式接口 |
| [response-validation.ts](../src/response-validation.ts)：record/tokenCount/validateResponse | 响应形状、非负安全整数用量、本批唯一非空调用ID；可选的 `reasoning` 字符串与 `reasoningTokens` 同样只做畸形拒绝 | 缺失用量仍可映射0；不解释工具参数（由tools在分发前校验）；**不校验** reasoningTokens 是否真是输出子集 |
| [openai-adapter.ts](../src/openai-adapter.ts)：createOpenAIChatAdapter/parseSseCompletion/CHAT_RESPONSE_MAX_BYTES/DEFAULT_MAX_TOKENS | chat/completions、function wire映射、timeout/abort、结构校验、响应体1MiB硬上限、`reasoning_content` 与 `completion_tokens_details.reasoning_tokens` 解析（缺失即缺失，非字符串拒绝）；`stream:true` 时把 SSE 分片组装回同形状 payload 并复用后续全部校验；**每次请求都发 `max_tokens`**（D39，默认 8192、可覆盖：本项目在预算/字节/期限上的一致规则是"调用方声明上限"，且它原本**完全缺失**该字段） | 非增量读取（整段受1MiB约束后才解析）；无重试；上限按字节实收计数，不信任content-length；本机socket与真实端点（含流式工具往返）已联调；其它推理字段命名未适配。**实测警告（D39）**：部分提供方**静默丢弃 `tools` 并回纯文本**（HTTP 200，`tool_calls` 为空）——`deepseek-v4.1-flash`/`gpt-6-sol` 实测如此，表现为模型反复说 `function call failed, not handled`（该串在本仓库源码零命中，是网关合成话术）；**故 200 ≠ 工具可用**，预检需分开探测"推理可用性"与"工具可调用性" |
| [bounded-read.ts](../src/bounded-read.ts)：readBoundedUtf8 | 唯一的字节上限文本读取：按实收字节计数，超限中断并关闭底层流 | 只做上限与解码；不解码流式增量、不做内容类型判断 |
| [echo-adapter.ts](../src/echo-adapter.ts)：createEchoAdapter/createScriptedAdapter | 离线回显/确定性脚本测试 | Echo不是大模型、不自主调用工具 |
| [security-config.ts](../src/security-config.ts)：canonicalPath/resolveRuntimePaths/assertReadablePath/isWithin/configuredContextWindows | native真实路径、缺失叶子祖先、保护根、敏感路径规则、唯一的包含判定 `isWithin`、按模型窗口环境解析 | 命名策略非DLP；不消除本地并发替换竞态 |
| [tool-environment.ts](../src/tool-environment.ts)：buildToolEnvironment/isIssuedToolEnvironment | 白名单env、派生home/temp/config路径校验、冻结发行对象 | 合作Context非OS sandbox；不可信进程内代码可忽略 |
| [tools.ts](../src/tools.ts)：Tool/ToolRegistry/各工具工厂 | 工具表与**唯一**从模型调用到副作用的通路；`Tool.readOnly` 是宿主可信声明；`ToolRegistry(available?)` 可构造**会话级能力集合**，`has()` 查询、`definitions()` 过滤、`execute()` 前置拒绝——**缺席在两个方向一致强制**（不在提示词里暴露，且按名字也调不到）；拒绝文案标明是**常驻策略边界而非瞬时失败**（"not available in this session … policy boundary, not a transient failure"），避免模型重试或绕路；构造时校验 available 项必须已注册；**写入前的三重把关**：`sameFile`（路径仍解析到同一处）→ **`unchangedSinceApproval`（内容指纹未变，`contentStamp`＝sha256）** → 写入；`edit_file`/`patch_file`/`delete_file` 走内容校验，`create_file` 靠 `flag:"wx"` 由操作系统原子拒绝，`rename_file` 不校验内容（其提示不展示内容，批准的是路径） | 能力集合只回答"本会话有没有这个工具"，**不授权副作用**——副作用仍由既有审批门把关（两者是独立轴，已用测试固化）；注册表本身仍不查权限。**内容校验是 TOCTOU 窗口收窄、不是消除**：校验与 `rename` 之间仍有极短窗口，本项目无沙箱无文件锁，**不宣称原子性**；**绑定尚不含 cwd 与环境哈希**。**D46/D47 新增三个工具工厂**：`createRunCommandTool`（先查档位批准、再取 `toolEnvironment`、最后交给 `shell-tool.ts`）、`createJobOutputTool`（只读，无 `job_id` 时列出全部作业）、`createJobKillTool`（走审批，与启动同级）。**`ToolContext.preApproved` 只由规则表的 `allow` 置位**，`approveExact` 见其立即返回——这是修一个真 bug 的机制：`full-access` 档曾全体文件工具报"没有批准通道"，因为**注册表只对 `deny` 行动、`allow` 从未传到工具**，而写工具无条件调 `approveExact`。**`run_command` 的批准在取环境之前**：档位是策略问题，环境是能力问题，先答策略才不会因为环境缺失而掩盖"这一档根本不许跑" |
| [write-tools.ts](../src/write-tools.ts)：READ_ONLY_TOOLS/WRITE_TOOLS | **读/写分类的唯一来源**（D46 抽出）：`READ_ONLY_TOOLS`＝`read_file`/`inspect_file`/`job_output`，`WRITE_TOOLS`＝`run_command`/`job_kill`/六个文件工具。**档位（`tiers.ts`）与规则表（`file-policy.ts` 的 `APPROVAL_TOOLS`）都从这里派生**，而不是各自再列一遍名字 | **为什么必须单一来源**：曾出现"某工具被档位提供、却被规则表拒绝"的缺陷——模型拿到一个永远调不通的工具（`inspect_file` 事件）。派生而非重述使两个答案不可能漂移（有测试循环断言）。**`run_command` 归入写入类**，即使多数命令只读：工具本身不做只读承诺，按输入猜是假事实；代价是刻意的——不提供它的档位就真的没有它。**`job_output` 归入只读**：读一个作业的输出不改变任何状态，且该作业当初已被批准启动，故每档都提供它（`read-only` 档也能看后台作业产出） |
| [tiers.ts](../src/tiers.ts)：TIERS/resolveTier/findTier/isReadOnlyCommand | **四个**具名档位：`read-only`／**`ask-before-writing`（D48 新增中间档）**／`workspace-write`（默认、对陌生人安全）／`full-access`（标 `removesBoundary`）；每档显式给出**工具集合（缺席而非拒绝）＋规则表**；`resolveTier` 对**未知名字报错而不回落**（回落会因拼写错误静默改变姿态，回落到宽松档＝因错别字发放全权）。**中间档的只读命令判定**：查保守白名单（命令名 + 子命令 + 标志），**未识别一律要问**；含 `>` `\|` `&` `;` 或换行一律要问；解释器只放行**精确版本查询形式**（`node --version`，多一个参数即不算）。**准入准则**：一个工具能进白名单，当且仅当**它自己的标志、以及它读取的任何项目本地配置，都不能导致它执行另一个程序** | **档位无法放宽不变量**——路径收敛与能力集合不是规则，本模块只能选权限决策（有测试断言）；**`full-access` 只是"不再问"，不是"没有边界"**：路径收敛、写预算、漂移检测、审计照常生效；**已接到 CLI**（`--tier`／`PERSONAL_AGENT_TIER`，`cli.ts` 按档位工具列表构造 `ToolRegistry` 与规则表）。**中间档刻意不调模型判定只读**（goose `SmartApprove` 第④层要额外一次 provider 往返；本项目工具全是内置的，只读与否是代码里的静态事实，把已知事实拿去猜只增加延迟与失败点）；**判定错的方向是可控的**：漏判＝多问一次，误判＝没人批准的写入，故一切存疑归"问"。**`git` 整族不在白名单，且这是修掉一个已发布漏洞的结果**：曾按子命令放行 `git status`/`log`/`diff`，但**实测仓库自带的 `core.fsmonitor` 会在 `git status` 时执行任意命令**（另有 `core.pager`/`diff.*.textconv`）；`GIT_CONFIG_NOSYSTEM` 只关系统级配置、关不掉仓库级，而逐键 `git -c` 覆盖等于重犯本项目已失败两次的"枚举危险项"。**`rg`（`--pre` 执行外部命令，本机未装无法核实）与 `npm ls`（读项目 `.npmrc`，未验证）同因移出**。回归测试走完整链路并带反证（先在 `full-access` 下证明投毒仓库真会执行，再断言中间档下不执行）。**彻底恢复 git 免问需要 D26（仓库配置不得自我提权）落地，而 D26 尚未实现** |
| [shell-tool.ts](../src/shell-tool.ts)：runShellCommand/shellFor/SHELL_MAX_OUTPUT_BYTES | **D46 给模型的"手脚"**：一条命令字符串经**平台 shell**（win32→`cmd.exe /d /s /c`，否则 `/bin/sh -c`）执行；`spawn` **不设 `shell:true`**，故命令文本是 shell 的**输入**而非第二层引号；缓冲后**一次性解码**（多字节字符跨 chunk 会被逐块解码搞坏，仅在读出 `\uFFFD` 时才试 GBK）；上限 64KB／2000 行／120 秒，超限追加 `[output truncated …]`；**非零退出码作为普通结果返回**（`[exit code: N]`），不是 `isError` | **不做安全过滤**：shell 的价值就是能跑任何东西，"让危险无法表达"做不到（此前三轮试过 argv 方案，结果只能跑固定清单，等于没有手脚）。**安全全部交给档位**：`read-only` 不含此工具／`workspace-write` 逐次问／`ask-before-writing` 只读命令免问／`full-access` 不问。**环境必须由 `toolEnvironment` 提供**，否则子进程继承操作员的 `HOME`，命令能读写其 dotfiles 而文件工具仍报"工作区是边界"。**Windows 特有**：`cmd.exe` 会为命令派生子进程，故杀进程必须杀树（见 background-jobs.ts） |
| [background-jobs.ts](../src/background-jobs.ts)：startBackgroundJob/readJobOutput/killJob/shutdownJobs/prepareSpillDirectory | **D47 让长命令活下去**：`run_in_background` 立即返回 job id；输出**落盘**到 `<agentHome>/shell-output`（不是共享临时目录：两个会话不得互读），读时**只返回尾部并明说省略了多少字节**；落盘目录按 **7 天 / 256MB** 自动清理，**只删本模块自己命名的文件**；`shutdownJobs` 在 agent 退出时停掉所有作业并报告条数（**用户明确选择"退出即清理"**，因为活过退出的作业是隐形的）；`killTree` 在 Windows 用 `taskkill /PID <pid> /T /F` | **子进程刻意不 `detached`**：脱离会让清理依赖"能否再找到它"而非父子关系。**真机抓出的真 bug**：首版 `job_kill` 只 `child.kill()`，而作业进程是 `cmd.exe`、真正的命令是**它的子进程**，于是**工具报"已停止"而作业继续写磁盘**（实测 135→175 字节）；`taskkill /T /F` 修复。**crush 的 POSIX 做法（`Setsid` + 负 pid）在 Windows 不可用**：实测 `kill(-pid)` 抛 `ESRCH`，且 crush 自己的 `exec_windows.go` 也未做等价处理。**未覆盖**：agent 被强杀（`SIGKILL`）时的残留未测；非 Windows 走 `child.kill()` 但未在真机验证。**无沙箱**：后台命令在操作者视野外执行，可记录/可读/可停，但**不能假设它只做了被要求的事** |
| [trusted-roots.ts](../src/trusted-roots.ts)：readTrustedRoots/grantReadableRoot/revokeReadableRoot/checkReadable | **工作区外附加只读根**（D35），存 `<agentHome>/trust.json`（**不在工作区**：仓库里的信任文件是攻击者可控的，克隆恶意仓库即自带授权）；`grantReadableRoot` **拒绝文件系统根**；损坏的信任文件**报错而非读成空**（"读成空"与"仍然受限"无法区分，而该文件正是用来放宽读的） | **只放宽读**：`checkReadable` 只被 `read_file` 走过（`tools.ts` 的 `assertReadablePathOutcome`），写工具直接调 `assertReadablePath`，故授予后写仍以 `path escapes the workspace` 拒绝。附加根内**仍套用** `sensitivePathName`；`protectedRoots()` 的宽泛宿主树（`%LOCALAPPDATA%` 等）**刻意不套用**，否则几乎任何可授予目录都会被拒（曾因此误拒，被探针查出）；**每一步重读、不缓存整会话** |
| [rule-table.ts](../src/rule-table.ts)：decide/effectivePriority/RULE_TIERS | 单一优先级规则表：规则 = `id`/`tool`（含 `*`）/`decision`/`tier`/`priority`/可选 `when(args)`/`reason`；**有效优先级 = `tier + clamp(priority,0,999)/1000`**，**排序一次、首个匹配者胜出**，**无匹配即 deny**，**谓词抛异常即不匹配**（fail-closed），返回 `{decision, rule, reason}` 以便归因 | **只管决策**：路径收敛（不变量）、写预算（计数器）、能力集合（会话属性，运行在前）**刻意留在表外**——建模成规则会让高优先级规则放宽它们。**`priority` 上限 999 是为保证任何优先级都无法跨 tier**；**同档内允许规则必须排在通配拒绝之上，否则通配会把允许一起吞掉**（`read-only` 曾因此实际变成"什么都不读"）；尚无配置加载与用户自定义规则 |
| [file-policy.ts](../src/file-policy.ts)：filePolicy/actionBinding/DEFAULT_RULES | `DEFAULT_RULES` **逐字复现**原写死判定（`read_file`→allow、六个文件工具→approve、其余→deny），`filePolicy(tool, rules?)` 委托给规则表；`actionBinding(tool,args)`＝`sha256(canonicalize({tool,args}))`，把"同一个动作"定义为**内容哈希**而非参数字符串（键序/空白无关，任一值变化即不同，**工具名进哈希**故跨工具不共享） | 不检查路径；路径仍由各工具调用 `assertReadablePath`。**绑定只含动作参数**：不含 cwd、环境哈希、目标文件当前内容，故**不等于** OpenClaw 的完整绑定；`canonicalize` 复用 `gene.ts`，全库只有一份稳定序列化 |
| [taskspec.ts](../src/taskspec.ts)：buildTaskSpec/assessTaskSpec/extractSignals | 每次发送前生成带版本的确定性 TaskSpec（schema 2）：原输入、目标、关键词意图、请求信号、运行时模式；缺目标记 unknown、不编造模式；强制拒绝是独立开关、默认关闭；信号=词元 + **中文二元组**（中文无词边界，整句不再当信号） | 关键词意图是分类不是权威；spec 只随 `SendResult` 返回，不写会话日志（D12）；信号是词表匹配，不是语义理解（D14/D16） |
| [gene.ts](../src/gene.ts)：mintGene/canonicalize/geneAddress/selectGene | 基因 = sha256 内容寻址的不可变紧凑经验 {name, intent, signals_match, preconditions, strategy(guard/act/verify/rollback), constraints, **validation（结构化声明）**, avoid}；铸造过结构不变量（行动必有验证步、预算为正、validation 非空且解析为声明——裸字符串归一化为 `command`）；选择：intent 门控 → 信号重叠（词元 + 中文子串）→ 拉普拉斯平滑成功率 → 新近度（只认最后一次成功）→ 连续失败隔离；零重叠排除；导出 `GeneDraft` 供调用方用裸字符串写 validation | 基因只被取代不被编辑；**地址是内容地址**：改一个字即变成另一个地址，旧字符串 validation 归一化后地址随之变化（可接受的一次性迁移）；constraints 由执行层机械强制且不注入提示（D18）；`unverifiable` 的 command 声明在 M3 前不构成证明（D14/D15/D20） |
| [gene-store.ts](../src/gene-store.ts)：GeneStore | agent home 内追加式 `genes.jsonl`：状态=对日志的折叠；`AppliedGene` 带 `constraints` 供执行层做本轮写预算（不进提示词）；基因按地址幂等重入；outcome 行（address=null 即无基因基线，含 `status`/`failureClass`/`intent`/`signals`/`evidence`）折出每基因 expression：attempts/successes/lastSuccessAt/streak 与基线计数；`failures()` 读出可分组进蒸馏的失败档案，`geneLessSuccesses()` 读出可归纳的无基因成功轮；截断尾容忍、中段损坏拒绝并报行号 | 追加不是事务；无多写者并发场景（每 agent 独占自己的 home）；损坏尾丢弃是数据损失，但不静默修复；`lastSuccessAt` 只记成功时刻，失败只增 streak（D14/D15） |
| [cycle.ts](../src/cycle.ts)：startCycle/applyEvent/replay/evaluateRun | PDRI 纯状态机：`planned→executing→reviewing→integrating→completed`，异常 `failed/cancelled`；顺序错乱抛错、终点周期拒绝一切事件、**评审 failed/blocked 不得进入整合**；`evaluateRun` 从 steps/toolCalls/toolErrors + 失败类别读出 success/partial/failed/blocked，证据逐条列出，`reviewer: "mechanical"` | 机械评审只回答"这轮跑成了什么样"，不回答"目标是否达成"（因此没有 objectiveSatisfied 字段）；识别不了的失败归 `unknown`，不猜；没有模型自报成功的通道（D15） |
| [distill.ts](../src/distill.ts)：distillGuards/unmintedDrafts/draftAddress | 失败档案→能力草稿的纯函数：按 (intent, 失败类别) 分组、统计信号复发次数、保留 ≥ 阈值（默认 3）者为 `signalsMatch`、产出只含 guard 步的 Gene 草稿 + 机械证据 + 人读摘要；无信号达阈值就不产出；`unmintedDrafts` 去掉已有基因覆盖的同一 (intent, 信号集)；同一份日志永远产出同一草稿（不调模型） | 草稿的 `validation` 故意为空 → `mintGene` 拒绝 → 只有操作者能补上证明并铸造；失败分组键在请求侧而非基因侧；不落原始错误文本，只有机械计数（D16） |
| [induct.ts](../src/induct.ts)：inductGenes/uncoveredCandidates/DEFAULT_CAVEAT | 成功归纳的纯函数：只取无基因的成功轮（用过基因的不是缺口），按 intent 分组、保留复发信号 ≥ 阈值（默认 2）者为 `signalsMatch`，产出候选 Gene 草稿——act 步骤就是转录事实证明用过的工具顺序（最长的一条），附人读摘要与 caveat；`uncoveredCandidates` 去掉已有基因覆盖的同一 (intent, 信号集)；同一份日志永远产出同一草稿 | **不推断 guard/verify**：把意图读进工具序列是模型叙述，D14/D16 禁止；因此不产出策略洞见，只产出"已被证明使用过的工具顺序 + 请求画像"；草稿 `validation` 为空且 act 无 verify → `mintGene` 两次拒绝，操作者必须自己补策略与证明（D17） |
| [validation.ts](../src/validation.ts)：checkClaim/checkValidation/claimsOf/readClaim | 结构化验证声明与轮末比对的纯函数：四种声明（`files-written`/`no-write`/`tool-used`/`command`）逐条对日志事实比对，三态 `met`/`unmet`/`unverifiable`；`files-written` 按集合相等双向比对（少报也算 unmet）；`satisfied` 只在全部 met 时为真；结果渲染成 `validation:<outcome>=<claim> (...)` 证据行 | **三态的核心是 `unverifiable`**：既不算 met（伪造证据）也不算 unmet（惩罚可能确实做了的工作）；无 shell 时 `command` 一律 unverifiable，**明写原因、绝不假装跑过**；不读意图、不做语义匹配、不由模型判定（D20） |
| [write-budget.ts](../src/write-budget.ts)：readWriteAttempt/checkWrite/chargeWrite/budgetFor | 每周期写入门账本（纯函数）：从工具调用析出（路径，行数）；文件按不同路径精确计数；行数只在参数确实携带内容时计数，否则记 `null` **不估算**；目标路径都读不出的写入记匿名名额并照常计入；`budgetFor` 取基因 constraints，无基因时用运行时默认 | 这是**执行层**的机械强制，不是提示词建议（D14：写进提示词的约束只是建议）；只覆盖六个文件工具，**不覆盖 shell 造成的写入**（无 shell）；`maxWriteFiles: 0` 被参数守卫拒绝——"整轮不许写"需要另设计表达方式（D18） |
| [cycle-store.ts](../src/cycle-store.ts)：CycleStore | agent home 内追加式 `cycles.jsonl`：每次事件一行，状态=按 cycleId 对事件日志折叠（`replay`），可重放；损坏尾容忍、中段损坏拒绝并报行号；ENOENT 视为空；未收口周期停在最后阶段而非冒充完成 | 追加不是事务；单进程内 send 串行，暂不产生悬空周期，因此没有定时强制收口；它是运行账本，不是会话事实源（ADR-0001） |
| [session-lease.ts](../src/session-lease.ts)：withSessionLease | wx锁文件、owner token、内部scope复用、核验归属后释放单个锁 | 本地合作进程锁；遗留锁不抢占；不是网络FS/恶意进程安全锁 |
| [session-store.ts](../src/session-store.ts)：SessionStore/migrateEvent | 独占header、事件校验/追加、每事件flush、inspect/history、pendingTools/recover、summary、audit。`audit` 记录拒绝或过期，标记 ignorable，不进入对话 | 多次追加不是事务；真实断电未实测；audit 不记录文件内容 |
| [preflight.ts](../src/preflight.ts)：preflight/formatPreflight/probeEndpoint/probeToolCalling/redact | 联调准备检查，**只报观察到的事实**；**默认不发凭据**（可达性探测不带认证头，故 401/403 也算"可达"）；**`--probe-tools` 才做真实请求**（D40）：用固定 prompt + 一个琐碎工具实测，**"请求是否被接受"与"工具是否真被调用"是两条独立判据**（HTTP 200 却丢弃 `tools` 是请求通过 + 工具失败，合并成因正是它此前没被发现的原因）；`toolCalling` 用 `undefined` 表示**未测量**（注释明写不得读作通过）；**错误正文与模型回显都经 `redact()` 脱敏**（截断不是脱敏，密钥只有 15 字符） | 探测超时 **300s**（实测一 个词 65-75s、带工具一轮 95-230s；曾用 60s 把可用模型报成坏的）；**单次结果无法区分"模型不支持工具"与"网关在抖"**，故失败文案要求**重跑一次再换模型**（实测同模型一次报丢弃、重跑即正常）；本模块只描述，**不做任何自动升级或重试** | | 联调准备检查：配置完整性（三项齐全规则）、**未鉴权**端点可达性探测（不读正文）、tokenizer 命令实跑一次、真实 TTY 状态；只报观察到的事实 | 不读凭据文件、不验证托管服务是否接受请求形状；它是"能否尝试"的门槛，不是"联调已完成"的证明 |

## 3. 依赖方向

```text
cli → cli-config / terminal / interactive
cli → Runtime + SessionStore + Adapter + ToolRegistry
interactive → Runtime / SessionStore / TerminalIO
Runtime → SessionStore → session-lease
Runtime → Adapter → response-validation
Runtime → Adapter → bounded-read（响应体上限）
Runtime → ToolRegistry → read_file → security-config
Runtime → ToolRegistry → read_file → bounded-read（文件读取上限）
Runtime → ToolRegistry → read_file → hex dump / offset+length 范围读（D38：非UTF-8或含NUL才走，文本逐字节不变）
Runtime → tool-environment → security-config
```

没有 DSH 包导入。受信配置由 CLI/宿主提供，不能由模型参数改变保护根或授权。工具进程内实现仍被信任，readOnly=true 不证明代码无副作用。

## 4. 一次发送的实际流程

1. CLI 解析/验证目录；缺配置交互向导或明确报错；--echo 为显式离线模式。--list 无需 Provider。
2. 交互默认唯一 session；single prompt 默认为 default；首次消息才创建日志。
3. Runtime.send 检查取消/空输入/单实例busy，取得整个会话的跨进程合作租约。
4. assertReady 读取日志，拒绝坏行/header/未完成工具组；准备 scratch，按需独占创建header。
5. 写 user；每步检查取消、步数、工具与deadline预算，重新加载历史并临时前置 system prompt。
6. 调用模型，返回后检查取消与响应结构；先追加 assistant，再追加 usage。超预算的步骤在落 assistant 前被拒绝，不留下“请求了但没回答”的工具组。
7. 无toolCalls返回最终答案；否则按序追加 tool/call→执行→tool/result→tool message。
8. 取消后不启动后续 executor，仍追加未执行调用的取消结果完成关联；等待已开始执行结束。
9. 回到第5步或退出；finally释放本次拥有的单个锁文件。退出/写入失败可能留下需检查状态。

## 5. 日志与恢复

`<home>/<sessionId>.jsonl`：v1 session/message/usage/summary；message 带可选 runId/step（tool 消息另有 isError）。`tool/call`、`tool/result` 为历史 kind，**不再写入**但旧日志仍被解析（ADR-0001）。`summary` 记录压缩边界 `covers`，写为 `ignorable`，旧读者跳过它只会看到更长的 prompt。

- header唯一且ID匹配；版本合法整数，role与字段约束、token数校验；append前验证。
- inspect返回 events/eventLines/problems；read拒绝结构错误；history仅投影message（**压缩不删除任何 message**）。
- pendingTools 另做序列/审计匹配检查；assertReady在新发送前调用。不能把history单独等同完整语义验证。
- `/recover`在锁内显式补末尾工具组：有result补message，无result标记未知，不执行工具。多次调用可幂等。
- 截断尾行、冲突、重复/孤立消息不自动修复；原日志保留。每事件 flush 且失败上抛，但**无目录项持久化保证、无断电实验**。

## 6. 测试与配置地图

| 文件 | 主要覆盖 |
|---|---|
| [phase1.test.ts](../test/phase1.test.ts) | store基础/迁移、Echo、HTTP基础与响应字节上限、CLI参数 |
| [tools.test.ts](../test/tools.test.ts) | 路径/分发/工具顺序/步数、参数Schema校验、共享字节上限、审计回放、坏行、四类预算与上下文字节预算、按模型窗口、可注入tokenizer、剩余量显示、路径判定迁移断言 |
| [tool-environment.test.ts](../test/tool-environment.test.ts) | home、白名单env、Context、CLI拒绝 |
| [security.test.ts](../test/security.test.ts) | 合成秘密不外发、保护根、junction/hardlink、非只读拒绝 |
| [interactive.test.ts](../test/interactive.test.ts) | 对话/配置、旧home密钥拒读、控制字符、取消、畸形响应、`/compact` 与 `/status` |
| [reliability.test.ts](../test/reliability.test.ts) | Runtime争用/嵌套/真实子进程、header、坏尾行、显式恢复、CLI诊断、每事件flush计数与失败上抛、重复审计记录拒绝、`/resume` 未完成批次提示 |
| [session-format.test.ts](../test/session-format.test.ts) | 旧v1 golden fixture：逐字节冻结行形状与key顺序、重放一致、半批次恢复语义、幂等与只追加、`summary` kind 往返与畸形行 |
| [fault-injection.test.ts](../test/fault-injection.test.ts) | 逐写点故障注入：注入器子类覆写唯一写入漏斗，12 个注入点（写前失败/撕裂写入）断言前缀一致、状态可诊断、恢复不重跑工具、原字节不被改写 |
| [compaction.test.ts](../test/compaction.test.ts) | 摘要保真：原始消息逐字节保留、边界=实测消息数、摘要逐字入 prompt、用户和助手原文仍发送、旧工具结果省略、路径/报错/命令仍在、未完成工具批次/空摘要拒绝、二次压缩续写、总结调用无tools |
| [provider-integration.test.ts](../test/provider-integration.test.ts) | 本机真实socket联调：wire形状、工具结果回传、HTTP失败不泄漏正文、200非JSON、length拒绝、真实abort、真实CLI一次运行且密钥不入stdout/日志 |
| [preflight.test.ts](../test/preflight.test.ts) | 联调准备：探测不发密钥/不读正文、401算可达、密钥内容长度片段均不打印、残缺配置不判ready、坏tokenizer阻止"可尝试"、非UTF-8输出不打印乱码、TTY状态如实报告、exit 3/0 门槛 |
| [streaming.test.ts](../test/streaming.test.ts) | SSE：分片拼接与末尾usage保留、`null` usage 不覆盖真实值、**工具调用跨分片按 index 组装**、断流（无`[DONE]`且无`finish_reason`）拒绝、空流/畸形分片/非字符串拒绝、字节上限、真实socket上 abort、只在 `--stream` 时改请求体且渲染结果与非流式一致（仅按定义变化的 `用时` 墙钟字段归一比较）；**传输失败点名原因**（`bad port`/拒绝连接），abort 语义不被改写 |
| [fixtures.ts](../test/fixtures.ts) | 独占保留目录，home/store/workspace分离与owner标记 |
| [server-fixture.ts](../test/server-fixture.ts) | 共享测试服务器：持久 error 监听（记录并在 after 汇报）、EADDRINUSE 与 **fetch 禁连端口**（WHATWG bad-port 列表）换端口重试、`closeAllConnections()` 防 keep-alive 拖住清理 |
| [server-fixture.test.ts](../test/server-fixture.test.ts) | 夹具自身契约：抽到的端口真的可 fetch 且永不在禁连列表、记录的错误由 `closeAllServers` 汇报且不漏关任何服务器 |

[package.json](../package.json)：start源码CLI；test显式TS glob；build仅typecheck。[tsconfig](../tsconfig.json)：strict/noUncheckedIndexedAccess。当前已验证Node24；声明的更宽范围不等于全部验证。
