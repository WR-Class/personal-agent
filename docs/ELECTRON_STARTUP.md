# Electron 启动失败排查（Windows）

## 现象

默认运行时 `node_modules/electron/dist/electron.exe` 启动后立即退出，退出码 `2147483651`（`0x80000003`，`STATUS_BREAKPOINT`）。`ELECTRON_RUN_AS_NODE=1` 模式下同一可执行文件可以运行，说明文件本身完整，失败发生在浏览器进程或沙箱初始化阶段。

## 本机已验证的根因

工作区根目录 `D:\DSHXM\AgentKHD` 带有可继承的强制完整性标签 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，`electron/dist` 下所有文件继承为 Low。Chromium 沙箱要求浏览器进程以 Medium 运行并降级子进程；可执行文件被标记为 Low 时进程以 Low 启动，沙箱初始化失败并触发断点。

证据：

- 修复前：`icacls electron.exe` 显示 `Low Mandatory Level:(I)(NW)`。
- 只对 `personal-agent\node_modules\electron\dist` 执行 `icacls <dist> /setintegritylevel (OI)(CI)M /T`（共 77 项）。
- 修复后：`electron.exe` 显示 `Medium Mandatory Level:(I)(NW)`；`electron.exe --version` 返回 `v44.5.1`，退出码 0。
- 修复前后逐项比对：77 项 DACL 与 SHA256 均未变化；工作区根目录 ACL 未变化。
- 当前进程令牌为 `Medium Mandatory Level (S-1-16-8192)`。

## 修复后复验

`node scripts/verify-task-restart.cjs`（未设置 `PERSONAL_AGENT_ELECTRON`，使用默认运行时；隔离 `PERSONAL_AGENT_HOME` 与 `--user-data-dir`；本地模拟模型服务，不调用付费模型）：

- 两次启动均输出 `BOOT_VERIFIED`：`sandboxed=true`、`contextIsolated=true`、渲染进程 `typeof require === 'undefined'`。
- 通过：真实发送 / 停止 / 继续，Electron 退出并重新启动，暂停任务持久化，手动恢复，两个产物且无重放。
- 日志中的两条 `chat:send` 错误是脚本有意触发的停止路径，属于预期输出。
- `npm run build`、`test/desktop-launch.test.ts`（5/5）、`git diff --check` 通过。

## 代码改动

- `desktop/launch.cjs`：新增 `exitDiagnostic`。Windows 下退出码按无符号解释并显示十六进制；仅在 `0x80000003` 时提示检查完整性标签。提示明确说明该退出码本身不能唯一确定原因。
- `test/desktop-launch.test.ts`：覆盖有符号与无符号退出码、其他错误码、非 Windows 平台、正常退出和信号退出。
- `scripts/verify-task-restart.cjs`：每次启动都检查真实的 preload 隔离状态，而不只检查 BrowserWindow 配置。

## 明确不做的事

- 不使用 `--no-sandbox`，不关闭 `sandbox` 或 `contextIsolation`。
- 启动器不自动修改任何权限或完整性标签。
- 不重置工作区根目录的标签（根目录仍为 Low，这可能是外部工具有意设置的）。

## 仍未覆盖的发行风险

- 重新执行 `npm install` / `npm ci` 或重装 Electron 后，新文件会再次继承根目录的 Low 标签，需要重新执行上述限定范围的命令。
- 打包后的安装版未验证；安装位置不同，可能不受此问题影响，也可能遇到其他原因。
- `STATUS_BREAKPOINT` 也可能由其他原因引起，例如安全软件注入、GPU 驱动或损坏的运行时。本文只证明了本机的这一种原因。
- 未在其他 Windows 版本、其他账户或 macOS / Linux 上验证。
