import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
test('unwired usage is not overwritten by prototype timers', () => {
  const js = readFileSync(path.join(desktop, 'renderer/app.js'), 'utf8');
  const html = readFileSync(path.join(desktop, 'renderer/index.html'), 'utf8');
  assert.doesNotMatch(js, /Math\.random|sbTokens.*textContent\s*=/);
  assert.match(html, /id="sbTokens"[^>]*>用量未接线/);
  assert.doesNotMatch(html, />已连接<|>3 个连接器<|剩余 1,284 积分/);
});
test('desktop info and window actions share fail-closed sender validation', async () => {
  const handlers = new Map<string, Function>();
  const windows: any[] = [];
  class Window {
    webContents: any;
    constructor() {
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(desktop, 'renderer/index.html')).href }, setWindowOpenHandler() {}, on() {} };
      windows.push(this);
    }
    static fromWebContents(sender: any) { return windows.find(w => w.webContents === sender); }
    once() {} on() {} loadFile() { return Promise.resolve(); }
    minimize() {} isMaximized() { return false; }
  }
  const electron = {
    app: { getVersion: () => '0.1.0', whenReady: () => Promise.resolve(), on() {} },
    BrowserWindow: Window, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} } },
  };
  let now = 1000, sends = 0;
  const previews: Array<(v: any) => void> = [];
  const modelModule = {
    desktopProvider: () => new Promise(resolve => previews.push(resolve)),
    desktopModelSend: async () => { sends++; return { content: 'ok' }; },
  };
  // Isolate IPC lifecycle from IO; desktop-model.test.ts covers real HTTP/storage.
  const source = readFileSync(path.join(desktop, 'main.cjs'), 'utf8').replaceAll("import('../src/desktop-model.ts')", 'Promise.resolve(modelModule)');
  runInNewContext(source, {
    modelModule, Date: { now: () => now },
    require: (name: string) => name === 'electron' ? electron : name === 'node:path' ? path : { pathToFileURL },
    __dirname: desktop, process: { env: {}, versions: { electron: '44.5.1', chrome: 'test-chrome', node: 'test-node' }, platform: 'win32' }, console,
  });
  await Promise.resolve();
  const sender = windows[0].webContents;
  const valid = { sender, senderFrame: sender.mainFrame };
  const info = handlers.get('desktop:info')!;
  assert.deepEqual(JSON.parse(JSON.stringify(info(valid))), { appVersion: '0.1.0', electron: '44.5.1', chrome: 'test-chrome', node: 'test-node', platform: 'win32', agentConnected: false });
  for (const fn of handlers.values()) {
    for (const event of [{ sender, senderFrame: null }, { sender, senderFrame: { ...sender.mainFrame } }, { sender: {}, senderFrame: sender.mainFrame }]) {
      await assert.rejects(async () => fn(event, 'min'), /Untrusted desktop sender/);
    }
    const url = sender.mainFrame.url;
    sender.mainFrame.url = 'https://example.com/';
    await assert.rejects(async () => fn(valid, 'min'), /Untrusted desktop sender/);
    sender.mainFrame.url = url + '#settings';
    if (fn === handlers.get('desktop:info') || fn === handlers.get('window:action')) await assert.doesNotReject(async () => fn(valid, 'min'));
    sender.mainFrame.url = url;
  }
  const preview = handlers.get('runtime:provider')!, send = handlers.get('runtime:model')!;
  const settle = async (p: Promise<any>) => { await Promise.resolve(); previews.shift()!({ baseUrl: 'https://example.test/v1', model: 'test' }); return p; };
  await assert.rejects(send(valid, 'hi'), /重新查看/);
  const first = await settle(preview(valid));
  await assert.rejects(send(valid, 'hi', first.token + 1), /重新查看/);
  now += 300001;
  await assert.rejects(send(valid, 'hi', first.token), /重新查看/);
  const second = await settle(preview(valid));
  await send(valid, 'hi', second.token);
  await assert.rejects(send(valid, 'hi', second.token), /重新查看/);
  assert.equal(sends, 1);
  const older = preview(valid), newer = preview(valid);
  const stale = assert.rejects(older, /配置不可用/);
  await Promise.resolve();
  previews.pop()!({ baseUrl: 'https://new.test', model: 'new' });
  const newest = await newer;
  previews.shift()!({ baseUrl: 'https://old.test', model: 'old' });
  await stale;
  await send(valid, 'hi', newest.token);
  assert.equal(sends, 2);
});

test('preload exposes bounded metadata and reports actual renderer isolation', async () => {
  for (const enabled of [true, false]) {
    let api: any;
    const calls: unknown[][] = [];
    runInNewContext(readFileSync(path.join(desktop, 'preload.cjs'), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: any) => { api = value; } }, ipcRenderer: {
        invoke: async (...args: unknown[]) => { calls.push(args); return { appVersion: '0.1.0' }; },
      } }),
      process: { platform: 'win32', sandboxed: enabled, contextIsolated: enabled },
    });
    const info = await api.getInfo('ignored');
    assert.equal(info.sandboxed, enabled);
    assert.equal(info.contextIsolated, enabled);
    assert.deepEqual(calls, [['desktop:info']]);
    await api.listSessions('ignored-path');
    assert.deepEqual(calls[1], ['sessions:list']);
    await api.readHistory('demo', 'ignored-path');
    assert.deepEqual(calls[2], ['sessions:history', 'demo']);
    await api.sendEcho('hello', 'ignored-path');
    assert.deepEqual(calls[3], ['runtime:echo', 'hello']);
    await assert.rejects(api.getProvider('ignored'), /Invalid model selection/);
    await api.getProvider();
    await api.sendModel('hello', 123, 'ignored');
    assert.deepEqual(calls[4], ['runtime:provider']);
    assert.deepEqual(calls[5], ['runtime:model', 'hello', 123]);
    await api.getProvider({ id: 'test', model: 'one', path: 'ignored' });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[6])), ['runtime:provider', { id: 'test', model: 'one' }]);
    await api.providerSettings('list');
    assert.equal(calls[7]![0], 'providers:settings');
    assert.deepEqual(Object.keys(api).sort(), ['getInfo', 'getProvider', 'listSessions', 'onMaximized', 'platform', 'providerSettings', 'readHistory', 'sendEcho', 'sendModel', 'windowAction']);
  }
});
