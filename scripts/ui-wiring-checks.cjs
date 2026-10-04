// Shares the existing loopback-only Electron fixture; never touches a real user profile.
const assert = require('node:assert/strict');
module.exports = async function checkWiring({ evaluate, until, cdp, alphaId }) {
  async function menuItem(text) {
    const literal = JSON.stringify(text);
    await until(`Array.from(document.querySelectorAll('#menu .menu-item')).some(b=>b.textContent.includes(${literal}))`);
    await evaluate(`Array.from(document.querySelectorAll('#menu .menu-item')).find(b=>b.textContent.includes(${literal})).click()`);
  }
  const before = await evaluate(`personalAgentDesktop.listChats()`);
  assert.equal(before.sessions.length, 3);
  assert.equal(before.activeSessionId, alphaId);
  assert.ok(before.sessions.every(s=>s.indexed===true));
  // Search must use real titles and open actual message history, not an empty example view.
  await evaluate(`document.querySelector('#btnTaskSearch').click()`);
  await until(`document.querySelectorAll('#tsList .ts-row').length===3`);
  await evaluate(`document.querySelector('#tsInput').value='ALPHA';document.querySelector('#tsInput').dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(`document.querySelectorAll('#tsList .ts-row').length===1`);
  await evaluate(`document.querySelector('#tsList .ts-row').click()`);
  await until(`document.querySelector('#liveChatList').textContent.includes('resume ALPHA')&&!document.querySelector('#btnNew').disabled`);
  // Filtering must not wipe the real list by rendering the old empty GROUPS fixture.
  await evaluate(`document.querySelector('#btnFilter').click()`); await menuItem('失败');
  await until(`document.querySelectorAll('#taskGroups .session-row').length===1`);
  assert.ok(await evaluate(`document.querySelector('#taskGroups .session-row').textContent.includes('fresh BETA')`));
  await evaluate(`document.querySelector('#btnFilter').click()`); await menuItem('全部');
  await until(`document.querySelectorAll('#taskGroups .session-row').length===3`);
  assert.ok(await evaluate(`document.querySelector('[data-session="${alphaId}"]').classList.contains('is-on')`), 'filter refresh preserves active session');
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:']',code:'BracketRight',modifiers:2});
  await until(`document.querySelector('#taskGroups .session-row.is-on')?.dataset.session!==${JSON.stringify(alphaId)}&&!document.querySelector('#btnNew').disabled`);
  await evaluate(`document.querySelector('#btnChatHistory').click()`);
  await until(`document.querySelector('#searchScrim').classList.contains('is-on')`);
  await evaluate(`document.querySelector('#tsInput').value='ALPHA';document.querySelector('#tsInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#tsList .ts-row').click()`);
  await until(`document.querySelector('#liveChatList').textContent.includes('resume ALPHA')&&!document.querySelector('#btnNew').disabled`);
  const copy = await cdp('Runtime.evaluate',{expression:`document.querySelector('#btnCopyConversation').click()`,userGesture:true,returnByValue:true});
  assert.ok(!copy.exceptionDetails);
  await until(`document.querySelector('#toast').textContent.includes('已复制')`);
  await evaluate(`document.querySelector('#taChat').value='';document.querySelector('#taChat').focus();personalAgentDesktop.desktopAction('paste')`);
  await until(`document.querySelector('#taChat').value.includes('resume ALPHA')`);
  await evaluate(`document.querySelector('#taChat').value=''`);
  // Navigation entry points reach the same real tools.
  await evaluate(`document.querySelector('[data-nav="project"]').click()`);
  await until(`!document.querySelector('.workspace-panel').hidden&&!!document.querySelector('.workspace-start')`);
  await evaluate(`document.querySelector('#navMore').click();document.querySelector('[data-sub="files"]').click()`);
  await until(`document.querySelectorAll('.workspace-file').length>0`);
  await evaluate(`document.querySelector('#workspaceToggle').click()`);
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:'P',code:'KeyP',modifiers:10});
  await until(`document.querySelector('#scrim').classList.contains('is-on')`);
  await evaluate(`Array.from(document.querySelectorAll('.pal-item')).find(b=>b.textContent.includes('终端')).click()`);
  await until(`!document.querySelector('.workspace-panel').hidden&&!!document.querySelector('input[aria-label="终端命令"]')`);
  await evaluate(`document.querySelector('#workspaceToggle').click()`);
  // Undo/select/copy etc. are a finite trusted-shell API, not arbitrary WebContents methods.
  assert.equal((await evaluate(`personalAgentDesktop.desktopAction('selectAll')`)).ok,true);
  assert.equal(await evaluate(`personalAgentDesktop.desktopAction('executeJavaScript').then(()=>false,()=>true)`),true);
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:',',code:'Comma',modifiers:2});
  await until(`document.querySelector('#setScrim').classList.contains('is-on')&&!!document.querySelector('#compactToggle')`);
  async function setting(label, value) {
    await evaluate(`Array.from(Array.from(document.querySelectorAll('#setBody .set-row')).find(r=>r.querySelector('.set-row-t').textContent===${JSON.stringify(label)}).querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(value)}).click()`);
  }
  await setting('主题','深色'); await setting('字体大小','大'); await setting('发送消息','Ctrl+Enter');
  await evaluate(`document.querySelector('#compactToggle').click()`);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('#setBody .set-row')).find(r=>r.querySelector('.set-row-t').textContent==='网络代理').querySelector('button').disabled`),'unimplemented preferences cannot pretend to save');
  await evaluate(`location.hash='';window.__uiBeforeReload=true`);
  await cdp('Page.reload'); await until(`!window.__uiBeforeReload&&!!document.querySelector('#workspaceToggle')`);
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('personal-agent.ui.v1'))`),{version:1,theme:'dark',font:1,send:'Ctrl+Enter',compact:true});
  assert.equal(await evaluate(`document.documentElement.getAttribute('data-theme')`),'dark');
  assert.equal(await evaluate(`document.documentElement.style.getPropertyValue('--fs-base')`),'14px');
  assert.ok(await evaluate(`document.documentElement.classList.contains('ui-compact')`));
  // Empty input exercises shortcut cancellation without spending tokens or creating a session.
  const keys = await evaluate(`(()=>{const t=document.querySelector('#taHome');t.value='';return [{},{ctrlKey:true},{ctrlKey:true,shiftKey:true},{ctrlKey:true,isComposing:true}].map(o=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...o});t.dispatchEvent(e);return e.defaultPrevented;});})()`);
  assert.deepEqual(keys,[false,true,false,false],'Ctrl+Enter preference, newline and IME composition respected');
  await cdp('Input.dispatchKeyEvent', {type:'keyDown',key:',',code:'Comma',modifiers:2});
  await until(`!!document.querySelector('#compactToggle')`);
  await setting('主题','浅色'); await setting('字体大小','默认'); await setting('发送消息','Enter');
  await evaluate(`document.querySelector('#compactToggle').click();document.querySelector('#setClose').click()`);
  await evaluate(`location.hash='menu-help'`);
  await until(`document.querySelector('#menu').classList.contains('is-on')`);
  await menuItem('诊断工具');
  await until(`!!document.querySelector('#setBody pre')`);
  const info = JSON.parse(await evaluate(`document.querySelector('#setBody pre').textContent`));
  assert.ok(info.appVersion&&info.electron); assert.equal(info.contextIsolated,true); assert.equal(info.sandboxed,true);
  await evaluate(`document.querySelector('#setClose').click();location.hash='';localStorage.setItem('personal-agent.ui.v1',JSON.stringify({version:1,theme:'<script>',font:200,send:'bad',compact:'true',secret:'not-a-preference'}));window.__uiBeforeReload=true`);
  await cdp('Page.reload'); await until(`!window.__uiBeforeReload&&!!document.querySelector('#workspaceToggle')`);
  assert.equal(await evaluate(`document.documentElement.getAttribute('data-theme')`),'light');
  assert.equal(await evaluate(`document.documentElement.style.getPropertyValue('--fs-base')`),'13px');
  assert.equal(await evaluate(`document.documentElement.classList.contains('ui-compact')`),false);
  console.log('PASS UI wiring: real search/filter/history, navigation/tools, edit allowlist, persisted/validated preferences, send shortcuts, actual diagnostics, honest unimplemented settings');
};
