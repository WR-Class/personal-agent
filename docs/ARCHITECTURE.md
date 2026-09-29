# 目标架构：小核心 + 一切皆插件

> **⚠️ 这份文档是规范性的（normative），不是描述性的。** 它写的是**产品应该是什么形状**，
> 不是**产品今天是什么形状**。今天的形状在 [CODE_MAP.md](CODE_MAP.md)，进度在 [STATUS.md](STATUS.md)。
>
> **每轮开工前必读这份与 [DECISIONS_ACTIVE.md](DECISIONS_ACTIVE.md)。** 这两份是防止跑偏的锚：
> 本项目 33 个批次里反复出现的偏离，机制性原因是**只有回溯文档、没有规范文档** ——
> 于是每一轮都从"最后读到的那个外部源"重新推导产品形态。有了锚，"偏"才有意义。
>
> **⚠️ 本文档描述的目标形态目前一行代码都还没有实现。** 任何把它当成现状来读的理解都是错的。

---

## 1. 目标形态

**核心小到只是"一个共享 context + 三类事件 + 按序组装的插件树"。连会话日志、工具注册表、模型适配器、agent 循环本身都是可替换的插件。**

依据是本轮实读的 DSH 架构文档（`D:\DSHXM\ZYZNT\_dsh_ref\docs_architecture.md:11-13`，只读未改）：

> *"Cordis is the framework under dsh: plugins contribute services, typed events, and reversible effects to a shared context. **Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration.**"*
>
> *"**There is no privileged core to patch**: you extend dsh by mounting a plugin beside the others, and **registrations are effects that unwind when their plugin unloads**."*

**SoL-Pi 是同一理念的第二个独立证据**（`D:\DSHXM\SoL-Pi\SoL-Pi\README.md:24,45-48`）：
*"SoL-Pi installs on top of an **unmodified** Pi release. Every mechanism is **opt-in and disabled by default**."*，四条共享规则是 **No Pi patches**（*"imports public Pi APIs and does not vendor the Pi source tree"*）、**Explicit opt-in**（*"A missing configuration leaves every mechanism disabled"*）、**Preserve evidence**、**Use Pi's runtime choices**（*"Authentication, provider URLs, the main model, and shell behavior remain under Pi's control"*）。

**⇒ 两个独立产品给出同一条判据：宿主核心不因插件而改变，插件不修改宿主源码，缺配置时插件等于不存在。**

### 1.1 操作员的原始表述（这是本节的要求来源，逐字保留）

> *"一切皆插件的理念像dsh一样。其实我理解的一切皆插件就是本身产品是一个小产品或者只是核心功能，但是其他的所有的东西都可以插件集成，只是设置好接口就好了。比如我想要dsh或codex或trae客户端也有的内置浏览器。我可以开发一个然后接口接到这个agent产品中就好了。我理解的一切皆插件就像积木一样所有的东西除了我这个核心外其他的都是可拼接的，其实就像pi一样，他也是很多东西没有其他的都是插件。"*

**"内置浏览器"这个例子给出了验收判据**：一个全新能力（浏览器）**不需要改动核心任何一行**就能挂上来，只靠实现约定好的接口。

---

## 2. 接缝层：三个接口

DSH 的核心包全部通过 `ctx` 键暴露服务（`docs_architecture.md:53-62`）。本项目需要的是同样形状的三个接口。

### 2.1 共享 context（服务注册与获取）

上游形状（实读 `dsh-lab/plugins/dsh-orchestrator/lib/index.js`）：

```js
export const inject = ['systemPrompt']              // 声明依赖哪些服务
ctx.provide('taskSpec', api)                        // 贡献一个服务
const presets = ctx.get?.('agentPresets')           // 获取别的服务
ctx.systemPrompt.section({ name, order, text })     // 贡献一个提示词段
ctx.on?.('agent/pre-step', handler, { prepend:true }) // 订阅事件
```

**本项目需要**：`provide(key, service)` / `get(key)` / `on(event, handler, opts)`，且**注册是可卸载的效果**（DSH 原文 *"registrations are effects that unwind when their plugin unloads"*）。

### 2.2 三类事件（扩展点）

`docs_architecture.md:66-70` 把扩展点分成三类，**并且说明选错域是多数改动里的第一个决策**：

