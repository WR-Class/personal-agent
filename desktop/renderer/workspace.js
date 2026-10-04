/* User-operated tools; never exposed to model replies. */
(() => {
  const api = window.personalAgentDesktop;
  const style = document.createElement('style');
  style.textContent = `
    .composer .slot-bar>[data-mode],.composer .slot-bar>[title="权限"],.composer .slot-bar>[title="提及"],.composer .slot-bar>[title="技能"],.composer #btnStop,.composer-hint{display:none}
    .composer--home{min-height:0}.composer .slot{background:var(--bg-elevated);padding:0;border:1px solid var(--border-primary);overflow:hidden}.composer .slot-inner{border-radius:0;background:transparent}.composer .slot-ta{min-height:88px}.composer .slot-bar{padding:6px 14px 10px;gap:10px}.composer .slot-bar>.chip-btn:first-child{font-size:24px;width:32px;height:32px;justify-content:center;padding:0}.composer .workspace-controls{border-top:1px solid var(--border-primary);padding:8px 16px;font-size:12px;min-height:40px}.composer-status:empty{display:none}.composer .send{background:var(--btn-primary-bg);color:var(--btn-primary-fg)}.session-group{margin:12px 0}.session-group summary{cursor:pointer;padding:7px;color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-row{display:block;width:100%;padding:8px 14px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:8px;font:inherit;color:var(--text-primary)}.session-row:hover,.session-row.is-on{background:var(--bg-hover)}
    .composer-model{display:flex;align-items:center;min-width:0}.composer-model label{font-size:0}.composer-model select{font-size:12px;border:0;background:transparent;max-width:220px!important}
    .composer-status{display:block;padding:4px 12px}.workspace-controls{display:flex;gap:12px;padding:8px 12px;align-items:center}.workspace-controls button,.workspace-controls select{border:0;background:transparent;color:var(--text-secondary);font:inherit;max-width:220px;overflow:hidden;text-overflow:ellipsis}
    .workspace-panel{position:fixed;right:0;top:68px;bottom:28px;width:43vw;background:var(--bg,#fff);border-left:1px solid #ddd;z-index:20;display:flex;flex-direction:column;min-width:330px}.workspace-panel[hidden]{display:none}.workspace-panel header{padding:12px;border-bottom:1px solid #ddd;display:flex;gap:8px;align-items:center}.workspace-panel button,.workspace-panel input{font:inherit;padding:7px;border:1px solid #ddd;border-radius:6px;background:var(--bg,#fff);color:inherit}.workspace-panel input{min-width:0;flex:1}.workspace-content{flex:1;min-height:0;overflow:auto;padding:16px}.workspace-start{height:100%;display:flex;flex-direction:column;justify-content:center;gap:14px;max-width:350px;margin:auto}.workspace-start button{text-align:left;padding:18px}.workspace-start small{display:block;color:#888;margin-top:5px}.workspace-output{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}.workspace-toolbar{display:flex;gap:6px;margin-bottom:12px}.workspace-browser{height:calc(100% - 56px);min-height:80px}.workspace-error{padding:8px;color:#b22;white-space:pre-wrap}.workspace-file{display:block;width:100%;text-align:left;margin-bottom:5px}body.workspace-open .main{margin-right:43vw}@media(max-width:1000px){body.workspace-open .main{margin-right:0}.workspace-panel{width:70vw}}
  `;
  document.head.append(style);
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
  const panel = node('aside', '', 'workspace-panel'); panel.hidden = true; panel.setAttribute('aria-label','工作区工具');
  const header = node('header'), home = node('button','开始'), title = node('span','工作区'), close = node('button','收起'); title.style.flex = '1'; header.append(home,title,close);
  const error = node('div','','workspace-error'); error.setAttribute('role','status');
  const content = node('div','','workspace-content'); panel.append(header,error,content); document.body.append(panel);
  const toggle = node('button','◧ 工作区','chip-btn'); toggle.id='workspaceToggle'; document.querySelector('.tb-right').append(toggle);
  let mode = 'start', browserSlot, browserReady = false, state = {root:'',permission:'read'};
  const controls = [];
  async function call(action,payload) { const r = await api.workspace(action,payload); if (!r.ok) throw new Error(r.error); return r.data; }
  async function run(fn) { error.textContent=''; try { return await fn(); } catch(e) { error.textContent=e.message; } }
  function sync() { controls.forEach(({choose,permission})=>{choose.textContent=state.root||'选择工作区⌄';choose.title=state.root||'选择本地文件夹';permission.value=state.permission;}); }
  function show() { panel.hidden=false;document.body.classList.add('workspace-open'); }
  async function hideBrowser() { await call('browser-bounds',{visible:false,x:0,y:0,width:1,height:1}); }
  function bounds() {
    if(mode!=='browser'||panel.hidden||!browserSlot||!browserReady) return;
    const obscured = !!document.querySelector('dialog[open],.set-overlay.is-on,.scrim.is-on');
    const r=browserSlot.getBoundingClientRect();
    void run(()=>call('browser-bounds',{x:Math.round(r.x),y:Math.round(r.y),width:Math.floor(r.width),height:Math.floor(r.height),visible:!obscured}));
  }
  async function start() { mode='start';browserSlot=null;await hideBrowser();content.replaceChildren();const menu=node('div','','workspace-start');
    for(const [label,detail,fn] of [['工作区文件','浏览已选择工作区中的文本文件',()=>files('')],['新建终端','手动运行命令 · 需要完全访问权限',terminal],['浏览器','隔离浏览网页，不向模型开放',browser]]){const b=node('button',label);b.append(node('small',detail));b.onclick=()=>run(fn);menu.append(b);}content.append(menu);
  }
  home.onclick=()=>run(start);close.onclick=()=>run(async()=>{panel.hidden=true;document.body.classList.remove('workspace-open');await hideBrowser();});toggle.onclick=()=>{if(panel.hidden){show();void run(start);}else close.click();};
  for(const composer of document.querySelectorAll('.composer')) {
    const row=node('div','','workspace-controls'),choose=node('button','选择工作区⌄'),permission=node('select');permission.setAttribute('aria-label','本地工具权限');
    for(const [value,text] of [['read','只读 · 禁止命令'],['full','允许完全访问']]){const o=node('option',text);o.value=value;permission.append(o);}row.append(choose,permission);composer.querySelector('.slot').append(row);controls.push({choose,permission});
    choose.onclick=()=>run(async()=>{const previous=state.root;state=await call('choose');sync();window.dispatchEvent(new CustomEvent('workspace-changed',{detail:{changed:previous!==state.root}}));});permission.onchange=()=>run(async()=>{try{state=await call('permission',{permission:permission.value});}finally{sync();}});
    const plus=composer.querySelector('.slot-bar .chip-btn');if(plus){plus.textContent='＋';plus.title='打开工作区文件（不会自动发送给模型）';plus.onclick=e=>{e.stopImmediatePropagation();show();void run(()=>files(''));};}
  }
  async function files(relative) {mode='files';await hideBrowser();content.replaceChildren();const data=await call('files',{relative});const up=node('button','上一级');up.onclick=()=>run(()=>files(relative.split('/').slice(0,-1).join('/')));content.append(up);for(const entry of data.entries||data){const b=node('button',(entry.directory?'📁 ':'')+entry.name,'workspace-file');b.onclick=()=>run(async()=>{const p=[relative,entry.name].filter(Boolean).join('/');if(entry.directory)await files(p);else{const result=await call('read',{relative:p});content.replaceChildren(up,node('pre',result.content??result,'workspace-output'));}});content.append(b);}}
  async function terminal(){mode='terminal';await hideBrowser();content.replaceChildren(node('p','命令终端：每次独立运行，最长 30 秒；不支持交互式程序。完全访问不是工作区沙箱，命令可以访问工作区以外。'));const bar=node('form','','workspace-toolbar'),input=node('input'),send=node('button','运行'),output=node('pre','','workspace-output');input.placeholder='输入 PowerShell 命令';input.setAttribute('aria-label','终端命令');send.type='submit';bar.append(input,send);content.append(bar,output);bar.onsubmit=e=>{e.preventDefault();void run(async()=>{send.disabled=true;try{const result=await call('terminal',{command:input.value});output.textContent=(result.output||'')+'\n退出码：'+result.code;}finally{send.disabled=false;}});};}
  async function browser(){mode='browser';content.replaceChildren();const bar=node('form','','workspace-toolbar'),back=node('button','←'),reload=node('button','↻'),url=node('input'),go=node('button','打开');back.type=reload.type='button';go.type='submit';url.placeholder='https://example.com';url.setAttribute('aria-label','网页地址');bar.append(back,reload,url,go);browserSlot=node('div','','workspace-browser');content.append(bar,browserSlot);bar.onsubmit=e=>{e.preventDefault();void run(async()=>{go.disabled=true;go.textContent='加载中…';try{const result=await call('browser-open',{url:url.value});url.value=result.url;browserReady=true;bounds();}finally{go.disabled=false;go.textContent='打开';}});};back.onclick=()=>run(()=>call('browser-back'));reload.onclick=()=>run(()=>call('browser-reload'));}
  new ResizeObserver(bounds).observe(panel);window.addEventListener('resize',bounds);
  new MutationObserver(bounds).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','open']});
  window.addEventListener('workspace-sync',()=>void run(async()=>{state=await call('state');sync();}));
  void run(async()=>{state=await call('state');sync();});
})();
