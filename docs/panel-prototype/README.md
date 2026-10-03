# 面板原型（M5，设计稿，非实现）

**状态：静态 HTML mockup，零依赖，无真实数据接线。** 目的是先确认信息架构和布局，
再决定是否往下做真实的 M5（数据源、IPC/HTTP 协议、状态管理都还没定）。

**打开方式**：DSH 内置浏览器对 `file://` 本地路径的直接导航是被拒绝的（多数
Electron webview 出于安全策略如此，即使文件确实存在磁盘上），所以起了一个零依赖
静态 server：`node docs/panel-prototype/serve.mjs 4173`，然后在内置浏览器打开
`http://127.0.0.1:4173/`。`serve.mjs` 只是预览工具，不是产品代码。

## v2：视觉语言仿 WorkBuddy（反编译 CSS 取值）

v1 是深色终端风配色，是凭空选的，操作员看后要求改仿 WorkBuddy。取证方式：本机
已有一份 WorkBuddy 的逆向产物 `D:\WorkBuddy\workbuddy-asar-inspect\renderer\`
（`_research/repos` 之外，更早的会话遗留），里面是**真实编译出的 `index.html` +
CSS**，不是猜的。从这些真实文件里读出的设计事实：

- `index.html` 的骨架屏注释明写"布局参照真实 UI"：**浅色**背景（`--sk-bg:#ffffff`），
  侧边栏 220px、标题栏 38px、状态栏 22px 都是骨架屏里的实测像素值。
- `agent-chat-pane-*.css`／`home-*.css`：`PingFang SC` 字体优先、**大圆角**（chip 用
  `border-radius:999px` 胶囊、头像圆角是三个 radius token 相加、弹层 16px 圆角）、
  三级文字色阶（primary/secondary/tertiary）、`--cb-green-color` 作为选中态强调色。

v2 把 v1 的深色终端配色换成这套浅色语言：白底、`--wb-green` 主题绿贯穿主按钮/选中
态/只读徽章、胶囊形状的档位切换与工具徽章、卡片式工具调用（浅灰底 + 圆角 + 细阴影）。

## v3：侧边栏结构改为真机截图实测（本轮更正）

**⚠️ v2 文档里"WorkBuddy 没有本地可运行的实例"是错的陈述，本轮已证伪**：操作员
指出本机应该装过客户端，一查确实有——开始菜单快捷方式指向
`D:\WorkBuddy\WorkBuddyAI\WorkBuddyAI.exe`，真实启动并截图成功。这比反编译 CSS
准确得多（CSS 变量值在本地找不到定义源，只能看类名猜测用途；截图是看得见的真实
渲染结果）。

**真机截图发现的结构性差异**：侧边栏不是 v2 画的单栏，而是**两栏** —— 最左一条
56px 窄图标导航条（深色中性背景，纵向排列的功能分区图标：首页/灵感/项目/任务/
自动化/更多），右边才是 220px 浅灰的会话/分组面板（顶部搜索框+列表）。v3 据此把
`.sidebar` 拆成 `.rail`（新增，深色图标条）+ `.sidebar`（原有，现在加了搜索框）。

**截图未能覆盖的部分，如实记录而非编造**：应用当时卡在未登录的空状态，主对话区
除了侧边栏骨架外几乎全空白（连账号头像都没有），点击导航项也没有反应（怀疑是未
认证导致导航被禁用，也可能是自动化点击本身对该 Electron 窗口不生效——两种可能
都没有进一步排查）。**因此聊天气泡、工具调用卡片、输入框的真实样式仍然只有 v2
的反编译 CSS 依据，没有真机截图印证** —— 这是本原型当前最大的证据缺口，如果以后
能登录看到真实对话界面，应该回来替换这部分。

## v4：去掉账号导航条（操作员纠正，v3 判断错了）

**v3 把真机截图里那条深色图标导航条照搬了进来，但这是一个判断错误**：操作员
指出这是个人智能体，不需要账号/登录这类概念——v3 那条导航条是 WorkBuddy 作为
企业协作产品才有的东西（首页/灵感/项目/任务/自动化/组织账号头像），照搬视觉
语言不等于照搬功能语义，这条导航条的*存在前提*（多项目、组织账号、需要登录）
在这个产品里根本不成立。v4 删掉了 `.rail` 整块，侧边栏恢复为单栏（会话列表 +
信任根目录），回到 WorkBuddy 骨架屏本身展示的那种更朴素的单栏形态。

