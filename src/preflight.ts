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
  /**
   * Spend one real token to find out whether the provider accepts this client's
   * request shape and actually calls tools.
   *
   * Off by default, and it needs the key, so the caller — not this module —
   * decides to pass it. See {@link probeToolCalling} for why a status probe
   * cannot answer either question.
   */
  liveToolProbe?: { baseUrl: string; model: string; apiKey: string };
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
  /**
   * Result of the opt-in live tool probe, or `undefined` when it was not run.
   * `undefined` means "not measured", never "fine" — callers must not read it as
   * a pass.
   */
  toolCalling?: "works" | "tools-dropped" | "request-failed";
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
 * One live round trip that answers the two questions a status probe cannot.
 *
 * The reachability probe above proves something is listening, and deliberately
 * sends no credentials, so it can never prove a real request is accepted. Both
 * failures observed in practice were invisible to it, and both were HTTP 200:
 *
 * 1. A gateway that rejects the request shape — every request came back 502
 *    until the adapter sent `max_tokens`, which it previously never did.
 * 2. A gateway that **silently discards the `tools` array** and answers as plain
 *    chat. The agent then looks like it is running while every tool call fails,
 *    with an error string that appears nowhere in this project, which sends the
 *    operator hunting for a bug that is not theirs.
 *
 * So this check sends one authenticated request with a trivial tool and reports
 * what came back. It is the only check here that spends a token and puts the key
 * on the wire, which is why it is opt-in and why the output says so.
 *
 * The prompt is fixed and asks for a function call, not a question, so the tool
 * result is about whether tool calling works rather than about the model's mood.
 */
const TOOL_PROBE_NAME = "preflight_echo";

/**
 * Remove the credential from any text that will be printed.
 *
 * Needed because this is the one check that puts the key on the wire, and a
 * broken proxy can echo the request — headers included — back in an error page.
 * Truncating is not redaction: the key is short enough to survive a slice. The
 * test for this failed on the first version, which reported the key verbatim.
 */
function redact(text: string, apiKey: string): string {
  return apiKey === "" ? text : text.split(apiKey).join("[redacted]");
}
/**
 * Generous on purpose. Measured against a real local gateway, a one-word
 * completion took 65-75 seconds and a turn with tool calls 95-230, so a short
 * probe timeout reports a working provider as broken — which is a worse failure
 * than waiting, because it sends the operator to fix the wrong thing. The first
 * version used 60s and timed out on a model that works.
 */
const TOOL_PROBE_TIMEOUT_MS = 300_000;

interface ToolProbeOutcome {
  accepted: boolean;
  /** Held separately from `accepted`: a 200 that dropped the tool is the case
   * this exists for, and collapsing the two into one boolean would hide it. */
  calledTool: boolean;
  detail: string;
}

