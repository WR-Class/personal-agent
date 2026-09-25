# 验证证据与当前限制

最新补充：恢复合同收口（逐写点故障注入 + PT07）与上下文预算；原文档统一轮日期2026-09-24。区分各轮历史实跑、当前检查、静态审查与用户反馈。阶段入口：[STATUS](STATUS.md)。

## 最新：token 上限（上下文预算第二半）与参考证据复核

- `npm.cmd run build` exit 0；`npm.cmd test`：**142 tests / 17 suites：141 pass、0 fail、1 skip**。
- 新增 `maxContextTokens`（默认 131072）与 `TokenBudgetError(tokens, limit)`：判定值取自 **provider 自己上报的 `usage.inputTokens`**，不引入 tokenizer、不做估算。
  - 实测：某步上报 9000 tokens 而上限 8000 时，该轮在**下一次调用前**停止，`adapter.consumed === 1`（只花了一次调用得知该数字，不把已知超限的 prompt 再送一次）。
  - 实测**诚实边界**：首次调用尚无测量值，只有字节上限生效——用「上限 8 token 但首轮仍成功」断言这一点，而不是含糊带过。
  - 测量值跨 send 保留：上一轮上报 70000 而上限 60000 时，下一轮在**不额外调用模型**的情况下被拒，且被拒轮次未写入日志（历史仍为 `user:first` / `assistant:first`）。
- `ScriptedStep` 增加可选 `usage`，使依赖 provider 上报值的预算可被测试；缺省仍为 1/1，不改变既有用例。
- CLI：`--max-context-tokens` 与 `PERSONAL_AGENT_MAX_CONTEXT_TOKENS`，非正整数拒绝；默认 131072 由测试锁定。
- 参考证据复核（只读，见 [REFERENCE_DECISIONS](REFERENCE_DECISIONS.md)）：Codex `context_window.rs` 用 `get_total_token_usage()` 的**实际用量**并维护两条上限；OpenCode 有字节上限 `maxOutputBytes` 与 chars/4 **估算**的 `catalogBudget`。本实现采用「实测 + 字节兜底」，明确不采用估算式硬上限、不采用压缩/摘要处置、不采用按模型元数据的窗口百分比。
- 未做：tokenizer 精确预判、摘要保真、剩余量显示、按模型配置窗口。

## 历史：恢复合同收口（逐写点故障注入 + PT07）

- `npm.cmd run build` exit 0；`npm.cmd test`：**139 tests / 17 suites：138 pass、0 fail、1 skip**。
- 逐写点故障注入（新增 `test/fault-injection.test.ts`，5 项）：
  - 先实测确认一次单工具 send 恰好产生 **6 个持久写入点**（user、assistant、usage、tool message、assistant 答复、usage），注入点数量由断言锁定而非假设。
  - 「写前失败」逐点注入 ×6：日志无结构损坏；重放历史是完整运行的**精确前缀**；`pendingTools()` 数量与注入点一致（写 1–2 为 0、写 3–4 为 1、写 5–6 为 0）；`recover()` 只补缺失项且**从不重跑工具**（执行器计数不变）；恢复后 `assertReady` 通过、补出的 tool message 指向被记录的调用。
  - 崩溃后的会话再发送会被拒且**不触达模型**（adapter 请求数不变）。
  - 「撕裂写入」逐点注入 ×6：`inspect` 精确定位为 **2 条**发现（非法 JSON + 末行未终止）；`recover()` 明确拒绝且**不改写任何字节**；发送同样被拒且不触达模型。
  - 恢复只追加（`after.startsWith(before)`），修复后的会话可继续发送。
