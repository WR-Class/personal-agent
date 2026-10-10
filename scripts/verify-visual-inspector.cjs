const assert=require('node:assert/strict');
module.exports=async({ws,inspected,evaluate,until,shot})=>{
 await until(`!document.querySelector('.inspector-panel').hidden`);
 await evaluate(ws,`Array.from(document.querySelectorAll('.inspector-tree button')).find(b=>b.textContent==='h1').click()`);
 await until(`!!document.querySelector('.inspector-fields input[data-property="color"]')`);
 await evaluate(ws,`(()=>{const e=document.querySelector('.inspector-fields input[data-property="color"]');e.value='rgb(10, 20, 30)';e.dispatchEvent(new Event('change'));})()`);
 for(let i=0;i<100;i++){if(await evaluate(inspected,`getComputedStyle(document.querySelector('h1')).color==='rgb(10, 20, 30)'`))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(await evaluate(inspected,`getComputedStyle(document.querySelector('h1')).color`),'rgb(10, 20, 30)');
 assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-inspect',{command:'style',token:'stale',node:1,property:'color',value:'red'})`)).ok,false);
 const treeData=(await evaluate(ws,`personalAgentDesktop.workspace('browser-inspect',{command:'tree'})`)).data;function find(items){for(const n of [].concat(items||[])){if(n.label==='h1')return n;const r=find(n.children);if(r)return r;}}const node=find(treeData.nodes).node;
 const selectData=(await evaluate(ws,`personalAgentDesktop.workspace('browser-inspect',${JSON.stringify({command:'select',token:treeData.token,node})})`)).data;
 for(const value of ['url(https://example.com/leak)','red;display:none'])assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-inspect',${JSON.stringify({command:'style',token:selectData.token,node,property:'color',value})})`)).ok,false);
 await shot('visual-inspector-design');
 await evaluate(ws,`document.querySelector('.inspector-tabs button:last-child').click()`);await until(`!document.querySelector('.inspector-panel input[aria-label="搜索 CSS 属性"]').hidden`);await shot('visual-inspector-css');
 await evaluate(ws,`document.querySelector('.inspector-panel button[aria-label="关闭检查器"]').click()`);
 await evaluate(ws,`window.__inspectEvents=[];personalAgentDesktop.onWorkspaceInspect(p=>window.__inspectEvents.push({kind:p.kind,error:p.error,tag:p.data?.tag}))`);
 async function select(){await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'select'})`);const p=await evaluate(inspected,`(()=>{const r=document.querySelector('h1').getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()`);await inspected('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await inspected('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await inspected('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});try{await until(`document.querySelector('.inspector-selection').matches(':popover-open')`);}catch(e){console.log(await evaluate(ws,`window.__inspectEvents`));throw e;}}
 await select();await shot('visual-element-selection');
 await evaluate(ws,`document.querySelector('.inspector-selection button').click();document.querySelector('.inspector-selection textarea').value='请改成绿色';document.querySelector('.inspector-selection button').click()`);
 await until(`!!document.querySelector('.composer-element-open')`);
 await evaluate(ws,`document.querySelector('.composer-element-open').click()`);await until(`!!document.querySelector('dialog[open]')`);
 assert.match(await evaluate(ws,`document.querySelector('dialog[open]').textContent`),/请改成绿色/);assert.match(await evaluate(ws,`document.querySelector('dialog[open]').textContent`),/RETURNABLE PREVIEW/);
 await shot('visual-element-draft');
 async function click(x,y){await ws('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await ws('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});}
 const r=await evaluate(ws,`(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
 await click(r.x+12,r.y+12);assert.equal(await evaluate(ws,`!!document.querySelector('dialog[open]')`),true,'inside padding must not dismiss');
 await click(r.x-12,r.y+12);await until(`!document.querySelector('dialog[open]')`);
 const input=await evaluate(ws,`(()=>{const e=Array.from(document.querySelectorAll('.composer textarea')).find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');const r=e.getBoundingClientRect();e.dataset.dismissTest='yes';return {x:r.x+20,y:r.y+20};})()`);await click(input.x,input.y);await ws('Input.insertText',{text:'dismiss typing check'});assert.match(await evaluate(ws,`document.querySelector('[data-dismiss-test]').value`),/dismiss typing check/);await evaluate(ws,`document.querySelector('[data-dismiss-test]').value=''`);
 await evaluate(ws,`document.querySelector('.composer-element-open').click()`);await until(`!!document.querySelector('dialog[open]')`);await ws('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ws('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(`!document.querySelector('dialog[open]')`);
 assert.equal(await evaluate(ws,`document.querySelector('#workspaceToggle').textContent`),'');assert.equal(await evaluate(ws,`!!document.querySelector('#workspaceToggle svg')`),true);assert.equal(await evaluate(ws,`Array.from(document.querySelectorAll('.workspace-panel header button')).some(b=>b.textContent==='收起')`),false);
 await evaluate(ws,`document.querySelector('#workspaceToggle').click()`);await until(`document.querySelector('.workspace-panel').hidden`);assert.equal(await evaluate(ws,`document.querySelector('#workspaceToggle').getAttribute('aria-expanded')`),'false');await evaluate(ws,`document.querySelector('#workspaceToggle').click()`);await until(`!document.querySelector('.workspace-panel').hidden`);assert.equal(await evaluate(ws,`document.querySelector('#workspaceToggle').getAttribute('aria-expanded')`),'true');
 await select();await evaluate(ws,`document.querySelectorAll('.inspector-selection button')[1].click()`);
 assert.equal(await evaluate(ws,`document.querySelectorAll('.composer-element-open').length`),2);
 assert.equal(await evaluate(ws,`document.body.textContent.includes('元素已加入草稿，尚未发送')`),false);
 await evaluate(ws,`while(document.querySelector('.composer-element-card .composer-file-remove'))document.querySelector('.composer-element-card .composer-file-remove').click()`);
 assert.equal(await evaluate(ws,`document.querySelectorAll('.composer-element-open').length`),0);
 assert.equal(await evaluate(ws,`document.body.textContent.includes('元素已加入草稿，尚未发送')`),false);
 await evaluate(ws,`(()=>{const form=document.createElement('div');form.className='composer';form.innerHTML='<div class="slot-inner"></div><div class="slot-bar"><button class="chip-btn"></button></div><textarea id="inspectDraftFixture"></textarea>';document.body.append(form);window.__draftFixture=mountComposerActions(form.querySelector('textarea'),{onChange(){},onStatus(){}});window.dispatchEvent(new CustomEvent('composer-element-add',{detail:{tag:'span',html:'<span>SAFE & DATA</span>',source:'fixture.html',comment:'make green'}}));})()`);
 assert.match(await evaluate(ws,`window.__draftFixture.getPrompt('request')`),/make green/);assert.match(await evaluate(ws,`window.__draftFixture.getPrompt('request')`),/SAFE & DATA/);
 await evaluate(ws,`window.__draftFixture.clear();document.querySelector('#inspectDraftFixture').closest('.composer').remove()`);
 assert.deepEqual(await evaluate(inspected,`({bridge:typeof personalAgentDesktop,node:typeof require})`),{bridge:'undefined',node:'undefined'});
 await evaluate(ws,`document.querySelector('#workspaceAdd').click();document.querySelectorAll('.workspace-add-menu button')[2].click()`);await until(`!!document.querySelector('.workspace-toolbar input')`);
 await evaluate(ws,`document.querySelector('.workspace-tab button').click()`);await until(`!!document.querySelector('#previewMore')`);
 assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-inspect',${JSON.stringify({command:'select',token:selectData.token,node})})`)).ok,false,'selection invalid after tab switch');
 await evaluate(ws,`document.querySelectorAll('.workspace-tab button')[3].click()`);await until(`document.querySelectorAll('.workspace-tab').length===1`);
 console.log('PASS visual inspector: real pick, design CSS edit, stale token, comment and element-only drafts');
};
if(require.main===module){const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[require.resolve('./verify-workspace.cjs')],{env:{...process.env,PA_VERIFY_VISUAL:'1'},stdio:'inherit'});process.exitCode=r.status??1;}