| 类 | 上游 | 用途 | 本项目对应 |
|---|---|---|---|
| **Session events** | 追加进日志、经 `session/event` 广播 | *"Use one when the fact **must survive a reload**"* | `session-store.ts` 的事件种类（已有 `task-state`、`summary` 等） |
| **Agent events** | `agent/*`：inbox、step、status、request、validation、continuation | *"Use one to **observe or intercept work in flight**"* | **目前完全没有** —— 这是最大的缺口 |
| **Capability events** | `fs/*`、`tools/*`、`telemetry/*` | *"attach policy and adapters to a seam **without importing the loop**"* | **目前完全没有** —— 策略今天被 `runtime.ts` 直接 import |

**⚠️ turn flow 里最关键的一个钩子**（`docs_architecture.md:82`）：

```text
-> agent/pre-step      reject | enter(messages, startsRequestSeries?)
```

**`agent/pre-step` 的契约是 `reject` 或 `enter(messages)` —— 它可以改写进入这一步的消息。**

**⇒ 这正是操作员要的 TaskSpec 能力的落点**：*"应该是可以分析意图并匹配提示词或者组装一份好的提示词，如果有相应的skill应该匹配相应的skill如果没有就不匹配。然后发送给大模型。大模型实际读取更好更容易理解不是我的自然语言是机器语言或者说提示词。"* —— **一个 `pre-step` 插件返回 `enter(组装后的 messages)` 就实现了它，核心不需要知道有这回事。**

上游 `dsh-orchestrator` 已经是这个形状的实例（`index.js:37-48`：`ctx.on('agent/pre-step', …, {prepend:true})`，阻断时 `return { kind:'reject', reason:{kind:'taskspec-invalid', errors} }`）。

### 2.3 插件生命周期与组合

`docs_architecture.md:17-37`：

- 运行中的宿主是**启动时按有序层组装出的插件树**
- **profile** = home 里的命名组合，列出它叠的 bundle + 树外插件 + 用户自己的 patch 文件
- **bundle** = 配置行的分发格式，*"whatever it inserts stays patchable by the layers above it"*
- 每个在自己的 `package.json` 里用 `dsh` 字段自我声明（`dsh.profile` / `dsh.bundle`）
- 层序：profile 里列的 bundle → profile 的 patch → home 级 patch → `--patch` 覆盖
- **patch 按 id 定位一行，替换它的全部配置，或插入新行**
- `dsh --profile web --dump-config` ⇒ *"Any row it prints can be replaced by a patch of your own."*

**⇒ 可组合性与可诊断性是同一条要求：能打印出整棵树，才能替换其中任何一行。**

---

## 3. 核心 / 插件划分（⚠️ 本节测量于 2026-09-30，当时是 36 个 src 文件；截至 D84 实为 **38** 个，新增 `taskspec-prompt.ts`（D81）与 `skill-catalogue.ts`（D84）。**§3.4 标题里的"36 个文件全覆盖"是对那次测量的正确历史记录，不改写** —— 那两个新文件都不改变本节的结论：它们各自只被 `runtime.ts` 按名字 import，所以恰好是 §3.4 ⑤ 说的病灶又多了两例，而不是反例。）

**⚠️ 现状**：`src/` 下 **36 个文件全部平铺，没有任何子目录**，而 `IMPLEMENTATION.md:124-131` 提议的 `config/ policy/ approval/ execution/ runs/ skills/ plugins/` **一个都不存在**。

**按 DSH 的划分对照，本项目 36 个文件里只有约 10 个必须留在核心，其余 26 个都应当是插件。**

### 3.1 必须留在核心（接缝本身 + 策略地基 + 入口）

| 文件 | 为什么必须留 |
|---|---|
| `types.ts` | 消息与流词汇表 —— 插件与核心共同的语言 |
| `security-config.ts` | 路径策略与 canonicalization；`decide()` 的地基 |
| `file-policy.ts` / `rule-table.ts` / `trusted-roots.ts` | 单一优先级规则表（D31）；**策略必须是核心，否则插件可以给自己放权** |
| `config.ts` / `cli-config.ts` | 配置解析与 agent home 断言 |
| `session-lease.ts` | 租约（同一 agent home 不可双写） |
| `response-validation.ts` | 适配器响应的最小校验 |
| `bounded-read.ts` | 有界读取原语 |
| `cli.ts` / `interactive.ts` / `terminal.ts` | 入口（对应 DSH 的 profile 启动） |