- PT07（`src/interactive.ts`）：`/resume` 在切换前报出未完成工具结果数量并指向 `/inspect` `/recover`，且声明不会自动重跑工具；补齐后不再提示（实测提示出现恰好 1 次——永久警告会训练用户忽略它）。
- 上下文预算（`src/runtime.ts`）：新增 `DEFAULT_MAX_CONTEXT_BYTES = 524288` 与 `ContextBudgetError(bytes, limit)`；统计**实际发送负载**的 UTF-8 字节（含 `content`、tool 调用名与 arguments；只算 `content` 会在模型发出大参数时低报）。
  - 超限拒绝发生在**写入用户轮次之前**：实测拒绝后日志只有会话头、无 message，因此不会留下永远无法回答的轮次。
  - **每一步复查**：实测 `maxContextBytes=30` 时首个 prompt（5 字节）通过、加入工具结果后的 prompt（52 字节）被拒，`adapter.consumed === 1` 证明停止发生在一次真实步骤之后而非之前；停止后 `inspect` 无问题、`pendingTools` 为空、`assertReady` 通过。
  - 拒绝时不触达模型（`adapter.consumed === 0`），错误消息同时报出实际字节数与上限。
  - 真实入口冒烟：`--max-context-bytes 20` 时退出码 1、输出 `context budget exceeded: prompt is 176 bytes, limit is 20`，日志仅含会话头。
  - 边界声明：这是**字节**上限，不是 token 计数，也不是截断/摘要策略；不声称能防止 provider 侧上下文溢出。
- CLI：`--max-context-bytes` 与 `PERSONAL_AGENT_MAX_CONTEXT_BYTES`，非正整数拒绝；默认值 524288 由测试锁定。
- 未做：token 计数、摘要保真、provider 侧真实窗口联调。

## 历史：恢复合同实施（ADR-0001 D1–D4 落地）

- `npm.cmd run build`：一次失败（`session-store.ts` 注释块未闭合，我对 `old_string` 的替换切断了原有 `## Versioning rules` 注释段），修正后 exit 0。
- 测试更新后 `node --experimental-strip-types --test test/session-format.test.ts test/reliability.test.ts`：18项全通过。
- 最终 `npm.cmd test`：**130 tests / 16 suites：129 pass、0 fail、1 skip**；`npm.cmd run build` exit 0。
- 真实入口冒烟：`node --experimental-strip-types src/cli.ts --home <fixture> --workspace <fixture> --echo --session smoke "hi there"` 退出0；写出的日志为 `{"kind":"message",...,"runId":"a1cd1fcc-...","step":0}`（user）与 `"step":1`（assistant+model），无 `tool/call`/`tool/result`；`--list` 正确重放 `user/assistant` 两行。
- 新覆盖：一次工具调用只写 1 行（审计对计数断言为 0）；tool 消息带 `runId`/`step`/`isError` 且 `ChatMessage` 内不含这些字段；同一次 send 的 turn 共享 `runId`、user 为 `step:0`、tool 结果与请求同 `step`；旧 v1 完整批次仍重放出相同消息序列；**旧半批次已记录的 result 仍被 `/recover` 复用而非编造**；缺字段的旧审计行不再致命（结果标未知）；**非 JSON 截断行仍报 invalid JSON**（`ignorable` 不适用，未被本次改动弱化）。
- 实施中发现并修正原 D4：计划让新读取器「跳过」旧审计对，实测会使旧日志中**已保存**的结果在恢复时被覆盖为「outcome unknown」。改为「只读不写」，并在 ADR 记录修正。
- 当时未做（其中第一、三项已在后续两轮补上，见上方最新两条）：逐写点故障注入、`/resume` 未完成提示（PT07）。**断电持久性至今未做**，也不在任何文档中声称已做。

## 历史：恢复合同第一步（决策 + 旧格式 golden fixture）

