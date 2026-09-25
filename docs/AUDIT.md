# 审计问题与当前修复映射

更新：2026-09-24，会话可靠性首批后。A01–A17 是最初审查的稳定编号；本表保留原始风险摘要并更新当前状态，不再将旧行号或旧探针当成当前缺陷。阶段以 [STATUS](STATUS.md) 为准。

状态定义：**已处理（限定范围）**指原始具体行为已修复且有相应用例；**部分处理**不等于关闭整个风险；**待处理**仍无对应完整实现。下面测试文件名表示可定位断言，不意味着本次文档整理重新执行成功。

## 逐项映射

| ID/原级别 | 原始风险 | 当前状态与源码 | 测试证据 | 剩余事项 |
|---|---|---|---|---|
| A01 P0 | env复制宿主密钥/DSH_HOME | 已处理（工具env继承范围）；tool-environment.buildToolEnvironment白名单 | security、tool-environment：secret/NODE_OPTIONS不继承，base不变 | PATH来源仍信任；不是OS身份隔离 |
| A02 P0 | home词法、外部scratch、Context可伪造 | 部分处理；security-config canonicalPath/resolveRuntimePaths；派生配置目录/issued对象校验 | security：缺失叶子祖先junction、外部temp、config逃逸、保护store | TOCTOU、不可信进程内工具、真实平台隔离仍无保证 |
| A03 P0 | 注册写工具直接执行，无Schema/审批 | 部分处理；ToolRegistry拒绝readOnly!==true，分发前按受支持Schema子集校验参数 | security：executor调用数0；tools：类型/enum/必需键/封闭对象拒绝且executor未运行 | 完整JSON Schema语义、Policy/Approval及授权参数绑定待做 |
| A04 P1 | workspace秘密/日志可外发 | 部分处理；assertReadablePath+活动home/store保护，provider-config拒读，hardlink拒读 | security：内容不进请求/log；interactive：旧home config拒读 | 任意普通文档秘密不能命名识别；无DLP/外发审批 |
| A05 P1 | 并发send交叉上下文 | 已处理（合作本地进程）；Runtime整轮withWriter+busy | reliability：双Runtime、嵌套Runtime、真实子进程拒绝 | 非合作进程/网络FS不在保证内；不排队 |
| A06 P1 | exists/create竞态、重复header | 部分处理；SessionStore.create wx/幂等，唯一header/ID检查，append持锁 | reliability：幂等header、错误ID、遗留锁拒绝 | 多事件事务/强杀各边界验证尚无；direct append内部复用依赖受信await合同 |
| A07 P1 | result与message分写、悬挂工具 | 已处理（限于新写入）；ADR-0001 已实施：每次工具调用只写1行message，双写消除，消息带runId/step，isError入事件层 | reliability：复用已存result、未知状态、幂等、原字节前缀、不请求模型；session-format：旧v1 golden fixture、新形状由真实运行冻结、缺字段旧审计行不致命 | 逐写点故障注入、断电持久性未知；旧日志仍含审计对（只读不写） |
| A08 P1 | 取消被当普通错误继续 | 部分处理；Runtime循环检查、批次补取消消息；interactive只隐藏真实abort | interactive：预取消/第二工具不运行/配对完整 | 当前readFile未传signal；已开始任意工具必须等settle；总deadline待做 |
| A09 P1 | 畸形Provider响应污染日志 | 部分处理；openai-adapter unknown解析+response-validation，Runtime持久化前校验；PT01拒绝明确length/content_filter | interactive：字符串usage/未完成回复拒绝、只保留user且工具零执行、HTTP正文不泄漏 | 完整wire往返/畸形组合/timeout测试、错误事件与缺失用量语义待做 |
| A10 P1 | 非法版本/tokens/role、未配对 | 部分处理；migrateEvent严格数值/role，pendingTools序列诊断 | reliability：负/小数/Infinity、tool缺ID、孤立消息行号 | types仍非判别联合；直接append只做结构校验；完整历史语义/迁移矩阵待补 |
| A11 P1 | 路径check/open竞态、size预检非硬限制 | 部分处理；native真实路径和静态链接/硬链接拒绝；read_file改为句柄级有界读取，256KiB为硬上限 | security、tools：路径/别名相关用例（symlink有skip）；恰好达限可读、超1字节拒绝 | 增长/替换竞态与read-then-open窗口测试待做 |
| A12 P1 | HTTP无限缓冲，缺总工具/时间预算 | 部分处理；HTTP响应体1MiB与文件读取256KiB硬字节上限、每步/整轮工具预算与整轮deadline已实现；上下文预算（字节+token+按模型窗口+可选本机tokenizer预判+剩余量显示）与摘要保真压缩已实现 | tools：无界流超限终止、按字节而非字符计数、每步/整轮超限且已发出的调用仍配对、deadline不伪装成普通abort；interactive：预算标志/环境解析与非法值拒绝；phase1：谎报content-length仍被拒；provider-integration：真实socket上deadline中断；compaction：压缩不删消息、边界实测、未完成批次/空摘要拒绝 | 未内置分词器（需宿主提供）；按模型窗口不派生字节上限；外部托管Provider与真实TTY未验证 |
| A13 P2 | flag吞值、静默Echo、list副作用 | 已处理（原始行为）；cli参数校验/显式echo/--/list无需Provider | phase1、interactive、tool-environment | 配置更新UX/更多退出码subprocess矩阵待补 |
| A14 P2 | 终端控制字符注入 | 已处理（默认渲染）；terminal.safeText，CLI输出转义 | interactive：ESC转义 | 实体TTY/平台组合持续验证；无承诺原始输出模式 |
| A15 P2 | TS测试发现/版本与构建承诺不符 | 部分处理；package test显式strip-types/glob，文档声明noEmit | 既有build/test实际记录 | engines>=22.6、TS^5.6.3与rewrite选项仍需收窄；零发现门槛/发行方案 |
| A16 P2 | recursive清理、fixture越界写入 | 已处理（测试fixture范围）；fixtures唯一标记/校验/分目录/保留 | 所有六测试入口使用helper；无recursive删除hook | session-lease仅释放确切锁叶，不属于fixture清理；不自动删除遗留数据 |
| A17 P2 | 工程化/文档与承诺脱节 | 部分处理；主文档已统一，Git 与 GitHub Actions 已实测（Windows + Node 22.x/24.x） | 文档链接/源码完整性复核 | 正式发行构建、非 Windows 平台与真实 TTY 自动化未完成 |

