# 会话可靠性第一批

日期：2026-09-24。保留现有 npm start 交互方式；用户已确认前一版可运行。本批补单 writer、严格事件/header 校验和显式中断工具组恢复，不开放新执行权限。

## 用户可见变化

- 同会话另一个写入者正在工作时明确拒绝，不排队、不交叉写入。
- `/inspect [id]`：当前/指定会话结构问题和工具配对检查，输出位置，不打印原始损坏行内容。
- `/recover [id]`：显式追加缺失的 tool message；已有 tool/result 原文保留；没有结果时标注“执行状态未知，恢复未重跑工具”。
- 损坏 JSON、无换行尾部、错 header 或孤立/冲突消息拒绝自动恢复。原文件不改写，用户可 `/new` 开始独立会话。
- Ctrl+C 与写盘/锁释放失败同时发生时，不再把真实故障冒充正常取消。

## 代码地图增量

- `src/session-lease.ts`：local-filesystem 排他 `.jsonl.lock`，wx 创建、随机 owner token/PID/time、同范围内部存储调用可复用租约；Runtime 外层不允许重入。
- `src/session-store.ts`：withWriter、私有 mutation、wx 幂等 header 创建；append 前结构验证与严格读；inspect 保留 eventLines；pendingTools/assertReady/recover。
- `src/runtime.ts`：整个 send 持有会话租约，写用户消息前检查未完成工具组。
- `src/interactive.ts` / `src/cli.ts`：诊断/恢复指令及帮助；损坏会话启动时留在 CLI，可检查/新建。
- `test/reliability.test.ts`：9 项并发、跨进程、校验、恢复和 CLI 用例。
- `test/tools.test.ts`：损坏 fixture 用原始合成追加构造；生产 append 现在必须拒绝继续扩展坏文件。

## 租约合同

使用规范化 store/session 路径；Windows key 大小写归一。完整发送持锁，公开 create/append 各自也取得租约。不同会话使用不同文件。相同会话争用抛 SessionBusyError；不自动等候和抢占。

释放只删除本次确切拥有的单个锁文件：验证 regular leaf、链接数、dev/ino、canonical path 与随机 token。**这不是测试清理，也没有递归删除。**锁之外的用户日志/备份没有删除。

异常退出可能留下 `.jsonl.lock`：本版有意拒绝自动过期/PID 猜测接管（PID 可复用）。处理方法是关闭相关 CLI、核实确无写入者、保留锁记录和会话副本后，由操作者处理这一个锁文件；不要批量删除锁，更不要清理整个 home。锁未解除时 `/recover` 也拒绝。

仅保证本程序合作进程在本地文件系统的互斥；未验证 NFS/SMB、恶意进程绕过、检查后链接替换。内部受信代码不能用 detached/unawaited mutation 绕过 await 合同。

## 格式与恢复决策

保持 v1 的事件形状；无版本旧行仍可升级。新增更严格语义可能使过去宽松接收的不合法记录报错，这是保守兼容性变化。拒绝负/小数版本、非有限/负/小数 tokens、错误角色字段、空/重复本批 call ID。append 在 stringify 前检查，避免 Infinity 被变成 null。

会话必须恰好一个首部 header、ID 匹配；存在但空文件、重复 header、尾行未换行拒绝扩展。未知 ignorable kind 的旧策略保留。

pendingTools 从消息和可选审计事件扫描当前末尾批次：正常历史 message-only 工具配对仍接受。未完成组阻止新 send；恢复不发模型请求，不调用 executor。已保存 result 仅补 message；未知结果写错误标记。重复 recover 返回0，原字节保持为新日志前缀。

这不是原子事务：一次事件追加仍可能被截断，assistant/usage/result/message 仍分开写，没有 fsync 每条数据保证或断电模拟。恢复期间再次出错需重新 inspect；无法解析的尾部不会自动截断/删除。全 Run 状态机、跨步骤身份、完整 Schema、上下文绑定后续继续。

## 验证

实际运行：npm.cmd run build 与 npm.cmd test。

**106 tests / 14 suites：105 pass，0 fail，1 skip**（旧符号链接创建权限不足）。

新增覆盖：
1. 两个 Runtime 同会话争用拒绝，释放后可继续。
2. adapter 内嵌另一个 Runtime 不能继承内部租约绕过。
3. 真正 Node 子进程争用被拒绝（stdio inherit，无网络）。
4. header 初始化幂等，遗留锁拒绝。
5. 不合法版本、角色、tokens 拒绝。
6. 截断尾部/header ID 不符拒绝追加，原文件内容不变。
7. 孤立工具结果给出行号/ID，不泄露内容，拒绝恢复。
8. CLI 指定会话 inspect/recover/resume。
9. 已存结果复用、未知状态标记、恢复幂等、不调用模型/工具、原字节前缀保留。

独立只读审查未发现合作本地锁假设下的 P0/P1；发现并修复取消掩盖写盘错误、配对故障缺少行号，以及空文件误报健康。评审没有替代实际测试。未进行全盘断电、真实进程强杀、恶意竞态或网络文件系统验证。测试 fixture 全部保留。
