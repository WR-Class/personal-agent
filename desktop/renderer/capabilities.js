/* Plugin manifests, flattened Skills and local/remote MCP. Untrusted values stay in text/value properties. */
(() => {
  'use strict';
  const el = (tag, text, parent, className) => {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
    if (className) node.className = className; if (parent) parent.append(node); return node;
  };
  // Presentation only: aliases do not rename imported packages or change model skill IDs.
  const identities = {
    'frontend-design': ['前端设计工具集','高品质 UI/UX 设计工具集，帮助生成独特的前端界面，涵盖视觉风格、布局排版、动效交互与设计系统。','#7065e9','window'],
    'cloudflare': ['Cloudflare 云平台','面向 Cloudflare 的开发工具与技能，涵盖 Workers、Wrangler、Agents SDK 和 API 连接器。','#f48120','cloud'],
    'github': ['GitHub 代码协作','检查代码仓库、处理 Pull Request 与 Issue、排查 CI，并通过已连接工具协作发布。','#475569','branch'],
    'web-app-development': ['Web 应用开发','面向 Web 应用的界面构建技能与配套资源，辅助开发页面和交互。','#2563eb','window'],
    'rapid-prototype-craft': ['快速原型制作','快速构建可交互原型，探索页面布局、用户流程与产品创意。','#a855f7','bolt']
  };
  const display=(item,meta)=>{const a=identities[item.id];return {name:a?.[0]||meta?.displayName||item.name,description:a?.[1]||meta?.description,color:a?.[2]||'#64748b',icon:a?.[3]||'window'};};
  function identityIcon(parent,info){
    const box=el('span',undefined,parent);box.className='plugin-icon';box.setAttribute('aria-hidden','true');box.style.cssText=`display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;flex:0 0 38px;border-radius:10px;background:${info.color};color:white`;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),p=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','24');svg.setAttribute('height','24');p.setAttribute('d',({window:'M4 4h16v16H4zM4 9h16M7 6.5h1M10 6.5h1',cloud:'M6 18h12a4 4 0 0 0 0-8 6 6 0 0 0-11-1 4.5 4.5 0 0 0-1 9z',branch:'M7 5v12M7 12h6a4 4 0 0 0 4-4V5M5 3h4v4H5zM15 3h4v4h-4zM5 17h4v4H5z',bolt:'M14 2 5 14h6l-1 8 9-13h-6z'})[info.icon]);p.setAttribute('fill','none');p.setAttribute('stroke','currentColor');p.setAttribute('stroke-width','1.7');p.setAttribute('stroke-linejoin','round');svg.append(p);box.append(svg);
  }
  let catalogueCache;
  window.mountCapabilitySettings = (host, { kind }) => {
    if (!['plugins','skills', 'mcp'].includes(kind)) throw Error('Unknown capability panel');
    const plugins=kind==='plugins', skills = kind === 'skills', local=skills||plugins;
    let state, packages, metadata=[], destroyed = false, busy = false, sequence = 0, editor, pendingRefresh = false, fresh=false;
    let chatBusy = document.getElementById('btnNew')?.disabled === true;
    host.replaceChildren(); host.classList.add('capability-settings'); host.dataset.capability = kind;
    const top = el('div', undefined, host, 'capability-heading');
    el('h3', plugins?'插件':skills ? '技能（Skills）' : 'MCP 连接器', top);
    const button = (parent, label, action, key) => {
      const b = el('button', label, parent, 'set-btn'); b.type = 'button'; b.onclick = action;
      if (key) b.dataset.action = key; return b;
    };
    const refreshButton = button(top, '刷新', () => void refresh(), 'refresh');
    el('p', local ? '导入包含 SKILL.md 的技能文件夹、插件或 ZIP，保留参考文档、脚本和资源。在当前 Agent 的所有工作区可用，不必填写关键词。'
      : '粘贴 mcpServers JSON 配置即可添加本地 stdio 或远程 HTTP 服务。保存不连接，连接需单独确认。远程服务不绑定工作区，可同时连接；远程工具逐次审批，本地 stdio 仍按工作区隔离。', host, 'capability-note');
    el('p', local ? '插件包含技能与可选连接器；技能启用不代表服务已连接。启用只允许按需读取技能资料，不会自动执行脚本或授予工具权限。选择工作区后，模型可按任务需要读取技能及资源。'
      : '支持 Streamable HTTP（JSON/SSE 响应）和自备 Bearer/PAT；支持浏览器 OAuth（同源公共客户端 PKCE / GitHub 设备码），不复用 TRAE 登录，不支持旧版 SSE 传输。headers/env 值由系统加密保存、回显脱敏。', host, 'capability-note');
    const workspace = el('p', '', host, 'capability-workspace');
    const status = el('p', '', host, 'capability-status'); status.setAttribute('role', 'status');
    const list = el('div', undefined, host, 'capability-list');
    const add = button(host, local ? (plugins?'导入插件文件夹':'导入技能文件夹') : '编辑 MCP JSON', () => local ? void run('packageimport',{kind:'folder'}) : void editJson(), 'add');
    add.classList.add('capability-add');
    if (local) {
      button(host,'选择 ZIP 文件',()=>void run('packageimport',{kind:'zip'}),'import-zip');
      if(skills)button(host,'选择 SKILL.md',()=>void run('packageimport',{kind:'file'}),'import-file');
      if(skills){const old = el('details',undefined,host); el('summary','旧版自定义提示词（兼容保留）',old);
      button(old,'添加旧版提示词',()=>edit(),'legacy-add');}
    }
    function permission() { return state?.permission || document.querySelector('.workspace-controls select')?.value || 'write'; }
    function lock() {
      host.querySelectorAll('button').forEach(b => { b.disabled = busy || chatBusy || !state || !fresh; });
      refreshButton.disabled = busy || chatBusy;
      list.querySelectorAll('[data-legacy]').forEach(b => { b.disabled ||= !state?.workspaceRoot; });
      list.querySelectorAll('[data-action="connect"]').forEach(b => { const card=b.closest('[data-id]'),server=card&&state?.servers?.find(s=>s.id===card.dataset.id);const blocked=server&&server.type!=='http'&&(!state?.workspaceRoot || permission() === 'read');b.disabled ||= !!blocked;b.title=blocked?'本地 stdio 进程需要选择工作区和写入/完全访问权限。':'远程服务跨工作区可用，执行工具时单独审批。'; });
      editor?.lock();
    }
    async function call(action, payload) {
      const api = window.personalAgentDesktop;
      if (!api?.capabilities) throw Error('能力管理仅在桌面客户端可用');
      const result = await api.capabilities(action, payload);
      if (!result?.ok) throw Error(result?.error || '能力操作失败');
      return result.data;
    }
    function render() {
      list.replaceChildren();
      workspace.textContent = local ? '技能存放：'+(packages?.directory || '读取中…')+' · 跨工作区可用' : (state.workspaceRoot ? '当前工作区：'+state.workspaceRoot : '远程服务可直接连接、跨工作区复用，无需开启本地写入权限。');
      if (local) for (const item of packages?.packages || []) {
        const meta=metadata.find(m=>m.id===item.id),info=display(item,meta);
        if(plugins&&meta?.kind!=='plugin')continue;
        if(skills){for(const skill of item.skills){const card=el('section',undefined,list,'capability-card');card.dataset.package=item.id;card.dataset.skill=skill.id;el('strong',skill.name,card);el('p',skill.description,card,'capability-note');el('p',`来源：${info.name} · ${item.enabled?'已启用，可按需读取':'已停用'} · 连接状态请看插件页`,card,'capability-note');const a=el('div',undefined,card,'capability-actions');button(a,item.enabled?'停用所属包技能':'启用所属包技能',()=>void run('packageenable',{id:item.id,enabled:!item.enabled}),'package-enable');if(meta?.kind!=='plugin')button(a,'删除技能包',()=>void run('packageremove',{id:item.id}),'package-remove');}continue;}
        const card=el('section',undefined,list,'capability-card');card.dataset.package=item.id;
        const header=el('div',undefined,card,'capability-heading');identityIcon(header,info);const identity=el('div',undefined,header);identity.style.cssText='flex:1;min-width:0';el('strong',info.name,identity);el('p',info.description||'已安装插件，展开查看技能及连接器。',identity,'capability-note');el('span',item.enabled?'技能已启用（不代表已连接）':'技能已停用',header,'capability-badge');el('p',item.id+' · '+item.version,card,'capability-note');
        el('p',`${item.skills.length} 个技能 · ${item.files} 个文件 · ${Math.ceil(item.bytes/1024)} KB`,card,'capability-note');
        const details=el('details',undefined,card);el('summary','查看技能',details);
        for(const skill of item.skills){el('strong',skill.name,details);el('p',skill.description,details,'capability-note');}

        for(const warning of meta?.compatibility||[])el('p',warning,card,'capability-note');
        if(!meta?.connectors.length)el('p','此插件未声明可连接的 MCP；所含技能可直接按需读取，无需连接。',card,'capability-note');
        for(const connector of meta?.connectors||[]){
          const row=el('div',undefined,card,'capability-card');row.dataset.connector=connector.key;
          const server=state.servers?.find(s=>s.id===connector.serverId),matches=server?.type==='http'&&server.url===connector.url;
          el('strong',connector.key+' · '+(!fresh?'状态刷新中':!connector.supported?'不支持此声明':!matches?'未配置':server.connected?'已连接':'已配置 · 未连接'),row);
          el('p',connector.url||connector.reason,row,'capability-note');
          if(matches&&server.connected){el('p','已发现工具：'+server.tools.length,row,'capability-note');for(const t of server.tools)el('p',t.name,row,'capability-note');}
          if(connector.supported){const actions=el('div',undefined,row,'capability-actions');const oauth=button(actions,matches&&server.oauthAuthorized?'重新 OAuth 授权':'OAuth 浏览器授权',()=>void oauthDialog({packageId:item.id,connectorKey:connector.key},connector.url),'oauth');if(matches&&server.oauthAuthorized){el('p','OAuth 授权已保存（不等于当前已连接）',row,'capability-note');button(actions,'清除本地授权',()=>void run('oauthforget',{id:connector.serverId}),'oauth-forget');}button(actions,matches?'重新配置令牌':'配置连接',()=>void configurePlugin(item,connector),'plugin-configure');
            if(matches){button(actions,server.connected?'断开':'连接',()=>void run(server.connected?'disconnect':'pluginconnect',server.connected?{id:connector.serverId}:{packageId:item.id,connectorKey:connector.key}),server.connected?'disconnect':'connect');button(actions,'删除连接配置',()=>void run('serverremove',{id:connector.serverId}),'remove-connection');}}
        }
        const actions=el('div',undefined,card,'capability-actions');
        button(actions,item.enabled?'停用包内技能':'启用包内技能',()=>void run('packageenable',{id:item.id,enabled:!item.enabled}),'package-enable');
        button(actions,'删除',()=>void run('packageremove',{id:item.id}),'package-remove');
      }
      const items = plugins?[]:skills ? state.skills || [] : state.servers || [];
      if (!items.length && !list.children.length) el('p', local ? '还没有此类内容。点击下方按钮导入；纯技能显示在技能页，含插件清单的包显示在插件页。' : '还没有 MCP 服务配置。', list, 'capability-note');
      for (const item of items) {
        const card = el('section', undefined, list, 'capability-card'); card.dataset.id = item.id;
        const header = el('div', undefined, card, 'capability-heading');
        el('strong', item.id, header);
        el('span', skills ? (item.enabled ? '当前工作区已启用' : '未启用') : (!fresh?'状态刷新中':item.connected ? '已连接' : '未连接'), header, 'capability-badge');
        if (skills) {
          el('p', '关键词：' + (item.scenarios || []).join('、') + ' · 优先级 ' + (item.priority ?? 0), card, 'capability-note');
          const details = el('details', undefined, card); el('summary', '查看提示词', details); el('pre', item.prompt, details, 'capability-prompt');
        } else {
          el('p', item.type === 'http' ? item.url : item.command, card, 'capability-command');
          if (item.hasCredentials) el('p','已单独配置加密凭据',card,'capability-note');
          if (item.cwd) el('p', '工作目录：' + item.cwd, card, 'capability-note');
          const tools = item.tools || [], details = el('details', undefined, card);
          el('summary', '已发现工具：' + tools.length, details);
          for (const tool of tools) {
            const row = el('div', undefined, details, 'capability-tool');
            el('strong', tool.name, row); el('p', tool.description || '无工具说明', row, 'capability-note');
          }
        }
        const actions = el('div', undefined, card, 'capability-actions');
        const mutate = (label, fn, key) => { const b = button(actions, label, fn, key); b.dataset.mutation = 'true'; if(skills)b.dataset.legacy='true'; return b; };
        mutate('编辑', () => skills ? edit(item) : void editJson(), 'edit');
        if(!skills&&item.type==='http'){const b=mutate(item.oauthAuthorized?'重新 OAuth 授权':'OAuth 浏览器授权',()=>void oauthDialog({id:item.id},item.url),'oauth');if(item.oauthAuthorized)mutate('清除本地授权',()=>void run('oauthforget',{id:item.id}),'oauth-forget');}
        if (skills) mutate(item.enabled ? '停用' : '为当前工作区启用', () => void run('skillenable', { id: item.id, enabled: !item.enabled }), 'enable');
        else mutate(item.connected ? '断开' : '连接', () => void run(item.connected ? 'disconnect' : 'connect', { id: item.id }), item.connected ? 'disconnect' : 'connect');
        mutate('删除', () => void run(skills ? 'skillremove' : 'serverremove', { id: item.id }), 'remove');
      }
      lock();
    }
    async function loadSnapshot(){
      const [data,packs,meta]=await Promise.all([call('list'),local?call('packages'):Promise.resolve(undefined),local?call('plugins'):Promise.resolve(undefined)]);
      if(destroyed)return;state=data;if(local){packages=packs;metadata=meta;}fresh=true;
      // Keep only public display DTOs in this renderer lifetime, never tokens/editor drafts or live status.
      if(local)catalogueCache={packages,metadata};
    }
    async function refresh() {
      if (destroyed || busy) return;
      const token = ++sequence; busy = true; fresh=false;if(state)render();lock(); status.textContent = packages?'已显示本次打开期间的列表，正在刷新状态…':'正在读取本地插件信息…';
      try {
        await loadSnapshot(); if (destroyed || token !== sequence) return;
        render(); status.textContent = editor ? '列表已刷新，编辑草稿已保留。' : '';
      } catch (error) { if (!destroyed && token === sequence) status.textContent = error.message; }
      finally { if (!destroyed && token === sequence) { busy = false; lock(); if (pendingRefresh) { pendingRefresh = false; void refresh(); } } }
    }
    async function run(action, payload) {
      if (destroyed || busy || chatBusy || !state) return;
      const token = ++sequence; busy = true; lock(); status.textContent = '正在处理…';
      try {
        await call(action, payload); if (destroyed || token !== sequence) return;
        if(local)catalogueCache=undefined;
        await loadSnapshot(); if (destroyed || token !== sequence) return;
        render(); status.textContent = '操作已完成；列表为当前实际状态。';
      } catch (error) { if (!destroyed && token === sequence) status.textContent = error.message; }
      finally { if (!destroyed && token === sequence) { busy = false; lock(); if (pendingRefresh) { pendingRefresh = false; void refresh(); } } }
    }
    async function oauthDialog(target,url){
      if(destroyed||busy||chatBusy||editor||!fresh)return;busy=true;lock();let config;
      try{config=await call('mcpget');}catch(e){status.textContent=e.message;return;}finally{busy=false;lock();}if(destroyed)return;
      const github=['https://api.githubcopilot.com/mcp/','https://api.githubcopilot.com/mcp'].includes(url);
      const d=el('dialog',undefined,document.body,'capability-dialog');d.dataset.kind='oauth';el('h3','OAuth 浏览器授权',d);el('p',url,d,'capability-note');
      el('p',github?'GitHub 使用 Personal Agent 已预置的应用身份，无需注册应用或填写 Client ID。点击授权后，在浏览器登录你自己的 GitHub 账号，输入本窗口显示的设备码并确认。设备码用于本次新授权；之后点击“连接”复用已保存授权，不必反复点击“重新 OAuth 授权”。':'使用 PKCE 和本机安全回调。Cloudflare 可自动注册公共客户端，无需填写 Client ID；其他同源 OAuth 服务可填写预注册 ID。服务不支持此流程时会明确报错。',d,'capability-note');
      const f=el('form',undefined,d),clientLabel=el('label','Client ID（可选）',f,'capability-field'),client=el('input',undefined,clientLabel);client.name='clientId';client.maxLength=512;clientLabel.hidden=github;client.type=github?'hidden':'text';
      const scopeLabel=el('label','权限范围（空格分隔）',f,'capability-field'),scope=el('input',undefined,scopeLabel);scope.name='scope';scope.maxLength=4096;scope.value=github?'read:user repo':'';
      el('p',github?'默认 read:user repo：包含个人资料读取及公有、私有仓库的广泛读写权限，不是只读或指定仓库授权；组织可能另需批准。可自行缩小范围。已有授权不会自动增加权限，需重新授权确认。':'留空由服务商授权页选择。仅授予当前任务所需权限；刷新令牌如服务提供将加密保存。',f,'capability-note');
      const message=el('p','点击下方按钮将直接打开系统浏览器并可能注册公共客户端，不再弹出重复确认。令牌仅由本机系统加密保存、不展示给模型；无需选择工作区或开放本地文件写入权限，授权后会连接远程 MCP，跨工作区复用；远程工具每次执行仍需审批。',f,'capability-status');message.setAttribute('role','status');const device=el('strong','',f);device.dataset.oauthCode='true';
      const actions=el('div',undefined,f,'capability-actions'),cancel=button(actions,'取消',()=>{if(running){void call('oauthcancel');message.textContent='正在取消授权…';}else d.close();},'cancel'),start=el('button','打开浏览器授权',actions,'set-btn');start.type='submit';start.dataset.action='oauth-start';let running=false,closed=false,timer;
      const current={lock(){client.disabled=scope.disabled=start.disabled=running||busy||chatBusy;cancel.disabled=false;},destroy(){closed=true;clearTimeout(timer);if(running)void call('oauthcancel');d.remove();}};editor=current;
      async function progress(){if(closed||!running)return;try{const p=await call('oauthstatus');if(p&&!closed){message.textContent=p.message;device.textContent=p.userCode?'设备码：'+p.userCode:'';}}catch{}if(!closed&&running)timer=setTimeout(progress,500);}
      d.oncancel=e=>{if(running){e.preventDefault();void call('oauthcancel');}};d.onclose=()=>{closed=true;clearTimeout(timer);d.remove();if(editor===current)editor=undefined;};
      f.onsubmit=async e=>{e.preventDefault();if(running||busy||chatBusy)return;running=busy=true;lock();void progress();
        try{const result=await window.personalAgentDesktop.capabilities('oauthstart',{...target,clientId:client.value.trim(),scope:scope.value.trim(),revision:config.revision});if(!result?.ok)throw Error(result?.error||'OAuth 失败');if(closed||destroyed)return;message.textContent=result.cancelled?'已取消，未启动授权。':result.data?.connected?'OAuth 授权成功，MCP 已连接。':result.data?.connectionFailed?'OAuth 授权已安全保存，但 MCP 连接失败；可关闭此窗口后重试连接。':'OAuth 授权成功，已安全保存；可关闭此窗口点击连接，无需选择工作区。';device.textContent='';}
        catch(e){if(!closed)message.textContent=e.message+'；本次授权流程未完成，请重试。浏览器回调本身不代表授权已保存。';}
        finally{clearTimeout(timer);running=busy=false;lock();if(!destroyed){await refresh();try{config=await call('mcpget');}catch{}}}
      };d.showModal();(github?start:client).focus();
    }
    async function configurePlugin(pack,connector){
      if(destroyed||busy||chatBusy||editor)return;busy=true;lock();let config;
      try{config=await call('mcpget');}catch(e){status.textContent=e.message;return;}finally{busy=false;lock();}if(destroyed)return;
      const d=el('dialog',undefined,document.body,'capability-dialog');d.dataset.kind='plugin-connect';el('h3','配置 '+pack.id+' / '+connector.key,d);
      el('p','远程地址：'+connector.url,d,'capability-note');el('p','使用你本人授权的 Bearer / PAT。令牌系统加密，不继承 TRAE 登录。保存不会连接；之后点击连接并确认。也可取消此表单，使用卡片上的 OAuth 浏览器授权。',d,'capability-note');
      const f=el('form',undefined,d),label=el('label','访问令牌'+(connector.needsToken?'（必填）':'（可选）'),f,'capability-field'),input=el('input',undefined,label);input.type='password';input.name='token';input.autocomplete='off';input.maxLength=8192;input.required=connector.needsToken;
      const message=el('p','',f,'capability-status'),actions=el('div',undefined,f,'capability-actions'),cancel=button(actions,'取消',()=>d.close(),'cancel'),save=el('button','保存配置',actions,'set-btn');save.type='submit';let saving=false;
      const current={lock(){input.disabled=save.disabled=busy||chatBusy||saving;cancel.disabled=saving;},destroy(){input.value='';d.remove();}};editor=current;
      d.oncancel=e=>{if(saving)e.preventDefault();};d.onclose=()=>{input.value='';d.remove();if(editor===current)editor=undefined;};
      f.onsubmit=async e=>{e.preventDefault();if(busy||chatBusy||saving)return;saving=busy=true;lock();try{await call('pluginconfigure',{packageId:pack.id,connectorKey:connector.key,token:input.value,revision:config.revision});input.value='';d.close();busy=false;await refresh();}catch(e){message.textContent=e.message;}finally{saving=busy=false;lock();}};d.showModal();input.focus();
    }
    async function editJson() {
      if(destroyed || busy || chatBusy || editor)return;
      busy=true;lock();let config;
      try{config=await call('mcpget');}catch(error){status.textContent=error.message;return;}finally{busy=false;lock();}
      if(destroyed)return;
      const dialog=el('dialog',undefined,document.body,'capability-dialog');dialog.dataset.kind='mcp-json';
      el('h3','MCP JSON 配置',dialog);el('p','保存不会连接。凭据回显为 [REDACTED]，保留该值仅对同一服务地址有效；更换地址需重新输入。请勿把含密钥的 JSON 放进项目仓库。',dialog,'capability-note');
      const form=el('form',undefined,dialog),area=el('textarea',undefined,form,'capability-json');area.name='json';area.setAttribute('aria-label','MCP JSON 配置');area.spellcheck=false;area.rows=18;area.maxLength=131072;area.value=config.json;
      const message=el('p','',form,'capability-status');message.setAttribute('role','status');
      const actions=el('div',undefined,form,'capability-actions');let dirty=false,discard=false,saving=false,closed=false;
      const cancel=button(actions,'取消',close,'cancel'),save=el('button','保存',actions,'set-btn set-btn--primary');save.type='submit';save.dataset.action='save';
      const current={lock(){area.disabled=save.disabled=busy||chatBusy||saving;cancel.disabled=saving;},destroy(){closed=true;area.value='';dialog.remove();}};editor=current;
      function close(){if(saving)return;if(dirty&&!discard){discard=true;cancel.textContent='放弃更改';message.textContent='存在未保存配置，再次点击放弃更改关闭。';return;}dialog.close();}
      area.oninput=()=>{dirty=true;discard=false;cancel.textContent='取消';};
      dialog.oncancel=e=>{e.preventDefault();close();};dialog.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}};
      dialog.onclose=()=>{closed=true;area.value='';dialog.remove();if(editor===current)editor=undefined;};
      form.onsubmit=async event=>{event.preventDefault();if(busy||chatBusy||saving)return;
        try{JSON.parse(area.value);}catch{message.textContent='JSON 格式错误，请检查引号、逗号和括号。';return;}
        saving=busy=true;lock();message.textContent='正在验证并保存…';
        try{const saved=await call('mcpsave',{json:area.value,revision:config.revision});if(destroyed||closed)return;area.value=saved.json;dirty=false;dialog.close();busy=false;await refresh();}
        catch(error){if(!closed)message.textContent=error.message;}finally{saving=busy=false;if(!destroyed)lock();}
      };
      dialog.showModal();current.lock();area.focus();
    }
    function edit(existing) {
      if (destroyed || busy || chatBusy || !state?.workspaceRoot || editor) return;
      const root = state.workspaceRoot, dialog = el('dialog', undefined, document.body, 'capability-dialog'); dialog.dataset.kind = kind;
      const heading = el('div', undefined, dialog, 'capability-heading');
      const title = el('h3', (existing ? '编辑' : '添加') + (skills ? '技能' : 'MCP 服务'), heading); title.id = 'capability-editor-title'; dialog.setAttribute('aria-labelledby', title.id);
      const form = el('form', undefined, dialog), fields = {};
      let saving = false, dirty = false, discard = false, closed = false;
      function field(name, label, value, multiline = false) {
        const lab = el('label', label, form, 'capability-field');
        const input = el(multiline ? 'textarea' : 'input', undefined, lab); input.name = name; input.value = value ?? ''; input.autocomplete = 'off';
        if (multiline) input.rows = name === 'prompt' ? 8 : 3;
        input.maxLength = name === 'prompt' ? 16000 : 4096; fields[name] = input; return input;
      }
      const id = field('id', 'ID（字母、数字、短横线或下划线）', existing?.id); id.maxLength = 64; id.required = true;
      if (skills) {
        field('scenarios', '匹配关键词（逗号或换行分隔）', (existing?.scenarios || []).join(', ')).required = true;
        field('prompt', '技能提示词（作为文本发送给模型）', existing?.prompt, true).required = true;
        const priority = field('priority', '优先级', existing?.priority ?? 0); priority.type = 'number'; priority.step = '1';
      } else {
        field('command', '可执行文件绝对路径（不是整条 shell 命令）', existing?.command).required = true;
        field('args', '参数（JSON 字符串数组）', JSON.stringify(existing?.args || [], null, 2), true).required = true;
        field('cwd', '工作目录绝对路径（可留空）', existing?.cwd);
        el('p', '保存配置不会启动进程。之后点击连接，由主进程再次确认启动。暂不提供 env 或密钥字段。', form, 'capability-note');
      }
      const message = el('p', '', form, 'capability-status'); message.setAttribute('role', 'status');
      const actions = el('div', undefined, form, 'capability-actions');
      const cancel = button(actions, '取消', close, 'cancel');
      const save = el('button', '保存', actions, 'set-btn set-btn--primary'); save.type = 'submit'; save.dataset.action = 'save';
      const current = {
        lock() {
          const stale = root !== state?.workspaceRoot;
          form.querySelectorAll('input,textarea,button').forEach(n => { n.disabled = saving || busy || chatBusy; });
          id.disabled ||= !!existing;
          save.disabled ||= stale || !state?.workspaceRoot;
          if (stale) message.textContent = '工作区已改变；草稿保留，但不可保存到另一个工作区。请取消后重新编辑。';
          else if (chatBusy) message.textContent = '聊天执行中，暂不能修改能力。';
        }
      };
      editor = current;
      function close() {
        if (saving || busy) return;
        if (dirty && !discard) { discard = true; cancel.textContent = '放弃更改'; message.textContent = '有未保存更改，再次点击“放弃更改”关闭。'; return; }
        dialog.close();
      }
      form.addEventListener('input', () => { dirty = true; discard = false; cancel.textContent = '取消'; });
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      });
      dialog.addEventListener('close', () => { closed = true; if (editor === current) editor = undefined; dialog.remove(); });
      current.destroy = () => { closed = true; dialog.close(); dialog.remove(); };
      form.onsubmit = async event => {
        event.preventDefault(); if (saving || busy || chatBusy || root !== state?.workspaceRoot) return;
        let payload;
        try {
          if (skills) {
            const scenarios = [...new Set(fields.scenarios.value.split(/[,，\n]+/).map(v => v.trim()).filter(Boolean))];
            const priority = fields.priority.value.trim() === '' ? 0 : Number(fields.priority.value);
            if (!scenarios.length || !Number.isSafeInteger(priority)) throw Error('请输入匹配关键词和整数优先级');
            payload = { skill: { id: id.value.trim(), scenarios, prompt: fields.prompt.value, priority } };
          } else {
            const args = JSON.parse(fields.args.value);
            if (!Array.isArray(args) || args.some(v => typeof v !== 'string')) throw Error('参数必须是 JSON 字符串数组');
            payload = { server: { id: id.value.trim(), command: fields.command.value.trim(), args, ...(fields.cwd.value.trim() ? { cwd: fields.cwd.value.trim() } : {}) } };
          }
        } catch (error) { message.textContent = error instanceof SyntaxError ? '参数不是有效的 JSON 字符串数组' : error.message; return; }
        saving = busy = true; lock(); message.textContent = '正在保存…';
        try {
          await call(skills ? 'skillsave' : 'serversave', payload);
          if (destroyed || closed || editor !== current) return;
          dirty = false; dialog.close(); busy = false; pendingRefresh = false; await refresh();
        } catch (error) { if (!destroyed && !closed && editor === current) message.textContent = error.message; }
        finally { saving = busy = false; if (!destroyed) { lock(); if (pendingRefresh) { pendingRefresh = false; void refresh(); } } }
      };
      current.lock(); dialog.showModal(); id.focus();
    }
    function onBusy(event) { chatBusy = !!event.detail?.busy; lock(); }
    function onWorkspace() {
      if (destroyed) return;
      // Refresh list state, never rebuild the editor or replace its unsaved field values.
      if (!busy) void refresh();
      else { pendingRefresh = true; status.textContent = '工作区状态已变化，操作完成后会重新读取。'; }
    }
    window.addEventListener('chat-busy', onBusy);
    window.addEventListener('workspace-sync', onWorkspace);
    window.addEventListener('workspace-changed', onWorkspace);
    if(local&&catalogueCache){packages=catalogueCache.packages;metadata=catalogueCache.metadata;state={skills:[],servers:[],permission:'write'};render();}
    void refresh();
    return { destroy() {
      destroyed = true; sequence++; editor?.destroy(); editor = undefined;
      window.removeEventListener('chat-busy', onBusy); window.removeEventListener('workspace-sync', onWorkspace); window.removeEventListener('workspace-changed', onWorkspace);
      host.classList.remove('capability-settings'); delete host.dataset.capability;
    } };
  };
})();
