# Ponytail 审查：已完成的 M1 实现

范围：当前14个src模块、相关测试与使用合同。方法：加载Ponytail full，主审检查Runtime/持久化/路径/工具，独立只读审查CLI/配置/终端/Provider，再核对实际调用者。**本轮安装Skill并审查，不修复产品代码，不改变M1阶段。**

## 最新整改：PT03 / PT05 已完成

- PT03：append仍在同一writer租约内调用create，create会严格读取既有日志或wx建立header；只删掉随后重复的read，不引入缓存，不弱化坏尾行/header拒绝。长日志每次仍全量扫描，不声称解决整体二次增长或已压测提速。
- PT05：移除没有生产调用者的resolveAdapter及多余import；main的loadProvider/configureProvider实际选择逻辑不变。原测试改为调用main，mock fetch限定在单个测试生命周期内并自动恢复，不请求真实服务。
- 新回归：初始化append与外层持锁的既有append均严格读一次；重复/错ID header拒绝且原文件不变。缺失/部分Provider配置拒绝不创建会话，显式Echo不请求网络，完整环境通过真实HTTP adapter组装请求/输出/会话。
- 验证：精简前读次数断言2!=1失败；精简后定向37项全过，typecheck过；全量110项/109pass/0fail/1skip。PT04/PT06**已完成**（见各自小节），PT07已完成（见下方）。

## 历史整改：PT01 / PT02 已完成

以下审查正文及行号保留为修复前证据；“均未修改”仅描述原审查轮。最新批次已完成：

- PT01：在openai-adapter解码choice时拒绝明确 `length` / `content_filter`。不保存不完整assistant/usage/tool记录，不执行工具；用户消息保留。缺失/null结束原因保持既有兼容，不宣称所有未知结束原因已完整分类。
- PT02：配置读写共享16,384字节上限；实际JSON（含缩进/转义/末尾换行）按UTF-8计算；超过上限在mkdir前拒绝，wx与原路径重检保留。不保存密钥时不把密钥计入文件大小。
- 定向回归：修复前12项中2项失败（缺少预期拒绝），修复后12项全通过；typecheck通过；全量109项/108pass/0fail/1skip（旧符号链接权限用例）。无真实API、无fixture清理。
- 独立只读复核未发现阻塞问题；没有新增抽象/依赖。该批未包含PT03–PT07；后续PT03/PT05进展见上方最新整改。

## 1. 安装与来源

- 上游：[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)，MIT。
- 固定提交：`e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`。
- 安装：[SKILL.md](../../.dsh/skills/ponytail/SKILL.md) 与 [LICENSE](../../.dsh/skills/ponytail/LICENSE)。未安装上游插件的生命周期hooks，不运行其脚本，不修改用户级DSH配置。
- DSH发现范围是当前workspace `D:\DSHXM\AgentKHD`；实际调用 `skill("ponytail")` 已成功返回全文。不是personal-agent自身实现了Skill加载（产品M4仍未开始）。切换cwd到子项目且没有Git根时，不保证自动继承此workspace目录。
- GitHub页面rawLines按LF拼接并保留末尾换行，和本地SHA256一致：
  - SKILL：`1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2`
  - LICENSE：`fb1bc6909ac3ef82d5c22106e32ef682b0cff66788fa915fb9b53b15c9d2f3ab`

本次遵循：先理解真实调用链，再复用已有能力/标准库，最小正确改动。不因Ponytail要求精简而删除已有安全测试、隔离fixture或用户明确要求的功能。模式full；用户可要求lite/ultra或“stop ponytail”。

## 2. 结论

**无需推倒重写、无需引入框架/数据库，也不该删掉会话锁和路径保护。**主要问题是少量协议缺口、重复解析/读取，以及测试验证了不走生产入口的旧helper。源码中的压缩单行不等于设计简单；需要修时只展开涉及的分支，不全库格式化。

以下“中/低”是此次整改优先级，不冒充漏洞利用等级。未发现的缺陷不等于不存在；本轮不是渗透测试或完整动态审计。

