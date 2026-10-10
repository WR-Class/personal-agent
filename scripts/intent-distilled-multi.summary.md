# Multi-model intent distillation summary

Models: `jev` (jev/jev-latest), `claude` (openai/claude-opus-5), `grok` (openai/grok-4.7)
Prompts: 211 (from `D:\DSHXM\AgentKHD\personal-agent\scripts\intent-prompts-supplemental.json`)

## Agreement

| Bucket | Count | % |
|---|---|---|
| All models agree on argmax | 29 | 13.7% |
| Exactly one model disagrees | 180 | 85.3% |

## Consensus argmax distribution

| Intent | Count | % |
|---|---|---|
| fix | 190 | 90.0% |
| verify | 5 | 2.4% |
| research | 11 | 5.2% |
| operate | 1 | 0.5% |
| build | 4 | 1.9% |

## Per-model argmax distribution

| Model | fix | verify | research | operate | build |
|---|---|---|---|---|---|
| jev | 26 | 31 | 102 | 15 | 37 |
| claude | 186 | 5 | 11 | 4 | 5 |
| grok | 202 | 1 | 5 | 0 | 3 |

## Largest disagreement (top 20 by spread)

| prompt | consensus | disagree | per-model argmax |
|---|---|---|---|
| "你是技术调研员。请调研开源" | research |  | `jev:research` `claude:research` `grok:research` |
| "你是技术调研员。请调研两个" | research |  | `jev:research` `claude:research` `grok:research` |
| "看项目目录，了解这个项目是" | research |  | `jev:research` `claude:research` `grok:research` |
| "帮我查清楚啊" | research |  | `jev:research` `claude:research` `grok:research` |
| "中转站每日签到功能" | build |  | `jev:build` `claude:build` `grok:build` |
| "还没做完吧？" | verify |  | `jev:verify` `claude:verify` `grok:verify` |
| "怎么使用" | research |  | `jev:research` `claude:research` `grok:research` |
| "已经重启了，试试" | fix | claude | `jev:fix` `claude:verify` `grok:fix` |
| "渗透安全测试" | verify | grok | `jev:verify` `claude:verify` `grok:fix` |
| "个人Agent (1)" | build | jev | `jev:research` `claude:build` `grok:build` |
| "你是技术调研员。任务：把用" | research | grok | `jev:research` `claude:research` `grok:fix` |
| "恢复Dsh项目历史记录" | fix | claude | `jev:fix` `claude:operate` `grok:fix` |
| "看下项目目录里面的东西，知" | research | grok | `jev:research` `claude:research` `grok:fix` |
| "运行项目目录下的项目文件" | verify | grok, claude | `jev:verify` `claude:operate` `grok:fix` |
| "为什么之前的聊天全部没有了" | fix | claude | `jev:fix` `claude:research` `grok:fix` |
| "能给个中文面板吗" | build | grok | `jev:build` `claude:build` `grok:fix` |
| "但是现在就是个界面不能用是吧？" | fix |  | `jev:fix` `claude:fix` `grok:fix` |
| "中转聚合站" | research | grok | `jev:research` `claude:research` `grok:fix` |
| "静默启动，我刚刚把窗口关了" | operate | grok | `jev:operate` `claude:operate` `grok:fix` |
| "**窄任务，只读不改，中文报" | research | grok | `jev:research` `claude:research` `grok:fix` |
