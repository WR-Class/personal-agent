# Personal Agent 桌面面板

## 当前可用版本（下方 v1–v8 为历史设计记录）

当前产品入口是独立 Electron 客户端，不是本目录早期静态 mockup。
以操作员提供的 `D:\WorkBuddyXM\JM\wb-client.html` 为基座；保留入口与标签，
不因后端缺失而删除控件。品牌改为 Personal Agent，原型数据与未接线动作明确提示。

### 启动

在项目根目录运行（Node >=22.12）：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run start:desktop
```

本机默认 Electron 路径曾启动失败；可按本文下方说明，通过
`PERSONAL_AGENT_ELECTRON` 显式指定同版本完整 Electron 44.5.1 运行时。
不要禁用沙箱。当前是源码开发运行方式，尚无安装包。

### 已接入的独立入口

- 窗口控制、版本和隔离信息：真实宿主数据。
- **本地会话**：读取宿主 `PERSONAL_AGENT_HOME`（默认项目 `.personal-agent`），
  刷新并点击只读历史；上限 1 MiB、最后 200 条，不重放工具。
- **离线 Echo 测试**：不联网，不是大模型；通过 AgentRuntime 保存新会话。
- **模型问答（无工具）**：每次新会话，先显示地址/模型，再点击确认发送。
  密钥不返回页面；每次确认仅用一次，5 分钟过期；拒绝旧预览和重定向。
  最多输入 8192 UTF-8 字节、输出 2048 token、等待 60 秒。
  文本、宿主长期约束及运行时提示会发往所示服务，可能计费。
  关闭弹窗不取消请求；失败可能留下部分日志，不自动重试。

**桌面配置入口：设置 → 模型 → 添加模型提供商。**
第三方页提供 DeepSeek / OpenAI / Kimi 预设；展开自定义设置可覆盖 API 地址。
自定义页填写 Provider ID、显示名称、API 地址与密钥。当前协议仅支持 OpenAI Chat Completions，
未实现 Anthropic/Bedrock 协议，不展示为可用选项。
点击醒目的 **获取可用模型** 按钮，将携带所填密钥请求该地址的 `/models`，
不会发起聊天；最多 15 秒、256 KiB、500 个模型，禁止重定向。不支持列表时可以手动添加 ID。
获取的模型默认全部加入目录，可移除后保存；获取成功不等于各模型均有聊天权限。
保存后，在侧栏“模型问答（无工具）”选择提供商/模型并确认发送。

桌面配置写入 Agent home 的 `desktop-providers.json`，密钥由 Electron safeStorage 加密；
加密不可用时拒绝保存，不自动降级明文。编辑不回填密钥，留空仅在原地址/身份下复用；
换地址须重新输入密钥。清除密钥可删除后重建提供商。重复 ID 创建拒绝；并发旧版本拒绝。
保存后的配置变更会使旧模型发送确认失效。配置目录不应同步或共享，也不应手工编辑密文。
本轮没有加入设计稿的“打开配置文件”按钮，避免把含密文的内部存储当普通用户配置编辑。
其他设置页仍按原型保留，尚未接线。

**可复验：**先关闭调试桌面，再运行 `node scripts/verify-provider-settings.cjs`。
脚本自动启动真实 Electron 与回环模拟服务，使用隔离的临时 Agent home；覆盖两个添加页的
模型发现、加密保存、留空密钥编辑、关闭保存后重开、页面重载、重复创建拒绝、删除与问答。
可用 `PERSONAL_AGENT_ELECTRON` 指定本机运行时；不会读取真实 Provider 或调用云端。
本轮全量：793 项，792 通过、1 跳过。模拟服务验收不代表实际云端账号可用。

仍保留 CLI 的 `loadProvider` 兼容入口。可在启动桌面的宿主环境中设置完整的
`PERSONAL_AGENT_BASE_URL`、`PERSONAL_AGENT_MODEL`、`PERSONAL_AGENT_API_KEY` 三项；
不要把密钥写进源码或截图。CLI 已保存的完整配置也可读取；只保存地址和模型、
未保存密钥的配置无法直接用于桌面。环境配置不能与文件里的密钥拼接。
配置预览不是连通性证明；遇到失败先查历史，避免重复收费。

普通首页/聊天发送仍是本窗口原型展示，不会保存或调用模型；模型问答请用独立入口。
工具、流式逐字显示、取消请求、工作区选择、模型以外的设置持久化及其他原型后端
尚未接入。CLI 的工具能力不等于桌面已经具备。原型侧栏/浏览器/终端示例也不是真实任务。

### 可复验的证据与限制

```powershell
npm.cmd test
# 先启动桌面；调试端口仅用于本机验收，平时不要开启
npm.cmd run start:desktop -- --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224
# 另一终端执行；可省略最后一个参数，此时不对比外部原型
node scripts/verify-desktop.cjs D:\WorkBuddyXM\JM\wb-client.html
```

`PA_VERIFY_NO_SCREENSHOTS=1` 可只运行断言而不改截图。验收脚本会刷新桌面，
应在没有请求运行时使用；不会发送模型请求、读取历史正文或启动替代 Web 服务。
已核对原型具名按钮/输入框均保留，5 主导航、8 子入口、4 面板，以及 1440/800 宽度
弹窗边界、Escape 关闭和渲染进程 Node 隔离。不是全原型逐像素一致或全部交互的证明。
模型链路已用真实 Electron + 本机 HTTP 模拟服务验过确认发送及历史回读；
真实云端模型未在此次桌面验收中调用。全量基线：792 项，791 通过、1 跳过。
截图见 [宽屏模型弹窗](acceptance/model-1440.png)、[窄屏模型弹窗](acceptance/model-800.png)。

---

# 历史面板原型（以下状态只对应各历史版本）

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

首条只读数据接线：`desktop:info` 复用窗口主 frame / URL 校验，经 preload 提供
实际 app/Electron/Chromium/Node 版本、平台及 renderer 的 sandboxed/contextIsolated。
版本菜单读取真实值；底栏明确区分“桌面已就绪”和“Agent 未接线”，不代表工具 OS 隔离。
移除原型随机令牌计数，连接器、模型、分支、用量与套餐积分不再冒充实时数据；入口保留。
构建、语法检查与全量 789 项（788 通过、1 跳过、0 失败）通过；真实窗口 CDP 已确认
隔离布尔值为 true、Agent 为未连接、等待超过旧定时器周期后用量仍显示未接线。
