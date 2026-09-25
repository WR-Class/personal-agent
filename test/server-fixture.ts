/**
 * Shared loopback test server.
 *
 * This replaced three near-identical copies, one per test file. What it buys:
 *
 * - `close()` calls `closeAllConnections()`, so fetch's keep-alive sockets cannot hold
 *   teardown open (a real way for a test file to stall or leave the runner hanging).
 * - The bind is retried when Windows hands out an already-taken ephemeral port, and the
 *   attempt count is reported instead of a bare errno.
 * - Server errors are *recorded*, and `closeAllServers` reports them from the file's
 *   `after` hook, so an error belongs to the file that owns the server.
 *
 * A hypothesis this file used to assert — that the project's two unreproduced test
 * failures came from a late server error escaping as an uncaught exception, because the
 * old code attached its handler with `once` — was **tested and disproven**: a probe that
 * emits an error on a successfully-bound server using that old pattern shows the error
 * being absorbed (2 tests, 2 pass, 0 fail), not escaping. The real cause of the
 * reproducible failure turned out to be an exact-output comparison in `streaming.test.ts`
 * that included the wall-clock `用时` field. This helper is hardening and deduplication,
 * not that fix; it is not offered as an explanation for any past failure.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface TestServer {
  /** Bound loopback port; compose the URL the caller needs (`.../v1` or bare). */
  port: number;
  /**
   * Errors the server emitted after the bind succeeded. Recorded, never thrown, so a
   * late error cannot be misattributed; `closeAllServers` fails the owning file.
   */
  readonly errors: string[];
  close(): Promise<void>;
}

const BIND_ATTEMPTS = 20;

/**
 * Ports `fetch` refuses to connect to, from the WHATWG bad-port list that undici
 * enforces *before* any I/O. A test server bound to one of these is unreachable no
 * matter how correct the code under test is, and the failure arrives instantly as
 * `TypeError: fetch failed` with `cause: bad port` — which is why it looked like an
 * unexplained intermittent failure rather than a port-allocation accident.
 *
 * Measured on this machine: Windows hands out ephemeral ports from roughly 1026–15000
 * and passes straight through the blocked bands at 1719–1723 and 2049, so about
 * 0.13% of binds land on a blocked port — in *bursts*, because consecutive draws are
 * consecutive ports. That burst behaviour is what made several tests fail at once.
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Start a real HTTP server on an ephemeral loopback port fetch can actually reach. */
export async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const errors: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const server = createServer(handler);
    let rejectBind: ((error: Error) => void) | undefined;
    // Persistent on purpose: `once` would be consumed by the first error and let every
    // later one escape as an uncaught exception.
    server.on("error", (error) => {
      const message = `test server error: ${(error as Error).message}`;
      errors.push(message);
      rejectBind?.(new Error(message));
    });
    try {
      await new Promise<void>((ready, reject) => {
        rejectBind = reject;
        server.listen(0, "127.0.0.1", () => { rejectBind = undefined; ready(); });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A refused bind needs no cleanup: a server that never listened holds no handle.
      if (attempt < BIND_ATTEMPTS && message.includes("EADDRINUSE")) continue;
      throw new Error(`test server could not bind a loopback port after ${attempt} attempt(s): ${message}`);
    }
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server exposed no port");
    if (FETCH_BLOCKED_PORTS.has(address.port)) {
      // Hand this port back and draw another: the test has no opinion about which port
      // it gets, and a blocked one would fail it for a reason it cannot express.
      await new Promise<void>((done) => server.close(() => done()));
      if (attempt < BIND_ATTEMPTS) continue;
      throw new Error(
        `test server drew fetch-blocked ports ${BIND_ATTEMPTS} times in a row (last ${address.port}); `
        + "fetch cannot connect to those ports at all",
      );
    }
    return {
      port: address.port,
      errors,
      async close() {
        // Keep-alive sockets (fetch keeps them) would otherwise hold `close()` open.
        await new Promise<void>((done) => server.close(() => done()));
        server.closeAllConnections();
      },
    };
  }
}

/**
 * Close every server and surface anything they recorded. Throwing here fails this
 * file's `after` hook with the real cause, which is the whole point: the error is
 * attributed to the file that owns the server rather than to a random test.
 */
export async function closeAllServers(servers: TestServer[]): Promise<void> {
  const recorded: string[] = [];
  for (const server of servers) {
    await server.close();
    recorded.push(...server.errors);
  }
  if (recorded.length > 0) {
    throw new Error(`test server(s) reported ${recorded.length} error(s): ${recorded.join("; ")}`);
  }
}
