#!/usr/bin/env node
import { resolve } from "node:path";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SessionStore } from "./session-store.ts";
import { AgentRuntime, DEFAULT_DEADLINE_MS, DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_STEPS, DEFAULT_MAX_TOOL_CALLS_PER_RUN, DEFAULT_MAX_TOOL_CALLS_PER_STEP, formatBudget } from "./runtime.ts";
import { formatTaskAssessment } from "./task-state.ts";
import { formatEvaluation } from "./cycle.ts";
import { createEchoAdapter } from "./echo-adapter.ts";
import { createOpenAIChatAdapter } from "./openai-adapter.ts";
import { findTier, resolveTier } from "./tiers.ts";
import { grantReadableRoot, readTrustedRoots, revokeReadableRoot } from "./trusted-roots.ts";
import { ToolRegistry, createBatchFilesTool, createCreateFileTool, createDeleteFileTool, createEditFileTool, createInspectFileTool, createPatchFileTool, createJobKillTool, createJobOutputTool, createReadFileTool, createRenameFileTool, createRunCommandTool, createUpdateTaskStateTool } from "./tools.ts";
import { mintGene } from "./gene.ts";
import { shutdownJobs } from "./background-jobs.ts";
import type { Gene } from "./gene.ts";
import { GeneStore } from "./gene-store.ts";
import { CycleStore } from "./cycle-store.ts";
import { distillGuards, unmintedDrafts } from "./distill.ts";
import { inductGenes, uncoveredCandidates } from "./induct.ts";
import { agentHomeProblem } from "./tool-environment.ts";
import { configuredContextWindows, configuredProtectedRoots, resolveRuntimePaths } from "./security-config.ts";
import { configureProvider, loadProvider } from "./cli-config.ts";
import { configRules, loadAgentConfig, wideningRules } from "./config.ts";
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
      npm start -- --preflight --probe-tools
                                      额外真实发一次请求（**会消耗 token**），实测两件状态码看不到的事：
                                      提供方是否接受本客户端的请求形状、是否真的调用工具
      npm start -- --mint-gene draft.json 从验证过的成功经验铸造一个基因并入库（不需要模型）
      npm start -- --distill           把反复失败的请求蒸馏成 guard 草稿并打印，不自动铸造
      npm start -- --induct            把"没有基因可用但成功了"的轮次归纳成候选草稿并打印，不自动铸造
      npm start -- --trust-root <dir>  授予对工作区外某目录的**只读**访问（写入仍限于工作区）
      npm start -- --trusted           列出已授予的只读目录；--untrust-root <dir> 撤销
      npm start -- --tier <name>       权限档位：read-only / ask-before-writing / workspace-write（默认）/ full-access
      npm start -- --stream "问题"     用 SSE 流式传输（服务端只支持流式时使用；不改变回答内容）
选项：--home <dir> --workspace <dir> --max-steps <n> --max-tools <n>
      --max-tools-per-step <n> --max-send-ms <n> --max-context-bytes <n> --max-context-tokens <n> --totals
      --session/-s <id> --echo --preflight --stream --distill --induct --tier --trust-root --untrust-root --trusted --help/-h -- <以横线开头的提示>
环境：PERSONAL_AGENT_BASE_URL / PERSONAL_AGENT_MODEL / PERSONAL_AGENT_API_KEY
      三项须一起配置；不与已保存配置混合，不再静默回退 Echo。
      预算：PERSONAL_AGENT_MAX_STEPS / _MAX_TOOL_CALLS / _MAX_TOOLS_PER_STEP / _MAX_SEND_MS / _MAX_CONTEXT_BYTES / _MAX_CONTEXT_TOKENS
      档位：PERSONAL_AGENT_TIER（不从工作区内的文件读取，克隆来的仓库无法自行提权）
      配置文件：<home>/config.json —— 设默认档位与规则；**只读 agent home，绝不读工作区**。
                形如 {"tier":"ask-before-writing","rules":[{"tool":"run_command","decision":"deny","reason":"…"}]}
                规则里**不接受** tier 与 when 字段（前者会让配置压过所选档位，后者等于让配置文件执行代码）；
                配置放宽了原本要问的事，会像 --tier full-access 一样写入会话审计。损坏的配置**报错**，不静默当空。
      长期约束：<home>/constraints.json —— 操作员的常驻嘱咐，**每轮重新注入系统提示词**，不因对话变长而被淹没。
                形如 {"version":1,"constraints":["永远用中文回复","不要改写 docs/ 里的历史批次记录"]}
                条目就是字符串：删掉一行即撤销（不带 id/reason/expires）。用任意编辑器改，**下一轮即生效，不必重启**。
                **它不能改权限**——出现 tool/decision/tier/rules/priority/when 一律报错并指向 config.json；
                注入的文字自己声明"是上下文不是保证"。**只读 agent home，绝不读工作区**（克隆来的仓库无法夹带嘱咐）；
                agent 也写不了它（agent home 按位置对文件工具封死）。合计超 32768 字节报错并给出实际大小，不静默截断。
      按模型窗口：PERSONAL_AGENT_CONTEXT_WINDOWS='{"<model>":<tokens>,"*":<tokens>}'
      精确预判（可选，不内置分词器）：PERSONAL_AGENT_TOKENIZER='<命令>'，读 stdin 的 prompt JSON，向 stdout 打印单个非负整数
      该命令失败/超时/输出非数字一律报错，不静默退回估算
      流式：PERSONAL_AGENT_STREAM=1（等同 --stream）