### 3.2 应当移到接缝后面（第一批插件）

| 今天的核心模块 | 应成为 | 上游同类 |
|---|---|---|
| `session-store.ts`（41 KB） | **session 插件**（`ctx.sessions`） | DSH `core/session` —— **它在 DSH 里就是插件** |
| `tools.ts`（63 KB）+ `tool-environment.ts` + `write-tools.ts` | **tools 插件**（`ctx.tools`） | DSH `core/tools` |
| `runtime.ts`（58 KB） | **agent-loop 插件**（`ctx.agentLoop`） | DSH `core/agent-loop` —— *"The default driver implementing that interface"*，**"default" 意味着可换** |
| 散在 `runtime.ts`/`constraints.ts`/`task-state.ts` 的注入块 | **system-prompt 插件**（`ctx.systemPrompt.section`） | DSH `core/system-prompt`；上游 `dsh-orchestrator` 正是用 `section({name, order, text})` |
| `taskspec.ts`（4.6 KB） | **TaskSpec 插件** | 上游 `dsh-orchestrator` **本身就是插件** |
| `gene.ts`/`gene-store.ts`/`cycle.ts`/`cycle-store.ts`/`distill.ts`/`induct.ts`/`validation.ts`/`write-budget.ts` | **蜂群纪律层插件** | 上游 `dsh-swarm` **也是插件**（`SWARM_LOOP.md:173` 曾把 "Cordis 宿主" 列为不做，已撤销） |
| `constraints.ts`（8.8 KB） | **约束注册表插件**（提示词段） | `ctx.systemPrompt.section` |
| `task-state.ts`（17 KB） | **任务状态插件**（自带存储） | 上游 journal 由 `config.taskSpecJournalRoot` 决定 ⇒ **插件拥有自己的存储** |
| `inspection-tools.ts`（12 KB） | **只读检查能力插件** | capability events（`tools/*`） |
| `shell-tool.ts`（7 KB） | **命令执行能力插件** | capability events |
| `background-jobs.ts`（10 KB） | **后台作业插件** | — |
| `preflight.ts`（22 KB） | **预检插件** | — |
| `tiers.ts`（16 KB） | **权限档插件** | — |

### 3.3 ⚠️ 已经存在的唯一一条真接缝

**`openai-adapter.ts` / `echo-adapter.ts` 是可互换的模型适配器** ⇒ **本项目已经有一条真的接缝，只是只有这一条。** 它证明接缝层不是空想：**照它的形状把 `ctx` 与三类事件补出来，其余 26 个模块就有了可移入的位置。**

### 3.4 ⚠️ 实测：地基形状是对的，错的是扩展方向（2026-09-30，脚本建 import 图，36 个文件全覆盖）

**上面 §3.1/§3.2 的划分是判断，不是测量。以下是对 `src/` 全部 36 个文件解析 `from "./x.ts"` 的实测结果。**

**① 零循环依赖。** 36 个文件的内部 import 图**无环**。这一条决定性地回答了"是否在错误的地基上建造"：**纠缠的地基拆不成插件，无环的可以。**

**② ⚠️ `ModelAdapter` 不是"接近接缝"，它就是一条教科书式正确的接缝。** 实测三项：

| 探针 | 结果 |
|---|---|
| `types.ts` 导出 | `Role, ToolCall, ChatMessage, JsonSchema, ToolDefinition, ChatRequest, ChatUsage, ChatResponse, **ModelAdapter**` ⇒ **接口与词汇表同在核心** |
| `runtime.ts` 是否直接 import 具体适配器 | **`openai-adapter` = false，`echo-adapter` = false** ⇒ **循环只依赖接口** |
| 谁挑具体实现 | **`cli.ts`**（组合根）：`if(options.echo) adapter=createEchoAdapter()` |

**⇒ 这正是 DSH `llm/llm` 的形状：循环依赖接口，组合根挑实现。** `ToolRegistry` 是第二条真接缝（`constructor(available?)` + `has()` + `definitions()` + `execute()`，缺席在两个方向一致强制）。

**③ ⚠️ §3.2 有三个模块被我分类错了，此处更正（原文按规矩保留）。** `gene.ts`、`cycle.ts`、`task-state.ts` 被列为"应当移到接缝后面"，但**实测它们的内部被依赖度是 8 / 6 / 5，且依赖方包含核心模块**：