**同一轮里操作员还纠正了右侧栏的问题**，但诊断结果不同：右侧栏（后台作业/MCP
插件/审计日志）的内容是本项目自己的真实能力，不是编造的、也不是抄错对象，操作员
确认"其他的没问题"，只是最初的措辞让人误以为要删——这一栏原样保留。

**没有做的**：没有照抄 WorkBuddy 的具体功能（它是通用助理产品，没有档位切换/工具
调用卡片/MCP 插件这些概念），只借用色板、圆角尺度、字体这些视觉语言，功能区划分
仍按本项目的信息架构（见下表）。

## v5：补齐视觉能力声明后，按真机截图**整体重画**（不只是侧边栏）

**前置修复**：操作员指出"你应该也是有视觉的，先把自己声明成可以看图"。实查
`C:\Users\RongWu\.dsh\profiles\desktop\cordis.patch.yml`，`kimi-k3`、`fable-5.1`、
`gpt-6-astra` 三个模型的条目都缺 `input: [text, image]`（只有 `claude-fable-5`
早前补过），导致 `read_image` 在前几轮模型切换后一直报 "does not declare image
input"——**此前几轮"看过截图"的判断实际是在看不到图的情况下做出的，这是 v3/v4
反复判错结构的根因之一**。已给三个模型都补上该声明（patchReload: live，即时生效），
并真实重读了截图。

**亲眼看到截图后确认的真实布局**（纠正此前多处分歧）：

1. **权限选择器在输入框内部**——截图输入卡片底部左侧是 "🛡 默认权限 ▾"，不在
   标题栏。v1-v4 把档位切换放在标题栏是错的；v5 移入输入卡片，映射 `--tier`。
2. **模型选择器也在输入框内部**（右下角 + 发送按钮），v5 移入。
3. **助手消息没有气泡**——头像+名字+状态行（"已完成 6s"）+纯文本+底部一排操作
   图标（复制/赞/踩/重试+模型名）；只有用户消息有右对齐小灰气泡。v1-v4 的左右
   气泡对开是错的。
4. **右侧栏是抽屉**：默认关闭，右上角 ⿻ 按钮开合；内部区块可折叠（截图里的
   "概览 ▾ / 产物 ▾"）。这回答了操作员"后台作业/MCP 插件/审计日志是不是可折叠
   抽屉"的问题——v4 及以前是常驻 300px 侧栏、不可折叠，**不对**；v5 改为
   `position:fixed` 抽屉 + `<details>` 折叠区块 + 标题栏开关按钮。
5. **对话内容居中限宽**（反编译 CSS 实测 `max-width:832px`），v5 的 chat 与
   composer 都收敛到这个宽度。
6. 输入框是居中的白色大圆角卡片带阴影，不是贴底横条。

侧边栏保持 v4 确认过的结构（文字入口 + 任务/空间折叠组），但去掉了 emoji 堆砌
之外的臆造图标，并按截图补了会话相对时间列。

侧边栏功能入口的取舍（操作员确认）：
- "专家·技能·连接器" → **技能与连接器**，对应 `mcp-plugin.ts` 的
  MCP 桥接 —— 概念本来就重叠，不是硬凑的类比。
- "任务(N)" → **任务** 折叠组，对应 `task-state.ts` 的任务追踪。
- **"助理""定时任务"没有加**：本项目没有多助理切换、没有任务调度器，加上就是
  伪造能力。
- "空间"分组 → 会话按工作区分组（`<details>` 原生折叠，见下表⚠️行：代码里
  尚无此机制，是原型设想）。

## v6：收编操作员提供的交互原型为基座，按真实能力裁剪

操作员提供了一份 390 行的 WorkBuddy 风**交互**原型（`新建 文本文档 (4).html`）——
可真实发送、模拟执行流、授权三选一、右侧 tab 面板、弹出菜单，比 v5 的静态 mockup
更接近"面板长什么样、点起来什么感觉"。操作员选择**收编并改造**。

**保留的**：整体交互框架（会话发送/停止、计划步骤 running/done/skip、授权卡片
允许一次/始终允许/拒绝、右侧面板 tab、弹出菜单、深浅色变量）。