## 3. 建议处理项（均未修改）

### PT01 中：HTTP响应忽略明确的未完成原因

- 证据：[openai-adapter.ts](../src/openai-adapter.ts):93–107直接取choice.message，不读finish_reason；[runtime.ts](../src/runtime.ts):236–253按正常assistant写入/返回或执行工具。
- 观察：注入fetch返回 `finish_reason=length` 或 `content_filter`，非空partial文本和形状完整的工具调用均被adapter接受。纯内存探针实跑通过；没有真正执行这些工具、没有真实模型请求。
- 最小修复：在现有HTTP解码位置读取一次choice，对明确的非成功结束拒绝；无finish_reason是否兼容要显式决定。暂不引入全新响应状态框架。
- 最小回归：mock截断文本必须拒绝，日志仅保留user；截断但可解析的工具参数也不能进入executor。
- 关联：A09的更具体缺口；比合并几个工具函数优先。

### PT02 低：配置能保存，但下一次启动拒读

- 证据：[cli-config.ts](../src/cli-config.ts):39–41拒绝大于16,384字节；57–63保存时没有相同限制，85–91会显示保存成功。
- 静态确定路径：合法但很长的model/apiKey通过字符串校验→保存超限JSON→下次load拒绝。未创建超大文件复现。
- 最小修复：先序列化一次，以 `Buffer.byteLength(payload, "utf8")` 校验同一上限，再mkdir/write；复用序列化结果，不加配置管理框架。
- 最小回归：多字节字符串超限时不创建文件；边界内配置可保存后重载。

### PT03 中（维护/随日志增长成本）：每次append重复全量读日志

- 证据：[session-store.ts](../src/session-store.ts):314调用create；create:295先read；append:315随即再次read。都处于同一合作writer租约。Runtime还在每步buildPrompt读历史。
- 静态成本：单次工具有call/result/message三次append，重复全量解析被放大；整个不断增长日志的持续追加总扫描成本可呈二次增长。没有性能压测，不声称当前已卡顿。
- 最小修复：先移除同一租约内可证明重复的那一次read，保留create的严格读、wx和坏尾行拒绝。一次扫描仍随日志大小增长；不要为省这一遍立刻上缓存/索引/SQLite。
- 最小回归：spy确认既有会话append只做一次严格读；坏尾行/重复header拒绝与跨进程互斥测试仍必须通过。

### PT04 低：路径包含判断和解析有两套

**已完成（本批）**：删除 `tools.ts` 的 `isInside` 与 `resolveInside`，只保留 `security-config.ts` 的 `isWithin`/`canonicalPath`/`assertReadablePath`；`read_file` 现在只经 `assertReadablePath` 一处判定（原先叠加三次、两套算法）。`resolveInside` 的 ENOENT 回退被 `canonicalPath` 的"最近存在祖先"取代，缺失叶子与"叶子父目录是越界链接"两种情况都比原先更强。**没有宣布等价**：原先叠加检查覆盖的每一项（词法包含、canonical 包含、敏感名原拼写、canonical 后的敏感名、同名前缀、外部链接、敏感目录作 workspace、缺失叶子）都在 `test/tools.test.ts` 逐条断言，其中直接调用 `resolveInside` 的那条已迁移为对存活实现的断言。**这不是 TOCTOU 修复**，重复解析的删除不消除本地并发替换竞态。

- 证据：[tools.ts](../src/tools.ts):91–95 isInside与[security-config.ts](../src/security-config.ts):13–16 isWithin算法相同；read_file:150–152叠加assertReadablePath→旧resolveInside→assertReadablePath。旧helper还有root realpath失败即回退绝对路径的不同失败策略。
- 最小修复：先复用isWithin；进一步收敛解析必须保留词法workspace包含、canonical包含、敏感名称原拼写及真实路径检查。不能直接删掉所有旧检查就宣布等价。
- 调用者：生产只有read_file，test/tools.test.ts:120也直接测试resolveInside；要一起迁移覆盖，不留两套安全算法。
- 最小回归：越界、同名前缀、外部链接、敏感目录作workspace、缺失叶子、hardlink继续拒绝；保持正常read/missing-file合同。
- 注意：重复路径解析不是TOCTOU防护，整合也不能宣称消除了竞态。