交互命令：/help /new /sessions /resume <id> /history /inspect [id] /recover [id] /status /exit
密钥默认不落盘；工具仅 read_file。\n`;
export interface CliOptions {
  session: string; sessionExplicit: boolean; home: string; workspace: string;
  prompt?: string; list: boolean; showTotals: boolean; maxSteps: number; echo: boolean; help: boolean; preflight: boolean; probeTools: boolean;
  maxToolCallsPerRun: number; maxToolCallsPerStep: number; deadlineMs: number; maxContextBytes: number; maxContextTokens: number;
  stream: boolean;
  /** Path to a gene draft JSON to mint. Operator action; no model involved. */
  mintGene?: string;
  /** Print distilled guard drafts. Read-only: minting stays a separate action. */
  distill: boolean;
  /** Print induced candidate drafts. Same rule: nothing is minted here. */
  induct: boolean;
  /** Permission posture name (D32). Unknown names fail rather than fall back. */
  tier?: string;
  /** Grant read access to a directory outside the workspace (D35). Writes are unaffected. */
  trustRoot?: string;
  /** Revoke a previously granted readable root (D35). */
  untrustRoot?: string;
  /** Print the granted readable roots and exit. */
  listTrusted: boolean;
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
    echo:false,help:false,preflight:false,distill:false,induct:false,
    // The permission posture (D32). Read from the flag or the environment, and
    // deliberately never from a file inside the workspace: a cloned repository
    // must not be able to grant itself full access.
    tier:env.PERSONAL_AGENT_TIER,
    listTrusted:false,
    // Opt-in, because unlike every other preflight check this one spends a token
    // and puts the key on the wire. It answers the question a status probe
    // structurally cannot: does this provider accept our request shape, and does
    // it actually call tools. See preflight.ts.
    probeTools:false,
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
    else if(arg==="--probe-tools")options.probeTools=true;
    else if(arg==="--stream")options.stream=true;
    else if(arg==="--tier")options.tier=valueFor(argv,++i,arg);
    else if(arg==="--trust-root")options.trustRoot=valueFor(argv,++i,arg);
    else if(arg==="--untrust-root")options.untrustRoot=valueFor(argv,++i,arg);
    else if(arg==="--trusted")options.listTrusted=true;
    else if(arg==="--mint-gene")options.mintGene=valueFor(argv,++i,arg);
    else if(arg==="--distill")options.distill=true;
    else if(arg==="--induct")options.induct=true;
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
  if(options.mintGene&&(rest.length||options.list||options.showTotals||options.preflight||options.echo||options.distill||options.induct))throw new UsageError("--mint-gene 不能与 prompt、--list、--totals、--preflight、--echo、--distill 或 --induct 混用");
  if(options.distill&&(rest.length||options.list||options.showTotals||options.preflight||options.echo||options.induct))throw new UsageError("--distill 不能与 prompt、--list、--totals、--preflight、--echo 或 --induct 混用");
  if(options.induct&&(rest.length||options.list||options.showTotals||options.preflight||options.echo))throw new UsageError("--induct 不能与 prompt、--list、--totals、--preflight 或 --echo 混用");
  // Trust actions are standalone operator decisions. Refusing to combine them
  // with a prompt keeps "what may be read" from being changed as a side effect
  // of a turn the model drove.
  const trustAction=[options.trustRoot!==undefined,options.untrustRoot!==undefined,options.listTrusted].filter(Boolean).length;
  if(trustAction>1)throw new UsageError("--trust-root、--untrust-root 与 --trusted 互斥");
  if(trustAction>0&&(rest.length||options.list||options.showTotals||options.preflight||options.echo||options.mintGene||options.distill||options.induct))throw new UsageError("--trust-root、--untrust-root 与 --trusted 不能与 prompt 或其他子命令混用");
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
  if(options.probeTools&&!options.preflight)throw new UsageError("--probe-tools 只在 --preflight 下有意义；它需要先跑准备检查");
  if(options.preflight){
    // Without --probe-tools this stays before any credential file is read and
    // before any adapter is built: this mode must not be a path that could use a
    // key it was only supposed to describe. With --probe-tools the operator has
    // explicitly asked for a real authenticated request, so the key is read here
    // and passed in — and it is still never printed, only used.
    let liveToolProbe;
    if(options.probeTools){
      let provider;
      try{provider=await loadProvider(options.home??env.PERSONAL_AGENT_HOME??".personal-agent",env);}
      catch(error){throw new UsageError(`--probe-tools 需要可用的模型配置：${(error as Error).message}`);}
      if(!provider)throw new UsageError("--probe-tools 需要已保存的模型配置；请先运行 npm start 配置，或设置 PERSONAL_AGENT_* 环境变量。");
      liveToolProbe={baseUrl:provider.baseUrl,model:provider.model,apiKey:provider.apiKey};
    }
    const report=await preflight({env,stdinIsTTY:!!process.stdin.isTTY,stdoutIsTTY:!!process.stdout.isTTY,
      ...(process.stdout.columns===undefined?{}:{columns:process.stdout.columns}),
      ...(process.stdout.rows===undefined?{}:{rows:process.stdout.rows}),
      ...(liveToolProbe?{liveToolProbe}:{})});
    write(formatPreflight(report));
    // Non-zero when a live run cannot be attempted, so this is usable as a gate.
    // A measured tool-capability failure is also non-zero: a model that ignores
    // every tool cannot serve as this Agent, so it must not exit 0 as "ready".
    // Exit 5 separates an account problem from a capability one, because the
    // operator's next move differs: top up the account, versus change the model.
    if(report.toolCalling==="account")return 5;
    if(report.toolCalling==="tools-dropped"||report.toolCalling==="request-failed")return 4;
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
  const cycleStore=new CycleStore(join(paths.agentHome,"cycles.jsonl"));
  if(options.mintGene){
    let raw:string;
    try{raw=await readFile(options.mintGene,"utf8");}
    catch(error){throw new UsageError(`无法读取基因文件：${(error as Error).message}`);}
    // A BOM is what Windows editors and `Set-Content -Encoding utf8` write by
    // default. JSON.parse rejects it, and "not valid JSON" would send the
    // operator looking for a syntax error that is not there, so it is stripped.
    if(raw.charCodeAt(0)===0xfeff)raw=raw.slice(1);
    let draft:unknown;
    try{draft=JSON.parse(raw);}
    catch(error){throw new UsageError(`基因文件不是合法 JSON：${(error as Error).message}`);}
    let minted;
    try{minted=mintGene(draft as Gene);}
    catch(error){throw new UsageError(`基因不合格：${(error as Error).message}`);}
    await geneStore.appendGene(minted);
    write(`已铸造 ${minted.gene.name} → ${minted.address}\n`);
    return 0;
  }
  if(options.distill){
    const facts=await geneStore.failures();
    const library=await geneStore.state();
    const drafts=unmintedDrafts(distillGuards(facts),[...library.genes.values()]);
    if(!drafts.length)write(`没有达到阈值的失败模式（已归档失败 ${facts.length} 轮）。\n`);
    for(const draft of drafts){
      write(`${draft.summary}\n`);
      write(`${JSON.stringify(draft.gene)}\n`);
      write(`（草稿不含 validation，铸造前须自己补上真正的验证命令）\n`);
    }
    return 0;
  }
  if(options.induct){
    const facts=await geneStore.geneLessSuccesses();
    const library=await geneStore.state();
    const drafts=uncoveredCandidates(inductGenes(facts),[...library.genes.values()]);
    if(!drafts.length)write(`没有达到阈值的无基因成功模式（已归档无基因成功 ${facts.length} 轮）。\n`);
    for(const draft of drafts){
      write(`${draft.summary}\n`);
      write(`${JSON.stringify(draft.gene)}\n`);
      write(`（${draft.caveat}）\n`);
    }
    return 0;
  }
  if(options.listTrusted){
    const roots=await readTrustedRoots(paths.agentHome);
    if(!roots.length)write(`没有授予任何工作区外的可读目录。\n（信任记录位于 ${join(paths.agentHome,"trust.json")}，不在工作区内。）\n`);
    for(const root of roots)write(`${root}\n`);
    return 0;
  }
  if(options.trustRoot!==undefined||options.untrustRoot!==undefined){
    const granting=options.trustRoot!==undefined;
    const requested=(granting?options.trustRoot:options.untrustRoot)!;
    const absolute=resolve(requested);
    // Paths are canonicalized at the store boundary, so record what was stored.
    if(granting){
      let recorded:string;
      try{recorded=await grantReadableRoot(paths.agentHome,absolute);}
      catch(error){throw new UsageError((error as Error).message);}
      write(`已授予只读访问：${recorded}\n`);
      write(`写操作仍限于工作区 ${paths.workspaceRoot}——授予只读不等于授予写入。\n`);
      write(`该目录下按名字保护的路径（.env、.git、*.pem 等）仍然拒绝。\n`);
      await store.appendAudit(options.session,{tool:"*",decision:"denied",
        reason:`readable root granted: ${recorded}`,rule:"trust:grant"});
    } else {
      const removed=await revokeReadableRoot(paths.agentHome,absolute);
      if(!removed)write(`未授予过该目录，无需撤销：${absolute}\n`);
      else {
        write(`已撤销只读访问：${absolute}\n`);
        await store.appendAudit(options.session,{tool:"*",decision:"denied",
          reason:`readable root revoked: ${absolute}`,rule:"trust:revoke"});
      }
    }
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
      // The per-request timeout must not be shorter than the send deadline, or
      // the adapter becomes the binding constraint and a slow-but-working
      // provider fails with a timeout the operator never configured. Observed
      // for real: a local gateway took 65-75s for a one-word completion, so the
      // 120s adapter default left almost no headroom once tool calls were added.
      else adapter=createOpenAIChatAdapter({...config,timeoutMs:options.deadlineMs,...(options.stream?{stream:true}:{})});
    }
    // Operator configuration, read from the agent home only (D26). A corrupt file
    // throws rather than being ignored: it exists to change what the agent may do,
    // and running on defaults while the operator believes they configured
    // something is the worst of the three possible outcomes.
    const agentConfig=await loadAgentConfig(paths.agentHome);
    // Precedence is CLI flag > environment > agent-home config > built-in default.
    // `options.tier` already folds the first two together, so config is consulted
    // only when neither was given. gemini-cli merges its operator layer last so it
    // overrides the workspace layer; the equivalent here is that an explicit
    // command-line choice is never silently replaced by a file.
    const tier=resolveTier(options.tier??agentConfig.tier);
    // Asked of argv rather than inferred by comparing values, because `--tier X`
    // with `PERSONAL_AGENT_TIER=X` would otherwise be attributed to the
    // environment, and an audit line that names the wrong source is worse than one
    // that names none.
    const tierSource=argv.includes("--tier")?"--tier"
      :options.tier?"PERSONAL_AGENT_TIER"
      :agentConfig.tier?`config file ${agentConfig.source}`:"built-in default";
    // Removing a boundary is a recorded operator decision, not something that
    // happens because a label was set (D26/D32). It is written to the session
    // audit so the choice can be reviewed after the fact.
    if(tier.removesBoundary)await store.appendAudit(options.session,{tool:"*",decision:"denied",
      reason:`permission tier "${tier.name}" removes the write prompt; chosen via ${tierSource}`,
      rule:`tier:${tier.name}`});
    // Configuration sits a tier below the posture's own boundaries, so it can
    // adjust what a writing posture leaves open but cannot out-prioritise
    // `read-only`'s deny-every-write or `full-access`'s audited allow-all.
    const configuredRules=configRules(agentConfig);
    // A configured `allow` that the posture would have asked about is a boundary
    // removal, and gets the same treatment as choosing a permissive tier: named in
    // the audit, one line per rule, so "who stopped the prompting" has an answer.
    for(const widened of wideningRules(agentConfig,tier.rules)){
      await store.appendAudit(options.session,{tool:widened.tool,decision:"allowed",
        reason:`configuration allows "${widened.tool}" without asking${widened.reason?`: ${widened.reason}`:""}`,
        rule:"config:widen"});
    }
    const rules=[...configuredRules,...tier.rules];
    // Built from the tier's tool list, so a posture that does not offer a tool
    // makes it genuinely absent rather than merely refused (D28/D32). Configuration
    // cannot add a tool back: it reaches the rule table, never the registry.
    const createRuntime=(sessionId:string)=>{
      // ⚠️ D90: this table lives *inside* createRuntime rather than beside it, because
      // one entry needs this session's id. It used to sit outside with
      // `update_task_state` special-cased by a ternary in the map below, which meant
      // adding a tool that needs session state required editing control flow instead of
      // a table. Now the table is the only registration point for every tool,
      // session-scoped or not, and the map is a single lookup.
      //
      // The registry is still built per session rather than once. Building it once
      // outside would either capture a stale session id — letting one session write
      // another's task state — or need a mutable holder, which is the same hazard with
      // more steps.
      const allTools={read_file:createReadFileTool,inspect_file:createInspectFileTool,run_command:createRunCommandTool,job_output:createJobOutputTool,job_kill:createJobKillTool,
        edit_file:createEditFileTool,patch_file:createPatchFileTool,
        create_file:createCreateFileTool,delete_file:createDeleteFileTool,rename_file:createRenameFileTool,
        batch_files:createBatchFilesTool,
        update_task_state:()=>createUpdateTaskStateTool(store,sessionId)} as const;
      // ⚠️ D90: check before calling. Without this, a tier naming a tool that has no
      // factory dies as `TypeError: allTools[...] is not a function`, and it dies
      // *before* `ToolRegistry`'s own "available tool is not registered" check
      // (tools.ts:1226-1230) can say anything useful. Naming the offending tool and
      // listing what does exist is the difference between a diagnosis and a stack trace.
      const tierTools=tier.tools.map(name=>{
        const factory=allTools[name as keyof typeof allTools];
        if(!factory) throw new Error(`档位声明了工具 ${JSON.stringify(name)}，但没有对应的工厂；表里有的是 ${Object.keys(allTools).join(", ")}`);
        return factory();
      });
      return new AgentRuntime({adapter,store,sessionId,
      workspaceRoot:paths.workspaceRoot,home:paths.agentHome,protectedRoots:extraRoots,geneStore,cycleStore,
      tools:new ToolRegistry(tierTools,tier.tools),rules,maxSteps:options.maxSteps,
      maxToolCallsPerStep:options.maxToolCallsPerStep,maxToolCallsPerRun:options.maxToolCallsPerRun,deadlineMs:options.deadlineMs,maxContextBytes:options.maxContextBytes,maxContextTokens:options.maxContextTokens,
      ...(contextWindows===undefined?{}:{contextWindows}),
      ...(countPromptTokens===undefined?{}:{countPromptTokens}),
      systemPrompt:"You are a concise, capable assistant working in a real workspace. Use run_command to build, test, search and inspect: anything you would otherwise type into a terminal. Use read_file for workspace text and inspect_file for binaries, executables and archives. File changes use edit_file, create_file, delete_file, rename_file, or batch_files. A command that exits non-zero is not a failure of the tool, so read its output and correct the command rather than reporting the task as impossible. When you change something, verify it by running it. Respect denied paths; never pretend a tool succeeded.",
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
    };
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
      // Between the budget and the task assessment, and that order is the meaning:
      // what this round consumed, then what the system concluded about this round,
      // then where the cross-round task stands. The task line goes last because it
      // is the only one of the three that is not scoped to this round.
      write(`${formatEvaluation(result.evaluation)}\n`);
      // Printed only when a task state was recorded. An assessment computed but
      // never shown would be dead code of exactly the kind D58 found: built,
      // load-bearing in tests, and reaching nobody.
      const taskLine = result.taskAssessment === undefined ? undefined : formatTaskAssessment(result.taskAssessment);
      if (taskLine !== undefined) write(`${taskLine}\n`);
      if(options.showTotals){const totals=await runtime.totals();write(`[adapter=${adapter.id} model=${result.model} steps=${result.steps} tools=${result.toolCalls} in=${totals.inputTokens} out=${totals.outputTokens}]\n`);}
    } finally {process.off("SIGINT",abort);}
    return 0;
  } finally {
    // Closing the agent closes its background jobs, which is the operator's
    // explicit choice over letting them outlive the session. A job that survived
    // this point would be invisible: nothing left running still reports that it
    // is writing to disk. Reported when anything was actually stopped, so the
    // count is visible rather than the silence being ambiguous.
    const stopped = shutdownJobs();
    if (stopped > 0) write(`[已停止 ${stopped} 个后台作业]\n`);
    if(interactive&&!providedIO)io?.close();
  }
}
const invokedDirectly=process.argv[1]!==undefined&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invokedDirectly)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch((error:unknown)=>{
  process.stderr.write(safeText(`错误：${error instanceof Error?error.message:String(error)}\n`));
  process.exitCode=error instanceof UsageError?2:1;
});
