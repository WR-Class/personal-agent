/**
 * Preflight for a *real* integration run (live provider + real terminal).
 *
 * This module exists because a passing test suite says nothing about whether a
 * live run is even possible. Every check here reports an **observed fact**: what
 * was configured, what a real socket answered, whether the tokenizer command
 * actually runs, and whether stdin/stdout are terminals. Nothing here sends the
 * API key, nothing here spends a token, and nothing here converts "I could not
 * check" into "ready".
 *
 * Two deliberate omissions:
 *
 * - The key is never printed, not even a prefix or its length; only whether one
 *   is present and where it came from.
 * - The reachability probe sends **no** authorization header, so it cannot make
 *   an authenticated call by accident. A 401/403 is therefore a *success* for
 *   this probe: it proves DNS, TLS and routing work and something is listening.
 */

import path from "node:path";
import { spawnSync } from "node:child_process";

export interface PreflightEnv {
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  columns?: number;
  rows?: number;
  fetchImpl?: typeof fetch;
  platform?: string;
  nodeVersion?: string;
}

export interface PreflightCheck {
  /** Short label, used as-is in the report. */
  name: string;
  status: "ok" | "warn" | "fail" | "skipped";
  detail: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** True only when a live run can actually be attempted right now. */
  canAttemptLiveRun: boolean;
  /** A configured-but-broken tokenizer blocks a live run; see `canAttemptLiveRun`. */
  tokenizerFailed: boolean;
  /** Independent of the provider: whether interactive mode is possible. */
  canRunInteractively: boolean;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe the endpoint without credentials.
 *
 * `GET {baseUrl}/models` is the conventional, cheap, non-generating endpoint for
 * OpenAI-compatible servers. A local server that does not implement it answers
 * 404, which still proves reachability, so any HTTP status counts as reachable.
 */
async function probeEndpoint(baseUrl: string, doFetch: typeof fetch): Promise<PreflightCheck> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // Status only. The body is never read: it is untrusted and could be an error
    // page echoing credentials back from a broken proxy.
    await response.body?.cancel();
    return {
      name: "服务可达性",
      status: "ok",
      detail: `GET .../models 得到 HTTP ${response.status}（未发送密钥；401/403 同样证明可达）`,
    };
  } catch (error) {
    if ((error as Error).name === "TimeoutError") {
      return { name: "服务可达性", status: "fail", detail: `探测超时（${PROBE_TIMEOUT_MS}ms 内无响应）` };
    }
    return {
      name: "服务可达性",
      status: "fail",
      detail: `请求失败：${(error as Error).message}（只报错误类别，不读取响应正文）`,
    };
  }
}

/**
 * Describe a command's own error text, or decline to.
 *
 * On Windows a cmd.exe failure message is written in the console's OEM code page,
 * so decoding it as UTF-8 yields U+FFFD replacement characters. Printing that is
 * worse than printing nothing: it looks like corruption in *our* output. When the
 * text cannot be decoded, say so and keep the exit code.
 */
function stderrExcerpt(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (text === "") return "";
  if (text.includes("\uFFFD")) return "（命令的 stderr 不是 UTF-8，无法可靠解码，已省略）";
  return text.slice(0, 200);
}

/**
 * Run the optional tokenizer command once with a tiny prompt.
 *
 * The point is to catch the common failure *before* a live run: a command that is
 * present in the environment but does not execute would otherwise turn every send
 * into an error. Its printed integer is validated exactly as a real send does.
 */
