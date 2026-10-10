/* User-operated tools; never exposed to model replies. */
(() => {
  const api = window.personalAgentDesktop;
  const style = document.createElement('style');
  style.textContent = `
    .composer .slot-bar>[data-mode],.composer .slot-bar>[title="权限"],.composer .slot-bar>[title="提及"],.composer .slot-bar>[title="技能"],.composer-hint{display:none}
    .session-group{margin:12px 0}.session-group summary{cursor:pointer;padding:7px;color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-row{display:block;width:100%;padding:8px 14px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:8px;font:inherit;color:var(--text-primary)}.session-row:hover,.session-row.is-on{background:var(--bg-hover)}
    .confirm-scrim{align-items:center;justify-content:center;z-index:60;background:rgba(0,0,0,.32)}.confirm-card{width:400px;max-width:86vw;background:var(--bg-elevated);border:1px solid var(--border-primary);border-radius:var(--radius-xl);padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.18)}.confirm-card h3{margin:0 0 8px;font-size:var(--fs-body);color:var(--text-primary)}.confirm-card p{margin:0;font-size:var(--fs-caption);color:var(--text-secondary);line-height:1.6}.confirm-detail{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-mono);font-size:12px;background:var(--bg-primary-default);border-radius:var(--radius-md);padding:8px 10px;margin:10px 0 0;max-height:40vh;overflow:auto;color:var(--text-secondary)}.confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.confirm-actions button{height:30px;padding:0 14px;border-radius:var(--radius-md);border:1px solid var(--border-primary);font-size:var(--fs-caption);background:var(--bg-elevated);color:var(--text-secondary)}.confirm-actions button:hover{background:var(--bg-hover);color:var(--text-primary)}.confirm-actions .confirm-yes{background:var(--btn-primary-bg);color:var(--btn-primary-fg);border-color:transparent}
    .workspace-panel{position:fixed;right:0;top:68px;bottom:28px;width:var(--workspace-width,43vw);background:var(--bg-elevated);border-left:1px solid var(--border-primary);z-index:20;display:flex;flex-direction:column;min-width:0;box-sizing:border-box}.workspace-panel[hidden]{display:none}.workspace-panel header{padding:12px;border-bottom:1px solid var(--border-primary);display:flex;gap:8px;align-items:center}.workspace-panel button,.workspace-panel input{font:inherit;padding:7px;border:1px solid var(--border-primary);border-radius:6px;background:var(--bg-elevated);color:inherit}.workspace-panel input{min-width:0;flex:1}.workspace-content{flex:1;min-height:0;overflow:auto;padding:16px}.workspace-start{height:100%;display:flex;flex-direction:column;justify-content:center;gap:14px;max-width:350px;margin:auto}.workspace-start button{text-align:left;padding:18px}.workspace-start small{display:block;color:var(--text-tertiary);margin-top:5px}.workspace-output{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}.workspace-toolbar{display:flex;gap:6px;margin-bottom:12px}.workspace-browser{height:calc(100% - 56px);min-height:80px}.workspace-error{padding:8px;color:var(--status-error);white-space:pre-wrap}.workspace-file{display:block;width:100%;text-align:left;margin-bottom:5px}body.workspace-open .main{margin-right:var(--workspace-width,43vw)}
    .workspace-splitter{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;touch-action:none;z-index:1;outline:none}.workspace-splitter:hover,.workspace-splitter:focus-visible,body.workspace-resizing .workspace-splitter{background:color-mix(in srgb,var(--accent) 35%,transparent)}body.workspace-resizing,body.workspace-resizing *{cursor:col-resize!important;user-select:none!important}
    body.workspace-full .workspace-panel{width:calc(100vw - var(--workspace-left,0px))}body.workspace-full .main{visibility:hidden;pointer-events:none}body.workspace-full .workspace-splitter{display:none}.workspace-fullscreen{width:32px;height:32px;display:grid;place-items:center}.workspace-fullscreen svg{width:16px;height:16px}.workspace-panel header button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .workspace-error:empty{display:none}
    .workspace-panel header{padding:6px 8px;min-height:44px;flex:none;gap:6px}
    .workspace-panel #workspaceFileTab{border:0;border-radius:999px;background:var(--bg-secondary)}
    .workspace-panel .preview-controls{display:flex;gap:4px;flex:none}
    .workspace-panel .preview-controls[hidden]{display:none}
    .workspace-content.is-viewport{display:flex;flex-direction:column;padding:0;overflow:hidden}
    .preview-body{flex:1;min-height:0;overflow:auto}
    .preview-body:has(>.workspace-browser){display:flex;flex-direction:column}
    .preview-body:not(:has(>.workspace-browser)){padding:12px}
    .preview-body>pre,.preview-body .code-block{height:auto;min-height:80px;max-height:none;flex-shrink:0}
    .workspace-tabs{display:flex;gap:3px;overflow-x:auto;min-width:0;max-width:70%;align-items:center}
    .workspace-panel .workspace-tab{display:flex;align-items:center;flex:none;max-width:200px;border:0;padding:0;background:transparent}
    .workspace-tab button{border:0;background:transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .workspace-tab[aria-selected="true"]{background:var(--bg-selected);border-radius:6px}
    .workspace-panel #workspaceAdd{border:0;background:transparent;font-size:18px;padding:4px 8px}
    .workspace-panel #workspaceAdd:hover{background:var(--bg-hover)}
    .workspace-add-menu{position:fixed;margin:0;padding:6px;width:200px;border:1px solid var(--border-primary);border-radius:10px;background:var(--bg-elevated);color:var(--text-primary);box-shadow:var(--shadow-pop)}
    .workspace-add-menu button{display:block;width:100%;padding:9px;text-align:left;border:0;background:none;color:inherit}
    .workspace-add-menu button:hover{background:var(--bg-hover)}
    .preview-body>.workspace-output{padding:12px;margin:0}
    .workspace-content.is-viewport .workspace-browser{flex:1;min-height:0;height:auto}
    .workspace-content.is-viewport>.workspace-toolbar{flex:none;margin:0;padding:6px 8px}
    .workspace-panel button[aria-pressed="true"]{background:var(--bg-selected)}
    @media(max-width:1000px){body.workspace-open .main{margin-right:0}}
  `;
  document.head.append(style);
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
  const panel = node('aside', '', 'workspace-panel'); panel.hidden = true; panel.setAttribute('aria-label','工作区工具');
  const header = node('header'), home = node('button','＋'), title = node('button','工作区');home.id='workspaceAdd';home.type='button';home.title='打开工作区工具';home.setAttribute('aria-label','打开工作区工具');title.id='workspaceFileTab';title.type='button';title.disabled=true;title.style.cssText='flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left';const fullscreen=node('button','','workspace-fullscreen');fullscreen.id='workspaceFullscreen';fullscreen.type='button';fullscreen.setAttribute('aria-keyshortcuts','Control+Alt+Enter');header.append(home,title,fullscreen);
  const previewControls=node('div','','preview-controls');previewControls.hidden=true;header.insertBefore(previewControls,fullscreen);
  function viewport(active){content.classList.toggle('is-viewport',active);previewControls.hidden=true;previewControls.replaceChildren();}
  const error = node('div','','workspace-error'); error.setAttribute('role','status');
  let content = node('div','','workspace-content'); panel.append(header,error,content); document.body.append(panel);
  const toggle = node('button','','chip-btn'); toggle.id='workspaceToggle';toggle.type='button';toggle.title='展开 / 收起工作区';toggle.setAttribute('aria-label','展开 / 收起工作区');toggle.setAttribute('aria-controls','workspacePanel');toggle.setAttribute('aria-expanded','false');toggle.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>'; document.querySelector('.tb-right').append(toggle);
  const splitter=node('div','','workspace-splitter');splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-orientation','vertical');splitter.setAttribute('aria-label','调整工作区宽度');panel.id='workspacePanel';splitter.setAttribute('aria-controls',panel.id);panel.prepend(splitter);
  let preferredWidth=0,drag=null,full=false;try{const saved=Number(localStorage.getItem('workspace-width'));if(Number.isFinite(saved)&&saved>=280)preferredWidth=saved;}catch{}
  function limits(){const r=document.querySelector('.main').getBoundingClientRect();const left=Math.max(0,r.left),available=innerWidth-left;return {left,min:Math.min(330,available),max:Math.max(Math.min(330,available),available-(innerWidth>1000?360:24))};}
  function layout(){const l=limits(),width=Math.round(Math.max(l.min,Math.min(l.max,preferredWidth||(innerWidth>1000?innerWidth*.43:innerWidth*.7))));document.body.style.setProperty('--workspace-width',width+'px');document.body.style.setProperty('--workspace-left',l.left+'px');splitter.setAttribute('aria-valuemin',Math.round(l.min));splitter.setAttribute('aria-valuemax',Math.round(l.max));splitter.setAttribute('aria-valuenow',width);bounds();}
  function saveWidth(){try{localStorage.setItem('workspace-width',String(preferredWidth));}catch{}}
  function setWidth(width){const l=limits();preferredWidth=Math.max(l.min,Math.min(l.max,width));layout();}
  function endDrag(){if(!drag)return;const id=drag.id;drag=null;document.body.classList.remove('workspace-resizing');if(splitter.hasPointerCapture(id))splitter.releasePointerCapture(id);saveWidth();bounds();}
  splitter.onpointerdown=e=>{if(e.button!==0||full)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,width:panel.getBoundingClientRect().width};splitter.setPointerCapture(e.pointerId);document.body.classList.add('workspace-resizing');splitter.focus();bounds();};
  splitter.onpointermove=e=>{if(drag?.id===e.pointerId)setWidth(drag.width+drag.x-e.clientX);};splitter.onpointerup=splitter.onpointercancel=splitter.onlostpointercapture=endDrag;window.addEventListener('blur',endDrag);
  splitter.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const l=limits();setWidth(e.key==='Home'?l.min:e.key==='End'?l.max:panel.getBoundingClientRect().width+(e.key==='ArrowLeft'?1:-1)*(e.shiftKey?64:16));saveWidth();};splitter.ondblclick=()=>{preferredWidth=0;layout();saveWidth();};
  function setFull(value){endDrag();full=value;document.body.classList.toggle('workspace-full',full);const label=full?'退出全屏':'全屏';fullscreen.title=label+' · Ctrl + Alt + Enter';fullscreen.setAttribute('aria-label',label);fullscreen.setAttribute('aria-pressed',String(full));fullscreen.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="'+(full?'M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6':'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6')+'"/></svg>';layout();}
  fullscreen.onclick=()=>setFull(!full);window.addEventListener('keydown',e=>{if(panel.hidden||e.repeat||document.querySelector('dialog[open],.scrim.is-on,.set-overlay.is-on'))return;if(e.ctrlKey&&e.altKey&&e.key==='Enter'){e.preventDefault();setFull(!full);}else if(e.key==='Escape'&&full){e.preventDefault();setFull(false);fullscreen.focus();}});
  /* 权限/命令确认弹窗：客户端自绘，主进程持一次性确认号裁决；120 秒无应答视为取消。 */
  const cScrim = node('div','','scrim confirm-scrim');
  const cCard = node('div','','confirm-card'); cCard.setAttribute('role','dialog'); cCard.setAttribute('aria-modal','true');
  const cTitle = node('h3'), cMsg = node('p'), cDetail = node('div','','confirm-detail'), cActions = node('div','','confirm-actions');
  const cCancel = node('button','取消'), cOk = node('button','','confirm-yes');
  cActions.append(cCancel,cOk); cCard.append(cTitle,cMsg,cDetail,cActions); cScrim.append(cCard); document.body.append(cScrim);
  let confirmId = null;
  function answerConfirm(ok) { const id = confirmId; confirmId = null; cScrim.classList.remove('is-on'); if (id) void api.workspace('confirm-response',{ id, ok }); }
  cCancel.onclick = () => answerConfirm(false); cOk.onclick = () => answerConfirm(true);
  cScrim.onclick = e => { if (e.target === cScrim) answerConfirm(false); };
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && confirmId) answerConfirm(false); });
  api.onWorkspaceConfirm?.(payload => {
    if (!payload || typeof payload.id !== 'string') return;
    if (payload.dismissed) { if (confirmId === payload.id) { confirmId = null; cScrim.classList.remove('is-on'); } return; }
    confirmId = payload.id; cTitle.textContent = payload.title || ''; cMsg.textContent = payload.message || '';
    cDetail.textContent = payload.detail || ''; cDetail.style.display = payload.detail ? '' : 'none';
    cOk.textContent = payload.confirm || '确认'; cScrim.classList.add('is-on'); cCancel.focus();
  });
  const tabStrip=node('div','','workspace-tabs');header.insertBefore(tabStrip,home);title.hidden=true;title.style.display='none';
  const spacer=node('span');spacer.style.flex='1';header.insertBefore(spacer,previewControls);
  const tabs=[];let activeTab=null,tabSerial=0,switching=false;
  function saveTab(){if(activeTab)Object.assign(activeTab,{content,mode,browserSlot,browserReady,controls:[...previewControls.childNodes],scrollTop:content.scrollTop});}
  async function activateTab(tab){
    if(switching||tab===activeTab)return;switching=true;
    try{window.dispatchEvent(new Event('workspace-inspector-reset'));saveTab();++viewRevision;await hideBrowser();await call('browser-tab',{id:tab.id});content.remove();activeTab=tab;content=tab.content;panel.append(content);content.scrollTop=tab.scrollTop||0;mode=tab.mode;browserSlot=tab.browserSlot;browserReady=tab.browserReady;previewControls.replaceChildren(...(tab.controls||[]));previewControls.hidden=!previewControls.childNodes.length;
      for(const t of tabs)t.button.setAttribute('aria-selected',String(t===tab));show();bounds();
    }finally{switching=false;}
  }
  async function openTab(kind,file){
    if(switching)return;const existing=file&&tabs.find(t=>t.file===file);if(existing){await activateTab(existing);return;}if(tabs.length>=20){error.textContent='请先关闭不用的页签（最多20个）';return;}
    const button=node('div','','workspace-tab'),label=node('button',file?file.split(/[\\/]/).pop():({files:'文件',browser:'浏览器',terminal:'终端'})[kind]),remove=node('button','×');button.setAttribute('role','tab');remove.setAttribute('aria-label','关闭页签');button.append(label,remove);
    const tab={id:'tab-'+(++tabSerial),kind,file,button,content:node('div','','workspace-content'),mode:'start',browserReady:false,controls:[]};tabs.push(tab);tabStrip.append(button);
    label.onclick=()=>run(()=>activateTab(tab));remove.onclick=()=>run(async()=>{if(switching)return;const index=tabs.indexOf(tab);if(activeTab===tab){const other=tabs[index-1]||tabs[index+1];if(other)await activateTab(other);else{saveTab();activeTab=null;content.replaceChildren();previewControls.replaceChildren();mode='start';browserReady=false;browserSlot=null;await hideBrowser();}}await call('browser-tab',{id:tab.id,close:true});tabs.splice(tabs.indexOf(tab),1);button.remove();});
    await activateTab(tab);switching=true;try{if(file)await deliverable(file);else if(kind==='files')await files('');else if(kind==='browser')await browser();else await terminal();saveTab();}finally{switching=false;}
  }
  const addMenu=node('div','','workspace-add-menu');addMenu.popover='auto';document.body.append(addMenu);
  for(const [kind,label] of [['files','文件'],['terminal','终端'],['browser','浏览器']]){const b=node('button',label);b.type='button';b.onclick=()=>{addMenu.hidePopover();void run(()=>openTab(kind));};addMenu.append(b);}
  addMenu.addEventListener('toggle',()=>{bounds();});
  let lastFile=null,viewRevision=0;
  title.onclick=()=>{if(lastFile)void run(()=>deliverable(lastFile));};
  let mode = 'start', browserSlot, browserReady = false, state = {root:'',permission:'write'};
  const controls = [];
  async function call(action,payload) { const r = await api.workspace(action,payload); if (!r.ok) throw new Error(r.error); return r.data; }
  async function run(fn) { error.textContent=''; try { return await fn(); } catch(e) { error.textContent=e.message; } }
  function sync() { controls.forEach(({choose,permission,picker})=>{choose.querySelector('.workspace-name').textContent=state.root ? state.root.split(/[\\/]/).filter(Boolean).pop() || state.root : '选择工作区';choose.title=(state.root||'选择本地文件夹')+' · 选择后 Agent 可读取其中的文件，工具结果会发送到当前模型服务';permission.value=state.permission;picker.sync();}); }
  function show() { panel.hidden=false;toggle.setAttribute('aria-expanded','true');document.body.classList.add('workspace-open');layout(); }
  async function hideBrowser() { await call('browser-bounds',{visible:false,x:0,y:0,width:1,height:1}); }
  window.addEventListener('workspace-inspector-layout',()=>bounds());
  window.addEventListener('workspace-inspector-draft',()=>{if(full)setFull(false);});
  let boundsFrame;
  function bounds(){syncBounds();cancelAnimationFrame(boundsFrame);boundsFrame=requestAnimationFrame(syncBounds);}
  function syncBounds() {
    if(mode!=='browser'||panel.hidden||!browserSlot||!browserReady) return;
    // 不要因为 drag 就隐藏原生预览视图：切换可见性会让页面立刻失去指针捕获，分栏拖拽随即中断。
    const obscured = addMenu.matches(':popover-open') || !!document.querySelector('dialog[open],.inspector-selection:popover-open,.set-overlay.is-on,.scrim.is-on');
    const r=browserSlot.getBoundingClientRect();
    void run(()=>call('browser-bounds',{x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height),visible:!obscured}));
  }
  home.onclick=()=>{const r=home.getBoundingClientRect();addMenu.style.left=Math.min(r.left,innerWidth-210)+'px';addMenu.style.top=r.bottom+4+'px';addMenu.togglePopover();};
  async function collapse(){window.dispatchEvent(new Event('workspace-inspector-reset'));++viewRevision;setFull(false);panel.hidden=true;toggle.setAttribute('aria-expanded','false');if(addMenu.matches(':popover-open'))addMenu.hidePopover();document.body.classList.remove('workspace-open');toggle.focus();await hideBrowser();}
  toggle.onclick=()=>{if(panel.hidden){show();if(!activeTab)home.click();else bounds();}else void run(collapse);};
  for(const composer of document.querySelectorAll('.composer')) {
    const row=node('div','','workspace-controls'),choose=node('button','','workspace-choose'),permission=node('select');permission.setAttribute('aria-label','本地工具权限');
    choose.type='button';
    choose.innerHTML='<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span class="workspace-name">选择工作区</span><svg class="ico workspace-chevron" aria-hidden="true"><use href="#i-chev-d"/></svg>';
    for(const [value,text] of [['read','只读'],['write','工作区写入'],['full','完全访问']]){const o=node('option',text);o.value=value;permission.append(o);}
    permission.title='默认工作区写入：区内文件修改自动执行，命令因无系统沙箱须批准；只读：仅查看工作区；完全访问：区外文件读写及命令免确认。所选权限按会话记住，重开客户端或切回该会话会恢复。文件工具保护不等于命令沙箱。';
    row.append(choose,permission);composer.querySelector('.slot').append(row);
    const picker=window.enhancePicker(permission,{kind:'permission',label:'工具权限',descriptions:{read:'仅查看工作区文件，不执行写入或命令',write:'工作区内修改自动执行，运行命令前需批准',full:'区外读写及命令免确认 · 无系统沙箱'}});
    controls.push({choose,permission,picker});
    choose.onclick=()=>run(async()=>{const previous=state.root;state=await call('choose');sync();window.dispatchEvent(new CustomEvent('workspace-changed',{detail:{changed:previous!==state.root}}));});permission.onchange=()=>run(async()=>{try{state=await call('permission',{permission:permission.value});}finally{sync();}});
    if (composer.closest('#vChat')) {
      row.classList.add('workspace-controls--inline');
      choose.hidden=true;
      composer.querySelector('.slot-bar .chip-btn').after(row);
    }
  }
  async function files(relative) {++viewRevision;viewport(false);title.setAttribute('aria-pressed','false');mode='files';await hideBrowser();content.replaceChildren();const data=await call('files',{relative});const up=node('button','上一级');up.onclick=()=>run(()=>files(relative.split('/').slice(0,-1).join('/')));content.append(up);for(const entry of data.entries||data){const b=node('button',(entry.directory?'📁 ':'')+entry.name,'workspace-file');b.onclick=()=>run(async()=>{const p=[relative,entry.name].filter(Boolean).join('/');if(entry.directory)await files(p);else await openTab('file',p);});content.append(b);}}
  async function deliverable(file){
    const revision=++viewRevision;show();viewport(true);mode='files';await hideBrowser();if(revision!==viewRevision)return;content.replaceChildren();
    const result=await call('deliverable-read',{path:file});if(revision!==viewRevision)return;lastFile=file;title.disabled=false;title.textContent=result.relative;title.title='返回文件预览 · '+result.relative;title.setAttribute('aria-pressed','true');
    const reload=node('button','↻'),more=node('button','…'),body=node('div','','preview-body');reload.title='重新读取并预览文件';reload.setAttribute('aria-label',reload.title);reload.onclick=()=>run(()=>deliverable(file));more.id='previewMore';more.type='button';more.title='预览工具（隔离预览，禁止网络、文件访问和弹窗）';more.setAttribute('aria-label','预览工具');more.setAttribute('aria-haspopup','menu');more.disabled=true;more.onclick=()=>run(()=>call('browser-tools-menu'));previewControls.append(reload,more);previewControls.hidden=false;content.append(body);
    await (async()=>{
      if(revision!==viewRevision)return;
      if(/\.html?$/i.test(result.relative)){
        mode='browser';browserReady=false;body.replaceChildren();browserSlot=node('div','','workspace-browser');body.append(browserSlot);
        await call('deliverable-preview',{path:file});if(revision!==viewRevision){if(mode!=='browser')await hideBrowser();return;}browserReady=true;more.disabled=false;bounds();
      }else{mode='files';await hideBrowser();body.replaceChildren();if(/\.md$/i.test(result.relative))window.renderReply(body,result.content);else body.append(node('pre',result.content,'workspace-output'));}
    })();
  }
  window.addEventListener('deliverable-open',e=>{if(typeof e.detail?.path==='string')void run(()=>openTab('file',e.detail.path));});
  async function terminal(){++viewRevision;viewport(false);title.setAttribute('aria-pressed','false');mode='terminal';await hideBrowser();content.replaceChildren(node('p','手动命令：最长 30 秒，不支持交互式程序。工作区档逐次批准；完全访问免确认。命令没有系统沙箱，可以访问工作区以外。模型命令及后台任务由聊天工具链执行。'));const bar=node('form','','workspace-toolbar'),input=node('input'),send=node('button','运行'),output=node('pre','','workspace-output');input.placeholder='输入 PowerShell 命令';input.setAttribute('aria-label','终端命令');send.type='submit';bar.append(input,send);content.append(bar,output);bar.onsubmit=e=>{e.preventDefault();void run(async()=>{send.disabled=true;try{const result=await call('terminal',{command:input.value});output.textContent=(result.output||'')+'\n退出码：'+result.code;}finally{send.disabled=false;}});};}
  async function browser(){++viewRevision;viewport(true);browserReady=false;await hideBrowser();title.setAttribute('aria-pressed','false');mode='browser';content.replaceChildren();const bar=node('form','','workspace-toolbar'),back=node('button','←'),reload=node('button','↻'),url=node('input'),go=node('button','打开');back.type=reload.type='button';go.type='submit';url.placeholder='https://example.com';url.setAttribute('aria-label','网页地址');bar.append(back,reload,url,go);browserSlot=node('div','','workspace-browser');content.append(bar,browserSlot);bar.onsubmit=e=>{e.preventDefault();void run(async()=>{go.disabled=true;go.textContent='加载中…';try{const result=await call('browser-open',{url:url.value});url.value=result.url;browserReady=true;bounds();}finally{go.disabled=false;go.textContent='打开';}});};back.onclick=()=>run(()=>call('browser-back'));reload.onclick=()=>run(()=>call('browser-reload'));}
  new ResizeObserver(bounds).observe(panel);new ResizeObserver(layout).observe(document.querySelector('.sidebar'));window.addEventListener('resize',layout);setFull(false);
  new MutationObserver(bounds).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','open']});
  // All existing menu/navigation entries reuse these same user-operated tools.
  window.addEventListener('workspace-open', e => {
    const target = e.detail?.mode;
    if (!['start','files','terminal','browser','toggle'].includes(target)) return;
    if (target === 'toggle') { toggle.click(); return; }
    show();
    void run(async () => {
      state = await call('state'); sync();
      if(target==='start')home.click();else await openTab(target);
    });
  });
  window.addEventListener('chat-busy',e=>controls.forEach(({choose,permission})=>{choose.disabled=permission.disabled=!!e.detail?.busy;}));
  window.addEventListener('workspace-sync',()=>void run(async()=>{state=await call('state');sync();}));
  void run(async()=>{state=await call('state');sync();});
})();
