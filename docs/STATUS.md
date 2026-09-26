# 项目当前状态（唯一阶段入口）

最新批次：**偶发测试失败根因定位与修复**（两层原因：测试自身把含墙钟 `用时` 的完整输出按字节比较；Windows 临时端口分配器会给出 fetch 一律拒绝连接的禁连端口。修复后 6 路并发 × 3 轮共 18 次全量运行 **0 失败**；顺带修复适配器吞掉传输失败真实原因的问题）。此前批次：版本控制与 CI、SSE 流式传输、推理可见性、`--preflight` 联调准备检查、持久性语义、PT04 路径收敛、PT06 审计重复检查、按模型窗口与剩余量显示、可注入 tokenizer 精确预判、摘要保真压缩、本机 socket 与真实端点 Provider 联调。原文档统一基线：2026-09-24。此文件负责阶段/剩余任务；其他主文档负责各自专题，批次记录保留历史证据。后续每批实现必须先更新本表。

## 定位

**当前处于 M2。** M1 已于 2026-09-25 验收。M2 的单文件修改和批量清单已落地，但 M2 还未收口。M3 及以后未开始。不是 API 代理，不依赖 DSH 运行时。

正常入口仍为 `npm.cmd start`。用户已确认上一版 CLI 实际运行没有问题；这不是所有 Provider/操作系统/取消与密钥输入组合均已验证的声明。

## 阶段矩阵

| 阶段 | 当前状态 | 范围 |
|---|---|---|
| M0 源码审查/文档基线 | 已完成；本次已统一主文档 | 当前地图、A01–A17 修复映射、参考证据、阶段门槛 |
| M1 可靠只读 Runtime | 用户已确认验收（2026-09-25） | 安全基线、交互 CLI、响应校验、正常取消、合作单 writer、有限恢复、推理可见性、SSE 传输、Git 与已实测的 GitHub Actions CI |
| M2 权限与受控文件修改 | **已收口** | 六个文件操作共用批准。grant 匹配工具、参数和到期时间。写入前复查路径。拒绝与过期写入 `audit` 事件 |
| M3 受控进程工具 | 未开始 | 无 shell，无 OS sandbox |
| M4 Skill/插件 | 未开始 | 无 Manifest/宿主/不可信插件隔离 |
| M5 客户端与记忆 | 未开始；CLI 可用性提前交付 | CLI 不等于桌面 UI、流式协议、长期记忆 |
| M6 多 Agent | 未开始 | 无 fork、任务调度、并发文件冲突管理 |

## M1 分项状态

| 工作包 | 状态 | 已落地 | 未完成 |
|---|---|---|---|
| PR1 安全基线 | 首批完成 | env 白名单、真实路径/保护根、敏感读取、非只读拒绝、保留 fixture | OS 隔离非本批目标；真实子进程与恶意竞态不作保证 |
| PR2 协议边界 | 部分完成 | unknown响应校验、拒绝明确length/content_filter、配置读写字节限额一致、事件字段/用量/header校验、工具参数按受支持Schema子集校验（不支持关键字明确拒绝） | 角色判别联合、完整JSON Schema语义、未知用量与0区分、更多负向协议测试 |
| PR3 会话一致性 | 部分完成 | wx header、跨实例/进程合作锁、尾行检查、工具组显式补齐、每事件 flush 与其失败上抛、重复 `tool/call` 审计记录拒绝、压缩边界=实测消息数 | 完整 Run/Step/Call 身份与状态机、单一回放事实/事务、完整迁移 fixtures；flush 不等于目录项持久化，也**未实测真实断电** |
| PR4 取消与预算 | 部分完成 | 预取消、循环边界检查、未开始工具不执行、正常取消补齐关联、HTTP响应1MiB与文件读取256KiB硬字节上限、总 deadline、每轮/每步工具数、字节+实测token双上限、按模型窗口、可选本机 tokenizer 预判、剩余量显示 | 未内置分词器（可注入，需宿主自备）；无按模型字节窗口；provider 上报值只能晚一轮生效 |
| PR5 工程化 | 部分完成 | 交互入口、帮助、控制字符转义、明确 TS 测试入口、文档同步、`/compact`、`/status`、`--preflight`、Git、GitHub Actions（Windows + Node 22.x/24.x 首跑成功） | 发行构建与非 Windows 平台验证未做；无真实 TTY 自动化（未使用 pty）；只测了 Node 22.23.3 与运行器上的 22.x/24.x，不是 22.6 下限本身 |

## 当前执行队列

只按这个顺序继续，不再每轮重新选择：

1. **M2 已收口**：写入前复查路径；保护目录在批准前拒绝；拒绝和过期写入 `audit` 事件。
2. **TaskSpec 已完成**：`sendTurn` 在写任何日志之前生成带版本的确定性 spec（原输入、目标、意图、运行时模式），随 `SendResult` 返回；缺目标记 unknown、不编造模式；强制拒绝默认关闭（`enforceTaskSpec` 可打开）。证据与取舍见 D12。
3. **蜂群 worker 已完成（第一批）**：`dispatch_workers` 一次精确批准后分派 1–2 个只读 worker。每个 worker 是全新 `AgentRuntime`：独立会话与上下文、注册表只有 `read_file`（写工具结构性不存在，不能递归分派）、各自记 TaskSpec（D12）、失败单独报告、继承父 signal。证据与取舍见 D13。已知限制：worker 的 token 花费记在 worker 自己的会话里，不进父预算。
4. **SoL-Pi**：接一个只读能力，走现有 Schema、Policy 和批准。