### PT05 低：测试专用的生产Provider选择helper

- 证据：[cli.ts](../src/cli.ts):68–72 resolveAdapter的调用者仅在phase1/interactive测试；真正main在93–99通过loadProvider/configureProvider独立选adapter。
- 风险：helper测试通过不能证明用户启动的配置选择正确；两条路径容易漂移。
- 最小修复：删除无生产调用的resolveAdapter，测试迁往真实main/loadProvider/providerConfig入口；若要保留则让生产使用同一条路径。不要再加AdapterFactory。
- 最小回归：main收到完整环境、缺配置、部分环境、显式Echo四种组合，断言真正选中的行为。

### PT06 低：重复tool/call审计事件被当成正常

**已完成（本批）**：`pendingTools` 给当前 pending item 加 `seenCall` 标记，第二个同 id 的 `tool/call` 被判为重复并按**第二条**的源行号报错（`reliability.test.ts` 断言 `/line 4/` 与错误文案）；原来的 arguments 一致性检查保留。旧的无审计 message-only 路径与"未写 call 但结果未知"的恢复路径都仍然合法（同一测试用单条审计记录与 `recover` 证明）。这仍只是审计严格性修复，**没有**实现完整 Run 框架。

- 证据：[session-store.ts](../src/session-store.ts):443–449检查arguments/name，却只记录result是否重复，不记录call是否出现过。
- 实跑：给pendingTools注入内存inspect结果，assistant请求→两个相同tool/call→一个result→tool message，返回空pending而非错误。
- 不扩大结论：正常Runtime顺序路径没有产生重复call的证据；这是审计严格性缺口，不是发现工具实际重复执行。
- 最小修复：给当前pending item加可选call-seen标记，拒绝第二个call；保留旧message-only历史与“未写call但恢复未知结果”的合法路径。不必先实现整个Run框架。
- 最小回归：重复call报第二条源行，旧无审计message-only及正常recover仍通过。

### PT07 低（交互一致性）：resume不提前提示未完成工具组

**已完成（本轮）**：`/resume` 切换前先读 `pendingTools`，有未完成结果时报出数量并指向 `/inspect` `/recover`，同时声明不会自动重跑工具；补齐后不再提示。测试断言提示出现恰好 1 次（永久警告会训练用户忽略它），且恢复后 `assertReady` 通过。`src/interactive.ts`。

- 证据：[interactive.ts](../src/interactive.ts):30启动用history+assertReady，53–56恢复只用history；send入口仍有assertReady，所以不会因此交叉执行。
- 最小修复：切换后调用同一ready诊断，给inspect/recover提示，仍允许留在该会话修复；不引入会话控制器类。
- 最小回归：/resume未完成会话后直接/exit，未发送消息也应看到恢复提示。

## 4. 已知缺口再次确认，不作为新增发现

- usage缺失→0：[openai-adapter.ts](../src/openai-adapter.ts)；注入fetch实跑确认。影响计费/统计语义，见既有A09/PR2，不是新发现。
- ~~response.text全量缓冲、readFile仅stat预检、tools仅JSON对象检查~~ **已在M1协议与硬字节上限批修复**：响应体与文件读取共用 [bounded-read.ts](../src/bounded-read.ts) 的硬字节上限；工具参数按受支持Schema子集在分发前校验，不支持关键字明确拒绝。仍未做的只是完整JSON Schema标准语义与工具数量/总时长预算，不需要泛化“资源管理平台”。
- Session日志result/message仍分开追加；不保证事务/断电exactly-once。先补实际中断边界用例，再决定格式演进；本轮不建议仅为愿景重写为数据库。
- 部分注释滞后：runtime:36–39称maxSteps为终止保证，tools原有注释称registry不咨询权限但已有非只读gate；未来改到这些区域时顺手校正，不单开大重构。

