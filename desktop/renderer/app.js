(function(){
  'use strict';
  var $  = function(s,r){ return (r||document).querySelector(s); };
  var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

  /* ===================== 数据 ===================== */
  var sessions = [], savedWorkspaces = [], selectedSessionId = null, refreshSequence = 0;
  var filterState = { status:'all' };
  var FILTER_LABEL = { all:'全部任务', ok:'完成', err:'未完成/失败', unknown:'状态未知（旧记录）' };
  function sessionStatus(s){ return s.indexed === false ? 'unknown' : s.failed === true ? 'err' : s.failed === false ? 'ok' : 'unknown'; }
  var PREF_KEY = 'personal-agent.ui.v1';
  var prefs = { version:1, theme:'light', font:0, send:'Enter', compact:false };
  try {
    var stored = JSON.parse(localStorage.getItem(PREF_KEY));
    if (stored && stored.version === 1) {
      if (['light','dark'].includes(stored.theme)) prefs.theme = stored.theme;
      if ([-1,0,1].includes(stored.font)) prefs.font = stored.font;
      if (['Enter','Ctrl+Enter'].includes(stored.send)) prefs.send = stored.send;
      if (typeof stored.compact === 'boolean') prefs.compact = stored.compact;
    }
  } catch (_) {} // Invalid/blocked storage falls back to non-secret defaults.
  function savePrefs(){ try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { toast('偏好仅本次有效：本地存储不可用'); } }
  function openWorkspace(mode){ window.dispatchEvent(new CustomEvent('workspace-open', {detail:{mode:mode}})); }
  function applyCompact(){ document.documentElement.classList.toggle('ui-compact', prefs.compact); }
  document.documentElement.setAttribute('data-theme', prefs.theme);
  var compactStyle = document.createElement('style');
  compactStyle.textContent = '.ui-compact .home-hero,.ui-compact .home-sub{display:none}.ui-compact .session-row{padding:4px 10px}.ui-compact .msg{margin-bottom:8px}.set-row [disabled]{opacity:.55;cursor:not-allowed}';
  document.head.append(compactStyle); applyCompact();
  var SCENES = {
    working:{ ph:'描述你想完成的任务…  例如：把这份季度财报整理成可分享的网页', label:'日常办公' },
    coding: { ph:'描述你想实现的功能…  例如：给定价页加一个席位滑块，实时算总价', label:'代码开发' },
    design: { ph:'描述你想要的视觉方向…  例如：做一版更克制的定价页，主推团队版', label:'设计创意' }
  };

  /* ===================== 侧栏渲染 ===================== */
  function ico(id, cls){ return '<svg class="ico '+(cls||'')+'"><use href="#'+id+'"/></svg>'; }

  function renderSessions(){
    const host = $('#taskGroups');
    const expanded = new Map($$('.session-group', host).map(g => [g.dataset.root, g.open]));
    const roots = [...new Set([...savedWorkspaces, ...sessions.map(s => s.workspaceRoot)].filter(Boolean))];
    host.replaceChildren();
    for (const root of [null, ...roots]) {
      const items = sessions.filter(s => (s.workspaceRoot || null) === root && (filterState.status === 'all' || sessionStatus(s) === filterState.status));
      if (!root && !items.length) continue;
      const group = document.createElement('details'); group.className = 'session-group'; group.dataset.root = root || ''; group.open = expanded.get(root || '') !== false;
      const head = document.createElement('summary'); head.textContent = (root ? '▱ ' + root.split(/[\\/]/).filter(Boolean).pop() : '会话') + ' (' + items.length + ')'; head.title = root || '未关联工作区的历史'; group.append(head);
      for (const s of items) {
        const b = document.createElement('button'); b.className = 'session-row'; b.dataset.session = s.id; b.textContent = s.title; b.title = s.title + ' · ' + FILTER_LABEL[sessionStatus(s)];
        const state = document.createElement('small'); state.textContent = ' · ' + FILTER_LABEL[sessionStatus(s)]; b.append(state);
        b.classList.toggle('is-on', s.id === selectedSessionId);
        b.onclick = () => void openSession(s.id); group.append(b);
      }
      if (!items.length) { const note = document.createElement('small'); note.textContent = '此文件夹暂无符合筛选的会话'; group.append(note); }
      host.append(group);
    }
    if (!host.children.length) host.textContent = '暂无符合筛选的会话';
  }
  async function openSession(id){
    if (await mainChat.open(id)) { ++refreshSequence; selectedSessionId = id; renderSessions(); }
  }
  async function refreshSessions() {
    const sequence = ++refreshSequence;
    if (!window.personalAgentDesktop?.listChats) { $('#taskGroups').textContent = '历史仅在桌面客户端可用'; return; }
    try {
      const data = await window.personalAgentDesktop.listChats();
      if (sequence !== refreshSequence) return;
      sessions = data.sessions; savedWorkspaces = data.workspaces;
      if (Object.prototype.hasOwnProperty.call(data, 'activeSessionId')) selectedSessionId = data.activeSessionId;
      renderSessions();
      if (searchScrim?.classList.contains('is-on')) renderTs(tsInput.value);
    } catch (_) {
      if (sequence === refreshSequence) toast('会话列表读取失败；保留现有列表与历史文件');
    }
  }
  window.addEventListener('workspace-changed', async e => { if (e.detail?.changed) await newTask(); await refreshSessions(); });

  /* ===================== 视图切换 ===================== */
  var vHome = $('#vHome'), vChat = $('#vChat');

  function showChat(title, live){
    if (mainChat && !live) mainChat.showExample();
    if (title) $('#chatTitle').textContent = title;
    $('#tbTitle').textContent = 'JM · ' + (title || $('#chatTitle').textContent);
    vHome.classList.remove('is-on');
    vChat.classList.add('is-on');
    $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
  }
  function showHome(){
    vChat.classList.remove('is-on');
    vHome.classList.add('is-on');
    $('#tbTitle').textContent = 'JM · 新建任务';
  }

  function togglePanel(){ openWorkspace('toggle'); }

  /* ===================== 输入框 ===================== */
  function autoGrow(ta){
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }
  function syncSend(ta, btn){
    var has = ta.value.trim().length > 0;
    btn.classList.toggle('is-ready', has);
  }

  function bindComposer(ta, btn, onSend){
    ta.addEventListener('input', function(){ autoGrow(ta); syncSend(ta, btn); });
    ta.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229 && (prefs.send === 'Ctrl+Enter' ? e.ctrlKey && !e.metaKey : !e.ctrlKey && !e.metaKey)){
        e.preventDefault();
        if (ta.value.trim()) onSend(ta.value.trim());
      }
    });
    btn.addEventListener('click', function(){ if (ta.value.trim()) onSend(ta.value.trim()); });
    autoGrow(ta); syncSend(ta, btn);
  }

  var mainChat = window.mountMainChat({ showChat: showChat, refreshSessions: refreshSessions });
  void refreshSessions();
  $('#openModel').onclick = () => { showHome(); $('#taHome').focus(); };
  bindComposer($('#taHome'), $('#sendHome'), function(v){ void mainChat.send(v, $('#taHome')); });
  bindComposer($('#taChat'), $('#sendChat'), function(v){ void mainChat.send(v, $('#taChat')); });
  $('#btnStop').addEventListener('click', function(){ mainChat.stop(); });
  async function newTask() {
    if (await mainChat.reset()) { ++refreshSequence; selectedSessionId = null; renderSessions(); showHome(); $('#taHome').focus(); toast('已新建空白会话'); }
  }

  /* ===================== 场景标签 ===================== */
  $('#sceneTabs').addEventListener('click', function(e){
    var b = e.target.closest('.scene'); if (!b) return;
    $$('.scene', this).forEach(function(x){ x.classList.remove('is-on'); });
    b.classList.add('is-on');
    var s = SCENES[b.dataset.scene];
    var ta = $('#taHome');
    ta.placeholder = s.ph;
    ta.focus();
    toast('「' + s.label + '」仅更换输入提示，不改变模型或能力');
  });

  /* ===================== 模式切换 ===================== */
  document.addEventListener('click', function(e){
    var m = e.target.closest('.chip-btn[data-mode]'); if (!m) return;
    var bar = m.parentElement;
    $$('.chip-btn[data-mode]', bar).forEach(function(x){ x.classList.remove('is-on'); });
    m.classList.add('is-on');
    toast('当前仅文字问答；计划模式未实现；手动工具权限在输入框下方');
  });

  /* ===================== 侧栏交互 ===================== */
  $$('.nav-badge').forEach(b => b.remove());
  $('#sceneTabs').title = '场景仅更换输入提示，不切换模型或工具能力';
  const sceneNote = document.createElement('small'); sceneNote.textContent = '场景仅更换输入提示，不切换模型或工具能力。'; $('#sceneTabs').after(sceneNote);

  $('.sec-head')?.addEventListener('click', function(){
    var n = this.nextElementSibling;
    if (!n) return;
    var hid = n.style.display === 'none';
    n.style.display = hid ? '' : 'none';
    var u = $('use', this);
    u.setAttribute('href', hid ? '#i-chev-d' : '#i-chev-r');
  });

  /* “更多”是可展开分组（对齐真实客户端 conversation.more 的语义） */
  var moreOpen = false;
  function setMore(open){
    moreOpen = !!open;
    var btn = $('#navMore'), sub = $('#navMoreSub');
    sub.hidden = !moreOpen;
    btn.classList.toggle('is-open', moreOpen);
    btn.setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
    $('use', $('#icoMoreChev')).setAttribute('href', moreOpen ? '#i-chev-d' : '#i-chev-r');
  }
  function toggleMore(){
    /* 侧栏收起时先展开，否则分组内容无处可见 */
    var sb = $('#sidebar');
    if (sb.classList.contains('is-collapsed')) toggleSidebarCollapse();
    setMore(!moreOpen);
  }

  $$('.nav-item').forEach(function(b){
    b.addEventListener('click', function(){
      if (b.dataset.nav === 'more'){ toggleMore(); return; }
      $$('.nav-item').forEach(function(x){ x.classList.remove('is-on'); });
      $$('.nav-sub-item').forEach(function(x){ x.classList.remove('is-on'); });
      setMore(false);
      b.classList.add('is-on');
      if (b.dataset.nav === 'assistant') { showHome(); return; }
      if (b.dataset.nav === 'project') { openWorkspace('start'); return; }
      var map = { expert:'专家', automation:'定时任务' };
      toast('未实现：' + map[b.dataset.nav]);
    });
  });

  $$('.nav-sub-item').forEach(function(b){
    b.addEventListener('click', function(){
      $$('.nav-sub-item').forEach(function(x){ x.classList.remove('is-on'); });
      b.classList.add('is-on');
      $$('.nav-item').forEach(function(x){ x.classList.remove('is-on'); });
      $('#navMore').classList.add('is-on');
      if (b.dataset.sub === 'files') { openWorkspace('files'); return; }
      toast('未实现：' + $('span', b).textContent);
    });
  });

  $('#btnNew').addEventListener('click', newTask);
  $('#btnBackHome').addEventListener('click', showHome);

  document.addEventListener('click', function(e){
    var a = e.target.closest('a[data-nav]');
    if (a){ e.preventDefault(); toast('未接线：连接器管理'); }
  });

  /* ===================== 设置（结构对齐真实客户端 NAV_GROUPS / NAV_ITEMS） ===================== */
  var setScrim = $('#setScrim');
  var currentTab = 'settings';
  var scQuery = '';

  var SET_GROUPS = [
    { id:'general',      label:'设置' },
    { id:'feature',      label:'功能' },
    { id:'dataSecurity', label:'数据与安全' },
    { id:'about',        label:'关于我们' }
  ];
  var SET_ITEMS = [
    { id:'settings',          label:'通用',           group:'general',      ico:'i-settings' },
    { id:'account',           label:'个人主页',        group:'general',      ico:'i-people' },
    { id:'subscriptionUsage', label:'套餐与积分',      group:'general',      ico:'i-package' },
    { id:'appearance',        label:'外观',           group:'general',      ico:'i-wand' },
    { id:'keyboardShortcuts', label:'快捷键',         group:'general',      ico:'i-slash' },
    { id:'personalization',   label:'个性化',         group:'feature',      ico:'i-bulb' },
    { id:'memory',            label:'记忆与进化',      group:'feature',      ico:'i-book' },
    { id:'extensions',        label:'智能体',         group:'feature',      ico:'i-expert' },
    { id:'models',            label:'模型',           group:'feature',      ico:'i-cloud' },
    { id:'claw',              label:'Personal Agent 设置',  group:'feature',      ico:'i-sparkle' },
    { id:'dataManagement',    label:'数据管理',        group:'dataSecurity', ico:'i-terminal' },
    { id:'buddyApps',         label:'应用管理',        group:'dataSecurity', ico:'i-grid' },
    { id:'securityCenter',    label:'安全中心',        group:'dataSecurity', ico:'i-shield' },
    { id:'systemPermissions', label:'系统授权',        group:'dataSecurity', ico:'i-lock' },
    { id:'softwareConfig',    label:'软件配置',        group:'dataSecurity', ico:'i-code' },
    { id:'helpFeedback',      label:'关于 Personal Agent',  group:'about',        ico:'i-bulb' },
    { id:'getHelp',           label:'获取帮助',        group:'about',        ico:'i-search' }
  ];

  /* 真实 SHORTCUT_DEFINITIONS（Windows 绑定） */
  var SC_CATS = [
    { id:'general',    label:'通用' },
    { id:'navigation', label:'任务' },
    { id:'editing',    label:'聊天' },
    { id:'window',     label:'面板·窗口' }
  ];
  var SC = [
    { c:'general',    l:'放大内容字号',     k:'Ctrl+=',       e:false },
    { c:'general',    l:'缩小内容字号',     k:'Ctrl+-',       e:false },
    { c:'general',    l:'重置内容字号',     k:'Ctrl+0',       e:false },
    { c:'navigation', l:'打开全局搜索',     k:'Ctrl+K',       e:true },
    { c:'navigation', l:'全局搜索',         k:'Ctrl+K',       e:true },
    { c:'navigation', l:'新建对话',         k:'Ctrl+N',       e:true },
    { c:'navigation', l:'新建快速问答',     k:'Ctrl+Shift+N', e:true },
    { c:'navigation', l:'上一个任务',       k:'Ctrl+[',       e:true },
    { c:'navigation', l:'下一个任务',       k:'Ctrl+]',       e:true },
    { c:'navigation', l:'定位当前任务',     k:'Ctrl+Shift+E', e:true },
    { c:'editing',    l:'发送消息',         k:'Enter',        e:true },
    { c:'editing',    l:'输入时换行',       k:'Shift+Enter',  e:true },
    { c:'editing',    l:'停止生成（未实现）', k:'Escape',       e:false },
    { c:'editing',    l:'对话内搜索（未实现）', k:'Ctrl+F',     e:false },
    { c:'editing',    l:'语音录制（未实现）', k:'Ctrl+D',       e:false },
    { c:'editing',    l:'选择器（未实现）', k:'@',              e:false },
    { c:'editing',    l:'斜杠命令（未实现）', k:'/',             e:false },
    { c:'window',     l:'打开设置',         k:'Ctrl+,',       e:true },
    { c:'window',     l:'切换左侧栏',       k:'Ctrl+B',       e:true },
    { c:'window',     l:'切换工作区面板',   k:'Ctrl+Shift+B', e:true },
    { c:'window',     l:'进入/退出全屏',    k:'F11',          e:true },
    { c:'window',     l:'唤起/隐藏主窗口（未实现）', k:'Shift+Alt+W', e:false }
  ];

  var PANEL_DESC = {
    account:           ['个人主页',   '头像、昵称与个人资料。'],
    subscriptionUsage: ['套餐与积分', '当前套餐、积分余额与用量明细。'],
    personalization:   ['个性化',     '称呼、语气与回复风格偏好。'],
    memory:            ['记忆与进化', '长期记忆的查看、编辑与清理。'],
    extensions:        ['智能体',     '智能体与技能的启用、配置与上传。'],
    claw:              ['Personal Agent 设置', '助手行为与运行时配置。'],
    dataManagement:    ['数据管理',   '会话、文件与本地数据的导出和清理。'],
    buddyApps:         ['应用管理',   '已发布应用的查看与管理。'],
    systemPermissions: ['系统授权',   '屏幕录制、辅助功能、文件访问等系统权限。'],
    softwareConfig:    ['软件配置',   '终端、环境变量与运行时配置。'],
    helpFeedback:      ['关于 Personal Agent', '版本信息、更新与诊断工具。'],
    getHelp:           ['获取帮助',   '使用文档、反馈与支持。']
  };

  /* ---- 小组件 ---- */
  function sSec(t){ return '<div class="set-sec">' + t + '</div>'; }
  function sRow(t, d, ctl){
    return '<div class="set-row"><div class="set-row-main"><div class="set-row-t">' + t + '</div>' +
      (d ? '<div class="set-row-d">' + d + '</div>' : '') + '</div>' +
      '<div class="set-row-ctl">' + ctl + '</div></div>';
  }
  function seg(opts, active){
    return '<span class="seg">' + opts.map(function(o){
      return '<button data-seg="' + o + '"' + (o === active ? ' class="is-on"' : '') + '>' + o + '</button>';
    }).join('') + '</span>';
  }
  function txt(v){ return '<span class="set-txt">' + v + '</span>'; }
  function kbd(b){
    return '<span class="kbd">' + b.split('+').map(function(p){ return '<span>' + p + '</span>'; }).join('') + '</span>';
  }
  function isDark(){ return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function themeCard(name, mode){
    var on = (mode === 'dark') === isDark();
    return '<button class="set-tcard' + (on ? ' is-on' : '') + '" data-theme-pick="' + mode + '">' +
      '<div class="set-tprev set-tprev--' + mode + '"><span></span><span></span><span></span></div>' +
      '<div class="set-tname">' + name + '</div></button>';
  }

  /* ---- 各面板 ---- */
  var PANELS = {};

  PANELS.settings = function(){
    return sSec('本地界面偏好（自动保存，不含密钥）')
      + sRow('主题', '选择应用程序的显示主题。', seg(['浅色','深色'], isDark() ? '深色' : '浅色'))
      + sRow('字体大小', '调整界面与内容的文字大小。', seg(['小','默认','大'], ['小','默认','大'][fontLevel + 1]))
      + sRow('简洁模式', '隐藏首页装饰，缩小会话列表间距；不隐藏消息。', '<button class="set-btn" id="compactToggle" aria-pressed="' + prefs.compact + '">' + (prefs.compact ? '已开启' : '已关闭') + '</button>')
      + sRow('发送消息', 'Shift+Enter 始终换行；输入法组合期间不发送。', seg(['Enter','Ctrl+Enter'], prefs.send))
      + sSec('权限') + sRow('手动工作区工具', '权限在输入框下方控制；不是 OS 沙箱，不向模型开放工具。', '<button class="set-btn" data-permissions>查看权限入口</button>')
      + sSec('尚未实现')
      + ['显示语言','客户端通知','桌面通知','通知提示音','专家与技能推荐','自动安装可信技能','开机自启','自动更新','链接打开方式','网络代理','锁屏远程','系统缓存目录','任务保留期限','默认工作空间存储路径','体验优化计划'].map(function(label){ return sRow(label, '未实现，不保存或执行此选项。', '<button class="set-btn" disabled>未实现</button>'); }).join('');
  };

  PANELS.appearance = function(){
    return sSec('基础')
      + '<div class="set-themes">' + themeCard('浅色', 'light') + themeCard('深色', 'dark') + '</div>'
      + sSec('个性')
      + '<div class="set-themes"><div class="set-tcard is-soon">'
      + '<div class="set-tprev set-tprev--light"><span></span><span></span><span></span></div>'
      + '<div class="set-tname">敬请期待</div></div></div>'
      + '<div class="set-ph-note" style="text-align:left;padding-left:2px">换个皮肤，换种心情 —— 限时主题与个性化皮肤在真实客户端中按版本开放。</div>';
  };

  PANELS.models = function(){ return ''; }; // Real provider view owns this panel's content and lifecycle.

  PANELS.securityCenter = function(){
    return sSec('真实安全边界')
      + sRow('模型会话', '文字会发送到所选模型服务并保存本地历史；不承诺自动脱敏，不自动上传工作区文件。', txt('文字问答 · 模型工具未接线'))
      + sRow('手动工具权限', '只读禁止命令；完全访问允许手动命令访问工作区外，不是 OS 沙箱。权限与确认由工作区工具管理。', '<button class="set-btn" data-permissions>查看权限入口</button>')
      + sRow('渲染器隔离', 'Electron 渲染器隔离与本地命令权限不同；实际隔离状态见关于页。', txt('以运行信息为准'))
      + sRow('数据脱敏 / 安全审计面板', '未实现，不提供虚假开关或安全保证。', '<button class="set-btn" disabled>未实现</button>');
  };
  PANELS.systemPermissions = PANELS.securityCenter;

  PANELS.keyboardShortcuts = function(){
    var q = scQuery.toLowerCase();
    var h = sSec('快捷键')
      + '<div class="sc-tools">'
      + '<input class="sc-search" id="scSearch" placeholder="搜索快捷键" value="' + esc(scQuery) + '">'
      + '<span class="sc-count">共 ' + SC.length + ' 条</span>'
      + '<button class="set-btn" disabled>自定义按键 / 重映射未实现</button></div>';
    SC.forEach(function(x){ if (x.l === '发送消息') x.k = prefs.send; });
    SC_CATS.forEach(function(cat){
      var rows = SC.filter(function(x){
        return x.c === cat.id && (!q || x.l.toLowerCase().indexOf(q) > -1 || x.k.toLowerCase().indexOf(q) > -1);
      });
      if (!rows.length) return;
      h += '<div class="set-sec">' + cat.label + '</div>'
        + '<table class="sc-table"><thead><tr><th>操作</th><th style="width:220px">按键绑定</th></tr></thead><tbody>';
      rows.forEach(function(x){
        h += '<tr><td>' + x.l + (x.e ? '' : '<span class="sc-lock">固定</span>') + '</td><td>' + kbd(x.k) + '</td></tr>';
      });
      h += '</tbody></table>';
    });
    if (!h) h = sSec('快捷键');
    return h;
  };

  function renderPanel(id){
    if (PANELS[id]) return PANELS[id]();
    var d = PANEL_DESC[id] || [id, ''];
    return sSec(d[0])
      + '<div class="set-ph"><div class="set-ph-t">' + d[0] + '</div>'
      + '<div class="set-ph-d">' + d[1] + '</div>'
      + '<div class="set-ph-note">未接线：保留原型功能入口，后续接入真实能力。</div></div>';
  }

  var providerSettingsView, settingsSequence = 0;
  async function renderInfo(host, sequence){
    const output = document.createElement('pre'); output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; output.textContent = '正在读取实际桌面运行信息…'; host.append(output);
    try {
      const info = await window.personalAgentDesktop?.getInfo?.();
      if (sequence !== settingsSequence || !output.isConnected) return;
      output.textContent = info ? JSON.stringify(info, null, 2) : '浏览器预览：无桌面运行信息';
    } catch (_) { if (sequence === settingsSequence) output.textContent = '桌面运行信息读取失败，请重试'; }
  }
  PANELS.helpFeedback = PANELS.getHelp = function(){ return sSec('桌面实际运行信息') + '<p>模型设置配置文字问答；项目 / 更多 → 我的文件打开手动工作区工具。场景仅改变输入提示。模型工具、停止生成、语音、发布分享、账号与云服务未实现。</p>'; };
  function renderSettings(id){
    const sequence = ++settingsSequence;
    if (providerSettingsView) { providerSettingsView.destroy(); providerSettingsView = null; }
    if (id) currentTab = id;
    var nav = '';
    SET_GROUPS.forEach(function(g){
      var items = SET_ITEMS.filter(function(x){ return x.group === g.id; });
      if (!items.length) return;
      nav += '<div class="set-grp">' + g.label + '</div>';
      items.forEach(function(x){
        nav += '<button class="set-item' + (x.id === currentTab ? ' is-on' : '') + '" data-tab="' + x.id + '">'
          + '<svg class="ico"><use href="#' + x.ico + '"/></svg><span>' + x.label + '</span></button>';
      });
    });
    $('#setNav').innerHTML = nav;
    var it = SET_ITEMS.filter(function(x){ return x.id === currentTab; })[0];
    $('#setTitle').textContent = it ? it.label : '设置';
    $('#setBody').innerHTML = renderPanel(currentTab);
    if (currentTab === 'models') providerSettingsView = window.mountProviderSettings($('#setBody'));
    if (['helpFeedback','getHelp'].includes(currentTab)) void renderInfo($('#setBody'), sequence);
    $('#setBody').scrollTop = 0;
  }
  function openSettings(tab){ renderSettings(tab || 'settings'); setScrim.classList.add('is-on'); }
  function closeSettings(){ setScrim.classList.remove('is-on'); ++settingsSequence; if (providerSettingsView) { providerSettingsView.destroy(); providerSettingsView = null; } }

  function applyTheme(mode){
    if ((mode === 'dark') !== isDark()) toggleTheme();
    renderSettings(currentTab);
  }

  $('#setNav').addEventListener('click', function(e){
    var b = e.target.closest('[data-tab]');
    if (b) renderSettings(b.dataset.tab);
  });
  $('#setBody').addEventListener('click', function(e){
    if (currentTab === 'models' || e.target.closest('[disabled]')) return;
    if (e.target.closest('[data-permissions]')) { closeSettings(); showHome(); openWorkspace('start'); toast('在输入框下方选择本地工具权限；完全访问不是 OS 沙箱'); return; }
    if (e.target.closest('#compactToggle')) { prefs.compact = !prefs.compact; applyCompact(); savePrefs(); renderSettings(currentTab); return; }
    var tp = e.target.closest('[data-theme-pick]');
    if (tp){ applyTheme(tp.dataset.themePick); return; }
    var sg = e.target.closest('.seg button');
    if (sg){
      $$('button', sg.parentNode).forEach(function(x){ x.classList.remove('is-on'); });
      sg.classList.add('is-on');
      var rowEl = sg.closest('.set-row');
      var lbl = rowEl ? $('.set-row-t', rowEl) : null;
      if (lbl && lbl.textContent === '字体大小'){
        setFontSize(['小','默认','大'].indexOf(sg.textContent) - 1);
      }
      if (lbl && lbl.textContent === '主题') applyTheme(sg.textContent === '深色' ? 'dark' : 'light');
      if (lbl && lbl.textContent === '发送消息') { prefs.send = sg.textContent; savePrefs(); }
      return;
    }
    if (e.target.closest('.set-btn, .set-txt')) toast('未实现：此项没有配置操作');
  });
  $('#setBody').addEventListener('input', function(e){
    if (e.target.id !== 'scSearch') return;
    scQuery = e.target.value;
    var pos = e.target.selectionStart;
    renderSettings('keyboardShortcuts');
    var el = $('#scSearch');
    if (el){ el.focus(); try { el.setSelectionRange(pos, pos); } catch(_){} }
  });
  $('#setClose').addEventListener('click', closeSettings);
  setScrim.addEventListener('click', function(e){ if (e.target === setScrim) closeSettings(); });

  /* ===================== 命令面板 ===================== */
  var palItems = [
    { sec:'任务', ico:'i-sparkle', label:'新建任务',           k:'Ctrl N', act:function(){ void newTask(); } },
    { sec:'视图', ico:'i-globe',   label:'打开浏览器面板',      k:'',       act:function(){ openWorkspace('browser'); } },
    { sec:'视图', ico:'i-package', label:'产物面板（未实现）',  k:'',       act:function(){ toast('未实现：产物面板；不等同工作区工具'); } },
    { sec:'视图', ico:'i-folder',  label:'打开文件树',          k:'',       act:function(){ openWorkspace('files'); } },
    { sec:'视图', ico:'i-terminal',label:'打开终端',            k:'',       act:function(){ openWorkspace('terminal'); } },
    { sec:'设置', ico:'i-wand',    label:'打开外观设置',       k:'',        act:function(){ openSettings('appearance'); } },
  ];
  var palScrim = $('#scrim'), palInput = $('#palInput'), palList = $('#palList'), palIdx = 0, palView = palItems;

  function renderPal(q){
    q = (q||'').trim().toLowerCase();
    palView = q ? palItems.filter(function(i){ return i.label.toLowerCase().indexOf(q) > -1; }) : palItems;
    palIdx = 0;
    var html = '', last = '';
    palView.forEach(function(it, i){
      if (it.sec !== last){ html += '<div class="pal-sec">' + it.sec + '</div>'; last = it.sec; }
      html += '<button class="pal-item' + (i === 0 ? ' is-on' : '') + '" data-i="' + i + '">' +
                ico(it.ico) + '<span>' + it.label + '</span>' +
                (it.k ? '<span class="k">' + it.k + '</span>' : '') +
              '</button>';
    });
    palList.innerHTML = html || '<div class="pal-sec">没有匹配项</div>';
  }
  function movePal(d){
    if (!palView.length) return;
    palIdx = (palIdx + d + palView.length) % palView.length;
    $$('.pal-item', palList).forEach(function(el, i){ el.classList.toggle('is-on', i === palIdx); });
  }
  function openPal(){
    palScrim.classList.add('is-on');
    palInput.value = ''; renderPal(''); palInput.focus();
  }
  function closePal(){ palScrim.classList.remove('is-on'); }

  palInput.addEventListener('input', function(){ renderPal(this.value); });
  palList.addEventListener('click', function(e){
    var b = e.target.closest('.pal-item'); if (!b) return;
    closePal(); palView[+b.dataset.i].act();
  });
  palScrim.addEventListener('click', function(e){ if (e.target === palScrim) closePal(); });

  /* ===================== 上下文菜单 ===================== */
  var menu = $('#menu');
  function openMenu(anchor, items){
    menu.className = 'menu';
    menu.innerHTML = items.map(function(it, i){
      if (it.sep) return '<div class="menu-sep"></div>';
      return '<button class="menu-item" data-i="' + i + '">' + ico(it.ico) + it.label +
             (it.k ? '<span class="k">' + it.k + '</span>' : '') + '</button>';
    }).join('');
    var r = anchor.getBoundingClientRect();
    menu.classList.add('is-on');
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(r.left, innerWidth - w - 8) + 'px';
    menu.style.top  = Math.min(r.bottom + 4, innerHeight - h - 8) + 'px';
    menu._items = items;
  }
  menu.addEventListener('click', function(e){
    var b = e.target.closest('.menu-item'); if (!b) return;
    var it = menu._items[+b.dataset.i];
    closeMenu();
    if (it && it.act) it.act();
  });
  function closeMenu(){ menu.classList.remove('is-on'); menu.className = 'menu'; mbOpen = null; $$('.mb-menu').forEach(function(b){ b.classList.remove('is-on'); }); }

  async function copyText(text){
    try {
      try { await navigator.clipboard.writeText(text); }
      catch (error) {
        if (!window.personalAgentDesktop?.desktopCopy) throw error;
        const result = await window.personalAgentDesktop.desktopCopy(text);
        if (!result?.ok) throw Error('clipboard unavailable');
      }
      toast('已复制到剪贴板');
    } catch (_) { toast('复制失败：剪贴板不可用'); }
  }
  function copyConversation(){
    const live = $('#liveChatList');
    if (!vChat.classList.contains('is-on') || !live || live.hidden || !live.innerText.trim()) { toast('没有可复制的真实对话'); return; }
    void copyText(live.innerText);
  }
  const copyButton = $('.chat-head [title="分享"]');
  copyButton.id = 'btnCopyConversation'; copyButton.title = '复制对话'; copyButton.setAttribute('aria-label','复制对话'); copyButton.textContent = '复制对话'; copyButton.style.width = 'auto'; copyButton.onclick = copyConversation;
  const historyButton = $('.chat-head [title="历史"]'); historyButton.id = 'btnChatHistory'; historyButton.onclick = openTaskSearch;
  const chatMore = $('.chat-head [title="更多"]'); chatMore.id = 'btnChatMore';
  chatMore.onclick = function(e){ e.stopPropagation(); openMenu(this, [
    {ico:'i-plus',label:'新建任务',act:newTask}, {ico:'i-history',label:'历史任务',act:openTaskSearch}, {ico:'i-copy',label:'复制对话',act:copyConversation}
  ]); };
  $('.side-foot .icon-btn').onclick = function(e){ e.stopPropagation(); openMenu(this, [
    {ico:'i-people',label:'个人主页（未实现）',act:function(){openSettings('account');}}, {ico:'i-settings',label:'设置',act:function(){openSettings('settings');}}
  ]); };
  $('#taskGroups').addEventListener('contextmenu', function(e){
    var row = e.target.closest('.session-row'); if (!row) return;
    e.preventDefault();
    const session = sessions.find(s => s.id === row.dataset.session); if (!session) return;
    openMenu(row, [
      { ico:'i-history', label:'打开会话', act:function(){ void openSession(session.id); } },
      { ico:'i-copy', label:'复制标题', act:function(){ void copyText(session.title); } },
      { ico:'i-copy', label:'复制会话 ID', act:function(){ void copyText(session.id); } }
    ]);
  });

  document.addEventListener('click', function(e){
    if (!menu.contains(e.target) && !e.target.closest('#viewSel')) closeMenu();
  });

  /* ===================== 主题 ===================== */
  function toggleTheme(){
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next); prefs.theme = next; savePrefs();
    var ico = $('#icoTheme');   /* 标题栏切换按钮已移除，仅在存在时同步图标 */
    if (ico) ico.innerHTML = '<use href="#' + (next === 'dark' ? 'i-sun' : 'i-moon') + '"/>';
    toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  }

  /* ===================== 提示 ===================== */
  var toastEl = $('#toast'), toastTimer;
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('is-on'); }, 1800);
  }

  /* ===================== 快捷键辅助 ===================== */
  var fontLevel = prefs.font;
  function setFontSize(lv, initial){
    lv = Math.max(-1, Math.min(1, lv));
    fontLevel = lv;
    var d = lv;                                   /* -1 小 / 0 默认 / 1 大 */
    document.documentElement.style.setProperty('--fs-base',    (13 + d) + 'px');
    document.documentElement.style.setProperty('--fs-body',    (14 + d) + 'px');
    document.documentElement.style.setProperty('--fs-caption', (12 + d) + 'px');
    if (!initial) { prefs.font = lv; savePrefs(); toast(d === 0 ? '内容字号：默认' : (d > 0 ? '内容字号：大' : '内容字号：小')); }
  }
  setFontSize(fontLevel, true);
  function stepTask(dir){
    const rows = $$('.session-row');
    if (!rows.length) { toast('没有符合筛选的任务'); return; }
    const current = rows.findIndex(r => r.dataset.session === selectedSessionId);
    const row = rows[current < 0 ? 0 : (current + dir + rows.length) % rows.length];
    row.closest('details').open = true; void openSession(row.dataset.session);
  }
  function locateCurrent(){
    if (!selectedSessionId) { toast('当前会话尚无历史记录'); return; }
    if (filterState.status !== 'all') setFilter('all');
    const row = $$('.session-row').find(r => r.dataset.session === selectedSessionId);
    if (!row) { toast('当前会话不在历史列表中'); return; }
    sidebar.classList.remove('is-collapsed'); if (innerWidth <= 900) sidebar.classList.add('is-open');
    $('#icoCollapse').innerHTML = '<use href="#i-panel-l"/>';
    row.closest('details').open = true; row.scrollIntoView({block:'nearest'}); row.focus();
  }

  /* ===================== 快捷键 ===================== */
  document.addEventListener('keydown', function(e){
    if (e.isComposing) return;
    if (e.key === 'F11'){ e.preventDefault(); winAction('fullscreen'); return; }
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'w'){ e.preventDefault(); winAction('close'); return; }
    if (e.key === 'Escape' && setScrim.classList.contains('is-on')){ e.preventDefault(); closeSettings(); return; }
    /* 与真实客户端 SHORTCUT_DEFINITIONS 对齐（见「设置 → 快捷键」）。注意：带 Shift 的组合必须先判断。 */
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p'){ e.preventDefault(); openPal(); return; }        /* 原型附加：命令面板 */
    if (mod && e.shiftKey && e.key.toLowerCase() === 'b'){ e.preventDefault(); togglePanel(); return; }     /* toggle-artifacts */
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n'){ e.preventDefault(); void newTask(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'e'){ e.preventDefault(); locateCurrent(); return; }
    if (mod && e.key.toLowerCase() === 'k'){ e.preventDefault(); openTaskSearch(); return; }                /* open-global-search */
    if (mod && e.key.toLowerCase() === 'b'){ e.preventDefault(); toggleSidebarCollapse(); return; }         /* toggle-sidebar */
    if (mod && e.key === ','){ e.preventDefault(); openSettings('settings'); return; }                      /* open-settings */
    if (mod && e.key.toLowerCase() === 'n'){ e.preventDefault(); void newTask(); return; }/* new-conversation */
    if (mod && e.key === '['){ e.preventDefault(); stepTask(-1); return; }                                  /* prev-task */
    if (mod && e.key === ']'){ e.preventDefault(); stepTask(1); return; }                                   /* next-task */
    if (mod && (e.key === '=' || e.key === '+')){ e.preventDefault(); setFontSize(fontLevel + 1); return; }
    if (mod && e.key === '-'){ e.preventDefault(); setFontSize(fontLevel - 1); return; }
    if (mod && e.key === '0'){ e.preventDefault(); setFontSize(0); return; }
    if (mod && e.key.toLowerCase() === 'f'){ e.preventDefault(); toast('未接线：对话内搜索'); return; }
    if (mod && e.key.toLowerCase() === 'd'){ e.preventDefault(); toast('未接线：语音录制'); return; }

    if (searchScrim.classList.contains('is-on')){
      if (e.key === 'Escape'){ closeTaskSearch(); }
      else if (e.key === 'ArrowDown'){ e.preventDefault(); moveTs(1); }
      else if (e.key === 'ArrowUp'){ e.preventDefault(); moveTs(-1); }
      else if (e.key === 'Enter'){ e.preventDefault(); openTsCurrent(); }
      return;
    }
    if (palScrim.classList.contains('is-on')){
      if (e.key === 'Escape'){ closePal(); }
      else if (e.key === 'ArrowDown'){ e.preventDefault(); movePal(1); }
      else if (e.key === 'ArrowUp'){ e.preventDefault(); movePal(-1); }
      else if (e.key === 'Enter' && palView[palIdx]){ e.preventDefault(); var it = palView[palIdx]; closePal(); it.act(); }
      return;
    }
    if (e.key === 'Escape'){
      closeMenu();
      closeTaskSearch();

    }
  });

  /* ===================== 窄屏抽屉 ===================== */
  var sidebar = $('#sidebar');
  function syncScrim() {}
  /* 菜单栏最左：侧边栏收起 / 展开（宽屏收成 48px 图标轨，窄屏走抽屉） */
  function toggleSidebarCollapse(){
    if (innerWidth <= 900){
      sidebar.classList.toggle('is-open');
      return;
    }
    var c = sidebar.classList.toggle('is-collapsed');
    $('#icoCollapse').innerHTML = '<use href="#' + (c ? 'i-panel-r' : 'i-panel-l') + '"/>';
    toast(c ? '侧边栏已收起' : '侧边栏已展开');
  }
  $('#btnCollapseSide').addEventListener('click', function(e){
    e.stopPropagation();
    toggleSidebarCollapse();
  });

  document.addEventListener('click', function(e){
    if (innerWidth > 900) return;
    if (!sidebar.classList.contains('is-open')) return;
    if (sidebar.contains(e.target) || e.target.closest('#btnCollapseSide')) return;
    sidebar.classList.remove('is-open');
  });
  addEventListener('resize', function(){ syncScrim(); if (innerWidth > 900) sidebar.classList.remove('is-open'); });
  syncScrim();

  /* ===================== 菜单栏（顶部状态栏） ===================== */
  var mbOpen = null;

  /* ---- 窗口按钮 ---- */
  function syncMaximized(on){
    document.documentElement.classList.toggle('is-win-max', on);
    $('#icoWinMax').innerHTML = '<use href="#' + (on ? 'i-restore' : 'i-max') + '"/>';
  }
  function winAction(kind){
    var desktop = window.personalAgentDesktop;
    if (desktop && typeof desktop.windowAction === 'function'){
      desktop.windowAction(kind).then(function(result){
        if (result && result.ok && kind === 'max') syncMaximized(result.maximized);
      }).catch(function(){ toast('窗口操作失败，请重试'); });
      return;
    }
    toast('窗口控制仅在独立 Electron 客户端中可用');
  }
  if (window.personalAgentDesktop && typeof window.personalAgentDesktop.onMaximized === 'function'){
    window.personalAgentDesktop.onMaximized(syncMaximized);
  }
  $$('.win-btn').forEach(function(b){
    b.addEventListener('click', function(){ winAction(b.dataset.win); });
  });

  async function desktopInfo(showVersion) {
    var bridge = window.personalAgentDesktop;
    if (!bridge || typeof bridge.getInfo !== 'function') {
      $('#sbConnection').textContent = '浏览器预览 · Agent 未接线';
      if (showVersion) toast('浏览器预览：无桌面运行信息');
      return;
    }
    try {
      var info = await bridge.getInfo();
      $('#sbConnection').textContent = '文字聊天已就绪 · Agent 模型工具未接线';
      $('#sbIsolation').textContent = info.sandboxed && info.contextIsolated ? '渲染器已隔离 · 手动工具使用工作区权限' : '警告：渲染器隔离未启用';
      if (showVersion) openSettings('helpFeedback');
    } catch (_) {
      $('#sbConnection').textContent = '桌面信息读取失败 · Agent 未接线';
      $('#sbIsolation').textContent = '隔离状态未知';
      if (showVersion) toast('桌面信息读取失败，请重试');
    }
  }
  void desktopInfo(false);

  /* Preserve native editing focus/selection when opening and using menus. */
  document.addEventListener('pointerdown', function(e){ if (e.target.closest('.mb-menu, .menu-item')) e.preventDefault(); });
  async function editAction(action){
    try {
      if (!window.personalAgentDesktop?.desktopAction) { toast('编辑菜单仅在桌面客户端可用'); return; }
      const result = await window.personalAgentDesktop.desktopAction(action);
      if (!result?.ok) toast('编辑操作失败');
    } catch (_) { toast('编辑操作失败'); }
  }
  /* ---- 顶部菜单定义 ---- */
  var MENUS = {
    edit: [
      { label:'撤销', k:'Ctrl+Z', act:function(){ void editAction('undo'); } },
      { label:'重做', k:'Ctrl+Y', act:function(){ void editAction('redo'); } },
      { sep:true },
      { label:'剪切', k:'Ctrl+X', act:function(){ void editAction('cut'); } },
      { label:'复制', k:'Ctrl+C', act:function(){ void editAction('copy'); } },
      { label:'粘贴', k:'Ctrl+V', act:function(){ void editAction('paste'); } },
      { sep:true },
      { label:'全选', k:'Ctrl+A', act:function(){ void editAction('selectAll'); } },
      { label:'查找任务', k:'Ctrl+K', act:function(){ openTaskSearch(); } }
    ],
    window: [
      { label:'最小化', act:function(){ winAction('min'); } },
      { label:'最大化 / 还原', act:function(){ winAction('max'); } },
      { label:'全屏', k:'F11', act:function(){ winAction('fullscreen'); } },
      { sep:true },
      { label:'重置窗口大小', act:function(){ winAction('reset'); } },
      { label:'新建窗口', act:function(){ winAction('new'); } },
      { sep:true },
      { label:'关闭窗口', k:'Ctrl+W', act:function(){ winAction('close'); } }
    ],
    help: [
      { label:'使用帮助 / 运行信息', act:function(){ openSettings('getHelp'); } },
      { label:'诊断工具', act:function(){ openSettings('helpFeedback'); } },
      { label:'资源占用', act:function(){ toast('未接线：资源占用'); } },
      { label:'打开日志目录(L)', act:function(){ toast('未接线：日志目录'); } },
      { label:'意见反馈', act:function(){ toast('未接线：意见反馈'); } }
    ],
    about: [
      { label:'检查更新', act:function(){ toast('未接线：检查更新'); } },
      { label:'版本信息', act:function(){ void desktopInfo(true); } },
      { label:'开源许可', act:function(){ toast('未接线：许可查看器'); } },
      { label:'访问官网', act:function(){ toast('未接线：访问官网'); } }
    ]
  };

  function openBarMenu(name, btn){
    var items = MENUS[name] || [];
    menu.className = 'menu menu--bar is-on';
    menu.innerHTML = items.map(function(it, i){
      if (it.sep) return '<div class="menu-sep"></div>';
      return '<button class="menu-item" data-i="' + i + '">' + it.label +
             (it.k ? '<span class="k">' + it.k + '</span>' : '') + '</button>';
    }).join('');
    menu._items = items;
    menu.style.left = '0px'; menu.style.top = '0px';
    var r = btn.getBoundingClientRect();
    menu.style.left = Math.min(r.left, Math.max(6, innerWidth - menu.offsetWidth - 6)) + 'px';
    menu.style.top  = (r.bottom + 2) + 'px';
    mbOpen = name;
    $$('.mb-menu').forEach(function(b){ b.classList.toggle('is-on', b === btn); });
  }

  $$('.mb-menu').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      if (mbOpen === btn.dataset.menu){ closeMenu(); return; }
      openBarMenu(btn.dataset.menu, btn);
    });
    btn.addEventListener('mouseenter', function(){
      if (mbOpen && mbOpen !== btn.dataset.menu) openBarMenu(btn.dataset.menu, btn);
    });
  });

  /* ---- 设置 ---- */
  $('#btnSettings').addEventListener('click', function(e){
    e.stopPropagation();
    openMenu(this, [
      { ico:'i-settings', label:'通用设置', k:'Ctrl+,', act:function(){ openSettings('settings'); } },
      { ico:'i-wand',     label:'外观',            act:function(){ openSettings('appearance'); } },
      { ico:'i-cloud',    label:'模型',            act:function(){ openSettings('models'); } },
      { ico:'i-shield',   label:'安全中心', act:function(){ openSettings('securityCenter'); } },
      { ico:'i-slash',    label:'快捷键',       act:function(){ openSettings('keyboardShortcuts'); } },
      { sep:true },
      { ico:'i-refresh',  label:'检查更新',  act:function(){ toast('未接线：检查更新'); } }
    ]);
  });

  /* ---- 筛选 ---- */
  function setFilter(k){
    filterState.status = k;
    $('#filterDot').style.display = (k === 'all') ? 'none' : '';
    $('#btnFilter').classList.toggle('is-on', k !== 'all');
    renderSessions();
    toast('筛选：' + FILTER_LABEL[k]);
  }
  $('#btnFilter').addEventListener('click', function(e){
    e.stopPropagation();
    var self = this;
    var opts = [
      { k:'all', ico:'i-grid'  },
      { k:'unknown', ico:'i-clock' },
      { k:'ok',  ico:'i-check' },
      { k:'err', ico:'i-close' }
    ];
    openMenu(self, opts.map(function(o){
      return {
        ico:o.ico,
        label: FILTER_LABEL[o.k] + (filterState.status === o.k ? '  ✓' : ''),
        act: function(){ setFilter(o.k); }
      };
    }));
  });

  /* ---- 任务搜索 ---- */
  var searchScrim = $('#searchScrim'), tsInput = $('#tsInput'), tsList = $('#tsList');
  var tsView = [], tsIdx = 0;

  function esc(t){
    return String(t).replace(/[&<>"]/g, function(c){
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c];
    });
  }
  function hl(text, q){
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }
  function renderTs(q){
    q = (q || '').trim();
    var ql = q.toLowerCase();
    const previousId = tsView[tsIdx]?.id;
    tsView = sessions.filter(function(t){
      return !ql || t.title.toLowerCase().includes(ql) || (t.workspaceRoot || '').toLowerCase().includes(ql);
    });
    tsIdx = Math.max(0, tsView.findIndex(t => t.id === previousId));
    $('#tsCount').textContent = q ? (tsView.length + ' 条结果') : (sessions.length + ' 个任务');
    if (!tsView.length){
      tsList.innerHTML = '<div class="ts-empty">没有匹配「' + esc(q) + '」的任务</div>';
      return;
    }
    var html = '', last = null;
    tsView.forEach(function(t, i){
      const root = t.workspaceRoot || '未关联工作区';
      if (root !== last){
        html += '<div class="ts-grp">' + ico('i-folder') + '<span>' + hl(root, q) + '</span></div>';
        last = root;
      }
      html += '<button class="ts-row' + (i === tsIdx ? ' is-on' : '') + '" data-i="' + i + '">' +
                '<span class="nm">' + hl(t.title, q) + '</span>' +
                '<span class="tm">' + esc(FILTER_LABEL[sessionStatus(t)]) + '</span>' +
              '</button>';
    });
    tsList.innerHTML = html;
  }
  function moveTs(d){
    if (!tsView.length) return;
    tsIdx = (tsIdx + d + tsView.length) % tsView.length;
    var rows = $$('.ts-row', tsList);
    rows.forEach(function(r, i){ r.classList.toggle('is-on', i === tsIdx); });
    if (rows[tsIdx] && rows[tsIdx].scrollIntoView) rows[tsIdx].scrollIntoView({ block:'nearest' });
  }
  function openTsCurrent(){
    var t = tsView[tsIdx]; if (!t) return;
    closeTaskSearch();
    void openSession(t.id);
  }
  function openTaskSearch(){
    searchScrim.classList.add('is-on');
    tsInput.value = '';
    renderTs(''); void refreshSessions();
    setTimeout(function(){ tsInput.focus(); }, 40);
  }
  function closeTaskSearch(){ searchScrim.classList.remove('is-on'); }

  $('#btnTaskSearch').addEventListener('click', function(e){
    e.stopPropagation(); openTaskSearch();
  });
  tsInput.addEventListener('input', function(){ renderTs(this.value); });
  tsList.addEventListener('click', function(e){
    var r = e.target.closest('.ts-row'); if (!r) return;
    tsIdx = +r.dataset.i; openTsCurrent();
  });
  searchScrim.addEventListener('click', function(e){
    if (e.target === searchScrim) closeTaskSearch();
  });

  // Token usage stays explicitly unwired until supplied by the real runtime.

  /* ===================== 初始化 ===================== */
  renderSessions();

  /* ===================== Hash 深链路由 ===================== */
  /* #chat #art #file #term #browser #pick #dark 便于逐屏直达与截图核验 */
  function route(){
    var h = (location.hash || '').replace('#','');
    if (!h) return;
    if (h === 'dark'){ document.documentElement.setAttribute('data-theme','dark'); return; }
    if (h === 'chat'){ showChat(); return; }
    if (h === 'pal'){ setTimeout(openPal, 80); return; }
    if (h === 'search'){ setTimeout(openTaskSearch, 80); return; }
    if (h === 'collapsed'){ setTimeout(toggleSidebarCollapse, 80); return; }
    if (h === 'menu-help'){ setTimeout(function(){ var b=document.querySelector('[data-menu="help"]'); openBarMenu('help', b); }, 80); return; }
    if (h === 'menu-window'){ setTimeout(function(){ var b=document.querySelector('[data-menu="window"]'); openBarMenu('window', b); }, 80); return; }
    if (h === 'more'){ setTimeout(function(){ setMore(true); }, 80); return; }
    if (h === 'filter'){ setTimeout(function(){ $('#btnFilter').click(); }, 80); return; }
    if (h === 'settings'){ setTimeout(function(){ openSettings('settings'); }, 80); return; }
    if (h === 'appearance'){ setTimeout(function(){ openSettings('appearance'); }, 80); return; }
    if (h === 'models'){ setTimeout(function(){ openSettings('models'); }, 80); return; }
    if (h === 'shortcuts'){ setTimeout(function(){ openSettings('keyboardShortcuts'); }, 80); return; }
  }
  window.addEventListener('hashchange', route);
  route();

  if (!location.hash) toast('选择模型开始聊天 · 无工具');
})();