- 新增 `test/session-format.test.ts`：`node --experimental-strip-types --test test/session-format.test.ts` 6项全通过；`npm.cmd test`：**128 tests / 16 suites：127 pass、0 fail、1 skip**；`npm.cmd run build` exit 0。
- 覆盖：逐字节冻结 v1 行形状（含 key 顺序 `v,kind,at,message,model`）；`history()` 重建与写入完全相同的消息序列；`totals()`；带审计事件的完整批次 `pendingTools()` 为空；「有 result 无 message」判为待恢复、`recover()` 复用既有 result 不重跑、原字节前缀不变（`after.startsWith(before)`）、第二次 recover 返回 0；「有 call 无 result」标为结果未知且只追加 result+message 两行。
- 测试自身首轮失败2项（会话头 id 不匹配、key 顺序写错），修正后通过；其中一次失败暴露出**实质约束**：`migrateEvent` 在 kind 分派前对 `tool/call`/`tool/result` 做形状检查，因此 `ignorable:true` 对这两个已知 kind 不生效（实测 `migrateEvent({v:1,kind:"tool/call",ignorable:true})` 抛错）。该行为已冻结为断言，并写入 [ADR-0001](ADR-0001-session-fact-source.md) 作为 D1 的实施约束。
- 本轮**未改变任何产品行为**：日志格式、读取语义、恢复语义均与上一轮相同；未做逐写点故障注入。

## 历史：M1运行预算轮（每步/整轮工具数与整轮deadline）

- 定向 `node --experimental-strip-types --test test/tools.test.ts`：首轮1项失败——`AbortSignal.timeout()` 拒绝时 `name` 是 `TimeoutError` 而非 `AbortError`，原判定漏掉它，导致 deadline 被当成宿主内部错误抛出；修正谓词后40项全通过。
- `npm.cmd run build`：exit 0；`node --test test/interactive.test.ts test/tools.test.ts`：53项/52通过/1跳过。
- 最终 `npm.cmd test`：**122 tests / 15 suites：121 pass、0 fail、1 skip**；`npm.cmd run build` exit 0。
- CLI 实际入口冒烟：`node --experimental-strip-types src/cli.ts --help` 退出0且列出新预算标志；`--max-tools 0 hi` 退出2并报 `--max-tools must be a positive integer`。
- 新覆盖：单步超预算时整步在执行前被拒绝、且不落 assistant/不产生 call/result；整轮超预算时已发出的调用仍被配对、被拒步骤不留痕；adapter 忽略 signal 时 deadline 仍停止循环、错误为 `DeadlineExceededError` 而非普通 abort；四项预算的非法值（0、小数）构造期/解析期拒绝；env 与标志的取值优先级与默认值。
- 未做：真实 Provider 慢响应、真实长任务挂钟精度、上下文/token 预算；deadline 不能强杀忽略 signal 的进程内代码。

## 历史：M1参数契约与硬字节上限轮

- 定向实跑 `node --experimental-strip-types --test test/phase1.test.ts test/tools.test.ts test/interactive.test.ts test/security.test.ts`：首轮失败2项，旧断言只匹配 `non-empty string` 而实际报 `$.path is required`；修正该信息后定向80项只剩1项失败，并暴露 schema 声明错误被套 `threw:` 外壳的真实问题，分开报告后通过。
- `npm.cmd run build`：先因 `FileHandle` 不是 `AsyncIterable` 失败一次（TS2345），改为显式分块生成器后 exit 0。
- 最终 `npm.cmd test`：**117 tests / 15 suites：116 pass、0 fail、1 skip**（skip 仍为环境不允许创建符号链接）；`npm.cmd run build` exit 0。
- 新覆盖：Schema 不支持关键字（如 `oneOf`）在执行器调用前拒绝且不伪装成 `threw:`；类型/enum/const/必填键/`additionalProperties:false` 错误；无界流在超过上限时被中断（不是读完再判断）；上限按字节而非字符计算；`content-length` 谎报不影响判定；文件恰好达上限可读、超 1 字节拒绝。
- 仍沿用保留 fixture，无真实网络（HTTP 用注入 `fetchImpl`）；未做真实 Provider、真实大文件与真实 TTY 验证。

## 历史：Ponytail冗余精简轮（PT03/PT05）

- 先运行reliability：新增读次数断言失败（实际2、期望1），其余9项通过。
- 将旧resolveAdapter测试迁往main后、删除helper前：phase1+interactive 27项通过，证明原真实入口行为不变。
- 精简后 `node --experimental-strip-types --test test/reliability.test.ts test/phase1.test.ts test/interactive.test.ts`：37项通过。
- `npm.cmd run build`：exit 0；`npm.cmd test`：110 tests/14 suites，109pass、0fail、1skip（旧symlink权限）。
- 覆盖：初始化及外层持锁append只严格读一次；错/重复header不扩展；既有坏尾行、跨进程争用继续通过。main的配置缺失/部分/显式Echo/完整环境真实adapter路径均验证；fetch使用t.mock自动恢复，无真实网络。
- 只删冗余，不改变日志格式、租约、安全策略或增加依赖。没有基准压测，不以测试时长波动声称性能倍增。src/test中resolveAdapter残留与文档链接另行检查。

