#!/usr/bin/env node
import { resolve } from "node:path";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SessionStore } from "./session-store.ts";
import { AgentRuntime, DEFAULT_DEADLINE_MS, DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_STEPS, DEFAULT_MAX_TOOL_CALLS_PER_RUN, DEFAULT_MAX_TOOL_CALLS_PER_STEP, formatBudget } from "./runtime.ts";
import { createEchoAdapter } from "./echo-adapter.ts";
import { createOpenAIChatAdapter } from "./openai-adapter.ts";
import { ToolRegistry, createBatchFilesTool, createCreateFileTool, createDeleteFileTool, createEditFileTool, createPatchFileTool, createReadFileTool, createRenameFileTool } from "./tools.ts";
import { mintGene } from "./gene.ts";
import type { Gene } from "./gene.ts";
import { GeneStore } from "./gene-store.ts";
import { agentHomeProblem } from "./tool-environment.ts";
import { configuredContextWindows, configuredProtectedRoots, resolveRuntimePaths } from "./security-config.ts";
import { configureProvider, loadProvider } from "./cli-config.ts";
import { createTerminal, safeText } from "./terminal.ts";
import type { TerminalIO } from "./terminal.ts";
import { runInteractive } from "./interactive.ts";
import { formatPreflight, preflight } from "./preflight.ts";
import type { ChatMessage, ModelAdapter } from "./types.ts";