```
session-store.ts -> session-lease.ts, security-config.ts, types.ts, gene.ts, task-state.ts
file-policy.ts   -> gene.ts, rule-table.ts, write-tools.ts
tools.ts         -> … session-store.ts, task-state.ts
```

**⇒ 会话日志与策略层已经认识两个"本该是插件"的东西。这不是"移过去很便宜"，是词汇表泄漏进了核心。** 修法就是 `ModelAdapter` 已经用的那个：**共享词汇（类型）进 `types.ts`，行为留在外面。**

**④ 一个真正封闭的扩展点。** `session-store.ts` 的 `migrateEvent` 是 **8 个 case 的 switch** ⇒ **新增事件种类必须改核心**。DSH 的 session events 是开放的（插件可追加种类），这一处不是。**这是"特权核心"最具体的一个实例，也是任务状态这类功能每加一个都要碰核心的原因。**

> **✅ 已修（D71，提交 `7542367`）：`migrateEvent` 前面接了一层运行时"种类→处理器"注册表**（`registerEventKind(kind, handler) → disposer`、`registeredEventKinds()`），**既有 8 个 case 的 switch 一行未改**，所以既有种类的校验逻辑零改动、回归面为零。**⚠️ 但本节说的"封闭"只修掉了一半，必须如实说清**：运行时开放了，**类型侧仍然封闭** —— `ExternalSessionEvent` **故意没有进 `SessionEvent` 联合**，因为加进去实测会让 8 处按 `event.kind === "…"` 收窄的地方全部编译失败（开放成员的 `kind` 是 `string`，与所有字面量重叠，TS 无法排除它），其中 `inspect` 的工具批次审计是 `tool/call || tool/result` 的**析取**收窄后读 `callId`/`name`/`arguments`，为买类型层便利去改写一处安全校验不划算。改法是**两个集合分开**：`InspectionResult.events` 只装核心认识的种类，`.external` 装注册进来的（**连行号一起，什么都没丢**）。**⇒ 这是 D70 那条教训在第二个位置复现**：`docs_development.md:56` 记 DSH 因"两侧声明合并同一个 `Context` 键会碰撞"而拆成两个 tsconfig 聚合，我当时写"本项目单 program 所以不可达"，**实测证明开放类型的代价只是换了个位置，落在收窄点上。**

> **✅ 第 ① 步已落地（D72 决定 / D73 实现，提交 `4b699b2`）：`external` 的消费者已定为 DSH 的 Projection seam，且三角色齐备。** `docs_architecture.md:113` 的 *"registered units fold committed events incrementally, host consumers read one typed state with `stateOf()`"* 已按 `:117` 的三角色实现：**Definition** = `SessionProjectionUnit<S> = {key, initial, fold}`；**Provider** = `registerSessionProjection(unit) → disposer`，核心在模块作用域注册自己的 `taskState` 单元；**Consumer** = `store.stateOf<S>(sessionId, key)`，既有 `taskState()` 已改成它的一层薄封装。**⇒ D71 那个"存在但未被使用"的注册表因此有了第一个调用方，两轮合成一条链。**
>
> **⚠️ 三点必须连着读，否则会误判进度**：**(1) 折叠仍是每次全量，不是 `:113` 说的 `incrementally`** —— 增量是 D72 第 ④ 步，与恢复 `latestMarks` 的一趟优化绑在一起，**本轮有意偏离并记在 D73 第四节，不是漏做**；**(2) `latestMarks`/`buildPrompt` 原样未动**，所以那一趟"读两样"的优化没被拆散（D72 第四节 (4)）；**(3) 校验位置未动** —— `case "task-state"`（`session-store.ts:511`）仍在核心 switch 里，搬进 provider 是第 ② 步，**所以核心 switch 目前仍是 8 个 case，本节 ④ 说的"封闭"只解掉了运行时的注册一侧**。
>
> **⚠️ 写路径的安全性质比计划提前到手**：D72 把"投影缺失即拒绝写入"排在第 ③ 步，实测发现 `appendTaskState`（`session-store.ts:850`）调的就是 `taskState()` ⇒ 第 ① 步就自动覆盖了。**但第 ③ 步没有因此完成**：它真正剩下的部分是"增量折叠之后写路径还能不能拿到前一份状态"，那是第 ④ 步改了折叠方式才会出现的问题。

