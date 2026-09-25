# ADR-0001：会话事实来源与 Run/Step/Call 身份

状态：**D1–D4 已实施**（2026-09-25，同 D4 实施时修正一处；4.3 记录后续新增的 `summary` kind）。日期：2026-09-25。
取代：无。相关：[AUDIT](AUDIT.md) A06/A07/A10、[IMPLEMENTATION](IMPLEMENTATION.md) PR3、[SAFETY](SAFETY.md)、[STATUS](STATUS.md)、[VALIDATION](VALIDATION.md)。

本文件是决策记录。第 1 节是实施前读源码得出的事实，第 2 节是决定，第 2.5 节记录实施中的修正。

## 1. 背景：实施前的事实（已读源码确认，保留为决策依据）

`src/runtime.ts` 每个工具调用向日志写入 **3 行**：

1. `tool/call`（审计事件，`ignorable:true`）
2. `tool/result`（审计事件，带 `isError`，`ignorable:true`）
3. `message`（`role:"tool"`，带 `toolCallId`）

`assistant` 消息本身还带 `toolCalls[].arguments`，与第 1 行的 `arguments` 重复。结果内容在第 2、3 行各存一份。

`src/session-store.ts` 里 `history()` 只读 `message`，`pendingTools()` 同时交叉校验 `message` 与审计事件，并在两者不一致时抛错：

- `tool result/message conflict`（同一 callId 的 result 与 message 内容不同）
- `orphan or mismatched tool audit event`、`duplicate tool result`、`tool arguments mismatch`

**这些检查之所以存在，正是因为同一事实被写了两遍。** 一次崩溃落在任一行之间，都可能产生两套事实不一致的状态；`/recover` 只能在能解释这种不一致时补齐。

此外目前没有 Run/Step 身份：日志里无法回答「这条消息属于哪一次 send」「这一步是第几步」。

## 2. 决策

### D1：`message` 事件是唯一事实来源

新写入不再产生 `tool/call` 与 `tool/result`。一次工具调用只写 **1 行**（`role:"tool"` 的 message）。`assistant` 消息的 `toolCalls[]` 即「请求了什么」，`tool` 消息即「得到了什么」。

理由：`message` 是重放提示词所必需的那一份（模型看到的就是它），审计事件是可从 message 推导的副本。保留必需的那一份、删除可推导的那一份，比反过来少一层推导逻辑。

### D2：`isError` 提升为 MessageEvent 的顶层字段

`MessageEvent` 增加可选 `isError?: boolean`（仅对 `role:"tool"` 有意义），放在事件层而不是放进 `ChatMessage`。

理由：`ChatMessage` 同时是发给 Provider 的线格式，把非线格式字段塞进去会让它泄漏给模型。事件层已有同类先例——`model?: string` 就是只存在于事件、不在 `ChatMessage` 里的字段。

代价（接受）：旧日志中 `isError` 只存在于 `tool/result`，读取旧日志时该信息**丢失**；影响的只是 `/inspect` 展示旧记录时的错误标记，不影响重放与恢复。

### D3：身份在事件层显式化，不新建状态机

新增两个可选顶层字段，仍然保持 append-only JSONL、不引入数据库：

- `MessageEvent.runId?: string`、`MessageEvent.step?: number`
- `tool` 消息沿用 `toolCallId` 作为 Call 身份（已是现状）

`runId` 由 `send()` 在入口生成（不透明字符串，非自增、非时间戳语义），`step` 为该次 send 内第几次模型调用（从 1 开始）。

理由：M1 的恢复需求是「能判定一次 send 是否完整、能在不重跑工具的前提下补齐」，这只需要**身份 + 配对**，不需要 `created→running→waiting_approval→…` 这类状态转移。引入状态机要求一个可变的状态载体，而当前事实来源是不可变的追加日志——那会同时引入状态与日志两套真相。等 M2 引入审批（真正需要 `waiting_approval`）时再评估，不提前建。

**明确不采用**：Run 状态字段、状态转移表、`runs/` 目录。

### D4：不删除、不重写既有日志；旧审计对「只读不写」

新写入不再产生 `tool/call`、`tool/result`。旧日志中的这两类保持原样，不迁移、不清理，且**新读取器仍然解析它们**。

**实施时修正（原 D4 写的是「当作未知可忽略事件跳过」，实测证明那样有损，故改为只读不写）：**

原计划让新读取器把旧审计事件当作未知 kind 跳过。实施时发现这会造成**旧日志修复质量回退**：一条在 `tool/result` 与 message 之间被中断的旧日志，其已记录的结果只存在于审计事件里。跳过后 `pendingTools()` 看不到结果，`/recover` 会对一个**实际已保存**的结果写入「outcome unknown」——用假信息覆盖真信息。

该场景已由 `test/session-format.test.ts` 冻结（「复用既有 result，不得编造」），正是这条冻结断言在实施中拦下了原方案。

因此实际采用：

- 旧审计事件仍被解析；well-formed 时进入 `events`，供 `pendingTools()` 回答「这个调用是否已有结果」。
- 它们**从不**用于重建对话：`history()` 一直只读 message，这一点未变。
- 形状不完整（缺 `callId`/`name`/`isError`）的旧审计行返回 `null` 被跳过，不再让整个会话读取失败——这是原 D4 想要的那部分行为，保留。
- 注意边界：**非 JSON** 的截断行仍在 `JSON.parse` 阶段就被报为问题，`ignorable` 无法介入。这是既有的「疑似中断写入」信号，未被本次改动弱化，也不应被说成已处理。