function probeTokenizer(env: NodeJS.ProcessEnv): PreflightCheck {
  const command = env.PERSONAL_AGENT_TOKENIZER?.trim();
  if (!command) {
    return { name: "本机 tokenizer", status: "skipped", detail: "未设置；token 上限将只依赖 provider 实测值（首轮无测量）" };
  }
  const result = spawnSync(command, {
    shell: true,
    input: JSON.stringify([{ role: "user", content: "preflight" }]),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) return { name: "本机 tokenizer", status: "fail", detail: `命令无法执行：${result.error.message}` };
  if (result.status !== 0) {
    const excerpt = stderrExcerpt(result.stderr);
    return { name: "本机 tokenizer", status: "fail", detail: `命令退出码 ${result.status}${excerpt === "" ? "" : `：${excerpt}`}` };
  }
  const text = (result.stdout ?? "").trim();
  if (!/^\d+$/.test(text)) {
    return { name: "本机 tokenizer", status: "fail", detail: `stdout 不是一个非负整数：${JSON.stringify(text.slice(0, 60))}` };
  }
  return { name: "本机 tokenizer", status: "ok", detail: `命令可执行，对样例 prompt 返回 ${text}` };
}

export async function preflight(input: PreflightEnv): Promise<PreflightReport> {
  const env = input.env;
  const platform = input.platform ?? process.platform;
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const doFetch = input.fetchImpl ?? fetch;
  const checks: PreflightCheck[] = [];

  checks.push({
    name: "运行环境",
    // Reported, never asserted as supported: only Node 24 has been exercised.
    status: "ok",
    detail: `Node ${nodeVersion} / ${platform}（本项目只在 Node 24 上实跑过，其他版本未验证）`,
  });

  checks.push({
    name: "目录",
    status: "ok",
    detail: `home=${env.PERSONAL_AGENT_HOME ?? "(默认 .personal-agent)"} workspace=${env.PERSONAL_AGENT_WORKSPACE ?? "(当前目录)"}`,
  });

  const baseUrl = env.PERSONAL_AGENT_BASE_URL?.trim();
  const model = env.PERSONAL_AGENT_MODEL?.trim();
  const hasKey = (env.PERSONAL_AGENT_API_KEY ?? "").trim() !== "";
  const anyEnvProvider = !!baseUrl || !!model || hasKey;

  let providerUsable = false;
  if (anyEnvProvider) {
    // Three-together rule, same as loadProvider: a partial environment is refused
    // rather than completed from a saved file.
    const complete = !!baseUrl && !!model && hasKey;
    checks.push({
      name: "Provider 配置",
      status: complete ? "ok" : "fail",
      detail: complete
        ? `来自环境变量：model=${model}（密钥存在；只报告"存在"，不显示内容、长度或任何片段）`
        : "环境变量只配置了一部分；必须三项齐全，且不会与已保存配置混合",
    });
    if (complete) {
      checks.push({
        name: "端点协议",
        status: baseUrl.startsWith("http://") ? "warn" : "ok",
        detail: baseUrl.startsWith("http://") ? "使用明文 HTTP；仅本机回环地址会被接受" : "使用 HTTPS",
      });
    }
    providerUsable = complete;
  } else {
    checks.push({
      name: "Provider 配置",
      status: "skipped",
      detail: "环境变量未提供；已保存的 provider-config.json 由 CLI 读取，本检查不读取凭据文件，因此不代为确认",
    });
  }

  checks.push(baseUrl
    ? await probeEndpoint(baseUrl, doFetch)
    : { name: "服务可达性", status: "skipped", detail: "没有可探测的端点（未通过环境变量给出 baseUrl）" });

  const tokenizer = probeTokenizer(env);
  checks.push(tokenizer);

  const interactive = input.stdinIsTTY && input.stdoutIsTTY;
  checks.push({
    name: "终端",
    status: interactive ? "ok" : "warn",
    detail: interactive
      ? `stdin/stdout 均为 TTY（${input.columns ?? "?"}x${input.rows ?? "?"}）：密钥隐藏输入与 Ctrl+C 语义可实测`
      : "stdin 或 stdout 不是 TTY：交互模式与密钥隐藏输入无法在此验证，需要真实终端",
  });

  checks.push({
    name: "会话语义",
    status: "ok",
    detail: `日志目录 ${path.join(env.PERSONAL_AGENT_HOME ?? ".personal-agent")}；每次发送逐事件 flush` +
      "（不保证目录项持久化，本批未做掉电实验）",
  });

  // A configured tokenizer that cannot run is not a warning: it makes every send
  // fail, so a live run must not be reported as attemptable. A tokenizer that was
  // never configured is genuinely optional and does not block anything.
  return {
    checks,
    canAttemptLiveRun: providerUsable && tokenizer.status !== "fail",
    tokenizerFailed: tokenizer.status === "fail",
    canRunInteractively: interactive,
  };
}

/** Human-readable report. Kept beside the checks so the wording cannot drift. */
export function formatPreflight(report: PreflightReport): string {
  const mark = { ok: "OK  ", warn: "警告", fail: "失败", skipped: "跳过" } as const;
  const lines = ["联调准备检查（不发送密钥、不消耗 token、不读取凭据文件正文）："];
  for (const check of report.checks) lines.push(`  [${mark[check.status]}] ${check.name}：${check.detail}`);
  lines.push("");
  lines.push(report.canAttemptLiveRun
    ? "结论：环境变量形式的 Provider 配置齐全，可以尝试一次真实发送（会真实联网，可能真实计费）。"
    : report.tokenizerFailed
      ? "结论：**不能**尝试真实发送——已配置的本机 tokenizer 命令无法运行，它会让每次发送都失败。"
      : "结论：**不能**由此确认真实发送可行——缺少完整的环境变量 Provider 配置。");
  lines.push(report.canRunInteractively
    ? "交互模式：当前 stdin/stdout 是 TTY，可以实测密钥隐藏输入与 Ctrl+C。"
    : "交互模式：**当前不是 TTY**，交互与密钥隐藏输入在本环境无法验证。");
  lines.push("本检查仍不能证明：某个托管服务是否接受本客户端的请求形状；真实终端下的人机观感；断电持久性。");
  return `${lines.join("\n")}\n`;
}
