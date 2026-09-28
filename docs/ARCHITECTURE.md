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

## 3. 核心 / 插件划分（本项目 36 个 src 文件）

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
- **插件的分发格式**（是否要 bundle/profile/patch 三层，还是只要"一个目录一个插件"）**尚未决定**。DSH 的三层是为多 profile 分发设计的，本项目是否需要**未评估**。
- **迁移顺序**（26 个模块先移哪个）**尚未决定**。候选判据：先移已经有缝的（模型适配器），再移最独立的（`inspection-tools.ts`、`shell-tool.ts`），最后移最纠缠的（`runtime.ts`、`tools.ts`）。
- **零生产依赖是否仍能维持** —— 接缝层本身应当能用标准库实现，但**未验证**。
- **`node:sqlite` 与插件存储的关系**：D68 已验出 `engines: node >=22.6` 处需要 `--experimental-sqlite`（v22.13.0 起免除），且"只许 INSERT/SELECT"规则与"原子条件更新"不可兼得。**若任务状态成为插件并自带存储，这个决定归插件，不归核心。**