> **⚠️ 修正（D74，有代码）：上一段交付的接缝两半其实没有接上，已修。** D71 的 `registerEventKind` 让外部种类落进 `InspectionResult.external`，而 D73 的 `stateOf` 只折叠 `events` ⇒ **一个插件即使同时注册了种类和投影，它的投影也永远收不到自己那个种类的任何事件，`stateOf` 恒返回 `initial`，而两处注册都列得出来、所有测试都通过 —— 正是本节反复引用的 D60 形态**。已修为**按行号归并 `events` 与 `external`** 后折叠（`fold` 参数放宽到 `SessionEvent | ExternalSessionEvent`，核心 provider 改用 `"atMessage" in event` 收窄）。**⇒ 这是本节 ④ 那张 D71 账单的第一处实际支出：仅仅放宽 `fold` 参数就让 1 处既有测试编译失败。**
>
> **⚠️ 第 ② 步现在被阻塞，等一个裁定，本节不预设结论。** D72 第 ② 步说"把 `case "task-state"` 的校验搬进 provider，完成之后核心 switch 少一个 case"，实读查出三层级联，**其中第 2 层是硬阻塞**：`task-state` 移出 switch 就必须走外部路径落进 `external`（第 1 层，本轮已修通），而 `TaskStateEvent` 要退出 `SessionEvent` 联合才能算真的移出核心 ⇒ **正好撞上本节 ④ 记录的那 8 处收窄失败，含 `inspect` 的工具批次安全校验，而 D71 当时明确拒绝付这个代价**。第 3 层（`latestMarks` 一趟优化）其实可解 —— **优化省的是"两次读日志"，不是"一个循环"**，把 `external` 并进同一趟不破坏它。
>
> **两条候选路线（D74 第五节，待操作者裁定）**：**甲** 接受 D71 的账单，让 `TaskStateEvent` 退出联合并逐个修那 8 处 ⇒ 本节 ④ 说的"新增事件种类必须改核心"这个特权核心实例**真的被消掉**；**乙** 换判据，承认"核心自己消费、且带单调性安全性质的种类"就该留在核心 switch，把注册表 + 投影留给真正外部的种类 ⇒ **D72 第 ② 步作废，核心 switch 稳定在 8 个 case，而本节 ④ 需要连带修订**（因为它现在把"8 个 case"判为缺陷）。**⚠️ 乙与 §1 的目标形态（小核心 + 一切皆插件）有张力，但与 `docs_architecture.md:113` 没有冲突** —— DSH 的 `SessionEventMap` 也是核心自己拥有的类型，插件靠声明合并扩展它，而 D70/D71 已把声明合并降级为可选。**作废一条已记录的决定并修订本规范文档，不由我单方面做（对照 D61 的处理方式），所以本节两条并列、不标倾向。**

> **⚠️ 修订（D77，有代码）：操作者已裁定丙，本节"类型侧仍封闭"这句话现在只对了一半。** 已落地的是：`session-store.ts` 新增 `export interface SessionEventMap`（8 个内置种类，键为种类字面量、值为既有事件接口），`SessionEvent` 改为 `SessionEventMap[keyof SessionEventMap]` ⇒ **类型表现在可被声明合并增广，一个插件种类可以带着自己的字面量加入 `SessionEvent`**。**本节 ④ 那个判断（"新增事件种类必须改核心，这是特权核心的实例"）因此不再成立**：新增种类现在可以只写一份 `declare module` 增广 + 一次 `registerEventKind`，**核心一行都不用改**。
>
> **⚠️ 而"仍封闭"的那一半也仍然成立，必须连着读**：**`ExternalSessionEvent` 这个 `kind: string` 的兜底成员还在，`InspectionResult.external` 还在，D74 的行号归并还在，`migrateEvent` 的 8-case switch 一个 case 都没少。** 删兜底成员意味着把 `registerEventKind` 收紧成"注册即增广"，那会作废 D71 已落地的形状与它那 9 项测试（它们在运行时注册 `"probe/lying"` 等种类而不做增广），并让 D74 的归并成为死代码 —— **一次涉及三处已记录决定的联动改动，D77 刻意没有与"让类型表可增广"挤在同一轮。**
>
> **⚠️ D77 实测到的、本节必须记住的一条**：`tsconfig.json` 的 `include` 覆盖整个 `test` 树，所以**测试文件里的增广在编译 `src/` 时可见 —— 这就是 `docs_development.md:56` 说的"一个 program 看到两侧的合并"，发生在我们自己的单程序里**。实测 `tsc --noEmit` **退出码 0、错误数 0** ⇒ **带自己字面量的合并成员不污染那 8 处收窄**。**⇒ 本节此前引用的 `:56` 冲突与 `:58-60` 三条纪律，是 DSH 那种多聚合程序场景的需要；本项目单程序布局由每轮必跑的 `tsc --noEmit` 直接覆盖，冲突真发生时是 `TS2717` 编译期硬错误（D77 变异 C 已在本仓库复现），不是静默的类型腐坏。**
>
> **⚠️ 但 D77 也量出丙的一处真实代价，本节不能只记好处**：`SessionEventMap[keyof SessionEventMap]` 是索引访问、**只取值不取键** ⇒ **键名与成员的 `kind` 字面量之间没有任何强制关系**，插件可以增广出"键与 `kind` 对不上"的成员而 `tsc` 不报错。**D76 那个映射类型派生写法不会有这个问题（它从键派生 `{kind: K}`），所以这是本轮选最简形式付的代价，不是免费的。** 记为已知弱点；若将来 `registerEventKind` 收紧成 `K extends keyof SessionEventMap`，键名会成为运行时注册的一部分，不一致会立刻在注册处暴露。

