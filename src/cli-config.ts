import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeStateDirectory, canonicalPath, configuredProtectedRoots } from "./security-config.ts";
import type { TerminalIO } from "./terminal.ts";

export interface ProviderConfig { baseUrl: string; model: string; apiKey: string; }
const CONFIG_NAME = "provider-config.json";
const CONFIG_MAX_BYTES = 16_384;
export function providerConfig(value: unknown): ProviderConfig {
  if (!value || typeof value !== "object") throw new Error("模型配置必须是对象。");
  const v = value as Record<string, unknown>;
  for (const key of ["baseUrl", "model", "apiKey"]) {
    if (typeof v[key] !== "string" || !(v[key] as string).trim() || /[\x00-\x1f\x7f]/.test(v[key] as string)) {
      throw new Error(`模型配置缺失或无效: ${key}`);
    }
  }
  let url: URL;
  try { url = new URL(v.baseUrl as string); }
  catch { throw new Error("服务地址不是有效 URL。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("服务地址须为无账号、查询参数或片段的 HTTP(S) URL。");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("远端模型须使用 HTTPS；HTTP 仅允许本机回环地址。");
  }
  return { baseUrl: url.href.replace(/\/+$/, ""), model: (v.model as string).trim(), apiKey: (v.apiKey as string).trim() };
}
function location(home: string, env: NodeJS.ProcessEnv): string {
  const root = assertSafeStateDirectory(home, { protectedRoots: configuredProtectedRoots(env) });
  return path.join(root, CONFIG_NAME);
}
export async function loadProvider(home: string, env: NodeJS.ProcessEnv): Promise<ProviderConfig | undefined> {
  const values = [env.PERSONAL_AGENT_BASE_URL, env.PERSONAL_AGENT_MODEL, env.PERSONAL_AGENT_API_KEY];
  // Don't combine a saved key with a different environment endpoint.
  if (values.some(v => v !== undefined && v !== "")) {
    return providerConfig({ baseUrl: values[0], model: values[1], apiKey: values[2] });
  }
  const file = location(home, env);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || canonicalPath(file) !== file || info.size > CONFIG_MAX_BYTES) {
      throw new Error("配置文件不是安全的普通小文件。");
    }
    let saved: unknown;
    try { saved = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new Error("无法解析模型配置文件；原始内容已隐藏，请在本地检查配置。"); }
    if (!saved || typeof saved !== "object") throw new Error("模型配置损坏。");
    const record = saved as Record<string, unknown>;
    if (record.v !== 1) throw new Error("不支持的模型配置版本。");
    // Nonsecret profile saved; request a key each time rather than persisting it silently.
    if (record.apiKey === undefined) return providerConfig({ ...record, apiKey: "__ASK_AT_START__" });
    return providerConfig(record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function saveProvider(home: string, env: NodeJS.ProcessEnv, config: ProviderConfig, saveKey: boolean): Promise<void> {
  const valid = providerConfig(config);
  const file = location(home, env);
  const payload = JSON.stringify({ v: 1, baseUrl: valid.baseUrl, model: valid.model,
    ...(saveKey ? { apiKey: valid.apiKey } : {}) }, null, 2) + "\n";
  if (Buffer.byteLength(payload, "utf8") > CONFIG_MAX_BYTES) {
    throw new Error(`模型配置超过 ${CONFIG_MAX_BYTES} 字节，未保存；请缩短配置。`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Exclusive create: never follow or replace an existing config link/file.
  await writeFile(location(home, env), payload, { flag: "wx", mode: 0o600 });
}
export async function configureProvider(io: TerminalIO, home: string, env: NodeJS.ProcessEnv): Promise<ProviderConfig | "echo" | null> {
  let saved = await loadProvider(home, env);
  if (saved && saved.apiKey !== "__ASK_AT_START__") return saved;
  if (!io.interactive) throw new Error("没有完整模型配置。请运行 npm start 完成向导，或使用 --echo 离线体验。");
  if (saved) {
    const key = await io.ask("API 密钥（隐藏，仅本次使用）：", true);
    return key === null ? null : providerConfig({ ...saved, apiKey: key });
  }
  io.write("首次使用：Enter 配置模型，输入 echo 可离线体验（不是大模型）。\n");
  const mode = await io.ask("模式 [model/echo]：");
  if (mode === null) return null;
  if (mode.trim().toLowerCase() === "echo") return "echo";
  const baseUrl = await io.ask("服务地址（例如 https://api.openai.com/v1）：");
  if (baseUrl === null) return null;
  const model = await io.ask("模型名称：");
  if (model === null) return null;
  const apiKey = await io.ask("API 密钥（隐藏）：", true);
  if (apiKey === null) return null;
  saved = providerConfig({ baseUrl, model, apiKey });
  io.write("可保存地址和模型。密钥默认不保存；选择保存密钥将以明文写入独立 Agent home，不是系统凭据库。\n");
  const choice = await io.ask("保存 [Enter=仅地址/模型；key=连同明文密钥；no=均不保存]：");
  if (choice === null) return null;
  const selection = choice.trim().toLowerCase();
  if (!["", "key", "no"].includes(selection)) throw new Error("保存选项无效，未保存配置；请重新启动。");
  if (selection !== "no") {
    await saveProvider(home, env, saved, selection === "key");
    io.write(selection === "key" ? "已按你的选择保存明文密钥；勿提交或分享 Agent home。\n" : "已保存地址和模型；下次启动会隐藏询问密钥。\n");
  }
  return saved;
}
