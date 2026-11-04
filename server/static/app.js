/* NearDrop 近传 - 前端 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 基础
  var isApp = !!(window.NearDrop && window.NearDrop.isApp && window.NearDrop.isApp() === '1');
  var API = '';
  try {
    if (window.NearDrop && window.NearDrop.getServer) {
      API = window.NearDrop.getServer() || '';
    }
  } catch (e) {}
  if (!API) API = window.__ND_SERVER__ || (location.protocol === 'file:' ? '' : location.origin);
  API = String(API).replace(/\/+$/, '');

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  var $ = function (id) { return document.getElementById(id); };

  // 身份分三层：
  //   1. 服务器身份 SID —— 这台电脑的固定编号，换 IP/换 Wi-Fi 都不变
  //   2. 设备身份 ME_ID —— 这台手机的固定编号，存原生 SharedPreferences，清缓存也还在
  //   3. 设备凭证 DTOK —— 输过一次访问码后由电脑发下来的长期凭据，按 SID 记
  // 老版本的 TOK_KEY 按 IP 记 token，换个网络就失效，这正是「改个名字又要输码」的根因。
  var SID_KEY = function (sid) { return 'nd_dtok:' + sid; };
  var TOK_KEY = 'nd_tok:' + API;          // 主机 token，仅作兼容
  var HOST_TOK = LS.get(TOK_KEY, '');
  var SID = LS.get('nd_sid:' + API, '');  // 拿 health 后再确认
  var DTOK = SID ? LS.get(SID_KEY(SID), '') : '';
  var ME_ID = '';

  function withTok(url) {
    var q = [];
    if (HOST_TOK) q.push('token=' + encodeURIComponent(HOST_TOK));
    if (ME_ID) q.push('device=' + encodeURIComponent(ME_ID));
    if (DTOK) q.push('dtok=' + encodeURIComponent(DTOK));
    if (!q.length) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
  }

  function fileUrl(fid, download) {
    return withTok(API + '/api/file/' + fid + (download ? '?download=1' : ''));
  }

  function thumbUrl(fid, v) {
    return withTok(API + '/api/thumb/' + fid + (v ? '?v=' + v : ''));
  }

  function dmId(a, b) {
    return 'dm:' + [a, b].sort().join('__');
  }

  var S = {
    me: null,
    convs: [],
    devices: [],
    online: [],
    conv: 'room',
    msgs: [],
    hasMore: false,
    loading: false,
    ws: null,
    wsOk: false,
    retry: 0,
    unread: {},
    lastRenderedId: 0
  };

  // ---------------------------------------------------------------- 工具
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function fmtDay(ts) {
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return fmtClock(ts);
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + fmtClock(ts);
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtClock(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + fmtClock(ts);
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'];
  function colorOf(str) {
    var h = 0;
    str = String(str || 'x');
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffff;
    return COLORS[h % COLORS.length];
  }
  function initial(name) {
    name = String(name || '?').trim();
    return name ? name.slice(0, 1).toUpperCase() : '?';
  }

  // act 可选：{ label: '打开', fn: function(){} }，给提示条挂一个操作按钮
  function toast(msg, ms, act) {
    var t = $('toast');
    t.innerHTML = '';
    var txt = document.createElement('span');
    txt.className = 'toast-txt';
    txt.textContent = msg;
    t.appendChild(txt);
    if (act && act.label) {
      var b = document.createElement('button');
      b.className = 'toast-act';
      b.textContent = act.label;
      b.addEventListener('click', function () {
        t.classList.remove('show');
        try { act.fn(); } catch (e) {}
      });
      t.appendChild(b);
      t.classList.add('has-act');
    } else {
      t.classList.remove('has-act');
    }
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, ms || 1800);
  }

  // ---------------------------------------------------------- 打开保存目录（仅 App）
  function canOpenFolder() {
    return !!(isApp && window.NearDrop && window.NearDrop.openFolder);
  }

  // which: last（刚存的）/ download（下载›近传）/ camera（相册›相机）
  function openFolder(which) {
    if (!canOpenFolder()) return false;
    try { window.NearDrop.openFolder(which || 'last'); } catch (e) { toast('打不开文件管理器'); }
    return true;
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      'Content-Type': 'application/json',
      'X-ND-Token': HOST_TOK,
      'X-ND-Device': ME_ID,
      'X-ND-Device-Token': DTOK
    }, opts.headers || {});
    return fetch(API + withTok(path), opts).then(function (r) {
      if (r.status === 401) {
        HOST_TOK = '';
        LS.set(TOK_KEY, '');
        if (SID) { DTOK = ''; LS.set(SID_KEY(SID), ''); }
        showAuth('这台电脑需要访问码');
        throw new Error('需要访问口令');
      }
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
      return r.json();
    });
  }

  function guessKind() {
    var ua = navigator.userAgent;
    if (isApp || /Android|iPhone|iPad|Mobile/i.test(ua)) return 'phone';
    if (/Macintosh/i.test(ua)) return 'mac';
    return 'pc';
  }

  function guessName() {
    var ua = navigator.userAgent;
    if (isApp) return '安卓手机';
    if (/Windows/i.test(ua)) return 'Windows 电脑';
    if (/Macintosh/i.test(ua)) return 'Mac 电脑';
    if (/Android/i.test(ua)) return '安卓手机';
    if (/iPhone/i.test(ua)) return 'iPhone';
    return '浏览器设备';
  }

  // ---------------------------------------------------------------- 设备身份
  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    } catch (e) {}
    var s = '';
    for (var i = 0; i < 12; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return s;
  }

  // 安卓端把设备编号存在 SharedPreferences 里，清缓存/重装 App 都还在
  function nativeDeviceId() {
    try { return (window.NearDrop && window.NearDrop.getDeviceId && window.NearDrop.getDeviceId()) || ''; } catch (e) { return ''; }
  }
  function nativeHwId() {
    try { return (window.NearDrop && window.NearDrop.getHwId && window.NearDrop.getHwId()) || ''; } catch (e) { return ''; }
  }
  function isCustomName() {
    return LS.get('nd_name_custom', '0') === '1';
  }

  function ensureLocalId() {
    ME_ID = nativeDeviceId() || LS.get('nd_device_id', '') || '';
    if (!ME_ID) ME_ID = 'd_' + uuid();
    LS.set('nd_device_id', ME_ID);
    return ME_ID;
  }

  function ensureMe() {
    var id = ME_ID || ensureLocalId();
    var name = LS.get('nd_device_name', '');
    if (!name) { name = guessName(); LS.set('nd_device_name', name); }
    return api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        device_id: id, name: name, kind: guessKind(),
        hw_id: nativeHwId(), custom: isCustomName() ? 1 : 0
      })
    }).then(function (dev) {
      ME_ID = dev.id;
      LS.set('nd_device_id', dev.id);
      // 只在用户没亲手改过名字时，才采纳服务端记着的名字
      if (!isCustomName() && dev.name) LS.set('nd_device_name', dev.name);
      S.me = dev;
      return dev;
    });
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    var qs = new URLSearchParams(location.search);
    var code = (qs.get('code') || '').trim();
    if (code) {
      tryAuth(code).then(function () {
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
        boot2();
      }).catch(function () {
        showAuth('扫码带的访问码不对，手动输入吧');
      });
      return;
    }
    // 本机（127.0.0.1）服务端免口令，先直接试；要口令的话第一个请求会 401 再弹窗
    boot2();
  }

  function boot2() {
    // 5 秒连不上就别死等：App 回扫描页，浏览器给重试
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      onConnFail();
    }, 5000);

    fetch(API + '/api/health', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('bad');
      return r.json();
    }).then(function (h) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 用服务器的固定编号找凭证：换 IP 也认得出「还是那台电脑」
      SID = h.server_id || SID || ('url:' + API);
      if (SID) LS.set('nd_sid:' + API, SID);
      DTOK = SID ? (LS.get(SID_KEY(SID), '') || '') : '';
      HOST_TOK = LS.get(TOK_KEY, '') || '';
      ensureLocalId();
      startApp();
    }).catch(function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onConnFail();
    });
  }

  function startApp() {
    ensureMe().then(function () {
      $('meName').textContent = S.me.name;
      $('meSub').textContent = isApp ? API.replace(/^https?:\/\//, '') : (location.host || '本机');
      $('meAvatar').textContent = initial(S.me.name);
      $('meAvatar').style.background = colorOf(S.me.id);
      loadConvs();
      connectWS();
      openConv(LS.get('nd_conv', 'room'));
      showListIfMobile();
      loadInfo();
      loadDevices(true);
    }).catch(function (e) {
      if (String(e && e.message).indexOf('访问口令') >= 0) return;
      onConnFail();
    });
  }

  function onConnFail() {
    if (isApp) {
      // 清掉记住的地址，免得下次启动又卡在同一个失效 IP 上
      try { window.NearDrop.clearServer && window.NearDrop.clearServer(); } catch (e) {}
      try { location.replace('connect.html?auto=1'); return; } catch (e) {}
    }
    $('meName').textContent = '连不上电脑端';
    $('meAvatar').textContent = '!';
    $('meAvatar').style.background = '#ef4444';
    $('connState').classList.add('off');
    $('connState').querySelector('span').textContent = '连不上电脑端';
    $('msgList').innerHTML = '<div class="empty-tip">连不上电脑端的「近传」<br>' +
      '确认电脑上程序还开着、手机和电脑在同一个 Wi-Fi<br><br>' +
      '<button class="retry-btn" onclick="location.reload()">重试</button></div>';
  }

  // ---------------------------------------------------------------- 访问码
  function tryAuth(code) {
    var id = ME_ID || ensureLocalId();
    var body = {
      code: code,
      device_id: id,
      name: LS.get('nd_device_name', '') || guessName(),
      kind: guessKind(),
      hw_id: nativeHwId(),
      custom: isCustomName() ? 1 : 0
    };
    return fetch(API + '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('bad code');
      return r.json();
    }).then(function (d) {
      HOST_TOK = d.token || '';
      LS.set(TOK_KEY, HOST_TOK);
      if (d.server_id) {
        SID = d.server_id;
        LS.set('nd_sid:' + API, SID);
      }
      if (!SID) SID = 'url:' + API;
      if (d.device_token) {
        DTOK = d.device_token;
        LS.set(SID_KEY(SID), DTOK);
      }
      if (d.device && d.device.id) {
        ME_ID = d.device.id;
        LS.set('nd_device_id', ME_ID);
        if (!isCustomName() && d.device.name) LS.set('nd_device_name', d.device.name);
        S.me = d.device;
      }
      hideAuth();
      return d;
    });
  }

  function showAuth(msg) {
    $('authErr').textContent = msg || '';
    $('authLayer').classList.add('show');
    $('authScan').style.display = isApp ? '' : 'none';
    setTimeout(function () { try { $('authCode').focus(); } catch (e) {} }, 150);
  }

  function hideAuth() {
    $('authLayer').classList.remove('show');
  }

  function submitAuth() {
    var code = ($('authCode').value || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) { $('authErr').textContent = '请输入 6 位数字访问码'; return; }
    $('authErr').textContent = '正在验证…';
    $('authGo').disabled = true;
    tryAuth(code).then(function () {
      $('authGo').disabled = false;
      $('authCode').value = '';
      $('authErr').textContent = '';
      boot2();
    }).catch(function () {
      $('authGo').disabled = false;
      $('authErr').textContent = '访问码不对，看一眼电脑上的显示';
    });
  }

  // ---------------------------------------------------------------- WebSocket
  function connectWS() {
    if (!S.me) return;
    var wsUrl = API.replace(/^http/, 'ws') + '/ws?device=' + encodeURIComponent(S.me.id) +
      '&token=' + encodeURIComponent(HOST_TOK) + '&dtok=' + encodeURIComponent(DTOK);
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }
    S.ws = ws;

    ws.onopen = function () {
      S.wsOk = true;
      S.retry = 0;
      $('connState').classList.remove('off');
      $('connState').querySelector('span').textContent = '已连接';
      clearInterval(S._hb);
      S._hb = setInterval(function () {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }));
      }, 20000);
      // 断线重连后补消息
      if (S.conv) catchUp(S.conv);
    };

    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      handleEvent(d);
    };

    ws.onclose = function (ev) {
      S.wsOk = false;
      $('connState').classList.add('off');
      $('connState').querySelector('span').textContent = '连接断开，重连中…';
      clearInterval(S._hb);
      // 4003 = 凭证被撕掉（电脑端踢出 / 换过口令），别再死循环重连
      if (ev && ev.code === 4003) {
        DTOK = '';
        if (SID) LS.set(SID_KEY(SID), '');
        $('connState').querySelector('span').textContent = '需要重新验证';
        showAuth('已被这台电脑移出，重新输入访问码就能继续用');
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = function () {};
  }

  function scheduleReconnect() {
    S.retry = Math.min(S.retry + 1, 6);
    var wait = Math.min(1000 * Math.pow(1.7, S.retry), 12000);
    setTimeout(connectWS, wait);
  }

  function handleEvent(d) {
    if (d.event === 'msg') {
      onIncoming(d.conv, d.message);
    } else if (d.event === 'presence') {
      S.online = d.online || [];
      renderConvs();
      if ($('devices').classList.contains('show')) loadDevices();
    } else if (d.event === 'device_update') {
      loadConvs();
      if ($('devices').classList.contains('show')) loadDevices();
    } else if (d.event === 'device_deleted') {
      S.devices = (S.devices || []).filter(function (x) { return x.id !== d.device_id; });
      renderDevices();
      loadConvs();
      if ($('devices').classList.contains('show')) loadDevices();
    } else if (d.event === 'msg_deleted') {
      if (d.conv === S.conv) removeMsg(d.id);
      loadConvs();
    } else if (d.event === 'conv_cleared') {
      if (d.conv === S.conv) { S.msgs = []; $('msgList').innerHTML = ''; }
      loadConvs();
    } else if (d.event === 'kicked') {
      DTOK = '';
      if (SID) LS.set(SID_KEY(SID), '');
      showAuth('已被这台电脑移出，重新输入访问码就能继续用');
    } else if (d.event === 'speed_invite') {
      // 对端发起互测：直接把面板打开并开始接收，省得再点一次
      openSpeed();
      spJoin(d.sid, 'recv', d.from_name || '对方设备');
      toast((d.from_name || '对方') + ' 正在和你测速', 3000);
    }
  }

  function onIncoming(conv, m) {
    if (!m) return;
    if (!S.convs.some(function (c) { return c.id === conv; })) { loadConvs(); }
    if (conv === S.conv) {
      if (!S.msgs.some(function (x) { return x.id === m.id; })) {
        var nearBottom = isNearBottom();
        S.msgs.push(m);
        appendMsgNode(m);
        markRead(conv, m.id);
        if (nearBottom || m.sender === (S.me && S.me.id)) scrollBottom();
      }
    } else {
      if (m.sender !== (S.me && S.me.id)) {
        S.unread[conv] = (S.unread[conv] || 0) + 1;
      }
      loadConvs();
    }
  }

  // ---------------------------------------------------------------- 会话
  function loadConvs() {
    if (!S.me) return Promise.resolve();
    return api('/api/conversations?device=' + encodeURIComponent(S.me.id)).then(function (d) {
      S.convs = d.conversations || [];
      S.devices = d.devices || [];
      S.online = d.online || [];
      renderConvs();
    });
  }

  var KIND_ICON = { pc: '🖥', phone: '📱', mac: '💻', web: '🌐' };

  function readPos(conv) { return Number(LS.get('nd_read_' + conv, 0)) || 0; }
  function markRead(conv, id) {
    if (id && id > readPos(conv)) LS.set('nd_read_' + conv, String(id));
  }

  function renderConvs() {
    var box = $('convList');
    var meId = S.me && S.me.id;
    var html = S.convs.map(function (c) {
      var last = (c.last && c.last.id) ? c.last : null;
      var preview = '';
      if (last) {
        var who = last.sender === (S.me && S.me.id) ? '我' : (last.sender_name || '');
        var body =
          last.type === 'text' ? last.text :
          last.type === 'image' ? '[图片]' :
          last.type === 'video' ? '[视频]' :
          last.type === 'audio' ? '[语音]' : '[文件] ' + (last.file_name || '');
        preview = (c.kind === 'room' && who ? who + '：' : '') + String(body || '').slice(0, 40);
      } else {
        preview = c.subtitle || '';
      }
      var unread = S.unread[c.id] || 0;
      if (!unread && last && last.sender !== meId && last.id > readPos(c.id) && c.id !== S.conv) unread = 1;
      var online = c.kind === 'dm' ? (S.online.indexOf(c.peer) >= 0) : (S.online.length > 0);
      var isRoom = c.kind === 'room';
      var bg = isRoom ? 'linear-gradient(135deg,#2563eb,#7c3aed)' : colorOf(c.peer || c.id);
      var ch = isRoom ? '公' : initial(c.title);
      return '<div class="conv-item' + (c.id === S.conv ? ' active' : '') + '" data-conv="' + esc(c.id) + '">' +
        '<div class="conv-avatar" style="background:' + bg + '">' + esc(ch) +
        (online ? '<span class="dot"></span>' : '') + '</div>' +
        '<div class="conv-main">' +
        '<div class="conv-title"><span>' + esc(c.title) + '</span><span>' +
        (last ? fmtDay(last.created) : '') + '</span></div>' +
        '<div class="conv-preview">' + esc(preview) + '</div>' +
        '</div>' +
        (unread ? '<div class="conv-badge">' + (unread > 99 ? '99+' : unread) + '</div>' : '') +
        '</div>';
    }).join('');
    box.innerHTML = html || '<div class="empty-tip">暂无会话</div>';
  }

  function openConv(conv) {
    S.conv = conv;
    LS.set('nd_conv', conv);
    S.unread[conv] = 0;
    var c = S.convs.filter(function (x) { return x.id === conv; })[0];
    // 从设备列表点进来时，这个私聊可能还没在会话列表里
    if (!c && conv.indexOf('dm:') === 0 && S.me) {
      var parts = conv.slice(3).split('__');
      var peer = parts[0] === S.me.id ? parts[1] : parts[0];
      var d = (S.devices || []).filter(function (x) { return x.id === peer; })[0];
      c = { id: conv, title: d ? d.name : '私聊', peer: peer, kind: 'dm' };
    }
    $('chatTitle').textContent = c ? c.title : (conv === 'room' ? '公共频道' : '会话');
    if (conv === 'room') {
      $('chatSub').textContent = '所有设备都能看到';
    } else if (c) {
      var on = S.online.indexOf(c.peer) >= 0;
      $('chatSub').textContent = on ? '在线' : '私聊 · 离线也能收到';
    }
    document.body.classList.add('chat-open');
    renderConvs();
    loadMessages(conv, true);
  }

  function showListIfMobile() {
    if (window.innerWidth <= 760) document.body.classList.remove('chat-open');
  }

  function loadMessages(conv, reset) {
    S.loading = true;
    var url = '/api/messages?conv=' + encodeURIComponent(conv) + '&device=' + encodeURIComponent(S.me.id) + '&limit=40';
    if (!reset && S.msgs.length) url += '&before=' + S.msgs[0].id;
    return api(url).then(function (d) {
      var list = d.messages || [];
      S.hasMore = !!d.has_more && list.length > 0;
      if (reset) {
        S.msgs = list;
        renderAll();
      } else {
        S.msgs = list.concat(S.msgs);
        renderAll(true);
      }
      if (S.msgs.length) markRead(conv, S.msgs[S.msgs.length - 1].id);
      S.loading = false;
    }).catch(function (e) {
      S.loading = false;
      toast('加载消息失败');
    });
  }

  function catchUp(conv) {
    if (!S.msgs.length) { loadMessages(conv, true); return; }
    var lastId = S.msgs[S.msgs.length - 1].id;
    api('/api/messages?conv=' + encodeURIComponent(conv) + '&device=' + encodeURIComponent(S.me.id) + '&after=' + lastId)
      .then(function (d) {
        (d.messages || []).forEach(function (m) {
          if (!S.msgs.some(function (x) { return x.id === m.id; })) {
            S.msgs.push(m);
            appendMsgNode(m);
          }
        });
        scrollBottom();
      }).catch(function () {});
  }

  // ---------------------------------------------------------------- 渲染消息
  var AudioCtx = null;

  function renderAll(keepScroll) {
    var box = $('msgList');
    var prevH = box.scrollHeight, prevTop = box.scrollTop;
    box.innerHTML = '';
    if (S.hasMore) {
      var lm = document.createElement('div');
      lm.className = 'load-more';
      lm.textContent = '查看更早的消息';
      lm.onclick = function () { if (!S.loading) loadMessages(S.conv, false); };
      box.appendChild(lm);
    }
    var lastTs = 0;
    S.msgs.forEach(function (m) {
      if (m.created - lastTs > 5 * 60 * 1000) {
        var sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.textContent = fmtDay(m.created);
        box.appendChild(sep);
        lastTs = m.created;
      }
      box.appendChild(buildMsgNode(m));
    });
    if (!S.msgs.length) {
      var et = document.createElement('div');
      et.className = 'empty-tip';
      et.innerHTML = S.conv === 'room'
        ? '这里是公共频道<br>发点东西试试，所有设备都能收到'
        : '还没有消息<br>发过去的东西会一直在电脑上，手机上线就能看到';
      box.appendChild(et);
    }
    if (keepScroll) {
      box.scrollTop = box.scrollHeight - prevH + prevTop;
    } else {
      scrollBottom(true);
    }
  }

  function appendMsgNode(m) {
    var box = $('msgList');
    var prev = S.msgs[S.msgs.length - 2];
    if (prev && m.created - prev.created > 5 * 60 * 1000) {
      var sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = fmtDay(m.created);
      box.appendChild(sep);
    } else if (!prev) {
      var sep2 = document.createElement('div');
      sep2.className = 'day-sep';
      sep2.textContent = fmtDay(m.created);
      box.appendChild(sep2);
    }
    box.appendChild(buildMsgNode(m));
  }

  function buildMsgNode(m) {
    var mine = S.me && m.sender === S.me.id;
    var row = document.createElement('div');
    row.className = 'row' + (mine ? ' out' : '');
    row.dataset.id = m.id;

    var av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = colorOf(m.sender);
    av.textContent = initial(m.sender_name || '?');
    av.title = m.sender_name || '';

    var col = document.createElement('div');
    col.className = 'bubble-col';

    if (!mine && S.conv === 'room') {
      var sn = document.createElement('div');
      sn.className = 'sender';
      sn.textContent = m.sender_name || '设备';
      col.appendChild(sn);
    }

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.type === 'text') {
      bubble.textContent = m.text || '';
      bindLongPress(bubble, m);
    } else if (m.type === 'image') {
      bubble.classList.add('media');
      var img = document.createElement('img');
      img.src = thumbUrl(m.file_id, m.id);
      img.loading = 'lazy';
      img.alt = m.file_name || '图片';
      img.onclick = function () { openViewer(m); };
      img.onerror = function () { img.src = fileUrl(m.file_id); };
      bubble.appendChild(img);
    } else if (m.type === 'video') {
      bubble.classList.add('media');
      bubble.appendChild(buildVideoCard(m));
    } else if (m.type === 'audio') {
      bubble.appendChild(buildVoice(m));
    } else {
      bubble.appendChild(buildFile(m));
    }

    col.appendChild(bubble);

    // 底部信息
    var meta = document.createElement('div');
    meta.className = 'meta-line';
    meta.innerHTML = '<span>' + fmtClock(m.created) + '</span>' +
      (m.type !== 'text' ? '<span>' + fmtSize(m.file_size) + '</span>' : '') +
      (m.type !== 'text' ? '<button class="save-btn">保存</button>' : '') +
      (mine ? '<button class="del-btn">删除</button>' : '');
    col.appendChild(meta);

    if (m.type !== 'text') {
      meta.querySelector('.save-btn').onclick = function () { saveMsg(m); };
    }
    if (mine) {
      meta.querySelector('.del-btn').onclick = function () {
        if (!confirm('删除这条消息？（服务器上的文件也会删掉）')) return;
        api('/api/message/' + m.id, { method: 'DELETE' }).then(function () { removeMsg(m.id); });
      };
    }

    row.appendChild(av);
    row.appendChild(col);
    return row;
  }

  function buildVoice(m) {
    var wrap = document.createElement('div');
    wrap.className = 'voice';
    var bars = '';
    for (var i = 0; i < 5; i++) {
      bars += '<i style="height:' + (6 + Math.random() * 12).toFixed(0) + 'px"></i>';
    }
    wrap.innerHTML = '<span class="wave">' + bars + '</span><span class="dur">' + fmtDur(m.duration || 0) + '</span>';
    var audio = new Audio(fileUrl(m.file_id));
    var playing = false;
    audio.onended = function () { playing = false; wrap.classList.remove('playing'); };
    wrap.onclick = function () {
      if (playing) { audio.pause(); playing = false; wrap.classList.remove('playing'); return; }
      audio.currentTime = 0;
      audio.play().then(function () { playing = true; wrap.classList.add('playing'); })
        .catch(function () { toast('播放失败'); });
    };
    return wrap;
  }

  function buildFile(m) {
    var name = m.file_name || '文件';
    var ext = (name.split('.').pop() || '').slice(0, 4);
    var wrap = document.createElement('div');
    wrap.className = 'file-card';
    wrap.innerHTML = '<div class="file-ico">' + esc(ext) + '</div>' +
      '<div><div class="file-name">' + esc(name) + '</div>' +
      '<div class="file-size">' + fmtSize(m.file_size) + '</div></div>';
    wrap.onclick = function () { saveMsg(m); };
    return wrap;
  }

  // ---------------------------------------------------------------- 视频卡片 / 播放器
  // 聊天里只放一张封面 + 播放按钮，点开才是全屏播放器（参考微信的做法）。
  var posterCache = {};    // file_id -> {url, dur}
  var posterQueue = [];
  var posterBusy = false;

  function buildVideoCard(m) {
    var card = document.createElement('div');
    card.className = 'vcard';
    card.innerHTML = '<div class="vplay">▶</div>' +
      '<span class="vsize">' + fmtSize(m.file_size) + '</span>' +
      '<span class="vdur" style="display:none"></span>';
    var durEl = card.querySelector('.vdur');
    card.onclick = function () { openPlayer(m); };

    var cached = posterCache[m.file_id];
    if (cached) applyPoster(card, durEl, cached);
    else enqueuePoster(m, function (info) { applyPoster(card, durEl, info); });
    return card;
  }

  function applyPoster(card, durEl, info) {
    if (!card.isConnected) return;
    if (info.url) {
      card.style.backgroundImage = 'url(' + info.url + ')';
      card.classList.add('has-poster');
    }
    if (info.dur > 0) {
      durEl.textContent = fmtDur(info.dur);
      durEl.style.display = '';
    }
  }

  // 逐个取帧，避免一屏视频同时发请求把 Wi-Fi 挤满
  function enqueuePoster(m, cb) {
    posterQueue.push({ m: m, cb: cb });
    pumpPoster();
  }

  function pumpPoster() {
    if (posterBusy || !posterQueue.length) return;
    posterBusy = true;
    var job = posterQueue.shift();
    grabPoster(job.m, function (info) {
      posterBusy = false;
      posterCache[job.m.file_id] = info;
      job.cb(info);
      pumpPoster();
    });
  }

  function grabPoster(m, done) {
    var v = document.createElement('video');
    var finished = false;
    var timer = setTimeout(function () { finish({ url: '', dur: 0 }); }, 6000);

    function finish(info) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
      done(info || { url: '', dur: 0 });
    }

    try {
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      // App 里页面来自 appassets.local，文件来自 http://ip:port，属于跨域。
      // 不带这句 canvas 会被污染，toDataURL 直接抛 SecurityError。
      v.crossOrigin = 'anonymous';
      v.addEventListener('loadedmetadata', function () {
        var dur = isFinite(v.duration) ? v.duration : 0;
        v._dur = dur;
        try { v.currentTime = dur > 2 ? Math.min(1, dur * 0.1) : 0; }
        catch (e) { finish({ url: '', dur: dur }); }
      });
      v.addEventListener('seeked', function () {
        var dur = v._dur || 0;
        try {
          var w = 320;
          var h = Math.round(w * (v.videoHeight / Math.max(1, v.videoWidth))) || 180;
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          finish({ url: c.toDataURL('image/jpeg', 0.72), dur: dur });
        } catch (e) { finish({ url: '', dur: dur }); }
      });
      v.addEventListener('error', function () { finish({ url: '', dur: 0 }); });
      v.src = fileUrl(m.file_id);
      v.load();
    } catch (e) { finish({ url: '', dur: 0 }); }
  }

  var playerCur = null;
  var plLandscape = false;
  var plHideTimer = null;

  function openPlayer(m) {
    playerCur = m;
    var v = $('playerVideo');
    $('plTitle').textContent = m.file_name || '视频';
    $('plBig').classList.remove('hidden');
    $('plPlay').textContent = '❚❚';
    $('plSeek').value = '0';
    $('plTime').textContent = '00:00';
    $('plTotal').textContent = '00:00';
    v.src = fileUrl(m.file_id);
    $('player').classList.add('show');
    try { v.play().catch(function () {}); } catch (e) {}
    showPlayerUi();
  }

  function closePlayer() {
    var v = $('playerVideo');
    $('player').classList.remove('show');
    $('player').classList.remove('hide-ui');
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('src'); v.load(); } catch (e) {}
    plLandscape = false;
    try {
      if (window.NearDrop && window.NearDrop.setOrientation) window.NearDrop.setOrientation('auto');
    } catch (e) {}
    playerCur = null;
    clearTimeout(plHideTimer);
  }

  function togglePlay() {
    var v = $('playerVideo');
    if (v.paused) { try { v.play().catch(function () {}); } catch (e) {} }
    else v.pause();
    showPlayerUi();
  }

  function showPlayerUi() {
    $('player').classList.remove('hide-ui');
    clearTimeout(plHideTimer);
    plHideTimer = setTimeout(function () {
      var v = $('playerVideo');
      if (v && !v.paused) $('player').classList.add('hide-ui');
    }, 3200);
  }

  function toggleRotate() {
    if (!(window.NearDrop && window.NearDrop.setOrientation)) { toast('这里不支持旋转'); return; }
    plLandscape = !plLandscape;
    try { window.NearDrop.setOrientation(plLandscape ? 'landscape' : 'portrait'); } catch (e) {}
    showPlayerUi();
  }

  // ---------------------------------------------------------------- 长按文字消息
  var menuMsg = null;

  function bindLongPress(bubble, m) {
    var timer = null, sx = 0, sy = 0;

    function cancel() { clearTimeout(timer); }
    function fire() {
      cancel();
      selectBubbleText(bubble);
      openMsgMenu(m, bubble);
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
    }

    bubble.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      cancel();
      timer = setTimeout(fire, 420);
    }, { passive: true });
    bubble.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
    }, { passive: true });
    bubble.addEventListener('touchend', cancel);
    bubble.addEventListener('touchcancel', cancel);

    // 电脑上右键、或按住不动，效果一样
    bubble.addEventListener('contextmenu', function (e) { e.preventDefault(); fire(); });
    bubble.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      sx = e.clientX; sy = e.clientY;
      cancel();
      timer = setTimeout(fire, 500);
    });
    bubble.addEventListener('mouseup', cancel);
    bubble.addEventListener('mouseleave', cancel);
  }

  function selectBubbleText(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function openMsgMenu(m, anchor) {
    menuMsg = m;
    var menu = $('msgMenu');
    menu.classList.add('show');
    var r = anchor.getBoundingClientRect();
    var mw = menu.offsetWidth || 160;
    var mh = menu.offsetHeight || 42;
    var cx = r.left + r.width / 2;
    cx = Math.max(mw / 2 + 8, Math.min(window.innerWidth - mw / 2 - 8, cx));
    var top = r.top - mh - 12;
    var below = top < 8;
    if (below) top = r.bottom + 12;
    menu.classList.toggle('below', below);
    menu.style.left = cx + 'px';
    menu.style.top = top + 'px';
  }

  function closeMsgMenu() {
    $('msgMenu').classList.remove('show');
    menuMsg = null;
    try { window.getSelection().removeAllRanges(); } catch (e) {}
  }

  function copyText(txt) {
    if (window.NearDrop && window.NearDrop.copyText) {
      try { window.NearDrop.copyText(txt); toast('已复制'); return; } catch (e) {}
    }
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) { ok = false; }
    if (ok) { toast('已复制'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt)
        .then(function () { toast('已复制'); })
        .catch(function () { toast('复制失败'); });
    } else {
      toast('复制失败');
    }
  }

  function removeMsg(id) {
    S.msgs = S.msgs.filter(function (x) { return x.id !== id; });
    var node = $('msgList').querySelector('.row[data-id="' + id + '"]');
    if (node) node.remove();
  }

  function isNearBottom() {
    var box = $('msgList');
    return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  }
  function scrollBottom(force) {
    var box = $('msgList');
    if (force || isNearBottom()) {
      requestAnimationFrame(function () { box.scrollTop = box.scrollHeight; });
    }
  }

  // ---------------------------------------------------------------- 发送
  function sendText() {
    var ta = $('textInput');
    var txt = ta.value.trim();
    if (!txt || !S.me) return;
    ta.value = '';
    autoGrow();
    $('btnSend').disabled = true;
    api('/api/send', {
      method: 'POST',
      body: JSON.stringify({ conv: S.conv, device: S.me.id, text: txt })
    }).catch(function (e) {
      toast('发送失败：' + e.message);
    });
  }

  function uploadOne(file, duration) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      fd.append('file', file, file.name || 'file');
      fd.append('conv', S.conv);
      fd.append('device', S.me.id);
      if (duration) fd.append('duration', String(duration));
      var xhr = new XMLHttpRequest();
      // 传文件是裸 XHR，不经过 api()，凭证得自己带：
      // URL 上带一份（和 /api/file 下载一致），请求头再带一份，兼容不同 WebView
      xhr.open('POST', API + withTok('/api/upload'));
      try {
        xhr.setRequestHeader('X-ND-Token', HOST_TOK || '');
        xhr.setRequestHeader('X-ND-Device', S.me.id || ME_ID || '');
        xhr.setRequestHeader('X-ND-Device-Token', DTOK || '');
      } catch (e) { /* 个别内核不允许设头，URL 上的凭证仍然有效 */ }
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          var p = Math.round(e.loaded / e.total * 100);
          showUpload(file.name, p);
        }
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve({}); }
          return;
        }
        var detail = '';
        try {
          var j = JSON.parse(xhr.responseText);
          detail = (j && j.detail) || '';
        } catch (e) { detail = String(xhr.responseText || '').slice(0, 80); }
        if (xhr.status === 401) {
          // 凭证失效（被移出 / 换了电脑）：弹访问码，别让用户对着 HTTP 401 发呆
          if (SID) { DTOK = ''; LS.set(SID_KEY(SID), ''); }
          showAuth('这台电脑需要访问码');
          reject(new Error('需要重新输入访问码'));
          return;
        }
        if (xhr.status === 413) { reject(new Error('文件太大，被服务端拒绝了')); return; }
        if (xhr.status === 403) { reject(new Error(detail || '没有权限发到该会话')); return; }
        reject(new Error(detail ? (detail + '（HTTP ' + xhr.status + '）') : ('HTTP ' + xhr.status)));
      };
      xhr.onerror = function () { reject(new Error('网络错误')); };
      xhr.send(fd);
    });
  }

  function sendFiles(files, duration) {
    if (!files || !files.length || !S.me) return;
    var arr = Array.prototype.slice.call(files);
    var i = 0;
    function next() {
      if (i >= arr.length) { hideUpload(); return; }
      var f = arr[i++];
      showUpload(f.name, 0);
      uploadOne(f, duration).then(next).catch(function (e) {
        hideUpload();
        toast('发送失败：' + (f.name || '') + ' ' + e.message);
      });
    }
    next();
  }

  function showUpload(name, pct) {
    var box = $('uploadBox');
    box.classList.add('show');
    $('uploadLabel').textContent = '正在发送 ' + String(name).slice(0, 22) + (pct ? ' · ' + pct + '%' : '');
    $('uploadBar').style.width = pct + '%';
  }
  function hideUpload() {
    $('uploadBox').classList.remove('show');
    $('uploadBar').style.width = '0%';
  }

  // ---------------------------------------------------------------- 保存
  var saving = false;   // 保存任务进行中，避免重复点重复下载
  function saveMsg(m) {
    saveToLocal(fileUrl(m.file_id, true), m.file_name || ('neardrop_' + m.file_id), m.mime || '');
  }

  function saveToLocal(url, name, mime) {
    if (isApp && window.NearDrop && window.NearDrop.saveUrl) {
      if (saving) { toast('上一个还在保存中'); return; }
      pauseViewerVideo();   // 边播边存会抢同一个 Wi-Fi，先把播放器停下
      try {
        var r = window.NearDrop.saveUrl(url, name);
        // saveUrl 是异步的，返回 ok 只代表任务已开始，不能当成保存成功
        if (r === 'busy') { toast('上一个还在保存中'); return; }
        saving = true;
        toast('正在保存…', 60000);
      } catch (e) { toast('保存失败'); }
      return;
    }
    var a = document.createElement('a');
    a.href = url;
    a.download = name || 'file';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 300);
    toast('已开始下载');
  }

  // 预览/播放器里正在播的视频，保存时先暂停，避免和下载抢带宽
  function pauseViewerVideo() {
    try {
      var vs = document.querySelectorAll('#player video, #viewerBody video');
      for (var i = 0; i < vs.length; i++) {
        if (!vs[i].paused) vs[i].pause();
      }
    } catch (e) {}
  }

  // 原生回传保存进度：start / progress / done / error
  window.__ndSave = function (state, msg) {
    if (state === 'start') { saving = true; toast('正在保存…', 60000); return; }
    if (state === 'progress') { toast('正在保存 ' + msg, 60000); return; }
    saving = false;
    if (state === 'done') {
      var which = /相册/.test(msg || '') ? 'camera' : 'download';
      toast(msg || '已保存', 6000, canOpenFolder() ? {
        label: '打开',
        fn: function () { openFolder(which); }
      } : null);
      return;
    }
    toast(msg || '保存失败', 3000);
  };
  if (isApp && window.NearDrop && window.NearDrop.jsReady) {
    try { window.NearDrop.jsReady(); } catch (e) {}
  }

  // 安卓返回键：依次关掉播放器、长按菜单、图片预览，都关完了才让原生处理
  window.__ndBack = function () {
    if ($('player').classList.contains('show')) { closePlayer(); return '1'; }
    if ($('msgMenu').classList.contains('show')) { closeMsgMenu(); return '1'; }
    if ($('viewer').classList.contains('show')) { closeViewer(); return '1'; }
    return '0';
  };

  // ---------------------------------------------------------------- 预览
  var viewerCur = null;
  function openViewer(m) {
    viewerCur = m;
    var body = $('viewerBody');
    body.innerHTML = '';
    if (m.type === 'image') {
      var img = document.createElement('img');
      img.src = fileUrl(m.file_id);
      body.appendChild(img);
    } else if (m.type === 'video') {
      var v = document.createElement('video');
      v.src = fileUrl(m.file_id);
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      body.appendChild(v);
    }
    $('viewer').classList.add('show');
  }
  function closeViewer() {
    $('viewer').classList.remove('show');
    $('viewerBody').innerHTML = '';
  }

  // ---------------------------------------------------------------- 录音
  var rec = { media: null, chunks: [], stream: null, t0: 0, timer: null, native: false, done: false };

  function startRecord() {
    if (isApp && window.NearDrop && window.NearDrop.recordStart) {
      try {
        window.NearDrop.recordStart();
        rec.native = true;
        rec.done = false;
        showRecLayer();
        return;
      } catch (e) { /* 走 web */ }
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('此浏览器不支持录音，请用 App，或在电脑本机录音');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      rec.stream = stream;
      rec.chunks = [];
      var mime = '';
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mime = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) {
        mime = 'audio/mp4';
      }
      rec.media = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.media.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.media.onstop = function () {
        var type = rec.media.mimeType || 'audio/webm';
        var blob = new Blob(rec.chunks, { type: type });
        var dur = (Date.now() - rec.t0) / 1000;
        cleanupStream();
        if (rec.cancelFlag) { rec.cancelFlag = false; return; }
        if (blob.size < 1200) { toast('录音太短'); return; }
        var ext = type.indexOf('mp4') >= 0 ? 'm4a' : 'webm';
        var f = new File([blob], 'voice_' + Date.now() + '.' + ext, { type: type });
        sendFiles([f], dur);
      };
      rec.media.start();
      rec.t0 = Date.now();
      showRecLayer();
    }).catch(function (e) {
      toast('无法使用麦克风：' + e.message);
    });
  }

  function stopRecord(cancel) {
    hideRecLayer();
    if (rec.native) {
      rec.cancelFlag = !!cancel;
      try {
        window.NearDrop.recordStop(cancel ? '1' : '0', S.conv, (S.me && S.me.id) || '');
      } catch (e) {}
      rec.native = false;
      return;
    }
    if (rec.media && rec.media.state !== 'inactive') {
      rec.cancelFlag = !!cancel;
      rec.media.stop();
    }
  }

  function cleanupStream() {
    if (rec.stream) {
      rec.stream.getTracks().forEach(function (t) { t.stop(); });
      rec.stream = null;
    }
  }

  function showRecLayer() {
    $('recLayer').classList.add('show');
    rec.t0 = rec.t0 || Date.now();
    $('recTime').textContent = '0:00';
    clearInterval(rec.timer);
    rec.timer = setInterval(function () {
      var s = Math.floor((Date.now() - rec.t0) / 1000);
      $('recTime').textContent = fmtDur(s);
      if (s >= 300) stopRecord(false);
    }, 250);
  }
  function hideRecLayer() {
    $('recLayer').classList.remove('show');
    clearInterval(rec.timer);
  }

  // App 原生录音回调
  window.__ndAudio = function (base64, duration, mime) {
    hideRecLayer();
    if (!base64) { toast('录音失败'); return; }
    try {
      var bin = atob(base64);
      var len = bin.length;
      var buf = new Uint8Array(len);
      for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
      var type = mime || 'audio/mp4';
      var ext = type.indexOf('mp4') >= 0 || type.indexOf('aac') >= 0 ? 'm4a' : 'webm';
      var f = new File([buf], 'voice_' + Date.now() + '.' + ext, { type: type });
      sendFiles([f], duration || 0);
    } catch (e) {
      toast('录音处理失败');
    }
  };

  // ---------------------------------------------------------------- 设备与地址
  function loadInfo() {
    return api('/api/info').then(function (d) {
      S.accessCode = d.access_code || '';
      S.serverName = d.server_name || '';
      S.serverIps = d.ips || [];
      S.serverPort = d.port;
      $('setCode').textContent = S.accessCode || '------';
      if (!$('footInfo').textContent) {
        $('footInfo').textContent = (S.serverIps[0] || '') + ':' + d.port;
      }
    }).catch(function () {});
  }

  function loadDevices(silent) {
    return api('/api/devices?device=' + encodeURIComponent(S.me ? S.me.id : '')).then(function (d) {
      S.devices = d.devices || [];
      S.server = d.server || {};
      S.canManage = !!d.can_manage;
      if (d.access_code) {
        S.accessCode = d.access_code;
        $('setCode').textContent = d.access_code;
      }
      if (d.me_ip) {
        S.meIp = d.me_ip;
        if (silent && S.me) $('meSub').textContent = '我的 IP ' + d.me_ip;
      }
      $('devMeIp').textContent = d.me_ip || '—';
      if ($('devices').classList.contains('show')) renderDevices();
    }).catch(function () {});
  }

  function openDevices() {
    $('devices').classList.add('show');
    loadDevices();
  }

  var KIND_EMOJI = { pc: '💻', phone: '📱', mac: '💻', web: '🌐' };

  function renderDevices() {
    var s = S.server || {};
    var rows = (S.devices || []).map(function (d) {
      // 标签合并成一个，窄屏放得下：在线·可信 / 离线·可信 / 已移出
      var stText = d.revoked ? '已移出' : (d.online ? '在线' : '离线');
      if (!d.revoked && !d.is_self && d.trusted) stText += '·可信';
      var stCls = (d.online && !d.revoked) ? 'on' : 'off';
      var tags = (d.is_self ? '<i class="tag me">我</i>' : '') +
        '<i class="tag ' + stCls + '"' + (d.trusted ? ' title="输过访问码，换网络也能免密连"' : '') + '>' +
        stText + '</i>';
      var kick = (!d.is_self && S.canManage && d.trusted && d.online)
        ? '<button class="dev-kick" data-kick="' + esc(d.id) + '" data-name="' + esc(d.name) + '">移出</button>'
        : '';
      // 离线设备给「删除」：彻底清掉记录和凭证，列表不再挂着僵尸设备
      var del = (!d.is_self && !d.online)
        ? '<button class="dev-del" data-del="' + esc(d.id) + '" data-name="' + esc(d.name) + '">删除</button>'
        : '';
      return '<div class="dev-row' + (d.is_self ? ' self' : '') + '" data-peer="' + esc(d.id) + '">' +
        '<div class="dev-ico" style="background:' + colorOf(d.id) + '">' + esc(initial(d.name)) + '</div>' +
        '<div class="dev-main"><div class="dev-name"><span class="nm">' + esc(d.name) + '</span></div>' +
        '<div class="dev-ip">' + (d.ip ? esc(d.ip) : '地址未知') +
        (d.is_self ? ' · 这台设备' : '') + tags + '</div></div>' +
        (d.is_self ? '' : del + kick) +
        '</div>';
    }).join('');

    $('devList').innerHTML = rows || '<div class="empty-tip">还没有其他设备连上来</div>';
    $('devServer').innerHTML =
      '<div class="dev-row server-row">' +
      '<div class="dev-ico" style="background:linear-gradient(135deg,#2563eb,#7c3aed)">转</div>' +
      '<div class="dev-main"><div class="dev-name">' + esc(s.name || '这台电脑') +
      '<i class="tag on">中转站</i></div>' +
      '<div class="dev-ip">' + esc((s.ip || '') + (s.port ? ':' + s.port : '')) + '</div></div>' +
      '</div>' +
      '<div class="dev-note">访问码 <b>' + esc(S.accessCode || '------') + '</b>，新设备连接时输入这个；' +
      '点设备行可私聊，离线的设备可以删除</div>';

    Array.prototype.forEach.call(document.querySelectorAll('#devList .dev-row'), function (el) {
      el.onclick = function () {
        var peer = el.getAttribute('data-peer');
        $('devices').classList.remove('show');
        if (peer && S.me && peer !== S.me.id) {
          openConv(dmId(S.me.id, peer));
        }
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#devList .dev-kick'), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-kick');
        var nm = btn.getAttribute('data-name') || '这台设备';
        if (!confirm('把「' + nm + '」移出？\n它需要重新输入访问码才能连回来。')) return;
        api('/api/device/revoke', {
          method: 'POST',
          body: JSON.stringify({ device_id: id, self: S.me ? S.me.id : '' })
        }).then(function () {
          toast('已移出 ' + nm);
          loadDevices();
        }).catch(function (err) {
          toast('移出失败：' + String(err && err.message || '').replace(/^.*detail.*$/, '只有电脑端能操作'));
        });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#devList .dev-del'), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-del');
        var nm = btn.getAttribute('data-name') || '这台设备';
        if (!confirm('删除「' + nm + '」？\n\n它的记录和登录凭证都会被清掉，列表里不再显示。\n聊天记录会保留，只是发送者显示为「已移除设备」。\n下次它再连过来要重新输访问码。')) return;
        btn.disabled = true;
        api('/api/device/delete', {
          method: 'POST',
          body: JSON.stringify({ device_id: id, self: S.me ? S.me.id : '' })
        }).then(function (r) {
          toast('已删除 ' + (r && r.name || nm));
          loadDevices();
        }).catch(function (err) {
          btn.disabled = false;
          var msg = String(err && err.message || '');
          toast('删除失败：' + (msg.indexOf('403') >= 0 ? '只有电脑端能删在线设备' : msg));
        });
      };
    });
  }

  // ---------------------------------------------------------------- 设置 / 弹层
  // ---------------------------------------------------------------- 测速
  // 三种口径都在这里：单端（到电脑的上下行）、两端互测（A 发 B 收，走服务器转发）
  var SP = {
    ws: null, sid: '', role: '', name: '', t0: 0,
    sent: 0, recv: 0, remote: 0, tick: null, busy: false, blob: null
  };

  function spRate(bytes, ms) {
    if (!bytes || !ms) return '–';
    var bps = bytes * 1000 / ms;
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
    return bps.toFixed(0) + ' B/s';
  }

  function spSet(id, txt, cls) {
    var el = $(id);
    if (!el) return;
    el.textContent = txt;
    var cell = el.parentNode;
    if (cell && cell.classList) {
      cell.classList.remove('good');
      cell.classList.remove('bad');
      if (cls) cell.classList.add(cls);
    }
  }

  function spTip(t) {
    var el = $('spTip');
    if (el) el.textContent = t;
  }

  function spPingOnce() {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    return fetch(API + withTok('/api/speed/ping'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function () {
        var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        return t1 - t0;
      });
  }

  function spPing(n) {
    var ps = [], chain = Promise.resolve();
    for (var i = 0; i < n; i++) {
      chain = chain.then(function () {
        return spPingOnce().then(function (v) { ps.push(v); });
      });
    }
    return chain.then(function () {
      ps.sort(function (a, b) { return a - b; });
      return Math.round(ps[Math.floor(ps.length / 2)]);
    });
  }

  // 下载：限时读流，算「这段时间内实际到手多少字节」。慢链路也能测出来，不会等一个 64MB 下完
  function spDown(msTarget) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t0 = performance.now(), bytes = 0, stopped = false;
    var url = API + withTok('/api/speed/down?bytes=' + (64 * 1024 * 1024));
    var timer = setTimeout(function () { stopped = true; if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, msTarget);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (res) {
      if (!res.body || !res.body.getReader) {
        return res.arrayBuffer().then(function (b) { bytes = b.byteLength; });
      }
      var reader = res.body.getReader();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          bytes += (r.value && r.value.length) || 0;
          if (!stopped) return pump();
        });
      }
      return pump();
    }).catch(function () {
    }).then(function () {
      clearTimeout(timer);
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      return { bytes: bytes, ms: Math.max(1, performance.now() - t0) };
    });
  }

  function spUpBlob() {
    if (SP.blob) return SP.blob;
    var unit = new Uint8Array(1024 * 1024);
    for (var i = 0; i < unit.length; i += 997) unit[i] = i & 255;
    var parts = [];
    for (var j = 0; j < 32; j++) parts.push(new Blob([unit]));
    SP.blob = new Blob(parts);
    return SP.blob;
  }

  function spUp(msTarget) {
    var t0 = performance.now(), loaded = 0;
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      var cut = false;
      var timer = setTimeout(function () {
        cut = true;
        try { xhr.abort(); } catch (e) {}
      }, msTarget);
      function fin() {
        clearTimeout(timer);
        resolve({ bytes: loaded, ms: Math.max(1, performance.now() - t0), cut: cut });
      }
      try {
        xhr.open('POST', API + withTok('/api/speed/up'), true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = function (e) { if (e && e.loaded > loaded) loaded = e.loaded; };
        xhr.onload = fin;
        xhr.onerror = fin;
        xhr.onabort = fin;
        xhr.send(spUpBlob());
      } catch (e) {
        fin();
      }
    });
  }

  function spLocal() {
    if (SP.busy) return;
    SP.busy = true;
    $('spLocalRun').disabled = true;
    $('spLocalRun').textContent = '测速中…';
    spSet('spPing', '…');
    spSet('spDown', '…');
    spSet('spUp', '…');
    spTip('正在测…');
    var pingMs = 0;
    spPing(5).then(function (ms) {
      pingMs = ms;
      spSet('spPing', ms + ' ms', ms < 12 ? 'good' : (ms > 60 ? 'bad' : ''));
      return spDown(3500);
    }).then(function (r) {
      spSet('spDown', spRate(r.bytes, r.ms), r.bytes * 1000 / r.ms > 1048576 ? 'good' : 'bad');
      return spUp(3000);
    }).then(function (r) {
      spSet('spUp', spRate(r.bytes, r.ms), r.bytes * 1000 / r.ms > 524288 ? 'good' : 'bad');
      var downBps = 0;
      try { downBps = parseFloat($('spDown').textContent); } catch (e) {}
      var slow = /KB\/s|B\/s/.test($('spDown').textContent);
      spTip(slow
        ? '带宽偏低：如果手机连的是 2.4GHz 或信号弱，换 5GHz、或把电脑插网线会快好几倍。'
        : '这个速度正常，日常传文件够用。');
    }).catch(function () {
      spTip('测速失败，检查一下和电脑的连接。');
    }).then(function () {
      SP.busy = false;
      $('spLocalRun').disabled = false;
      $('spLocalRun').textContent = '再测一次';
    });
  }

  function spFillTargets() {
    var sel = $('spTarget');
    if (!sel) return;
    var cur = sel.value;
    var opts = ['<option value="">选择一台在线设备</option>'];
    (S.devices || []).forEach(function (d) {
      if (d.is_self || d.revoked || !d.online) return;
      opts.push('<option value="' + d.id + '">' + esc(d.name || d.id) + '</option>');
    });
    sel.innerHTML = opts.join('');
    if (cur) sel.value = cur;
    if (opts.length === 1) $('spPairRun').disabled = true;
    else $('spPairRun').disabled = false;
  }

  function spCloseSocket() {
    clearInterval(SP.tick);
    SP.tick = null;
    if (SP.ws) {
      try {
        SP.ws.onclose = null;
        SP.ws.onmessage = null;
        SP.ws.close();
      } catch (e) {}
      SP.ws = null;
    }
  }

  function spJoin(sid, role, name) {
    spCloseSocket();
    SP.sid = sid;
    SP.role = role;
    SP.name = name || '';
    SP.sent = 0;
    SP.recv = 0;
    SP.remote = 0;
    SP.t0 = 0;
    SP.busy = true;
    $('spSendLabel').textContent = role === 'send' ? '我这台发出去' : '对方已发出';
    $('spRecvLabel').textContent = role === 'send' ? '对端收到' : '我实际收到';
    spSet('spSend', '…');
    spSet('spRecv', '…');
    $('spPairRun').disabled = true;
    $('spPairRun').textContent = role === 'send' ? '测速中…' : '对方正在测…';

    var url = API.replace(/^http/, 'ws') + '/ws/speed/' + encodeURIComponent(sid) +
      '?device=' + encodeURIComponent(ME_ID) +
      '&token=' + encodeURIComponent(HOST_TOK) + '&dtok=' + encodeURIComponent(DTOK);
    var ws;
    try { ws = new WebSocket(url); } catch (e) { toast('测速连接失败'); spBusyEnd(); return; }
    ws.binaryType = 'arraybuffer';
    SP.ws = ws;
    ws.onopen = function () { spTip('已连上，等两端就绪…'); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.t === 'go') spGo();
        else if (d.t === 'done') spFinish(d);
        else if (d.t === 'stat') {
          if (SP.role === 'send') SP.remote = d.down || 0;
          else SP.remote = d.up || 0;
        }
        return;
      }
      if (SP.role === 'recv') SP.recv += (ev.data && ev.data.byteLength) || 0;
    };
    ws.onclose = function () {
      if (SP.busy) spBusyEnd('连接断了');
    };
  }

  function spBusyEnd(msg) {
    SP.busy = false;
    clearInterval(SP.tick);
    SP.tick = null;
    $('spPairRun').disabled = false;
    $('spPairRun').textContent = '开始互测';
    if (msg) spTip(msg);
  }

  function spGo() {
    SP.t0 = performance.now();
    SP.sent = 0;
    SP.recv = 0;
    spTip(SP.role === 'send' ? '正在发送数据…' : '正在接收数据…');
    clearInterval(SP.tick);
    SP.tick = setInterval(function () {
      var ms = Math.max(1, performance.now() - SP.t0);
      if (SP.role === 'send') {
        spSet('spSend', spRate(SP.sent, ms));
        spSet('spRecv', spRate(SP.remote, ms));
        if (SP.ws && SP.ws.readyState === 1) {
          try { SP.ws.send(JSON.stringify({ t: 'stat' })); } catch (e) {}
        }
      } else {
        spSet('spSend', spRate(SP.remote, ms));
        spSet('spRecv', spRate(SP.recv, ms));
        if (SP.ws && SP.ws.readyState === 1) {
          try { SP.ws.send(JSON.stringify({ t: 'stat' })); } catch (e) {}
        }
      }
    }, 300);
    if (SP.role === 'send') spSendLoop();
  }

  function spSendLoop() {
    var CHUNK = 256 * 1024;
    var buf = new Uint8Array(CHUNK);
    for (var i = 0; i < CHUNK; i += 1021) buf[i] = i & 255;
    var deadline = performance.now() + 5000;
    function step() {
      var ws = SP.ws;
      if (!ws || ws.readyState !== 1) return;
      if (performance.now() > deadline) {
        try { ws.send(JSON.stringify({ t: 'done' })); } catch (e) {}
        return;
      }
      // 缓冲里堆太多说明这一跳已经发不动了，先等一等；
      // 一口气全塞进浏览器内存会得到一个好看但假的数字
      if (ws.bufferedAmount > 2 * 1024 * 1024) { setTimeout(step, 6); return; }
      try { ws.send(buf); } catch (e) { return; }
      SP.sent += CHUNK;
      setTimeout(step, 0);
    }
    step();
  }

  function spFinish(d) {
    var ms = Math.max(1, performance.now() - SP.t0);
    var up = (d && d.up) || SP.sent;
    var down = (d && d.down) || SP.recv;
    clearInterval(SP.tick);
    SP.tick = null;
    SP.busy = false;
    $('spPairRun').disabled = false;
    $('spPairRun').textContent = '再测一次';
    if (SP.role === 'send') {
      spSet('spSend', spRate(up, ms), 'good');
      spSet('spRecv', spRate(down, ms), 'good');
      spTip('我发出去 ' + spRate(up, ms) + '，对端实际收到 ' + spRate(down, ms) +
        '。中间要过电脑转一次，端到端以「对端收到」为准。');
    } else {
      spSet('spSend', spRate(up, ms));
      spSet('spRecv', spRate(down, ms), 'good');
      spTip('端到端 ' + spRate(down, ms) + '（我实际收到的）。这就是两台设备之间传文件的真实速度。');
    }
    spCloseSocket();
  }

  function spStartPair() {
    var target = $('spTarget').value;
    if (!target) { toast('先选一台在线设备'); return; }
    if (SP.busy) { toast('正在测，等一下'); return; }
    var name = '';
    (S.devices || []).forEach(function (x) { if (x.id === target) name = x.name; });
    api('/api/speed/relay/start', {
      method: 'POST',
      body: JSON.stringify({ device: ME_ID, target: target })
    }).then(function (d) {
      spJoin(d.sid, 'send', name);
      spTip('已通知 ' + (name || '对方') + '，等它连上就自动开始…');
    }).catch(function (e) {
      toast('发起失败：' + (e && e.message ? e.message : '未知错误'));
    });
  }

  function openSpeed() {
    $('speed').classList.add('show');
    spFillTargets();
    loadDevices(true).then(spFillTargets).catch(function () {});
  }

  function openSettings() {
    $('setName').value = S.me ? S.me.name : '';
    $('setServer').value = LS.get('nd_server', '') || API;
    $('setCode').textContent = S.accessCode || '------';
    $('setFolderField').style.display = canOpenFolder() ? '' : 'none';
    $('settings').classList.add('show');
  }

  function saveSettings() {
    var name = $('setName').value.trim();
    var server = $('setServer').value.trim().replace(/\/+$/, '');
    var oldServer = API;
    if (name && S.me && name !== S.me.name) {
      // 先写本地：哪怕这一刻正好网络抖了、凭证过期了，名字也不会被默认名冲回去
      LS.set('nd_device_name', name);
      LS.set('nd_name_custom', '1');
      S.me.name = name;
      $('meName').textContent = name;
      $('meAvatar').textContent = initial(name);
      (S.devices || []).forEach(function (d) { if (d.id === S.me.id) d.name = name; });
      api('/api/device/rename', {
        method: 'POST',
        body: JSON.stringify({ device_id: S.me.id, name: name })
      }).then(function () {
        toast('已改名');
      }).catch(function () {
        toast('已在本机改名，联网后自动同步');
      });
    }
    if (server && server !== oldServer) {
      LS.set('nd_server', server);
      // 换电脑就是另一个身份，各自的凭证分开记，这里不需要清
      if (isApp && window.NearDrop && window.NearDrop.setServer) {
        window.NearDrop.setServer(server);
      }
      toast('正在切换电脑…');
      setTimeout(function () { location.reload(); }, 600);
    }
    $('settings').classList.remove('show');
  }

  function openInvite() {
    var base = API;
    var target = base + '/?code=' + encodeURIComponent(S.accessCode || '');
    $('qrUrl').textContent = base + '/';
    $('qrCodeHint').textContent = S.accessCode ? ('访问码 ' + S.accessCode) : '';
    $('qrImg').src = API + withTok('/api/qr?text=' + encodeURIComponent(target) + '&t=' + Date.now());
    $('invite').classList.add('show');
  }

  function openChatMenu() {
    var c = S.convs.filter(function (x) { return x.id === S.conv; })[0];
    var label = c ? c.title : S.conv;
    if (confirm('清空「' + label + '」的全部消息？\n（服务器上的文件也会一并删除，无法恢复）')) {
      api('/api/clear', {
        method: 'POST',
        body: JSON.stringify({ conv: S.conv, device: S.me.id })
      }).then(function () {
        S.msgs = [];
        renderAll();
        loadConvs();
        toast('已清空');
      });
    }
  }

  function autoGrow() {
    var ta = $('textInput');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    $('btnSend').disabled = !ta.value.trim();
  }

  // ---------------------------------------------------------------- 事件绑定
  function bind() {
    $('btnSend').onclick = sendText;
    $('textInput').addEventListener('input', autoGrow);
    $('textInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 760) {
        e.preventDefault();
        sendText();
      }
    });

    $('btnMore').onclick = function () {
      var p = $('morePanel');
      p.classList.toggle('show');
      if (p.classList.contains('show')) {
        setTimeout(function () { $('textInput').blur(); }, 10);
      }
    };

    $('morePanel').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      $('morePanel').classList.remove('show');
      if (act === 'image') $('pickImage').click();
      else if (act === 'video') $('pickVideo').click();
      else if (act === 'file') $('pickFile').click();
      else if (act === 'camera') $('pickCamera').click();
    });

    ['pickImage', 'pickVideo', 'pickFile', 'pickCamera'].forEach(function (id) {
      $(id).addEventListener('change', function (e) {
        var files = e.target.files;
        if (files && files.length) sendFiles(files);
        e.target.value = '';
      });
    });

    $('convList').addEventListener('click', function (e) {
      var item = e.target.closest('.conv-item');
      if (!item) return;
      openConv(item.dataset.conv);
    });

    $('btnBack').onclick = function () {
      document.body.classList.remove('chat-open');
      loadConvs();
    };

    $('btnSettings').onclick = openSettings;
    $('btnSpeed').onclick = openSpeed;
    $('spLocalRun').onclick = spLocal;
    $('spPairRun').onclick = spStartPair;
    $('spClose').onclick = function () {
      $('speed').classList.remove('show');
      spCloseSocket();
      spBusyEnd();
    };
    $('speed').addEventListener('click', function (e) {
      if (e.target === $('speed')) {
        $('speed').classList.remove('show');
        spCloseSocket();
        spBusyEnd();
      }
    });
    $('btnInvite').onclick = openInvite;
    $('btnDevices').onclick = openDevices;
    $('btnChatMenu').onclick = openChatMenu;
    $('setCancel').onclick = function () { $('settings').classList.remove('show'); };
    $('setSave').onclick = saveSettings;
    $('setOpenDl').onclick = function () { openFolder('download'); };
    $('setOpenCam').onclick = function () { openFolder('camera'); };
    $('inviteClose').onclick = function () { $('invite').classList.remove('show'); };

    $('devClose').onclick = function () { $('devices').classList.remove('show'); };
    $('devices').addEventListener('click', function (e) {
      if (e.target === $('devices')) $('devices').classList.remove('show');
    });

    $('setResetCode').onclick = function () {
      if (!confirm('换一个访问码？\n已经连上的设备不受影响，新设备要用新码。')) return;
      api('/api/auth/reset-code', { method: 'POST' }).then(function (d) {
        S.accessCode = d.access_code;
        $('setCode').textContent = d.access_code;
        toast('新访问码：' + d.access_code, 4000);
      }).catch(function () { toast('操作失败'); });
    };

    $('authGo').onclick = submitAuth;
    $('authCode').addEventListener('input', function (e) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
    $('authCode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitAuth();
    });
    $('authScan').onclick = function () { location.href = 'connect.html?auto=1'; };

    $('viewerClose').onclick = closeViewer;
    $('viewerSave').onclick = function () {
      if (viewerCur) saveMsg(viewerCur);
    };
    $('viewer').addEventListener('click', function (e) {
      if (e.target === $('viewer')) closeViewer();
    });

    // 全屏播放器
    var pv = $('playerVideo');
    $('plClose').onclick = closePlayer;
    $('plBig').onclick = togglePlay;
    $('plPlay').onclick = togglePlay;
    $('plRotate').onclick = toggleRotate;
    $('plSave').onclick = function () { if (playerCur) saveMsg(playerCur); };
    if (!(window.NearDrop && window.NearDrop.setOrientation)) {
      $('plRotate').style.display = 'none';
    }
    pv.addEventListener('click', function () {
      if ($('player').classList.contains('hide-ui')) showPlayerUi();
      else $('player').classList.toggle('hide-ui');
    });
    pv.addEventListener('loadedmetadata', function () {
      $('plTotal').textContent = fmtDur(isFinite(pv.duration) ? pv.duration : 0);
    });
    pv.addEventListener('timeupdate', function () {
      var d = pv.duration || 0;
      $('plTime').textContent = fmtDur(pv.currentTime || 0);
      if (d > 0) $('plSeek').value = String(Math.round(pv.currentTime / d * 1000));
    });
    pv.addEventListener('play', function () {
      $('plBig').classList.add('hidden');
      $('plPlay').textContent = '❚❚';
      showPlayerUi();
    });
    pv.addEventListener('pause', function () {
      $('plBig').classList.remove('hidden');
      $('plPlay').textContent = '▶';
      $('player').classList.remove('hide-ui');
      clearTimeout(plHideTimer);
    });
    pv.addEventListener('error', function () {
      if ($('player').classList.contains('show')) toast('视频打不开，可能已被删除');
    });
    $('plSeek').addEventListener('input', function () {
      var d = pv.duration || 0;
      if (d > 0) pv.currentTime = d * (Number(this.value) / 1000);
      showPlayerUi();
    });

    // 长按消息菜单
    $('msgMenu').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mact]') : null;
      if (!b || !menuMsg) return;
      var act = b.getAttribute('data-mact');
      var m = menuMsg;
      closeMsgMenu();
      if (act === 'copy') {
        copyText(m.text || '');
      } else if (act === 'delete') {
        if (!confirm('删除这条消息？')) return;
        api('/api/message/' + m.id, { method: 'DELETE' })
          .then(function () { removeMsg(m.id); toast('已删除'); })
          .catch(function () { toast('删除失败'); });
      }
    });
    document.addEventListener('pointerdown', function (e) {
      if (!$('msgMenu').classList.contains('show')) return;
      if (e.target.closest && e.target.closest('#msgMenu')) return;
      closeMsgMenu();
    }, true);
    $('settings').addEventListener('click', function (e) {
      if (e.target === $('settings')) $('settings').classList.remove('show');
    });
    $('invite').addEventListener('click', function (e) {
      if (e.target === $('invite')) $('invite').classList.remove('show');
    });

    $('btnVoice').onclick = function () {
      if (rec.media || rec.native) return;
      startRecord();
    };
    $('recStop').onclick = function () { stopRecord(false); };
    $('recCancel').onclick = function () { stopRecord(true); };

    // 滚动加载更早
    var box = $('msgList');
    box.addEventListener('scroll', function () {
      if (box.scrollTop < 40 && S.hasMore && !S.loading) loadMessages(S.conv, false);
    });

    // 拖拽上传（电脑）
    ['dragover', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        sendFiles(e.dataTransfer.files);
      }
    });

    // 粘贴图片
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); sendFiles(files); }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.conv) {
        if (S.ws && S.ws.readyState !== 1) connectWS();
        catchUp(S.conv);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    boot();
  });

  // 供 Android 原生调用（录音上传完成后兜底刷新）
  window.__ndRefresh = function () {
    loadConvs();
    if (S.conv) catchUp(S.conv);
  };
})();
