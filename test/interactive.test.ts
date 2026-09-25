import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { main, parseArgs } from "../src/cli.ts";
import { configureProvider, loadProvider, saveProvider, providerConfig } from "../src/cli-config.ts";
import type { TerminalIO } from "../src/terminal.ts";
import { safeText } from "../src/terminal.ts";
import { createTestFixture } from "./fixtures.ts";
import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createEchoAdapter, createScriptedAdapter } from "../src/echo-adapter.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { createOpenAIChatAdapter } from "../src/openai-adapter.ts";
import { runInteractive } from "../src/interactive.ts";

function fakeIO(inputs: (string|null)[], interactive=true) {
  const output: string[]=[];const hidden:boolean[]=[];
  const io:TerminalIO={interactive,async ask(_prompt,secret){hidden.push(!!secret);return inputs.shift()??null;},
    write(text){output.push(text);},onInterrupt(){return ()=>{};},close(){}};
  return {io,output,hidden};
}
it("interactive echo handles repeated turns and session commands",async()=>{
  const f=await createTestFixture("interactive");const ui=fakeIO(["one","two","/history","/sessions","/new","/resume demo","/status","/help","/exit"]);
  assert.equal(await main(["--home",f.home,"--workspace",f.workspaceRoot,"--session","demo","--echo"],{},ui.io),0);
  const text=ui.output.join("");assert.match(text,/echo: one/);assert.match(text,/echo: two/);assert.match(text,/demo/);assert.match(text,/模型:/);
  assert.equal((await new SessionStore({root:f.home}).history("demo")).length,4);
});
it("interactive /compact records a boundary, says what it did, and keeps /history whole",async()=>{
  const f=await createTestFixture("interactive-compact");
  const ui=fakeIO(["one","/compact","/history","/compact","/status","/exit"]);
  assert.equal(await main(["--home",f.home,"--workspace",f.workspaceRoot,"--session","c1","--echo"],{},ui.io),0);
  const text=ui.output.join("");
  // Both compactions report a boundary; the second says it continued from the first.
  assert.match(text,/已记录前 2 条消息的索引/);
  assert.match(text,/已在上一次摘要（2 条）/);
  // The transcript is untouched: /history still lists every turn.
  assert.match(text,/user: one[\s\S]*assistant: echo: one/);
  assert.equal((await new SessionStore({root:f.home}).history("c1")).length,2,"messages survive compaction");
  assert.ok((await new SessionStore({root:f.home}).compaction("c1"))?.covers === 2);
});
it("interactive prints a reasoning trace before the answer, and stays silent when there is none",async()=>{
  const f=await createTestFixture("interactive-reasoning");
  const store=new SessionStore({root:f.home});
  // Two scripted turns: one with a trace, one without. The absent case must print
  // no "[思考]" header at all rather than an empty one.
  const adapter=createScriptedAdapter({steps:[
    {content:"first answer",reasoning:"I counted on my fingers",
      usage:{inputTokens:9,outputTokens:30,reasoningTokens:22}},
    {content:"second answer",usage:{inputTokens:4,outputTokens:6}},
  ]});
  const ui=fakeIO(["one","two","/exit"]);
  await runInteractive({io:ui.io,store,workspace:f.workspaceRoot,model:"scripted / s1",sessionId:"r1",
    createRuntime:(id)=>new AgentRuntime({adapter,store,sessionId:id,home:f.home,workspaceRoot:f.workspaceRoot})});
  const text=ui.output.join("");
  assert.equal(text.split("[思考]").length-1,1,"only the turn that had a trace prints one");
  assert.ok(text.indexOf("[思考] I counted on my fingers")<text.indexOf("first answer"),"the trace reads before the answer");
  assert.match(text,/· 推理 22 ·/);
  assert.match(text,/second answer/);
  // The share is not a delta on the ceiling arithmetic: 9 is the prompt count.
  assert.match(text,/令牌 9\/131072/);
  // And reasoning never becomes conversation: the transcript holds the answers only.
  const history=await store.history("r1");
  assert.equal(history.length,4);
  assert.ok(!JSON.stringify(history).includes("I counted on my fingers"),"the trace is not persisted as a message");
});

