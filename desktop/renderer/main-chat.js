/* Real chat with a text-only safe Markdown subset. */
(function () {
  'use strict';
  // ponytail: a safe Markdown subset, not a full HTML/CommonMark engine. Unknown syntax stays text.
  window.renderReply = function (host, text) {
    host.replaceChildren(); host.classList.add('reply-markdown');
    function inline(parent, value) {
      const parts = value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
      for (const part of parts) {
        if (part.startsWith('`') && part.endsWith('`')) { const n = document.createElement('code'); n.textContent = part.slice(1, -1); parent.append(n); }
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
    for (const line of lines) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) { block(); fence = ''; }
        else code.push(line);
      } else if (marker) { flush(); fence = marker[1]; language = marker[2].trim(); }
      else if (!line.trim()) flush();
      else {
        const heading = line.match(/^(#{1,6})\s+(.+)$/), item = line.match(/^\s*(?:[-*+] |\d+\. )(.+)$/);
        if (heading || item) { flush(); const n = document.createElement(heading ? 'h' + Math.min(heading[1].length + 1, 6) : 'p'); inline(n, heading ? heading[2] : '• ' + item[1]); host.append(n); }
        else paragraph.push(line);
      }
    }
    if (fence) block(); flush();
  };
  window.mountMainChat = function ({ showChat, refreshSessions }) {
    const api = window.personalAgentDesktop;
    const sample = document.querySelector('.chat-list');
    const list = document.createElement('div'); list.className = 'chat-list'; list.id = 'liveChatList'; list.hidden = true; list.style.display = 'none'; sample.after(list);
    let busy = false, started = false, failed = false, example = false, confirmed = '', title = '', loading = 0;
    const selectors = [], statuses = [];
    const homeStop = document.getElementById('btnStop').cloneNode(true); homeStop.id = 'btnStopHome';
    homeStop.onclick = () => { if (busy) void api.stopChat(); };
    document.querySelector('#sendHome').before(homeStop);
    for (const id of ['taHome', 'taChat']) {
      const input = document.getElementById(id), row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;flex-wrap:wrap';
      const label = document.createElement('label'); label.textContent = '模型 '; label.htmlFor = id + 'Model';
      const select = document.createElement('select'); select.id = id + 'Model'; select.className = 'set-sel'; select.style.maxWidth = '100%'; label.append(select); row.append(label);
      const status = document.createElement('span'); status.setAttribute('role', 'status'); status.style.cssText = 'font-size:12px;color:var(--text-secondary)'; row.append(status);
      const probe = document.createElement('button'); probe.type = 'button'; probe.textContent = '检测工具'; probe.title = '向当前模型发送一次合成工具请求，可能计费；不读取或上传项目文件';
      probe.onclick = async () => {
        if (busy) return;
        const value = selectors[0].value;
        if (!value) { status('请先在模型设置中保存并选择提供商'); return; }
        probe.disabled = true; status('正在检测工具协议（合成请求，不读项目文件）…');
        try { const r = await api.providerSettings('test-tools', JSON.parse(value)); status(r.ok ? r.data.detail + (r.data.response ? ' 回复：' + r.data.response : '') : r.error); }
        catch { status('工具检测失败，请检查模型配置'); } finally { probe.disabled = false; }
      };
      row.append(probe);
      row.className = 'composer-model'; row.style.cssText = ''; status.className = 'composer-status';
      const composer = input.closest('.composer'); composer.querySelector('.send').before(row); composer.append(status);
      selectors.push(select); statuses.push(status); input.maxLength = 8192;
      select.onchange = () => { selectors.forEach(s => { s.value = select.value; }); confirmed = ''; void updateDestination(); };
    }
    function status(text) { statuses.forEach(s => { s.textContent = text; }); }
    api?.onChatActivity?.(e => { if (busy) status(e.type === 'model' ? '正在请求模型…' : `工具 ${e.name || ''} · ${e.type === 'tool-start' ? '执行中' : e.isError ? '失败/拒绝' : '完成'}`); });
    function toolMessage(item) {
      const body = message('工具 · ' + (item.name || item.callId || ''), '');
      const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
      summary.textContent = item.kind === 'call' ? '请求参数' : item.isError ? '失败/拒绝' : '执行结果';
      pre.textContent = String(item.kind === 'call' ? item.arguments : item.content).slice(0, 65536);
      pre.style.cssText = 'white-space:pre-wrap;max-height:260px;overflow:auto'; details.append(summary, pre); body.append(details);
    }
    async function updateDestination() {
      const value = selectors[0].value;
      const r = await api.providerSettings('list');
      if (!r.ok || selectors[0].value !== value) return;
      const chosen = value ? JSON.parse(value) : null;
      const provider = r.data.providers.find(p => p.id === chosen?.id);
      selectors.forEach(s => { s.title = provider ? '发送到 ' + provider.baseUrl + ' · 消息及已启用工具读取的文件会发送到此服务并保存本地历史；可能计费' : '使用 CLI / 环境模型配置'; });
    }
    async function open(id) {
      if (busy) return false;
      busy = true; lock(); status('读取会话…');
      try {
        const saved = await api.openChat(id);
        title = saved.title; started = true; failed = !saved.canResume; confirmed = saved.identity;
        const value = saved.selection ? JSON.stringify(saved.selection) : '';
        selectors.forEach(s => { s.value = value; });
        list.replaceChildren();
        const calls = new Map();
        for (const m of saved.messages) {
          if (m.toolCalls) for (const c of m.toolCalls) { calls.set(c.id, c.name); toolMessage({kind:'call',callId:c.id,name:c.name,arguments:c.arguments}); }
          if (m.role === 'tool') { toolMessage({kind:'result',callId:m.toolCallId,name:calls.get(m.toolCallId),content:m.content,isError:m.isError}); continue; }
          if (!['user', 'assistant'].includes(m.role) || (!m.content && m.toolCalls?.length)) continue;
          const n = message(m.role === 'user' ? '你' : 'Personal Agent', m.content);
          if (m.role === 'assistant') window.renderReply(n, m.content);
        }
        showLive(); status(saved.workspaceError || (saved.canResume ? '' : '历史只读：配置已变化、旧版本记录或上次请求未完成；继续输入将自动新建会话'));
        window.dispatchEvent(new Event('workspace-sync')); return true;
      } catch (_) { status('会话读取失败；原文件保留'); return false; }
      finally { busy = false; lock(); }
    }
    function lock() {
      selectors.forEach(s => { s.disabled = busy || started; });
      for (const id of ['taHome', 'taChat', 'sendHome', 'sendChat']) document.getElementById(id).disabled = busy;
      document.getElementById('btnNew').disabled = busy;
      document.getElementById('btnStop').disabled = !busy; homeStop.disabled = !busy;
    }
    async function load() {
      const sequence = ++loading;
      if (!api) { status('请在桌面客户端中配置模型'); return; }
      try {
        const r = await api.providerSettings('list');
        if (sequence !== loading) return;
        if (!r.ok) throw Error(r.error);
        const old = selectors[0].value;
        selectors.forEach(s => {
          s.replaceChildren(new Option('CLI / 环境配置', ''));
          r.data.providers.forEach(p => p.models.forEach(m => s.add(new Option(p.name + ' / ' + m, JSON.stringify({ id: p.id, model: m })))));
          s.value = Array.from(s.options).some(o => o.value === old) && old ? old : s.options[1]?.value || '';
        });
        status(''); lock(); await updateDestination();
      } catch (_) { status('模型列表读取失败，请重新打开客户端或检查设置'); }
    }
    function message(role, text) {
      const row = document.createElement('div'); row.className = 'msg msg--' + (role === '你' ? 'user' : 'agent');
      const body = document.createElement('div'); body.className = 'msg-body';
      const label = document.createElement('strong'); label.textContent = role; body.append(label);
      const content = document.createElement('div'); content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 20px'; content.textContent = text; body.append(content); row.append(body); list.append(row);
      document.getElementById('chatScroll').scrollTop = document.getElementById('chatScroll').scrollHeight;
      return content;
    }
    function showLive() { sample.hidden = true; sample.style.display = 'none'; list.hidden = false; list.style.display = 'flex'; showChat(title, true); }
    async function send(text, input) {
      if (busy) return;
      if (example) example = false;
      if (!api) { status('请启动桌面客户端'); return; }
      if (!text.trim() || new TextEncoder().encode(text).length > 8192) { status('请输入 1–8192 UTF-8 字节文本'); return; }
      // 上次失败、配置已变或只读历史：不拦截输入，发送时自动新建会话，旧历史保留。
      const restarted = failed;
      if (failed && !await reset()) return;
      busy = true; lock(); status('读取模型配置…');
      let reply, sent = false;
      try {
        const value = selectors[0].value;
        const preview = await api.getProvider(value ? JSON.parse(value) : undefined);
        const identity = JSON.stringify([preview.providerId, preview.baseUrl, preview.model, preview.revision]);
        if (started && confirmed !== identity) { failed = true; status('模型配置已改变；继续输入将自动新建会话，旧上下文不会发送到新服务'); return; }
        if (confirmed !== identity) {
          // Discard any invisible host conversation left by a renderer reload.
          await api.resetChat();
          // reset invalidates the token, so obtain the target again and compare before sending.
          const renewed = await api.getProvider(value ? JSON.parse(value) : undefined);
          if (JSON.stringify([renewed.providerId, renewed.baseUrl, renewed.model, renewed.revision]) !== identity) throw Error('配置已变化');
          Object.assign(preview, renewed); confirmed = identity;
        }
        if (!started) { list.replaceChildren(); title = text.slice(0, 24); }
        showLive(); message('你', text); reply = message('Personal Agent', '正在回复…');
        input.value = ''; input.style.height = 'auto';
        status('请求中 · 文件工具模式最长 180 秒 · 可以停止'); sent = true; started = true;
        const result = await api.sendChat(text, preview.token);
        if (result.transcript?.length) { reply.closest('.msg').remove(); result.transcript.forEach(toolMessage); reply = message('Personal Agent', ''); }
        if (result.error) failed = true;
        window.renderReply(reply, result.error || result.content);
        const evidence = result.toolStatus;
        const toolNotice = !evidence?.offered.length ? '本次未提供模型工具；若需读取项目，请启用下方模型文件工具' : evidence.requested === 0 ? `本次已声明 ${evidence.offered.join('、')}，但模型未返回工具调用；没有读取项目文件。可点“检测工具”核对接口兼容性` : `工具请求 ${evidence.requested} 次 · 成功 ${evidence.completed} · 失败/拒绝 ${evidence.failed}`;
        status(result.error ? '请求未完成 · 已执行操作不会自动回滚；查看工具记录和工作区' : (restarted ? '已自动新建会话 · ' : '') + '已保存 · ' + toolNotice);
        document.getElementById('chatScroll').scrollTop = document.getElementById('chatScroll').scrollHeight;
        await refreshSessions().catch(() => {});
      } catch (_) {
        if (sent) { failed = true; if (reply) reply.textContent = '请求失败或已停止，可能已计费或执行部分工具。请检查历史和文件；不会自动重试或回滚，继续输入将新建会话。'; }
        status(sent ? '请求失败，历史保留；继续输入将自动新建会话' : '模型配置不可用或已变化，请检查设置后重试');
        if (sent) await refreshSessions().catch(() => {});
      } finally { busy = false; lock(); }
    }
    async function reset() {
      if (busy) { status('请求进行中，请等待完成后新建任务'); return false; }
      busy = true; lock();
      try {
        if (api) await api.resetChat();
        started = failed = example = false; confirmed = ''; title = ''; list.replaceChildren();
        document.getElementById('taHome').value = ''; document.getElementById('taChat').value = '';
        sample.hidden = false; sample.style.display = 'flex'; list.hidden = true; list.style.display = 'none';
        await load(); return true;
      } catch (_) { status('新建失败，请等待当前模型请求完成'); return false; }
      finally { busy = false; lock(); }
    }
    window.addEventListener('providers-changed', () => {
      if (started) { failed = true; status('配置已更新，请新建任务'); } else if (!busy) { confirmed = ''; void load(); }
    });
    void load();
    return { send, reset, open, isBusy: () => busy, showExample() { example = true; status('原型示例 · 请新建任务开始真实聊天'); sample.hidden = false; sample.style.display = 'flex'; list.hidden = true; list.style.display = 'none'; }, stop() { if (!busy) { status('当前没有正在运行的请求'); return; } status('正在停止；已执行文件变更不会自动回滚'); void api.stopChat().catch(() => status('停止失败，请等待请求超时')); } };
  };
})();
