# 个人 Agent 操作员手册

本文档面向**唯一操作员**（你本人），记录把 personal-agent 部署到 Linux 服务器后的日常操作。

## 一、TL;DR

- **白名单文件** `<agent_home>/infra-hosts.json` 控制 agent 能 ssh 到哪里。
- **私钥目录** `<agent_home>/infra-keys/<alias>.pem` 存 ssh 私钥，agent **只读不写**。
- **审批通道** `<agent_home>/.approval/<hash>.decision` ——agent 写 `request`、操作员写 `yes`/`no`。
- **容器必须 `--network host`** ——agent 容器内 `127.0.0.1:5252` 走宿主 sshd。
- **`infra-hosts.json` 必须是合法 JSON**（键值都加引号）。

## 二、文件清单

```
<agent_home>/
├── infra-hosts.json          # ssh 目标白名单
├── infra-keys/
│   ├── <alias>.pem           # 每台 host 一把私钥，chmod 600
│   └── ...
├── .approval/                # 文件预批通道目录
│   ├── <hash>.request        # agent 写：待批准请求
│   ├── <hash>.decision       # 操作员写：yes / no
│   └── <hash>.resolved       # agent 写：已处理（防重放）
├── .ssh/known_hosts          # 容器里 ssh 信任的 host 列表
├── chat-<session>.jsonl      # 每个 session 一份对话记录
├── config.json               # agent 配置（默认 tier / 规则）
└── cycles.jsonl              # swarm cycle 记录
```

## 三、启动一个 agent 容器

```bash
# 1. 准备 agent home
mkdir -p /root/pa-linux-home
chown -R 1000:1000 /root/pa-linux-home

# 2. 写 infra-hosts.json（合法 JSON，键值都加引号）
cat > /root/pa-linux-home/infra-hosts.json <<'JSON'
{
  "hosts": {
    "self": {
      "user": "root",
      "host": "127.0.0.1",
      "port": 5252,
      "key": "zzcsapi_deploy"
    }
  }
}
JSON

# 3. 推私钥
mkdir -p /root/pa-linux-home/infra-keys
scp -i ~/.ssh/zzcsapi_deploy <client-key>.pem /root/pa-linux-home/infra-keys/zzcsapi_deploy
chmod 600 /root/pa-linux-home/infra-keys/zzcsapi_deploy

# 4. 跑容器（注意 --network host！）
docker run --rm --network host \
  -u 1000:1000 \
  -e HOME=/tmp \
  -e PERSONAL_AGENT_HOME=/agent-home \
  -e PERSONAL_AGENT_BASE_URL=<...> \
  -e PERSONAL_AGENT_MODEL=<...> \
  -e PERSONAL_AGENT_API_KEY=<...> \
  -v <agent-source>:/work \
  -v /root/pa-linux-home:/agent-home \
  -v /tmp/.ssh:/tmp/.ssh \
  -w /work \
  node:24 \
  bash -c "node --experimental-strip-types /work/src/cli.ts --tier infra-read --approve file:/agent-home/.approval --session <id> -- <prompt>"
```

### 必填环境变量

| 变量 | 用途 |
|---|---|
| `PERSONAL_AGENT_BASE_URL` | 模型 base URL（含 `/v1`） |
| `PERSONAL_AGENT_MODEL` | 模型名 |
| `PERSONAL_AGENT_API_KEY` | API key |
| `PERSONAL_AGENT_HOME` | agent home 容器内路径（`/agent-home`） |

### 必填参数

- `--tier`：`infra-read`（只读）或 `infra-write`（可写、可执行）
- `--approve file:/agent-home/.approval`：非 TTY 容器**必须**用 file 通道

## 四、文件预批通道

```bash
# 1. 看到请求
ls /root/pa-linux-home/.approval/
# 12b1d734ef068ae0.request

# 2. 读内容
cat /root/pa-linux-home/.approval/12b1d734ef068ae0.request
# Run on self?
# whoami
# 本次批准 2 分钟内有效。

# 3. 决定
echo "yes" > /root/pa-linux-home/.approval/12b1d734ef068ae0.decision
# 或
echo "no"  > /root/pa-linux-home/.approval/12b1d734ef068ae0.decision

# 4. agent 1 秒内拿到决策
# 5. agent 写 <hash>.resolved 标记已用
```

### 关键约束

- **2 分钟内未决** = 默认拒绝（超时）
- **同一 hash 已 resolved** = 后续相同 hash 的调用被忽略（防重放）
- **重命名 resolved 文件**可让同一审批请求重新有效（`mv resolved resolved.bak`）
- **clear 全部**：直接 `rm /agent_home/.approval/*.resolved`

## 五、infra-hosts.json 格式

```json
{
  "hosts": {
    "<alias>": {
      "user": "root",
      "host": "127.0.0.1",
      "port": 5252,
      "key": "<私钥文件名，在 infra-keys/ 目录下>",
      "maxCommandLength": 8192
    }
  }
}
```

字段：`user` 必填、`host` 必填（IP 或 DNS，**不是 alias**）、`port` 可选（默认 22）、`key` 必填（`infra-keys/` 下相对路径）、`maxCommandLength` 可选（命令字符上限）。

### 验证 JSON 合法

```bash
python3 -m json.tool < /root/pa-linux-home/infra-hosts.json
```

合法会格式化输出，非法会报错 `Expecting property name enclosed in double quotes`。

## 六、常见错误

### `Expected property name or '}' in JSON at position 1`

`infra-hosts.json` 不合法。重新用 base64 写或 heredoc 加引号转义。

### `ssh: Could not resolve hostname <alias>`

`infra-hosts.json` 缺 `host` 字段或 `host` 字段是 alias 而不是 IP/DNS。

### `ssh: connect to host 127.0.0.1 port 5252: Connection refused`

容器没用 `--network host`。容器内的 `127.0.0.1` 是容器自己的，不是宿主。

### `no approval channel is configured`

非 interactive 模式没传 `--approve file:<dir>`。

### `infra-hosts.json not found in agent home`

`PERSONAL_AGENT_HOME` 路径错，或 `-v` bind mount 没挂上。

## 七、tier 一览

| tier | 工具 | 适用 |
|---|---|---|
| `read-only` | read_file / inspect_file / job_output | 浏览工作区 |
| `ask-before-writing` | + run_command（approve） / 写文件 | 默认 |
| `workspace-write`（默认） | 写文件 | 不再问 |
| `full-access` | 全部 | 远程服务器慎用 |
| `infra-read` | read_remote | 读远端服务器文件 |
| `infra-write` | read_remote + run_remote | 远端服务器运维 |

`infra-read` / `infra-write` 是**唯一**能调 `read_remote` / `run_remote` 的 tier——默认 tier **看不到**这些工具。

## 八、安全边界（务必清楚）

- agent **不写** `infra-hosts.json` / `infra-keys/` ——这些是只读配置
- agent **不读**模型给的 ssh 私钥文件名（仅按白名单查 `infra-keys/`）
- agent **不传**命令到自身命令行（命令是 ssh 参数，审批一次就是执行的那一次）
- `--approve file:<dir>` 的 `.approval/` 在 agent home 内，**操作员主控**
- agent home `chown 1000:1000` 保证容器内可写