it("interactive reports the per-model window and tokenizer env it was given",async()=>{
  const f=await createTestFixture("interactive-budget-status");
  const ui=fakeIO(["/status","/exit"]);
  const env={PERSONAL_AGENT_CONTEXT_WINDOWS:'{"m":4096}',PERSONAL_AGENT_MAX_CONTEXT_TOKENS:"131072"};
  assert.equal(await main(["--home",f.home,"--workspace",f.workspaceRoot,"--session","s1","--echo"],env,ui.io),0);
  const text=ui.output.join("");
  assert.match(text,/上限: 步骤 10/);
  assert.match(text,/prompt 524288 字节/);
  assert.match(text,/按模型窗口 m=4096/);
});
it("list history works with no provider and parser rejects swallowed flags",async()=>{
  const f=await createTestFixture("cli-list");const ui=fakeIO([]);
  assert.equal(await main(["--home",f.home,"--list"],{},ui.io),0);
  assert.throws(()=>parseArgs(["--home","--list"],{}),/needs a value/);
  assert.equal(parseArgs(["--","--literal"],{}).prompt,"--literal");
  await assert.rejects(()=>main(["--home",f.home],{PERSONAL_AGENT_MODEL:"m"},ui.io),/配置/);
});
it("run budgets parse from flags and environment and reject non-positive values",()=>{
  const flags=parseArgs(["--max-tools","2","--max-tools-per-step","3","--max-send-ms","1500","--max-context-bytes","4096","--max-context-tokens","2048","hi"],{});
  assert.equal(flags.maxToolCallsPerRun,2);
  assert.equal(flags.maxToolCallsPerStep,3);
  assert.equal(flags.deadlineMs,1500);
  assert.equal(flags.maxContextBytes,4096);
  assert.equal(flags.maxContextTokens,2048);
  const fromEnv=parseArgs(["hi"],{PERSONAL_AGENT_MAX_TOOL_CALLS:"4",PERSONAL_AGENT_MAX_TOOLS_PER_STEP:"5",PERSONAL_AGENT_MAX_SEND_MS:"6000",PERSONAL_AGENT_MAX_CONTEXT_BYTES:"8192",PERSONAL_AGENT_MAX_CONTEXT_TOKENS:"1024"});
  assert.equal(fromEnv.maxToolCallsPerRun,4);
  assert.equal(fromEnv.maxToolCallsPerStep,5);
  assert.equal(fromEnv.deadlineMs,6000);
  assert.equal(fromEnv.maxContextBytes,8192);
  assert.equal(fromEnv.maxContextTokens,1024);
  const defaults=parseArgs(["hi"],{});
  assert.equal(defaults.maxToolCallsPerRun,32);
  assert.equal(defaults.maxToolCallsPerStep,8);
  assert.equal(defaults.deadlineMs,300_000);
  assert.equal(defaults.maxContextBytes,524_288);
  assert.equal(defaults.maxContextTokens,131_072);
  for (const flag of ["--max-tools","--max-tools-per-step","--max-send-ms","--max-context-bytes","--max-context-tokens","--max-steps"]) {
    assert.throws(()=>parseArgs([flag,"0","hi"],{}),/positive integer/,flag);
    assert.throws(()=>parseArgs([flag,"1.5","hi"],{}),/positive integer/,flag);
  }
});
it("wizard hides key and defaults to nonsecret persistence",async()=>{
  const f=await createTestFixture("wizard");const ui=fakeIO(["","https://example.test/v1","model","SYNTHETIC_KEY",""]);
  const config=await configureProvider(ui.io,f.home,{});assert.equal(typeof config,"object");assert.ok(ui.hidden.includes(true));
  const saved=await readFile(join(f.home,"provider-config.json"),"utf8");assert.doesNotMatch(saved,/SYNTHETIC_KEY/);
  assert.doesNotMatch(ui.output.join(""),/SYNTHETIC_KEY/);
  const next=fakeIO(["SECOND_KEY"]);assert.equal((await configureProvider(next.io,f.home,{}) as {apiKey:string}).apiKey,"SECOND_KEY");
});
it("key persistence requires explicit choice and partial env never borrows saved key",async()=>{
  const f=await createTestFixture("saved-key");const ui=fakeIO(["","https://example.test/v1","m","EXPLICIT_KEY","key"]);
  await configureProvider(ui.io,f.home,{});assert.equal((await loadProvider(f.home,{}))?.apiKey,"EXPLICIT_KEY");
  await assert.rejects(()=>loadProvider(f.home,{PERSONAL_AGENT_BASE_URL:"https://different.test/v1"}));
  await assert.rejects(()=>saveProvider(f.home,{},providerConfig({baseUrl:"https://x.test",model:"m",apiKey:"x"}),true),/EEXIST/);
});
it("saved key in an inactive custom home remains unreadable to tools",async()=>{
  const f=await createTestFixture("inactive-config");const oldHome=join(f.workspaceRoot,"old-home");
  await saveProvider(oldHome,{},providerConfig({baseUrl:"https://x.test",model:"m",apiKey:"NEVER_LEAK_KEY"}),true);
  const result=await new ToolRegistry([createReadFileTool()]).execute({id:"r",name:"read_file",arguments:JSON.stringify({path:"old-home/provider-config.json"})},{workspaceRoot:f.workspaceRoot});
  assert.equal(result.isError,true);assert.doesNotMatch(result.content,/NEVER_LEAK_KEY/);
});
it("invalid config JSON never echoes source fragments",async()=>{
  const f=await createTestFixture("invalid-config");await writeFile(join(f.home,"provider-config.json"),'{"apiKey":"PRIVATE_FRAGMENT" bad json');
  await assert.rejects(()=>loadProvider(f.home,{}),e=>e instanceof Error&&!e.message.includes("PRIVATE_FRAGMENT"));
});
it("noninteractive setup refuses to read a key and output escapes controls",async()=>{
  const f=await createTestFixture("no-tty");const ui=fakeIO([],false);
  await assert.rejects(()=>configureProvider(ui.io,f.home,{}),/没有完整模型配置/);
  assert.equal(safeText("x\x1b[2J"),"x\\u001b[2J");
  assert.throws(()=>providerConfig({baseUrl:"http://remote.test",model:"m",apiKey:"k"}),/HTTPS/);
});
it("pre-cancel does not write a turn; cancellation skips remaining executors and completes tool pairing",async()=>{
  const f=await createTestFixture("cancel");const store=new SessionStore({root:f.storeRoot});
  const cancelled=new AbortController();cancelled.abort();
  const plain=new AgentRuntime({adapter:createEchoAdapter(),store,sessionId:"pre",home:f.home});
  await assert.rejects(()=>plain.send("hi",cancelled.signal));assert.deepEqual(await store.history("pre"),[]);
  const abort=new AbortController();let runs=0;
  const adapter=createScriptedAdapter({steps:[{toolCalls:[{id:"a",name:"stop",arguments:"{}"},{id:"b",name:"stop",arguments:"{}"}]}]});
  const runtime=new AgentRuntime({adapter,store,sessionId:"batch",home:f.home,tools:new ToolRegistry([{name:"stop",description:"test",parameters:{type:"object"},readOnly:true,
    async execute(){runs++;abort.abort();return {content:"first completed"};}}])});
  await assert.rejects(()=>runtime.send("go",abort.signal));assert.equal(runs,1);
  const history=await store.history("batch");assert.deepEqual(history.filter(m=>m.role==="tool").map(m=>m.toolCallId),["a","b"]);
  assert.match(history.at(-1)!.content,/cancelled/);
});
it("incomplete provider responses never persist assistant data or execute tools", async () => {
  const f = await createTestFixture("finish-reason");
  const store = new SessionStore({ root: f.storeRoot });
  let executions = 0;
  const tools = new ToolRegistry([{ name: "probe", description: "test", parameters: { type: "object" }, readOnly: true,
    async execute() { executions++; return { content: "unexpected" }; } }]);
  for (const reason of ["length", "content_filter"]) {
    for (const withTools of [false, true]) {
      const id = `${reason}-${withTools}`;
      const adapter = createOpenAIChatAdapter({ baseUrl: "https://x.test", apiKey: "k", model: "m",
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: {
          content: "PRIVATE_PARTIAL_REPLY",
          ...(withTools ? { tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }] } : {}),
        } }] })) });
      const runtime = new AgentRuntime({ adapter, store, sessionId: id, home: f.home, tools });
      await assert.rejects(() => runtime.send("hello"), error => error instanceof Error &&
        error.message.includes(reason) && !error.message.includes("PRIVATE_PARTIAL_REPLY"));
      assert.equal(executions, 0);
      assert.deepEqual((await store.read(id)).map(event => event.kind), ["session", "message"]);
      assert.deepEqual((await store.history(id)).map(message => message.role), ["user"]);
      await store.assertReady(id);
    }
  }
});
it("successful and legacy provider endings retain compatible response mapping", async () => {
  for (const reason of [undefined, null, "stop", "tool_calls"]) {
    const withTools = reason === "tool_calls";
    const adapter = createOpenAIChatAdapter({ baseUrl: "https://x.test", apiKey: "k", model: "m",
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: {
        content: withTools ? null : "ok",
        ...(withTools ? { tool_calls: [{ id: "c", type: "function", function: { name: "probe", arguments: "{}" } }] } : {}),
      } }] })) });
    const result = await adapter.chat({ messages: [] });
    assert.equal(result.content, withTools ? "" : "ok");
    assert.equal(result.toolCalls.length, withTools ? 1 : 0);
  }
});
it("configuration byte limit is enforced before creating a home and round-trips at the boundary", async () => {
  const f = await createTestFixture("config-size");
  const base = { baseUrl: "https://x.test/v1", model: "", apiKey: "SYNTHETIC_KEY" };
  for (const saveKey of [false, true]) {
    const empty = JSON.stringify({ v: 1, baseUrl: base.baseUrl, model: "",
      ...(saveKey ? { apiKey: base.apiKey } : {}) }, null, 2) + "\n";
    const available = 16_384 - Buffer.byteLength(empty, "utf8");
    const model = "汉".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    const config = { ...base, model };
    const rejectedHome = join(f.root, `rejected-${saveKey}`);
    await assert.rejects(() => saveProvider(rejectedHome, {}, { ...config, model: model + "x" }, saveKey),
      error => error instanceof Error && /16384/.test(error.message) && !error.message.includes(base.apiKey));
    await assert.rejects(() => stat(rejectedHome), { code: "ENOENT" });
    const acceptedHome = join(f.root, `accepted-${saveKey}`);
    await saveProvider(acceptedHome, {}, config, saveKey);
    assert.equal((await stat(join(acceptedHome, "provider-config.json"))).size, 16_384);
    assert.deepEqual(await loadProvider(acceptedHome, {}), { ...config, apiKey: saveKey ? base.apiKey : "__ASK_AT_START__" });
  }
  const home = join(f.root, "omit-large-key");
  await saveProvider(home, {}, { ...base, model: "m", apiKey: "k".repeat(20_000) }, false);
  assert.equal((await loadProvider(home, {}))?.apiKey, "__ASK_AT_START__");
});
it("malformed provider responses fail before assistant persistence and HTTP errors hide raw body",async()=>{
  const f=await createTestFixture("bad-response");const store=new SessionStore({root:f.storeRoot});
  const adapter=createOpenAIChatAdapter({baseUrl:"https://x.test",apiKey:"k",model:"m",fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:"ok"}}],usage:{prompt_tokens:"7"}}))});
  const runtime=new AgentRuntime({adapter,store,sessionId:"invalid",home:f.home});await assert.rejects(()=>runtime.send("hi"),/token count/);
  assert.deepEqual((await store.history("invalid")).map(m=>m.role),["user"]);
  const bad=createOpenAIChatAdapter({baseUrl:"https://x.test",apiKey:"k",model:"m",fetchImpl:async()=>new Response("SECRET_BODY",{status:401})});
  await assert.rejects(()=>bad.chat({messages:[]}),e=>e instanceof Error&&e.message.includes("401")&&!e.message.includes("SECRET_BODY"));
});