讨论只在某一项的机制改变时发生。机制未变就继续下一项，不把选择权丢回对话。

## 研究、方案与阶段证明

| 用途 | 文件 |
|---|---|
| 成熟产品调研和采用/拒绝决策 | `REFERENCE_DECISIONS.md` |
| 当前阶段的实施方案 | `IMPLEMENTATION.md` |
| 当前进度 | `STATUS.md` |

开始新阶段前，先在 `REFERENCE_DECISIONS.md` 增加一条：读过的源码路径、采用的机制、明确不采用的机制。没有这条记录，不改该阶段代码。

## 每轮文档更新

只更新受影响的文档：

| 变化 | 更新 |
|---|---|
| 阶段、进度、执行队列 | `STATUS.md` |
| 新增、删除或改了代码行为 | `CODE_MAP.md` |
| 安全边界、权限、批准或拒绝规则 | `SAFETY.md` |
| 采用或拒绝一个外部机制 | `REFERENCE_DECISIONS.md` |

一次改动可以同时命中多行。纯文档措辞修正只改那一份。历史批次文档不回写。

## 仍未完成但不阻塞当前队列

- 取消中的轮次不打印用量和耗时。
- 默认 Agent home 仍在项目树内。
- 无发行构建、无非 Windows 验证、无外部托管 Provider、无自动化 TTY。

不因测试数量增长宣布整个 M1 完成，不直接跳到 shell/蜂群。每项具体实施顺序见 [IMPLEMENTATION](IMPLEMENTATION.md)。

**阶段入口规则：** 开始任何一个新阶段之前，先讨论该阶段要参考的材料、采用什么、不采用什么、和当前实现的差别。讨论未完成不改代码。M1 已按此规则看过 Atlas 的循环、提示结构和运行约束，结论是现在不改这三项。

## 证据与文档导航

- [CODE_MAP](CODE_MAP.md)：当前 16 个源码模块与完整调用链，不再使用最初快照行号。- [AUDIT](AUDIT.md)：A01–A17 原始风险摘要、当前修复/残余及源码/测试映射。
- [REFERENCE_DECISIONS](REFERENCE_DECISIONS.md)：研究证据与实际采用程度分开。
- [SAFETY](SAFETY.md)：当前有效保护与限制。
- [VALIDATION](VALIDATION.md)：历史各批证据及本次复核限制。
- [联调 Runbook](LIVE_INTEGRATION.md)：真实 Provider/实体 TTY 的分步操作与证据要求。
- 历史批次：[PR1](PR1_STATUS.md)、[CLI](CLI_STATUS.md)、[会话可靠性](SESSION_RELIABILITY.md)。其中的测试数/“尚未实现”描述属于该批时点，当前阶段以本表为准。

最新实际验证：207 tests，206 pass、0 fail、1 skip（skip 是 Windows 无权限创建符号链接，按跳过计，不计为通过）；**并发稳定性：6 路并发 × 3 轮 = 18 次全量运行 0 失败**（修复前 4 路并发 12 次运行出现 6 次失败，根因与证据链见 [VALIDATION](VALIDATION.md)）；类型检查通过；真实端点冒烟通过（非流式与 `--stream` 两条路径渲染结果逐字相同；流式下完成一次**真实工具往返**；推理在答案之前打印、预算行含 `推理 N`、日志含 `reasoningTokens` 而不含推理文本）。本批同时修正了两处由冒烟发现的缺陷：一次性模式下回答曾被打印两次（重构时残留的重复 `write`）；`--preflight` 在 tokenizer 命令无法运行仍报告"可以尝试"且 exit 0，以及把 Windows 非 UTF-8 的 stderr 当 UTF-8 打印成乱码。本批新增：**每事件 flush**（`openAppend`/`sync` 接缝，测试计数 sync 次数并让失败上抛，`relaxed` 模式可对照）、**PT04 路径收敛**（删除 `resolveInside` 与重复的 `isInside`，`read_file` 只经 `assertReadablePath` 一处判定，原覆盖迁移到该实现）、**PT06 审计重复检查**（第二个同 id `tool/call` 被拒并报出其行号）、**按模型 token 窗口**（精确模型名 → `*` → 全局；畸形配置在构造与环境解析处即拒绝）、**剩余量显示**（未实测打印为“未测量”，超限打印为“超N”而非负剩余）、**可注入 tokenizer**（`countPromptTokens`；CLI 为 `PERSONAL_AGENT_TOKENIZER` 命令，失败/超时/非数字一律报错，不静默退回估算，不内置分词器）、**摘要保真压缩**（`summary` 事件记录 `covers`，原始消息全部保留，边界等于实测消息数，未完成工具批次与空摘要一律拒绝）、**本机 socket Provider 联调**（真实 HTTP + 真实 `fetch` + 真实 abort + 真实 CLI 记录，密钥不入 stdout 亦不入日志）。会话格式已按 [ADR-0001](ADR-0001-session-fact-source.md) D1–D4 落地；参考来源与不采用项见 [REFERENCE_DECISIONS](REFERENCE_DECISIONS.md)。历史记录见[VALIDATION](VALIDATION.md)。[Ponytail审查与整改状态](PONYTAIL_REVIEW.md)的 PT01–PT07 已全部处理。
