// Start start:desktop with --remote-debugging-port=9224 before running this check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const pages = await (await fetch('http://127.0.0.1:9224/json/list')).json();
  const page = pages.find(p => p.type === 'page' && p.url.endsWith('/desktop/renderer/index.html'));
  assert.ok(page, 'Personal Agent desktop page must be running');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  async function call(method, params = {}) {
    const key = ++id;
    let timer;
    try {
      const m = await Promise.race([new Promise(resolve => { pending.set(key, resolve); ws.send(JSON.stringify({ id: key, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(method + ' timed out')), 10000); })]);
      assert.ok(!m.error, JSON.stringify(m.error)); return m.result;
    } finally { clearTimeout(timer); pending.delete(key); }
  }
  async function evaluate(expression) {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value;
  }
  const out = path.resolve(__dirname, '../docs/panel-prototype/acceptance');
  fs.mkdirSync(out, { recursive: true });
  async function screenshot(name) {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  try {
    await call('Page.reload');
    await evaluate(`new Promise(resolve=>{if(document.readyState==='complete')resolve();else addEventListener('load',resolve,{once:true});})`);
    const backgrounds = await evaluate(`Array.from(document.querySelectorAll('dialog'),d=>getComputedStyle(d).backgroundColor)`);
    assert.equal(backgrounds.length, 3);
    assert.ok(backgrounds.every(c=>c.startsWith('rgb(')), 'dialogs must have opaque backgrounds: ' + backgrounds);
    const entries = await evaluate(`({ nav:Array.from(document.querySelectorAll('.nav-item'),e=>e.dataset.nav), sub:Array.from(document.querySelectorAll('.nav-sub-item'),e=>e.dataset.sub), panes:Array.from(document.querySelectorAll('.pane'),e=>e.dataset.pane), node:typeof require })`);
    assert.deepEqual(entries.nav, ['assistant','project','expert','automation','more']);
    assert.deepEqual(entries.sub, ['skills','connector','apps','docs','files','mail','ima','lexiang']);
    assert.deepEqual(entries.panes, ['browser','art','file','term']);
    assert.equal(entries.node, 'undefined');
    for (const width of [1440, 800]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.querySelector('#openEcho').click()`);
      await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      const bounds = await evaluate(`(()=>{const d=document.querySelector('#echoDialog'),r=d.getBoundingClientRect();return {open:d.open,left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
      assert.ok(bounds.open && bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, JSON.stringify(bounds));
      await screenshot('echo-' + width);
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate(`document.querySelector('#echoDialog').open`), false, 'Escape closes dialog');
    }
    console.log('PASS: prototype navigation/panes, renderer isolation, 1440/800 dialog bounds, Escape');
  } finally { await call('Emulation.clearDeviceMetricsOverride'); ws.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
