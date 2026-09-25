/**
 * Tests for the two isolation guarantees that came out of the 2026-09-24
 * accident, where a tool ran `Remove-Item $home -Recurse -Force` and `$home`
 * resolved to the operator's profile directory.
 *
 *   (1) a tool never inherits the operator's home, temp, or config locations
 *   (2) an agent home that overlaps the operator's is refused before anything runs
 */

import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import {
  MissingToolEnvironmentError,
  ToolRegistry,
  requireToolEnvironment,
} from "../src/tools.ts";
import type { Tool, ToolContext } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { UsageError, main, parseArgs } from "../src/cli.ts";
import {
  UnsafeAgentHomeError,
  agentHomeProblem,
  buildToolEnvironment,
} from "../src/tool-environment.ts";
import { createTestFixture } from "./fixtures.ts";

const windows = process.platform === "win32";
const root = parse(process.cwd()).root; // "C:\" on Windows, "/" elsewhere
const operatorHome = join(root, "Users", "tester");

/**
 * A synthetic operator environment, so these assertions do not depend on the
 * machine running them. Deliberately shaped like a real Windows profile.
 */
const fakeEnv: NodeJS.ProcessEnv = {
  USERPROFILE: operatorHome,
  SystemRoot: join(root, "Windows"),
  ProgramFiles: join(root, "Program Files"),
  ProgramData: join(root, "ProgramData"),
  LOCALAPPDATA: join(operatorHome, "AppData", "Local"),
  APPDATA: join(operatorHome, "AppData", "Roaming"),
  PATH: join(root, "bin"),
};

// Project-local marked fixtures avoid host temp/AppData and are retained.
let scratchRoot = "";
let storeRoot = "";
let agentHome = "";
let workspaceRoot = "";

before(async () => {
  const fixture = await createTestFixture("tool-environment");
  scratchRoot = fixture.root;
  storeRoot = fixture.storeRoot;
  agentHome = fixture.home;
  workspaceRoot = fixture.workspaceRoot;
  await writeFile(join(workspaceRoot, "note.txt"), "hello", "utf8");
});