> **⚠️ 修订（D79 + D87，无代码）：上面 :174 那段"待操作者裁定"已过期，:174 与 :178 各有一句话被 D79 撤回。原文保留不改写，更正记在这里。**
>
> **① :174 的"待操作者裁定"已被裁定并落地。** 操作者裁定的是**丙**（*"行，可以。做吧"*），落地为 D77（提交 `c91e8f3`），也就是 :176-182 已经记的那件事。**⇒ 甲/乙 两条候选都不再是待决项**：甲要付的账单（让 `TaskStateEvent` 退出联合、逐个修 8 处收窄）没有付，乙要换的判据也没有换 —— **丙走的是第三条路：类型表可增广，核心 switch 一个 case 都不动。** 一个从 :174 读起的人会先读到"待裁定"再读到"已裁定"，**这个顺序本身就是缺陷，所以在本块首句点明。**
>
> **② ⚠️ :174 那句"D70/D71 已把声明合并降级为可选"被 D79 撤回，:178 那段随之作废。** D79 实读了 Cordis 的**真 TypeScript 源码**（在 `app.asar` 里，`dsh/node_modules/@assistant-ai/cordis/src/*.ts`，**不是编译产物、不是博客转述**），逐字证据：**`registry.ts:107-108` `provide?: string | string[]`（运行时侧完全不约束）**；**`:19,22-23,37` `Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }` / `InjectKey = keyof {…}` / `function Inject<K extends InjectKey>(name: K, config?: …)`（只有消费侧受约束）**；**`:164` `declare module './context.ts' {`**。**⇒ 成熟产品的形状是"运行时开放 + 类型侧可选增广"，而这正是本项目 D77 之后的形状**（`SessionEventMap` 可增广、`ExternalSessionEvent` 的 `kind: string` 兜底仍在）。**⚠️ 因此"注册时是否必须增广"这个问题是一个伪选择，D79 已明确撤回** —— :178 那段"删兜底成员意味着把 `registerEventKind` 收紧成'注册即增广'，那会作废 D71 已落地的形状与它那 9 项测试"**作为一个待决问题不再存在**：兜底成员**就该留着**，因为它正是 Cordis 那个 `provide?: string | string[]` 的对应物。**⇒ D70 那句"声明合并是可选的"的措辞也需按此读：可选不等于次等，它是成熟产品的常态。**
>
> **③ ⚠️ 本节必须落的一条设计约束（route 丙 剩下的第 ① 项，此前只记在 `REFERENCE_DECISIONS.md` 里，没有进规范文档）**：**`migrateEvent` 的 `default` 分支必须保持 D71 的形状 —— 注册表路由 + 对 `ignorable` 种类返回 `null` + 对未知种类抛错 —— 绝不能换成 `assertNever`。** 理由是 D76 的 P5 探针**实测**的结果，不是推理：**`assertNever` 对一个已在运行时注册、但类型侧没有增广的外部种类会在运行时抛错**，也就是说它会把"插件合法地贡献了一个种类"变成一次崩溃。**⚠️ 若将来确实想要对那 8 个内置种类的穷尽性检查，做法是另立一个只覆盖这 8 个的窄类型来做 `assertNever`，而不是把这个检查加在承担外部种类路由的那个 switch 上** —— 一个 switch 不能同时是"开放扩展点"和"封闭穷尽检查"，**这两个性质在同一个 `default` 上互斥。**
>
> **④ ⚠️ :182 记的那处真实代价仍然成立，且 D79 补了一条旁证**：`SessionEventMap[keyof SessionEventMap]` 是索引访问、只取值不取键 ⇒ **键名与成员的 `kind` 字面量之间没有强制关系**。**D79 查到 Cordis 同样不强制 name == key** ⇒ **这是一个家族级的取舍，不是本项目独有的疏忽**，故仍记为已知弱点、**在真有第三方插件撞上它之前不修**（修法已写在 :182：把 `registerEventKind` 收紧成 `K extends keyof SessionEventMap`，让键名成为运行时注册的一部分）。

