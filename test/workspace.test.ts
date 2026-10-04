import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installWorkspace, safeRelative, sensitiveName, resolveWorkspacePath, safeURL, safeBounds, shellEnvironment } = require('../desktop/workspace.cjs');

test('relative path policy denies traversal, absolute paths, streams and sensitive files', () => {
  assert.deepEqual(safeRelative('src/main.ts'), ['src', 'main.ts']);
  assert.deepEqual(safeRelative('.'), []);
  for (const name of ['../a', 'x/../a', '..\\a', '/etc/passwd', 'C:\\secret', 'C:secret', '\\\\server\\share', 'a:stream', 'a\0b', 'x/.. /a', '.env', '.env.local', 'x/.ssh/config', 'x/id_ed25519', 'x/key.pem', 'secrets.json', 'api-key.json', 'x/NUL.txt']) {
    assert.throws(() => safeRelative(name), name);
  }
  assert.equal(sensitiveName('environment.ts'), false);
  assert.equal(sensitiveName('.ENV.production'), true);
});

test('HTTP URL policy rejects credentials, local schemes and ambiguous syntax', () => {
  assert.equal(safeURL('https://example.com/a?q=1#b'), 'https://example.com/a?q=1#b');
  for (const url of ['file:///C:/x', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', '//example.com', 'https://u:p@example.com', 'https://u@example.com', 'https://example.com\\@evil.test', ' https://example.com', 'http:\n//example.com', 'https://']) {
    assert.throws(() => safeURL(url), url);
  }
});

test('bounds and shell environment are strict allowlists', () => {
  assert.deepEqual(safeBounds({ x: 0, y: 10, width: 100, height: 90, visible: true }, [100, 100]), { x: 0, y: 10, width: 100, height: 90, visible: true });
  for (const values of [{ x: -1 }, { width: 101 }, { height: 0 }, { x: 0.5 }, { visible: 'true' }]) {
    assert.throws(() => safeBounds({ x: 0, y: 0, width: 100, height: 100, visible: true, ...values }, [100, 100]));
  }
  assert.deepEqual(shellEnvironment({ PATH: '/bin', HOME: '/home/test', OPENAI_API_KEY: 'secret', ODD_PROVIDER_AUTH: 'secret', NODE_OPTIONS: '--require=evil', BASH_ENV: '/evil', ENV: '/evil' }), { PATH: '/bin', HOME: '/home/test' });
});

test('real paths reject junction escape and same-root links', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  try {
    const root = path.join(fixture, 'root'); const outside = path.join(fixture, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(path.join(root, 'normal'));
    fs.writeFileSync(path.join(root, 'normal', 'ok.txt'), 'hello');
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(root, 'normal'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = fs.realpathSync(root);
    assert.equal(resolveWorkspacePath(canonical, 'normal/ok.txt'), path.join(canonical, 'normal', 'ok.txt'));
    assert.throws(() => resolveWorkspacePath(canonical, 'escape'));
    assert.throws(() => resolveWorkspacePath(canonical, 'alias/ok.txt'));
    assert.throws(() => resolveWorkspacePath(null, 'normal'));
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

function harness(root: string) {
  let handler: any;
  const confirms: any[] = []; const views: any[] = []; const sessions: any[] = [];
  const makeWindow = () => {
    const win: any = new EventEmitter(); win.webContents = new EventEmitter();
    win.webContents.send = (channel: string, payload: any) => { if (channel === 'workspace:confirm') confirms.push(payload); };
    win.isDestroyed = () => false; win.getContentSize = () => [800, 600];
    win.contentView = { addChildView() {}, removeChildView() {} }; return win;
  };
  const win = makeWindow(); const second = makeWindow();
  class View {
    webContents: any; visible = false; bounds: any; options: any;
    constructor(options: any) {
      this.options = options; this.webContents = new EventEmitter(); const wc = this.webContents;
      wc.setWindowOpenHandler = (fn: any) => { wc.open = fn; }; wc.isDestroyed = () => false;
      wc.close = () => { wc.closed = true; }; wc.loadURL = async (url: string) => { wc.url = url; };
      wc.getURL = () => wc.url; wc.reload = () => {}; wc.navigationHistory = { canGoBack: () => false };
      views.push(this);
    }
    setVisible(visible: boolean) { this.visible = visible; }
    setBounds(bounds: any) { this.bounds = bounds; }
  }
  const roots: string[] = [];
  const workspaceApi = installWorkspace({ onRootChosen: async (root: string) => { roots.push(root); }, ipcMain: { handle(channel: string, fn: any) { assert.equal(channel, 'workspace:action'); handler = fn; } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
    WebContentsView: View, session: { fromPartition(partition: string) {
      const ses: any = new EventEmitter(); ses.partition = partition;
      ses.setPermissionRequestHandler = (fn: any) => { ses.permission = fn; };
      ses.setPermissionCheckHandler = (fn: any) => { ses.check = fn; };
      ses.setDevicePermissionHandler = (fn: any) => { ses.device = fn; };
      ses.webRequest = { onBeforeRequest(fn: any) { ses.request = fn; } }; sessions.push(ses); return ses;
    } }, trustedWindow: (event: any) => { if (event?.win !== win && event?.win !== second) throw new Error('untrusted'); return event.win; } });
  const call = (action: string, payload?: any, window = win) => handler({ win: window }, action, payload);
  const answer = (ok: boolean) => call('confirm-response', { id: confirms.at(-1).id, ok });
  return { win, second, confirms, views, sessions, roots, workspaceApi, answer, call };
}

test('IPC verifies sender, isolates state, confirms permissions, bounds file previews', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-ipc-'));
  try {
    fs.writeFileSync(path.join(fixture, 'hello.txt'), 'hello');
    fs.writeFileSync(path.join(fixture, '.env'), 'hidden');
    fs.writeFileSync(path.join(fixture, 'large.txt'), 'a'.repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(fixture, 'binary.bin'), Buffer.from([0, 1, 2]));
    const h = harness(fixture);
    assert.equal((await h.call('state', {}, {} as any)).ok, false);
    assert.deepEqual((await h.call('state')).data, { root: null, permission: 'read' });
    assert.equal((await h.call('terminal', { command: 'echo no' })).ok, false);
    assert.equal((await h.call('choose')).data.root, fs.realpathSync(fixture));
    assert.equal((await h.call('state', {}, h.second)).data.root, null);
    let granting = h.call('permission', { permission: 'full' });
    assert.equal(h.confirms.length, 1, 'permission escalation must ask through the in-app dialog');
    await h.answer(false);
    assert.equal((await granting).ok, false);
    granting = h.call('permission', { permission: 'full' });
    await h.answer(true);
    assert.equal((await granting).data.permission, 'full');
    assert.match(h.confirms[0].message, /当前用户权限.*工作区外/); assert.match(h.confirms[0].detail, /模型仍无工具/);
    assert.equal((await h.call('read', { relative: 'hello.txt' })).data.content, 'hello');
    const large = (await h.call('read', { relative: 'large.txt' })).data;
    assert.equal(large.content.length, 256 * 1024); assert.equal(large.truncated, true);
    assert.equal((await h.call('read', { relative: 'binary.bin' })).ok, false);
    assert.equal((await h.call('read', { relative: '.env' })).ok, false);
    const listing = (await h.call('files', { relative: '' })).data;
    assert.equal(listing.entries.some((entry: any) => entry.name === '.env'), false);
    assert.equal(typeof listing.entries[0].directory, 'boolean');
    for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(fixture, `item-${i}`), '');
    const bounded = (await h.call('files')).data; assert.equal(bounded.entries.length, 500); assert.equal(bounded.truncated, true);
    assert.equal((await h.call('choose')).data.permission, 'read');
    assert.ok(h.roots.includes(fs.realpathSync(fixture)), 'native picker persists canonical root through host callback');
    const grant = h.call('permission', { permission: 'full' }); await h.answer(true); await grant;
    assert.equal(h.workspaceApi.adoptRoot(h.win, fixture).permission, 'read');
    assert.deepEqual(h.workspaceApi.adoptRoot(h.win, null), { root: null, permission: 'read' });
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('confirmed terminal runs one shell command with bounded output and no inherited provider environment', async () => {
  const h = harness(os.tmpdir());
  await h.call('choose');
  const grant = h.call('permission', { permission: 'full' }); await h.answer(true); await grant;
  process.env.WORKSPACE_TEST_SECRET = 'must-not-inherit';
  try {
    const command = process.platform === 'win32' ? 'if ($env:WORKSPACE_TEST_SECRET) { exit 9 }; Write-Output workspace-ok; exit 0' : 'test -z "$WORKSPACE_TEST_SECRET" || exit 9; printf workspace-ok';
    const running = h.call('terminal', { command }); await h.answer(true);
    const answer = await running;
    assert.equal(answer.ok, true); assert.equal(answer.data.code, 0); assert.match(answer.data.output, /workspace-ok/);
    assert.match(h.confirms.at(-1).detail, /workspace-ok/);
    const largeRunning = h.call('terminal', { command: process.platform === 'win32' ? "Write-Output ('x' * 140000)" : "head -c 140000 /dev/zero | tr '\\0' x" });
    await h.answer(true);
    const large = await largeRunning;
    assert.equal(large.ok, true); assert.equal(large.data.truncated, true);
    assert.ok(Buffer.byteLength(large.data.output) <= 128 * 1024);
  } finally { delete process.env.WORKSPACE_TEST_SECRET; }
});

test('browser uses ephemeral isolated session, denies unsafe navigation, hides on shell reload and closes', async () => {
  const h = harness(os.tmpdir());
  assert.equal((await h.call('browser-bounds', { visible: false })).ok, true);
  assert.equal((await h.call('browser-open', { url: 'file:///secret' })).ok, false);
  assert.equal((await h.call('browser-open', { url: 'https://example.com' })).ok, true);
  const view = h.views[0]; const ses = h.sessions[0];
  assert.equal(ses.partition.startsWith('persist:'), false);
  assert.equal(view.options.webPreferences.preload, undefined);
  assert.equal(view.options.webPreferences.nodeIntegration, false); assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(ses.check(), false); assert.equal(ses.device(), false);
  assert.deepEqual(view.webContents.open(), { action: 'deny' });
  for (const details of [{ url: 'https://example.com', resourceType: 'subFrame' }, { url: 'file:///secret', resourceType: 'mainFrame' }]) {
    ses.request(details, (answer: any) => assert.equal(answer.cancel, true));
  }
  ses.request({ url: 'https://example.com', resourceType: 'mainFrame' }, (answer: any) => assert.equal(answer.cancel, false));
  let prevented = false;
  view.webContents.emit('will-frame-navigate', { isMainFrame: false, url: 'https://example.com', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal((await h.call('browser-bounds', { x: 0, y: 0, width: 801, height: 600, visible: true })).ok, false);
  assert.equal((await h.call('browser-bounds', { x: 0, y: 0, width: 800, height: 600, visible: true })).ok, true);
  h.win.webContents.emit('did-start-navigation', {}, 'file:///shell', false, true); assert.equal(view.visible, false);
  h.win.emit('closed'); assert.equal(view.webContents.closed, true);
});
