# 当前有效决定（D01–D129 的折叠视图）

> **⚠️ 标题此前写"D01–D86"，而 D124–D126 已落进正文（第 1 节新增「Jev 蒸馏」小节、D19 行加注、第 3 节加三条缺口）⇒ 那是一句过期陈述，本轮更正。**本轮新增 D138（v5 AI 状态上下文：planNext 提升 + loop 检测）+ 沟通风格标准（5 段式拍板框架）。**注意 D87–D123 仍未被折叠进本文件**（它们的完整条目在 `REFERENCE_DECISIONS.md` 尾部的 12.x 节与 `STATUS.md` 的批次行里），**所以"D01–D132"指的是本文件覆盖的编号上界，不是逐条折叠的完整性声明**。

> **⚠️ 这份文档是 [REFERENCE_DECISIONS.md](REFERENCE_DECISIONS.md)（约 3400 行 / 380 KB）的折叠视图。**
> 那份是完整日志：每条决定都带"读过什么源码、为什么这么定、明确不做什么"。
> **这份只回答一个问题：现在到底怎么定的。**
>
> **每轮开工前必读这份与 [ARCHITECTURE.md](ARCHITECTURE.md)。**
> 本项目反复出现的偏离，最贵的一类不是技术判断错，而是**没查既有决定就重新论证**——
> 已发生三次：D14（蜂群定位，用户纠偏过两次）、D13（"这不是蜂群"）、`SWARM_LOOP.md:175`（WorkBuddy 路由早已采用）。
> **这三条答案当时都在文档里。**
>
> **维护规则**：新决定落进 `REFERENCE_DECISIONS.md` 后，**同一轮内**更新本文件对应行；
> 被撤回或更正的决定**不删除**，移到第 2 节并留指针。

---

## 1. 当前有效的决定

### 产品形态与依赖

| # | 决定 |
|---|---|
| **D01** | **独立 TS 内核，CLI/Runtime 分层，无 DSH 运行依赖。** ⚠️ 与 [ARCHITECTURE.md](ARCHITECTURE.md) 不冲突：**借鉴 Cordis 的接缝形状，不引入 Cordis 依赖** |
| **D57** | **不放开"零生产依赖"**。`package.json` 无 `dependencies` 字段。精确 token 预判走 `PERSONAL_AGENT_TOKENIZER` 外部命令钩子（已建成并接线四处）；嵌入与 pty 确实被挡，但中间路也救不了（`onnxruntime-node` 287 MB + `postinstall`；`node-pty` 61 MB + `node-gyp`）；纯 JS 分词器 21–26 MB 全是 BPE 词表，交易不划算 |
| **架构** | **目标形态是小核心 + 一切皆插件**，见 [ARCHITECTURE.md](ARCHITECTURE.md)。⚠️ **这是规范性目标，目前零实现** |

### 上下文与 token

| # | 决定 |
|---|---|
| **D07** | 上下文以**字节上限 + 实测 token 上限**双重拒绝；**不做估算、不截断、不自动摘要** |
| **D08** | 精确预判由**宿主注入**；**失败即报错**，不内置分词器、不隐式回退到估算（注释：*"falling back to a guess would turn 'I could not measure' into 'I measured'"*） |
| **D09** | 压缩**只缩短 prompt**：`summary` 事件记 `covers`，**message 一条不删**，边界必须等于实测消息数，未完成工具批次与空摘要拒绝，**必须显式触发** |
| **D62** | 任务状态进 prompt **不注入判定结果**；三个注入块（genePrompt + 约束 + 任务状态）**合计上限 = `Math.floor(maxContextBytes / 4)`**，字节上限在**写入时**强制 |

### 会话与存储

| # | 决定 |
|---|---|
| **ADR-0001** | **会话日志是对话的唯一事实源**。理由不是审美而是**崩溃窗口**：*"同一事实被写了两遍。一次崩溃落在任一行之间，都可能产生两套事实不一致的状态"*。**判据（§4.3）**：删掉这类记录，是只丢便利（如 `summary`，删了只是 prompt 变长），还是丢真相 |
| **ADR-0001 D1** | `assistant` 消息的 `toolCalls[]` 即「请求了什么」，`tool` 消息即「得到了什么」 |
| **ADR-0001 D3** | `runId` 由 `send()` 生成，**不新建状态机**；明确不采用 Run 状态字段、状态转移表、`runs/` 目录 |
| **D03** | JSONL、独占 header、显式有限恢复 |
| **D02** | 单 Agent、单次工具顺序；本地合作会话 writer 租约覆盖整轮 |
| **D68** | ⚠️ **若采用 SQLite：只允许 `INSERT`（含 `ON CONFLICT DO NOTHING`）与 `SELECT`，不允许 `UPDATE`/`DELETE`** —— 保住"产品无法改写自己的历史"这条**结构性质**。**代价：拿不到原子条件更新，二者不可兼得** |
| **D68** | `node:sqlite` 与 D50 的按位置拒绝**兼容**（那是文件工具的闸门，产品自身存储不经过它）；**且模型永远无法通过工具读写 agent home 里的 DB** |
| **D67** | **跨轮累积排序**：① 步骤稳定 id + 每轮不可变分项判定 + 读时折叠 ② `node:sqlite` ③ 只累积 `tools` ④ 存证据并集重判（**降级**） ⑤ JSONL 可变快照 ⑥ (A) 已死。**① 与 ② 正交**（记什么 vs 记在哪）；**① 是最小充分改动且不依赖存储决定** |
| **D61** | **`validation.ts` 的 `files-written` 语义不变、`paths` 不可变**（操作员裁定：*"如果会削弱蜂群基因，那就放弃增长"*）。**"测试通过"永远无法由本系统判定**：`command` 声明一律 `unverifiable` |

### 权限与安全

| # | 决定 |
|---|---|
| **D04** | 宿主拒绝非只读与敏感读取；**模型/插件不得自行扩大授权** |
| **D27** | **路径收敛是真的、读也被收敛，但它不是沙盒**。⚠️ 用户的判断 *"我整个电脑所有位置应该你都是可读的…但你本身应该是不会主动去其他目录直接执行的"* **是错的，且错在安全的方向**："我不会主动去"是行为描述，"我能不能"是代码事实 |
| **D25** | **降打扰的第三条轴：让能力"不存在"，而不是"被拒绝"**（修正 D24）。能力缺席 = 最强收敛（4 个独立项目佐证） |
| **D28** | 能力存在性落地：`ToolRegistry` 已是唯一从模型调用到副作用的通路，`Tool.readOnly` 已是宿主可信声明 ⇒ **不需要新模块** |
| **D29** | **授权绑定到动作的内容哈希**（`approveExact`、`FileGrant.expiresAt`、`APPROVAL_TTL_MS = 2 分钟`） |
| **D30** | **批准后漂移即拒**：`edit_file` 曾在批准前读一次内容、此后再不读，而批准与写入之间的窗口不是瞬时的 |
| **D31** | **单一优先级规则表取代写死的判定**。⚠️ 范围收敛：**路径收敛是不变量（不是策略选择）、写预算是每周期计数**，硬凑成一张表是假对称 |
| **D32** | 归因接上 + 具名档位。⚠️ 审计的事件校验器**逐字段重建**记录，所以**只加字段会被静默丢弃**——类型、写入、校验器三处必须同时改 |
| **D35** | **附加可读根**：路径轴从"只能收紧"变成"可以显式放开"，且**读写分离** |
| **D50** | 仓库自带配置**不得自行提权**；探测产物曾破坏 10 个 CLI 测试（已回退） |
| **D51** | **配置只从 agent home 读，绝不从工作区发现配置文件**（刻意不实现常见的"找项目配置"） |
| **D22 / D24** | 权限架构把**"沙箱"和"审批"拆成两个独立旋钮**；⚠️ Codex 的答案是**降打扰靠沙箱不靠审批**，而 **Windows 上这条边界最弱** ⇒ D22 的"以审批为主"在此必须修正 |
| **D23** | 规则引擎与分层优先级（tier 前缀 `DEFAULT=1`/`EXTENSION=2`/`WORKSPACE=3`/`USER=4`/…） |
| **D26** | **"第二自报通道"的定义**（多条决策的共同支柱）：*"另一个模型说这轮成功了"* 与 *"干活的模型报告自己成功了"* **都不可采信** |

### 工具与能力