**⑤ 真正的病灶：组合根与循环按名字硬 import。**

| 文件 | out-degree | 含义 |
|---|---|---|
| `cli.ts` | **23** | 几乎 import 全部模块（组合根本应如此，但它同时也是唯一挑实现的地方） |
| `runtime.ts` | **16** | `constraints`/`task-state`/`taskspec`/`write-budget`/`validation`/`gene-store`/`cycle-store`/`cycle` **全部按名字直接 import** |
| `tools.ts` | **12** | 含 `inspection-tools`/`shell-tool`/`background-jobs`/`task-state` |

**⇒ DSH 那句 "There is no privileged core to patch" 在本项目不成立：要让任何东西成为插件，都得先改 `runtime.ts`。这就是"特权核心"。**

**⑥ 结论（对"是否在错误的地基上建造"的回答）**：**不是。** 无环 + 两条已存在且正确的接缝 = **地基形状是对的**。**错的是扩展方向** —— 核心按名字硬 import，所以新增能力必须改核心。**那是一个窄得多、也便宜得多的问题：把 `ModelAdapter` 已被证明的模式推广出去，而不是发明新框架。**

**⑦ ⚠️ 因此 §5 的第一条"接缝的具体签名尚未设计"已被本轮测量推翻**：签名已经存在（`ModelAdapter`），并且已经在一个地方被正确使用。**再设计一套新接口就是重造代码库里已有的东西。**

---

## 4. 与既有决定的一致性

- **D13**（已撤回重定向）：*"第一批把'蜂群 worker'实现成了子代理扇出工具（`dispatch_workers`，提交 `5e0e039`），**用户判定这不是蜂群**，方向确认为**纪律层**"* ⇒ **蜂群是纪律层，与本文档一致：它是一个插件，不是核心的多 agent 框架。**
- **D14**（用户二次纠偏后确认）：*"蜂群 = **基因库 + RSI 闭环**，PDRI 是骨架不是核心"* ⇒ **本文档不改变它。** 插件化只决定"蜂群建在哪一层"，不决定"蜂群是什么"。
- **D01**：*"独立TS内核，CLI/Runtime分层，**无DSH运行依赖**"* ⇒ **⚠️ 这条仍然有效，且与本文档不冲突**：要借鉴的是**接缝的形状**（context / 三类事件 / 可卸载注册），**不是引入 Cordis 运行时依赖**。零生产依赖的取向不变。
- **ADR-0001**（会话事实来源）⇒ **session 插件化不得动摇"日志是唯一事实源"**：插件可以拥有自己的存储（如任务状态、周期账本），但**对话事实只在会话日志里**。
- **`IMPLEMENTATION.md:112`**：*"这三项不是 Skill，也不把 DSH、蜂群或 SoL-Pi 原样接进来。借鉴机制，运行时仍是 `personal-agent` 自己的。"* ⇒ **⚠️ 这句话被我在执行中读成了"直接写进核心"的许可证，那是误读。** 它的原意是"不原样接进来"（不引入 Cordis/DSH 依赖），**不是"不做接缝层"**。本文档是对这句误读的更正。

---

## 5. ⚠️ 本文档不决定的事（如实记录）