## 历史：Ponytail边界修复轮

- `node --experimental-strip-types --test test/interactive.test.ts`：修复前12项/10通过/2失败，失败均为缺少预期拒绝；修复后12项全通过。
- `npm.cmd run build`：exit 0，类型检查通过。
- `npm.cmd test`：109 tests / 14 suites：108pass、0fail、1skip；skip仍为符号链接创建权限不足。
- 新覆盖：length/content_filter × 有无工具调用全部拒绝；只保留user，无assistant/usage/tool记录且executor计数0；stop/tool_calls及缺失/null保持兼容；保存配置多字节精确16,384字节可重载，超1字节在建home前拒绝；不保存密钥时超长密钥不计入文件。
- 沿用现有保留fixture，无真实API/删除清理。独立只读审查通过不替代上述实跑。
- 以下“文档统一轮”的拦截与未变哈希均为过去轮次证据，不是本批状态。该次宿主包装命令没有重试、也未改hook；本批直接运行已有产品测试入口。

## 1. 各批已有实际结果

| 批次 | 当时实际验证 | 限制/记录 |
|---|---|---|
| 最初审查 | 71 tests / 13 suites：70pass、0fail、1skip；typecheck通过 | 禁用rm的包装执行，不是原始npm test；旧env保留秘密等探针是修复前证据 |
| PR1安全基线 | 88 tests / 14 suites：87pass、0fail、1skip；typecheck通过 | fixture移除recursive清理；静态路径/环境/保密测试，非OS沙箱 |
| 交互CLI | 97 tests / 14 suites：96pass、0fail、1skip；typecheck通过 | fakeIO+合成响应；实际--help/管道Echo入口退出0；非真实TTY全覆盖 |
| 会话可靠性 | **106 tests / 14 suites：105pass、0fail、1skip；typecheck通过** | 含真实Node子进程锁争用；不是全断电/强杀边界演练 |

各批skip为旧符号链接创建测试受环境权限限制，不能当成pass。junction/hardlink相关合成用例曾实跑通过。详细历史：[PR1](PR1_STATUS.md)、[CLI](CLI_STATUS.md)、[会话](SESSION_RELIABILITY.md)。

用户反馈“运行没有问题”确认了CLI可用入口；未指定全部Provider、密钥模式、取消与恢复操作，不据此扩大验收范围。

## 2. 本次文档统一轮

- 仅允许README及docs Markdown修改，不新增功能、不改src/test/package配置。
- 复核14个源码模块的职责、6个测试入口、1个fixture helper；独立只读审查核对M1剩余项，没有独立运行测试。
- 尝试的命令：`npm.cmd run build` 后接Node包装导入六个测试文件；包装禁用rm/rmdir，保留协议所需的确切锁叶unlink。
- **整条命令被宿主destructive-guard拒绝，提示“删除目标是盘根 //”。没有执行结果可证明本次build/tests通过。未修改宿主hook、未升级权限、未换方式绕过。**
- 单独只读验证：本地Markdown链接全部存在；源码/测试/脚本/配置聚合SHA256前后相同。当前目录无.git条目，不宣称有可用提交历史。
- 因此本次的功能验证引用第1节最后一批已有结果；PDRI的完整新验证不得记为通过。

## 3. 源码完整性基线

算法：枚举src/test/scripts直接文件，加package.json、package-lock.json、tsconfig.json、.gitignore；相对路径排序；每项为 `path + NUL + lowercaseSHA256(file)`，LF连接后再次SHA256。README/docs不在其中。

本次文档前/后均为：

```text
790b703e2e65f2225e374e3bafd79475dd866777a650237df9034d3cd3433ff3
```

