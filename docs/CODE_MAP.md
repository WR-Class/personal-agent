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
| [cli.ts](../src/cli.ts)：parseArgs/main | --help/--echo/参数校验、单次或交互入口、组装依赖、活动显示、预算标志与环境变量 | 不是 UI 框架；无 prompt 时进入交互 |
| [cli-config.ts](../src/cli-config.ts)：providerConfig/loadProvider/saveProvider/configureProvider | HTTP(S)配置校验、向导、显式密钥保存、wx配置创建 | 不是凭据库；已有文件不自动覆盖；环境配置必须三项完整 |
| [terminal.ts](../src/terminal.ts)：TerminalIO/createTerminal/safeText | 可注入终端输入、隐藏输入、防预输入、控制字符转义、队列/EOF | 实体TTY行为未全覆盖；不做逐token渲染 |
| [interactive.ts](../src/interactive.ts)：runInteractive/listSessions | 连续对话、new/resume/history/status、inspect/recover、Ctrl+C | 会话切换仍需用户确认当前 workspace/Provider |
| [runtime.ts](../src/runtime.ts)：AgentRuntime.send/sendTurn/runToolCalls/compact/formatBudget | 持锁整轮、预检查、`sendTurn` 在写任何日志前生成 TaskSpec（可 `enforceTaskSpec` 硬拒，默认关）、模型工具循环、activity、取消关联补齐、预算（模型调用/每步工具/整轮工具/整轮deadline/prompt字节/input token/按模型窗口/可选本机tokenizer）、每次send生成runId、`compact()` 生成并记录摘要边界、`RunBudget` 报告已用与上限 | 默认10步、每步8次、整轮32次、deadline 300000ms、prompt 524288字节、input 131072 tokens；deadline送达adapter但无法强杀忽略signal的进程内代码；字节上限不是token计数；token上限优先取本机tokenizer计数（需宿主注入，不内置分词器），否则取provider实测值因此首轮无测量；按模型窗口只作用于token上限，不派生出字节上限 |
| [types.ts](../src/types.ts)：ChatMessage/ModelAdapter/ToolCall | TypeScript协议接口；`ChatUsage.reasoningTokens` 为 provider 上报的子集标记；`ChatResponse.reasoning` **刻意不放在 ChatMessage 上**，使"推理不落盘、不回传"成为类型形状的性质 | ChatMessage 仍非角色判别联合；类型不等于运行时校验；无流式接口 |
| [response-validation.ts](../src/response-validation.ts)：record/tokenCount/validateResponse | 响应形状、非负安全整数用量、本批唯一非空调用ID；可选的 `reasoning` 字符串与 `reasoningTokens` 同样只做畸形拒绝 | 缺失用量仍可映射0；不解释工具参数（由tools在分发前校验）；**不校验** reasoningTokens 是否真是输出子集 |
| [openai-adapter.ts](../src/openai-adapter.ts)：createOpenAIChatAdapter/parseSseCompletion/CHAT_RESPONSE_MAX_BYTES | chat/completions、function wire映射、timeout/abort、结构校验、响应体1MiB硬上限、`reasoning_content` 与 `completion_tokens_details.reasoning_tokens` 解析（缺失即缺失，非字符串拒绝）；`stream:true` 时把 SSE 分片组装回同形状 payload 并复用后续全部校验 | 非增量读取（整段受1MiB约束后才解析）；无重试；上限按字节实收计数，不信任content-length；本机socket与真实端点（含流式工具往返）已联调；其它推理字段命名未适配 |
| [bounded-read.ts](../src/bounded-read.ts)：readBoundedUtf8 | 唯一的字节上限文本读取：按实收字节计数，超限中断并关闭底层流 | 只做上限与解码；不解码流式增量、不做内容类型判断 |
| [echo-adapter.ts](../src/echo-adapter.ts)：createEchoAdapter/createScriptedAdapter | 离线回显/确定性脚本测试 | Echo不是大模型、不自主调用工具 |
| [security-config.ts](../src/security-config.ts)：canonicalPath/resolveRuntimePaths/assertReadablePath/isWithin/configuredContextWindows | native真实路径、缺失叶子祖先、保护根、敏感路径规则、唯一的包含判定 `isWithin`、按模型窗口环境解析 | 命名策略非DLP；不消除本地并发替换竞态 |
| [tool-environment.ts](../src/tool-environment.ts)：buildToolEnvironment/isIssuedToolEnvironment | 白名单env、派生home/temp/config路径校验、冻结发行对象 | 合作Context非OS sandbox；不可信进程内代码可忽略 |
| [file-policy.ts](../src/file-policy.ts)：filePolicy | 只读允许；六个文件工具与 `dispatch_workers` 需批准；其他副作用拒绝 | 不检查路径；路径仍由各工具调用 `assertReadablePath` |
| [taskspec.ts](../src/taskspec.ts)：buildTaskSpec/assessTaskSpec | 每次发送前生成带版本的确定性 TaskSpec：原输入、目标、关键词意图、运行时模式；缺目标记 unknown、不编造模式；强制拒绝是独立开关、默认关闭 | 关键词意图是分类不是权威；spec 只随 `SendResult` 返回，不写会话日志（D12） |
| [workers.ts](../src/workers.ts)：createDispatchWorkersTool/workerTools | 有界只读 worker：一次精确批准后分派 1–2 个子任务；每个 worker 是全新 AgentRuntime（独立会话 `worker-<uuid>`、注册表仅 `read_file`、顺序执行、继承父 signal）；失败按 worker 分开如实报告 | worker 不能写、不能再分派（结构性，非提示词）；worker 的 token 用量记在 worker 会话，不进父预算；无文件/行数账本（D13） |
| [session-lease.ts](../src/session-lease.ts)：withSessionLease | wx锁文件、owner token、内部scope复用、核验归属后释放单个锁 | 本地合作进程锁；遗留锁不抢占；不是网络FS/恶意进程安全锁 |
| [session-store.ts](../src/session-store.ts)：SessionStore/migrateEvent | 独占header、事件校验/追加、每事件flush、inspect/history、pendingTools/recover、summary、audit。`audit` 记录拒绝或过期，标记 ignorable，不进入对话 | 多次追加不是事务；真实断电未实测；audit 不记录文件内容 |
| [preflight.ts](../src/preflight.ts)：preflight/formatPreflight | 联调准备检查：配置完整性（三项齐全规则）、**未鉴权**端点可达性探测（不读正文）、tokenizer 命令实跑一次、真实 TTY 状态；只报观察到的事实 | 不读凭据文件、不验证托管服务是否接受请求形状；它是"能否尝试"的门槛，不是"联调已完成"的证明 |

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