- **接缝的具体签名**（`provide`/`get`/`on` 的类型、事件负载形状、卸载语义）**尚未设计** —— 本文档只定形状与划分，不定 API。
  **⚠️ 本条已被 §3.4 的实测部分推翻（2026-09-30）：`ModelAdapter` 的签名已经存在且已被正确使用（接口在 `types.ts`，`runtime.ts` 不 import 任何具体适配器，`cli.ts` 挑实现）。⇒ 待设计的不是"签名"，而是"把这个已被证明的模式推广到哪几处"。** 仍未设计的只剩 `on(event, …)` 的事件负载形状与卸载语义 —— 而这两项**在没有第二个消费者之前属于推测需求**。
  **⚠️⚠️ 上一行末尾那句"属于推测需求"也已被推翻（D69，同日，见 [REFERENCE_DECISIONS.md](REFERENCE_DECISIONS.md) 的 D69）。写出它时我没有读过 `docs_cordis-primer.md`（45 行）与 `docs_architecture.md:91-150`，是用没读过的东西否决了它。** Cordis 早已给出答案：**事件负载形状** = TypeScript 声明合并 + `@mode` 标签；**卸载语义** = `ctx.effect()` 返回 disposer，*"If teardown order matters, keep the related work in one effect so disposal unwinds in the intended sequence"*；**加载顺序** = `inject` 声明服务需求，*"load order is expressed through service requirements rather than manual boot sequencing"*。**⇒ 这三项不是待设计，是待采用。**
- **⚠️ 本节其余各条的状态（D69 补读后）**：
  - **"插件的分发格式"** —— **可以确定地拒绝 loader/overlay 三层**，而且这次是读过之后拒绝：`docs_cordis-primer.md:39` 原文自己就是条件句 *"**Use overlays when the environment selects plugins.**"*，profile/bundle/patch 服务于多 profile 分发（`web`/`headless`/`sdk`/`acp`），本项目一个 profile 都没有。**不做它与源一致。**
  - **"迁移顺序"** —— **`:117` 给出了判据**：*"A seam is a swappable capability with three roles: a Service Definition… a Service Provider… and a Consumer… **one role alone is not a seam; adding a capability means designing all three**"* ⇒ **每处迁移必须同时设计三角色**，我上一轮"推广 `ModelAdapter` 到 tools"的说法按此不完整。
  - **"任务状态的存储归属"** —— **`:113` 的 Projection seam 已给出答案形状**：*"registered units fold committed events incrementally, host consumers read one typed state with `stateOf()`"*，且 *"A host reader either requires this service during activation or **fails explicitly** when the registry or required key is absent"*（**不静默默认**）⇒ **D67 名次 1 的"读时折叠"是 DSH 已出厂的接缝**，三轮研究重新发明了它。
  - **⚠️ `node:sqlite` 应当再降**：`:109` 证明 DSH 自己就是 **JSONL + zstd + 版本化 generation + 相邻单步迁移**，且 *"committed generation paths are never renamed, replaced, or deleted"* —— **一个成熟产品在同样问题上没有选 SQLite**，且与 D68 的 INSERT-only 规则同向。
- **⚠️ 新增未决项（D69）**：`migrateEvent` 的 8-case 封闭 switch **可以**照 `:143`（*"Add durable session state → extend `SessionEventMap`"*）+ 声明合并改成开放扩展点。**但本项目是 `node --experimental-strip-types` 直跑 TS，声明合并在此模式下的可用性未验证** —— 这是采用前必须先测的一条。
- **插件的分发格式**（是否要 bundle/profile/patch 三层，还是只要"一个目录一个插件"）**尚未决定**。DSH 的三层是为多 profile 分发设计的，本项目是否需要**未评估**。
- **迁移顺序**（26 个模块先移哪个）**尚未决定**。候选判据：先移已经有缝的（模型适配器），再移最独立的（`inspection-tools.ts`、`shell-tool.ts`），最后移最纠缠的（`runtime.ts`、`tools.ts`）。
- **零生产依赖是否仍能维持** —— 接缝层本身应当能用标准库实现，但**未验证**。
- **`node:sqlite` 与插件存储的关系**：D68 已验出 `engines: node >=22.6` 处需要 `--experimental-sqlite`（v22.13.0 起免除），且"只许 INSERT/SELECT"规则与"原子条件更新"不可兼得。**若任务状态成为插件并自带存储，这个决定归插件，不归核心。**
