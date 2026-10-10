# 代表性任务验收基线

本基线使用本地模拟模型 HTTP 服务、真实核心文件工具、真实命令子进程、真实本地 MCP 服务与持久会话/任务存储。不会调用付费 Provider，也不会修改操作员会话。它验证执行与恢复链路，不代表真实模型的自主任务完成率。

## 复跑

从 personal-agent 项目目录运行：

```powershell
node --experimental-strip-types --test test/representative-task.test.ts test/desktop-skill-runtime.test.ts test/desktop-capabilities.test.ts test/desktop-task-flow.test.ts
npm.cmd run build
npm.cmd test
```

## 场景与判据

| 场景 | 实际判据 | 测试入口 |
|---|---|---|
| 文件修改、停止、同会话继续与命令验证 | create_file + patch_file 得到真实 result.txt；第三次 HTTP 请求中止；继续时保留两次结果；真实 Node 子进程读取内容并输出验证标记；历史中两个修改各只执行一次，命令审批一次 | [代表性任务](../test/representative-task.test.ts) |
| 暂停长任务、重新加载、手动恢复 | 持久状态为 paused；模型不能自行报告 continue；手动恢复后创建真实 final.txt；宿主处理 complete 后重新加载为 completed；轮数为 2、文件创建一次 | [代表性任务](../test/representative-task.test.ts) |
| Skill 渐进资源读取 | 导入真实 SKILL 与参考文件；两个工作区通过模型工具读取；初始目录不含全文，最终 tool 消息含两个 sentinel；禁用后读取拒绝 | [技能运行时](../test/desktop-skill-runtime.test.ts) |
| MCP 调用与停止 | 真实 HTTP/stdio 握手与 tools/call；批准后调用一次，拒绝不调用；连接按 owner 隔离；abort 后等待进程关闭；配置变更撤销旧连接 | [连接器](../test/desktop-capabilities.test.ts) |
| 计划与任务边界 | 未批准计划禁用写工具；修改后旧 revision 失效；错误轮暂停；重启恢复和轮数预算持久化 | [任务流程](../test/desktop-task-flow.test.ts) |

定向集成：**12 项全部通过、0 跳过**。构建、全量与差异检查的本批结果见 [STATUS](STATUS.md)。测试夹具在结束时清理，产物不是永久交付物。

## 实际 Electron 客户端补充验收

新增 [客户端重启脚本](../scripts/verify-task-restart.cjs)，使用独立 home/profile/workspace、本地 HTTP Provider、真实 preload/IPC 和文件工具；通过 CDP 鼠标事件点击发送、停止、侧栏会话、任务状态按钮和启动/恢复。不替换生产 renderer API。只为隔离模型确认替换原生对话框响应，初始模型/工作区通过夹具配置。

```powershell
node scripts/verify-task-restart.cjs
# 本机默认 Electron 无法启动；使用此前已有的备用运行时：
$env:PERSONAL_AGENT_ELECTRON='C:\Users\RongWu\Downloads\electron-test\electron.exe'
node scripts/verify-task-restart.cjs
```

- 发送创建 first.txt 后，下一 HTTP 请求保持等待；真实停止按钮结算；继续请求读取已保存工具历史且不重写文件。
- 创建长任务后停止，状态 paused、轮数 1；通过窗口关闭动作退出真实 Electron（退出 0），同 profile 重启，PID 改变；用户从侧栏打开原会话。
- 退出/启动/打开会话均不产生额外模型请求；任务仍 paused、轮数 1。点击任务状态与启动/恢复后完成 final.txt，状态 completed、轮数 2；完整历史共两次 create_file，各对应一个产物，无重放。
- [完成截图](../.test-artifacts/task-restart-completed.png) 已检查；截图和隔离目录保留于本地 .test-artifacts。界面历史仍提示不区分主动停止与请求失败；该显示限制没有在本批修改。
- 默认安装 Electron 在启动阶段退出，只有既有备用运行时验收通过。脚本早期暴露 DOM 就绪判定和把工作区置于保护 home 内的夹具错误，均只修脚本；后者正确收到 sensitive path is denied。

## 不能从本基线推出的结论

- 没有使用真实模型，不可写成“真实任务完成率 100%”；返回的工具序列由模拟服务确定。
- Node 场景只重建流程对象；补充客户端场景已驱动真实按钮和正常退出/重启，但没有验证强杀/崩溃、安装包或干净机器启动。
- MCP 是本地夹具，不证明远端生产服务或 OAuth 账号兼容；Skill 读取成功不证明模型能正确执行任何技能。
- 长任务 complete 仍接受模型证据文本，不是独立验收机制；本测试额外从磁盘检查真实文件，不能把这项检查误当成产品宿主在自动验证文本。
- 不证明操作系统沙箱、路径 TOCTOU、跨平台或文件 symlink 权限环境已经覆盖。

下一步应使用隔离测试账号和固定真实模型，对同一组任务重复验收并记录模型、费用、尝试次数和人工验收结果；这需要另行明确付费调用范围。