**裁剪掉的（本项目没有的能力，一律删除不保留空壳）**：专家中心、自动化（定时
任务）、技能商店开关、Agent/Chat/Plan 三模式、附件上传、文件产出预览 tab、账号
登录行、设置弹窗里的"文件权限"开关。

**接入的真实概念**：
- 三模式选择器 → **四档 `--tier`**（read-only / ask-before-writing / workspace-write /
  full-access），且**档位真实影响模拟行为**：read-only 直接跳过授权、full-access 不询问、
  中间两档弹授权卡；"批准且 2 分钟内免问"对应 `approveExact`。
- 技能页 → **技能与连接器**页，卡片形状照 `loadMcpPlugins` 的返回（`tools`/`errors`、
  已连接/启动失败两种状态、readOnly/approve 规则）。
- 右侧 tab → **进度 / 作业 / 审计**三页，分别对应 `task-state.ts`、
  `background-jobs.ts`、`session-store.ts` 的 `appendAudit` 事件形状。
- 输入卡片下方的预算行照 `formatBudget` 字段。

## 每个区块对应 CLI 里的哪个真实概念

原型里出现的每一项都能在已实现的代码里找到对应事实，不是凭空设计的功能：

| 面板区块 | 对应的真实概念 | 代码位置 |
|---|---|---|
| 侧边栏"技能与连接器"入口 → 插件页 | MCP 插件桥接；卡片形状照 `loadMcpPlugins` 返回的 `{tools, errors}` | `mcp-plugin.ts`、`mcp-bridge.ts` |
| 侧边栏"任务"折叠组 | 任务状态追踪 | `task-state.ts` |
| 侧边栏会话列表 | `/sessions`、`--session <id>` | `cli.ts:38-39,72,131` |
| ⚠️ 会话按"空间"（工作区）分组 | **原型独有的推测映射，代码里没有这个机制** | `--workspace`（`cli.ts:133`）与 `--session`（`cli.ts:131`）是两个独立维度，无关联分组逻辑；要做需新增代码 |
| 输入卡片内的权限档位 chip（"🛡 workspace-write ▾"） | `--tier` 四档 | `tiers.ts`、`cli.ts` 的 `resolveTier` |
| 输入卡片内的模型 chip | 运行时的 `adapter.defaultModel` | `cli.ts`（`model:` 字段） |
| 助手消息（头像+名字+状态行+纯文本+操作行） | `session-store.ts` 的消息事件 + `result.reasoning` | `runtime.ts` `send()` |
| 用户消息灰气泡 | 同上（user 角色事件） | 同上 |
| 工具调用卡片（可展开，含参数/结果） | `ToolCall`/`ToolResult`，`readOnly` 徽章、`mcp__` 前缀 | `tools.ts`、`mcp-bridge.ts` |
| 批准卡片 | `approve` 回调、`approveExact` 的"2 分钟免问"提示 | `tools.ts` 的 `approveExact` |
| 底部预算行（输入卡片下方居中） | `formatBudget` 的步骤/工具调用/令牌/用时/写入统计 | `runtime.ts` `formatBudget` |
| 任务完成行 | `formatTaskAssessment` | `task-state.ts` |
| 右侧面板（标题栏 ▧ 开合，进度/作业/审计三 tab） | 面板形态仿 WorkBuddy；内容为本项目真实能力 | — |
| ├ 进度 tab | 任务步骤状态 | `task-state.ts` |
| ├ 作业 tab | `run_in_background`/`job_output`/`job_kill` | `background-jobs.ts` |
| └ 审计 tab | `store.appendAudit` 事件 | `session-store.ts` |

## 明确没有回答的问题（留给下一步决策）

- **交付形态已定（操作员决定）**：独立 Electron 应用，**不用** DSH 的
  `dsh-plugin-desktop` 机制——不希望自己面板的窗口/生命周期受 DSH 插件框架约束。
  仍待定的是 Electron 侧的具体脚手架（窗口管理、打包、更新通道）。
- **数据从哪来**：面板要读 `session-store.ts` 的 `.jsonl` 事件流，是直接读文件、
  起一个本地 HTTP/WS 服务、还是把 `AgentRuntime` 内嵌进面板进程？这决定了会不会
  产生"CLI 和面板各跑一份 runtime，状态不同步"的问题。
