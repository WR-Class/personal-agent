/**
 * Live-integration readiness (`--preflight`).
 *
 * The claims worth testing are the negative ones: the check must **not** print a
 * credential, must **not** send one to the endpoint, must **not** read a response
 * body, and must **not** report "ready" when the provider configuration is
 * incomplete. A readiness check that cannot fail is decoration.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatPreflight, preflight } from "../src/preflight.ts";
import { parseArgs, main } from "../src/cli.ts";
import { createTestFixture } from "./fixtures.ts";

const fixture = await createTestFixture("preflight");
const servers: Server[] = [];

after(async () => {
  for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
});

async function serve(handler: (url: string, headers: Record<string, unknown>) => { status: number; body?: string }) {
  const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    const outcome = handler(request.url ?? "", request.headers);
    response.writeHead(outcome.status, { "content-type": "application/json" });
    response.end(outcome.body ?? "{}");
  });
  // Named, not left to an unhandled 'error' event: a refused bind would otherwise
  // be attributed to whichever test happened to be running.
  await new Promise<void>((ready, fail) => {
    server.once("error", (error) => fail(new Error(`test server could not bind a loopback port: ${(error as Error).message}`)));
    server.listen(0, "127.0.0.1", () => ready());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen };
}

const SECRET = "PREFLIGHT-KEY-DO-NOT-PRINT-7731";

function base(env: NodeJS.ProcessEnv, overrides: Partial<Parameters<typeof preflight>[0]> = {}) {
  return preflight({ env, stdinIsTTY: false, stdoutIsTTY: false, ...overrides });
}

function check(report: Awaited<ReturnType<typeof preflight>>, name: string) {
  const found = report.checks.find((entry) => entry.name === name);
  assert.ok(found, `expected a check named ${name}`);
  return found;
}

describe("preflight readiness check", () => {
  it("probes a real endpoint without sending the key, and treats 401 as reachable", async () => {
    const { baseUrl, seen } = await serve(() => ({ status: 401, body: `{"error":"unauthorized"}` }));
    const report = await base({
      PERSONAL_AGENT_BASE_URL: baseUrl,
      PERSONAL_AGENT_MODEL: "live-model",
      PERSONAL_AGENT_API_KEY: SECRET,
    });

    assert.equal(report.canAttemptLiveRun, true);
    assert.equal(check(report, "服务可达性").status, "ok");
    assert.match(check(report, "服务可达性").detail, /HTTP 401/);

    assert.equal(seen.length, 1, "exactly one probe request");
    assert.equal(seen[0]!.url, "/v1/models");
    // The whole point: no credential leaves the process during a readiness check.
    assert.equal(seen[0]!.headers.authorization, undefined);
    assert.ok(!JSON.stringify(seen[0]!.headers).includes(SECRET));
  });

  it("never prints the key, its length, or a fragment of it", async () => {
    const { baseUrl } = await serve(() => ({ status: 404 }));
    const report = await base({
      PERSONAL_AGENT_BASE_URL: baseUrl,
      PERSONAL_AGENT_MODEL: "live-model",
      PERSONAL_AGENT_API_KEY: SECRET,
    });
    const text = formatPreflight(report);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes(SECRET.slice(0, 8)), "not even a prefix");
    assert.ok(!text.includes(String(SECRET.length)), "nor its length");
    assert.match(text, /密钥存在/);
  });

  it("refuses to call a partial provider configuration ready", async () => {
    const { baseUrl, seen } = await serve(() => ({ status: 200 }));
    const report = await base({ PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "m" });
    assert.equal(report.canAttemptLiveRun, false, "baseUrl+model without a key is not a usable configuration");
    assert.equal(check(report, "Provider 配置").status, "fail");
    // Reachability is independent of the credential, and the probe sends none, so
    // it still runs: that separates "the endpoint is down" from "the key is
    // missing" instead of collapsing both into one unconfirmed verdict.
    assert.equal(check(report, "服务可达性").status, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.headers.authorization, undefined);
  });

  it("reports a missing configuration as unconfirmed rather than ready", async () => {
    const report = await base({});
    assert.equal(report.canAttemptLiveRun, false);
    assert.equal(check(report, "Provider 配置").status, "skipped");
    assert.equal(check(report, "服务可达性").status, "skipped");
    assert.equal(check(report, "本机 tokenizer").status, "skipped");
    assert.match(formatPreflight(report), /\*\*不能\*\*/);
  });

  it("reports an unreachable endpoint as a failure with its error class only", async () => {
    // Port 1 on loopback: connection refused, no server. The detail must name the
    // error class, not any response content (there is none).
    const report = await base({ PERSONAL_AGENT_BASE_URL: "http://127.0.0.1:1/v1", PERSONAL_AGENT_MODEL: "m", PERSONAL_AGENT_API_KEY: "k" });
    assert.equal(check(report, "服务可达性").status, "fail");
    assert.match(check(report, "服务可达性").detail, /只报错误类别/);
  });

  it("actually runs the tokenizer command and rejects a bad one", async () => {
    const good = join(fixture.root, "preflight-tok.mjs");
    await writeFile(good, 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d.length));\n', "utf8");
    const ok = await base({ PERSONAL_AGENT_TOKENIZER: `node "${good}"` });
    assert.equal(check(ok, "本机 tokenizer").status, "ok");
    assert.match(check(ok, "本机 tokenizer").detail, /返回 \d+/);

    const bad = join(fixture.root, "preflight-tok-bad.mjs");
    await writeFile(bad, 'console.log("about four tokens");\n', "utf8");
    const badReport = await base({ PERSONAL_AGENT_TOKENIZER: `node "${bad}"` });
    assert.equal(check(badReport, "本机 tokenizer").status, "fail");
    assert.match(check(badReport, "本机 tokenizer").detail, /不是一个非负整数/);
  });

  it("does not call a live run attemptable when the tokenizer command is broken", async () => {
    // A configured-but-unrunnable tokenizer makes every send fail, so "ready"
    // would be a lie. (Found by smoke: the first version reported exit 0 here.)
    const { baseUrl } = await serve(() => ({ status: 200 }));
    const report = await base({
      PERSONAL_AGENT_BASE_URL: baseUrl,
      PERSONAL_AGENT_MODEL: "m",
      PERSONAL_AGENT_API_KEY: "k",
      PERSONAL_AGENT_TOKENIZER: "definitely-not-a-real-command-xyz",
    });
    assert.equal(check(report, "本机 tokenizer").status, "fail");
    assert.equal(report.tokenizerFailed, true);
    assert.equal(report.canAttemptLiveRun, false);
    assert.match(formatPreflight(report), /tokenizer 命令无法运行/);
  });

  it("never prints undecodable command output as mojibake", async () => {
    // Windows cmd.exe writes its own errors in the console code page; decoding
    // those bytes as UTF-8 produces U+FFFD. Reporting that as if it were our text
    // looks like corruption, so the excerpt is declined instead.
    const report = await base({ PERSONAL_AGENT_TOKENIZER: "definitely-not-a-real-command-xyz" });
    const detail = check(report, "本机 tokenizer").detail;
    assert.ok(!detail.includes("\uFFFD"), "no replacement characters in the report");
    // Whatever the platform produced, the check still names the exit code.
    assert.match(detail, /退出码 \d+/);
  });

  it("reports terminal capability as an observation, not an assumption", async () => {
    const notTTY = await base({});
    assert.equal(notTTY.canRunInteractively, false);
    assert.equal(check(notTTY, "终端").status, "warn");
    assert.match(check(notTTY, "终端").detail, /不是 TTY/);

    const tty = await base({}, { stdinIsTTY: true, stdoutIsTTY: true, columns: 120, rows: 30 });
    assert.equal(tty.canRunInteractively, true);
    assert.equal(check(tty, "终端").status, "ok");
    assert.match(check(tty, "终端").detail, /120x30/);
  });

  it("is a usable gate: exit 3 without a live configuration, 0 with one", async () => {
    const writes: string[] = [];
    const io = {
      write: (text: string) => { writes.push(text); },
      ask: async () => null,
      onInterrupt: () => () => {},
      close: () => {},
      interactive: false,
      hidden: () => {},
    } as never;

    assert.equal(await main(["--preflight"], {}, io), 3, "no provider configuration is not ready");
    assert.match(writes.join(""), /联调准备检查/);

    const { baseUrl } = await serve(() => ({ status: 200 }));
    writes.length = 0;
    const code = await main(
      ["--preflight"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "m", PERSONAL_AGENT_API_KEY: SECRET },
      io,
    );
    assert.equal(code, 0);
    assert.ok(!writes.join("").includes(SECRET));

    // The flag is mutually exclusive with the modes it would otherwise disturb.
    assert.throws(() => parseArgs(["--preflight", "hi"], {}), /不能与 prompt/);
    assert.throws(() => parseArgs(["--preflight", "--list"], {}), /不能与 prompt、--list 或 --echo 混用/);
    assert.throws(() => parseArgs(["--preflight", "--echo"], {}), /不能与 prompt、--list 或 --echo 混用/);
  });
});