describe("agent home safety", () => {
  it("accepts a dedicated directory", () => {
    assert.equal(agentHomeProblem(join(root, "agents", "khd"), { env: fakeEnv, operatorHome }), null);
  });

  it("accepts a directory inside the operator's home but not AppData", () => {
    // The rule is equality, not containment: an agent may keep its home beside
    // the operator's files as long as it is not the operator's home itself.
    assert.equal(agentHomeProblem(join(operatorHome, ".personal-agent"), { env: fakeEnv, operatorHome }), null);
  });

  it("refuses the operator's own home", () => {
    const problem = agentHomeProblem(operatorHome, { env: fakeEnv, operatorHome });
    assert.ok(problem);
    assert.match(problem, /operator's home directory/);
  });

  it("refuses the operator's home written with a trailing separator", () => {
    assert.ok(agentHomeProblem(`${operatorHome}\\`, { env: fakeEnv, operatorHome }));
  });

  it("refuses a filesystem root", () => {
    const problem = agentHomeProblem(root, { env: fakeEnv, operatorHome });
    assert.ok(problem);
    assert.match(problem, /filesystem root/);
  });

  it("refuses an ancestor of the operator's home", () => {
    // Deleting an ancestor takes the operator's home with it, so this is worse
    // than equality and must not slip through for being a different string.
    const problem = agentHomeProblem(join(root, "Users"), { env: fakeEnv, operatorHome });
    assert.ok(problem);
    assert.match(problem, /contains the operator's home directory/);
  });

  it("refuses AppData", { skip: !windows }, () => {
    const problem = agentHomeProblem(join(operatorHome, "AppData", "Local", "agent"), {
      env: fakeEnv,
      operatorHome,
    });
    assert.ok(problem);
    assert.match(problem, /protected|AppData/);
  });

  it("refuses a Windows system directory", { skip: !windows }, () => {
    const problem = agentHomeProblem(join(root, "Windows", "System32"), { env: fakeEnv, operatorHome });
    assert.ok(problem);
    assert.match(problem, /protected|system directory/);
  });

  it("falls back to USERPROFILE when no operator home is passed", () => {
    assert.ok(agentHomeProblem(operatorHome, { env: fakeEnv }));
  });
});

describe("rebuilding the tool environment", () => {
  const options = () => ({
    workspaceRoot,
    agentHome,
    base: { ...fakeEnv, PERSONAL_AGENT_HOME: "should-not-leak" },
    operatorHome,
  });

  it("repoints HOME and USERPROFILE at the agent's own home", () => {
    const { env } = buildToolEnvironment(options());
    assert.equal(env.HOME, resolve(agentHome));
    assert.equal(env.USERPROFILE, resolve(agentHome));
    assert.notEqual(env.USERPROFILE, fakeEnv.USERPROFILE);
  });

  it("repoints every temp variable into the agent's home", () => {
    const { env } = buildToolEnvironment(options());
    const expected = join(resolve(agentHome), "tmp");
    assert.equal(env.TMP, expected);
    assert.equal(env.TEMP, expected);
    assert.equal(env.TMPDIR, expected);
  });

  it("repoints the per-user config locations too", () => {
    // Otherwise a tool that writes to %APPDATA% still lands in the operator's
    // roaming profile, which is the same class of bug as HOME.
    const { env } = buildToolEnvironment(options());
    assert.equal(env.APPDATA, join(resolve(agentHome), "AppData", "Roaming"));
    assert.equal(env.LOCALAPPDATA, join(resolve(agentHome), "AppData", "Local"));
    assert.equal(env.XDG_CONFIG_HOME, join(resolve(agentHome), "config"));
  });

  it("uses the workspace root as the working directory", () => {
    const { cwd } = buildToolEnvironment(options());
    assert.equal(cwd, resolve(workspaceRoot));
  });

  it("keeps PATH, drops arbitrary variables and secrets, and does not mutate the base", () => {
    const base = { ...fakeEnv, TEST: "arbitrary", PERSONAL_AGENT_API_KEY: "secret", PERSONAL_AGENT_HOME: "private" };
    const original = { ...base };
    const { env } = buildToolEnvironment({ ...options(), base });
    assert.equal(env.PATH, fakeEnv.PATH);
    assert.equal(env.TEST, undefined);
    assert.equal(env.PERSONAL_AGENT_API_KEY, undefined);
    assert.equal(env.PERSONAL_AGENT_HOME, undefined);
    assert.deepEqual(base, original, "the caller's environment must be left alone");
  });

  it("refuses an unsafe explicit temp root", () => {
    assert.throws(
      () => buildToolEnvironment({ ...options(), tempRoot: operatorHome }),
      UnsafeAgentHomeError,
    );
  });

  it("refuses protected roots without placing its home inside one", () => {
    const protectedRoot = join(scratchRoot, "mock-protected");
    const check = { env: fakeEnv, operatorHome, protectedRoots: [protectedRoot] };
    assert.equal(agentHomeProblem(agentHome, check), null);
    assert.ok(agentHomeProblem(join(protectedRoot, "child"), check));
    assert.throws(
      () => buildToolEnvironment({ ...options(), tempRoot: protectedRoot, protectedRoots: [protectedRoot] }),
      UnsafeAgentHomeError,
    );
  });

  it("refuses to build an environment for the operator's home", () => {
    // The rewrite would be a no-op, so failing closed is the only safe answer.
    assert.throws(
      () => buildToolEnvironment({ ...options(), agentHome: operatorHome }),
      UnsafeAgentHomeError,
    );
  });
});

describe("the runtime hands tools a rebuilt environment", () => {
  function spyRuntime(sessionId: string, seen: ToolContext[]) {
    const spy: Tool = {
      name: "spy",
      description: "records the context it was given",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      async execute(_args, context) {
        seen.push(context);
        return { content: "recorded" };
      },
    };
    return new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [{ toolCalls: [{ id: "c1", name: "spy", arguments: "{}" }] }, { content: "done" }],
      }),
      store: new SessionStore({ root: storeRoot }),
      sessionId,
      workspaceRoot,
      home: agentHome,
      tools: new ToolRegistry([spy]),
    });
  }

  it("passes the agent's home, not the operator's", async () => {
    const seen: ToolContext[] = [];
    await spyRuntime("env-passed", seen).send("go");

    assert.equal(seen.length, 1);
    const environment = requireToolEnvironment(seen[0]!);
    assert.equal(environment.env.HOME, resolve(agentHome));
    assert.equal(environment.env.USERPROFILE, resolve(agentHome));
    assert.notEqual(environment.env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(environment.cwd, resolve(workspaceRoot));
  });

  it("creates the scratch directory before the first tool runs", async () => {
    const seen: ToolContext[] = [];
    await spyRuntime("env-scratch", seen).send("go");

    const scratch = requireToolEnvironment(seen[0]!).env.TEMP;
    assert.equal((await stat(scratch!)).isDirectory(), true);
  });

  it("refuses at construction when the home is the operator's", () => {
    assert.throws(
      () =>
        new AgentRuntime({
          adapter: createScriptedAdapter({ steps: [{ content: "x" }] }),
          store: new SessionStore({ root: storeRoot }),
          sessionId: "unsafe",
          workspaceRoot,
          home: process.env.USERPROFILE ?? process.env.HOME ?? operatorHome,
        }),
      UnsafeAgentHomeError,
    );
  });

  it("refuses to invent an environment when the caller supplied none", () => {
    // A silent fallback to process.env here would reinstate the original bug.
    assert.throws(() => requireToolEnvironment({ workspaceRoot }), MissingToolEnvironmentError);
  });
});

describe("the CLI refuses an unsafe home (exit 2)", () => {
  it("rejects --home pointing at the operator's home", () => {
    assert.throws(() => parseArgs(["--home", operatorHome, "hi"], fakeEnv), UsageError);
  });

  it("rejects PERSONAL_AGENT_HOME pointing at the operator's home", () => {
    assert.throws(
      () => parseArgs(["hi"], { ...fakeEnv, PERSONAL_AGENT_HOME: operatorHome }),
      UsageError,
    );
  });

  it("rejects a drive root supplied as --home", () => {
    assert.throws(() => parseArgs(["--home", root, "hi"], fakeEnv), UsageError);
  });

  it("still parses a dedicated home", () => {
    const options = parseArgs(["--home", join(root, "agents", "khd"), "hi"], fakeEnv);
    assert.equal(options.home, join(root, "agents", "khd"));
    assert.equal(options.prompt, "hi");
  });

  it("does not create the directory it refuses", { skip: !windows }, async () => {
    const refused = join(fakeEnv.LOCALAPPDATA!, "personal-agent-refused");
    await assert.rejects(() => main(["--home", refused, "hi"], fakeEnv), UsageError);
    assert.equal(existsSync(refused), false, "the refusal must happen before mkdir");
  });

  it("runs normally on a safe home and records the turn", async () => {
    const home = join(scratchRoot, "cli-home");
    const code = await main(["--home", home, "--workspace", workspaceRoot, "--echo", "hello"], fakeEnv);
    assert.equal(code, 0);
    assert.equal(existsSync(join(home, "default.jsonl")), true);
  });
});