M1协议与硬字节上限批后（新增 `src/bounded-read.ts`，改动 tools/openai-adapter 及测试），同算法重算为 **27 个文件**：

```text
39a06ef075787f5089ccff0948d4bb8d77e0e9c32f0ce6a8f162d5fc69fd86f6
```

M1运行预算批后（改动 runtime/cli 及测试），再次重算，仍为 **27 个文件**：

```text
e2146206a3ae01090d580c032fdec5c6267889e4452729dbedd93d1ff7e40930
```

恢复合同第一步后（新增 `test/session-format.test.ts`），重算为 **28 个文件**：

```text
3ff711439e969ca09288c31fc38f7ba1cad5d6ce9acf2039e1468b0b50db3840
```

恢复合同实施（ADR-0001 落地：runtime/session-store 及测试）后，仍为 **28 个文件**：

```text
6ae4b9c9bbb9a9762987aad8e8eeee7ae7b17ade7cc5042e2c7cf88d764f7606
```

恢复合同收口与上下文预算后（新增 `test/fault-injection.test.ts`，改 `runtime.ts`/`interactive.ts`/`cli.ts` 及测试），重算为 **29 个文件**：

```text
e524374787747ba5c786a42652e1344a085a64ac8aaa57d490f3346393befc01
```

加入 token 上限（改 `runtime.ts`/`cli.ts`/`echo-adapter.ts` 及测试）后，仍为 **29 个文件**：

```text
c696627846d39e8b8853aef5a9d00e0c7f2689d921a69ca7d2d840d9e53abce0
```

持久性/路径收敛/窗口与剩余量/tokenizer/摘要保真/本机socket联调批后（新增 `test/compaction.test.ts`、`test/provider-integration.test.ts`，改 `session-store.ts`/`runtime.ts`/`security-config.ts`/`tools.ts`/`cli.ts`/`interactive.ts` 及多个测试），重算为 **31 个文件**。本次写法按算法原文**保留末尾 LF**：

```text
03555c8567c35113210605eff112aed843bcb9b901800a851625f870ec320cf2
```

（同批中间值 `969d91df5d7f112bfc504ae2ed4cca47a269c0e66884d63e722c5248faa037c5` 是在修掉"一次性模式回答被打印两次"这一自查缺陷与补充相应回归断言**之前**算的，已失效，保留在此只为说明差异来源。）

`--preflight` 联调准备检查批后（新增 `src/preflight.ts`、`test/preflight.test.ts`，改 `cli.ts` 及 README/SAFETY 等文档），重算为 **33 个文件**：

```text
d0b5139bc108575ad52a8fec0e03afd09d3451dd35f0078ffab663a07111af37
```

推理可见性批后（改 `types.ts`/`response-validation.ts`/`openai-adapter.ts`/`runtime.ts`/`session-store.ts`/`interactive.ts`/`cli.ts`/`echo-adapter.ts` 及测试），仍为 **33 个文件**：

```text
d75cf1c01af527be614254f47cc03ff634e62c86baa1973f74a8fee8c4f8697b
```

SSE 流式批后（新增 `test/streaming.test.ts`，改 `openai-adapter.ts`/`cli.ts` 及文档），为 **34 个文件**：

```text
201c0fb5e7e54fcf40e2412b1196d36588b070ab0744b09c84e1df3749a0d731
```

版本控制与 CI 批**不改变此值**：该批只动了文档、`.gitattributes` 与新冒烟现场，而哈希集合是 `src`/`test`/`scripts` 加四个配置文件——`.gitattributes` **刻意不在**哈希集合内，它恰恰是用来保证集合内文件字节稳定（LF）的。已用 `git clone` 验证：新克隆中重算得到**同一个** 34 文件摘要。

偶发失败根因批后（新增 `test/server-fixture.ts` 与 `test/server-fixture.test.ts`，改 `openai-adapter.ts`/`streaming.test.ts` 并把三个测试文件换到共享夹具），为 **36 个文件**：