## 5. 必须保留的复杂度

- ModelAdapter已有OpenAI/Echo/scripted多个实现；不是单实现接口浪费。
- TerminalIO有真实终端与fakeIO，维持可测性；不将终端控制字符转义混入持久化内容。
- Runtime的validateResponse保护自定义adapter；不能因HTTP adapter也校验就删掉。
- wx会话租约、独占header、严格尾行、显式不重跑恢复：避免数据损坏的必要机制。
- 保护根、白名单、敏感名/真实路径、hardlink拒绝、秘密不入日志测试必须保留。
- 配置的完整环境优先级、隐藏输入门槛、明确保存密钥选项和独占写不能为方便而放宽。
- test/fixtures.ts解决已发生过的测试目录/清理风险；Ponytail不是删除fixture及回归测试的理由。
- 当前顺序工具和独立单Agent保留；不提前搭建Skill运行时/插件市场/蜂群/泛化事件总线。

## 6. 验证与推荐执行顺序

已执行：Skill实际加载；固定上游文本/许可证哈希比较；两次纯内存Node探针（重复call、缺失usage；length/content_filter）；主/子审查对同一finish_reason结论用swarm_merge合并。未执行真实API/TTY/故障注入/性能测试，未重新跑全套测试或build；旧106项结果不能称为本次审查全部通过。

产品src/test/scripts及package/lock/tsconfig/gitignore聚合SHA256前后：
`790b703e2e65f2225e374e3bafd79475dd866777a650237df9034d3cd3433ff3`。

M1协议与硬字节上限批（含新增`bounded-read.ts`）后同一算法重算为27个文件：
`39a06ef075787f5089ccff0948d4bb8d77e0e9c32f0ce6a8f162d5fc69fd86f6`。

M1运行预算批（runtime/cli及测试）后再次重算：
`e2146206a3ae01090d580c032fdec5c6267889e4452729dbedd93d1ff7e40930`。

恢复合同第一步（新增`test/session-format.test.ts`）后重算为28个文件：
`3ff711439e969ca09288c31fc38f7ba1cad5d6ce9acf2039e1468b0b50db3840`。

恢复合同实施（ADR-0001落地，runtime/session-store及测试）后：
`6ae4b9c9bbb9a9762987aad8e8eeee7ae7b17ade7cc5042e2c7cf88d764f7606`（值变化是预期结果，不是校验失败）。

恢复合同收口与上下文预算后（新增`test/fault-injection.test.ts`）重算为29个文件：
`e524374787747ba5c786a42652e1344a085a64ac8aaa57d490f3346393befc01`。

加入token上限后仍为29个文件：
`c696627846d39e8b8853aef5a9d00e0c7f2689d921a69ca7d2d840d9e53abce0`。

持久性/PT04/PT06/窗口与剩余量/tokenizer/摘要保真/本机socket联调批后（新增`test/compaction.test.ts`、`test/provider-integration.test.ts`）重算为31个文件：
`03555c8567c35113210605eff112aed843bcb9b901800a851625f870ec320cf2`（本次口径为保留末尾LF；去掉末尾LF会得到不同的 `dd3a731b…`，此前各值属于哪种写法已不可反查，见 [VALIDATION](VALIDATION.md) 第3节说明）。

`--preflight` 联调准备检查批后（新增`src/preflight.ts`、`test/preflight.test.ts`）重算为33个文件：
`d0b5139bc108575ad52a8fec0e03afd09d3451dd35f0078ffab663a07111af37`。

建议下一批：PT01+PT02的边界错误先修并各补小测试；再做PT03/PT05低风险减法；PT04须带安全回归；PT06/PT07作为可靠性小修。它们是建议，不是本次已实施。**PT01–PT07 现已全部实施**（PT03/PT05 见上方前述批次，PT04/PT06/PT07 见各自小节标注）。M1剩余门槛仍见 [STATUS](STATUS.md)。
