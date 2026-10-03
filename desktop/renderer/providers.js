/* Provider settings: native controls; secrets exist only in the active password field. */
(function () {
  'use strict';
  function el(tag, text, parent) { const n = document.createElement(tag); if (text) n.textContent = text; if (parent) parent.append(n); return n; }
  async function call(action, payload) {
    if (!window.personalAgentDesktop) throw Error('浏览器预览不支持配置，请启动桌面客户端');
    const r = await window.personalAgentDesktop.providerSettings(action, payload);
    if (!r.ok) throw Error(r.error); return r.data;
  }
  window.mountProviderSettings = function (host) {
    let state, activeDialog, destroyed = false;
    host.replaceChildren();
    el('p', '填入各提供商的 API 密钥即可使用其模型。密钥使用系统加密保存。', host);
    const status = el('p', '', host); status.setAttribute('role', 'status');
    const list = el('div', '', host);
    const button = (parent, label, action) => { const b = el('button', label, parent); b.type = 'button'; b.className = 'set-btn'; b.onclick = action; return b; };
    async function refresh() {
      try {
        state = await call('list'); if (destroyed || !host.isConnected) return;
        status.textContent = ''; list.replaceChildren();
        if (!state.providers.length) el('p', '还没有添加模型提供商', list);
        for (const p of state.providers) {
          const row = el('div', '', list); row.style.cssText = 'display:flex;align-items:center;gap:12px;border:1px solid var(--border-primary);border-radius:14px;padding:16px;margin:10px 0';
          const name = el('span', p.name + (p.kind === 'custom' ? ' · 自定义' : ''), row); name.style.flex = '1';
          button(row, '编辑', () => edit(p));
          button(row, '删除', async () => {
            if (!window.confirm('删除提供商“' + p.name + '”及其保存的密钥？')) return;
            try { await call('delete', { revision: state.revision, id: p.id }); await refresh(); window.dispatchEvent(new Event('providers-changed')); }
            catch (e) { status.textContent = e.message; }
          });
        }
        const add = button(list, '＋ 添加模型提供商', () => edit()); add.style.cssText = 'width:100%;margin:12px 0;padding:12px';
      } catch (e) { status.textContent = e.message; }
    }
    function edit(existing) {
      if (!state || destroyed || activeDialog?.open) return;
      const revision = state.revision;
      const dialog = el('dialog', '', document.body); activeDialog = dialog; dialog.className = 'provider-dialog';
      dialog.style.cssText = 'margin:auto;width:min(580px,92vw);max-height:90vh;overflow:auto;padding:24px;border:1px solid var(--border-primary);border-radius:16px;background:var(--bg-elevated);color:var(--text-primary)';
      let custom = existing?.kind === 'custom', busy = false, generation = 0, models = [...(existing?.models || [])];
      const top = el('div', '', dialog); top.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
      el('h3', existing ? '编辑模型提供商' : '添加模型提供商', top);
      button(top, '关闭', () => dialog.close());
      const tabs = el('div', '', dialog); tabs.style.cssText = 'display:flex;gap:8px;margin:16px 0';
      const third = button(tabs, '第三方模型提供商', () => switchTab(false));
      const own = button(tabs, '自定义模型 API', () => switchTab(true));
      if (existing) { third.disabled = true; own.disabled = true; }
      const form = el('div', '', dialog), message = el('p', '', dialog); message.setAttribute('role', 'status');
      let id, name, preset, url, key, modelList, fetchButton, save, details;
      function field(parent, label, value, type = 'text') {
        const lab = el('label', label, parent); lab.style.cssText = 'display:block;margin:14px 0 6px;font-size:13px';
        const input = el('input', '', lab); input.type = type; input.value = value || ''; input.autocomplete = 'off'; input.maxLength = type === 'password' ? 8192 : 2048;
        input.style.cssText = 'display:block;width:100%;margin-top:6px;padding:9px;border:1px solid var(--border-input);border-radius:8px;background:var(--bg-elevated);color:inherit'; return input;
      }
      function switchTab(value) { if (busy) return; key.value = ''; custom = value; models = []; render(); }
      function payload() {
        return { revision, editingId: existing?.id, provider: { id: custom ? id.value : (existing?.id || preset.value), name: custom ? name.value : state.presets.find(p => p.id === preset.value).name,
          kind: custom ? 'custom' : preset.value, baseUrl: url.value || (custom ? '' : state.presets.find(p => p.id === preset.value)?.baseUrl),
          protocol: 'openai-chat', models: [...models], apiKey: key.value } };
      }
      function showModels() {
        modelList.replaceChildren();
        if (!models.length) el('p', '暂无模型，可获取可用模型或手动添加。', modelList);
        for (const m of models) {
          const row = el('div', '', modelList); row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0';
          const label = el('span', m, row); label.style.cssText = 'flex:1;overflow-wrap:anywhere';
          button(row, '移除', () => { if (!busy) { models = models.filter(x => x !== m); showModels(); } });
        }
      }
      function lock(on) {
        busy = on;
        form.querySelectorAll('input,select,button').forEach(n => { n.disabled = on; });
        if (existing && id) id.disabled = true;
        if (existing && preset) preset.disabled = true;
        if (!existing) third.disabled = own.disabled = on;
      }
      function render() {
        form.replaceChildren(); message.textContent = '';
        third.setAttribute('aria-pressed', String(!custom)); own.setAttribute('aria-pressed', String(custom));
        third.style.background = !custom ? 'var(--bg-hover)' : ''; own.style.background = custom ? 'var(--bg-hover)' : '';
        id = name = preset = undefined;
        if (custom) {
          id = field(form, 'Provider ID', existing?.id); id.placeholder = 'my-gateway'; id.maxLength = 64; id.disabled = !!existing;
          name = field(form, '显示名称', existing?.name); name.maxLength = 80;
          url = field(form, 'API 地址', existing?.baseUrl); url.placeholder = 'https://gateway.example/v1';
          el('p', 'API 协议：OpenAI Chat Completions', form);
        } else {
          const lab = el('label', '提供商 ', form); preset = el('select', '', lab); preset.className = 'set-sel';
          for (const p of state.presets) { const o = el('option', p.name, preset); o.value = p.id; }
          preset.value = existing?.kind || state.presets[0].id; preset.disabled = !!existing;
        }
        key = field(form, 'API 密钥', '', 'password'); key.placeholder = existing?.hasKey ? '已保存，留空保持原密钥' : '输入 API 密钥（本地无认证服务可留空）';
        if (!custom) {
          details = el('details', '', form); details.open = !!existing;
          el('summary', '自定义设置', details).style.cssText = 'cursor:pointer;margin:16px 0';
          url = field(details, 'API 地址', existing?.baseUrl); url.placeholder = state.presets.find(p => p.id === preset.value).baseUrl;
          preset.onchange = () => { url.value = ''; url.placeholder = state.presets.find(p => p.id === preset.value).baseUrl; key.value = ''; models = []; showModels(); };
        }
        fetchButton = button(form, '获取可用模型', async () => {
          if (busy) return;
          const seq = ++generation; lock(true); message.textContent = '正在获取上游模型（最多等待 15 秒）…';
          try {
            const r = await call('discover', payload());
            if (!dialog.open || seq !== generation) return;
            models = [...new Set([...models, ...r.models])]; showModels();
            message.textContent = r.models.length ? '已获取 ' + r.models.length + ' 个模型；可移除不需要的模型后保存。' : '上游返回空列表，可手动添加模型 ID。';
          } catch (e) { if (dialog.open && seq === generation) message.textContent = e.message; }
          finally { if (dialog.open && seq === generation) lock(false); }
        });
        fetchButton.classList.add('set-btn--primary'); fetchButton.style.cssText = 'margin:16px 0;width:100%;padding:10px';
        el('h4', '模型目录', form); modelList = el('div', '', form); modelList.style.cssText = 'max-height:180px;overflow:auto'; showModels();
        const manual = field(form, '手动添加模型 ID', ''); manual.maxLength = 256; manual.placeholder = '例如 deepseek-chat';
        button(form, '＋ 添加模型', () => {
          const m = manual.value.trim(); if (!m) return;
          if (models.length >= 500) { message.textContent = '最多 500 个模型'; return; }
          if (!models.includes(m)) models.push(m); manual.value = ''; showModels();
        });
        const actions = el('div', '', form); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:24px';
        button(actions, '取消', () => dialog.close());
        save = button(actions, existing ? '保存' : '创建提供商', async () => {
          if (busy) return; lock(true); message.textContent = '正在保存…'; const seq = ++generation;
          try {
            await call('save', payload()); key.value = '';
            if (dialog.open && seq === generation) dialog.close();
            await refresh(); window.dispatchEvent(new Event('providers-changed'));
          } catch (e) { if (dialog.open && seq === generation) message.textContent = e.message; }
          finally { if (dialog.open && seq === generation) lock(false); }
        }); save.classList.add('set-btn--primary');
      }
      render();
      const current = dialog;
      current.addEventListener('close', () => { generation++; key.value = ''; current.remove(); });
      current.showModal();
    }
    refresh();
    return { refresh, destroy() { destroyed = true; activeDialog?.close(); } };
  };
})();
