/* Real chat with a text-only safe Markdown subset. */
(function () {
  'use strict';
  // ponytail: a safe Markdown subset, not a full HTML/CommonMark engine. Unknown syntax stays text.
  window.renderReply = function (host, text) {
    host.replaceChildren(); host.classList.add('reply-markdown');
    const paths=new Set();
    const filePath=value=>/\.(?:html?|md|txt|css|js|json|svg)$/i.test(value)&&!/[\n<>|]/.test(value)&&!/^[a-z]+:\/\//i.test(value);
    function fileButton(parent,label,path){const b=document.createElement('button');b.type='button';b.className='deliverable-link';b.textContent=label;b.title='在工作区预览：'+path;b.onclick=()=>window.dispatchEvent(new CustomEvent('deliverable-open',{detail:{path}}));parent.append(b);paths.add(path);}
    function inline(parent, value) {
      const parts = value.split(/(\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\n]+)\)|`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
      for (const part of parts) {
        const link=part.match(/^\[([^\]]+)\]\((?:<([^>]+)>|(.+))\)$/),target=link&&(link[2]||link[3]);
        if(target&&filePath(target))fileButton(parent,link[1],target);
        else if (part.startsWith('`') && part.endsWith('`')) { const value=part.slice(1,-1);if(filePath(value))fileButton(parent,value,value);else{const n = document.createElement('code'); n.textContent = value; parent.append(n);} }
        else if (part.startsWith('**') && part.endsWith('**')) { const n = document.createElement('strong'); n.textContent = part.slice(2, -2); parent.append(n); }
        else parent.append(document.createTextNode(part));
      }
    }
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let fence = '', code = [], paragraph = [], language = '';
    function flush() { if (paragraph.length) { const p = document.createElement('p'); inline(p, paragraph.join('\n')); host.append(p); paragraph = []; } }
    function block() {
      if (language) { const label = document.createElement('div'); label.className = 'code-language'; label.textContent = language; host.append(label); }
      const pre = document.createElement('pre'), n = document.createElement('code'); n.textContent = code.join('\n'); pre.append(n); host.append(pre); code = [];
    }
    const cells=line=>line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(v=>v.trim().replace(/\\\|/g,'|'));
    for (let i=0;i<lines.length;i++) {const line=lines[i];
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { block(); fence = ''; }
        else code.push(line);
      } else if (marker) { flush(); fence = marker[1]; language = marker[2].trim(); }
      else if (!line.trim()) flush();
      else if(/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)){flush();host.append(document.createElement('hr'));}
      else if(line.includes('|')&&lines[i+1]?.includes('|')&&cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){
        flush();const wrap=document.createElement('div'),table=document.createElement('table');wrap.className='reply-table';wrap.append(table);host.append(wrap);
        const row=(value,tag)=>{const tr=document.createElement('tr');for(const cell of cells(value)){const td=document.createElement(tag);inline(td,cell);tr.append(td);}table.append(tr);};
        row(line,'th');i++;while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim())row(lines[++i],'td');
      }
      else {
        const heading = line.match(/^(#{1,6})\s+(.+)$/), item = line.match(/^\s*(?:[-*+] |\d+\. )(.+)$/);
        if (heading || item) { flush(); const n = document.createElement(heading ? 'h' + Math.min(heading[1].length + 1, 6) : 'p'); inline(n, heading ? heading[2] : '• ' + item[1]); host.append(n); }
        else paragraph.push(line);
      }
    }
    if (fence) block(); flush();
    // Tree-style delivery lists are text, but their file leaves can still be opened.
    const leaves=[...String(text).matchAll(/^\s*[├└][─—\s]+([^\n←]+?\.(?:html?|md|txt|svg))(?=\s|$)/gim)].map(m=>m[1].trim());
    if(leaves.length){const bar=document.createElement('div');bar.className='deliverable-list';for(const path of [...new Set(leaves)].slice(0,12))if(!paths.has(path))fileButton(bar,path,path);if(bar.childNodes.length)host.append(bar);}
  };
  window.mountMainChat = function ({ showChat, refreshSessions, api = window.personalAgentDesktop }) {
    const sample = document.querySelector('.chat-list');
    const list = document.createElement('div'); list.className = 'chat-list'; list.id = 'liveChatList'; list.hidden = true; list.style.display = 'none'; sample.after(list);
    const chatScroll = document.getElementById('chatScroll');
    const atBottom = node => node.scrollHeight - node.clientHeight - node.scrollTop <= 4;
    let following = true, followFrame = 0;
    function followBottom() {
      if (followFrame) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = 0;
        if (following) chatScroll.scrollTop = chatScroll.scrollHeight;
      });
    }
    // Follow new output only while the reader remains at the bottom. Wheel intent
    // takes effect before a queued animation frame can pull the reader back down.
    chatScroll.addEventListener('wheel', event => { if (event.deltaY < 0) following = false; }, { passive: true });
    chatScroll.addEventListener('scroll', () => { following = atBottom(chatScroll); }, { passive: true });
    new MutationObserver(followBottom).observe(list, { childList: true, subtree: true, characterData: true });
    new ResizeObserver(followBottom).observe(list);
    let busy = false, started = false, example = false, confirmed = '', title = '', loading = 0;
    const selectors = [], statuses = [], pickers = [], composerActions = new Map();
    const usageBar = document.createElement('div'); usageBar.className = 'composer-usage';
    usageBar.setAttribute('role', 'status'); usageBar.setAttribute('aria-label', '当前会话模型用量');
    const usageFields = new Map();
    const iconPaths = { speed:'M3 16a9 9 0 1 1 18 0M12 14l5-6', tokens:'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0', context:'M12 3a9 9 0 1 1-9 9M3 12a9 9 0 0 1 9-9' };
    for (const metric of ['turns','speed','tokens','cache','context']) {
      const item = document.createElement('span'); item.className = 'usage-item'; item.dataset.metric = metric;
      if (iconPaths[metric]) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'), path = document.createElementNS('http://www.w3.org/2000/svg','path');
        svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); path.setAttribute('d',iconPaths[metric]); svg.append(path); item.append(svg);
      }
      const value = document.createElement('span'); item.append(value); usageFields.set(metric,{item,value}); usageBar.append(item);
    }
    function renderUsage(summary) {
      const u = summary || {}, number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      const compact = n => !number(n) ? '—' : n >= 1e6 ? (n/1e6).toFixed(1).replace(/\.0$/,'')+'M' : n >= 1e3 ? (n/1e3).toFixed(1).replace(/\.0$/,'')+'K' : String(n);
      const values = {
        turns: [`${number(u.turns) ? u.turns : 0} 轮 ${number(u.steps) ? u.steps : 0} 步`, '当前会话已记录的用户轮次与模型回复步数（含工具调用步骤）'],
        speed: [`${number(u.tokensPerSecond) ? u.tokensPerSecond.toFixed(1) : '—'} tok/s`, '最近一次已记录模型请求的平均输出速度，包含网络与等待时间，不是纯生成速度'],
        tokens: [`${compact(u.totalTokens)} tok${u.partial ? ' *' : ''}`, `会话累计输入 ${compact(u.inputTokens)} / 输出 ${compact(u.outputTokens)} tokens；${u.partial ? '部分请求未返回用量，星号表示统计不完整' : '仅统计已记录的服务商用量'}`],
        cache: [`缓存命中 ${number(u.cacheHitPercent) ? u.cacheHitPercent.toFixed(0)+'%' : '—'}`, '服务商返回的缓存输入 tokens / 输入 tokens；缺失数据时不推算'],
        context: [`上下文 ${number(u.contextPercent) ? u.contextPercent.toFixed(0)+'%' : '—'}`, '未配置可靠的模型上下文窗口，暂不估算占比']
      };
      for (const [key,[text,title]] of Object.entries(values)) { const field = usageFields.get(key); field.value.textContent = text; field.item.title = title; }
    }
    renderUsage();
    function syncPickers() { pickers.forEach(picker => picker.sync()); }
    let selectedValue = '', sending = false, stopping = false, requestDispatched = false, backgroundJobs = 0, stopRequest, stopConfirmed=false, stopUncertain=false;
    for (const id of ['taHome', 'taChat']) {
      const input = document.getElementById(id), row = document.createElement('div');
      input.addEventListener('input', () => lock());
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;flex-wrap:wrap';
      const label = document.createElement('div'); label.className = 'composer-model-picker';
      const select = document.createElement('select'); select.id = id + 'Model'; select.className = 'set-sel'; select.style.maxWidth = '100%'; label.append(select); row.append(label);
      const statusNode = document.createElement('span'); statusNode.setAttribute('role', 'status'); statusNode.style.cssText = 'font-size:12px;color:var(--text-secondary)'; row.append(statusNode);
      row.className = 'composer-model'; row.style.cssText = ''; statusNode.className = 'composer-status';
      const composer = input.closest('.composer'); composer.querySelector('.send').before(row);
      if (id === 'taChat') { list.after(statusNode); composer.append(usageBar); }
      else composer.prepend(statusNode);
      selectors.push(select); statuses.push(statusNode); input.maxLength = 8192;
      pickers.push(window.enhancePicker(select, { kind: 'model', label: '选择模型', searchable: true }));
      composerActions.set(input, window.mountComposerActions(input, { onChange: lock, onStatus: status }));
      select.onchange = async () => {
        const value = select.value, previous = selectedValue;
        if (busy || value === previous) { selectors.forEach(s => { s.value = previous; }); syncPickers(); return; }
        selectors.forEach(s => { s.value = value; }); syncPickers();
        if (!started) {
          selectedValue = value; confirmed = ''; await updateDestination().catch(() => {}); return;
        }
        busy = true; lock(); status('确认模型切换…');
        try {
          const preview = await api.getProvider(value ? JSON.parse(value) : undefined);
          const result = await api.switchChatModel(preview.token);
          if (result.changed) {
            confirmed = result.identity; selectedValue = value; await updateDestination().catch(() => {});
            status('模型已切换 · 历史与当前权限保留');
            window.dispatchEvent(new Event('workspace-sync')); await refreshSessions().catch(() => {});
          } else { selectors.forEach(s => { s.value = previous; }); status('已取消切换，模型与历史未改变'); }
        } catch (_) { selectors.forEach(s => { s.value = previous; }); status('切换失败或配置已变化，原会话未切换；请重试'); }
        finally { busy = false; lock(); }
      };
    }
    function status(text) { statuses.forEach(s => { s.textContent = text; }); }
    function toolLabel(name){return ({create_goal:'创建目标',get_goal:'查看目标',update_goal:'更新目标',update_task_state:'更新任务状态',create_file:'创建文件',write_file:'写入文件',patch_file:'修改文件',edit_file:'编辑文件',read_file:'读取文件',inspect_file:'检查文件',list_directory:'列出目录',run_command:'执行命令',job_list:'查看后台任务',job_output:'读取任务输出',job_kill:'停止后台任务',skill_read:'读取技能',web_search:'搜索网页',web_fetch:'读取网页'})[name]||name||'工具';}
    api?.onChatActivity?.(e => { if (busy) { processActivity(e);if(e.type==='long-task')taskBars.forEach(b=>{b.hidden=false;b.textContent=`任务 ${e.round}/${e.maxRounds||'不限'} 轮 · 点击暂停`;});status(e.type === 'long-task' ? `长任务第 ${e.round}/${e.maxRounds||'不限'} 轮已返回，可随时停止` : e.type === 'model' ? '正在请求模型…' : `工具 ${toolLabel(e.name)} · ${e.type === 'tool-start' ? '执行中' : e.isError ? '失败/拒绝' : '完成'}`); } });
    const pendingCards = new Map();
    function toolEvidence(card,kind,value){
      card.body.querySelector('[data-placeholder]')?.remove();let section=card.body.querySelector(`[data-kind="${kind}"]`);
      if(!section){section=document.createElement('section');section.dataset.kind=kind;const label=document.createElement('h4'),pre=document.createElement('pre');label.textContent=kind==='call'?`请求参数 · ${card.name}`:'执行结果';section.append(label,pre);card.body.append(section);}
      section.querySelector('pre').textContent=String(value??'')||(kind==='result'?'工具已返回，无文本输出。':'无参数。');
    }
    function toolMessage(item, turn) {
      if(turn){
        const key=item.callId;let card=key?pendingCards.get(key):null;
        if(!card||!turn.root.contains(card.root)){card=turn.step({name:toolLabel(item.name),status:'queued'});card.name=item.name;card.root.dataset.callId=key||'';if(key)pendingCards.set(key,card);}
        toolEvidence(card,item.kind,item.kind==='call'?item.arguments:item.content);
        if(item.kind==='result'){card.body.querySelector('[data-placeholder]')?.remove();const interrupted=turn.root.dataset.state==='stopped'&&item.isError&&card.step.status!=='failed'&&/^(?:cancelled|aborted|已取消|已停止)/i.test(String(item.content??''));card.update(interrupted?'stopped':item.isError?'failed':'done',`${toolLabel(card.name)} · ${interrupted?'已停止':item.isError?'失败/拒绝':'已完成'}`);if(key)pendingCards.delete(key);}
        return;
      }
    }
    async function updateDestination() {
      syncPickers();
      const value = selectors[0].value;
      const r = await api.providerSettings('list');
      if (!r.ok || selectors[0].value !== value) return;
      const chosen = value ? JSON.parse(value) : null;
      const provider = r.data.providers.find(p => p.id === chosen?.id);
      selectors.forEach(s => { s.title = provider ? '发送到 ' + provider.baseUrl + ' · 消息及已启用工具读取的文件会发送到此服务并保存本地历史；可能计费' : '使用 CLI / 环境模型配置'; });
      syncPickers();
    }
    async function open(id) {
      if (busy) return false;
      busy = true; lock(); status('读取会话…');
      try {
        const saved = await api.openChat(id);
        renderUsage(saved.usageSummary);
        composerActions.forEach(actions => actions.clear());
        title = saved.title; started = true; confirmed = saved.identity; backgroundJobs = saved.backgroundJobs || 0;
        const value = saved.selection ? JSON.stringify(saved.selection) : '';
        selectors.forEach(s => { s.value = value; }); selectedValue = value;
        await updateDestination().catch(() => {}); list.replaceChildren(); pendingCards.clear();
        const calls = new Map();let turn;
        for (const m of saved.messages) {
          if(m.role==='user'){message('你',m.content);turn=null;continue;}
          if(!['assistant','tool'].includes(m.role))continue;
          if(!turn)turn=new window.AgentTurn({mount:list,historical:true});
          if (m.toolCalls) for (const c of m.toolCalls) { calls.set(c.id, c.name); toolMessage({kind:'call',callId:c.id,name:c.name,arguments:c.arguments},turn); }
          if (m.role === 'tool') { toolMessage({kind:'result',callId:m.toolCallId,name:calls.get(m.toolCallId),content:m.content,isError:m.isError},turn); continue; }
          if(m.content){if(m.toolCalls?.length){const p=turn.step({name:'过程说明',status:'done'});p.append(m.content);}else{const n=turn.answer();window.renderReply(n,m.content);turn.finish('done');turn.actions(n);}}
        }
        if(saved.failed||saved.pendingTools){if(!turn)turn=new window.AgentTurn({mount:list,historical:true});turn.finish('idle');turn.label.textContent='上轮未完成 · 原因和耗时未记录';turn.alert('历史记录未区分主动停止与请求失败，请查看工具证据；不推测终态。','warn');}
        showLive(); status(saved.workspaceError || (!saved.canResume ? '模型配置不可用或历史只读；原会话保留，请确认模型配置' : saved.failed || saved.pendingTools ? '上轮未完成；可继续发送。缺失工具结果会标记未知，不重跑旧操作，也不新建会话' : ''));
        window.dispatchEvent(new Event('workspace-sync'));void refreshTask(); return true;
      } catch (_) { status('会话读取失败；原文件保留'); return false; }
      finally { busy = false; lock(); }
    }
    function lock() {
      selectors.forEach(s => { s.disabled = busy; }); syncPickers();
      composerActions.forEach(actions => actions.setBusy(busy));
      for (const id of ['taHome', 'taChat']) document.getElementById(id).disabled = busy;
      for (const id of ['sendHome', 'sendChat']) {
        const button = document.getElementById(id);
        button.disabled = busy && (!sending || stopping);
        const draftInput = document.getElementById(id === 'sendHome' ? 'taHome' : 'taChat');
        const hasDraft = !!draftInput.value.trim() || hasAttachments(draftInput);
        const stoppable = sending || (backgroundJobs > 0 && !hasDraft);
        button.dataset.action = stoppable ? 'stop' : 'send';
        button.title = stopping ? '正在停止' : sending ? '停止' : stoppable ? '停止后台任务' : '发送';
        button.setAttribute('aria-label', button.title);
        button.querySelector('use').setAttribute('href', stoppable ? '#i-stop' : '#i-arrow-up');
        button.classList.toggle('is-ready', stoppable || hasDraft);
      }
      document.getElementById('btnNew').disabled = busy;
      window.dispatchEvent(new CustomEvent('chat-busy', { detail: { busy } }));
    }
    function stop() {
      if ((!sending && !backgroundJobs) || stopping) return;
      stopping = true; lock(); status('正在停止；已执行的文件变更不会回滚');
      if (!sending) {
        busy = true; lock();
        void api.stopChat().then(() => { backgroundJobs = 0; status('后台任务已停止，已完成操作保留'); })
          .catch(() => status('无法确认后台进程已停止，请检查任务记录'))
          .finally(() => { busy = stopping = false; lock(); });
      } else if (requestDispatched) stopRequest = api.stopChat().then(result => {stopConfirmed=result?.ok===true&&result?.stopped===true;stopUncertain=!stopConfirmed;backgroundJobs=stopConfirmed?0:backgroundJobs;}).catch(() => {
        stopUncertain=true;
        backgroundJobs = Math.max(1, backgroundJobs);
        status('无法确认进程清理完成，请检查任务记录；不会声称已全部停止');
      });
    }
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (sending || backgroundJobs)) { e.preventDefault(); stop(); }
    }, true);
    async function load() {
      const sequence = ++loading;
      if (!api) { status('请在桌面客户端中配置模型'); return; }
      try {
        const r = await api.providerSettings('list');
        if (sequence !== loading) return;
        if (!r.ok) throw Error(r.error);
        const old = selectors[0].value;
        selectors.forEach(s => {
          const environment = new Option('CLI / 环境配置', ''); environment.dataset.label = '环境配置'; environment.dataset.detail = 'CLI 默认';
          s.replaceChildren(environment);
          r.data.providers.forEach(p => p.models.forEach(m => {
            const option = new Option(p.name + ' / ' + m, JSON.stringify({ id: p.id, model: m }));
            option.dataset.label = m; option.dataset.detail = p.name; s.add(option);
          }));
          s.value = Array.from(s.options).some(o => o.value === old) && old ? old : s.options[1]?.value || '';
        });
        selectedValue = selectors[0].value; status(''); lock(); await updateDestination().catch(() => {});
      } catch (_) { status('模型列表读取失败，请重新打开客户端或检查设置'); }
    }
    let liveStream;
    function processPanel(live){
      if(live.process)return live.process;
      live.process=live.turn.step({name:'思考中 · 服务商返回的推理',thinking:true,status:'queued'});live.node.closest('.agent-answer').before(live.process.root);return live.process;
    }
    function settleStep(live,interrupted=false){
      if(live.reasonNode)live.reasonNode.textContent=live.reasoning;
      if(live.process&&live.process.step.status==='queued')live.process.update(interrupted?'stopped':'done',interrupted?'思考中断 · 未完成':'已思考');
      for(const card of live.tools.values())if(card.step.status==='queued'){card.update(interrupted?'stopped':'queued',`${toolLabel(card.name)} · ${interrupted?'参数未完成，未执行':'参数已接收，等待执行'}`);}
      live.turn.stream(live.node,live.text,false);
    }
    function processActivity(e){const live=liveStream;if(!live||stopping)return;
      if(e.type==='model'){live.turn.setState('thinking');return;}
      if(!['tool-start','tool-end'].includes(e.type))return;
      let card=e.callId?pendingCards.get(e.callId):null;
      if(!card){card=[...live.tools.values()].find(c=>!c.root.dataset.callId&&c.name===e.name);
        if(!card)card=live.turn.step({name:toolLabel(e.name)});
        card.name=e.name;card.root.dataset.callId=e.callId||'';if(e.callId)pendingCards.set(e.callId,card);
      }
      if(e.arguments!==undefined)toolEvidence(card,'call',e.arguments);
      if(e.content!==undefined)toolEvidence(card,'result',e.content);
      const state=e.type==='tool-start'?'running':e.isError?'failed':'done';
      card.update(state,`${toolLabel(card.name)} · ${state==='running'?'执行中':state==='failed'?'失败/拒绝':'已完成'}`);
      if(state==='running'){live.turn.setState('running');if(!card.body.textContent){card.append('正在执行，等待工具结果…');card.body.lastChild.dataset.placeholder='true';}}else{card.body.querySelector('[data-placeholder]')?.remove();if(!card.body.querySelector('[data-kind="result"]'))toolEvidence(card,'result','工具已结束，执行详情尚未同步；本轮结束后补齐。');}
    }
    function finishProcess(live,state,info={}){if(!live)return;settleStep(live,state!=='done');clearInterval(live.timer);if(live.frame)cancelAnimationFrame(live.frame);live.turn.finish(state,info);}
    function streamStatus(){const live=liveStream;if(!live||stopping)return;
      for(const card of live.turn.steps)if(card.step.status==='running'||card.step.status==='queued')card.update(card.step.status);
      if(live.complete)return;const p=live.progress;
      status(p?`已收 ${p.bytes} 字节 · 正文 ${p.textChars} / 思考 ${p.reasoningChars} / 工具参数 ${p.toolChars} 字符（非tokens） · 距上次数据 ${Math.max(0,Math.floor((Date.now()-p.lastDataAt)/1000))} 秒 · 未完成，可停止`:'等待服务商返回数据 · 可随时停止（本次连接等待上限 180 秒，非任务期限）');
    }
    api?.onChatStream?.(e=>{
      const live=liveStream;if(!live||!sending||stopping||e.token!==live.token)return;
      if(e.start){
        if(live.id){
          if(live.frame){cancelAnimationFrame(live.frame);live.frame=0;}
          settleStep(live,!live.complete);
          const previous=live.node.closest('.agent-answer');
          if(live.text&&!following){
            // Keep the text being read in place: converting it to a collapsed or
            // 320px-capped card shrinks the page and clamps the reader to bottom.
            const label=document.createElement('p');label.className='process-preview-label';
            label.textContent=live.retrying?'中断预览 · 非完成证据':'过程说明';
            previous.prepend(label);
          }else{
            if(live.text){const commentary=live.turn.step({name:live.retrying?'中断预览 · 非完成证据':'过程说明',status:live.retrying?'stopped':'done'});commentary.append(live.text);previous.before(commentary.root);}
            previous.remove();
          }
          live.node=live.turn.answer('正在接收模型回复…');
        }
        live.retrying=false;live.id=e.responseId;live.text='';live.reasoning='';live.reasonNode=null;live.process=null;live.tools=new Map();live.progress=undefined;live.complete=false;live.node.textContent='正在接收模型回复…';live.turn.setState('thinking');streamStatus();return;
      }
      if(e.responseId!==live.id)return;
      if(e.retry){if(live.frame){cancelAnimationFrame(live.frame);live.frame=0;}settleStep(live,true);live.complete=true;live.node.textContent=live.text?live.text+'\n【本次预览中断，重试将重新生成】':'';const note=document.createElement('p');note.className='retry-note';note.textContent=e.retry.reason==='length'?'本次回复达到输出上限 · 已丢弃截断的工具调用，关闭思考重新生成本次请求 1/1（可能额外计费，可停止；此前完成的工具不重跑）':`连接暂时失败 · ${e.retry.delayMs/1000}秒后重试 ${e.retry.attempt}/2（可能额外计费，可停止）`;live.turn.body.append(note);live.retrying=true;status(note.textContent);return;}
      if(e.progress)live.progress=e.progress;
      if(e.complete){live.complete=true;settleStep(live);status('模型回复已校验，正在处理后续步骤…');}
      else streamStatus();
      if(e.tool){let card=live.tools.get(e.tool.index);if(!card){card=live.turn.step({name:toolLabel(e.tool.name),status:'queued'});card.append('模型正在生成工具参数；接收完整后展示参数与执行结果。此时尚未执行。');card.body.lastChild.dataset.placeholder='true';live.tools.set(e.tool.index,card);}card.name=e.tool.name;card.summary.textContent=`${toolLabel(e.tool.name)} · 接收参数 ${e.tool.argumentChars} 字符，尚未执行`;}
      if(e.reasoning){const p=processPanel(live);if(!live.reasonNode){const pre=document.createElement('pre');pre.className='provider-reasoning';p.body.append(pre);live.reasonNode=pre;}
        live.reasoning=(live.reasoning+e.reasoning).slice(-24000);}
      if(!e.text&&!e.reasoning)return;
      live.text+=e.text||'';
      if(e.text)live.turn.setState('streaming');
      if(!live.frame)live.frame=requestAnimationFrame(()=>{
        live.frame=0;if(liveStream!==live)return;
        const followReasoning=live.reasonNode&&atBottom(live.reasonNode);
        live.turn.stream(live.node,live.text||'正在思考，尚未收到正文…',!!live.text&&!live.complete);
        if(live.reasonNode){
          live.reasonNode.textContent=(live.progress?.reasoningChars>24000?'【仅显示最近24000字符】\n':'')+live.reasoning;
          if(followReasoning)live.reasonNode.scrollTop=live.reasonNode.scrollHeight;
        }
        streamStatus();followBottom();
      });
    });
    function message(role, text) {
      const row = document.createElement('div'); row.className = 'msg msg--' + (role === '你' ? 'user' : role === '工具' ? 'tool' : 'agent');
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', role);
      const body = document.createElement('div'); body.className = 'msg-body';
      const content = document.createElement('div'); content.className = 'message-content'; content.textContent = text; body.append(content); row.append(body); list.append(row);
      followBottom();
      return content;
    }
    function showLive() { sample.hidden = true; sample.style.display = 'none'; list.hidden = false; list.style.display = 'flex'; showChat(title, true); }
    function hasAttachments(input) { return composerActions.get(input)?.hasFiles() === true; }
    async function send(text, input, taskRevision) {
      if (busy) return;
      if (example) example = false;
      if (!api) { status('请启动桌面客户端'); return; }
      let prompt;
      try { prompt = composerActions.get(input)?.getPrompt(text) ?? text; } catch (error) { status(error.message); return; }
      if (!prompt.trim() || new TextEncoder().encode(prompt).length > 8192) { status('正文与附件合计须为 1–8192 UTF-8 字节，请缩短内容或移除附件'); return; }
      // Only the explicit new-chat action resets identity; failures remain this conversation.
      busy = sending = true; stopping = requestDispatched = stopConfirmed = stopUncertain = false;stopRequest=undefined; lock(); status('读取模型配置…');
      let reply, sent = false;
      try {
        const value = selectors[0].value;
        const preview = await api.getProvider(value ? JSON.parse(value) : undefined);
        if (stopping) { status('已停止，未发送模型请求'); return; }
        const identity = JSON.stringify([preview.providerId, preview.baseUrl, preview.model, preview.revision]);
        if (started && confirmed !== identity) {
          const switched = await api.switchChatModel(preview.token);
          if (stopping) { status('已停止，未发送模型请求'); return; }
          if (!switched.changed) { status('未确认模型变化，原会话保留'); return; }
          confirmed = switched.identity; window.dispatchEvent(new Event('workspace-sync'));
          const renewed = await api.getProvider(value ? JSON.parse(value) : undefined);
          if (JSON.stringify([renewed.providerId, renewed.baseUrl, renewed.model, renewed.revision]) !== confirmed) throw Error('配置已变化');
          Object.assign(preview, renewed);
        } else if (!started) { confirmed = identity; }
        if (stopping) { status('已停止，未发送模型请求'); return; }
        if (!started) { list.replaceChildren(); pendingCards.clear(); title = (text.trim() || '文本附件').slice(0, 24); }
        showLive(); message('你', prompt); const turn=new window.AgentTurn({mount:list});turn.setState('thinking');reply=turn.answer('正在回复…');
        input.value = ''; input.style.height = 'auto';
        status('执行中 · 不设任务总时限或花费上限 · 可停止模型与当前会话任务'); sent = true; started = true;
        liveStream={turn,token:preview.token,node:reply,id:'',text:'',reasoning:'',panels:[],tools:new Map(),frame:0,timer:setInterval(streamStatus,1000)};
        requestDispatched = true;
        const response = taskRevision===undefined?api.sendChat(prompt, preview.token):api.sendTask(prompt, preview.token, taskRevision);
        composerActions.get(input)?.clear();
        const result = await response;
        if(stopRequest)await stopRequest;
        const partial=liveStream?.text||'';reply=liveStream?.node||reply;const state=stopConfirmed?'stopped':result.error?'failed':'done';finishProcess(liveStream,state,{tokens:typeof result.usageSummary?.totalTokens==='number'?`会话累计 ${result.usageSummary.totalTokens} tokens${result.usageSummary.partial?'（不完整）':''}`:'用量未报告'});liveStream=undefined;
        if(state!=='done')turn.alert(stopConfirmed?'用户已停止。已执行操作保留，不会回滚。':result.error,'stopped'===state?'warn':'error');
        renderUsage(result.usageSummary);
        backgroundJobs = result.backgroundJobs || 0;
        if (result.transcript?.length) result.transcript.forEach(item=>toolMessage(item,turn));
        if(result.error){
          if(partial){const preview=turn.step({name:'中断预览 · 非完成证据',status:'stopped'});preview.append(partial);reply.closest('.agent-answer').before(preview.root);}
          reply.textContent=stopConfirmed?'已停止，已完成操作保留。':'本轮未完成，可检查证据后继续。';
          if(!stopConfirmed&&!turn.steps.some(c=>c.step.status==='failed')){const failed=turn.step({name:'模型请求失败',status:'failed'});failed.append(result.error);}
        }else window.renderReply(reply, result.content);
        if(stopUncertain)turn.alert('停止请求未获确认；本轮状态以返回结果为准，后台清理情况请检查任务记录。','warn');
        turn.refold();turn.actions(reply);
        const evidence = result.toolStatus;
        const toolNotice = !evidence?.offered.length ? '未选择工作区，本次为文字问答' : evidence.requested === 0 ? '工具已按当前权限提供；本次模型没有调用工具' : `工具请求 ${evidence.requested} 次 · 成功 ${evidence.completed} · 失败/拒绝 ${evidence.failed}`;
        status((result.recoveredTools ? `已补齐 ${result.recoveredTools} 个工具结果（已记录结果或未知错误，未重跑） · ` : '') + (stopConfirmed ? '已停止 · 原会话和已执行操作保留' : result.error ? '请求未完成 · 原会话保留，可继续发送；已执行操作不回滚' : '已保存 · ' + toolNotice));
        followBottom();
        await refreshSessions().catch(() => {});
      } catch (_) {
        if(stopRequest)await stopRequest;
        const partial=liveStream?.text||'',turn=liveStream?.turn;reply=liveStream?.node||reply;finishProcess(liveStream,stopConfirmed?'stopped':'failed');liveStream=undefined;
        if(partial&&reply){reply.textContent=partial+'\n\n【未完成预览，未作为完整回复保存】';reply=turn?turn.answer(''):message('Personal Agent','');}
        if(turn){turn.alert(stopConfirmed?'用户已停止。已执行操作保留。':stopUncertain?'停止未获确认；本轮请求失败，请检查已执行操作和后台任务。':'本轮请求失败；已执行操作保留，请检查下方说明。',stopConfirmed||stopUncertain?'warn':'error');turn.actions(reply);}
        if (sent && reply) reply.textContent = stopConfirmed ? '已停止本轮请求。已保存的消息和工具操作保留，不会自动重试或回滚；可以在此继续发送。' : '请求失败，可能已计费或执行部分工具。请检查历史和文件；临时模型请求可能已有限重试，但不会自动重跑工具或回滚；原会话保留，可继续发送。若补齐了中断状态，可在工具历史查看。';
        status(stopConfirmed ? '已停止，原会话和已保存记录保留' : sent ? '请求失败，原会话和历史保留；可继续发送' : '模型配置不可用或已变化，请检查设置后重试');
        if (sent) {
          await refreshSessions().catch(() => {});
          // Read-only refresh: reopening here would revoke current workspace permissions.
          try { const chats = await api.listChats(); if (chats.activeSessionId) renderUsage((await api.readHistory(chats.activeSessionId)).usageSummary); } catch (_) { /* Keep the last verified summary. */ }
        }
      } finally {
        await stopRequest; stopRequest = undefined;
        busy = sending = stopping = requestDispatched = false; lock();void refreshTask();
      }
    }
    const taskBars=[];
    const taskLabels={ready:'待启动',running:'运行中',paused:'已暂停',review:'待验收',completed:'已结束'};
    async function refreshTask(){if(!api)return;try{const r=await api.task('get');const t=r.ok?r.data.task:null;taskBars.forEach(b=>{b.hidden=!t;b.textContent=t?`持续任务 · ${taskLabels[t.status]} · 已运行 ${t.rounds} 轮${t.plan&&!t.planApproved?' · 计划待确认':''} · 查看`:'计划 / 长任务';b.title=t?`${t.objective}\n${busy?'点击暂停当前执行':'点击查看计划、恢复或结束任务'}`:'';});}catch{}}
    async function taskPanel(){
      if(busy){status('请先停止当前运行');return;}
      const d=document.createElement('dialog');d.className='capability-dialog';d.dataset.kind='task';const heading=document.createElement('h3'),note=document.createElement('p'),progress=document.createElement('pre'),objective=document.createElement('textarea'),rounds=document.createElement('input'),label=document.createElement('label'),roundLabel=document.createElement('label'),save=document.createElement('button'),run=document.createElement('button'),finish=document.createElement('button'),close=document.createElement('button');
      const criteria=document.createElement('textarea'),plan=document.createElement('textarea'),criteriaLabel=document.createElement('label'),planLabel=document.createElement('label'),remove=document.createElement('button');
      criteria.name='criteria';criteria.rows=3;plan.name='plan';plan.rows=8;criteriaLabel.textContent='验收条件';planLabel.textContent='计划（修改后需重新确认）';criteriaLabel.className=planLabel.className='capability-field';criteriaLabel.append(criteria);planLabel.append(plan);remove.type='button';remove.className='set-btn';remove.textContent='删除任务记录';
      const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};
      d.classList.add('task-dialog');const previousFocus=document.activeElement;heading.id='task-panel-title';d.setAttribute('aria-labelledby',heading.id);
      const header=node('header','task-dialog-header'),titles=node('div',''),body=node('div','task-dialog-body'),footer=node('footer','task-dialog-footer'),secondary=node('div','task-secondary-actions'),primary=node('div','task-primary-actions');
      heading.textContent='计划 / 长任务';titles.append(heading,node('p','task-subtitle','先明确目标，再按计划推进。'));close.textContent='×';close.type='button';close.className='task-dialog-close';close.setAttribute('aria-label','关闭计划与长任务');header.append(titles,close);
      const stateCard=node('section','task-state'),badge=node('span','task-badge','未创建'),counter=node('span','task-counter'),stateHead=node('div','task-state-heading');stateHead.append(badge,counter);progress.className='task-progress';progress.setAttribute('role','status');stateCard.append(stateHead,progress);
      label.className=roundLabel.className='capability-field';label.textContent='任务目标';objective.name='objective';objective.rows=3;objective.placeholder='描述希望完成的结果，也可以先让 Agent 自动制定。';label.append(objective);criteria.rows=2;criteria.placeholder='例如：指定测试全部通过，且不删除或削弱现有断言。';plan.rows=5;plan.placeholder='实施步骤、影响范围与风险；修改后需重新确认。';
      const planDetails=node('details','task-details'),planSummary=node('summary','','执行计划');planDetails.append(planSummary,planLabel);
      const budget=node('div','task-budget');roundLabel.textContent='累计轮数上限';rounds.name='maxRounds';rounds.type='number';rounds.min='0';rounds.max='20';rounds.value='0';roundLabel.append(rounds);budget.append(roundLabel,node('p','task-budget-hint','0 = 不限；可主动设为 1–20 轮\n无任务总时限或花费上限，可随时停止'));
      const options=node('details','task-details task-options'),optionsSummary=node('summary','','预算与安全说明');note.textContent='续跑可能持续计费。计划确认前只读，预算不会提高操作权限；停止或重启后需手动恢复。模型报告完成不等于独立验收。';note.className='task-safety';options.append(optionsSummary,budget,note);
      save.textContent='保存目标';run.textContent='启动 / 恢复';finish.textContent='人工确认完成';[save,run,finish].forEach(b=>{b.className='set-btn';b.type='button';});run.classList.add('task-primary');remove.classList.add('task-danger');secondary.append(finish,remove);primary.append(save,run);footer.append(secondary,primary);body.append(stateCard,label,criteriaLabel,planDetails,options);d.append(header,body,footer);document.body.append(d);d.showModal();close.focus();d.onclose=()=>{d.remove();if(previousFocus?.isConnected)previousFocus.focus();};close.onclick=()=>d.close();let current,loading=false,dirty=false;
      function lockPanel(){const t=current?.task;for(const field of [objective,criteria,plan,rounds])field.disabled=loading||t?.status==='completed';save.disabled=loading||!current||t?.status==='completed';run.disabled=loading||dirty||!t||t.status==='completed'||(t.maxRounds>0&&t.rounds>=t.maxRounds);finish.disabled=loading||dirty||!t||t.status==='completed';remove.disabled=loading||!t;}
      function render(data){current=data;dirty=false;const t=data.task;objective.value=t?.objective||'';rounds.value=String(t?.maxRounds??0);criteria.value=t?.criteria||'';plan.value=t?.plan||'';planDetails.open=!!t?.plan;badge.textContent=t?(t.plan&&!t.planApproved?'计划待确认':taskLabels[t.status]):'未创建';counter.textContent=t?`${t.rounds} / ${t.maxRounds||'不限'} 轮`:'';run.textContent=t?.plan&&!t.planApproved?'确认计划并执行':'启动 / 恢复';run.title='';progress.textContent=t?[t.reason,t.checkpoint||'目标已保存，尚无执行进度。'].filter(Boolean).join('\n'):'尚未保存目标';secondary.hidden=!t;lockPanel();}
      async function action(name,payload={}){if(loading)return;loading=true;lockPanel();try{const r=await api.task(name,{...payload,revision:current?.revision});if(!r.ok)throw Error(r.error);render(r.data);}catch(e){progress.textContent=e.message;badge.textContent='暂不可操作';}finally{loading=false;lockPanel();void refreshTask();}}
      for(const field of [objective,criteria,plan,rounds])field.addEventListener('input',()=>{dirty=true;lockPanel();badge.textContent='有未保存修改';run.title='先保存修改，再确认执行';});remove.onclick=()=>action('remove');save.onclick=()=>action('configure',{objective:objective.value,criteria:criteria.value,plan:plan.value,maxRounds:Number(rounds.value)});finish.onclick=()=>action('finish');run.onclick=()=>{const revision=current.revision;d.close();const input=document.getElementById(started?'taChat':'taHome');void send('继续已保存的长任务目标',input,revision);};await action('get');
    }
    window.addEventListener('open-task-plan',()=>{void taskPanel();});
    for(const id of ['taHome','taChat']){const b=document.createElement('button');b.type='button';b.className='task-status-chip';b.hidden=true;b.dataset.action='task-plan';b.onclick=()=>busy?stop():taskPanel();taskBars.push(b);document.getElementById(id).closest('.composer').prepend(b);}
    async function reset() {
      if (busy) { status('请求进行中，请等待完成后新建任务'); return false; }
      busy = true; lock();
      try {
        if (api) await api.resetChat();
        renderUsage();
        composerActions.forEach(actions => actions.clear());
        started = example = false; backgroundJobs = 0; confirmed = ''; title = ''; list.replaceChildren(); pendingCards.clear();
        document.getElementById('taHome').value = ''; document.getElementById('taChat').value = '';
        sample.hidden = false; sample.style.display = 'flex'; list.hidden = true; list.style.display = 'none';
        await load();void refreshTask(); return true;
      } catch (_) { status('新建失败，请等待当前模型请求完成'); return false; }
      finally { busy = false; lock(); }
    }
    window.addEventListener('providers-changed', () => {
      if (started) { status('配置已更新；下一次发送需确认模型变化，原会话保留'); } else if (!busy) { confirmed = ''; void load(); }
    });
    busy = true; lock();
    void (async () => { try { await load(); const active = await api?.listChats(); busy = false; if (active?.activeSessionId && !started) await open(active.activeSessionId); } catch { status('会话恢复失败；历史未更改，请从侧栏重新打开'); } finally { busy = false; lock(); } })();
    return { send, reset, open, renameTitle(value) { title = value; if (started) showLive(); }, clearDeleted() { renderUsage(); composerActions.forEach(actions => actions.clear()); started = example = false; backgroundJobs = 0; confirmed = ''; title = ''; list.replaceChildren(); pendingCards.clear(); document.getElementById('taHome').value = ''; document.getElementById('taChat').value = ''; status(''); lock(); }, hasAttachments, isBusy: () => busy, showExample() { example = true; status('原型示例 · 请新建任务开始真实聊天'); sample.hidden = false; sample.style.display = 'flex'; list.hidden = true; list.style.display = 'none'; }, stop };
  };
})();
