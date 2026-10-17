// AETHEL EDU / GlobalStudy — shared mobile client runtime.
// Every public client (/, /student, /agent, /dbc, /supplier/*, /ads, /admin)
// uses this file so behaviour, i18n and styling stay identical everywhere.
(function () {
  'use strict';

  var STORAGE_LANG = 'gs-lang';
  var STORAGE_SESSION = 'gs-session';
  var STORAGE_ACTOR = 'gs-actor';

  // -------------------------------------------------------------------------
  // i18n — Chinese by default, English switch, persisted in localStorage.
  // -------------------------------------------------------------------------
  var lang = localStorage.getItem(STORAGE_LANG) || 'zh';

  var T = {
    zh: {
      appName: 'GlobalStudy',
      operator: 'AETHEL EDU 安世达教育',
      footer: '由安世达教育提供核心动力',
      switchLang: 'English',
      switchClient: '切换客户端',
      close: '关闭',
      loading: '加载中…',
      retry: '重试',
      error: '出错了，请重试',
      networkError: '网络请求失败',
      loginDemo: '一键体验 Demo',
      loginReal: '真实账号登录',
      logout: '退出登录',
      email: '邮箱',
      phone: '手机号',
      password: '密码',
      login: '登录',
      register: '注册',
      demoNotice: '当前为演示数据 / Demo data',
      sandboxNotice: '当前为 Sandbox 环境，未接入真实第三方服务',
      notBound: '待绑定',
      bound: '已绑定',
      browseOnly: '仅浏览模式',
      level1: 'Level 1 Premium',
      level2: 'Level 2 Executive',
      free: '免费会员',
      save: '保存',
      cancel: '取消',
      confirm: '确认',
      submit: '提交',
      search: '搜索',
      all: '全部',
      details: '详情',
      none: '暂无数据',
      yes: '是',
      no: '否',
      status: '状态',
      created: '创建时间',
      actions: '操作',
      currency: '币种',
      amount: '金额',
      poweredBy: 'Powered by Aethel Edu'
    },
    en: {
      appName: 'GlobalStudy',
      operator: 'AETHEL EDU',
      footer: 'Powered by Aethel Edu',
      switchLang: '中文',
      switchClient: 'Switch client',
      close: 'Close',
      loading: 'Loading…',
      retry: 'Retry',
      error: 'Something went wrong',
      networkError: 'Network request failed',
      loginDemo: 'One-click demo',
      loginReal: 'Sign in',
      logout: 'Sign out',
      email: 'Email',
      phone: 'Phone',
      password: 'Password',
      login: 'Sign in',
      register: 'Register',
      demoNotice: 'Demonstration data',
      sandboxNotice: 'Sandbox environment — no real third-party service is connected',
      notBound: 'Unbound',
      bound: 'Bound',
      browseOnly: 'Browse only',
      level1: 'Level 1 Premium',
      level2: 'Level 2 Executive',
      free: 'Free',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      submit: 'Submit',
      search: 'Search',
      all: 'All',
      details: 'Details',
      none: 'No data',
      yes: 'Yes',
      no: 'No',
      status: 'Status',
      created: 'Created',
      actions: 'Actions',
      currency: 'Currency',
      amount: 'Amount',
      poweredBy: 'Powered by Aethel Edu'
    }
  };

  function t(key) {
    return (T[lang] && T[lang][key]) || (T.en[key]) || key;
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    localStorage.setItem(STORAGE_LANG, lang);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    applyLangToDom();
    if (typeof window.onLangChange === 'function') window.onLangChange(lang);
  }

  function toggleLang() { setLang(lang === 'zh' ? 'en' : 'zh'); }

  function applyLangToDom() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i += 1) {
      var key = nodes[i].getAttribute('data-i18n');
      var value = t(key);
      if (nodes[i].hasAttribute('data-i18n-attr')) {
        nodes[i].setAttribute(nodes[i].getAttribute('data-i18n-attr'), value);
      } else {
        nodes[i].textContent = value;
      }
    }
    var btn = document.getElementById('langBtn');
    if (btn) btn.textContent = t('switchLang');
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------
  function sessionToken() { return localStorage.getItem(STORAGE_SESSION) || ''; }

  function saveSession(token, actor) {
    if (token) localStorage.setItem(STORAGE_SESSION, token);
    if (actor) localStorage.setItem(STORAGE_ACTOR, JSON.stringify(actor));
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_SESSION);
    localStorage.removeItem(STORAGE_ACTOR);
  }

  function currentActor() {
    try { return JSON.parse(localStorage.getItem(STORAGE_ACTOR) || 'null'); }
    catch (_) { return null; }
  }

  function authHeaders() {
    var token = sessionToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  function api(path, options) {
    var opts = options || {};
    var method = opts.method || 'GET';
    var headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(), opts.headers || {});
    var body = (opts.body === undefined || method === 'GET') ? undefined : JSON.stringify(opts.body);
    return fetch(path, { method: method, headers: headers, body: body })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        var parsed = ct.indexOf('application/json') >= 0 ? r.json() : r.text();
        return parsed.then(function (payload) {
          if (!r.ok) {
            var message = (payload && payload.error) || t('error');
            var err = new Error(message);
            err.status = r.status;
            err.payload = payload;
            throw err;
          }
          return payload;
        });
      })
      .catch(function (e) {
        if (e && e.status) throw e;
        var netErr = new Error(t('networkError'));
        netErr.status = 0;
        throw netErr;
      });
  }

  function get(path) { return api(path); }
  function post(path, body) { return api(path, { method: 'POST', body: body }); }
  function put(path, body) { return api(path, { method: 'PUT', body: body }); }
  function patch(path, body) { return api(path, { method: 'PATCH', body: body }); }
  function del(path) { return api(path, { method: 'DELETE' }); }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
      });
  }

  function label(obj, fallback) {
    if (obj === null || obj === undefined) return fallback || '—';
    if (typeof obj === 'string') return obj;
    return lang === 'zh' ? (obj.zh || obj.name_zh || obj.en || obj.name_en || fallback || '—')
      : (obj.en || obj.name_en || obj.zh || obj.name_zh || fallback || '—');
  }

  function money(value, currency) {
    if (value === null || value === undefined || value === '') return '—';
    var amount = typeof value === 'object' ? value.amount : value;
    var cur = currency || (typeof value === 'object' ? value.currency : '') || 'SGD';
    try {
      return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US',
        { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(Number(amount));
    } catch (_) {
      return String(amount) + ' ' + cur;
    }
  }

  function date(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US');
  }

  function datetime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
  }

  function statusTag(status) {
    var s = String(status || '').toLowerCase();
    var cls = 'blue';
    if (['verified', 'active', 'approved', 'paid', 'succeeded', 'completed', 'done', 'enrolled', 'admitted', 'confirmed', 'checked_in', 'received'].indexOf(s) >= 0) cls = 'good';
    else if (['demo', 'pending', 'draft', 'cart', 'scheduled', 'projected', 'requested', 'processing', 'reserved', 's3', 's4', 's7', 'under_review', 'interview_required'].indexOf(s) >= 0) cls = 'demo';
    else if (['rejected', 'cancelled', 'expired', 'failed', 'clawed_back', 'frozen', 'withdrawn', 'waitlisted'].indexOf(s) >= 0) cls = 'warn';
    return '<span class="status ' + cls + '">' + esc(status) + '</span>';
  }

  function stageLabel(code) {
    var map = {
      S0: ['意向', 'Lead'], S1: ['匹配', 'Matching'], S2: ['申请', 'Application'], S3: ['材料', 'Documents'],
      S4: ['面试 / 测试', 'Interview / Test'], S5: ['录取', 'Admission'], S6: ['合同', 'Contract'],
      S7: ['签证', 'Visa'], S8: ['行前', 'Pre-departure'], S9: ['入学', 'Enrollment'], S10: ['佣金结算', 'Commission']
    };
    var entry = map[String(code).toUpperCase()];
    return entry ? (lang === 'zh' ? entry[0] : entry[1]) : String(code);
  }

  function emptyState(text) {
    return '<div class="empty">' + esc(text || t('none')) + '</div>';
  }

  function errorState(message) {
    return '<div class="empty">' + esc(message || t('error')) + '</div>';
  }

  function metrics(items) {
    return '<div class="metrics">' + items.map(function (item) {
      return '<div class="metric"><small>' + esc(item[0]) + '</small><b>' + esc(item[1]) + '</b></div>';
    }).join('') + '</div>';
  }

  function sectionHead(title, right) {
    return '<div class="section-head"><h2>' + esc(title) + '</h2><span>' + esc(right || '') + '</span></div>';
  }

  function card(html) { return '<div class="card">' + html + '</div>'; }

  function notice(text) { return '<div class="notice">' + esc(text) + '</div>'; }

  function sandboxNote() {
    return notice(t('sandboxNotice'));
  }

  // Bottom sheet drawer
  function openDrawer(title, html) {
    var drawer = document.getElementById('drawer');
    var mask = document.getElementById('mask');
    if (!drawer || !mask) return;
    document.getElementById('drawerTitle').textContent = title;
    document.getElementById('drawerBody').innerHTML = html;
    document.getElementById('drawerClose').textContent = t('close');
    drawer.classList.add('open');
    mask.classList.add('open');
  }

  function closeDrawer() {
    var drawer = document.getElementById('drawer');
    var mask = document.getElementById('mask');
    if (drawer) drawer.classList.remove('open');
    if (mask) mask.classList.remove('open');
  }

  // -------------------------------------------------------------------------
  // Navigation / tabs
  // -------------------------------------------------------------------------
  function showTab(name, names) {
    var list = names || [];
    for (var i = 0; i < list.length; i += 1) {
      var tab = document.getElementById('tab' + list[i]);
      var nav = document.getElementById('nav' + list[i]);
      if (tab) tab.classList.toggle('active', list[i].toLowerCase() === name);
      if (nav) nav.classList.toggle('active', list[i].toLowerCase() === name);
    }
    if (typeof window.renderTab === 'function') window.renderTab(name);
  }

  // -------------------------------------------------------------------------
  // Auth gate — redirect to the demo login panel when there is no session.
  // -------------------------------------------------------------------------
  function requireAuth() {
    return !sessionToken();
  }

  function loginPanel(demoAccounts) {
    var accounts = (demoAccounts || []).map(function (a) {
      return '<button class="btn primary wide" data-demo="' + esc(a.token) + '">' +
        esc(t('loginDemo')) + ' · ' + esc(a.display_name || a.token) + '</button>';
    }).join('');
    return '<section class="section">' +
      '<div class="hero"><div class="eyebrow">DEMO</div><h1>' + esc(t('loginDemo')) + '</h1>' +
      '<p>' + esc(t('sandboxNotice')) + '</p></div>' +
      '<div class="list" style="margin-top:12px">' + (accounts || emptyState(t('none'))) + '</div>' +
      '<div class="section-head"><h2>' + esc(t('loginReal')) + '</h2></div>' +
      '<div class="search">' +
      '<input id="loginEmail" class="wide" placeholder="' + esc(t('email')) + '">' +
      '<input id="loginPassword" type="password" placeholder="' + esc(t('password')) + '">' +
      '<button class="btn primary wide" id="doLogin">' + esc(t('login')) + '</button>' +
      '</div></section>';
  }

  function bindLogin() {
    var buttons = document.querySelectorAll('[data-demo]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].onclick = function () {
        var token = this.getAttribute('data-demo');
        post('/api/auth/demo-login', { token: token }).then(function (r) {
          saveSession(r.data.token, r.data.user);
          location.reload();
        }).catch(function (e) { alert(e.message); });
      };
    }
    var btn = document.getElementById('doLogin');
    if (btn) {
      btn.onclick = function () {
        var email = document.getElementById('loginEmail').value;
        var password = document.getElementById('loginPassword').value;
        post('/api/auth/login', { email: email, password: password }).then(function (r) {
          saveSession(r.data.token, r.data.user);
          location.reload();
        }).catch(function (e) { alert(e.message); });
      };
    }
  }

  function logout() {
    post('/api/auth/logout', {}).catch(function () {});
    clearSession();
    location.reload();
  }

  // -------------------------------------------------------------------------
  // Footer (Rule: every page carries the operator credit)
  // -------------------------------------------------------------------------
  function footer() {
    return '<footer class="footer">' + esc(t('appName')) + ' · ' + esc(t('footer')) +
      '<span class="footer-powered">' + esc(t('poweredBy')) + '</span></footer>';
  }

  // -------------------------------------------------------------------------
  // Client shell — header, tabs, bottom nav, drawer
  // -------------------------------------------------------------------------
  function shell(options) {
    var opts = options || {};
    var header = '<header class="header">' +
      '<a class="brand" href="/"><div class="logo">G</div><div><b>' + esc(opts.title || 'GlobalStudy') +
      '</b><small id="clientName">' + esc(opts.subtitle || '') + '</small></div></a>' +
      '<div class="header-actions"><button class="lang-btn" id="langBtn">' + esc(t('switchLang')) + '</button>' +
      (opts.showSwitch === false ? '' : '<a class="pill" href="/" id="switchClient">' + esc(t('switchClient')) + '</a>') +
      '</div></header>';

    var hero = opts.hero === false ? '' :
      '<section class="hero"><div class="eyebrow">' + esc(opts.eyebrow || '') + '</div>' +
      '<h1>' + esc(opts.headline || '') + '</h1><p>' + esc(opts.lead || '') + '</p></section>';

    var tabs = (opts.tabs && opts.tabs.length)
      ? '<div class="tabs">' + opts.tabs.map(function (tab) {
          return '<button id="tab' + tab.key + '"' + (tab.active ? ' class="active"' : '') +
            ' onclick="showTab(\'' + esc(tab.key.toLowerCase()) + '\', window.TAB_NAMES)">' + esc(tab.label) + '</button>';
        }).join('') + '</div>'
      : '';

    var nav = (opts.tabs && opts.tabs.length)
      ? '<nav class="bottom">' + opts.tabs.map(function (tab) {
          return '<button id="nav' + tab.key + '"' + (tab.active ? ' class="active"' : '') +
            ' onclick="showTab(\'' + esc(tab.key.toLowerCase()) + '\', window.TAB_NAMES)"><b>' + esc(tab.icon || '●') +
            '</b><span id="nav' + tab.key + 'Text">' + esc(tab.label) + '</span></button>';
        }).join('') + '</nav>'
      : '';

    return header + hero + tabs + '<main id="main"></main>' + footer() + nav +
      '<div class="drawer-mask" id="mask" onclick="closeDrawer()"></div>' +
      '<section class="drawer" id="drawer"><div class="handle"></div>' +
      '<div class="drawer-head"><b id="drawerTitle">' + esc(t('details')) + '</b>' +
      '<button id="drawerClose" onclick="closeDrawer()">' + esc(t('close')) + '</button></div>' +
      '<div id="drawerBody"></div></section>';
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------
  window.GS = {
    t: t, setLang: setLang, toggleLang: toggleLang, get lang() { return lang; },
    api: api, get: get, post: post, put: put, patch: patch, del: del,
    sessionToken: sessionToken, saveSession: saveSession, clearSession: clearSession,
    currentActor: currentActor, authHeaders: authHeaders,
    esc: esc, label: label, money: money, date: date, datetime: datetime,
    statusTag: statusTag, stageLabel: stageLabel,
    emptyState: emptyState, errorState: errorState, metrics: metrics,
    sectionHead: sectionHead, card: card, notice: notice, sandboxNote: sandboxNote,
    openDrawer: openDrawer, closeDrawer: closeDrawer, showTab: showTab,
    requireAuth: requireAuth, loginPanel: loginPanel, bindLogin: bindLogin, logout: logout,
    footer: footer, shell: shell,
    applyLangToDom: applyLangToDom
  };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('langBtn');
    if (btn) btn.onclick = toggleLang;
    applyLangToDom();
    if (typeof window.onReady === 'function') window.onReady();
  });
})();
