/**
 * The test harness's own contract.
 *
 * These pin the reporting behaviour the helper promises: a server that recorded an
 * error is reported by the file that owns it, and every server is closed regardless.
 * They are *not* the fix for the project's intermittent failure — that was a
 * wall-clock comparison in `streaming.test.ts` — and the earlier theory that a late
 * server error escaped into an unrelated test was probed and disproven (see the note
 * in `server-fixture.ts`).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { closeAllServers, startTestServer } from "./server-fixture.ts";
import type { TestServer } from "./server-fixture.ts";

const servers: TestServer[] = [];

after(async () => {
  await closeAllServers(servers);
});

describe("test server harness", () => {
  it("serves on a loopback port and closes without recording an error", async () => {
    const started = await startTestServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    servers.push(started);
    assert.ok(started.port > 0);
    const answered = await fetch(`http://127.0.0.1:${started.port}/probe`);
    assert.equal(await answered.text(), "ok");
    // Keep-alive sockets must not be able to stall teardown; closing twice would
    // throw, so the single close here is itself the assertion that it completes.
    await started.close();
    assert.deepEqual(started.errors, []);
  });

  it("never hands out a port that fetch refuses to reach", async () => {
    // fetch rejects the WHATWG bad-port list (1719-1723, 2049, 6000, 6666 …) before any
    // I/O. Windows' ephemeral allocator passes through those bands, so a plain
    // `listen(0)` would occasionally produce a server nothing can connect to — which is
    // exactly what made an intermittent test failure look mysterious. Every port this
    // helper returns must therefore be reachable, and this asserts it by using it.
    const blocked = new Set([1719, 1720, 1721, 1722, 1723, 2049, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
    for (let i = 0; i < 12; i += 1) {
      const started = await startTestServer((_request, response) => response.end("reachable"));
      servers.push(started);
      assert.equal(blocked.has(started.port), false, `port ${started.port} is blocked for fetch`);
      const answered = await fetch(`http://127.0.0.1:${started.port}/reachable`);
      assert.equal(await answered.text(), "reachable", `port ${started.port} must actually be usable`);
    }
  });

  it("reports a recorded server error instead of letting it escape", async () => {
    // A synthetic server stands in for the hard-to-provoke cases (an accept failure
    // under load, an error during close): the contract is the same either way.
    const fake: TestServer = { port: 1, errors: ["test server error: synthetic accept failure"], close: async () => {} };
    await assert.rejects(() => closeAllServers([fake]), /reported 1 error\(s\): test server error: synthetic accept failure/);
  });

  it("closes every server it is given, even when one of them recorded an error", async () => {
    const closed: string[] = [];
    const make = (name: string, errors: string[]): TestServer => ({
      port: 1, errors, close: async () => { closed.push(name); },
    });
    await assert.rejects(() => closeAllServers([make("a", []), make("b", ["boom"]), make("c", [])]));
    assert.deepEqual(closed, ["a", "b", "c"], "no server is skipped because an earlier one failed");
  });
});
