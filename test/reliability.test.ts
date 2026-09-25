import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createTestFixture } from "./fixtures.ts";
import { SessionCorruptionError, SessionStore, migrateEvent } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createEchoAdapter } from "../src/echo-adapter.ts";
import { SessionBusyError } from "../src/session-lease.ts";
import { main } from "../src/cli.ts";
import type { TerminalIO } from "../src/terminal.ts";

it("same-session runtimes reject overlapping turns then permit next turn",async()=>{
  const f=await createTestFixture("writer");const store=new SessionStore({root:f.storeRoot});
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const adapter={...createEchoAdapter(),async chat(){enter();await gate;return {content:"done",toolCalls:[],model:"test",usage:{inputTokens:0,outputTokens:0}};}};
  const a=new AgentRuntime({adapter,store,sessionId:"same",home:f.home});
  const b=new AgentRuntime({adapter:createEchoAdapter(),store:new SessionStore({root:f.storeRoot}),sessionId:"same",home:f.home});
  const work=a.send("one");await entered;
  try {await assert.rejects(()=>b.send("two"),SessionBusyError);}finally{release();}await work;
  await b.send("three");assert.deepEqual((await store.history("same")).filter(m=>m.role==="user").map(m=>m.content),["one","three"]);
});
it("runtime nested from adapter cannot inherit and bypass the writer lease",async()=>{
  const f=await createTestFixture("nested-writer");const store=new SessionStore({root:f.storeRoot});
  const nested=new AgentRuntime({adapter:createEchoAdapter(),store,home:f.home,sessionId:"s"});
  const adapter={...createEchoAdapter(),async chat(){await assert.rejects(()=>nested.send("nested"),SessionBusyError);return {content:"ok",toolCalls:[],model:"m",usage:{inputTokens:0,outputTokens:0}};}};
  await new AgentRuntime({adapter,store,home:f.home,sessionId:"s"}).send("outer");
  assert.deepEqual((await store.history("s")).filter(m=>m.role==="user").map(m=>m.content),["outer"]);
});
it("cross-process writer cannot enter a held session lease",async()=>{
  const f=await createTestFixture("process-lock");const store=new SessionStore({root:f.storeRoot});
  const module=pathToFileURL(resolve("src/session-store.ts")).href;
  const script=`import {SessionStore} from ${JSON.stringify(module)}; const s=new SessionStore({root:${JSON.stringify(f.storeRoot)}}); try {await s.withWriter('shared',async()=>{});process.exitCode=9;}catch(e){process.exitCode=e.name==='SessionBusyError'?0:8;}`;
  await store.withWriter("shared",async()=>{
    const code=await new Promise<number|null>((done,reject)=>{const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",script],{stdio:"inherit"});child.on("error",reject);child.on("exit",done);});
    assert.equal(code,0);
  });
});
it("initialization is exclusive/idempotent and stale locks fail closed",async()=>{
  const f=await createTestFixture("header");const store=new SessionStore({root:f.storeRoot});
  await store.create("one");await store.create("one");assert.equal((await store.read("one")).length,1);
  await writeFile(store.pathFor("stale")+".lock","orphan owner");
  await assert.rejects(()=>store.create("stale"),SessionBusyError);
});
it("each append strictly reads once, including initialization and corrupt headers", async t => {
  const f = await createTestFixture("append-read");
  const store = new SessionStore({ root: f.storeRoot });
  const reads = t.mock.method(store, "read");
  await store.appendMessage("s", { role: "user", content: "first" });
  assert.equal(reads.mock.callCount(), 1);
  reads.mock.resetCalls();
  await store.withWriter("s", () => store.appendMessage("s", { role: "assistant", content: "second" }));
  assert.equal(reads.mock.callCount(), 1);
  assert.deepEqual((await store.read("s")).map(event => event.kind), ["session", "message", "message"]);
  const header = JSON.stringify({ v: 1, kind: "session", id: "s", createdAt: "t" });
  for (const invalid of [header + "\n" + header + "\n", header.replace('"s"', '"other"') + "\n"]) {
    await writeFile(store.pathFor("s"), invalid);
    reads.mock.resetCalls();
    await assert.rejects(() => store.appendMessage("s", { role: "user", content: "refused" }), /header/);
    assert.equal(reads.mock.callCount(), 1);
    assert.equal(await readFile(store.pathFor("s"), "utf8"), invalid);
  }
});
it("rejects invalid versions, role fields and numeric usage",()=>{
  for(const v of [-1,0.5,Infinity])assert.throws(()=>migrateEvent({v,kind:"session",id:"s",createdAt:"t"}));
  assert.throws(()=>migrateEvent({v:1,kind:"message",at:"t",message:{role:"tool",content:"x"}}));
  for(const n of [-1,0.5,Infinity])assert.throws(()=>migrateEvent({v:1,kind:"usage",at:"t",usage:{inputTokens:n,outputTokens:0}}));
});
it("torn final lines and header mismatches are never extended",async()=>{
  const f=await createTestFixture("torn");const store=new SessionStore({root:f.storeRoot});await store.create("torn");
  await appendFile(store.pathFor("torn"),'{"v":1,"kind":"message"');
  const before=await readFile(store.pathFor("torn"),"utf8");await assert.rejects(()=>store.appendMessage("torn",{role:"user",content:"no"}));
  await assert.rejects(()=>store.recover("torn"));assert.equal(await readFile(store.pathFor("torn"),"utf8"),before);
  await writeFile(store.pathFor("wrong"),JSON.stringify({v:1,kind:"session",id:"different",createdAt:"t"})+"\n");await assert.rejects(()=>store.read("wrong"),/header/);
});
it("semantic tool corruption identifies source line and never recovers silently",async()=>{
  const f=await createTestFixture("pairing");const store=new SessionStore({root:f.storeRoot});await store.create("s");
  await store.appendMessage("s",{role:"tool",toolCallId:"orphan",content:"PRIVATE_CONTENT"});
  await assert.rejects(()=>store.pendingTools("s"),e=>e instanceof Error && /line 2/.test(e.message)&&/orphan/.test(e.message)&&!e.message.includes("PRIVATE_CONTENT"));
  await assert.rejects(()=>store.recover("s"));
});
it("refuses a duplicate tool call audit record instead of absorbing it",async()=>{
  // PT06: a second `tool/call` for the same id used to be silently accepted (the
  // arguments check passed, so nothing distinguished it from the first), which
  // meant there was no way to tell a duplicated audit record from a legitimate
  // one. Legacy kinds only: ADR-0001 stopped writing the audit pair.
  const f=await createTestFixture("dup-call");const store=new SessionStore({root:f.storeRoot});await store.create("dup");
  const audit=(kind:string,extra:Record<string,unknown>)=>JSON.stringify({v:1,kind,ignorable:true,at:new Date().toISOString(),callId:"c1",name:"read_file",...extra})+"\n";
  await store.appendMessage("dup",{role:"assistant",content:"",toolCalls:[{id:"c1",name:"read_file",arguments:'{"path":"a.txt"}'}]});
  await appendFile(store.pathFor("dup"),audit("tool/call",{arguments:'{"path":"a.txt"}'}),"utf8");
  await appendFile(store.pathFor("dup"),audit("tool/call",{arguments:'{"path":"a.txt"}'}),"utf8");

  await assert.rejects(
    ()=>store.pendingTools("dup"),
    (error:unknown)=>{
      assert.ok(error instanceof SessionCorruptionError);
      assert.match((error as Error).message,/duplicate tool call audit event/);
      assert.match((error as Error).message,/line 4/,"the second copy's line is named, not the first");
      return true;
    },
  );
  // A single audit record is still understood, and the message-only path stays legal.
  const single=new SessionStore({root:f.storeRoot});
  await single.create("single");
  await single.appendMessage("single",{role:"assistant",content:"",toolCalls:[{id:"c1",name:"read_file",arguments:"{}"}]});
  await appendFile(single.pathFor("single"),audit("tool/call",{arguments:"{}"}),"utf8");
  assert.equal((await single.pendingTools("single")).length,1,"one audit record still pairs normally");
  await single.recover("single");
  await single.assertReady("single");
});

it("flushes every append, and a failed flush is never reported as success",async()=>{
  const f=await createTestFixture("durability");

  // The seam exists so this claim is checked rather than asserted: count the
  // sync calls, then make one fail. A real power cut is not testable here, and
  // no test in this project claims to have performed one.
  class CountingStore extends SessionStore {
    syncs=0;failOnSync=-1;
    protected override async openAppend():Promise<{write(d:string):Promise<unknown>;sync():Promise<void>;close():Promise<void>}|undefined>{
      const store=this;
      return {
        async write(){},
        async sync(){ store.syncs+=1; if(store.syncs===store.failOnSync) throw new Error("injected flush failure"); },
        async close(){},
      };
    }
  }

  const store=new CountingStore({root:f.storeRoot});
  await store.create("s");
  await store.appendMessage("s",{role:"user",content:"a"});
  await store.appendMessage("s",{role:"user",content:"b"});
  // The header is created with `wx` (not an append), so exactly the two appends
  // flush — no extra flush hidden in creation, and none skipped.
  assert.equal(store.syncs,2,"one flush per append");

  store.failOnSync=3;
  await assert.rejects(()=>store.appendMessage("s",{role:"user",content:"c"}),/injected flush failure/);

  // Flush failure must not be swallowed, and the default mode must be flush.
  assert.equal(new SessionStore({root:f.storeRoot}).durability,"flush");
});

it("flushes by default and round-trips identically when relaxed",async()=>{
  const f=await createTestFixture("durability-modes");
  const flushed=new SessionStore({root:f.storeRoot});
  await flushed.create("flush");await flushed.appendMessage("flush",{role:"user",content:"hello"});
  const relaxed=new SessionStore({root:f.storeRoot,durability:"relaxed"});
  await relaxed.create("relaxed");await relaxed.appendMessage("relaxed",{role:"user",content:"hello"});

  function withoutVariableFields(lines:string){return lines.split("\n").filter(Boolean).map(l=>{const o=JSON.parse(l);delete o.at;delete o.createdAt;delete o.id;return o;});}
  assert.deepEqual(
    withoutVariableFields(await readFile(flushed.pathFor("flush"),"utf8")),
    withoutVariableFields(await readFile(relaxed.pathFor("relaxed"),"utf8")),
    "durability is a flushing decision, not a format difference",
  );
  assert.deepEqual(await flushed.history("flush"),await relaxed.history("relaxed"));
});

it("records one complete line per event, so the flush boundary is per event",async()=>{
  const f=await createTestFixture("durability-lines");const store=new SessionStore({root:f.storeRoot});
  await store.create("lines");
  for(let i=0;i<5;i+=1)await store.appendMessage("lines",{role:"user",content:`m${i}`});
  const text=await readFile(store.pathFor("lines"),"utf8");
  assert.equal(text.split("\n").filter(Boolean).length,6,"header plus five appends, one line each");
  assert.ok(text.endsWith("\n"),"every event ends on a line boundary; a half line would be a torn write");
  const {problems}=await store.inspect("lines");
  assert.deepEqual(problems,[]);
});

it("resume warns about an unfinished tool batch, and stops warning once it is repaired",async()=>{
  const f=await createTestFixture("resume-warn");const store=new SessionStore({root:f.home});await store.create("dangling");
  await store.appendMessage("dangling",{role:"assistant",content:"",toolCalls:[{id:"x",name:"read_file",arguments:"{}"}]});
  const inputs=["/resume dangling","/recover dangling","/resume dangling","/exit"];const output:string[]=[];
  const io:TerminalIO={interactive:true,async ask(){return inputs.shift()??null;},write(s){output.push(s);},onInterrupt(){return()=>{};},close(){}};
  assert.equal(await main(["--home",f.home,"--echo"],{},io),0);

  const text=output.join("");
  const warnings=text.split("未完成工具结果").length-1;
  // Warned while dangling, silent after repair — a permanent warning would train
  // the user to ignore it.
  assert.equal(warnings,1);
  assert.match(text,/有 1 个未完成工具结果/);
  assert.match(text,/\/recover/,"the warning must say how to fix it");
  assert.match(text,/不会自动重跑工具/);
  await store.assertReady("dangling");
});
it("interactive inspect/recover can repair a named interrupted session without switching",async()=>{
  const f=await createTestFixture("recovery-cli");const store=new SessionStore({root:f.home});await store.create("broken");
  await store.appendMessage("broken",{role:"assistant",content:"",toolCalls:[{id:"x",name:"read_file",arguments:"{}"}]});
  const inputs=["/inspect broken","/recover broken","/resume broken","/exit"];const output:string[]=[];
  const io:TerminalIO={interactive:true,async ask(){return inputs.shift()??null;},write(s){output.push(s);},onInterrupt(){return()=>{};},close(){}};
  assert.equal(await main(["--home",f.home,"--echo"],{},io),0);assert.match(output.join(""),/已追加补齐 1/);await store.assertReady("broken");
});
it("explicit recovery reuses saved result, marks unknown and never invokes tools",async()=>{
  const f=await createTestFixture("recover");const store=new SessionStore({root:f.storeRoot});await store.create("s");
  const calls=[{id:"a",name:"read_file",arguments:"{}"},{id:"b",name:"read_file",arguments:"{}"}];
  await store.appendMessage("s",{role:"assistant",content:"",toolCalls:calls});
  // A legacy log: the runtime no longer writes audit pairs, but old files still
  // carry one, and this is the case where the recorded result is the only
  // evidence that the call already ran. Written literally, as an old file would be.
  await appendFile(store.pathFor("s"),`${JSON.stringify({v:1,kind:"tool/result",ignorable:true,at:new Date().toISOString(),callId:"a",name:"read_file",content:"saved result",isError:false})}\n`,"utf8");
  const before=await readFile(store.pathFor("s"),"utf8");
  let requests=0;const adapter={...createEchoAdapter(),async chat(){requests++;throw new Error("must not run");}};
  const runtime=new AgentRuntime({adapter,store,sessionId:"s",home:f.home});
  await assert.rejects(()=>runtime.send("continue"),/recover/);assert.equal(requests,0);
  assert.equal(await store.recover("s"),2);assert.equal(await store.recover("s"),0);await store.assertReady("s");
  const history=await store.history("s");assert.equal(history[1]!.content,"saved result");assert.match(history[2]!.content,/outcome unknown/);
  assert.ok((await readFile(store.pathFor("s"),"utf8")).startsWith(before));
});