export const HELP = `Personal Agent — 交互式只读 Agent
用法：npm start                         持续对话/首次配置向导
      npm start -- --echo               离线回显体验，不是大模型
      npm start -- --session demo "你好" 单次发送
      npm start -- --session demo --list 查看历史，不需要模型配置
      npm start -- --preflight        联调准备检查：配置/可达性/tokenizer/TTY，不发密钥不消耗 token
      npm start -- --mint-gene draft.json 从验证过的成功经验铸造一个基因并入库（不需要模型）
      npm start -- --stream "问题"     用 SSE 流式传输（服务端只支持流式时使用；不改变回答内容）
选项：--home <dir> --workspace <dir> --max-steps <n> --max-tools <n>
      --max-tools-per-step <n> --max-send-ms <n> --max-context-bytes <n> --max-context-tokens <n> --totals
      --session/-s <id> --echo --preflight --stream --help/-h -- <以横线开头的提示>
环境：PERSONAL_AGENT_BASE_URL / PERSONAL_AGENT_MODEL / PERSONAL_AGENT_API_KEY
      三项须一起配置；不与已保存配置混合，不再静默回退 Echo。
      预算：PERSONAL_AGENT_MAX_STEPS / _MAX_TOOL_CALLS / _MAX_TOOLS_PER_STEP / _MAX_SEND_MS / _MAX_CONTEXT_BYTES / _MAX_CONTEXT_TOKENS
      按模型窗口：PERSONAL_AGENT_CONTEXT_WINDOWS='{"<model>":<tokens>,"*":<tokens>}'
      精确预判（可选，不内置分词器）：PERSONAL_AGENT_TOKENIZER='<命令>'，读 stdin 的 prompt JSON，向 stdout 打印单个非负整数
      该命令失败/超时/输出非数字一律报错，不静默退回估算
      流式：PERSONAL_AGENT_STREAM=1（等同 --stream）
交互命令：/help /new /sessions /resume <id> /history /inspect [id] /recover [id] /status /exit
密钥默认不落盘；工具仅 read_file。\n`;
export interface CliOptions {
  session: string; sessionExplicit: boolean; home: string; workspace: string;
  prompt?: string; list: boolean; showTotals: boolean; maxSteps: number; echo: boolean; help: boolean; preflight: boolean;
  maxToolCallsPerRun: number; maxToolCallsPerStep: number; deadlineMs: number; maxContextBytes: number; maxContextTokens: number;
  stream: boolean;
  /** Path to a gene draft JSON to mint. Operator action; no model involved. */
  mintGene?: string;
}
export class UsageError extends Error {}
function valueFor(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new UsageError(`${flag} needs a value`);
  return value;
}
function positiveFlag(flag: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${flag} must be a positive integer`);
  return value;
}
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = { session:"default",sessionExplicit:false,home:env.PERSONAL_AGENT_HOME ?? resolve(".personal-agent"),
    workspace:env.PERSONAL_AGENT_WORKSPACE ?? process.cwd(),list:false,showTotals:false,
    maxSteps:Number(env.PERSONAL_AGENT_MAX_STEPS ?? DEFAULT_MAX_STEPS),
    maxToolCallsPerRun:Number(env.PERSONAL_AGENT_MAX_TOOL_CALLS ?? DEFAULT_MAX_TOOL_CALLS_PER_RUN),
    maxToolCallsPerStep:Number(env.PERSONAL_AGENT_MAX_TOOLS_PER_STEP ?? DEFAULT_MAX_TOOL_CALLS_PER_STEP),
    deadlineMs:Number(env.PERSONAL_AGENT_MAX_SEND_MS ?? DEFAULT_DEADLINE_MS),
    maxContextBytes:Number(env.PERSONAL_AGENT_MAX_CONTEXT_BYTES ?? DEFAULT_MAX_CONTEXT_BYTES),
    maxContextTokens:Number(env.PERSONAL_AGENT_MAX_CONTEXT_TOKENS ?? DEFAULT_MAX_CONTEXT_TOKENS),
    echo:false,help:false,preflight:false,
    // Opt-in: streaming changes the request body (stream_options), so a server that
    // rejects unknown fields must still be reachable on the default path.
    stream:env.PERSONAL_AGENT_STREAM==="1"||env.PERSONAL_AGENT_STREAM==="true" };
  const rest: string[] = [];
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i]!;
    if(arg==="--"){rest.push(...argv.slice(i+1));break;}
    if(arg==="--session"||arg==="-s"){options.session=valueFor(argv,++i,arg);options.sessionExplicit=true;}
    else if(arg==="--home")options.home=valueFor(argv,++i,arg);
    else if(arg==="--workspace")options.workspace=valueFor(argv,++i,arg);
    else if(arg==="--max-steps")options.maxSteps=Number(valueFor(argv,++i,arg));
    else if(arg==="--max-tools")options.maxToolCallsPerRun=Number(valueFor(argv,++i,arg));
    else if(arg==="--max-tools-per-step")options.maxToolCallsPerStep=Number(valueFor(argv,++i,arg));
    else if(arg==="--max-send-ms")options.deadlineMs=Number(valueFor(argv,++i,arg));
    else if(arg==="--max-context-bytes")options.maxContextBytes=Number(valueFor(argv,++i,arg));
    else if(arg==="--max-context-tokens")options.maxContextTokens=Number(valueFor(argv,++i,arg));
    else if(arg==="--list")options.list=true;
    else if(arg==="--totals")options.showTotals=true;
    else if(arg==="--echo")options.echo=true;
    else if(arg==="--preflight")options.preflight=true;
    else if(arg==="--stream")options.stream=true;
    else if(arg==="--mint-gene")options.mintGene=valueFor(argv,++i,arg);
    else if(arg==="--help"||arg==="-h")options.help=true;
    else if(arg.startsWith("-"))throw new UsageError(`unknown flag: ${arg}`);
    else rest.push(arg);
  }
  if(options.help)return options;
  if(!/^[A-Za-z0-9._-]+$/.test(options.session))throw new UsageError("invalid session id");
  positiveFlag("--max-steps", options.maxSteps);
  positiveFlag("--max-tools", options.maxToolCallsPerRun);
  positiveFlag("--max-tools-per-step", options.maxToolCallsPerStep);
  positiveFlag("--max-send-ms", options.deadlineMs);
  positiveFlag("--max-context-bytes", options.maxContextBytes);
  positiveFlag("--max-context-tokens", options.maxContextTokens);
  if(options.list&&(rest.length||options.showTotals))throw new UsageError("--list 不能与 prompt 或 --totals 混用");
  if(options.preflight&&(rest.length||options.list||options.echo))throw new UsageError("--preflight 不能与 prompt、--list 或 --echo 混用");
  if(options.mintGene&&(rest.length||options.list||options.showTotals||options.preflight||options.echo))throw new UsageError("--mint-gene 不能与 prompt、--list、--totals、--preflight 或 --echo 混用");
  let extraRoots:string[];
  try{extraRoots=configuredProtectedRoots(env);}catch(error){throw new UsageError((error as Error).message);}
  const problem=agentHomeProblem(options.home,{env,protectedRoots:extraRoots});
  if(problem!==null)throw new UsageError(problem);
  if(rest.length)options.prompt=rest.join(" ");
  return options;
}
function renderMessage(message: ChatMessage): string {
  const lines=[`${message.role}: ${message.content}`];
  for(const call of message.toolCalls??[])lines.push(`  → ${call.name}(${call.arguments})`);
  return lines.join("\n");
}
/**
 * Optional external tokenizer command, invoked once per prompt with the prompt
 * JSON on stdin and a token count expected on stdout.
 *
 * This exists so a host that already has the right tokenizer can get an exact
 * pre-flight count without this project bundling one. It is off unless
 * `PERSONAL_AGENT_TOKENIZER` names a command, and a command that fails, times
 * out, or prints a non-count is a hard error: falling back to a guess would turn
 * "I could not measure" into "I measured", which is the one outcome worse than
 * having no tokenizer at all.
 */
function tokenizerCounter(env: NodeJS.ProcessEnv): ((messages: readonly ChatMessage[]) => number) | undefined {
  const command = env.PERSONAL_AGENT_TOKENIZER?.trim();
  if (!command) return undefined;
  const timeoutMs = Number(env.PERSONAL_AGENT_TOKENIZER_TIMEOUT_MS ?? 5_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError("PERSONAL_AGENT_TOKENIZER_TIMEOUT_MS must be a positive integer");
  }
  return (messages) => {
    const result = spawnSync(command, { shell: true, input: JSON.stringify(messages), encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (result.error) throw new Error(`tokenizer command failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`tokenizer command exited ${result.status}: ${(result.stderr ?? "").trim().slice(0, 200)}`);
    const text = (result.stdout ?? "").trim();
    if (!/^\d+$/.test(text)) throw new Error(`tokenizer command must print a single non-negative integer, got ${JSON.stringify(text.slice(0, 60))}`);
    return Number(text);
  };
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, providedIO?: TerminalIO): Promise<number> {
  const options=parseArgs(argv,env);
  const write=(text:string)=>providedIO ? providedIO.write(text) : process.stdout.write(safeText(text));
  if(options.help){write(HELP);return 0;}
  if(options.preflight){
    // Deliberately before any credential file is read and before any adapter is
    // built: this mode reports what it can observe, and must not be a path that
    // could use a key it was only supposed to describe.
    const report=await preflight({env,stdinIsTTY:!!process.stdin.isTTY,stdoutIsTTY:!!process.stdout.isTTY,
      ...(process.stdout.columns===undefined?{}:{columns:process.stdout.columns}),
      ...(process.stdout.rows===undefined?{}:{rows:process.stdout.rows})});
    write(formatPreflight(report));
    // Non-zero when a live run cannot be attempted, so this is usable as a gate.
    return report.canAttemptLiveRun?0:3;
  }
  const extraRoots=configuredProtectedRoots(env);
  let contextWindows;
  try{contextWindows=configuredContextWindows(env);}
  catch(error){throw new UsageError((error as Error).message);}
  let countPromptTokens;
  try{countPromptTokens=tokenizerCounter(env);}
  catch(error){throw new UsageError((error as Error).message);}
  let paths;
  try{paths=resolveRuntimePaths({workspaceRoot:options.workspace,agentHome:options.home,protectedRoots:extraRoots});}
  catch(error){throw new UsageError((error as Error).message);}
  const store=new SessionStore({root:paths.agentHome});
  const geneStore=new GeneStore(join(paths.agentHome,"genes.jsonl"));
  if(options.mintGene){
    let raw:string;
    try{raw=await readFile(options.mintGene,"utf8");}
    catch(error){throw new UsageError(`无法读取基因文件：${(error as Error).message}`);}
    let draft:unknown;
    try{draft=JSON.parse(raw);}
    catch{throw new UsageError("基因文件不是合法 JSON");}
    let minted;
    try{minted=mintGene(draft as Gene);}
    catch(error){throw new UsageError(`基因不合格：${(error as Error).message}`);}
    await geneStore.appendGene(minted);
    write(`已铸造 ${minted.gene.name} → ${minted.address}\n`);
    return 0;
  }
  if(options.list){const history=await store.history(options.session);for(const m of history)write(renderMessage(m)+"\n");if(!history.length)write("(no messages)\n");return 0;}
  const interactive=options.prompt===undefined;
  let io=providedIO;
  if(interactive&&!io)io=createTerminal();
  try {
    let adapter:ModelAdapter;
    if(options.echo)adapter=createEchoAdapter();
    else {
      const config=interactive ? await configureProvider(io!,paths.agentHome,env) : await loadProvider(paths.agentHome,env);
      if(config===null)return 0;
      if(config==="echo")adapter=createEchoAdapter();
      else if(!config||config.apiKey==="__ASK_AT_START__")throw new UsageError("没有完整模型配置。运行 npm start 配置，或显式 --echo。");
      else adapter=createOpenAIChatAdapter({...config,...(options.stream?{stream:true}:{})});
    }
    const createRuntime=(sessionId:string)=>new AgentRuntime({adapter,store,sessionId,
      workspaceRoot:paths.workspaceRoot,home:paths.agentHome,protectedRoots:extraRoots,geneStore,
      tools:new ToolRegistry([createReadFileTool(), createEditFileTool(), createPatchFileTool(), createCreateFileTool(), createDeleteFileTool(), createRenameFileTool(), createBatchFilesTool()]),maxSteps:options.maxSteps,
      maxToolCallsPerStep:options.maxToolCallsPerStep,maxToolCallsPerRun:options.maxToolCallsPerRun,deadlineMs:options.deadlineMs,maxContextBytes:options.maxContextBytes,maxContextTokens:options.maxContextTokens,
      ...(contextWindows===undefined?{}:{contextWindows}),
      ...(countPromptTokens===undefined?{}:{countPromptTokens}),
      systemPrompt:"You are a concise, helpful assistant. Use read_file for workspace facts. File changes use edit_file, create_file, delete_file, rename_file, or batch_files. Every action needs its own approval. Respect denied paths; never pretend a tool succeeded.",
      ...(interactive && io ? { approve: async (prompt: string) => {
        io.write(`${prompt}\n回答“是”才执行这一次。\n`);
        const answer = await io.ask("批准？> ");
        return answer?.trim() === "是";
      } } : {}),
      onActivity:event=>{
        if(!interactive)return;
        if(event.type==="model")io!.write("[正在请求模型……]\n");
        else if(event.type==="tool-start")io!.write(`[工具 ${event.name}：执行中]\n`);
        else io!.write(`[工具 ${event.name}：${event.isError?"失败/拒绝":"完成"}]\n`);
      },
    });
    if(interactive)return await runInteractive({io:io!,store,workspace:paths.workspaceRoot,
      model:`${adapter.id} / ${adapter.defaultModel}`,sessionId:options.sessionExplicit?options.session:undefined,createRuntime,
      budgetLimits:`步骤 ${options.maxSteps} · 每步工具 ${options.maxToolCallsPerStep} · 整轮工具 ${options.maxToolCallsPerRun} · prompt ${options.maxContextBytes} 字节 · 令牌 ${options.maxContextTokens}${contextWindows?` · 按模型窗口 ${Object.entries(contextWindows).map(([m,v])=>`${m}=${v}`).join(", ")}`:""} · 挂钟 ${options.deadlineMs}ms`});
    const runtime=createRuntime(options.session);
    const controller=new AbortController();
    const abort=()=>controller.abort();process.on("SIGINT",abort);
    try {
      // One write of the reply, then the budget line. An earlier revision of this
      // block left the inline write in place after the budget line was added, so
      // the answer printed twice; the smoke output caught it.
      const result=await runtime.send(options.prompt!,controller.signal);
      if(result.reasoning!==undefined)write(`[思考] ${result.reasoning}\n`);
      write(result.reply.content+"\n");
      write(`${formatBudget(result.budget)}\n`);
      if(options.showTotals){const totals=await runtime.totals();write(`[adapter=${adapter.id} model=${result.model} steps=${result.steps} tools=${result.toolCalls} in=${totals.inputTokens} out=${totals.outputTokens}]\n`);}
    } finally {process.off("SIGINT",abort);}
    return 0;
  } finally {if(interactive&&!providedIO)io?.close();}
}
const invokedDirectly=process.argv[1]!==undefined&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invokedDirectly)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch((error:unknown)=>{
  process.stderr.write(safeText(`错误：${error instanceof Error?error.message:String(error)}\n`));
  process.exitCode=error instanceof UsageError?2:1;
});