```text
be2b877eaf7afea3ad855bb01f215ac75757c7fa24d2e5fe76981a87a7469c64
```

同文件集下若**去掉末尾 LF**再哈希，则得到 `dd3a731b44e31589793b7b11e04b698af9e0899fd7b9767a00bc1aad84e234d6`。两者不同，**此前记录的数值无法反查其属于哪一种写法**（源码已改变，旧值不可重算），因此本节此前各值只能用来说明"代码确实变过"。从本批起以保留末尾 LF 的写法为本算法唯一口径，后续必须沿用同一写法，否则数值不可比。

每次值变化都是预期结果（源码确实改变），不是完整性校验失败。首次用 PowerShell `[System.IO.Path]::GetRelativePath` 计算失败（该 API 在 PowerShell 5.1 不存在），得到的结果已丢弃、未使用；上列数值均由改为手工相对路径的同一算法得到。

旧审查前/后的历史值：`473943f3e615802939a348aea8c6aa88edbacf6ecc73a7e5ea9c176591d57dc6`。后续功能实现已改变代码，两者本就不应相同。

最初保留fixture：`.personal-agent/audit-docs-qXspAD`；PR1中间测试还保留`.personal-agent/test-runs/`；当前测试使用`.test-artifacts/`。本次未清理任何目录。

## 4. 当前回归覆盖与缺口

| 面向 | 已有确定性用例 | 尚缺/未验证 |
|---|---|---|
| 环境/目录 | 白名单、保护根、tempRoot、config junction、合成秘密不外发 | 真实子PowerShell变量、Windows8.3专项、恶意并发替换、跨平台 |
| CLI/凭据 | 多轮/命令、显式Echo、错误配置、隐藏标志、旧home密钥拒读、错误正文隐藏、预算标志与env解析及非法值退出码、`/compact` 压缩后 `/history` 仍完整、`/status` 显示按模型窗口、本机socket真实一次运行（密钥不入stdout不入日志）、`--preflight` 探测不发密钥/不读正文/残缺配置不判ready/坏tokenizer阻止"可尝试"/非UTF-8输出不打印乱码/exit 3与0 | **实体TTY全矩阵（未使用pty，未测）**、外部真实Provider/网络错误组合、配置编辑UX |
| 会话并发 | 双Runtime、嵌套拒绝、真实子进程争用、独占幂等header | 网络FS、同一session长期压力、所有release失败/路径别名组合 |
| 会话恢复 | 尾部截断拒绝、错header、孤立消息行号、保存result复用、未知标记、幂等、旧v1格式逐字节golden fixture、新写入形状由真实运行冻结、缺字段旧审计行不致命、逐写点故障注入(写前失败/撕裂写入)、每事件flush计数与失败上抛、重复tool/call审计记录按行号拒绝、`usage` 新增可选 `reasoningTokens` 时旧日志仍有效且畸形值报行号 | 恢复再中断、完整Run状态机、**真实断电持久性（未测，见下）**、目录项持久化 |
| 运行预算 | 步数、单步/整轮工具数、deadline、上下文字节（写前拒绝/每步复查/不触达模型）、token上限（实测值/首轮无测量/跨轮保留）、按模型窗口（精确/`*`/全局、畸形值拒绝）、可注入tokenizer（预判拒绝/计数上报/非整数拒绝/未注入时不虚构）、剩余量显示（未测量与超限两种文案） | 宿主自备真实分词器的端到端计数准确性、provider真实窗口数值、按模型字节窗口 |
| 摘要保真 | 原始消息逐字节保留、边界=实测消息数（伪造过大/过小被拒）、摘要逐字进入后续 prompt、被覆盖轮不再发送、未完成工具批次拒绝、空摘要不写入、二次压缩续写且旧摘要不再发送、总结调用无 tools、旧的 ignorable 读者看到完整历史、`summary` kind 往返与畸形行报错 | 摘要质量（本批只保证不改写、不越界、不丢消息，不评价好坏）、超长摘要自身的压缩策略 |
| 协议 | text HTTP映射、401、数值/角色/version、畸形usage不污染assistant、工具参数按受支持Schema子集校验、不支持关键字明确拒绝、HTTP响应1MiB上限按字节判定、**本机真实socket roundtrip（wire形状/工具结果回传/tool_call_id）**、真实HTTP失败不泄漏正文、200非JSON、finish_reason=length拒绝、真实socket上deadline中断、**推理：`reasoning_content` 解析、`reasoning_tokens` 取子集而非增量、缺失即缺失（不虚构空串/0）、`null` 视为无、非字符串拒绝、推理不回传到请求体、真实端点显示与落盘实测**、**SSE：分片拼接、末尾usage保留、`null` usage 不覆盖、工具调用跨分片按index组装、断流拒绝、空流/畸形分片拒绝、流式下字节上限与abort、只在显式要求时改请求体的真实socket验证、真实端点流式工具往返** | 外部托管Provider实测、TLS/代理、限流、缺失usage语义、完整JSON Schema标准、其它推理字段命名（`reasoning`/`reasoning_details`未适配）、**增量显示（本项目不做，整段缓冲）**、服务端中途断流的真实复现（只用构造分片测过） |
| 执行/预算 | 工具顺序、maxSteps、pre-abort、取消后第二工具未执行、文件256KiB硬上限（含恰好达限与超1字节）、无界流提前中断、每步/整轮工具超预算不执行且不留未配对组、deadline 停止循环 | 增长文件竞态、上下文/token预算、真实慢Provider计时 |
| 工程 | strict typecheck、显式TS test入口、字面量固定「运行期预算展示」、血统演算验证（RAM预算与M1阈值一致）、**仓库已版本控制**（工作树干净）、**`.gitattributes` 固定 LF 后「新克隆=工作树」完整性哈希逐字节一致**、**CI 的三个步骤在干净克隆上实跑通过**（`npm ci` → `tsc --noEmit` → 全量测试）、**Node 22.23.3 便携包实测通过**（官方 zip，SHA256 与 nodejs.org 的 SHASUMS256 一致，解压在 `.test-artifacts/toolchain/`，PATH 只在该次命令内生效，未改全局 Node；干净克隆上 `npm ci` 3 包 0 漏洞 → `tsc --noEmit` → 207/206/0/1）、**传输失败原因上浮**（`bad port`/拒绝连接点名、abort 不改写）、**并发稳定性：6 路并发 × 3 轮 = 18 次全量运行 0 失败**（修复前 4 路并发 12 次出现 6 次失败，根因与证据链见上文偶发失败条目） | **CI 从未在真实运行器上执行**（本地仓库无远端）、**只测了 Node 22.23.3 这一版**（不是整个 22.x 区间，也不是 22.6 下限本身）、非 Windows 平台未测、历史两起失败的原始输出已失（机制吻合但无法回溯证明） |

