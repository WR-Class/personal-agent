(function(){
  'use strict';
  var $  = function(s,r){ return (r||document).querySelector(s); };
  var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

  /* ===================== 数据 ===================== */
  var GROUPS = [
    { name:'JM', path:'示例工作区（未接线）', open:true, items:[
      { t:'Northwind 定价页改版', time:'刚刚',  st:'run', on:true },
      { t:'内置浏览器元素拾取联调', time:'12:40', st:'ok' },
      { t:'侧栏按项目目录分组',     time:'11:05', st:'ok' },
      { t:'整理季度财报成网页',     time:'昨天',  st:'err' }
    ]},
    { name:'示例文档', path:'示例目录（未接线）', open:true, items:[
      { t:'设计令牌对照表梳理',   time:'昨天', st:'ok' },
      { t:'令牌提取脚本重构',     time:'周一', st:'ok' }
    ]},
    { name:'sandbox', path:'C:\\Users\\RongWu\\sandbox', open:false, items:[
      { t:'asr 音频转写实验', time:'周日', st:'ok' }
    ]}
  ];
  /* 筛选状态：all / run / ok / err —— 对应任务运行状态 */
  var filterState = { status:'all' };
  var FILTER_LABEL = { all:'全部任务', run:'进行中', ok:'已完成', err:'失败' };
  function passFilter(it){ return filterState.status === 'all' || it.st === filterState.status; }

  /* 全量任务索引，供任务搜索使用 */
  var TASK_INDEX = [];
  GROUPS.forEach(function(g){
    g.items.forEach(function(it){
      TASK_INDEX.push({ t:it.t, time:it.time, st:it.st, group:g.name, path:g.path });
    });
  });
  var SCENES = {
    working:{ ph:'描述你想完成的任务…  例如：把这份季度财报整理成可分享的网页', label:'日常办公' },
    coding: { ph:'描述你想实现的功能…  例如：给定价页加一个席位滑块，实时算总价', label:'代码开发' },
    design: { ph:'描述你想要的视觉方向…  例如：做一版更克制的定价页，主推团队版', label:'设计创意' }
  };

  /* ===================== 侧栏渲染 ===================== */
  function ico(id, cls){ return '<svg class="ico '+(cls||'')+'"><use href="#'+id+'"/></svg>'; }

  function renderGroups(){
    var host = $('#taskGroups');
    host.innerHTML = GROUPS.map(function(g, gi){
      var items = g.items.map(function(it, ii){ return { it:it, ii:ii }; })
                         .filter(function(o){ return passFilter(o.it); });
      if (!items.length) return '';
      var rows = items.map(function(o){
        var it = o.it, ii = o.ii;
        return '<button class="chat-row'+(it.on?' is-on':'')+'" data-g="'+gi+'" data-i="'+ii+'">'+
                 '<span class="dot'+(it.st?' dot--'+it.st:'')+'"></span>'+
                 '<span class="chat-name">'+it.t+'</span>'+
                 '<span class="chat-time">'+it.time+'</span>'+
               '</button>';
      }).join('');
      return '<div class="grp'+(g.open?'':' is-collapsed')+'" data-g="'+gi+'">'+
               '<button class="grp-row">'+
                 ico('i-chev-d','twist')+
                 ico('i-folder')+
                 '<span class="grp-name">'+g.name+'</span>'+
                 '<span class="grp-path">'+g.path+'</span>'+
                 '<span class="grp-count">'+items.length+'</span>'+
               '</button>'+
               '<div class="grp-list">'+rows+'</div>'+
             '</div>';
    }).join('');
  }

  var historyRequest = 0;
  $('#historyDialog').addEventListener('close', function() { historyRequest++; $('#historyBody').replaceChildren(); });
  async function openHistory(id) {
    var request = ++historyRequest, dialog = $('#historyDialog'), body = $('#historyBody');
    body.replaceChildren();
    $('#historyTitle').textContent = '会话历史 · ' + id;
    $('#historyStatus').textContent = '读取中…';
    if (!dialog.open) dialog.showModal();
    try {
      var result = await window.personalAgentDesktop.readHistory(id);
      if (request !== historyRequest || !dialog.open) return;
      $('#historyStatus').textContent = '只读预览，不发送、不重放工具。共 ' + result.total + ' 条消息' + (result.truncated ? '，仅显示最后 200 条' : '');
      result.messages.forEach(function(message) {
        var section = document.createElement('section'), heading = document.createElement('h3'), text = document.createElement('pre');
        heading.textContent = message.role;
        text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere';
        text.textContent = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
        section.append(heading, text);
        if (message.toolCalls && message.toolCalls.length) {
          var calls = document.createElement('pre'); calls.style.whiteSpace = 'pre-wrap'; calls.style.overflowWrap = 'anywhere';
          calls.textContent = '工具调用记录（未执行）\n' + JSON.stringify(message.toolCalls, null, 2); section.append(calls);
        }
        body.append(section);
      });
    } catch (_) {
      if (request === historyRequest) $('#historyStatus').textContent = '读取失败：会话不存在、损坏、受保护或超过 1 MiB；未修改日志。关闭后可重试。';
    }
  }

  async function refreshSessions() {
    var button = $('#refreshSessions'), status = $('#sessionListStatus'), host = $('#savedSessions');
    if (button.disabled) return;
    host.replaceChildren();
    var bridge = window.personalAgentDesktop;
    if (!bridge || typeof bridge.listSessions !== 'function') {
      status.textContent = '浏览器预览：本地会话不可用';
      return;
    }
    button.disabled = true;
    status.textContent = '正在读取本地会话…';
    try {
      var result = await bridge.listSessions();
      result.ids.forEach(function(id) {
        var row = document.createElement('button');
        row.addEventListener('click', function() { void openHistory(id); });
        row.className = 'chat-row';
        var name = document.createElement('span');
        name.className = 'chat-name'; name.textContent = id; row.title = id;
        row.append(name); host.append(row);
      });
      status.textContent = result.total ? '已保存 ' + result.total + ' 个会话' + (result.truncated ? '（仅显示前 100 个）' : '') + ' · 点击只读预览' : '尚无已保存会话';
    } catch (_) {
      status.textContent = '会话读取失败，请检查宿主 PERSONAL_AGENT_HOME 与目录权限；点击刷新重试';
    } finally { button.disabled = false; }
  }
  $('#refreshSessions').addEventListener('click', refreshSessions);
  void refreshSessions();

  $('#openEcho').addEventListener('click', function() { $('#echoDialog').showModal(); });
  $('#echoSend').addEventListener('click', async function() {
    var button = this, input = $('#echoInput').value, status = $('#echoStatus');
    if (button.disabled) return;
    if (!input.trim() || new TextEncoder().encode(input).length > 8192) {
      status.textContent = '请输入 1–8192 字节文本'; return;
    }
    var bridge = window.personalAgentDesktop;
    if (!bridge || typeof bridge.sendEcho !== 'function') { status.textContent = '浏览器预览不支持本地运行时'; return; }
    button.disabled = true; $('#echoInput').disabled = true;
    $('#echoReply').textContent = ''; status.textContent = '本地回显中（非模型）…';
    try {
      var result = await bridge.sendEcho(input);
      $('#echoReply').textContent = result.content;
      status.textContent = '已保存离线测试会话：' + result.id;
      await refreshSessions();
    } catch (_) {
      status.textContent = '离线测试失败，可能已保存部分日志；请刷新会话检查。未自动重试。';
    } finally { button.disabled = false; $('#echoInput').disabled = false; }
  });

  var modelSending = false, modelRequest = 0, modelToken;
  $('#modelDialog').addEventListener('close', function() { modelRequest++; modelToken = undefined; $('#modelSend').disabled = true; });
  $('#openModel').addEventListener('click', async function() {
    $('#modelDialog').showModal();
    if (modelSending) return;
    var request = ++modelRequest;
    modelToken = undefined;
    $('#modelSend').disabled = true; $('#modelTarget').textContent = '';
    $('#modelStatus').textContent = '读取宿主配置…';
    try {
      var config = await window.personalAgentDesktop.getProvider();
      if (request !== modelRequest || !$('#modelDialog').open) return;
      modelToken = config.token;
      $('#modelTarget').textContent = '目标：' + config.baseUrl + ' · 模型：' + config.model;
      $('#modelStatus').textContent = '配置已读取（不代表服务已连通）；请确认后发送。';
      $('#modelSend').disabled = false;
    } catch (_) { if (request !== modelRequest) return; $('#modelStatus').textContent = '配置不可用，请在 CLI 配置完整 Provider 后重新打开。浏览器预览不支持发送。'; }
  });
  $('#modelSend').addEventListener('click', async function() {
    if (modelSending || this.disabled) return;
    var input = $('#modelInput').value;
    if (!input.trim() || new TextEncoder().encode(input).length > 8192) { $('#modelStatus').textContent = '请输入 1–8192 字节文本'; return; }
    modelSending = true; this.disabled = true; $('#modelInput').disabled = true;
    $('#modelReply').textContent = ''; $('#modelStatus').textContent = '请求中…关闭窗口不会取消；不要重复发送。';
    try {
      var result = await window.personalAgentDesktop.sendModel(input, modelToken);
      $('#modelReply').textContent = result.content;
      $('#modelStatus').textContent = '已保存：' + result.id + ' · ' + result.model + '；再次发送请关闭后重新确认配置。';
      await refreshSessions();
    } catch (_) { $('#modelStatus').textContent = '请求失败，可能已计费或保存部分日志；请检查配置与历史。未自动重试，重新发送前须再次确认配置。'; }
    finally { modelSending = false; $('#modelInput').disabled = false; }
  });

  /* ===================== 视图切换 ===================== */
  var vHome = $('#vHome'), vChat = $('#vChat');

  function showChat(title){
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

  /* ===================== 右侧面板 ===================== */
  var panel = $('#panel'), pickOn = true;
  var VIEW_LABEL = { browser:'浏览器', art:'产物', file:'全部文件', term:'终端' };

  function showPane(name){
    $$('.pane').forEach(function(p){ p.classList.toggle('is-on', p.dataset.pane === name); });
    $$('#atabs .atab').forEach(function(t){ t.classList.toggle('is-on', t.dataset.pane === name); });
    $('#viewSelLabel').textContent = VIEW_LABEL[name] || name;
    panel.classList.remove('is-hidden');
    if (typeof syncScrim === 'function') syncScrim();
  }

  $('#viewSel').addEventListener('click', function(e){
    e.stopPropagation();
    openMenu(this, [
      { ico:'i-globe',    label:'浏览器',   act:function(){ showPane('browser'); } },
      { ico:'i-package',  label:'产物',     act:function(){ showPane('art'); } },
      { ico:'i-folder',   label:'全部文件', act:function(){ showPane('file'); } },
      { ico:'i-terminal', label:'终端',     act:function(){ showPane('term'); } }
    ]);
  });

  $('#atabs').addEventListener('click', function(e){
    var tab = e.target.closest('.atab'); if (!tab) return;
    if (e.target.closest('.x')) { tab.remove(); return; }
    showPane(tab.dataset.pane);
  });

  function togglePanel(force){
    var hide = (typeof force === 'boolean') ? force : !panel.classList.contains('is-hidden');
    panel.classList.toggle('is-hidden', hide);
    if (typeof syncScrim === 'function') syncScrim();
    toast(hide ? '已收起右侧面板' : '已展开右侧面板');
  }
  $('#btnTogglePanel').addEventListener('click', function(){ togglePanel(); });
  $('#btnClosePanel').addEventListener('click', function(){ togglePanel(true); });

  /* ===================== 元素拾取 ===================== */
  var box = $('#pickBox'), pin = $('#pickPin'), size = $('#pickSize'), cta = $('#pickCta');
  var stage = $('#brwStage');

  function clearPick(){
    [box,pin,size,cta].forEach(function(el){ el.style.display = 'none'; });
  }

  function pickAt(el){
    var sr = stage.getBoundingClientRect();
    var r  = el.getBoundingClientRect();
    var x = r.left - sr.left + stage.scrollLeft;
    var y = r.top  - sr.top  + stage.scrollTop;
    box.style.display = 'block';
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    pin.style.display = 'grid';
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    size.style.display = 'block';
    size.style.left = x + 'px'; size.style.top = (y + r.height + 8) + 'px';
    size.textContent = Math.round(r.width) + '×' + Math.round(r.height);
    cta.style.display = 'flex';
    var cls = el.className.split(' ')[0] || 'div';
    var tag = el.tagName.toLowerCase();
    var id  = el.dataset.plan ? '#' + el.dataset.plan : (el.id ? '#' + el.id : '');
    $('#pickSel').textContent = tag + (cls && cls !== tag ? '.' + cls : '') + id;
    $('#pickDim').textContent = Math.round(r.width) + '×' + Math.round(r.height);
  }

  $('#brwPage').addEventListener('click', function(e){
    if (!pickOn) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target.closest('[data-plan], .wp-plan, .wp-hero, .wp-nav, .wp-cta');
    pickAt(el || e.target);
  }, true);

  $('#brwPage').addEventListener('mouseover', function(e){
    if (!pickOn) return;
    var el = e.target.closest('[data-plan], .wp-plan, .wp-hero, .wp-nav, .wp-cta');
    if (el) el.style.outline = '2px dashed rgba(229,72,77,.45)';
  });
  $('#brwPage').addEventListener('mouseout', function(e){
    if (e.target.style) e.target.style.outline = '';
  });

  $('#brwPick').addEventListener('click', function(){
    pickOn = !pickOn;
    this.classList.toggle('is-on', pickOn);
    if (!pickOn) clearPick();
    toast(pickOn ? '元素拾取已开启：点击页面任意元素' : '元素拾取已关闭');
  });

  $('#pickCancel').addEventListener('click', function(e){ e.stopPropagation(); clearPick(); });

  $('#pickSend').addEventListener('click', function(e){
    e.stopPropagation();
    var sel = $('#pickSel').textContent, dim = $('#pickDim').textContent;
    var ta = $('#taChat');
    ta.value = '看这里：' + sel + '（' + dim + '）。把它的内边距收紧一些，标题和价格再拉开一点层级。';
    autoGrow(ta); syncSend(ta, $('#sendChat'));
    showChat();
    clearPick();
    toast('已放入输入框；Agent 尚未接线');
    setTimeout(function(){ ta.focus(); }, 60);
  });

  $('#brwReload').addEventListener('click', function(){
    var p = $('#brwPage');
    p.style.transition = 'opacity .18s ease';
    p.style.opacity = '.35';
    setTimeout(function(){ p.style.opacity = '1'; }, 180);
    toast('已重新加载预览');
  });

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
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing){
        e.preventDefault();
        if (ta.value.trim()) onSend(ta.value.trim());
      }
    });
    btn.addEventListener('click', function(){ if (ta.value.trim()) onSend(ta.value.trim()); });
    autoGrow(ta); syncSend(ta, btn);
  }

  function pushMsg(text){
    var list = $('.chat-list');
    var wrap = document.createElement('div');
    wrap.className = 'msg msg--user';
    wrap.innerHTML = '<div class="msg-avatar">RW</div><div class="msg-body"><div class="bubble"></div></div>';
    $('.bubble', wrap).textContent = text;
    list.appendChild(wrap);

    var rep = document.createElement('div');
    rep.className = 'msg msg--agent';
    rep.textContent = '未接线：消息仅展示在当前窗口，未发送给模型、未执行工具，也未保存。';
    list.appendChild(rep);
    var sc = $('#chatScroll');
    sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
  }

  bindComposer($('#taHome'), $('#sendHome'), function(v){ pushMsg(v); $('#taHome').value=''; autoGrow($('#taHome')); syncSend($('#taHome'), $('#sendHome')); showChat('新任务 · ' + v.slice(0,14)); });
  bindComposer($('#taChat'), $('#sendChat'), function(v){ pushMsg(v); $('#taChat').value=''; autoGrow($('#taChat')); syncSend($('#taChat'), $('#sendChat')); });
  $('#btnStop').addEventListener('click', function(){ toast('未接线：当前没有真实运行的任务'); });

  /* ===================== 场景标签 ===================== */
  $('#sceneTabs').addEventListener('click', function(e){
    var b = e.target.closest('.scene'); if (!b) return;
    $$('.scene', this).forEach(function(x){ x.classList.remove('is-on'); });
    b.classList.add('is-on');
    var s = SCENES[b.dataset.scene];
    var ta = $('#taHome');
    ta.placeholder = s.ph;
    ta.focus();
    toast('已切换到「' + s.label + '」场景');
  });

  /* ===================== 模式切换 ===================== */
  document.addEventListener('click', function(e){
    var m = e.target.closest('.chip-btn[data-mode]'); if (!m) return;
    var bar = m.parentElement;
    $$('.chip-btn[data-mode]', bar).forEach(function(x){ x.classList.remove('is-on'); });
    m.classList.add('is-on');
    toast('模式：' + (m.dataset.mode === 'plan' ? '计划' : '仅问答'));
  });

  /* ===================== 侧栏交互 ===================== */
  $('#taskGroups').addEventListener('click', function(e){
    var gr = e.target.closest('.grp-row');
    if (gr){
      var g = gr.closest('.grp');
      g.classList.toggle('is-collapsed');
      GROUPS[+g.dataset.g].open = !g.classList.contains('is-collapsed');
      return;
    }
    var row = e.target.closest('.chat-row');
    if (row){
      $$('.chat-row').forEach(function(r){ r.classList.remove('is-on'); });
      row.classList.add('is-on');
      showChat(row.querySelector('.chat-name').textContent);
    }
  });

  $('.sec-head').addEventListener('click', function(){
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
      var map = { assistant:'助理', project:'项目', expert:'专家', automation:'定时任务' };
      toast('未接线：' + map[b.dataset.nav]);
    });
  });

  $$('.nav-sub-item').forEach(function(b){
    b.addEventListener('click', function(){
      $$('.nav-sub-item').forEach(function(x){ x.classList.remove('is-on'); });
      b.classList.add('is-on');
      $$('.nav-item').forEach(function(x){ x.classList.remove('is-on'); });
      $('#navMore').classList.add('is-on');
      toast('未接线：' + $('span', b).textContent);
    });
  });

  $('#btnNew').addEventListener('click', function(){
    showHome();
    $('#taHome').focus();
    toast('新建任务');
  });
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
    { c:'editing',    l:'停止生成',         k:'Escape',       e:true },
    { c:'editing',    l:'对话内搜索',       k:'Ctrl+F',       e:true },
    { c:'editing',    l:'语音录制开关',     k:'Ctrl+D',       e:true },
    { c:'editing',    l:'唤起选择器',       k:'@',            e:false },
    { c:'editing',    l:'唤起斜杠命令',     k:'/',            e:false },
    { c:'window',     l:'打开设置',         k:'Ctrl+,',       e:true },
    { c:'window',     l:'切换左侧栏',       k:'Ctrl+B',       e:true },
    { c:'window',     l:'切换右侧产物面板', k:'Ctrl+Shift+B', e:true },
    { c:'window',     l:'进入/退出全屏',    k:'F11',          e:true },
    { c:'window',     l:'唤起/隐藏主窗口',  k:'Shift+Alt+W',  e:true }
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
  function sw(on){ return '<span class="sw' + (on ? ' is-on' : '') + '"></span>'; }
  function seg(opts, active){
    return '<span class="seg">' + opts.map(function(o){
      return '<button data-seg="' + o + '"' + (o === active ? ' class="is-on"' : '') + '>' + o + '</button>';
    }).join('') + '</span>';
  }
  function sel(opts, active){
    return '<select class="set-sel">' + opts.map(function(o){
      return '<option' + (o === active ? ' selected' : '') + '>' + o + '</option>';
    }).join('') + '</select>';
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
    return sSec('基本设置')
      + sRow('主题', '选择应用程序的显示主题。', seg(['浅色','深色'], isDark() ? '深色' : '浅色'))
      + sRow('字体大小', '调整界面与内容的文字大小。', seg(['小','默认','大'], ['小','默认','大'][fontLevel + 1]))
      + sRow('简洁模式', '开启后将简化对话界面显示，隐藏部分装饰性元素。', sw(false))
      + sRow('显示语言', '设置应用程序界面的显示语言。', sel(['简体中文','繁體中文','English','日本語'], '简体中文'))
      + sRow('发送消息', '设置聊天输入框中发送消息的快捷键。', seg(['Enter','Ctrl+Enter'], 'Enter'))
      + sSec('通知')
      + sRow('客户端通知', '运营消息优先在应用内显示，应用切换到后台以后自动转桌面通知', sw(true))
      + sRow('桌面通知', '任务完成或有新消息时，通过系统弹窗提醒你', sw(false))
      + sRow('通知提示音', '收到桌面或应用内通知时播放的提示音', sel(['无音效','晴朗','沉稳','灵动'], '无音效'))
      + sSec('权限与安全')
      + sRow('沙箱安全', '关闭后，您对自己的数据安全负责，AI 对工作空间外文件的修改和删除可能会自动执行，请谨慎操作。默认权限下，仍然会保留对高危指令的确认、删除文件的确认等基础安全机制。', sw(true))
      + sRow('专家与技能推荐', '每次启动新任务时，为你推荐适合完成任务的专家与技能', sw(true))
      + sRow('自动安装可信技能', '安全检测通过后自动安装，高风险项始终要求手动确认', sw(true))
      + sSec('通用')
      + sRow('开机自启', '开启后 Personal Agent 会在你登录电脑后自动启动。', sw(false))
      + sRow('启动强制自动更新', '开启后 Personal Agent 启动时若检测到新版本，会自动下载并重启升级，无需手动确认。', sw(false))
      + sRow('链接打开方式', '按需模式下，本地预览链接在 Personal Agent 内置浏览器打开，其他链接默认使用系统浏览器；按住修饰键点击始终外部打开。', sel(['按需（默认）','始终内置','始终外部'], '按需（默认）'))
      + sRow('网络代理', '配置 Personal Agent 访问网络的方式。修改后立即生效，无需重启。', sel(['直接连接','跟随系统','手动配置'], '直接连接'))
      + sRow('锁屏远程', '选择锁屏后的运行方式，保障远程控制与后台 Agent 任务持续执行', sel(['关闭','熄屏后保持唤醒','保持屏幕常亮'], '熄屏后保持唤醒'))
      + sSec('存储')
      + sRow('系统缓存目录', '未接线：尚未读取实际缓存目录', txt('打开目录'))
      + sRow('任务保留期限', '过期会清理任务对话记录；仅对新任务生效，已有任务不受影响。', sel(['30 天','60 天','90 天','永久保留'], '90 天'))
      + sRow('默认工作空间存储路径', '新建任务、工作空间时将自动存放在该路径下；修改后不影响已有数据。', txt('未接线：尚未选择工作区'))
      + sSec('隐私')
      + sRow('体验优化计划', '允许使用你的对话数据帮助改进模型。数据会先加密脱敏，且无法关联到你个人。', sw(false));
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

  PANELS.models = function(){
    return sSec('自定义模型')
      + '<div class="set-empty"><div class="set-empty-t">还没有配置自定义模型</div>'
      + '<div class="set-empty-d">未接线：此处仅为模型配置设计，不保存配置，不读取或传输 API Key。</div>'
      + '<button class="set-btn set-btn--primary">添加模型</button></div>'
      + sSec('字段说明')
      + sRow('供应商', '仅支持 OpenAI 兼容协议 API。', txt('OpenAI 兼容'))
      + sRow('模型名称', '输入模型参数值，例如 gpt-4o 或 openai/gpt-4o', txt('gpt-4o'))
      + sRow('接口地址', 'https://api.example.com/v1/chat/completions', txt('https://…/v1'))
      + sRow('API Key', '输入你的 API Key。本地部署无需 API Key。', txt('sk-••••••••'))
      + sSec('高级配置')
      + sRow('最大输入 Token', '单次请求可接受的最大上下文长度。留空时跟随提供商默认值。', txt('使用提供商默认值'))
      + sRow('最大输出 Token', '单次回复可生成的最大 Token 数。留空时跟随提供商默认值。', txt('使用提供商默认值'))
      + sRow('思考模式', '将该模型标记为思考模型，客户端会据此开启相关能力和交互。', sw(false))
      + sRow('图片输入', '允许在聊天时向该模型发送图片附件。', sw(false))
      + sRow('工具调用', '允许模型调用智能体运行时暴露出来的工具和函数。', sw(true))
      + sRow('自定义协议', '开启后将直接使用填写的接口地址，不再自动补全 /chat/completions 路径。', sw(false))
      + sSec('本地模型')
      + sRow('本地运行的 AI 模型', '下载并管理本地运行的 AI 模型，支持 GPU / CPU 推理引擎与硬件要求校验。', txt('未下载'))
      + sRow('本地配置文件', 'models.json', txt('打开'));
  };

  PANELS.securityCenter = function(){
    return sSec('沙箱与安全')
      + sRow('沙箱安全', '关闭后，您对自己的数据安全负责，AI 对工作空间外文件的修改和删除可能会自动执行，请谨慎操作。', sw(true))
      + sSec('数据安全')
      + sRow('数据脱敏', '上传到云端的对话数据会先加密脱敏，且无法关联到你个人。', sw(true))
      + sSec('运行时')
      + sRow('高危指令确认', '对高危指令保留二次确认。', sw(true))
      + sSec('审计')
      + sRow('审计日志', '记录工具调用与文件写入，便于事后追溯。', sw(false))
      + sSec('实验性')
      + sRow('开发者模式', '开放调试入口与详细日志。', sw(false));
  };

  PANELS.keyboardShortcuts = function(){
    var q = scQuery.toLowerCase();
    var h = sSec('快捷键')
      + '<div class="sc-tools">'
      + '<input class="sc-search" id="scSearch" placeholder="搜索快捷键" value="' + esc(scQuery) + '">'
      + '<span class="sc-count">共 ' + SC.length + ' 条</span>'
      + '<button class="set-btn" id="scReset">全部恢复默认</button></div>';
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

  function renderSettings(id){
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
    $('#setBody').innerHTML = '<p role="status">未接线：除主题与字号外，本页为界面演示，不改变运行时权限，不保存配置。</p>' + renderPanel(currentTab);
    $('#setBody').scrollTop = 0;
  }
  function openSettings(tab){ renderSettings(tab || 'settings'); setScrim.classList.add('is-on'); }
  function closeSettings(){ setScrim.classList.remove('is-on'); }

  function applyTheme(mode){
    if ((mode === 'dark') !== isDark()) toggleTheme();
    renderSettings(currentTab);
  }

  $('#setNav').addEventListener('click', function(e){
    var b = e.target.closest('[data-tab]');
    if (b) renderSettings(b.dataset.tab);
  });
  $('#setBody').addEventListener('click', function(e){
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
      return;
    }
    var swEl = e.target.closest('.sw');
    if (swEl){ toast('未接线：不会改变真实配置或权限'); return; }
    if (e.target.closest('.set-btn:not(#scReset), .set-txt')){ toast('未接线：配置操作'); return; }
    if (e.target.closest('#scReset')){ scQuery = ''; renderSettings('keyboardShortcuts'); toast('所有快捷键已恢复至初始态'); return; }
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
    { sec:'任务', ico:'i-sparkle', label:'新建任务',           k:'Ctrl N', act:function(){ showHome(); } },
    { sec:'任务', ico:'i-history', label:'Northwind 定价页改版', k:'',       act:function(){ showChat('Northwind 定价页改版'); } },
    { sec:'任务', ico:'i-history', label:'内置浏览器元素拾取联调', k:'',     act:function(){ showChat('内置浏览器元素拾取联调'); } },
    { sec:'视图', ico:'i-globe',   label:'打开浏览器面板',      k:'',       act:function(){ showPane('browser'); } },
    { sec:'视图', ico:'i-package', label:'打开产物面板',        k:'',       act:function(){ showPane('art'); } },
    { sec:'视图', ico:'i-folder',  label:'打开文件树',          k:'',       act:function(){ showPane('file'); } },
    { sec:'视图', ico:'i-terminal',label:'打开终端',            k:'',       act:function(){ showPane('term'); } },
    { sec:'设置', ico:'i-wand',    label:'打开外观设置',       k:'',        act:function(){ openSettings('appearance'); } },
    { sec:'设置', ico:'i-panel-r', label:'显示 / 收起右侧面板', k:'Ctrl B', act:function(){ togglePanel(); } }
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

  $('#taskGroups').addEventListener('contextmenu', function(e){
    var row = e.target.closest('.chat-row'); if (!row) return;
    e.preventDefault();
    openMenu(row, [
      { ico:'i-edit',  label:'重命名', k:'F2', act:function(){ toast('未接线：重命名'); } },
      { ico:'i-pin',   label:'置顶',        act:function(){ toast('未接线：置顶'); } },
      { ico:'i-copy',  label:'复制链接',    act:function(){ toast('未接线：复制链接'); } },
      { ico:'i-share', label:'分享',        act:function(){ toast('未接线：分享'); } },
      { ico:'i-trash', label:'删除', k:'Del', act:function(){ toast('未接线：删除任务'); } }
    ]);
  });

  document.addEventListener('click', function(e){
    if (!menu.contains(e.target) && !e.target.closest('#viewSel')) closeMenu();
  });

  /* ===================== 主题 ===================== */
  function toggleTheme(){
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
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
  var fontLevel = 0;
  function setFontSize(lv){
    lv = Math.max(-1, Math.min(1, lv));
    fontLevel = lv;
    var d = lv;                                   /* -1 小 / 0 默认 / 1 大 */
    document.documentElement.style.setProperty('--fs-base',    (13 + d) + 'px');
    document.documentElement.style.setProperty('--fs-body',    (14 + d) + 'px');
    document.documentElement.style.setProperty('--fs-caption', (12 + d) + 'px');
    toast(d === 0 ? '内容字号：默认' : (d > 0 ? '内容字号：大' : '内容字号：小'));
  }
  function stepTask(dir){
    var rows = $$('.chat-row');
    if (!rows.length) return;
    var i = -1;
    rows.forEach(function(r, k){ if (r.classList.contains('is-on')) i = k; });
    i = i < 0 ? 0 : (i + dir + rows.length) % rows.length;
    rows.forEach(function(r){ r.classList.remove('is-on'); });
    rows[i].classList.add('is-on');
    showChat($('.chat-name', rows[i]).textContent);
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
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n'){ e.preventDefault(); showHome(); $('#taHome').focus(); toast('新建快速问答'); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'e'){ e.preventDefault(); toast('已定位当前任务'); return; }
    if (mod && e.key.toLowerCase() === 'k'){ e.preventDefault(); openTaskSearch(); return; }                /* open-global-search */
    if (mod && e.key.toLowerCase() === 'b'){ e.preventDefault(); toggleSidebarCollapse(); return; }         /* toggle-sidebar */
    if (mod && e.key === ','){ e.preventDefault(); openSettings('settings'); return; }                      /* open-settings */
    if (mod && e.key.toLowerCase() === 'n'){ e.preventDefault(); showHome(); $('#taHome').focus(); return; }/* new-conversation */
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
      if (cta.style.display !== 'none') clearPick();
      else if (panel.classList.contains('is-hidden')) togglePanel(false);
    }
  });

  /* ===================== 窄屏抽屉 ===================== */
  var sidebar = $('#sidebar'), panelScrim = $('#panelScrim');

  function syncScrim(){
    var narrow = innerWidth <= 900;
    var panelOpen = !panel.classList.contains('is-hidden');
    panelScrim.classList.toggle('is-off', !(narrow && panelOpen));
  }
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
  panelScrim.addEventListener('click', function(){ togglePanel(true); });
  panel.addEventListener('click', function(e){ e.stopPropagation(); });
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
      $('#sbConnection').textContent = '桌面已就绪 · Agent 未接线';
      $('#sbIsolation').textContent = info.sandboxed && info.contextIsolated ? '渲染器已隔离 · 工具权限未接线' : '警告：渲染器隔离未启用';
      if (showVersion) toast('Personal Agent ' + info.appVersion + ' · Electron ' + info.electron + ' · Chromium ' + info.chrome + ' · Node ' + info.node + ' · ' + info.platform + ' · 界面基于用户提供的 WorkBuddy 原型');
    } catch (_) {
      $('#sbConnection').textContent = '桌面信息读取失败 · Agent 未接线';
      $('#sbIsolation').textContent = '隔离状态未知';
      if (showVersion) toast('桌面信息读取失败，请重试');
    }
  }
  void desktopInfo(false);

  /* ---- 顶部菜单定义 ---- */
  var MENUS = {
    edit: [
      { label:'撤销', k:'Ctrl+Z', act:function(){ toast('菜单未接线；输入框可使用 Ctrl+Z'); } },
      { label:'重做', k:'Ctrl+Y', act:function(){ toast('菜单未接线；输入框可使用 Ctrl+Y'); } },
      { sep:true },
      { label:'剪切', k:'Ctrl+X', act:function(){ toast('菜单未接线；输入框可使用 Ctrl+X'); } },
      { label:'复制', k:'Ctrl+C', act:function(){ toast('菜单未接线；选中文本可使用 Ctrl+C'); } },
      { label:'粘贴', k:'Ctrl+V', act:function(){ toast('菜单未接线；输入框可使用 Ctrl+V'); } },
      { sep:true },
      { label:'全选', k:'Ctrl+A', act:function(){ toast('菜单未接线；输入框可使用 Ctrl+A'); } },
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
      { label:'使用文档', act:function(){ toast('未接线：使用文档'); } },
      { label:'诊断工具', act:function(){ toast('未接线：诊断工具'); } },
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
    renderGroups();
    toast('筛选：' + FILTER_LABEL[k]);
  }
  $('#btnFilter').addEventListener('click', function(e){
    e.stopPropagation();
    var self = this;
    var opts = [
      { k:'all', ico:'i-grid'  },
      { k:'run', ico:'i-clock' },
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
    tsView = TASK_INDEX.filter(function(t){
      return !ql || t.t.toLowerCase().indexOf(ql) > -1
                  || t.group.toLowerCase().indexOf(ql) > -1
                  || t.path.toLowerCase().indexOf(ql) > -1;
    });
    tsIdx = 0;
    $('#tsCount').textContent = q ? (tsView.length + ' 条结果') : (TASK_INDEX.length + ' 个任务');
    if (!tsView.length){
      tsList.innerHTML = '<div class="ts-empty">没有匹配「' + esc(q) + '」的任务</div>';
      return;
    }
    var html = '', last = '';
    tsView.forEach(function(t, i){
      if (t.group !== last){
        html += '<div class="ts-grp">' + ico('i-folder') + '<span>' + esc(t.group) + '</span>' +
                '<span class="ts-path">' + esc(t.path) + '</span></div>';
        last = t.group;
      }
      html += '<button class="ts-row' + (i === 0 ? ' is-on' : '') + '" data-i="' + i + '">' +
                '<span class="dot' + (t.st ? ' dot--' + t.st : '') + '"></span>' +
                '<span class="nm">' + hl(t.t, q) + '</span>' +
                '<span class="tm">' + esc(t.time) + '</span>' +
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
    showChat(t.t);
    toast('打开任务：' + t.t);
  }
  function openTaskSearch(){
    searchScrim.classList.add('is-on');
    tsInput.value = '';
    renderTs('');
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
  renderGroups();

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
    if (h === 'pick'){ showPane('browser'); setTimeout(function(){ pickAt($('.wp-plan--hot')); }, 120); return; }
    if (['art','file','term','browser'].indexOf(h) > -1){ showPane(h); return; }
  }
  window.addEventListener('hashchange', route);
  route();

  if (!location.hash) toast('Personal Agent 桌面壳 · 示例数据，运行时未接线');
})();