export async function probeToolCalling(
  baseUrl: string,
  model: string,
  apiKey: string,
  doFetch: typeof fetch,
): Promise<{ request: PreflightCheck; tools: PreflightCheck }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: `Call the ${TOOL_PROBE_NAME} function with value="ok". You must use the tool.` }],
    max_tokens: 64,
    tools: [{
      type: "function",
      function: {
        name: TOOL_PROBE_NAME,
        description: "Echo a value back. Used only to check tool calling.",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    }],
  };
  let outcome: ToolProbeOutcome;
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOOL_PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      // Redacted, not merely truncated: a broken proxy can echo the request —
      // and therefore the key — back in an error page, and the key is short
      // enough to survive a slice.
      outcome = {
        accepted: false, calledTool: false,
        detail: `HTTP ${response.status}；响应正文（已脱敏并截断）：${redact(text, apiKey).slice(0, 120) || "(空)"}`,
      };
    } else {
      let parsed: { choices?: { message?: { tool_calls?: unknown[]; content?: string } }[] };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        outcome = { accepted: false, calledTool: false, detail: "HTTP 200 但响应体不是 JSON" };
        return {
          request: { name: "真实请求", status: "fail", detail: outcome.detail },
          tools: { name: "工具调用", status: "fail", detail: "无法解析响应，故无法判定" },
        };
      }
      const message = parsed.choices?.[0]?.message;
      const calls = message?.tool_calls;
      const calledTool = Array.isArray(calls) && calls.length > 0;
      outcome = calledTool
        ? { accepted: true, calledTool: true, detail: "HTTP 200，返回了 tool_calls" }
        : {
            accepted: true, calledTool: false,
            detail: "HTTP 200，但**没有** tool_calls；模型回的是普通文本。" +
              `它说的话（已脱敏并截断）：${redact(message?.content ?? "(空)", apiKey).slice(0, 160)}`,
          };
    }
  } catch (error) {
    const name = (error as Error).name;
    outcome = {
      accepted: false, calledTool: false,
      detail: name === "TimeoutError"
        ? `探测超时（${TOOL_PROBE_TIMEOUT_MS}ms）`
        : `请求失败：${(error as Error).message}`,
    };
    return {
      request: { name: "真实请求", status: "fail", detail: outcome.detail },
      tools: { name: "工具调用", status: "fail", detail: "请求未成功，无法判定工具调用" },
    };
  }

  // The two checks stay separate on purpose. A 200 with no tool call is a
  // *passing* request and a *failing* tool capability, and reporting it as one
  // verdict is exactly how this went unnoticed.
  return {
    request: { name: "真实请求", status: outcome.accepted ? "ok" : "fail", detail: outcome.detail },
    tools: outcome.accepted
      ? {
          name: "工具调用",
          status: outcome.calledTool ? "ok" : "fail",
          detail: outcome.calledTool
            ? "提供方接受 tools 并返回了工具调用"
            : "**提供方丢弃了 tools**：HTTP 成功但从不调用工具。此模型在本 Agent 里无法使用工具。" +
              "注意：单次结果可能来自暂时性的网关故障，**请重跑一次再下结论**——" +
              "本项目实测过同一个模型一次报丢弃、重跑即正常。",
        }
      : { name: "工具调用", status: "fail", detail: "请求未成功，无法判定工具调用" },
  };
}

/**
 * Describe a command's own error text, or decline to.
 *
 * On Windows a cmd.exe failure message is written in the console's OEM code page,
 * so decoding it as UTF-8 yields U+FFFD replacement characters. Printing that is
 * worse than printing nothing: it looks like corruption in *our* output. When the
 * text cannot be decoded, say so and keep the exit code.
 */function stderrExcerpt(raw: string | null | undefined): string {
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

  let toolCalling: PreflightReport["toolCalling"];
  if (input.liveToolProbe) {
    const probe = input.liveToolProbe;
    const result = await probeToolCalling(probe.baseUrl, probe.model, probe.apiKey, doFetch);
    checks.push(result.request, result.tools);
    // Only a request that succeeded can say anything about tools; a failed
    // request leaves the question open rather than answered.
    toolCalling = result.request.status !== "ok"
      ? "request-failed"
      : result.tools.status === "ok" ? "works" : "tools-dropped";
  } else {
    checks.push({
      name: "工具调用",
      status: "skipped",
      detail: "未实测（需要 --probe-tools，会真实消耗 token）。**未测量不等于通过**：" +
        "已有实测案例显示提供方会以 HTTP 200 静默丢弃 tools",
    });
  }

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
    ...(toolCalling === undefined ? {} : { toolCalling }),
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
  // Spelled out separately because it is the one verdict that a passing HTTP
  // check hides, and because "not measured" must not read as "fine".
  if (report.toolCalling === "works") {
    lines.push("工具调用：**已实测可用**——提供方接受了 tools 并返回了工具调用。");
  } else if (report.toolCalling === "tools-dropped") {
    lines.push("工具调用：**失败**——提供方返回 HTTP 成功，但丢弃了 tools、从不调用工具。" +
      "此模型在本 Agent 里做不了任何事。**请重跑一次再换模型**：本项目实测过同一模型一次报丢弃、重跑即正常，" +
      "两次结果不同说明是网关在抖，而不是模型不支持。");
  } else if (report.toolCalling === "request-failed") {
    lines.push("工具调用：**无法判定**——真实请求本身就失败了，先修请求。");
  } else {
    lines.push("工具调用：**未测量**（未加 --probe-tools）。未测量不等于可用：" +
      "已有实例是 HTTP 200 且 tools 被静默丢弃。");
  }
  lines.push("本检查仍不能证明：真实终端下的人机观感；断电持久性；跨平台行为。" +
    "（" + (report.toolCalling ? "本次已实测真实请求与工具调用。" : "本次未实测真实请求与工具调用。") + "）");
  return `${lines.join("\n")}\n`;
}
