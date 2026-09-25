import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { writeFile, mkdir, symlink, readFile, link } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createTestFixture } from "./fixtures.ts";
import type { TestFixture } from "./fixtures.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";
import { assertSafeStateDirectory, canonicalPath, resolveRuntimePaths } from "../src/security-config.ts";
import { ToolRegistry, createReadFileTool, requireToolEnvironment } from "../src/tools.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { main } from "../src/cli.ts";

let f: TestFixture;
before(async () => { f = await createTestFixture("security"); });
const call = (p: string) => ({ id: "read1", name: "read_file", arguments: JSON.stringify({ path: p }) });

describe("PR1 security boundaries", () => {
  it("allowlists environment without mutating or copying secrets", () => {
    const base = { ...process.env, DSH_HOME: path.join(f.root, "host"), TEST_SECRET: "SYNTHETIC",
      PERSONAL_AGENT_API_KEY: "SYNTHETIC", NODE_OPTIONS: "--inspect", HOME_EXTRA: "SYNTHETIC" };
    const result = buildToolEnvironment({ workspaceRoot: f.workspaceRoot, agentHome: f.home, base });
    for (const name of ["DSH_HOME", "TEST_SECRET", "PERSONAL_AGENT_API_KEY", "NODE_OPTIONS", "HOME_EXTRA"]) assert.equal(result.env[name], undefined);
    assert.equal(base.TEST_SECRET, "SYNTHETIC");
    assert.equal(result.env.HOME, canonicalPath(f.home));
    assert.ok(Object.isFrozen(result.env));
  });
  it("rejects forged tool environment objects", () => {
    assert.throws(() => requireToolEnvironment({ workspaceRoot: f.workspaceRoot, toolEnvironment: { cwd: f.workspaceRoot, env: {} } }));
  });
  it("requires scratch to be strictly under home", () => {
    for (const tempRoot of [f.home, f.workspaceRoot]) assert.throws(() => resolveRuntimePaths({ agentHome: f.home, workspaceRoot: f.workspaceRoot, tempRoot }));
  });
  it("protects host and backup roots and rejects their ancestors", () => {
    const protectedRoot = path.join(f.root, "backup");
    assert.throws(() => assertSafeStateDirectory(path.join(protectedRoot, "nested"), { protectedRoots: [protectedRoot] }));
    assert.throws(() => assertSafeStateDirectory(f.root, { protectedRoots: [protectedRoot] }));
  });
  it("rejects protected CLI home before creating any files", async () => {
    const blocked = path.join(f.root, "protected-state");
    await assert.rejects(() => main(["--home", blocked, "hello"], { PERSONAL_AGENT_PROTECTED_ROOTS: JSON.stringify([blocked]) }));
    assert.equal(existsSync(blocked), false);
  });
  it("protects store independently from runtime home", () => {
    const blocked = path.join(f.root, "protected-store");
    assert.throws(() => new AgentRuntime({ adapter: createScriptedAdapter({steps:[]}),
      store: new SessionStore({root:blocked}), sessionId:"s", home:f.home, protectedRoots:[blocked] }));
    assert.equal(existsSync(blocked), false);
  });
  it("resolves existing link ancestors for missing state leaves", async context => {
    const target = path.join(f.root, "link-target"); await mkdir(target);
    const link = path.join(f.root, "link-alias");
    try { await symlink(target, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM","EACCES","ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip("link creation unavailable"); return; } throw error; }
    assert.throws(() => assertSafeStateDirectory(path.join(link,"missing","home"), {protectedRoots:[target]}));
    assert.equal(existsSync(path.join(target,"missing")),false);
  });
  it("denies sensitive files without returning their content", async () => {
    const registry = new ToolRegistry([createReadFileTool()]);
    for (const name of [".env", ".env.local", "credentials.json", "private.key"]) {
      await writeFile(path.join(f.workspaceRoot,name),"SYNTHETIC_SECRET");
      const result = await registry.execute(call(name), {workspaceRoot:f.workspaceRoot});
      assert.equal(result.isError,true); assert.doesNotMatch(result.content,/SYNTHETIC_SECRET/);
    }
    await writeFile(path.join(f.workspaceRoot,"public.txt"),"public");
    assert.equal((await registry.execute(call("public.txt"),{workspaceRoot:f.workspaceRoot})).content,"public");
  });
  it("denies credentials even when their ancestor is selected as workspace", async () => {
    const sensitive = path.join(f.workspaceRoot,".aws","sso","cache");
    await mkdir(sensitive,{recursive:true});await writeFile(path.join(sensitive,"hash.json"),"SYNTHETIC_TOKEN");
    const result=await new ToolRegistry([createReadFileTool()]).execute(call("hash.json"),{workspaceRoot:sensitive});
    assert.equal(result.isError,true);assert.doesNotMatch(result.content,/SYNTHETIC_TOKEN/);
  });
  it("rejects configuration directory junctions leaving home", async context => {
    const home=path.join(f.root,"config-home"),outside=path.join(f.root,"outside-config");
    await mkdir(home);await mkdir(outside);
    try { await symlink(outside,path.join(home,"config"),process.platform==="win32"?"junction":"dir"); }
    catch(error){if(["EPERM","EACCES","ENOSYS"].includes((error as NodeJS.ErrnoException).code??"")){context.skip("link unavailable");return;}throw error;}
    assert.throws(()=>buildToolEnvironment({agentHome:home,workspaceRoot:f.workspaceRoot}));
  });
  it("refuses hard-linked session leaves before read or append", async context => {
    const source=path.join(f.root,"protected-log.jsonl");const contents=JSON.stringify({v:1,kind:"session",id:"linked",createdAt:"t"})+"\n";
    await writeFile(source,contents);
    const store=new SessionStore({root:f.storeRoot});
    try { await link(source,path.join(f.storeRoot,"linked.jsonl")); }
    catch(error){if(["EPERM","EACCES","ENOTSUP"].includes((error as NodeJS.ErrnoException).code??"")){context.skip("hard link unavailable");return;}throw error;}
    await assert.rejects(()=>store.history("linked"));await assert.rejects(()=>store.appendMessage("linked",{role:"user",content:"must not append"}));
    assert.equal(await readFile(source,"utf8"),contents);
  });
  it("denies innocent-named hardlinks to sensitive content", async () => {
    const source=path.join(f.workspaceRoot,".env.linked"),alias=path.join(f.workspaceRoot,"innocent.txt");
    await writeFile(source,"HARDLINK_SECRET");await link(source,alias);
    const result=await new ToolRegistry([createReadFileTool()]).execute(call("innocent.txt"),{workspaceRoot:f.workspaceRoot});
    assert.equal(result.isError,true);assert.doesNotMatch(result.content,/HARDLINK_SECRET/);
  });
  it("does not invoke a side-effect executor even if registered", async () => {
    let executions = 0;
    const registry = new ToolRegistry([{ name:"writer", description:"synthetic", parameters:{type:"object"}, readOnly:false,
      async execute(){executions++;return {content:"unexpected"};} }]);
    const result = await registry.execute({id:"w",name:"writer",arguments:"{}"},{workspaceRoot:f.workspaceRoot});
    assert.equal(executions,0);assert.equal(result.isError,true);
  });
  it("secret bytes never reach the next provider request or persisted tool result", async () => {
    await writeFile(path.join(f.workspaceRoot,".env.secret"),"SYNTHETIC_NEVER_EXFILTRATE");
    const adapter = createScriptedAdapter({steps:[{toolCalls:[call(".env.secret")]},{content:"read denied"}]});
    const store = new SessionStore({root:f.storeRoot});
    const runtime = new AgentRuntime({adapter,store,sessionId:"secret",home:f.home,workspaceRoot:f.workspaceRoot,tools:new ToolRegistry([createReadFileTool()])});
    await runtime.send("Inspect a file");
    assert.doesNotMatch(JSON.stringify(adapter.requests),/SYNTHETIC_NEVER_EXFILTRATE/);
    assert.doesNotMatch(await readFile(store.pathFor("secret"),"utf8"),/SYNTHETIC_NEVER_EXFILTRATE/);
  });
  it("denies runtime state even when inside selected workspace with ordinary names", async () => {
    const localHome = path.join(f.workspaceRoot,"state");
    await mkdir(localHome);await writeFile(path.join(localHome,"note.txt"),"PRIVATE_HISTORY");
    const adapter = createScriptedAdapter({steps:[{toolCalls:[call("state/note.txt")]},{content:"denied"}]});
    const runtime = new AgentRuntime({adapter,store:new SessionStore({root:localHome}),sessionId:"state",home:localHome,
      workspaceRoot:f.workspaceRoot,tools:new ToolRegistry([createReadFileTool()])});
    await runtime.send("read state");assert.doesNotMatch(JSON.stringify(adapter.requests),/PRIVATE_HISTORY/);
  });
});