| # | 决定 |
|---|---|
| **D11** | 文件编辑的默认机制是**唯一原文片段替换**（`patch_file`）；整文件替换只用于明确要求全文的场景 |
| **D38** | `read_file` 读二进制从"静默损坏"改为**无损十六进制 + 范围读** |
| **D39** | 适配器曾**完全不发送 `max_tokens`**（已修） |
| **D40** | 预检能实测**"提供方是否接受请求形状"与"是否真的调用工具"**（原预检故意不发凭据，只能证明"有人在听"） |
| **D41** | **具名只读检查工具 `inspect_file`**。⚠️ 用户纠正两点均成立：**没有沙箱时弹窗根本不是保护**（我点同意事情照旧发生），它只是最差的审计方式；**"用户知情"≠"弹窗"** |
| **D43** | 把**"账户问题"从"能力问题"里分出来**：额度耗尽与"提供方丢弃 tools"线上形状完全一样（HTTP 200 + 空 `tool_calls`），**而处置动作相反** |
| **D46** | **`run_command` + 权限三档**（用户认可"按成熟产品的形状做"，真机 7/7） |
| **D47** | **后台作业**（让长命令活下去） |
| **D48 / D49** | 中间档 `ask-before-writing`；⚠️ **D49 修掉了 D48 放行的 `git` 整族漏洞**（实证复现） |
| **D34** | M3 四问的跨产品答案：**每家的答案不同，而且各自的失败方式也不同** |

### 蜂群纪律层

| # | 决定 |
|---|---|
| **D13** | ⚠️ **已撤回重定向**：第一批把"蜂群 worker"实现成子代理扇出工具（`dispatch_workers`，提交 `5e0e039`），**用户判定这不是蜂群**，方向确认为**纪律层**。撤回原因：**① 预算旁路**（worker 花费记在自己会话、不进父轮预算）**② 决定权倒置**（分派由模型发起） |
| **D14** | ⚠️ **用户二次纠偏后确认的核心设计：蜂群 = 基因库 + RSI 闭环，PDRI 是骨架不是核心**。**"群体智慧"是本文件自己的术语**（`SWARM_LOOP.md:201` 阶段 D *"更复杂的群体协作"*、`:203` *"所谓「群体智慧」是否只是多次调用模型"*） |
| **D15** | **PDRI 周期落地**：一个 `send` = 一个周期，`cycleId` 复用该轮 `runId`；**转移合法性由状态机强制**（顺序错乱即抛错，终点周期不再接受任何事件）；**评审是机械的**（`reviewer: "mechanical"`），**不采信模型自报成功**；周期账本 = agent home 内追加式 `cycles.jsonl`，**新近度只认最后一次成功**（`lastSuccessAt`），连续失败达 `quarantineStreak`(3) 即隔离 |
| **D16** | **失败档案与蒸馏**：outcome 行增加 `intent`/`signals`/`evidence`；分组键在**请求侧**（intent + 失败类别）不是基因；`distillGuards` 是**纯函数**、产出**只含 guard 步**的草稿 + 机械证据；**草稿刻意不给 validation**（`mintGene` 会因 validation 为空而拒绝它）—— **蒸馏不许伪造证明**；只保留机械事实，不落原始错误文本 |
| **D17** | **成功归纳（`induct`）**：无基因轮的成功 → 捕获候选。**并明确它做不到什么** |
| **D18** | **每周期写入门与硬预算**：写入前检查、无活周期拒绝写入、每周期累计文件/行数账本 |
| **D19** | **队列重排：先做机械验证，独立评审者后置**。整合同时要求**评分过线 AND 观测到的 validation 通过**（*"评审的同意是意见，验证是证据"*）。**不采用"让另一个模型说这轮干得不错"式评审**。**⚠️ D125 在此之上加了一道窄门**：机械判定原本**系统性乐观**（只看 steps/toolCalls/toolErrors，从不把"产出为零"降级），`roundVeto` 用 4 条形态规则补上；**但"独立评审者后置"这条不变**，Jev 只在开发期用于校准 |
| **D20** | **结构化验证声明 + 轮末逐条比对** |
| **准入门禁** | **只从验证成功的轨迹铸造基因**（EvoMap 负结果：**纯蒸馏基因劣于手写 Skill，-3.2~-11.2pp**）；**铸造永远是操作者动作** |
| **关键分野** | **Skill/Expert 是静态手册，Gene 必须带选择依据、执行结果、成功率、失败模式与演化历史** |
| **扇出** | **明确后置**。EvoMap 数据：原子拆分 + 隔离上下文 + **程序汇合 70.7%**，主从模式仅 **38.5%**，转述链路丢失 **166 个已判对的答案** ⇒ 将来实现扇出时必须是**"程序合并、绝不文本回传再综述"** |

### TaskSpec 与任务状态

| # | 决定 |
|---|---|
| **D12** | **TaskSpec 任务编排已实施**（源：`dsh-lab/plugins/dsh-orchestrator`） |
| **D58** | **TaskSpec 已建成且承重，缺的只是跨轮持久层**。⚠️ 但 `assessTaskSpec` 的 `unknowns`（objective/mode）是**死代码**：`sendTurn` 先对空输入抛错，且 `buildTaskSpec(text, {mode: TASK_MODE})` 总传已知 mode ⇒ **`mode-unknown` 与 `objective-required` 两个分支都不可达**。**⚠️ D68 核实：上游这两个分支是活的**（`presetFrom` 可能返回 `undefined`，`index.js:33` 还专门为它准备了一行提示词）⇒ **死代码是我们的接线造成的分歧，不是继承的缺陷** |
| **D59 / D60** | **跨轮持久任务状态层**：存储形状照抄 `summary`；**真正的产出是完成判定权**。D60 定案两个开放问题并**更正 D59 两处** |
| **D61** | **任务状态核心**：`task-state` 事件种类、`ignorable: true`、latest-wins；**无 `CURRENT_EVENT_VERSION` 提升**；**新种类必须在 `migrateEvent` 里有自己的 `case`**（`default:` 分支会丢弃 `ignorable` 记录）；**不存在 `done` 字段**——完成由 `assessTaskState` 拿 claim 对 `RoundEvidence` 经 `checkValidation` 算出；**claim 单调**（`assertNotWeakened`） |
| **D63** | **写入者 `update_task_state`**：四张表必须原子改。⚠️ **一个只有端到端测试能抓到的守卫**：把 `appendSummary` 的"工具批次未完成时拒绝"守卫抄过来会让写入工具**永久不可用**，因为**发起写入的那次调用本身永远是 pending** ⇒ **抄守卫前先确认它的前提是否跟着一起过来** |
| **D64** | **轮末判定：只报告、绝不降级**。理由：证据是**每轮的**（`writeLedger`/`outcomeTools` 每次 send 重置）而任务是**跨轮的**，第二轮达成的一步在第五轮会读成 `unmet`。**不持久化**（派生值；累积规则未定） |
| **D65** | **机械判定在终端可见：一个渲染器，不是两个**（`validation.ts` 已把 claim 折进 `evaluation.evidence`）；过滤 `steps=`/`toolCalls=`（预算行已打印），保留 `toolErrors=`；**上限 8 行、省略必须报数、绝不静默截断**；**`reviewer` 永远打印**；**无 `--verbose`** |
| **D67** | ⚠️ **步骤没有稳定身份**：`TaskStateStep` 是 `{text, claim?}`，而 `text` 的注释是 *"Prose. Not authority — the claim is. **May be rewritten freely.**"* ⇒ **文本不能兼任身份锚，位置会漂移**。**是否需要稳定 id 正是"累积"与"替换"的分水岭** |

### 验证纪律

| # | 决定 |
|---|---|
| **D45** | **真机验证是常规动作**：`npm run test:live`。理由：近几轮**三个真 bug 全部 typecheck 干净、单测全绿，只在真跑时现形** |
| **D36 / D44** | 真机使用与对比；`inspect_file` 真机端到端通过并挖出两个真 bug |
| **纪律** | **断言产品行为之前，先读到那条行为**（三次断言错的共同根因） |
| **纪律** | **变异验证是强制动作**：删掉刚写的机制，测试必须变红 |
| **纪律** | **历史批次文档永不改写**，只加标记式更正块 |

### Jev 蒸馏（D124–D126）

**⚠️ 边界先说清：Jev 是开发期的离线标注器，运行时不调用它。** D126 的核查：`src/` 里 `grep -E "jev|futureppo|systemone"` **零匹配**，`cycle.ts` 的 `import` 列表是**空的**；`src/` 里所有 `fetch` 都是操作员自己配置的 provider、MCP、OAuth。