因此 `migrateEvent` 里那段早期形状检查**不是删除，而是改为尽力解析**（`legacyFields()` 不满足即返回 `null`）。

## 3. 对崩溃窗口的影响

当前每次调用 3 个写入点 → 决定后 1 个。可观测状态从「请求了没执行 / 执行了没结果 / 有结果没消息」三类收敛为「有问题 / 没问题」两类：

| 场景 | 旧格式可观测状态 | 新格式可观测状态 |
|---|---|---|
| 写完 `tool/call` 后崩溃 | call 有、result 无、message 无 | 不适用（无该行） |
| 写完 `tool/result` 后崩溃 | result 有、message 无（需 /recover 补 message） | 不适用 |
| 写完 `tool` message 后崩溃 | 完整 | 完整 |
| 执行中崩溃（无任何行） | 未配对，`/recover` 标未知 | 未配对，`/recover` 标未知 |

关键性质不变：**恢复永不重跑工具**。执行中崩溃仍只能标记「结果未知」。

## 4. 实施记录

### 4.1 前置（改动格式之前完成）

1. 本 ADR。
2. `test/session-format.test.ts`：旧格式 golden fixture 逐字节冻结当前 v1 行，断言
   - `read()` 解析成功、`history()` 重建出与写入时完全相同的消息序列；
   - `totals()` 正确；
   - 旧日志中带审计事件的完整批次 `pendingTools()` 为空；
   - 旧日志中「有 result 无 message」的半批次被判定待恢复，`recover()` 补齐后与完整批次语义一致，且不重跑工具；
   - 「有 call 无 result」标为结果未知，且恢复只追加 `tool/result` + `message` 两行，不执行工具；
   - 恢复追加不重写原字节（`after.startsWith(before)`）、且幂等（第二次返回 0）。
3. 冻结新写入行的精确形状（含 **key 顺序**），使 D1 实施时的格式变化必须显式改测试，不能悄悄发生。
4. 实测确认 D4 的实施约束（见上）。

### 4.2 格式改动

- `src/runtime.ts`：每次 tool 调用只写 1 行 message（带 `runId`、`step`、`isError`）；`send()` 入口生成 `runId`（`crypto.randomUUID()`），user 为 `step:0`，assistant 与 tool 消息共用该步的 `step`。
- `src/session-store.ts`：`MessageEvent` 增加可选 `runId`/`step`/`isError` 并在读取时校验（`isError` 仅允许 tool 角色，`step` 必须非负安全整数）；`appendMessage` 的位置参数 `model` 改为选项对象；**删除** `appendToolCall`/`appendToolResult` 两个写入器；`recover()` 每次只追加 1 行 message。
- `migrateEvent`：早期形状检查改为尽力解析（缺字段的旧审计行返回 `null`），well-formed 旧审计对仍被解析以供修复复用。
- 测试：`test/session-format.test.ts` 新增「真实 runtime 运行冻结新形状」「缺字段旧审计行不致命但结果标未知」「非 JSON 截断行仍报问题」；`tools.test.ts` 三处断言由审计对改为 message 计数并断言**不再**产生审计事件；`reliability.test.ts` 的旧日志场景改为直接写入字面旧格式行。

验收结果与逐条证据见 [VALIDATION](VALIDATION.md)。

## 4.3 后续补充：`summary` 事件（2026-09-25，压缩保真批）

新增事件 kind `summary`，字段 `{v, kind:"summary", ignorable:true, at, covers, summary}`。

- `covers` 必须等于该会话当前的 message 数，由 `appendSummary` 用 store 自己数出的值校验；**值不等即拒绝**，因此边界是实测事实而不是调用者的声明。
- 写入时强制 `ignorable: true`：跳过它的旧读者会构建完整长度的 prompt——比预期长，但不会错。这一点与 D4 的原则一致（宁可多，不可丢）。
- `history()`/`totals()` 按 kind 过滤，所以 summary 事件**不会**改变消息回放：压缩只影响 `buildPrompt`，日志中一条 message 都不删。
- 与 D1 的关系：message 仍是唯一事实来源，`summary` 是对"模型看到什么"的**派生视图说明**，不是第二条事实来源；删除全部 summary 事件只意味着 prompt 变长。
- 校验：缺 `covers` 或 `covers` 非法会让该行成为可定位的问题（`inspect` 报行号），不会被静默跳过——它是已知 kind，不走可忽略的豁口。
- 测试：`test/compaction.test.ts`（保真）、`test/session-format.test.ts`（kind 往返与畸形行）。

## 5. 未决（不属本 ADR）

- 每次 `send` 是否追加一条显式的 run 边界事件（当前决定：不加，`runId` 随消息携带即可；若日后需要「列出所有 run」再评估）。
- 上下文预算与 Run 身份的关系（见 [VALIDATION](VALIDATION.md) 缺口表）。
- 逐写点故障注入的具体手段（本轮只冻结格式与语义，不做注入）。
