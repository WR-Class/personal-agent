import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { launchOptions } = require('../desktop/launch.cjs');

test('desktop launcher uses explicit runtime, absolute app path and isolated child environment', () => {
  const executable = path.resolve('runtime with spaces/electron.exe');
  const env = { PERSONAL_AGENT_ELECTRON: executable, ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', KEEP: 'yes' };
  const config = launchOptions(env, ['--remote-debugging-port=9223']);
  assert.equal(config.executable, executable);
  assert.ok(path.isAbsolute(config.args[0]));
  assert.equal(config.args[1], '--remote-debugging-port=9223');
  assert.equal(config.options.cwd, config.args[0]);
  assert.equal(config.options.shell, false);
  assert.equal(config.options.stdio, 'inherit');
  assert.equal(config.options.env.KEEP, 'yes');
  assert.equal(config.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(config.options.env.electron_run_as_node, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(!config.args.includes('--no-sandbox'));
  assert.throws(() => launchOptions({ PERSONAL_AGENT_ELECTRON: 'relative.exe' }, []), /absolute/);
});

test('desktop launcher defaults to installed Electron', () => {
  assert.equal(launchOptions({}, []).executable, require('electron'));
});

test('desktop launcher reports spawn errors, exceptions, nonzero and signal exits', () => {
  const source = readFileSync(new URL('../desktop/launch.cjs', import.meta.url), 'utf8');
  for (const outcome of ['error', 'throw', 'nonzero', 'signal', 'zero']) {
    const child = new EventEmitter();
    const mod = { exports: {} };
    const proc = { env: { PERSONAL_AGENT_ELECTRON: path.resolve('fake-electron.exe') }, argv: ['node', 'launcher'], exitCode: undefined as number | undefined };
    const errors: string[] = [];
    const fakeRequire = Object.assign((name: string) => {
      if (name === 'node:path') return path;
      if (name === 'node:child_process') return { spawn: () => {
        if (outcome === 'throw') throw new Error('spawn failed');
        return child;
      } };
      throw new Error('Explicit runtime must not load Electron installer');
    }, { main: mod });
    runInNewContext(source, { require: fakeRequire, module: mod, __dirname: path.resolve('desktop'), process: proc, console: { error: (...args: unknown[]) => errors.push(args.join(' ')) } });
    if (outcome === 'error') child.emit('error', new Error('not found'));
    if (outcome === 'nonzero') child.emit('exit', 7, null);
    if (outcome === 'signal') child.emit('exit', null, 'SIGTERM');
    if (outcome === 'zero') child.emit('exit', 0, null);
    assert.equal(proc.exitCode, outcome === 'zero' ? 0 : 1, outcome);
    assert.equal(errors.length, outcome === 'zero' ? 0 : 1, outcome);
  }
});

test('desktop retains prototype entries, own branding and sandbox', () => {
  const html = readFileSync(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const base = readFileSync(new URL('../docs/panel-prototype/index.html', import.meta.url), 'utf8');
  const entries = (s: string) => [...s.matchAll(/data-(?:nav|sub|pane|scene)="[^"]+"/g)].map(m => m[0]).sort();
  assert.deepEqual(entries(html), entries(base));
  assert.match(html, /<title>Personal Agent — Agent 客户端<\/title>/);
  assert.match(html, /class="tb-mark">PA</);
  assert.doesNotMatch(html, /WorkBuddy|>WB</);
  assert.match(js, /用户提供的 WorkBuddy 原型/);
  assert.ok((js.match(/未接线/g) || []).length >= 33);
  assert.match(main, /sandbox: true/);
  assert.match(main, /contextIsolation: true, nodeIntegration: false/);
});