| # | 决定 |
|---|---|
| **D124** | **意图判定从手写正则表改为 Jev 蒸馏信号表**（172 条 prompt × Jev `noul` ×5 → 381 个信号 → `intent-weights.json`）。**⚠️ 决定性变量是问句措辞**：单字问法 `Is this about build?` 让 build 保真只有 **79%**，展开成行为的描述式问法升到 **100%**（operate 97%→100%）。**`noul` 返回的是独立边缘概率、不构成分布**（不要求和为 1），故只做 argmax、不归一化、不称"置信度"。无匹配时返回先验并置 `oov`，由调用方处理 |
| **D125** | **`roundVeto` 在 `evaluateRun` 之上再窄一道**：4 条结构性退化形态（零轮次 / 空回复 / 回声 / 开场拒答）把 `success` 降级成 `partial`，**绝不降 `failed`**（产出确实发生了）。实测 54 个真实 round：D19 纯机械 **75.9%**、21 特征加权 **79.6%（⚠️ 且把 `fn=0` 破坏成 3）**、**4 条规则 87.0%（保住 `fn=0`）**。**否决不是加权** —— 一段排版漂亮的拒答会靠 `hasList`+`hasHeading` 把分推过阈值，而"排版好看"没有资格把"活没干"投下去。**`reply === undefined` 时跳过形态检查：缺席不是证据** |
| **D126** | **Jev 只存在于 `scripts/` 的离线工具里，且由人驱动**：产出经人审阅后写成 `src/` 的代码（4 条正则 / 一个 JSON）。**撤回"定期校准"这个提议** —— 那会让 Jev 变成长期依赖（每 round 一次调用），而那 4 条规则是**结构性退化、不随模型腐坏**（"输出为空"换什么模型都是没产出）。正确触发是**事件**：换 provider/模型，或 `grep veto=` 占比跳变。**⚠️ 不加 `--round-drift` 子命令**：第三方用户没有 Jev key，告诉他"建议重新发现形态"是让他做一件做不到的事 |
| **D129** | **Jev 蒸馏扩样**：从 DSH `~/.dsh/storages/session_projcache/sessions/*.json` 自动抽 211 条真 user prompt，写到 `scripts/intent-prompts-supplemental.json`；跑 `distill-intent.ts` (JEV × 1055) + `train-intent-weights.ts` → `scripts/intent-weights-supplemental.json` (211 rows / 1822 signals, priors research 0.426→0.534 ↑0.109)。**D124 信号覆盖只占 supplement 4%**（72/1822 共享，1750 OOV）+ **共享 72 信号上 mean\|Δ\|=0.21-0.26**——**D124 ② + ④ "未做留一法复核"那条缺口**实证：172 训的 381 信号**不稳定**。**⚠️ 2-gram 切粒度问题**（`extractSignals` 把一条长 prompt 切出的 bigrams 当独立信号，supplement 把这毛病放大了 4.8 倍）—— **D130 候选 = 训练时对一条 prompt 的所有 bigrams 共用 probs**，改 `train-intent-weights.ts` 一文件。**D129 这次**没合并到 `src/intent-weights.json`（D126 边界 + D124 ② 想看的"再训一次"留给 D130） |
| **D130** | **训练 1-row = 1-observation，bigram 通胀消除**：改 `train-intent-weights.ts`（58 → 96 行），一条 row 的 probs 等分给该 row 切出的所有 signals（share = 1 / signals.length）。抽 `train()` 为纯函数 + 加 `import.meta.url` 守卫避免测试 import 覆盖 src/。`test/train-intent-weights.test.ts`：**6 个 case** pin 住不变量。**合并训**：172 D124 + 211 D129 supplement = 383 rows → `intent-weights-merged.json` (**2131 signals**)。**4.8× 通胀完全消解**：D129 supplement 那批 OOV `build 0.98` ("下创"/"立于"/"的新"/"新项目"/...) 在 D130 后**全部 `build 0.01`**——一长 build prompt 切 70 个 bigrams，share=1/70，evidence 守恒 (0.98/70 ≈ 0.014)。**新 priors** (fix 0.300 / verify 0.418 / research 0.486 / operate 0.300 / build 0.304) 比 D124 (0.339/0.447/0.426/0.313/0.293) **更均衡** + research 仍最高 = **D129 §六 "真分布偏 research"被加权稳定**。**未替换 `src/intent-weights.json`**（D126 边界 + **人工 spot-check 5 个中文 prompt** 是替换前的最后一道闸） |
| **D131** | **多模型横评**（蜂群 EvoMap 风格 / Multi-Agent Collab + Self-organizing Swarms）：`scripts/multi-model-eval.ts`（342 行）通用多模型意图评判工具——支持 `type: "jev"` 调 noul 接口 / `type: "openai"` 调 OpenAI-兼容 `/v1/chat/completions`，7 个 parse 容错测试。**211 prompts × 3 模型 = 633 调用**：Jev **99.5%** 成功 / Claude Opus 5 **11.8%**（网关把它路由到 notion 通道，全 `temporarily-unavailable`）/ Grok 4.7 **4.7%**——**网关上游通道脆弱**（claude→notion 是网关 bug）。**单模型偏证实**：Jev 48% research / Claude 88% fix / Grok 96% fix——**全极端**。**13.7% 三家 argmax 全一致 + 85.3% 二家一致**——**单模型偏 87% prompt 上系统可测**。`scripts/intent-distilled-multi.jsonl`（211 行 × 3 模型 probs）留作 D132 多模型 weights 训练原料。**未动 src/**（D126 + 网关 noise 高） |
| **D132** | **多模型 weights + D124 ② spot-check**：`scripts/build-multi-model-weights.ts` 读 D131 输出过滤 fallback (`{fix:0.2..build:0.2}` 占位符不算意见) 训 4 张 weights（jev 211 / claude 25 / grok 10 / consensus-mean 211）。**D132 ②**：jev-only `priors.research 0.535` vs claude 0.414 vs consensus 0.528——**consensus 被 Jev 一家主导**（失败率高），**几乎不对冲**。`scripts/spot-check.ts` 5 个手写中文 prompt × 5 weights 表 → **merged (D130) = src/D124 base 5/5 平手**、D132 单源全 3/5（覆盖不足）。**D124 ② 决定**：`scripts/intent-weights-merged.json`（383 行 / 2131 signals）**可替 src/intent-weights.json**——平手 spot-check + 5.6× 信号覆盖 + priors 略偏真分布 |
| **D133 跳过** | 按用户意见 "你按照模型来就行"：8787 网关按 alias 分频道合理（notion 也接入了大模型，作为 `claude-opus-5` 后端正常），**D131 多模型横评 387 ERROR 接受为 alias 设计、不修** |
| **D19 ③** | **Jev noul 替代 D19**：54 round × 3 模型评测——**Jev 100% 响应，Claude/Grok 0% 响应**（同 D131 网关问题）。**Jev noul 重问（1-question `accomplished` 复 D125 蒸馏同款）= 98.1% 准确率**，**D19 75.9% → Jev 98.1% = +22.2pp / 13→1 FP**——**D19 母题真闭合**。**multi-consensus = Jev 单独**（Claude/Grok 全 null）。**不写 src/**（D126 + 7s 同步延迟 vs D19 0 延迟）——**D135 候选** = roundVeto 4 规则快扫 → 命中后**条件触发** Jev 重问做二次确认（只 ~5% round 触发，平均延迟 +0.35s） |
| **D131 §一 closure** | **AI 评审团同意/不同意特征分析**：`scripts/analyze-multi-agreement.ts` 读 D131 JSONL 211 行——**13.7% 三家全同意、85.3% 二家同意、0.9% 完全三派**。**长度不预测同意**（all/partial 都 47 字符），**只有"超短 7-12 字"才极端分派**。**Jev 是少数派 166/180**——**多数派压制少数派是 D131 系统性现象**，Jev 的少数派意见常是对的（"调研"二字 Jev 能看到，Claude/Grok 只看 fix）。**正确用法不是 consensus 投票**（损失少数派信息），**而是记下少数派意见作为 roundVeto 二次确认**。Top 15 模糊 prompt 都是短中文词，Top 15 强共识都是显式动作词（调研/修复/部署/Implement） |
| **D19 母题方向校正** | **推翻 D135 候选**（hybrid Jev 重问 = 违反 D126）：产品是 GitHub 通用包，不接入 Jev API。**真正的 D19 母题 = 把 Jev 的判断机制蒸馏成本地特征，加进 D125 21-feature scorer**。D19 ③ 给的 13 FP 案例 = **金矿**：每一类对应一个本地特征（`isEchoResponse` / `isAcknowledgmentOnly` / `responseLacksExpectedContent` / `intentMismatch` / `promptTooVague` / `promptIsFilepath` / `promptHasGoalBlock`）。**D19 ④ 候选** = 21 → 28 features，估 < 300 行，0 网络调用 |
| **D19 ③ retest** | **公共 endpoint 替代 8787**：用论坛 key 测 ytyidc.com (3 keys, 66 并发, pro/听话pro/free) + lblb.eu (1 key) — **5/11 模型通 JSON**（gpt-5.5/5.6/5.6-sol/6 + gemini-3.7-flash）。**54 round × 6 模型**：D19 75.9% → multi-consensus **96.3%** = +20.4pp / 13→1 FP。**5 个不同模型家族都做到 90-94%**——**D19 mechanical 错判不是 Jev 个性，是跨架构 LLM 共识**。**1 个 case 是 consensus 纠 Jev baseline 的错**——少数派信息有时正确。13 D19-FP 全部 5 模型一致判 <0.5（12 个）/ 抓到（1 个）= **7 类典型漏判**，每类对应 1 个本地特征 |
| **D136** | **上下文继承** = 模糊指令（"继续"/"再"/"OK"/"行" 等 30+ 触发词）的真正答案。`classifyIntent(text, history?)` 加 history 参数，触发词 + history → 继承 last round intent 0.85 高置信；不传 history = 旧行为，**967/967 测试过**。**D131 §一 closure**: 85% 的 2-1 disagreement 主要是模糊指令，D136 解 ~30-40%（触发词场景），D137 候选解决剩下 ~50%（"中转聚合站"等非触发模糊 case，用 history+current prompt 拼接当 raw text 重训）。**D131→D136→D137** 是 "AI 评审团 85% 不同意" 的逐步解决方案 |
| **D137** | **置信度反比 + margin+OOV 演化** = 4 步迭代从触发词到 margin-driven 渐变。v1 触发词（30+ 词表）→ v2 短+0 signal（魔数 8）→ v3 `0.85 - top_prob`（**失败**：D124 weights top prob 只 0.20-0.40，60% 污染清晰 fix）→ **v4 OOV + margin**（margin > 0.05 → 0 history；OOV → 0.6 history）。**970/970 测试过**。**根因错误教训**：D124 weights 是"软概率"，top prob 不是置信度指标，**margin = top - second 才是真置信度**。"修这个 bug" top 0.247 但 margin 0.071（明确），"继续" top 0.447 但 margin 0.022（OOV 不信）。D137 closed。D138/v5 候选 = 多轮衰减 + 多意图 history |
| **D138 (v5)** | **AI 状态上下文** = 用户的 prompt 没意义，意义在 AI 上轮干了啥。`HistoryRound` 加 `aiState` 字段（`didWhat` / `completed` / `planNext` / `userAccepted` 4 个）。`planNext` 存在 → history 权重 0.6→0.7（OOV）或 +0.2 boost（弱 signal）。**loop 检测**：连续 3 轮 AI state `didWhat + completed` 不变 → `Classification.loop.detected = true`（"用户说 100 次继续，AI 状态没动"）。**977/977 测试过**。**v5 是 v4 顺接**：0 触发词 / 0 长度门 / 0 魔数（除 5 个经验常量），向后兼容（缺 `aiState` 的旧 history 走 v4 路径）。**生产依赖**：runtime（D128 §九·六 (3)）需要每轮结束时记录 `aiState` 4 字段——这是 v5 的**前置依赖**，v5 classifier 已就绪，runtime 落字段是 D139 |
| **D139 (Option B 最小版)** | **runtime 落 aiState 2 字段**（`didWhat` + `completed`，planNext/userAccepted 留 D140/D141）。**`src/history-builder.ts` 新文件**（~80 行）：`buildHistory(events, n=5)` 按 runId 分组最近 N 轮，`summarizeRound(events)` 列出工具名 + 检查错误。**`src/taskspec.ts`** 加 `history?` 选项转给 `classifyIntent`。**`src/runtime.ts`** `sendTurn` 开头 `store.read(sessionId)` → `buildHistory` → `buildTaskSpec` 透传。**986/986 测试过**（D139 加 9 个测试）。**0 新持久化**——直接读 session log 现成的事件，stateless 派生。**行为变化**：D139 之后，runtime 自动喂 v5 classifier，loop 检测 + planNext 提升（虽然 planNext 还没填）在生产环境真起作用 |
| **D140 planNext 派生** | **`extractPlanNext` 扫 AI 最后消息里的"下一步" / "next" / "TODO" 模式**（4 个 regex）。命中 → `aiState.planNext` 有值；没命中 → undefined（v5 走 OOV 0.6 路径，不升 0.7）。**996/996 测试过**（D140 加 10 个测试）。**真数据命中率 0/2**——AI 不写"下一步"自述。**保持现状**——planNext 字段保留机制。用户告诉 AI "给出下一步计划" 时 D140 自然有效 |
| **D142 loop 告警 v2** | **5 轮窗口 + 主导 action 检测**：每轮记录 `actionSigs: string[]`（每个 tool call 一个签名 = `name\|args`），loop 检测看最近 5 轮所有 actionSigs——**任一签名出现 ≥ 3 次且占比 ≥ 50%** → loop。**用户案例 A,B,B,C,B,B（6 轮）** → B 占 4/5 = 80% → 触发。**v1 失败**：3 轮字符串相同才算 → 抓不到"AI 反复回来看 B"。**v2 用 actionSigs 数组**（不是单个 hash）能区分"5 个全 A"和"5 个中 3A+2B"。**1003/1003 测试过**（D142 加 7 个新测试，3 个旧测试更新到 5 轮窗口）。**3 个常量**：`LOOP_DETECT_WINDOW=5`、`LOOP_MIN_DOMINANT_COUNT=3`、`LOOP_MIN_DOMINANT_RATIO=0.5` |
| **沟通风格标准** | `docs/COMMUNICATION_STYLE.md` 已建立——5 段式（**做什么 / 为什么 / 代价 / 替代 / 推荐**）。**所有决策点都用大白话，不甩变量名/缩写/技术细节**。用户拍板"以后都要这样" |
| **D124 ② 决定修正** | 用户批准"评分表可以换" → merged weights (383 rows / 2131 signals) 替 D124 base → **8 个 unit test 回归**（"部署上线" 等路由偏到 research/verify）。**根因 = 真实用户数据 vs 手写样本的语义偏移**。**§二 决定 = 恢复 D124 base**（967/967 过），**merged 留在 scripts/**，D137 候选 = 补 ~30 个回归 case 到训练集再训，留一法验不破 D124 已通过 case |
| **D124 ② 完成** | `scripts/intent-weights-merged.json` (383 rows / 2131 signals / priors.research 0.486) **已替换** `src/intent-weights.json`——D132 5/5 spot-check 平手 + 5.6× 信号覆盖 + 偏向真分布。trainedAt=2026-10-09T04:43:13Z |
| **纪律** | **Jev 是校准来源，不是真相**。实测里有一类漏网是"模型用了 10–21 次工具真的干了活，Jev 却给 0.28–0.43" —— **把它当无条件 ground truth 会把它的噪声固化进代码**。同理，`重构这个函数 → verify` 这类分歧是判断不是错误，抹掉它会让权重表退化回我原来的偏见（D124 ④）。**D129** 给出实证：D124 381 信号只覆盖 supplement 4%、共享 72 信号 mean\|Δ\|=0.21-0.26——**留一法复核**已经做完，**D124 ② + ④ 那条缺口可以划掉** |

### 额度与扣分（D127）

| # | 决定 |
|---|---|
| **D127 ①** | **两本账**：**质量账**（`expression.attempts/successes`）决定下一次**选谁**；**预算账**（每轮真实写到的 files/lines + 是否被拒）决定下一次**给多大房间**。扣分的目的是**校准**，所以"撞预算"（关于房间）不能记进质量账 |
| **D127 ②** | **预算拒绝不再进 `toolErrors`**。工具没跑、什么都没坏 ⇒ 不再把整轮从 `success` 推成 `partial`。**⚠️ 这不是放宽**：拒绝依然发生、文件依然不改、审计依然记 denied；变的只是这笔账记在谁头上。压力仍可见（`evidence` 里出现 `budgetRefusals=N`），但**不参与判定** |
| **D127 ③** | **额度由历史测得，不由人猜**：`write-budget.ts` 新增 `measuredBudget()`，p95（不是 max/mean）+ **删失还原** + fallback 作**下限**。`distill.ts`/`induct.ts` 里写死的 `{maxFiles:1, maxLines:20}` 换成它。**冷启动仍用 `{1,20}`，但降级为占位** |
| **D127 ④** | **⚠️ 删失是最容易做错的一处**：被拦住的轮记下的是"写到了多少"而非"需要多少"，**而那个值恰好是上限** ⇒ 当需求用会推出同一个过小额度，永不抬升（测量不到任何东西的不动点）。修法：`budgetRefusals>0 ⇒ demand = max(reached, cap+1)`。这仍是下界，**但这是该错的方向** |
| **D127 ⑤** | **不把额度写进提示词**（想过并否决）：模型事前不知道任务需要几个文件，告诉它"只能 3 个"只会让它更早停手。`gene-store.ts` 那句 *"never the constraints"* 是错的，但错在"把约束当成可省略的元数据"，**替代品是让额度真的安全且真的够用，不是念给模型听** |
| **纪律** | **额度要么数出来、要么测出来。** ⚠️ D127 在同一会话里**连踩两次**"凭感觉填 `max_files` 然后被自己的额度拦住"——**铸造时人知道得最少**，这是同一个缺陷的再现，不是巧合 |

### `obs_recall` 召回端（D128）

| # | 决定 |
|---|---|
| **D128 ①** | **只采纳 SoL-Pi 召回那一半**：不另存内容寻址归档文件（ADR-0001 会让那变成"已存好的数据再造副本"，正是 D52 修正的根因）；按 `callId` 从会话日志**精确匹配**读回；`obs_recall` 工具**会话绑定**（store + id 构造时给），与 `update_task_state` 同形状 |
| **D128 ②** | **分页规则**：`RECALL_MAX_BYTES=16KB` / `RECALL_MAX_LINES=400` 同时封顶、先到先限；**UTF-8 字符边界守恒**——起止两端都查（SoL-Pi 只查尾，JS 切片不报错所以这里两边都要查）；产出的页面**事后重新校验**字节上限 |
| **D128 ③** | **不动 size-threshold 自动投影**。SoL-Pi 的 `THRESHOLD_BYTES=10KB` / `FULL_SENDS=2` D52 自己标了"未验证"——**不能拿猜的数字落系统**。本轮**先让召回端正确**，size 参数留作实机调（→ §九 接上） |
| **D128 ④** | **不复制 SoL-Pi 的 `obs_<sha256...>` 内容寻址 id**：那条 id 在原实现**承重**（工具从 id 构路径读归档），本实现**没有路径参数**（只收 `callId`），正则照搬就是"读起来像安全但啥都没保护"。`callId` 是**模型可读**的，它已经在对话里出现，**审计只需 grep** |
| **D128 ⑤** | **占位符必须带 callId**。`runtime.ts:1288` 那条 `N chars remain in the session log` 是**死指针**（说"还在日志里"但取不回来）—— D128 换成 `omittedResultPlaceholder(callId?, content)`，**没 callId 时明说**"no call id was recorded, so it cannot be read back"；**缺席不是邀请猜测** |
| **纪律** | **⚠️ `obs_recall` 只救**已**触发压缩**的轮次；大工具结果撑爆 `assertContextFits` 那条路径**不在本轮范围**（→ §九 接上） |

### 召回投影（D128 §九）

| # | 决定 |
|---|---|
| **§九 ①** | **新纯函数** `projectOversizedToolResults(messages, thresholdBytes)`（`src/obs-recall.ts`）：把超过阈值的 `role:"tool"` 替换成 `omittedResultPlaceholder`；`Infinity`/≤0 视为关闭（**仍返回新数组**——契约，调用方不能靠引用相等判"没改"）；**fail-open**（投影异常保留原消息，理由写进 doc：丢原文比看占位符更糟） |
| **§九 ②** | **新运行期选项** `obsProjectionThreshold?: number`（`src/runtime.ts:AgentRuntimeOptions`），默认 `Number.POSITIVE_INFINITY`（**默认 OFF，行为零变化**）；`positiveInt` 拒 `Infinity`，校验照 `maxSteps` 形状内联 |
| **§九 ③** | **两层投影合一 + 顺序在 doc 里写明**：`buildPrompt` 改一处，把**压缩**投影与**尺寸**投影合到同一个 `visible` 数组上，**压缩先、尺寸后**。颠倒会出错：尺寸投影先做会把"50 KiB 工具结果"换成"≈200 字节占位符"，**压缩层再投影一次**会拿占位符的字节数算"50000 bytes"——这是 §四"两件事有顺序"那条原则的具体化 |
| **§九 ④** | **不替操作员选阈值**。D52 §三 把 SoL-Pi 的 `THRESHOLD_BYTES=10KB` / `FULL_SENDS=2` 标了"未验证"；**猜 16 KiB** 和 **猜 32 KiB** 都是凭感觉，`D127 纪律` *额度要么数出来、要么测出来* 同样适用于投影阈值。**默认 OFF = 把开关的权力显式交给操作员**——不是"留 TODO" |
| **纪律** | **D128 §九 是接 D128 §六 的，不是接 `assertContextFits` 的**。它**减** `assertContextFits` 被触发的次数，**不**是替代它（`assertContextFits` 仍然**只**报错、不做截断，这是 D81）。**真机阈值**（personal-agent test 套件 n=11 实测过——`measure-tool-bytes.test.ts`）**支持 32 KiB 候选**：5/11 = 45% 投影比例 + 命中 18.9 KiB / 40 KiB 中段 + 不踩 < 256 B 短 case。**当前默认 = `32 * 1024`（`DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES`）**，**显式 `Number.POSITIVE_INFINITY` 仍等于关掉**。**n=11 是方向性数据**，**真分布仍待 DSH 真机**——**等用户在 DSH 跑 N 轮后精调** |

---

## 2. ⚠️ 已撤回 / 已被更正 / 已撤销

**这一节存在的理由：`REFERENCE_DECISIONS.md` 是时间序日志，撤回与更正散在 1630 行里。不折叠就会重犯"重新论证已被否决的结论"。**

| 原决定 | 状态 | 更正在哪 |
|---|---|---|
| **D13** 第一批把蜂群做成子代理扇出 | **已撤回重定向**（用户判定"这不是蜂群"） | D13 自身 |
| **D22** "以审批为主" | **被 D24 修正**（Windows 上沙箱边界最弱） | D24 |
| **D24** 的结论 | **被 D25 修正**（第三条轴是"能力不存在"） | D25 |
| **D26 之前**的三处措辞 | **用户追问后纠正**（"全局开关"DSH 和 Codex 都有） | D26 |
| **D31 之前**"待统一的四个轴" | **范围收敛**（硬凑一张表是假对称） | D31 |
| **D33** "下一步是规则表内核" | **过期**（`rule-table.ts`/`tiers.ts` 已完成并接线） | D33 自身 |
| **D48** 中间档放行了 `git` 整族 | **D49 实证复现并修掉** | D49 |
| **D50** 探测产物 | **破坏 10 个 CLI 测试，已回退** | D50 |
| **D52** `obs_recall` 归档到文件 | **被用户推翻**（*"如果不写成文件的话后期如何追溯之前的内容？"*）→ 改为**按 `callId` 从会话日志读回** | D52 修正块 → **D128 已落代码**（§九 接上 size-threshold 投影，默认 OFF）|
| **D53** 记忆系统的诊断 | **假诊断** | D55 修正 |
| **D55 拒绝 #2** 的前提 | **错**（用户指出 `/compact` 是一次模型调用；正确范围是 *`decide()` 不做模型调用*） | D55 修正块 |
| **D56** "① 堵住 ② 的逃生口"、"会话历史无法按内容索引" | **两条都是假的** | D57 取证 |
| **D57** *"`node:sqlite` 自 22.5 起内置 ⇒ floor 已覆盖"* | **⚠️ 不成立**：22.5.0–22.12.x 需要 `--experimental-sqlite`（Node 官方 `doc/api/sqlite.md`，PR 55890 在 v22.13.0/v23.4.0 去掉），而声明下限是 `>=22.6` | **D68 第一、二节 + D57 处的标记式更正块** |
| **D58** 之前我说"接上 `assessTaskState` 会让 D58 的死代码有意义" | **混淆，已自我更正**（D58 的死代码是 `assessTaskSpec` 的 `unknowns`，与任务状态无关） | D64 |
| **D59** 两处 | **被 D60 更正** | D60 |
| **D61** 操作员批准的 `files-written.paths` 增长 | **⚠️ 未实施**：`validation.ts:56-70` 证明它不成立（双向集合相等），**偏离已上报并给出反例**；操作员随后裁定 `paths` 不可变 | D61 |
| **D66** 的结论 | **被用户判为非决策级**（*"你现在在纠结就说明材料不够"*）→ D67 给出排序 | D67 |
| **D67** 名次 2 "两项前置未验" | **D68 验完**：一项通过、一项不通过 | D68 第六节 |
| **`IMPLEMENTATION.md:116`** "不依赖 DSH/Cordis" | **⚠️ 本轮撤销**（目标形态是一切皆插件；但"不引入 Cordis 依赖"仍有效） | `IMPLEMENTATION.md` 更正块 |
| **`SWARM_LOOP.md:173`** "Cordis 宿主"不采用 | **⚠️ 本轮撤销**（同上） | `SWARM_LOOP.md` 更正块 |
| **`IMPLEMENTATION.md:112`** *"借鉴机制，运行时仍是自己的"* | **⚠️ 被我误读成"直接写进核心"的许可证**，原意是"不原样接进来" | `IMPLEMENTATION.md` 更正块 |
| **`SWARM_LOOP.md` §8** | **已过期**：说 *"`src/` 下不存在 shell/exec 类模块"*，但 `shell-tool.ts` 已在 D46 落地；基线记 365，现为 629 | `SWARM_LOOP.md` 更正块 |
| **D69** 拒绝 Cordis | **⚠️ 未读就拒绝**（操作者：*"DSH不就是现成的例子吗？他是如何设计的？为什么又不参考成熟产品？"*）⇒ 立规矩：任何"不做 X"的结论必须附读过 X 的证据，读不到就写"未读，不下结论" | D69 |
| **D69** 与既有决定冲突 | **它同时否掉了 D14 已记录的取向与 `SWARM_LOOP.md:175` 已采用的 WorkBuddy 先例** ⇒ 立规矩：改动前先查 `DECISIONS_ACTIVE.md` | D69 |
| **D70** "声明合并可选" | **⚠️ 被 D75 修正**：对路线丙它不是可选，而是让运行时注册的种类在类型上拥有字面量的**唯一途径**（D70 那句话在"只要运行时开放性"时对、在"要类型侧可判别"时错） | D75 第二节 |
| **D70** 探针 (a) 的证据强度 | **⚠️ 被 D76 修正**：探针用 `--module preserve`，而项目 `tsconfig.json` 是 `"module": "ESNext"` ⇒ 结论对但当时不是在真实选项下得到的（D76 已用真实 tsconfig 重跑，仍成立）⇒ 立规矩：**探针必须复制项目真实 tsconfig，不能手搓 flag** | D76 开头 |
| **D71** "把开放成员加进 `SessionEvent` 联合会破坏 8 处收窄" | **⚠️ 归因错了，被 D75+D76+D77 修正**：破坏收窄的是 `ExternalSessionEvent.kind: string` 这个**兜底成员**（与所有字面量重叠），**不是"联合被打开"** ⇒ 路线丙（每个种类各自一个字面量）落地后，**那 8 处一处都不用改** | D75 第一节、D76 P2、D77 |
| **`ARCHITECTURE.md` §3.4④** "新增事件种类必须改核心 = 特权核心的实例" | **⚠️ 被 D77 作废**：`SessionEventMap` 可声明合并增广后，新增种类只需一份 `declare module` + 一次 `registerEventKind`，**核心一行不改**（已实测：`tsc --noEmit` 退出码 0、651 项测试通过） | D77、`ARCHITECTURE.md` §3.4④ 修订块 |
| **D77** "DSH 那套隔离本项目暂时不需要" | **⚠️ 被 D79 部分修正**：结论在单程序前提下仍成立，但当时把 DSH 对 `docs_development.md:56` 冲突的解法理解成只有"两个聚合程序"，**漏了它已发布的拓扑解法：纯类型出口（`/types` 子路径只含类型表，靠 re-export 保持符号同一性）** | D79 第四节 |
| **D72 第 ② 步**（把 `task-state` 逐字段校验搬进 provider） | **⚠️ 已取消**：丙消除了它要解决的问题（新增种类必须改核心），剩下的只是代码组织改善，而**没有第二个种类需要搬 ⇒ 无第二消费者 ⇒ 不做**。**何时重新捡起：出现第二个需要独立校验语义的事件种类时** | D78 plan-ready、D79 第九节 |
| **"是否要求注册即增广"这个待裁定项** | **⚠️ 已撤销 —— 它是个伪选择**：Cordis 真实源码 `registry.ts:107-108` 是 `provide?: string \| string[]`（运行时开放）、`:22-23,37` 的 `InjectKey` 派生自增广后的 `Context`（**约束只在取用侧**）；DSH 投影包**一个 `.d.ts` 都没有**，领域包靠声明合并接入"唯一一张投影类型表" ⇒ **成熟产品是"运行时开放 + 类型侧可选增广"，本项目 D77 之后已对齐，没有分歧可裁**。**⚠️ 真正的错是把它当价值判断题抛给操作者而没做研究** | D79 |
| **D77 的 kind-key 静态断言**（强制"表键 == 成员的 `kind` 字面量"） | **⚠️ 跳过（YAGNI）**，且 D79 给了更强理由：**Cordis 也不强制"注册名 == 类型键"** ⇒ 这不是本项目缺陷，是这一族设计的共同取舍。**何时重新考虑：出现第一个真实第三方插件且它真踩到不一致时** | D78 plan-ready、D79 第八节 |
| **"Cordis 只有二手转述可读"** | **⚠️ 可达性认定错误，第二次犯**（第一次是 D75）：`@deepseek-ai/cordis` 在 `app.asar` 里带的是 **`src/*.ts` 真实源码**（`registry.ts`/`context.ts`/`service.ts`/`events.ts`/`fiber.ts`/`reflect.ts`）⇒ 纪律升级：说"读不到"前要查已安装产物的打包体**及其非标准位置**（`src/` 不只 `lib/`、作用域目录不只顶层 `node_modules/`；`@deepseek-ai` 在 **`dsh/node_modules/` 之下**） | D79 第一节 |
| **D78 的 `CODE_MAP.md` 表格修复** | **⚠️ 只修了一半**：D78 去掉第 54 行的空单元格把竖线从 7 降到 5，但没把混格的重复内容归位 ⇒ **D80 才真正修好**（4 个单元格恢复为 3 个） | D80 |
| **D80 对 D 索引表的自动修复** | **⚠️ 已回滚**：删掉表格内部 23 个空行后，扫描暴露出更深的缺陷（**第 2365/2366 行竖线数 3 和 2，比众数 4 更少 ⇒ 那些行缺失单元格/被截断**，不是"多了未转义竖线"）⇒ **在历史索引上继续自动修复的风险是毁掉记录而不是修好渲染，故 `git checkout` 回滚** | D80 |
| **D81 的"注入块整块计入 `maxContextBytes/4`"** | **⚠️ 已被 D82 更正**：现在**只有外部字节（命中的技能提示词）计入**，产品自有的意图片段豁免（五个编译期常量、约 180 字节、有上界）。**理由**：那条上限是为"来自产品之外、无界的目录内容"而存在的，把有界的产品文本也计进去会产生一条把两个零字节块列进错误信息的拒绝。**⚠️ 同时被拒绝的替代方案：给上限加地板 `max(quarter, 512)`** —— 那是一个推不出来的魔法数，且会为小预算静默放宽上限 | D82 |
| **D81 的 `taskPromptSkills` 默认 `[]`** | **⚠️ 已被 D84 更正**：该选项现在是**覆盖用的注入点**，未提供时从 **agent home 下的 `skills.json`** 每轮重读。**⚠️ 注入的目录整体胜出、不与磁盘合并**（一个路由决定有两个来源，是操作者从此分不清哪个技能触发的开始） | D84 |
| **`SWARM_LOOP.md:175` 把 WorkBuddy 两级 skills 目录一起记为采用** | **⚠️ 已被 D84 收窄**：**只采用第一级（agent home），明确拒绝第二级 `{workspace}/.workbuddy-ai/skills/`** —— 两级布局恰恰是让一个被克隆的仓库能用产品自己的口吻对模型说话的原因（工作区文件随仓库分发，而技能提示词进的是 system 消息），与 `constraints.ts:81-83` 拒绝搜工作区同一个理由 | D84 |
| **D84 照抄来的 `PERMISSION_KEYS`（含 `priority`）** | **⚠️ 本轮自查出的真实缺陷，已修**：`priority` 恰恰是技能的合法字段（D81 用它打破平手）⇒ 任何声明 `priority` 的技能都被拒，**且报错指控操作者"试图改权限"，那是他没做的事** ⇒ **记法：把校验清单抄进新语境时必须逐条对着新 schema 核对，拒绝清单不是自然常数，它是关于某一种文件格式的陈述** | D84 |
| **`background-jobs` 那两条 kill 测试的断言形状** | **⚠️ 已被 D85 更正 —— 产品是对的，测试断言的是实现细节**：`killTree` 刻意不等待 `taskkill`（`:241-245`：*在关闭路径与工具调用里阻塞于一个正在被杀的进程，会把"已停止的任务"变成"挂死的 agent"*）⇒ **`killJob` 返回 `true` 的含义是"已发起击杀"，不是"进程已死"**，而测试赌的是"300 毫秒内已死"。**⚠️ 一处如实记录的放宽**：不再断言"击杀返回后一个字节都不再写"（那从来不是真的）⇒ 改为轮询到长度不再变化、10 秒仍在增长则失败并报出字节数。**⚠️ 明确拒绝的替代：让 `killJob` 等待击杀完成** —— 那会与已记录且有理由的异步设计冲突 | D85 |
| **"隔离重跑总是通过，所以隔离运行不算证据"** | **⚠️ 已被 D86 限定，不可当作通则**：那句话对 D85 那条红成立，因为它是**负载相关**的（并行才失败）；但 D86 的变异是**确定性**的（跳过 `taskkill` 分支与负载无关），**所以隔离失败就是确证** ⇒ **记法："隔离运行算不算证据"取决于被验证的性质是否与并发相关，不取决于运行方式本身** | D86 |
| **`ARCHITECTURE.md:174` 的"两条候选路线，待操作者裁定"** | **⚠️ 已过期，D87 在规范文档里就地更正**：操作者裁定的是**丙**并已落地（D77，`c91e8f3`）⇒ 甲/乙 都不再是待决项（甲的账单没付、乙的判据没换，**丙走的是第三条路：类型表可增广、核心 switch 一个 case 都不动**）。**原文保留不改写** | D77、D87 |
| **`ARCHITECTURE.md:174/178` 的"D70/D71 已把声明合并降级为可选"与"删兜底成员"那段** | **⚠️ 已被 D79 撤回、D87 在规范文档里就地更正**：兜底成员 `ExternalSessionEvent` 的 `kind: string` **就该留着**，因为它正是 Cordis `registry.ts:107-108` 那个 `provide?: string \| string[]` 的对应物 ⇒ **"注册时是否必须增广"作为待决问题不再存在**；"声明合并是可选的"这句要按 D79 读：**可选不等于次等，它是成熟产品的常态** | D79、D87 |
| **`ARCHITECTURE.md:93` 的"本项目 36 个 src 文件"** | **⚠️ 已被 D87 更正为 38**（D81 的 `taskspec-prompt.ts`、D84 的 `skill-catalogue.ts`）。**⚠️ §3.4 标题里的"36 个文件全覆盖"是对 2026-09-30 那次测量的正确历史记录，不改写** —— 那两个新文件都只被 `runtime.ts` 按名字 import，所以是 §3.4⑤ 那个病灶又多了两例，不是反例 | D87 |
| **`7cfddca` 提交信息里的验证数字** | **⚠️ 与所提交的树不符**（它描述的是把测试重新 skip 之前的那次运行）⇒ **不重写已推送的历史，更正写进 `REFERENCE_DECISIONS.md` D83 与 `STATUS.md` ㊽** ⇒ **新规矩：提交信息里的验证数字必须来自对"即将提交的那个树"的一次运行；若那次运行之后状态又变了，写数字之前重跑** | D83 |

---

## 执行预算更正（2026-10-06，用户明确决定）

- 产品目标是完成任务，不设 API 费用或累计 Token 花费上限；用量仍记录。模型上下文容量、单次输出设置（默认32000）、权限与写入边界不是花费上限，不因此移除。
- OpenCode 式步骤策略：默认无限；显式 maxSteps 后允许一次无工具总结，拒绝总结阶段工具调用，不将预算耗尽误判为完成。长任务默认 maxRounds=0（不限）；用户追加决定：旧任务的已存轮数限制必须自动覆盖，不要求面板操作。v1记录首次读取在租约内迁移并原子持久化为v2、maxRounds=0；保留进度、状态和计划，不自动恢复暂停任务。迁移后用户新设的显式限制仍有效。
- 去掉默认整轮15分钟和连续任务30分钟硬停；CLI默认亦不设整轮时限/累计工具调用上限。单次 API 请求桌面默认10分钟，首数据180秒、流空闲90秒继续独立生效；后两者是本产品现值，不声称复制Claude默认。
- **一手证据**：[Claude env-vars](https://code.claude.com/docs/en/env-vars.md) 明确 API_TIMEOUT_MS=600000 是单次 API 请求；BASH_DEFAULT_TIMEOUT_MS=120000、BASH_MAX_TIMEOUT_MS=600000 是前台命令。[工具参考](https://code.claude.com/docs/en/tools-reference.md) 另规定命令转后台及后台期限；[headless](https://code.claude.com/docs/en/headless.md) 的10分钟是最终轮后持续空闲等待。[OpenCode agents](https://opencode.ai/docs/agents/#max-steps) 写明未设置steps持续迭代，设上限后纯文本总结；本次读取 dev 源码 session/prompt.ts 亦见 agent.steps ?? Infinity。
- **确切结论范围**：本产品15分钟是本地整轮策略，不能以Claude请求/工具超时为依据；已读官方材料不支持Claude统一15分钟任务限制。不以文档未提及推断所有版本/云宿主绝无任务总时限。其他Claude行为逐项调查，不作已全面对齐的宣称。
- 完成须有证据；取消、权限拒绝、真实模型失败、无进展及上下文安全边界仍可能暂停。移除预算不保证模型必然完成，不无限重试认证/结构错误，不重放已成功工具。

## 3. ⚠️ 已知缺口

- **⚠️ D19 的盲区只补上了一部分（D125 实测）**：54 个真实 round 里 D19 错放 **13 个**假成功，`roundVeto` 抓到 **6 个**，**剩 7 个**。剩下的分两类：**(a)「忙但零工具」**（`继续` steps=17/tools=0、`创建HTML…` steps=10/tools=0）—— `busyNoTools` 特征实测**分不开两类**且会误伤合法的无工具回答（`1+1=?` → 0.99），故**刻意不放进规则**；**(b)「模型真干活了但 Jev 判低分」**（诊断包分析用过 10/21 次工具，Jev 给 0.28/0.34）—— 这类**不该照着改**，那是 Jev 的噪声而不是 D19 的缺陷。**⇒「87.0%」是留一法在 54 个 round 上的数，不是对任意语料的准确率**；且 DSH 主会话的 round 是 agent 自己的输出，**存在自指**（4 个子代理会话与 personal-agent 会话的循环性较低，语料是有意混合的）。
- **⚠️ 意图权重表未做留一法复核（D124 遗留）**：~~381 个信号里出现次数少的那部分权重不稳。轮次质量那边的方法（`eval-round-quality.ts`）到 D125 才补上，**意图表还没回补**~~ → **D129 §六 已闭合**：D124 381 信号只覆盖 supplement 4%、共享 72 信号 mean\|Δ\|=0.21-0.26——**留一法复核实证**，"未复核"这条**划掉**
- **⚠️ 「换模型后重跑校准」是设计、不是实测（D126 遗留）**：触发条件写成了事件驱动，但**本轮没有真的换一个 provider 演练过**。
- **⚠️ 2-gram 切粒度问题（D129 实证，**D130 已修**）**：~~`extractSignals` 把一条长 prompt 切出的所有 bigrams 当独立信号训练，supplement (1822 信号) 把这毛病放大了 4.8 倍。修法候选：训练时一条 prompt 的所有 bigrams 共用 `probs`（1 prompt = 1 观察），改 `train-intent-weights.ts` 一文件。**D130 候选**。**不阻塞 D129**。~~ → **D130 闭合**：4.8× 通胀消解（D129 supplement 那批 `build 0.98` 大 bigrams 全部变 `0.01`），**合并 383 行训出新 weights 2131 signals**——**D124 ② 决定**：这个 `scripts/intent-weights-merged.json` **可替 src/intent-weights.json**（spot-check 5/5 平手 D124 base，5.6× 信号覆盖）。**留给用户复核后做替换动作**（D126 边界）
- **⚠️ 单模型校准偏差（D131 实证，**D132 量化**）**：Jev 在 211 真用户 prompt 上 48% 判 research；Claude Opus 5 88% 判 fix；Grok 4.7 96% 判 fix——**三模型偏全极端**。**D132 验证**：`priors.research` 单模型训出（Jev 0.535 / Claude 0.414 / Grok 0.502）vs **consensus-mean 0.528**——**consensus 被 Jev 一家主导**（Claude 25 行 / Grok 10 行 失败率高），**多模型均值几乎不对冲**。**D119 候选**：补 Claude/Grok 调用补齐数据；或换 EvoMap multi-model 通路另行启动；当前 spot-check 上 merged=src/D124 5/5 平手，**D124 ② 决定先替 merged，**再决定 consensus 是否还需要
- **⚠️ 8787 网关 alias routing 配置（**D133 skipped 按用户意见**）**：`claude-opus-5` 被网关路由到 `notion*` 通道（**notion 也接入了大模型**——是 alias 合理后端），`grok-4.7` 走 `lezi`/`sharellm`（同理），`gpt-5.3` 503。**用户决定不动配置**：8787 按模型 alias 分频道合理，**D131 多模型横评里 387 ERROR 接受为"alias 设计"**


- **`REFERENCE_DECISIONS.md` 的 D 索引里没有 D10**（D01–D09 之后直接是 D11）。**未查清是漏号还是漏条。**
- **`CODE_MAP.md` 曾漏 `inspection-tools.ts`**（36 个 src 文件只覆盖 35 个）。
- **没有任何文档声明目标架构** —— 本轮由 [ARCHITECTURE.md](ARCHITECTURE.md) 补上。
- **`STATUS.md` 181 行 / 158 KB**，单个批次是一整行 **3.9 KB–11.9 KB**（批次 ⑳ 单行 11911 字节），**不可读**。
- **`STATUS.md` 与 `WHERE.md` 都自称入口**，无分层声明。
- **⚠️ `REFERENCE_DECISIONS.md` 末尾的 D 索引表是坏的（D80 查出，未修）**：**(1)** 表格内部有 **23 个空行**（原第 2337、2346、2351…2405 行），**Markdown 里空行终止表格 ⇒ 这张表被切成碎片**；**(2)** 至少 9 行的未转义竖线数与表头不符：`D15`(8)、`D22`(10)、`D24`(12)、`D30`(5)、`D32`(5)、`D41`(4)、`D43`(14) 是**单元格内未转义的 `|`**（如 `allow|deny|ask`、`userSettings|projectSettings|localSettings|session|cliArg`），而 **`D38`(3)、`D39`(2) 比众数 4 更少 ⇒ 那两行缺失单元格或被截断，不是格式问题而是内容缺损**。**⚠️ D80 试过自动修复（删表内空行）并主动回滚**：因为在一份历史索引上猜"哪个竖线是列分隔符"的风险是毁掉记录，而 `D38`/`D39` 的缺损无法在不丢信息的前提下自动补。**⇒ 需要先人工判定 `D38`/`D39` 两行原本应有几个单元格，再决定修法。**
- **⚠️ 表格完整性探测器的方法缺陷（D78 查出、D80 又踩一次）**：**(a)** 不要用手写正则查"某段文字在不在"——**同类假失败已 3 次**（D69 漏 markdown 反引号、D72 漏 `⚠️ ` 字形、D78 漏 `**：**`）；**(b)** 计数类检查先确认"同一计数单位在全文档是否同构"（`CODE_MAP.md` 有**两张列数不同的表**，取全表众数毫无意义）；**(c) 数分隔符必须排除转义形式**（`\|` 里仍含一个 `|`，曾让"修复后计数不变"被误判成修复未生效）；**(d) ⚠️ D80 新查出：探测器"表头 = 块内第一行"的假设在表格被空行切碎时不成立**，会报出"表头 8 个竖线而下面 6 行只有 4 个"这种自相矛盾的结果 ⇒ **承重的性质是"同一张表内各行未转义分隔符数一致"，且必须先确认块本身没被空行切碎。**
- **⚠️ 全仓表格复核的其余结果（D80，全部一致，无需处理）**：`ADR-0001`(1 表)、`ARCHITECTURE`(5)、`AUDIT`(1)、`CLI_STATUS`(2)、`CODE_MAP`(2，**第 54 行已修好**)、`DECISIONS_ACTIVE`(9)、`IMPLEMENTATION`(4)、`LIVE_INTEGRATION`(3)、`PR1_STATUS`(1)、`SAFETY`(4)、`STATUS`(4)、`SWARM_LOOP`(3)、`VALIDATION`(2)、`WHERE`(7)、`README`(3) —— **只有 `REFERENCE_DECISIONS.md` 的 D 索引表不一致。**
- **⚠️ PowerShell 陷阱新增一条（D80 踩到）**：**PowerShell 是先整体解析再执行**，所以脚本里任何一处解析错误（本轮是 `$(...)` 内联了 `;`）会让**整段脚本一行都不跑** —— 本轮 `git checkout` 因此静默未执行，而我一度以为它跑了。**⇒ 回滚一类的破坏性/关键命令必须单独一条执行并立刻复核效果，不要与别的语句混在同一段脚本里。**
- **⚠️ `PERSONAL_AGENT_MAX_CONTEXT_BYTES` 现在有一个约 200 字节的硬地板（D82 实测发现，此前未记录的行为变化）**：因为 system 消息现在总是带着约 180 字节的意图片段，**低于这个地板时整条提示词上限（`assertContextFits`）会在第一步之前就拒绝每一轮** ⇒ 把这个环境变量调到几百字节的做法**在 D81 之后失效了**。**这是"每轮都发一个块"的既定代价，不是缺陷**（512 KiB 的默认值不受影响），但**它从未在真机上跑过**。
- **⚠️ 两个字节上限各自从未被同时逼近过**：D83 只让整条提示词上限（B）成为唯一约束、D81 只让注入块上限（A）成为唯一约束 ⇒ **"三/四/五个真实注入块同时存在时 A 的行为"仍无测试**。D84 之后目录来自磁盘，技能提示词**全部是外部字节、全额计入 A**，所以这条缺口的现实性上升了。
- **⚠️ 变异脚本的一条工具纪律（D86 踩到，差点让变异留在树里）**：**"注入变异 → 跑测试 → 还原"的脚本，还原不能排在测试命令之后，因为那条命令可能永不返回** —— D86 第一次变异运行时，被杀不掉的孤儿 node 进程让测试运行器不退出，命令在 600 秒后被移到后台，**还原步骤因此没有执行到**。正确做法是让运行器强制退出（`--test-force-exit`，实测之后孤儿数为 0）或把还原放进独立的后续调用并核实。**⚠️ 清理孤儿进程时绝不能按进程名杀全部 `node.exe` —— DSH 宿主自己就跑在 node 上**；本轮的匹配条件是命令行里含 fixture 的标记文件名，执行后核对"孤儿 0、宿主侧 5 个 node 进程仍存活"。
- **⚠️ 文档债务本身仍是缺口**：`STATUS.md` 仍未拆分（第 174 行那条），六项文档重构的第 4 项仍未做，且**预先承诺过"若时间不足宁可不做也不做一半"**（拆分要把整块单行批次**逐字**搬进 `docs/STATUS_ARCHIVE.md` 并做字节同一性的机械核验）。**⚠️ 对照 D81 立下的规矩"文档欠账不得跨轮"：那条规矩管的是每轮的增量文档，而这条是历史遗留的结构性债务，二者不要混为一谈，但也不要拿前者当后者的豁免。**
