import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreTools } from '../src/core-tools.ts';
import { createDesktopTools } from '../src/desktop-tools.ts';
import { SessionStore } from '../src/session-store.ts';
import { resolveTier } from '../src/tiers.ts';
import { join } from 'node:path';

test('CLI and desktop derive the same core factory catalog for every tier', () => {
  const session = { store: new SessionStore({ root: join(process.cwd(), '.test-artifacts', 'catalog') }), id: 'catalog' };
  for (const [permission, name] of [['read', 'read-only'], ['write', 'workspace-write'], ['full', 'full-access']] as const) {
    const tier = resolveTier(name);
    const core = createCoreTools(tier.tools, session);
    const desktop = createDesktopTools({ workspaceRoot: process.cwd(), permission, check() {}, approve: async () => false }, session);
    assert.deepEqual(core.map(t => t.name), tier.tools);
    assert.deepEqual(desktop.tools.definitions().filter(t => t.name !== 'list_directory'), core.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
  }
  assert.throws(() => createCoreTools(['not_registered'], session), /no core factory/);
  assert.throws(() => createCoreTools(['update_task_state']), /trusted session/);
});
