# PR1：安全基线实施记录

2026-09-24。用户授权开始实施后完成第一批。此文件是该批记录，不是当前阶段入口；当前以 [STATUS](STATUS.md) 为准：M1 只读范围已于 2026-09-25 由用户确认验收。当时没有新增写文件或进程工具，现在仍然没有。

## 交付与代码地图增量

| 文件 | 本批改变 |
|---|---|
| src/security-config.ts（新增） | 可信配置合同、native realpath 及缺失叶子现存祖先解析、保护根、home/scratch 边界、敏感路径读取拒绝 |
| src/tool-environment.ts | 基础环境改成白名单；home/temp/config/cache/data 都验证；结果冻结且 helper 拒绝伪造环境对象 |
| src/runtime.ts | canonical workspace/home；独立验证 store 根；向只读工具传入活动 home/store 保护根；写临时目录前复核 |
| src/cli.ts | PERSONAL_AGENT_PROTECTED_ROOTS JSON 配置；构造前检查；移除无条件 mkdir，无参数/list 不再仅因启动创建目录 |
| src/tools.ts | 请求与 canonical 绝对路径敏感规则、hardlink 拒读；非 readOnly executor 默认不调用 |
| src/session-store.ts | canonical 安全 store 根；session 文件每次操作前拒绝链接、多硬链接和非普通文件，检查根未被替换 |
| test/fixtures.ts（新增） | .test-artifacts 下生成独占目录/owner 标记，创建前检查根；store/home/workspace 分开，无清理 API |
| test/security.test.ts（新增） | 保密、路径、链接、上下文与副作用拒绝的合成回归 |
| test/phase1、tools、tool-environment.test.ts | 迁移安全 fixture；显式 home；allowlist 断言；保留已有功能回归 |
| .gitignore | 忽略 .test-artifacts；此前生成的 .personal-agent 审计目录仍保留 |

原 CODE_MAP/AUDIT/SAFETY 保留为实施前审查快照，并加状态提示。README/IMPLEMENTATION 已更新。

## 权限和配置合同

- 工具环境仅保留 PATH、SystemRoot/WINDIR/ComSpec/PATHEXT、LANG/LC_ALL/LC_CTYPE、TERM/COLORTERM/NO_COLOR；重建 HOME/USERPROFILE/临时和 AppData/XDG 路径；Windows 重建 HOMEDRIVE/HOMEPATH。
- DSH_HOME、Provider API key、NODE_OPTIONS、代理配置和任意 TEST_SECRET 不继承。Provider 本身仍由原 CLI 配置获得密钥。
- 内置保护用户根/祖先、.dsh、所知 Windows 系统/AppData 根；额外备份目录由宿主配置，不能猜测所有备份位置。
- `PERSONAL_AGENT_PROTECTED_ROOTS` 是 JSON 绝对路径数组。例如 PowerShell：

```powershell
$env:PERSONAL_AGENT_PROTECTED_ROOTS = '["D:\\DSH-Backup","D:\\my-backups"]'
```

- 自定义 Runtime 可传 protectedRoots；这属于受信宿主配置，不允许模型修改。未知路径/权限失败按拒绝处理。
- read_file 默认拒绝 .env*、.ssh/.aws/.azure/.kube/.gnupg/.git/.dsh/.personal-agent、credentials/secrets 名称、常见私钥扩展，以及活动 home/store；选择敏感目录本身为 workspace 不能取消保护。
- 保守拒绝所有多硬链接普通文件，包括可能无害的硬链接；这是当前明确兼容性代价。
- readOnly 是宿主信任声明：false/缺失被拒绝，但恶意进程内代码可谎称 true。没有插件沙箱、审批 UI 或通用 Schema 校验。

## 验收证据

运行：

```powershell
npm.cmd run build
node --experimental-strip-types --test test/phase1.test.ts test/tools.test.ts test/tool-environment.test.ts test/security.test.ts
```

最终 **88 tests / 14 suites，87 pass，0 fail，1 skip**；类型检查通过。比原 71 项增加 17 项（安全套件 15 + 环境套件 2）。

跳过：旧符号链接文件用例因权限不可用。新增 Windows junction 现存祖先/config 逃逸和硬链接用例本机通过；不等于所有链接类型/所有平台通过。测试目录保留在 `.test-artifacts/`，此前中间验证生成的 `.personal-agent/test-runs/` 亦未清理。

实际验证：合成秘密不进入后续模型请求/日志；非只读 executor 调用数=0；拒绝 CLI home 不创建目录；敏感根作为 workspace 拒绝；配置 junction 越界拒绝；会话硬链接目标读写拒绝且目标不变；无害命名硬链接不泄露秘密。

首轮一个旧错误文案断言失败，修正明确祖先诊断后复测通过。独立只读审查两轮发现并推动了上述别名/链接修复；评审不是替代测试的证据。真实 API、PowerShell 自动变量、Windows 8.3 专项和跨平台运行未验证。

## 审计问题映射与剩余门槛

- A01：工具 env 复制秘密问题已修复；PATH 值仍来自可信宿主，不是可执行文件来源验证。
- A02：现存链接/缺失叶子、scratch 与派生配置路径检查已实现；未承诺抵抗其他进程在检查后恶意替换的 TOCTOU。
- A03：新增非只读默认拒绝；审批和参数完整校验仍待后续。
- A04：默认敏感路径/活动日志拒读；普通任意文件中的秘密无法按名称识别，不能当成 DLP。
- A16：测试移除递归删除、fixture 独立与归属标记完成；用户可另行审查清理，Agent 不自动清理。
- A05–A10 等并发、事务恢复、取消、响应/事件完整校验尚未完成。A11 仅增加静态链接防护，没有实现句柄级有界读取。

下一批：按 IMPLEMENTATION 的 PR2 做协议边界校验（Provider/事件/工具参数），随后 PR3 single-writer 与恢复。M2 写工具/M3 shell 仍不开放。
