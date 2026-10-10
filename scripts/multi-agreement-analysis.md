node : Loaded 211 multi-model rows from D:\DSHXM\AgentKHD\personal-agent\scripts\intent-distilled-multi.jsonl
所在位置 行:1 字符: 129
+ ... ew($false); node --experimental-strip-types scripts/analyze-multi-agr ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (Loaded 211 mult...led-multi.jsonl:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 

## Agreement bucket counts

- all         29 (13.7%)
- partial    180 (85.3%)
- split        2 (0.9%)
- single       0 (0.0%)

## Prompt length (chars) per bucket

| bucket | mean | median | min | max |
|---|---|---|---|---|
| all | 47.6 | 48 | 4 | 153 |
| partial | 46.5 | 49 | 5 | 217 |
| split | 9.5 | 12 | 7 | 12 |
| single | 0 | 0 | 0 | 0 |

## Per-consensus-intent disagreement rate (split / total)

| intent | total | all-agree | partial | split |
|---|---|---|---|---|
| fix | 190 | 22 | 168 | 0 |
| verify | 5 | 1 | 3 | 1 |
| research | 11 | 5 | 5 | 1 |
| operate | 1 | 0 | 1 | 0 |
| build | 4 | 1 | 3 | 0 |

## Per-model "odd-one-out" count (rows where it disagreed from majority)

- jev      166
- claude   6
- grok     12

## Top 15 ambiguous prompts (lowest consensus spread, all models weak)

- "中文告诉我" consensus=research models: jev=research@0.43 claude=research@0.20 grok=fix@0.20
- "中转聚合站" consensus=research models: jev=research@0.49 claude=research@0.72 grok=fix@0.20
- "渗透安全测试" consensus=verify models: jev=verify@0.80 claude=verify@0.96 grok=fix@0.20
- "个人Agent" consensus=research models: jev=research@0.47 claude=build@0.60 grok=fix@0.20
- "现在确实可用了" consensus=verify models: jev=verify@0.48 claude=verify@0.18 grok=fix@0.20
- "能给个中文面板吗" consensus=build models: jev=build@0.55 claude=build@0.87 grok=fix@0.20
- "已经重启了，试试" consensus=fix models: jev=fix@0.78 claude=verify@0.96 grok=fix@0.20
- "已经重启并恢复了会话" consensus=fix models: jev=fix@0.38 claude=operate@0.65 grok=fix@0.20
- "恢复Dsh项目历史记录" consensus=fix models: jev=fix@0.70 grok=fix@0.20 claude=operate@0.90
- "运行项目目录下的项目文件" consensus=verify models: jev=verify@0.53 grok=fix@0.20 claude=operate@0.94
- "静默启动，我刚刚把窗口关了" consensus=operate models: jev=operate@0.25 grok=fix@0.20 claude=operate@0.97
- "看下项目目录里面的东西，知" consensus=research models: jev=research@0.73 grok=fix@0.20 claude=research@0.92
- "你是技术调研员。任务：把用" consensus=research models: jev=research@0.83 grok=fix@0.20 claude=research@0.90
- "为什么之前的聊天全部没有了" consensus=fix models: jev=fix@0.57 grok=fix@0.20 claude=research@0.85
- "只回复两个字：收到。不要调" consensus=verify models: jev=verify@0.30 grok=fix@0.20 claude=verify@0.02

## Top 15 strong-agreement (all agree AND high prob margin)

- "还没做完吧？" consensus=verify jev_prob=0.62
- "中转站每日签到功能" consensus=build jev_prob=0.78
- "看项目目录，了解这个项目是" consensus=research jev_prob=0.79
- "你是技术调研员。请调研开源" consensus=research jev_prob=0.94
- "你是技术调研员。请调研两个" consensus=research jev_prob=0.94
- "帮我查清楚啊" consensus=research jev_prob=0.93
- "查明并修复 Personal Agent 经本机8787网关使用claude-opus-4-8时声明" consensus=fix jev_prob=0.97
- "好的，但是其他的老会话也是同样的问题，需要一块修复" consensus=fix jev_prob=0.96
- "怎么使用" consensus=research jev_prob=0.69
- "定位 personal-agent 默认 Electron 运行时启动失败的根因，实施有证据支持的最" consensus=fix jev_prob=0.96
- "老窗口报错了：resume failed for session"session-8b2c48d2…" consensus=fix jev_prob=0.88
- "我现在的dsh客户端 执行写入权限的时候报错为什么？写入 Error: invalid justi…" consensus=fix jev_prob=0.84
- "是我客户端什么文件有问题吗？" consensus=fix jev_prob=0.82
- "模型操作失败:gateway/internal: resume failed for sessio…" consensus=fix jev_prob=0.79
- "Implement scoped fix in D:\DSHXM\ZZCSAPI" consensus=fix jev_prob=0.85

## Top 15 single-model-dissent (2 agree, 1 differs)

- "你是技术调研员。请调研两个开源 AI 网关项目的**内部机制、性能、功能全面性**，产出高密度事实…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=research@0.97
- "把文件放到桌面新建一个文件夹。把交付物放进去。你本地的那份还要留着，就相当于做了一个备份。" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=verify@0.20
- "为Personal Agent桌面补齐本地技能查看/启用及实际模型加载、MCP本地stdio配置连接" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=build@0.95
- "你是只读取证代理,只读源码/文档报告,每条结论带 `file:line` 证据。**不要修改任何文…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=verify@0.76
- "Read-only research. User requires exact sourced c…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=research@0.79
- "核对并安全同步用户指定的TRAE frontend-design/cloudflare/github" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=verify@0.96
- "在 D:\AgentKHD 下创建独立于 DSH 的个人 Agent 新项目，第一阶段完成可运行的 " consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=build@0.98
- "看项目目录，了解这个项目是做什么的" consensus=fix dissent=jev | jev=research@0.85 grok=fix@0.20 claude=fix@0.20
- "以 D:\WorkBuddyXM\JM\wb-client.html 为完整视觉与交互基座，在 D:" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=build@0.92
- "我想做一个专属于自己的聊天agent，像DSH、Trae、Codex、claude code、Zco" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=build@0.89
- "你是只读取证代理。**绝对不要修改任何文件**,只读源码并报告,每条结论必须带 `file:lin…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=research@0.78
- "Research, read-only, the **local** reference repo…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=research@0.90
- "两个github项目都拉取到本地启动，我看看什么样" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=research@0.89
- "我想做一个专属于自己的聊天agent，像DSH、Trae、Codex、claude code、Zc…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=build@0.90
- "你在为一个自研的个人 Agent 产品做**外部取证**。只读、只报告，**不要修改任何文件**。…" consensus=fix dissent=jev | claude=fix@0.20 grok=fix@0.20 jev=research@0.91