类型声明不是运行时校验；测试源码存在不是“本次已通过”；review意见不是运行证据；环境重写不是OS隔离。

## 4.1 本批明确未验证的事项（不得由通过的测试推得）

- **真实断电/掉电持久性**：本批实现的是"每次 append 调用一次 flush 并把 flush 失败当作失败上抛"，并由测试**计数** `sync()` 调用次数、让 `sync()` 抛错以证明失败不被吞掉。这**不是**"数据能扛住突然断电"的证明：Windows 上无法对目录本身做 fsync，所以目录项持久化不在保证内；硬件/文件系统谎报 flush 也无法在本项目内识别；两次已 flush 事件之间崩溃得到的是撕裂记录，靠检查与补齐处理。**本批没有做过任何掉电实验。**
- **外部 Provider 联调**：本会话**没有任何外部 Provider 凭据**，因此未向任何托管服务发过请求。"某 Provider 接受此请求形状/模型名/token 口径"仍未验证。本批验证的是本机 `127.0.0.1` 上真实 `node:http` 服务 + 真实 `fetch` 的完整链路（含真实 abort 与真实 CLI 记录）。
- **实体 TTY**：未使用 pty（Node 无内置 pty，本会话未引入第三方依赖），因此"真实终端下 Ctrl+C 取消观感、密钥输入隐藏观感"仍属未验证；交互行为由 fakeIO 驱动验证，只能证明命令逻辑与输出文本。**已为此提供 `--preflight`（如实报告是否 TTY）与 [联调 Runbook](LIVE_INTEGRATION.md)（分步操作 + 证据要求），但 runbook 本身不构成验证。**
- **摘要质量**：只验证了不改写、不越界、不丢消息。摘要是否"总结得对"没有可自动判定的标准，本批不作任何评价。
- **`--preflight` 自身不证明的事**：它只回答"当前是否具备尝试联调的条件"。它的探针是未鉴权请求，因此**不能**证明某个托管服务接受本客户端的请求形状；"exit 0"不等于"联调成功"。
- **推理相关的未验证项**：推理文本的**质量与完整性**不作评价；本项目不校验 provider 上报的 `reasoningTokens` 是否真是输出 token 的子集（本机实测出现过 `输出 47 / 推理 47`）；非 OpenAI 兼容的推理字段命名（如 `reasoning`、`reasoning_details`）**未适配**，遇到时会被当作"该 provider 未提供推理"，而不是猜另一种名字。
- **偶发测试失败已定位并修复（2026-09-25）**。此前两起未复现失败（推理批 1 项约 3ms；git 批一次 `fail 3` 且输出被覆盖未留存）在 4 路并发加压下**复现**（12 次运行 6 次失败），随后定位出**两层真实原因**：
  1. **测试自身缺陷**：`streaming.test.ts` 曾把 CLI 完整渲染输出按字节比较，而输出含墙钟 `用时` 字段——并发下两轮耗时不同即失败（该 6 次失败全部是它）。修复：只归一这一个字段，并单独断言该字段存在。
  2. **平台层根因（更深层）**：`fetch`（undici）按 WHATWG 禁连端口列表对某些端口**在任何 I/O 之前**即刻抛 `TypeError: fetch failed`，`cause: bad port`。实测（本机，3000 次绑定）：Windows 临时端口分配器给出 1026–15000 区间端口，命中禁连列表 **4 次（0.13%）**，命中值 1719/1720/1723/2049；连续分配即连续端口，因此**成簇出现**——这解释了"一次挂 3 个"、"2.9ms 级失败速度"与"无辜测试被点名"的全部观测特征。修复：共享测试夹具抽到禁连端口即换端口重试（有界），并用测试锁死"抽到的端口真的可 fetch"。
  - 验证链：修复前 4×3=12 次并发 6 失败 → 修掉墙钟断言后 12 次 3 失败（全部 `bad port`）→ 端口修复后 **6 路并发 × 3 轮 = 18 次全量运行 0 失败**。
  - **顺带修复的产品缺陷**：适配器此前把传输失败原样上抛，操作者只能看到 `fetch failed`，真实原因在 `.cause` 里被吞掉。现在上浮原因（`bad port`/`ECONNREFUSED`/DNS/TLS），abort 保持原语义不被改写；配套测试覆盖两类原因与 abort 语义（禁连端口案例无需服务器即确定性复现）。
  - **被证伪的假设（留档防止再走弯路）**："`once` 监听器被消费后，迟到的 server 错误会逃逸成未捕获异常并被归因到无辜测试"——探针实测旧模式**吸收**了该错误（2 tests / 2 pass / 0 fail），假设不成立。因此 `server-fixture.ts` 的引入只算去重与加固（持久监听、`closeAllConnections()`、EADDRINUSE 重试），**不冒充根因修复**。
  - **历史两起失败仍无法回溯证明**就是这两层原因（原始输出已失），但机制与全部观测特征吻合。教训固化：失败输出必须先另存再继续（此前两次均因此丢失）。

## 5. 常规开发验证入口

在正常开发终端：

```powershell
npm.cmd run build
npm.cmd test
```

这两条是产品入口说明，不是绕过本次宿主拦截的建议。本会话不自动重试已被拒绝的命令。当前测试无recursive fixture清理，但租约finally会核验并unlink本次单个锁；数据现场保留。不以测试为由删除用户home、DSH、备份或恢复材料。
