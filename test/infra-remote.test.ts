import { test } from 'node:test';
import assertNode from 'node:assert/strict';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function setupHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'infra-home-'));
  const cfg = path.join(home, 'infra-hosts.json');
  writeFileSync(cfg, JSON.stringify({ hosts: { example: { user: 'alice', host: 'ex.example.com', port: 2200, key: 'example.pem' } } }));
  const keys = path.join(home, 'infra-keys');
  mkdirSync(keys, { recursive: true });
  writeFileSync(path.join(keys, 'example.pem'), '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n');
  return home;
}

const ctx: { workspaceRoot: string } = { workspaceRoot: process.cwd() };

test('infra tiers are present, separated from default tiers, and rule-shaped correctly', async () => {
  const { findTier } = await import('../src/tiers.ts');
  const defaults = ['read-only', 'ask-before-writing', 'workspace-write', 'full-access'];
  for (const name of defaults) {
    const t = findTier(name);
    assertNode.ok(t, `default tier ${name} missing`);
    assertNode.ok(!t!.tools.includes('read_remote'), `${name} must not expose read_remote`);
    assertNode.ok(!t!.tools.includes('run_remote'), `${name} must not expose run_remote`);
  }
  const read = findTier('infra-read');
  assertNode.ok(read);
  assertNode.ok(read!.tools.includes('read_remote'));
  assertNode.ok(!read!.tools.includes('run_remote'), 'infra-read must not expose run_remote');
  const write = findTier('infra-write');
  assertNode.ok(write);
  assertNode.ok(write!.tools.includes('read_remote'));
  assertNode.ok(write!.tools.includes('run_remote'));
  const readRules = read!.rules.filter(r => r.tool === 'read_remote');
  assertNode.ok(readRules.some(r => r.decision === 'allow'));
  const writeRules = write!.rules.filter(r => r.tool === 'run_remote');
  assertNode.ok(writeRules.some(r => r.decision === 'approve'));
});

test('read_remote refuses hosts not in infra-hosts.json', async () => {
  const home = setupHome();
  try {
    const { createReadRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createReadRemoteTool(() => home);
    const result = await tool.execute({ host: 'unknown', path: '/etc/hostname' }, ctx);
    assertNode.equal(result.isError, true);
    assertNode.match(result.content, /not in infra-hosts\.json/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('read_remote rejects relative paths on the remote host', async () => {
  const home = setupHome();
  try {
    const { createReadRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createReadRemoteTool(() => home);
    const result = await tool.execute({ host: 'example', path: 'etc/hostname' }, ctx);
    assertNode.equal(result.isError, true);
    assertNode.match(result.content, /absolute/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('read_remote refuses a key path that escapes infra-keys/', async () => {
  const home = setupHome();
  try {
    const cfg = path.join(home, 'infra-hosts.json');
    writeFileSync(cfg, JSON.stringify({ hosts: { bad: { user: 'alice', host: 'b.example.com', key: '../../etc/passwd' } } }));
    const { createReadRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createReadRemoteTool(() => home);
    const result = await tool.execute({ host: 'bad', path: '/etc/hostname' }, ctx);
    assertNode.equal(result.isError, true);
    assertNode.match(result.content, /infra-hosts\.json/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('read_remote rejects host names that are not safe', async () => {
  const home = setupHome();
  try {
    const cfg = path.join(home, 'infra-hosts.json');
    writeFileSync(cfg, JSON.stringify({ hosts: { 'bad host!': { user: 'alice', host: 'x.example.com', key: 'x.pem' } } }));
    const { createReadRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createReadRemoteTool(() => home);
    const result = await tool.execute({ host: 'bad host!', path: '/etc/hostname' }, ctx);
    assertNode.equal(result.isError, true);
    assertNode.match(result.content, /infra-hosts\.json/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run_remote dry_run=true prints the ssh invocation without running', async () => {
  const home = setupHome();
  try {
    const { createRunRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createRunRemoteTool(() => home);
    const result = await tool.execute({ host: 'example', command: 'uptime', dry_run: true }, ctx);
    assertNode.equal(result.isError, undefined);
    assertNode.match(result.content, /dry-run/);
    assertNode.match(result.content, /alice@ex\.example\.com/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run_remote dry_run defaults to true when the argument is omitted', async () => {
  const home = setupHome();
  try {
    const { createRunRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createRunRemoteTool(() => home);
    const result = await tool.execute({ host: 'example', command: 'whoami' }, ctx);
    assertNode.equal(result.isError, undefined);
    assertNode.match(result.content, /dry-run/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run_remote dry_run=false without context.approve is denied by approval channel', async () => {
  const home = setupHome();
  try {
    const { createRunRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createRunRemoteTool(() => home);
    const result = await tool.execute({ host: 'example', command: 'whoami', dry_run: false }, ctx);
    assertNode.equal(result.isError, true);
    assertNode.match(result.content, /approval channel/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run_remote operator declined after approval', async () => {
  const home = setupHome();
  try {
    const { createRunRemoteTool } = await import('../src/infra-remote.ts');
    const tool = createRunRemoteTool(() => home);
    const result = await tool.execute(
      { host: 'example', command: 'whoami', dry_run: false },
      { ...ctx, approve: async () => false, audit: async () => {} },
    );
    assertNode.equal(result.isError, true);
    assertNode.match(result.content, /operator declined/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('buildSshArgv: user@entry.host, -i/-p/-- order, known_hosts only when set', async () => {
  const { buildSshArgv } = await import('../src/infra-remote.ts');
  const e = { user: 'alice', host: 'real.example.com', port: 2200, key: 'k.pem' };
  const a = buildSshArgv('/usr/bin/ssh', e, '/k', 'whoami');
  assertNode.equal(a[1], 'alice@real.example.com', 'argv[1] must be user@entry.host');
  assertNode.notEqual(a[1], 'alice@example', 'must not be user@<alias>');
  assertNode.equal(a[a.indexOf('-i') + 1], '/k');
  assertNode.equal(a[a.indexOf('-p') + 1], '2200');
  assertNode.equal(a[a.indexOf('--') + 1], 'whoami');
  assertNode.ok(buildSshArgv('/usr/bin/ssh', e, '/k', 'c', { knownHostsFile: '/kh' }).includes('UserKnownHostsFile=/kh'));
  assertNode.ok(!buildSshArgv('/usr/bin/ssh', e, '/k', 'c').some(x => x.startsWith('UserKnownHostsFile=')));
});