测试路径均在 [test目录地图](CODE_MAP.md) 中可点击。`--preflight` 联调准备检查批最新实跑为184项/183通过/1跳过，类型检查通过；新增「探测不发密钥且不读响应正文、401算可达」「密钥内容/长度/片段均不打印」「残缺配置不判ready」「坏tokenizer阻止"可尝试"并 exit 3」「非UTF-8命令输出不打印乱码」「TTY状态如实报告」。持久性/PT04/PT06/窗口与剩余量/tokenizer/摘要保真/本机socket联调批实跑为174项/173通过/1跳过；token上限与参考证据复核实跑为142项/141通过/1跳过；恢复合同收口与上下文预算实跑为139项/138通过/1跳过；恢复合同实施实跑为130项/129通过/1跳过；恢复合同第一步实跑为128项/127通过/1跳过；运行预算轮实跑为122项/121通过/1跳过；M1 协议与硬字节边界首批实跑为117项/116通过/1跳过；PT03/PT05实跑为110项/109通过/1跳过。详见 [VALIDATION](VALIDATION.md)。

## 不应再重复的旧结论

- 不能再称“没有会话锁”“env仍复制全部秘密”“没有交互CLI”或“缺配置静默Echo”。
- 也不能反过来称“有锁就是事务”“有路径规则就是OS沙箱”“TS接口就是JSON Schema”。
- inspect的结构问题与pendingTools的语义问题分开；history仅投影消息不代表完整语义验证。
- 副作用默认拒绝不代表能运行不可信插件；插件代码可谎称只读或直接访问进程能力。
- 用户确认CLI可运行，不等于所有密钥/TTY/Ctrl+C/Provider细节都实测通过。

## 剩余优先级

1. A03/A09/A10：完整协议合同与角色判别联合（参数Schema已首批落地）。
2. A11/A12：上下文与token预算（文件/响应硬读取上限、工具数与运行时长预算已落地）。
3. A06/A07/A08：实施 ADR-0001（消除双写、加 Run/Step 身份）、恢复/取消故障边界、逐写点注入。
4. A15/A17：发行构建、非 Windows 与文档持续检查。Git 与 GitHub Actions 已实测。
5. 写文件/进程能力仍未开放，进入 M2/M3 前要另行确认；见 [IMPLEMENTATION](IMPLEMENTATION.md)。

## 历史证据说明

最初审查为8个src、3个test，71项测试（70通过/1跳过），含合成探针；后续PR1/CLI/会话批次改变源码后，旧探针结论不再代表当前行为。原事故不在本次重演，未做破坏性验证。批次记录保留在 PR1_STATUS、CLI_STATUS、SESSION_RELIABILITY；本表是修复状态的当前入口。
