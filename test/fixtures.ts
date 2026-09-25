import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeStateDirectory } from "../src/security-config.ts";

const testRunsRoot = fileURLToPath(new URL("../.test-artifacts/", import.meta.url));

export interface TestFixture {
  root: string;
  storeRoot: string;
  home: string;
  workspaceRoot: string;
}

/** Unique, owned test artifacts are retained for inspection, never cleaned up. */
export async function createTestFixture(label: string): Promise<TestFixture> {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("invalid test fixture label");
  const safeBase = assertSafeStateDirectory(testRunsRoot);
  await mkdir(safeBase, { recursive: true });
  const root = await mkdtemp(join(safeBase, `${label}-`));
  await writeFile(join(root, ".fixture-owner.json"), `${JSON.stringify({
    owner: "personal-agent-tests",
    label,
    createdAt: new Date().toISOString(),
    retained: true,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fixture = {
    root,
    storeRoot: join(root, "store"),
    home: join(root, "home"),
    workspaceRoot: join(root, "workspace"),
  };
  for (const directory of [fixture.storeRoot, fixture.home, fixture.workspaceRoot]) {
    await mkdir(directory);
  }
  return fixture;
}
