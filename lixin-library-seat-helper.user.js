// ==UserScript==
// @name         LiXin Library Seat Helper
// @namespace    https://kjyy.lixin.edu.cn/
// @version      2.0.0
// @description  上海立信会计金融学院 IC 空间座位预约辅助：点座位自动填号、定时预约、任务列表与取消。
// @author       顾佳俊
// @match        https://kjyy.lixin.edu.cn/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'lixin-seat-helper.tasks.v1';
  const SETTINGS_KEY = 'lixin-seat-helper.form.v1';
  const TICK_MS = 1000;
  const RUN_GRACE_MS = 10 * 60 * 1000;
  const LOGIN_CHECK_INTERVAL_MS = 10 * 1000;
  const LOGIN_PROBE_FALLBACK_PATH = '/ic-web/auth/userInfo';
  const LOGIN_RESPONSE_PREVIEW_LIMIT = 3000;
  const DEFAULT_APPLY_NOTE = '';
  const DAY_OPTION_DEFINITIONS = [
    { value: '今天', offset: 0, name: '今天' },
    { value: '明天', offset: 1, name: '明天' },
    { value: '+2', offset: 2, name: '后天' },
    { value: '+3', offset: 3, name: '三天后' },
    { value: '+4', offset: 4, name: '四天后' },
    { value: '+5', offset: 5, name: '五天后' },
    { value: '+6', offset: 6, name: '六天后' },
    { value: '+7', offset: 7, name: '七天后' }
  ];

  const STATUS_LABELS = {
    green: '空闲',
    yellowGreen: '半空闲',
    yellow: '使用中',
    gray: '不开放'
  };

  let state = {
    tasks: loadTasks(),
    form: loadForm(),
    panelOpen: false,
    busy: false,
    loginCheck: {
      status: 'pending',
      message: '等待首次检测',
      nextAt: Date.now(),
      lastCheckedAt: 0,
      checking: false
    },
    toastTimer: 0
  };

  const dom = {};

  boot();

  function boot() {
    injectStyle();
    createUi();
    bindSeatPicker();
    render();
    setInterval(appTick, TICK_MS);
    window.addEventListener('hashchange', () => {
      if (getCurrentRoomId()) {
        state.form.routeHash = location.hash;
        state.form.roomName = getRoomName();
        saveForm();
      }
      render();
    });
  }

  function getPageWindow() {
    try {
      return typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    } catch {
      return window;
    }
  }

  function injectStyle() {
    GM_addStyle(`
      #lixin-seat-helper-root {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        color: #1f2937;
      }
      #lixin-seat-helper-root * {
        box-sizing: border-box;
        letter-spacing: 0;
      }
      .lsh-fab {
        width: 46px;
        height: 46px;
        border: 0;
        border-radius: 50%;
        background: #146c94;
        color: #fff;
        font-size: 18px;
        font-weight: 700;
        box-shadow: 0 8px 24px rgba(20, 108, 148, .28);
        cursor: pointer;
      }
      .lsh-panel {
        width: 380px;
        max-width: calc(100vw - 28px);
        max-height: calc(100vh - 36px);
        overflow: auto;
        margin-bottom: 12px;
        background: #fff;
        border: 1px solid #d7dde5;
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, .22);
      }
      .lsh-hidden {
        display: none !important;
      }
      .lsh-head {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: #f8fafc;
        border-bottom: 1px solid #e5e7eb;
      }
      .lsh-title {
        font-size: 15px;
        font-weight: 700;
      }
      .lsh-author {
        margin-top: 2px;
        color: #64748b;
        font-size: 11px;
        line-height: 1.2;
      }
      .lsh-close {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #475569;
        cursor: pointer;
        font-size: 20px;
        line-height: 28px;
      }
      .lsh-body {
        padding: 14px;
      }
      .lsh-room {
        margin-bottom: 10px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.45;
      }
      .lsh-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .lsh-login-status {
        grid-column: 1 / -1;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        min-height: 42px;
        padding: 8px 10px;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        background: #f8fafc;
      }
      .lsh-login-dot {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        margin-top: 5px;
        border-radius: 50%;
        background: #94a3b8;
      }
      .lsh-login-status[data-state="ok"] .lsh-login-dot {
        background: #16a34a;
      }
      .lsh-login-status[data-state="checking"] .lsh-login-dot,
      .lsh-login-status[data-state="pending"] .lsh-login-dot {
        background: #0ea5e9;
      }
      .lsh-login-status[data-state="failed"] .lsh-login-dot {
        background: #dc2626;
      }
      .lsh-login-status[data-state="skipped"] .lsh-login-dot,
      .lsh-login-status[data-state="warn"] .lsh-login-dot {
        background: #d97706;
      }
      .lsh-login-copy {
        min-width: 0;
      }
      .lsh-login-label {
        color: #0f172a;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.35;
      }
      .lsh-login-detail {
        margin-top: 2px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.35;
        word-break: break-word;
      }
      .lsh-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .lsh-field-wide {
        grid-column: 1 / -1;
      }
      .lsh-field label {
        color: #334155;
        font-size: 12px;
        font-weight: 600;
      }
      .lsh-field input,
      .lsh-field select {
        height: 34px;
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 0 10px;
        color: #111827;
        background: #fff;
        font-size: 13px;
        outline: none;
      }
      .lsh-field input:focus,
      .lsh-field select:focus {
        border-color: #146c94;
        box-shadow: 0 0 0 3px rgba(20, 108, 148, .12);
      }
      .lsh-field input[readonly] {
        color: #64748b;
        background: #f8fafc;
      }
      .lsh-primary {
        width: 100%;
        height: 36px;
        margin-top: 12px;
        border: 0;
        border-radius: 6px;
        background: #146c94;
        color: #fff;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
      }
      .lsh-primary:disabled {
        opacity: .55;
        cursor: not-allowed;
      }
      .lsh-section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 16px 0 8px;
        color: #0f172a;
        font-size: 13px;
        font-weight: 700;
      }
      .lsh-task-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .lsh-empty {
        border: 1px dashed #cbd5e1;
        border-radius: 6px;
        padding: 12px;
        color: #64748b;
        text-align: center;
        font-size: 12px;
      }
      .lsh-task {
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        padding: 10px;
        background: #fbfdff;
      }
      .lsh-task-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }
      .lsh-task-seat {
        color: #0f172a;
        font-size: 13px;
        font-weight: 700;
        word-break: break-word;
      }
      .lsh-task-meta {
        margin-top: 5px;
        color: #475569;
        font-size: 12px;
        line-height: 1.5;
      }
      .lsh-task-status {
        margin-top: 6px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.45;
        word-break: break-word;
      }
      .lsh-task-countdown {
        margin-top: 4px;
        color: #146c94;
        font-size: 12px;
        line-height: 1.45;
        word-break: break-word;
      }
      .lsh-cancel {
        flex: 0 0 auto;
        height: 28px;
        border: 1px solid #fca5a5;
        border-radius: 6px;
        background: #fff;
        color: #b91c1c;
        cursor: pointer;
        font-size: 12px;
      }
      .lsh-toast {
        position: fixed;
        right: 18px;
        bottom: 78px;
        z-index: 2147483001;
        max-width: min(360px, calc(100vw - 32px));
        padding: 10px 12px;
        border-radius: 6px;
        background: #0f172a;
        color: #fff;
        box-shadow: 0 12px 30px rgba(15, 23, 42, .25);
        font-size: 13px;
        line-height: 1.45;
      }
      .lsh-help {
        margin-top: 9px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.45;
      }
      @media (max-width: 520px) {
        #lixin-seat-helper-root {
          right: 10px;
          bottom: 10px;
        }
        .lsh-panel {
          width: calc(100vw - 20px);
        }
      }
    `);
  }

  function createUi() {
    const root = document.createElement('div');
    root.id = 'lixin-seat-helper-root';
    root.innerHTML = `
      <div class="lsh-panel lsh-hidden">
        <div class="lsh-head">
          <div>
            <div class="lsh-title">立信座位助手</div>
            <div class="lsh-author">作者：顾佳俊 23级金融科技 联系微信：AL-0729-zK</div>
          </div>
          <button class="lsh-close" type="button" title="关闭">x</button>
        </div>
        <div class="lsh-body">
          <div class="lsh-room"></div>
          <div class="lsh-grid">
            <div class="lsh-login-status" data-lsh-login-status data-state="pending">
              <span class="lsh-login-dot"></span>
              <div class="lsh-login-copy">
                <div class="lsh-login-label" data-lsh-login-label>登录状态：等待检测</div>
                <div class="lsh-login-detail" data-lsh-login-detail>下次检测：-- 秒后</div>
              </div>
            </div>
            <div class="lsh-field lsh-field-wide">
              <label>目标座位号</label>
              <input data-lsh-field="seatId" autocomplete="off" placeholder="例如 PDW3FA3001">
            </div>
            <div class="lsh-field">
              <label>几点开始执行预约</label>
              <input data-lsh-field="runAt" type="datetime-local" step="1" autocomplete="off">
            </div>
            <div class="lsh-field">
              <label>预约哪一天</label>
              <select data-lsh-field="dayExpr"></select>
            </div>
            <div class="lsh-field lsh-field-wide">
              <label>预约时间段</label>
              <input data-lsh-field="timeRange" autocomplete="off" placeholder="例如 08:00-22:30">
            </div>
          </div>
          <button class="lsh-primary" type="button">提交任务</button>
          <div class="lsh-help">左键点击座位圆点会打开本面板并自动填入座位号；任务会按记录的房间和设定时间发起网络预约。</div>
          <div class="lsh-section-title">
            <span>当前任务</span>
            <span data-lsh-count></span>
          </div>
          <div class="lsh-task-list"></div>
        </div>
      </div>
      <button class="lsh-fab" type="button" title="立信座位助手">座</button>
    `;
    document.documentElement.appendChild(root);

    dom.root = root;
    dom.panel = root.querySelector('.lsh-panel');
    dom.fab = root.querySelector('.lsh-fab');
    dom.close = root.querySelector('.lsh-close');
    dom.room = root.querySelector('.lsh-room');
    dom.submit = root.querySelector('.lsh-primary');
    dom.taskList = root.querySelector('.lsh-task-list');
    dom.count = root.querySelector('[data-lsh-count]');
    dom.loginStatus = root.querySelector('[data-lsh-login-status]');
    dom.loginLabel = root.querySelector('[data-lsh-login-label]');
    dom.loginDetail = root.querySelector('[data-lsh-login-detail]');
    dom.fields = {
      seatId: root.querySelector('[data-lsh-field="seatId"]'),
      runAt: root.querySelector('[data-lsh-field="runAt"]'),
      dayExpr: root.querySelector('[data-lsh-field="dayExpr"]'),
      timeRange: root.querySelector('[data-lsh-field="timeRange"]')
    };

    dom.fab.addEventListener('click', () => togglePanel(true));
    dom.close.addEventListener('click', () => togglePanel(false));
    dom.submit.addEventListener('click', createTaskFromForm);
    Object.values(dom.fields).forEach(field => {
      const update = () => {
        state.form[field.dataset.lshField] = field.value;
        state.form.routeHash = location.hash;
        state.form.roomName = getRoomName();
        saveForm();
      };
      field.addEventListener('input', update);
      field.addEventListener('change', update);
    });
    dom.taskList.addEventListener('click', event => {
      const button = event.target.closest('[data-lsh-cancel]');
      if (!button) return;
      const id = button.getAttribute('data-lsh-cancel');
      state.tasks = state.tasks.filter(task => task.id !== id);
      saveTasks();
      render();
      toast('已取消任务');
    });
  }

  function bindSeatPicker() {
    document.addEventListener('click', event => {
      if (event.button !== 0) return;
      const seat = event.target.closest('.seat-area .grid .draggable[title]');
      if (!seat) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const seatId = (seat.getAttribute('title') || seat.textContent || '').trim();
      const status = detectSeatStatus(seat);
      handleSeatPick(seatId, status);
    }, true);
  }

  function handleSeatPick(seatId, status) {
    state.form.seatId = seatId;
    state.form.routeHash = location.hash;
    state.form.roomName = getRoomName();
    saveForm();
    render();
    togglePanel(true);
    toast(`已填入座位 ${seatId}（${status.label}）`);
  }

  function createTaskFromForm() {
    const form = readForm();
    const parsed = validateTask(form);
    if (!parsed.ok) {
      toast(parsed.message);
      return;
    }

    const routeHash = getCurrentRoomId() ? location.hash : state.form.routeHash;
    const roomName = getCurrentRoomId() ? getRoomName() : state.form.roomName;
    if (!extractRoomId(routeHash)) {
      toast('请先在目标座位预约房间页面创建任务或点选座位');
      return;
    }
    const task = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seatId: parsed.seatId,
      runAt: parsed.runAt,
      dayExpr: parsed.dayExpr,
      targetDate: resolveTargetDate(parsed.dayExpr),
      timeRange: parsed.timeRange,
      routeHash,
      roomName,
      createdAt: new Date().toISOString(),
      lastRunOn: '',
      completedAt: '',
      missedAt: '',
      running: false,
      status: '等待执行'
    };
    state.tasks.push(task);
    state.form = {
      ...state.form,
      seatId: parsed.seatId,
      runAt: parsed.runAt,
      dayExpr: parsed.dayExpr,
      timeRange: parsed.timeRange,
      routeHash: task.routeHash,
      roomName
    };
    saveForm();
    saveTasks();
    render();
    toast('任务已创建');
  }

  function render() {
    if (!dom.panel) return;
    if (!isValidDayExpr(state.form.dayExpr)) {
      state.form.dayExpr = '明天';
      saveForm();
    }
    renderDayOptions();
    dom.panel.classList.toggle('lsh-hidden', !state.panelOpen);
    dom.fab.classList.toggle('lsh-hidden', state.panelOpen);

    const currentRoom = getRoomName();
    dom.room.textContent = currentRoom
      ? `当前页面：${currentRoom} (${location.hash || '未进入座位预约页'})`
      : `当前页面：${location.hash || '未进入座位预约页'}`;
    renderLoginCheck();

    for (const [key, input] of Object.entries(dom.fields)) {
      if (document.activeElement !== input) input.value = state.form[key] || '';
    }

    dom.count.textContent = `${state.tasks.length}`;
    if (!state.tasks.length) {
      dom.taskList.innerHTML = `<div class="lsh-empty">暂无自动任务</div>`;
      return;
    }

    dom.taskList.innerHTML = state.tasks
      .map(task => `
        <div class="lsh-task">
          <div class="lsh-task-top">
            <div>
              <div class="lsh-task-seat">${escapeHtml(task.seatId)}</div>
              <div class="lsh-task-meta">${escapeHtml(formatRunAtLabel(task.runAt))} / ${escapeHtml(formatTargetDateLabel(task))} / ${escapeHtml(task.timeRange || '08:00-22:30')}</div>
              <div class="lsh-task-meta">${escapeHtml(task.roomName || task.routeHash || '当前座位页')}</div>
            </div>
            <button class="lsh-cancel" type="button" data-lsh-cancel="${escapeHtml(task.id)}">取消</button>
          </div>
          <div class="lsh-task-status">${escapeHtml(task.status || '等待执行')}</div>
          <div class="lsh-task-countdown" data-lsh-countdown="${escapeHtml(task.id)}"></div>
        </div>
      `)
      .join('');
    updateTaskCountdowns();
  }

  function appTick() {
    schedulerTick();
    loginCheckTick();
    updateTaskCountdowns();
  }

  function renderLoginCheck() {
    if (!dom.loginStatus) return;
    const check = state.loginCheck;
    const secondsLeft = check.checking
      ? 0
      : Math.max(0, Math.ceil((check.nextAt - Date.now()) / 1000));
    const checkedAt = check.lastCheckedAt
      ? `上次：${new Date(check.lastCheckedAt).toLocaleTimeString()}`
      : '尚未检测';

    dom.loginStatus.setAttribute('data-state', check.status);
    dom.loginLabel.textContent = `登录状态：${loginStatusLabel(check.status)}`;
    dom.loginDetail.textContent = check.checking
      ? `${check.message}；正在检测；${checkedAt}`
      : `${check.message}；下次检测：${secondsLeft} 秒后；${checkedAt}`;
  }

  function loginStatusLabel(status) {
    return {
      pending: '等待检测',
      checking: '检测中',
      ok: '正常',
      failed: '可能已失效',
      skipped: '暂缓检测',
      warn: '无法确认'
    }[status] || '未知';
  }

  function loginCheckTick() {
    renderLoginCheck();
    if (state.loginCheck.checking) return;
    if (Date.now() < state.loginCheck.nextAt) return;
    runLoginCheck();
  }

  async function runLoginCheck() {
    const check = state.loginCheck;
    const previousStatus = check.status;
    check.checking = true;
    check.status = 'checking';
    check.message = '正在检测页面登录状态';
    renderLoginCheck();

    try {
      const skipReason = loginCheckSkipReason();
      const result = skipReason
        ? { status: 'skipped', message: skipReason }
        : await inspectLoginState();

      check.status = result.status;
      check.message = result.message;
      if (result.status === 'failed' && previousStatus !== 'failed') {
        notify('立信座位助手', result.message);
        toast(result.message);
      }
    } catch (error) {
      check.status = 'failed';
      check.message = `检测失败：${error.message || error}`;
      if (previousStatus !== 'failed') {
        notify('立信座位助手', check.message);
        toast(check.message);
      }
    } finally {
      check.checking = false;
      check.lastCheckedAt = Date.now();
      check.nextAt = Date.now() + LOGIN_CHECK_INTERVAL_MS;
      renderLoginCheck();
    }
  }

  function loginCheckSkipReason() {
    if (state.busy) return '自动任务执行中，暂缓登录检测';
    if (hasVisibleElement('.el-dialog')) return '页面弹窗打开中，暂缓登录检测';
    const openPicker = Array.from(document.querySelectorAll('.el-picker-panel, .el-select-dropdown.el-popper'))
      .some(visibleElement);
    if (openPicker) return '日期或时间选择器打开中，暂缓登录检测';
    return '';
  }

  async function inspectLoginState() {
    return runLoginProbe(buildLoginProbe());
  }

  async function runLoginProbe(probe) {
    const started = Date.now();
    try {
      const page = getPageWindow();
      const pageFetch = page?.fetch?.bind(page) || fetch;
      const response = await pageFetch(probe.url, {
        cache: 'no-store',
        credentials: 'include',
        redirect: 'manual',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-lixin-seat-helper-probe': '1'
        },
        method: 'GET'
      });
      const responseText = response.type === 'opaqueredirect'
        ? ''
        : await response.clone().text().catch(() => '');
      const record = {
        contentType: response.headers.get('content-type') || '',
        json: parseJson(responseText),
        responseType: response.type || '',
        status: response.status,
        textPreview: responseText.slice(0, LOGIN_RESPONSE_PREVIEW_LIMIT),
        url: response.url || probe.url
      };
      const judgement = judgeLoginProbeRecord(record);
      const elapsed = Date.now() - started;

      if (judgement.status === 'ok') {
        return { status: 'ok', message: `网络检测正常：${probe.label}，HTTP ${response.status}，${elapsed}ms` };
      }
      if (judgement.status === 'failed') {
        return { status: 'failed', message: `网络检测失败：${judgement.reason}，请求 ${probe.label}` };
      }
      return { status: 'warn', message: `网络响应无法确认：${probe.label}，HTTP ${response.status}` };
    } catch (error) {
      return { status: 'failed', message: `网络检测请求失败：${error.message || error}` };
    }
  }

  function buildLoginProbe() {
    const roomId = getCurrentRoomId();
    if (roomId) {
      const params = new URLSearchParams({
        roomIds: roomId,
        resvDates: toCompactDate(new Date()),
        sysKind: '8'
      });
      return {
        label: `座位查询 ${roomId}`,
        url: `/ic-web/reserve?${params.toString()}`
      };
    }
    return {
      label: '用户信息',
      url: LOGIN_PROBE_FALLBACK_PATH
    };
  }

  function getCurrentRoomId() {
    const match = String(location.hash || '').match(/\/ic\/seatPredetermine\/(\d+)/);
    return match ? match[1] : '';
  }

  function judgeLoginProbeRecord(record) {
    const status = Number(record.status) || 0;
    const text = String(record.textPreview || '');
    const lowerUrl = String(record.url || '').toLowerCase();
    const loginFailure = /请登录|未登录|重新登录|登录超时|登录已失效|会话已失效|身份认证|认证失败|unauthorized|forbidden|session expired|token expired/i.test(text);
    const authRedirect = record.responseType === 'opaqueredirect' || /atrust\.lixin\.edu\.cn|controller\/v1\/public\/verify|\/login\b|cas|sso/.test(lowerUrl);
    const loginHtml = /text\/html/i.test(record.contentType) && /(login|password|请登录|统一身份|认证)/i.test(text);

    if (authRedirect || status === 0) {
      return { status: 'failed', reason: '请求被重定向到统一认证' };
    }
    if ([401, 403, 419, 440].includes(status) || loginFailure || loginHtml) {
      return { status: 'failed', reason: `响应显示登录失效（HTTP ${status || '未知'}）` };
    }
    if (status >= 300 && status < 400) {
      return { status: 'failed', reason: `响应发生重定向（HTTP ${status}）` };
    }

    const json = record.json || parseJson(text);
    if (json) {
      const code = json.code ?? json.status ?? json.statusCode;
      const message = String(json.message || json.msg || json.repMsg || '');
      if (code === 0 || code === '0' || message === '查询成功') {
        return { status: 'ok', reason: `响应正常（HTTP ${status}）` };
      }
      if ([401, 403, 419, 440].includes(Number(code)) || /请登录|未登录|重新登录|登录超时|登录已失效|会话已失效|认证/.test(message)) {
        return { status: 'failed', reason: `接口返回登录失效：${message || code}` };
      }
      return { status: 'warn', reason: `接口返回未知状态：${message || code || '无状态'}` };
    }

    if (status >= 200 && status < 300) {
      return { status: 'warn', reason: `响应不是预期 JSON（HTTP ${status}）` };
    }
    return { status: 'warn', reason: `响应无法确认（HTTP ${status || '未知'}）` };
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function toCompactDate(date) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  }

  function renderDayOptions() {
    if (!dom.fields?.dayExpr) return;
    const currentValue = state.form.dayExpr || '明天';
    const html = dayOptions()
      .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
    if (dom.fields.dayExpr.innerHTML !== html) dom.fields.dayExpr.innerHTML = html;
    dom.fields.dayExpr.value = currentValue;
  }

  function togglePanel(open) {
    state.panelOpen = open;
    render();
  }

  function readForm() {
    return {
      seatId: dom.fields.seatId.value.trim(),
      runAt: dom.fields.runAt.value.trim(),
      dayExpr: dom.fields.dayExpr.value.trim(),
      timeRange: dom.fields.timeRange.value.trim()
    };
  }

  function validateTask(form) {
    const seatId = normalizeSeatId(form.seatId);
    if (!seatId) return fail('请填写目标座位号');
    const runAt = normalizeRunAt(form.runAt);
    if (!runAt) return fail('请选择有效的执行日期和时间');
    const dayExpr = normalizeDayExpr(form.dayExpr);
    if (!dayExpr) return fail('请选择预约日期');
    const timeRange = normalizeTimeRange(form.timeRange);
    if (!timeRange) return fail('预约时间段格式应为 HH:mm-HH:mm，例如 08:00-22:30');
    return { ok: true, seatId, runAt, dayExpr, timeRange };
  }

  function fail(message) {
    return { ok: false, message };
  }

  function normalizeSeatId(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeRunAt(value) {
    const text = String(value || '').trim();
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(year, month - 1, day);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(match[4])}:${match[5]}:${match[6] || '00'}`;
    }

    match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return '';
    return `${toDateText(new Date())}T${pad2(match[1])}:${match[2]}:${match[3] || '00'}`;
  }

  function normalizeDayExpr(value) {
    const text = String(value || '').trim();
    return DAY_OPTION_DEFINITIONS.find(option => (
      option.value === text ||
      option.name === text
    ))?.value || '';
  }

  function normalizeTimeRange(value) {
    const match = String(value || '').trim().replace(/[~至到]/g, '-').match(/^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return '';
    const start = `${pad2(match[1])}:${match[2]}`;
    const end = `${pad2(match[3])}:${match[4]}`;
    if (timeToMinutes(start) >= timeToMinutes(end)) return '';
    return `${start}-${end}`;
  }

  function schedulerTick() {
    if (state.busy) return;
    const now = new Date();
    let changed = false;
    state.tasks.forEach(task => {
      if (task.running || task.completedAt || task.missedAt) return;
      const dueAt = scheduledDateTime(task.runAt);
      if (!dueAt) return;
      if (now.getTime() - dueAt.getTime() > RUN_GRACE_MS) {
        task.missedAt = now.toISOString();
        task.status = '已错过：超过 10 分钟宽限窗口';
        changed = true;
      }
    });
    if (changed) {
      saveTasks();
      render();
    }

    const dueTask = state.tasks.find(task => {
      if (task.running) return false;
      if (task.completedAt || task.missedAt) return false;
      const dueAt = scheduledDateTime(task.runAt);
      if (!dueAt) return false;
      const diff = now.getTime() - dueAt.getTime();
      return diff >= 0 && diff <= RUN_GRACE_MS;
    });
    if (!dueTask) return;
    runTask(dueTask);
  }

  function updateTaskCountdowns() {
    if (!dom.taskList) return;
    const now = new Date();
    const tasksById = new Map(state.tasks.map(task => [task.id, task]));
    dom.taskList.querySelectorAll('[data-lsh-countdown]').forEach(node => {
      const task = tasksById.get(node.getAttribute('data-lsh-countdown'));
      node.textContent = task ? taskCountdownText(task, now) : '';
    });
  }

  function taskCountdownText(task, now) {
    if (task.running) return '倒计时：正在执行';
    if (task.completedAt) return '倒计时：任务已执行';
    if (task.missedAt) return '倒计时：任务已错过';

    const runAt = scheduledDateTime(task.runAt);
    if (!runAt) return '倒计时：执行时间无效';

    const graceEndsAt = new Date(runAt.getTime() + RUN_GRACE_MS);
    if (now > graceEndsAt) {
      return '倒计时：已错过';
    }
    if (now >= runAt) {
      return '倒计时：已到时间，等待执行';
    }

    return `倒计时：距离执行 ${formatDuration(runAt.getTime() - now.getTime())}`;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days}天`);
    if (days || hours) parts.push(`${hours}小时`);
    if (days || hours || minutes) parts.push(`${minutes}分`);
    parts.push(`${seconds}秒`);
    return parts.join('');
  }

  async function runTask(task) {
    state.busy = true;
    task.running = true;
    task.status = '执行中：准备网络预约';
    saveTasks();
    render();

    try {
      const result = await reserveSeatByNetwork(task);
      task.completedAt = new Date().toISOString();
      task.lastRunOn = toDateText(new Date());
      task.status = result || `预约成功：${toDateText(new Date())} ${new Date().toLocaleTimeString()}`;
      notify('立信座位助手', task.status);
      toast(task.status);
    } catch (error) {
      task.completedAt = new Date().toISOString();
      task.lastRunOn = toDateText(new Date());
      task.status = `失败：${error.message || error}`;
      notify('立信座位助手', task.status);
      toast(task.status);
    } finally {
      task.running = false;
      state.busy = false;
      saveTasks();
      render();
    }
  }

  async function reserveSeatByNetwork(task) {
    const roomId = getTaskRoomId(task);
    if (!roomId) throw new Error('任务未记录房间，请在目标房间页面重新创建任务');

    const targetDate = task.targetDate || resolveTargetDate(task.dayExpr);
    const reserveDate = compactDateText(targetDate);
    const [startTime, endTime] = task.timeRange.split('-').map(toTimeWithSeconds);
    if (!startTime || !endTime) throw new Error('预约时间段无效');

    const userInfo = await requestApi(LOGIN_PROBE_FALLBACK_PATH);
    const user = userInfo.data || {};
    const accNo = user.accNo;
    if (!accNo) throw new Error('无法读取当前登录用户');

    task.status = `执行中：查询座位 ${task.seatId}`;
    saveTasks();
    render();

    const reserveInfo = await requestApi(`/ic-web/reserve?roomIds=${encodeURIComponent(roomId)}&resvDates=${reserveDate}&sysKind=8`, {
      token: user.token
    });
    const device = findReserveDevice(reserveInfo.data, task.seatId);
    if (!device) throw new Error(`房间 ${roomId} 未找到座位 ${task.seatId}`);

    task.status = `执行中：提交预约 ${task.seatId}`;
    saveTasks();
    render();

    const payload = {
      sysKind: 8,
      appAccNo: accNo,
      memberKind: 1,
      resvMember: [accNo],
      resvBeginTime: `${targetDate} ${startTime}`,
      resvEndTime: `${targetDate} ${endTime}`,
      testName: '',
      captcha: '',
      resvProperty: 0,
      resvDev: [device.devId],
      memo: DEFAULT_APPLY_NOTE
    };
    const result = await requestApi('/ic-web/reserve', {
      body: JSON.stringify(payload),
      method: 'POST',
      token: user.token
    });
    const message = result.message || '提交成功';
    return `预约成功：${task.seatId} ${targetDate} ${startTime.slice(0, 5)}-${endTime.slice(0, 5)}（${message}）`;
  }

  async function requestApi(url, options = {}) {
    const page = getPageWindow();
    const pageFetch = page?.fetch?.bind(page) || fetch;
    const headers = {
      accept: 'application/json, text/plain, */*',
      ...options.headers
    };
    if (options.method === 'POST' || options.body) {
      headers['content-type'] = 'application/json;charset=UTF-8';
    }
    if (options.token) {
      headers.token = options.token;
    }
    headers.lan = '1';

    let response;
    try {
      response = await pageFetch(url, {
        body: options.body,
        cache: 'no-store',
        credentials: 'include',
        headers,
        method: options.method || 'GET',
        redirect: 'manual'
      });
    } catch (error) {
      throw new Error(`网络请求失败：${error.message || error}`);
    }

    if (response.type === 'opaqueredirect' || response.status === 0) {
      throw new Error('登录可能已失效：请求被重定向到统一认证');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`登录可能已失效：接口发生重定向（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      throw new Error(`接口请求失败（HTTP ${response.status}）`);
    }

    const text = await response.text().catch(() => '');
    const data = parseJson(text);
    if (!data) throw new Error('接口返回不是 JSON');
    if (data.code !== undefined && data.code !== 0 && data.code !== '0') {
      throw new Error(data.message || data.msg || `接口返回错误：${data.code}`);
    }
    return data;
  }

  function getTaskRoomId(task) {
    return extractRoomId(task.routeHash) || getCurrentRoomId();
  }

  function extractRoomId(hash) {
    const match = String(hash || '').match(/\/ic\/seatPredetermine\/(\d+)/);
    return match ? match[1] : '';
  }

  function findReserveDevice(devices, seatId) {
    const normalizedSeatId = normalizeSeatId(seatId);
    return Array.isArray(devices)
      ? devices.find(device => normalizeSeatId(device.devName || device.name) === normalizedSeatId) || null
      : null;
  }

  function detectSeatStatus(seat) {
    const classes = Array.from(seat.classList);
    const key = classes.find(cls => STATUS_LABELS[cls]) || 'unknown';
    return { key, label: STATUS_LABELS[key] || classes.join(' ') || '未知' };
  }

  function resolveTargetDate(expr) {
    const option = dayOptionByValue(normalizeDayExpr(expr));
    if (!option) throw new Error(`无法识别预约日期：${expr}`);
    const target = addDays(startOfDay(new Date()), option.offset);
    return toDateText(target);
  }

  function dayOptions() {
    return DAY_OPTION_DEFINITIONS.map(option => {
      const date = addDays(new Date(), option.offset);
      return { value: option.value, label: `${option.name}（${date.getMonth() + 1}月${date.getDate()}日）` };
    });
  }

  function dayLabel(expr) {
    return dayOptions().find(option => option.value === expr)?.label || expr || '';
  }

  function formatTargetDateLabel(task) {
    return task.targetDate
      ? `预约：${task.targetDate}`
      : dayLabel(task.dayExpr);
  }

  function dayOptionByValue(value) {
    return DAY_OPTION_DEFINITIONS.find(option => option.value === value) || null;
  }

  function isValidDayExpr(value) {
    return Boolean(dayOptionByValue(value));
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function scheduledDateTime(runAt) {
    const parts = parseDateTimeText(normalizeRunAt(runAt));
    if (!parts) return null;
    return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  }

  function formatRunAtLabel(runAt) {
    const date = scheduledDateTime(runAt);
    if (!date) return '执行时间无效';
    return `执行：${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function defaultRunAt() {
    return `${toDateText(new Date())}T22:30:00`;
  }

  function compactDateText(dateText) {
    const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}${match[2]}${match[3]}` : '';
  }

  function normalizeDateText(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? toDateText(date)
      : '';
  }

  function toTimeWithSeconds(value) {
    const match = String(value || '').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    return match ? `${pad2(match[1])}:${match[2]}:00` : '';
  }

  function parseDateTimeText(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/);
    if (!match) return null;
    const parts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6])
    };
    const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    return date.getFullYear() === parts.year &&
      date.getMonth() === parts.month - 1 &&
      date.getDate() === parts.day &&
      date.getHours() === parts.hour &&
      date.getMinutes() === parts.minute &&
      date.getSeconds() === parts.second
      ? parts
      : null;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function toDateText(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function timeToMinutes(text) {
    const [h, m] = text.split(':').map(Number);
    return h * 60 + m;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function hasVisibleElement(selector) {
    return Array.from(document.querySelectorAll(selector)).some(visibleElement);
  }

  function visibleElement(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function textOf(element) {
    return (element && (element.innerText || element.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function getRoomName() {
    const h3 = document.querySelector('.ql-editor h3, h3');
    return textOf(h3).replace(/\([^)]*\)/g, '').trim();
  }

  function loadTasks() {
    try {
      const tasks = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (!Array.isArray(tasks)) return [];
      return tasks.map(task => ({
        ...task,
        runAt: task.runAt === '07:59:59' ? defaultRunAt() : (normalizeRunAt(task.runAt) || defaultRunAt()),
        dayExpr: isValidDayExpr(task.dayExpr) ? task.dayExpr : '明天',
        targetDate: normalizeDateText(task.targetDate) || resolveTargetDate(isValidDayExpr(task.dayExpr) ? task.dayExpr : '明天'),
        timeRange: normalizeTimeRange(task.timeRange) || '08:00-22:30',
        completedAt: task.completedAt || '',
        missedAt: task.missedAt || '',
        running: false,
        status: task.status || '等待执行'
      }));
    } catch {
      return [];
    }
  }

  function saveTasks() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.tasks));
  }

  function loadForm() {
    const fallback = {
      seatId: '',
      runAt: defaultRunAt(),
      dayExpr: '明天',
      timeRange: '08:00-22:30',
      routeHash: location.hash,
      roomName: ''
    };
    try {
      const saved = { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
      saved.runAt = saved.runAt === '07:59:59'
        ? defaultRunAt()
        : (normalizeRunAt(saved.runAt) || defaultRunAt());
      if (!isValidDayExpr(saved.dayExpr)) saved.dayExpr = '明天';
      saved.timeRange = normalizeTimeRange(saved.timeRange) || '08:00-22:30';
      return saved;
    } catch {
      return fallback;
    }
  }

  function saveForm() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.form));
  }

  function toast(message) {
    clearTimeout(state.toastTimer);
    let node = document.querySelector('.lsh-toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'lsh-toast';
      document.body.appendChild(node);
    }
    node.textContent = message;
    state.toastTimer = setTimeout(() => node.remove(), 4200);
  }

  function notify(title, text) {
    try {
      GM_notification({ title, text, timeout: 6000 });
    } catch {
      // Notification permission is optional.
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