- **实时性**：工具调用/审批要不要流式推送到面板（类似 SSE），还是轮询/手动刷新。
- **批准怎么真正生效**：`approve` 回调目前是 CLI 的 `io.ask()`；面板要提供一个
  等价的回调通道，而不是假装点了按钮就完事。

## 明确不做的（ponytail）

- 不做真实的状态管理框架选型（React/Vue/原生）——这是下一步的决定，不是原型的决定。
- 不做深色/浅色主题切换、国际化——原型固定用浅色（WorkBuddy 默认 IDE Light 风）。
- 不做响应式布局——先假设桌面宽屏。

## v7：Electron 桌面壳落地（2026-10-02）

操作员指令（原文）："按照这个 wb-client.html 构建客户端面板吧……不需要你删除某些功能签。"
这**反转**了此前"裁掉未实现能力空壳"的策略：wb-client.html 的全部功能入口/标签/菜单
一律保留；未接线的交互以"未接线"明示，绝不伪装成功。

已落地（`desktop/`）：

- `main.cjs`——无边框 1440×900 窗口；`sandbox:true`、`contextIsolation:true`、
  `nodeIntegration:false`；主进程拒绝一切导航/新窗口/下载/权限请求；IPC 处理器
  校验 `senderFrame` 是主 frame 且 URL 等于入口文件。
- `preload.cjs`——contextBridge 仅暴露 `windowAction(min|max|close|reset|new|fullscreen)`
  与 `onMaximized` 白名单。
- `renderer/`——原单文件原型拆分为 `index.html` + `styles.css` + `app.js`；
  CSP 收紧为 `script-src 'self'`。33 处交互打点"未接线"标记；窗口控制六动作真实接线。

已接线 / 未接线边界：窗口动作真实；聊天发送、任务增删、设置持久化、模型配置、
更新、帮助等全部仅展示提示——等运行时装配（IPC ↔ `AgentRuntime`）再逐个点亮。

环境注记（更正）：同一 Electron 44.5.1 的 dist 副本放到 Downloads 后，默认参数可
启动本项目真实窗口，renderer 带 `--enable-sandbox`。原位置曾出现 0x80000003 /
0xC0000005；目前只确认运行位置相关，尚未证明 ACL、签名或其他具体机制。
此前“未签名是唯一变量”“WorkBuddy 的 Electron 是 32.2.0”的判断均撤回。
依赖固定为 **Electron 44.5.1**；无需降级或禁用沙箱。

启动：`npm run start:desktop` 默认使用安装的 Electron。若本机原位置仍启动失败，
可显式指定已验证的同版本完整运行时（不是只复制 exe，也不依赖 WorkBuddy/DSH）：

```powershell
$env:PERSONAL_AGENT_ELECTRON = "$env:USERPROFILE\Downloads\electron-test\electron.exe"
npm run start:desktop
```

启动器仅为子进程清除宿主遗留的 `ELECTRON_RUN_AS_NODE`，保留参数与退出失败状态；
不会自动复制运行时、修改文件权限或加入 `--no-sandbox`。显式外部路径不会触发下载；
默认路径使用 Electron 官方 npm 入口，Electron 44 在安装不完整时可能自动下载运行时。
开发环境需要 Node >=22.12（与 Electron 44 的 npm 依赖要求对齐）。
这是开发阶段的显式路径替代方案，不是权限根因修复或安装包。
桌面产品名使用 Personal Agent，保留原型来源说明及全部功能入口。
验证：构建、语法检查与桌面 4 项回归通过。补充异常分支后曾两次在 MCP 测试的
同步 after 清理中遇到 Windows EPERM；三个 MCP 测试改为 await fs.promises.rm，
保留原重试预算且不吞错误，让子进程 close/error 回调在重试期间继续运行。
随后定向 26 项通过、全量连续三次 786 项（785 通过、1 跳过、0 失败）。
这是清理时序改善的实测结果，不声称解释了全部历史 EPERM 或修复了系统权限。
真实 Electron 页面经 CDP 验证标题、设置/关于名称与未接线提示；最大化、恢复、关闭
成功，启动器正常退出 0，渲染页面 `require` 不可用。未声称完成逐像素视觉验收。
启动日志仍有 GPU 缓存目录拒绝访问告警，未妨碍上述验证；未修改权限或删除用户缓存。
