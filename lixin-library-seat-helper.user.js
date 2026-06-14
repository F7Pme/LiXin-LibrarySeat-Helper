// ==UserScript==
// @name         LiXin Library Seat Helper
// @namespace    https://kjyy.lixin.edu.cn/
// @version      3.0.0
// @description  上海立信会计金融学院 IC 空间座位预约辅助：点座位自动填号、定时预约、任务列表与取消。
// @author       顾佳俊
// @match        https://kjyy.lixin.edu.cn/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'lixin-seat-helper.tasks.v1';
  const SETTINGS_KEY = 'lixin-seat-helper.form.v1';
  const TICK_MS = 1000;
  const RUN_GRACE_MS = 10 * 60 * 1000;
  const LOGIN_CHECK_INTERVAL_MS = 10 * 1000;
  const RESERVATION_REFRESH_INTERVAL_MS = 30 * 1000;
  const RESERVATION_LOOKAHEAD_DAYS = 7;
  const RESERVATION_PAGE_SIZE = 20;
  const CONTINUOUS_REQUEST_INTERVAL_MS = 1000;
  const API_REQUEST_TIMEOUT_MS = 5 * 1000;
  const LOGIN_PROBE_FALLBACK_PATH = '/ic-web/auth/userInfo';
  const LOGIN_RESPONSE_PREVIEW_LIMIT = 3000;
  const DEFAULT_APPLY_NOTE = '';
  const DEFAULT_RUN_TIME = '22:30:00';
  const DEFAULT_TIME_RANGE = '08:00-22:30';
  const LEGACY_RUN_TIME = '07:59:59';
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
    loginCheck: {
      status: 'pending',
      message: '等待首次检测',
      nextAt: Date.now(),
      lastCheckedAt: 0,
      checking: false
    },
    reservations: {
      items: [],
      status: '等待刷新',
      nextAt: Date.now(),
      lastFetchedAt: 0,
      loading: false
    },
    toastTimer: 0
  };

  const dom = {};
  const activeRuns = new Map();

  boot();

  function boot() {
    injectStyle();
    createUi();
    bindSeatPicker();
    render();
    setInterval(appTick, TICK_MS);
    window.addEventListener('hashchange', () => {
      if (refreshCurrentRoomRecord()) saveForm();
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
      .lsh-field-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .lsh-check {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: #475569;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
      }
      .lsh-check input[type="checkbox"] {
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: #146c94;
      }
      .lsh-input-wrap {
        position: relative;
      }
      .lsh-input-wrap input {
        padding-right: var(--lsh-input-action-space, 10px);
      }
      .lsh-run-input {
        --lsh-input-action-space: 92px;
      }
      .lsh-range-input {
        --lsh-input-action-space: 92px;
      }
      .lsh-input-actions {
        position: absolute;
        top: 4px;
        right: 4px;
        bottom: 4px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .lsh-input-button {
        height: 26px;
        min-width: 38px;
        padding: 0 7px;
        border: 1px solid #cbd5e1;
        border-radius: 5px;
        background: #f8fafc;
        color: #146c94;
        cursor: pointer;
        font-size: 12px;
        line-height: 24px;
      }
      .lsh-input-button:hover {
        background: #f0f9ff;
        border-color: #7dd3fc;
      }
      .lsh-field input:not([type="checkbox"]),
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
      .lsh-field input:not([type="checkbox"]):focus,
      .lsh-field select:focus {
        border-color: #146c94;
        box-shadow: 0 0 0 3px rgba(20, 108, 148, .12);
      }
      .lsh-field input:not([type="checkbox"])[readonly] {
        color: #64748b;
        background: #f8fafc;
      }
      .lsh-target-room {
        grid-column: 1 / -1;
        margin-top: -2px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.45;
        word-break: break-word;
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
      .lsh-task-list,
      .lsh-reservation-list {
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
      .lsh-task,
      .lsh-reservation {
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
      .lsh-task-log {
        margin-top: 8px;
        border-top: 1px solid #e2e8f0;
        padding-top: 7px;
      }
      .lsh-task-log summary {
        color: #146c94;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
      }
      .lsh-task-log-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 6px;
      }
      .lsh-copy {
        height: 26px;
        border: 1px solid #bfdbfe;
        border-radius: 6px;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font-size: 12px;
      }
      .lsh-copy:hover {
        background: #dbeafe;
      }
      .lsh-task-log pre {
        max-height: 220px;
        overflow: auto;
        margin: 6px 0 0;
        padding: 8px;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        background: #f8fafc;
        color: #0f172a;
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
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
      .lsh-cancel:disabled {
        opacity: .55;
        cursor: not-allowed;
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
            <div class="lsh-target-room" data-lsh-target-room></div>
            <div class="lsh-field lsh-field-wide">
              <div class="lsh-field-head">
                <label>几点开始执行预约</label>
                <label class="lsh-check">
                  <input type="checkbox" data-lsh-field="continuousRequest">
                  <span>连续请求</span>
                </label>
              </div>
              <div class="lsh-input-wrap lsh-run-input">
                <input data-lsh-field="runAt" autocomplete="off" placeholder="YYYY-MM-DD HH:mm:ss">
                <div class="lsh-input-actions">
                  <button class="lsh-input-button" type="button" data-lsh-run-now>现在</button>
                  <button class="lsh-input-button" type="button" data-lsh-run-default>默认</button>
                </div>
              </div>
            </div>
            <div class="lsh-field lsh-field-wide">
              <label>预约哪一天</label>
              <select data-lsh-field="dayExpr"></select>
            </div>
            <div class="lsh-field lsh-field-wide">
              <label>预约时间段</label>
              <div class="lsh-input-wrap lsh-range-input">
                <input data-lsh-field="timeRange" autocomplete="off" placeholder="例如 ${DEFAULT_TIME_RANGE}">
                <div class="lsh-input-actions">
                  <button class="lsh-input-button" type="button" data-lsh-time-now>现在</button>
                  <button class="lsh-input-button" type="button" data-lsh-time-default>默认</button>
                </div>
              </div>
            </div>
          </div>
          <button class="lsh-primary" type="button">提交任务</button>
          <div class="lsh-help">左键点击座位圆点会打开本面板并自动填入座位号；任务会按记录的房间和设定时间发起网络预约。</div>
          <div class="lsh-section-title">
            <span>当前预约</span>
            <span data-lsh-reservation-count></span>
          </div>
          <div class="lsh-reservation-list"></div>
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
    dom.reservationList = root.querySelector('.lsh-reservation-list');
    dom.reservationCount = root.querySelector('[data-lsh-reservation-count]');
    dom.taskList = root.querySelector('.lsh-task-list');
    dom.count = root.querySelector('[data-lsh-count]');
    dom.loginStatus = root.querySelector('[data-lsh-login-status]');
    dom.loginLabel = root.querySelector('[data-lsh-login-label]');
    dom.loginDetail = root.querySelector('[data-lsh-login-detail]');
    dom.targetRoom = root.querySelector('[data-lsh-target-room]');
    dom.runNow = root.querySelector('[data-lsh-run-now]');
    dom.runDefault = root.querySelector('[data-lsh-run-default]');
    dom.timeNow = root.querySelector('[data-lsh-time-now]');
    dom.timeDefault = root.querySelector('[data-lsh-time-default]');
    dom.fields = {
      seatId: root.querySelector('[data-lsh-field="seatId"]'),
      runAt: root.querySelector('[data-lsh-field="runAt"]'),
      continuousRequest: root.querySelector('[data-lsh-field="continuousRequest"]'),
      dayExpr: root.querySelector('[data-lsh-field="dayExpr"]'),
      timeRange: root.querySelector('[data-lsh-field="timeRange"]')
    };

    dom.fab.addEventListener('click', () => togglePanel(true));
    dom.close.addEventListener('click', () => togglePanel(false));
    dom.submit.addEventListener('click', createTaskFromForm);
    dom.runNow.addEventListener('click', () => setFieldValue('runAt', formatDateTimeInput(new Date())));
    dom.runDefault.addEventListener('click', () => setFieldValue('runAt', formatRunAtInput(defaultRunAt())));
    dom.timeNow.addEventListener('click', () => setFieldValue('timeRange', timeRangeWithCurrentStart()));
    dom.timeDefault.addEventListener('click', () => setFieldValue('timeRange', DEFAULT_TIME_RANGE));
    Object.values(dom.fields).forEach(field => {
      field.addEventListener('input', () => syncFieldToForm(field));
      field.addEventListener('change', () => syncFieldToForm(field));
    });
    dom.reservationList.addEventListener('click', event => {
      const button = event.target.closest('[data-lsh-cancel-reservation]');
      if (!button) return;
      cancelReservation(button.getAttribute('data-lsh-cancel-reservation'));
    });
    dom.taskList.addEventListener('click', event => {
      const copyButton = event.target.closest('[data-lsh-copy-log]');
      if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        copyTaskResponseLogs(copyButton.getAttribute('data-lsh-copy-log'));
        return;
      }

      const button = event.target.closest('[data-lsh-cancel]');
      if (!button) return;
      const id = button.getAttribute('data-lsh-cancel');
      const stopped = cancelTaskRun(id);
      state.tasks = state.tasks.filter(task => task.id !== id);
      saveTasks();
      render();
      toast(stopped ? '已停止并取消任务' : '已取消任务');
    });
  }

  function syncFieldToForm(field) {
    state.form[field.dataset.lshField] = readFieldValue(field);
    refreshCurrentRoomRecord();
    saveForm();
  }

  function readFieldValue(field) {
    return field.type === 'checkbox' ? field.checked : field.value;
  }

  function setFieldValue(key, value) {
    const field = dom.fields[key];
    if (!field) return;
    field.value = value;
    syncFieldToForm(field);
    render();
  }

  function timeRangeWithCurrentStart() {
    const current = normalizeTimeRange(dom.fields.timeRange.value);
    const end = current ? current.split('-')[1] : DEFAULT_TIME_RANGE.split('-')[1];
    return `${formatTimeInput(new Date())}-${end}`;
  }

  function refreshCurrentRoomRecord() {
    return saveRoomSnapshot(getCurrentRoomSnapshot());
  }

  function getCurrentRoomSnapshot() {
    const roomId = getCurrentRoomId();
    if (!roomId) return null;
    const roomName = getRoomName() || (state.form.routeHash === location.hash ? state.form.roomName : '');
    return { roomId, routeHash: location.hash, roomName };
  }

  function getFormRoomSnapshot() {
    const roomId = extractRoomId(state.form.routeHash);
    return roomId
      ? { roomId, routeHash: state.form.routeHash, roomName: state.form.roomName || '' }
      : null;
  }

  function getPreferredRoomSnapshot() {
    return getCurrentRoomSnapshot() || getFormRoomSnapshot();
  }

  function saveRoomSnapshot(snapshot) {
    if (!snapshot) return false;
    const isSameRoute = state.form.routeHash === snapshot.routeHash;
    const nextRoomName = snapshot.roomName || (isSameRoute ? state.form.roomName : '');
    const changed = state.form.routeHash !== snapshot.routeHash ||
      state.form.roomName !== nextRoomName;
    state.form.routeHash = snapshot.routeHash;
    state.form.roomName = nextRoomName;
    return changed;
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
    refreshCurrentRoomRecord();
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

    const room = getPreferredRoomSnapshot();
    if (!room) {
      toast('请先在目标座位预约房间页面创建任务或点选座位');
      return;
    }
    const task = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seatId: parsed.seatId,
      runAt: parsed.runAt,
      continuousRequest: parsed.continuousRequest,
      dayExpr: parsed.dayExpr,
      targetDate: resolveTargetDate(parsed.dayExpr),
      timeRange: parsed.timeRange,
      routeHash: room.routeHash,
      roomName: room.roomName,
      createdAt: new Date().toISOString(),
      lastRunOn: '',
      completedAt: '',
      missedAt: '',
      running: false,
      responseLogs: [],
      responseCount: 0,
      sentCount: 0,
      status: '等待执行'
    };
    state.tasks.push(task);
    state.form = {
      ...state.form,
      seatId: parsed.seatId,
      runAt: parsed.runAt,
      continuousRequest: parsed.continuousRequest,
      dayExpr: parsed.dayExpr,
      timeRange: parsed.timeRange,
      routeHash: task.routeHash,
      roomName: task.roomName
    };
    saveForm();
    saveTasks();
    render();
    toast('任务已创建');
  }

  function render() {
    if (!dom.panel) return;
    if (refreshCurrentRoomRecord()) saveForm();
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
    dom.targetRoom.textContent = targetRoomLabel();
    renderLoginCheck();
    renderReservations();

    for (const [key, input] of Object.entries(dom.fields)) {
      if (input.type === 'checkbox') {
        input.checked = Boolean(state.form[key]);
      } else if (document.activeElement !== input) {
        input.value = fieldDisplayValue(key, state.form[key]);
      }
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
              <div class="lsh-task-meta">${escapeHtml(formatRunAtLabel(task.runAt))} / ${escapeHtml(formatTargetDateLabel(task))} / ${escapeHtml(task.timeRange || DEFAULT_TIME_RANGE)} / ${escapeHtml(continuousRequestLabel(task))}</div>
              <div class="lsh-task-meta">${escapeHtml(task.roomName || task.routeHash || '当前座位页')}</div>
            </div>
            <button class="lsh-cancel" type="button" data-lsh-cancel="${escapeHtml(task.id)}">${task.running ? '停止' : '取消'}</button>
          </div>
          <div class="lsh-task-status">${escapeHtml(task.status || '等待执行')}</div>
          <div class="lsh-task-countdown" data-lsh-countdown="${escapeHtml(task.id)}"></div>
          ${renderTaskResponseLogs(task)}
        </div>
      `)
      .join('');
    updateTaskCountdowns();
  }

  function renderTaskResponseLogs(task) {
    const logs = Array.isArray(task.responseLogs) ? task.responseLogs : [];
    if (!logs.length) return '';
    return `
      <details class="lsh-task-log" open>
        <summary>完整响应日志（${logs.length}）</summary>
        <div class="lsh-task-log-actions">
          <button class="lsh-copy" type="button" data-lsh-copy-log="${escapeHtml(task.id)}">复制</button>
        </div>
        <pre>${escapeHtml(taskResponseLogText(task))}</pre>
      </details>
    `;
  }

  function taskResponseLogText(task) {
    const logs = Array.isArray(task.responseLogs) ? task.responseLogs : [];
    return [
      `任务：${task.seatId || ''}`,
      formatRunAtLabel(task.runAt),
      formatTargetDateLabel(task),
      `时间段：${task.timeRange || DEFAULT_TIME_RANGE}`,
      `房间：${task.roomName || task.routeHash || '当前座位页'}`,
      `状态：${task.status || '等待执行'}`,
      '',
      logs.map(formatTaskResponseLog).join('\n\n')
    ].filter(part => part !== '').join('\n');
  }

  function formatTaskResponseLog(log) {
    const at = log.at ? formatClock(new Date(log.at)) : '--:--:--';
    const title = `#${log.attempt || '?'} ${log.ok ? '成功' : '失败'} ${at}`;
    return [
      title,
      log.message ? `消息：${log.message}` : '',
      log.response ? `响应：${log.response}` : '',
      log.error ? `错误：${log.error}` : ''
    ].filter(Boolean).join('\n');
  }

  async function copyTaskResponseLogs(taskId) {
    const task = state.tasks.find(item => item.id === taskId);
    if (!task || !Array.isArray(task.responseLogs) || !task.responseLogs.length) {
      toast('暂无可复制的响应日志');
      return;
    }

    try {
      await writeClipboardText(taskResponseLogText(task));
      toast('完整响应日志已复制');
    } catch (error) {
      toast(`复制失败：${error.message || error}`);
    }
  }

  async function writeClipboardText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }

    const page = getPageWindow();
    const clipboard = page?.navigator?.clipboard || navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
    await clipboard.writeText(text);
  }

  function fieldDisplayValue(key, value) {
    return key === 'runAt'
      ? formatRunAtInput(value)
      : (value || '');
  }

  function targetRoomLabel() {
    const roomId = extractRoomId(state.form.routeHash);
    const room = state.form.roomName || '';
    if (roomId && room) return `目标房间：${room} (${state.form.routeHash})`;
    if (roomId) return `目标房间：${state.form.routeHash}`;
    return '目标房间：未记录，请先进入目标房间页或左键点选座位';
  }

  function renderReservations() {
    if (!dom.reservationList) return;
    const items = state.reservations.items;
    updateReservationSummary();

    if (!items.length) {
      dom.reservationList.innerHTML = `<div class="lsh-empty">${escapeHtml(reservationEmptyText())}</div>`;
      return;
    }

    dom.reservationList.innerHTML = items
      .map(item => {
        const uuid = reservationUuid(item);
        const seat = reservationSeatLabel(item);
        const room = reservationRoomLabel(item);
        const time = reservationTimeLabel(item);
        const status = reservationStatusLabel(item);
        const cancelDisabled = state.reservations.loading || !uuid;
        return `
          <div class="lsh-reservation">
            <div class="lsh-task-top">
              <div>
                <div class="lsh-task-seat">${escapeHtml(seat || '未知座位')}</div>
                <div class="lsh-task-meta">${escapeHtml(room || '未知房间')}</div>
                <div class="lsh-task-meta">${escapeHtml(time || '未知时间')}</div>
              </div>
              <button class="lsh-cancel" type="button" data-lsh-cancel-reservation="${escapeHtml(uuid)}" ${cancelDisabled ? 'disabled' : ''}>取消预约</button>
            </div>
            <div class="lsh-task-status">${escapeHtml(status)}</div>
          </div>
        `;
      })
      .join('');
  }

  function updateReservationSummary() {
    if (!dom.reservationCount) return;
    const now = new Date();
    const clock = formatClock(now);
    const count = state.reservations.items.length;
    const loadingText = state.reservations.loading ? ' · 刷新中' : '';
    const nextRefreshText = state.reservations.loading
      ? '正在刷新'
      : `下次刷新：${Math.max(0, Math.ceil((state.reservations.nextAt - now.getTime()) / 1000))} 秒后`;
    const lastRefreshText = state.reservations.lastFetchedAt
      ? formatClock(new Date(state.reservations.lastFetchedAt))
      : '尚未刷新';

    dom.reservationCount.textContent = `${count} · ${clock}${loadingText}`;
    dom.reservationCount.title = `当前时间：${clock}；上次刷新：${lastRefreshText}；${nextRefreshText}`;
  }

  function reservationEmptyText() {
    if (state.reservations.loading) return '正在刷新当前预约';
    if (/失败/.test(state.reservations.status)) return state.reservations.status;
    return '暂无当前预约';
  }

  function reservationTick() {
    if (!state.panelOpen || state.reservations.loading) return;
    if (Date.now() >= state.reservations.nextAt) refreshReservations();
  }

  async function refreshReservations(force = false) {
    if (state.reservations.loading) return;
    if (!force && Date.now() < state.reservations.nextAt) return;

    state.reservations.loading = true;
    state.reservations.status = '正在刷新当前预约';
    renderReservations();

    try {
      const user = await getCurrentUser();
      const params = reservationListParams();
      const result = await requestApi(`/ic-web/reserve/resvInfo?${params.toString()}`, {
        token: user.token
      });
      state.reservations.items = extractReservationRows(result.data);
      state.reservations.lastFetchedAt = Date.now();
      state.reservations.status = '刷新成功';
    } catch (error) {
      state.reservations.status = `刷新失败：${error.message || error}`;
    } finally {
      state.reservations.loading = false;
      state.reservations.nextAt = Date.now() + RESERVATION_REFRESH_INTERVAL_MS;
      renderReservations();
    }
  }

  async function cancelReservation(uuid) {
    const targetUuid = String(uuid || '').trim();
    if (!targetUuid) {
      toast('当前预约缺少取消标识，无法取消');
      return;
    }
    if (state.reservations.loading) {
      toast('当前预约列表正在刷新，请稍后再试');
      return;
    }

    const item = state.reservations.items.find(row => reservationUuid(row) === targetUuid);
    const label = item ? reservationSeatLabel(item) : '该预约';
    if (!window.confirm(`确定取消预约 ${label} 吗？`)) return;

    let shouldRefresh = false;
    state.reservations.loading = true;
    state.reservations.status = '正在取消预约';
    renderReservations();

    try {
      const user = await getCurrentUser();
      const result = await requestApi('/ic-web/reserve/delete', {
        body: JSON.stringify({ uuid: targetUuid }),
        method: 'POST',
        token: user.token
      });
      shouldRefresh = true;
      toast(result.message || '预约已取消');
    } catch (error) {
      state.reservations.status = `取消失败：${error.message || error}`;
      toast(state.reservations.status);
    } finally {
      state.reservations.loading = false;
      state.reservations.nextAt = shouldRefresh ? 0 : Date.now() + RESERVATION_REFRESH_INTERVAL_MS;
      renderReservations();
    }

    if (shouldRefresh) refreshReservations(true);
  }

  function reservationListParams() {
    const begin = startOfDay(new Date());
    const end = addDays(begin, RESERVATION_LOOKAHEAD_DAYS);
    return new URLSearchParams({
      beginDate: toDateText(begin),
      endDate: toDateText(end),
      needStatus: '6',
      page: '1',
      pageNum: String(RESERVATION_PAGE_SIZE),
      orderKey: 'gmt_create',
      orderModel: 'desc'
    });
  }

  function extractReservationRows(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.list)) return data.list;
    if (Array.isArray(data?.records)) return data.records;
    if (Array.isArray(data?.rows)) return data.rows;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  function reservationUuid(item) {
    return String(
      item?.uuid ||
      item?.resvUuid ||
      item?.reserveUuid ||
      item?.resvDevInfoList?.[0]?.uuid ||
      ''
    ).trim();
  }

  function reservationDeviceInfo(item) {
    if (Array.isArray(item?.resvDevInfoList) && item.resvDevInfoList.length) return item.resvDevInfoList[0] || {};
    if (Array.isArray(item?.resvDevs) && item.resvDevs.length) return item.resvDevs[0] || {};
    return {};
  }

  function reservationSeatLabel(item) {
    const device = reservationDeviceInfo(item);
    return device.devName || item?.devName || item?.resvDevName || item?.seatName || item?.resvId || '';
  }

  function reservationRoomLabel(item) {
    const device = reservationDeviceInfo(item);
    return device.roomName || item?.roomName || item?.resvRoomName || '';
  }

  function reservationStatusLabel(item) {
    return String(item?.resvStatusName || item?.statusName || item?.resvStatusDesc || item?.statusDesc || '可取消预约');
  }

  function reservationTimeLabel(item) {
    return joinReservationTime(item?.resvBeginTime || item?.beginTime, item?.resvEndTime || item?.endTime);
  }

  function joinReservationTime(beginValue, endValue) {
    const begin = formatReservationDateTime(beginValue);
    const end = formatReservationDateTime(endValue);
    if (begin && end && begin.slice(0, 10) === end.slice(0, 10)) {
      return `${begin} - ${end.slice(11)}`;
    }
    if (begin && end) return `${begin} - ${end}`;
    return begin || end || '';
  }

  function formatReservationDateTime(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
      const number = Number(value);
      const date = new Date(number < 100000000000 ? number * 1000 : number);
      if (!Number.isNaN(date.getTime())) {
        return `${toDateText(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      }
    }
    const text = String(value).trim().replace('T', ' ');
    return /^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/.test(text)
      ? text.slice(0, 16)
      : text;
  }

  function appTick() {
    schedulerTick();
    loginCheckTick();
    reservationTick();
    updateReservationSummary();
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
    const page = getPageWindow();
    const pageFetch = page?.fetch?.bind(page) || fetch;
    const Controller = page?.AbortController || AbortController;
    const controller = new Controller();
    const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
    try {
      const response = await pageFetch(probe.url, {
        cache: 'no-store',
        credentials: 'include',
        redirect: 'manual',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-lixin-seat-helper-probe': '1'
        },
        method: 'GET',
        signal: controller.signal
      });
      let responseText = '';
      if (response.type !== 'opaqueredirect') {
        try {
          responseText = await response.clone().text();
        } catch (error) {
          if (error?.name === 'AbortError') {
            return { status: 'failed', message: `网络检测请求超时：${Math.round(API_REQUEST_TIMEOUT_MS / 1000)} 秒内未收到完整响应` };
          }
          responseText = '';
        }
      }
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
      if (error?.name === 'AbortError') {
        return { status: 'failed', message: `网络检测请求超时：${Math.round(API_REQUEST_TIMEOUT_MS / 1000)} 秒内未收到响应` };
      }
      return { status: 'failed', message: `网络检测请求失败：${error.message || error}` };
    } finally {
      clearTimeout(timeoutId);
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
    if (open) refreshReservations(true);
  }

  function readForm() {
    return {
      seatId: dom.fields.seatId.value.trim(),
      runAt: dom.fields.runAt.value.trim(),
      continuousRequest: dom.fields.continuousRequest.checked,
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
    if (!timeRange) return fail(`预约时间段格式应为 HH:mm-HH:mm，例如 ${DEFAULT_TIME_RANGE}`);
    return { ok: true, seatId, runAt, dayExpr, timeRange, continuousRequest: Boolean(form.continuousRequest) };
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

  function createTaskRunControl(task) {
    const control = {
      cancelled: false,
      controllers: new Set(),
      finished: false,
      id: task.id
    };
    activeRuns.set(task.id, control);
    return control;
  }

  function cancelTaskRun(id) {
    const control = activeRuns.get(id);
    if (!control) return false;
    control.cancelled = true;
    abortTaskRunRequests(control);
    return true;
  }

  function finishTaskRun(control) {
    if (!control) return;
    control.finished = true;
    abortTaskRunRequests(control);
  }

  function abortTaskRunRequests(control) {
    if (!control) return;
    control.controllers.forEach(controller => {
      try {
        controller.abort();
      } catch {
        // Request may already be settled.
      }
    });
    control.controllers.clear();
  }

  function isRunStopped(control) {
    return Boolean(control?.cancelled || control?.finished);
  }

  function throwIfRunCancelled(control) {
    if (control?.cancelled) throw createCancelError();
  }

  function createCancelError() {
    const error = new Error('任务已取消');
    error.cancelled = true;
    return error;
  }

  function isCancelError(error) {
    return Boolean(error?.cancelled);
  }

  function schedulerTick() {
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

    const dueTasks = state.tasks.filter(task => {
      if (task.running) return false;
      if (task.completedAt || task.missedAt) return false;
      const dueAt = scheduledDateTime(task.runAt);
      if (!dueAt) return false;
      const diff = now.getTime() - dueAt.getTime();
      return diff >= 0 && diff <= RUN_GRACE_MS;
    });
    dueTasks.forEach(runTask);
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
    const control = createTaskRunControl(task);
    task.running = true;
    task.responseLogs = [];
    task.responseCount = 0;
    task.sentCount = 0;
    task.status = '执行中：准备网络预约';
    saveTasks();
    render();

    try {
      const result = await runReservationAttempts(task, control);
      if (control.cancelled) return;
      task.completedAt = new Date().toISOString();
      task.lastRunOn = toDateText(new Date());
      task.status = result || `预约成功：${toDateText(new Date())} ${new Date().toLocaleTimeString()}`;
      state.reservations.nextAt = 0;
      notify('立信座位助手', task.status);
      toast(task.status);
    } catch (error) {
      if (isCancelError(error) || control.cancelled) return;
      task.completedAt = new Date().toISOString();
      task.lastRunOn = toDateText(new Date());
      task.status = `失败：${error.message || error}`;
      notify('立信座位助手', task.status);
      toast(task.status);
    } finally {
      task.running = false;
      activeRuns.delete(task.id);
      if (state.tasks.includes(task)) {
        saveTasks();
        render();
      }
    }
  }

  async function runReservationAttempts(task, control) {
    const dueAt = scheduledDateTime(task.runAt) || new Date();
    const prepared = await prepareReserveRequest(task, control);

    if (task.continuousRequest === false) {
      const result = await submitReservationAttempt(prepared, task, 1, control);
      if (result.ok) return formatReservationSuccess(prepared, result.result);
      if (result.terminal) throw new Error(result.message || '预约失败，已停止继续请求');
      throw new Error(result.message || '预约请求失败');
    }

    const inFlight = new Set();
    let attempt = 0;
    let success = null;
    let terminalFailure = null;

    while (!isRunStopped(control) && !success && !terminalFailure) {
      attempt += 1;
      const targetAt = dueAt.getTime() + (attempt - 1) * CONTINUOUS_REQUEST_INTERVAL_MS;
      const waitMs = targetAt - Date.now();
      if (waitMs > 0) {
        task.status = `连续请求：等待发送第 ${attempt} 次`;
        saveTasks();
        render();
        await delay(waitMs);
      }
      throwIfRunCancelled(control);
      if (control.finished) break;

      task.sentCount = attempt;
      task.status = `连续请求：已发送第 ${attempt} 次，成功前每秒继续`;
      saveTasks();
      render();

      const submission = submitReservationAttempt(prepared, task, attempt, control)
        .then(result => {
          inFlight.delete(submission);
          if (result.ok && !isRunStopped(control)) {
            success = result;
            finishTaskRun(control);
          } else if (result.terminal && !isRunStopped(control)) {
            terminalFailure = result;
            finishTaskRun(control);
          }
          return result;
        })
        .catch(error => {
          inFlight.delete(submission);
          if (!isCancelError(error)) throw error;
          return { cancelled: true };
        });
      inFlight.add(submission);
    }

    while (!success && !terminalFailure && inFlight.size && !control.cancelled) {
      const settled = await Promise.race(Array.from(inFlight));
      if (settled?.ok) success = settled;
      if (settled?.terminal) terminalFailure = settled;
    }

    if (success) {
      finishTaskRun(control);
      return `${formatReservationSuccess(prepared, success.result)}；连续请求第 ${success.attempt} 次成功，共发出 ${task.sentCount || success.attempt} 次`;
    }

    if (terminalFailure) {
      throw new Error(terminalFailure.message || '预约失败，已停止继续请求');
    }

    throwIfRunCancelled(control);
    throw new Error('连续请求已停止但未收到成功响应');
  }

  async function submitReservationAttempt(prepared, task, attempt, control) {
    const mode = task.continuousRequest === false ? '单次请求' : '连续请求';
    try {
      const result = await submitPreparedReservation(prepared, control);
      appendTaskResponseLog(task, {
        attempt,
        ok: true,
        message: result.message || '提交成功',
        response: result.raw
      });
      task.responseCount = (task.responseCount || 0) + 1;
      task.status = `${mode}：第 ${attempt} 次成功，已收到 ${task.responseCount} 个响应`;
      saveTasks();
      render();
      return { attempt, ok: true, result };
    } catch (error) {
      if (isCancelError(error) || isRunStopped(control)) throw createCancelError();
      const verified = await verifyExistingReservationAfterFailure(prepared, task, attempt, control, error);
      if (verified) return verified;
      const detail = apiErrorDetail(error);
      const terminalMessage = terminalReservationFailureMessage(error);
      appendTaskResponseLog(task, {
        attempt,
        ok: false,
        message: error.message || String(error),
        response: detail
      });
      task.responseCount = (task.responseCount || 0) + 1;
      task.status = terminalMessage
        ? `${mode}：${terminalMessage}，已停止继续请求`
        : `${mode}：已发送 ${task.sentCount || attempt} 次，收到 ${task.responseCount} 个响应，最近第 ${attempt} 次失败：${error.message || error}`;
      saveTasks();
      render();
      return {
        attempt,
        message: terminalMessage || error.message || String(error),
        ok: false,
        terminal: Boolean(terminalMessage)
      };
    }
  }

  async function verifyExistingReservationAfterFailure(prepared, task, attempt, control, error) {
    if (!shouldVerifyExistingReservation(error)) return null;

    let result;
    try {
      result = await requestApi(`/ic-web/reserve/resvInfo?${targetReservationListParams(prepared).toString()}`, {
        control,
        token: prepared.token
      });
    } catch (verifyError) {
      if (isCancelError(verifyError) || isRunStopped(control)) throw createCancelError();
      return null;
    }

    const rows = extractReservationRows(result.data);
    const matched = rows.find(row => reservationMatchesPrepared(row, prepared));
    if (!matched) return null;

    appendTaskResponseLog(task, {
      attempt,
      ok: true,
      message: '提交返回已有预约，已反查确认目标预约存在',
      response: {
        failedSubmit: apiErrorDetail(error),
        matchedReservation: matched,
        verification: result
      }
    });
    task.responseCount = (task.responseCount || 0) + 1;
    task.status = `${task.continuousRequest === false ? '单次请求' : '连续请求'}：第 ${attempt} 次确认目标预约已存在，停止继续请求`;
    saveTasks();
    render();
    return {
      attempt,
      ok: true,
      result: {
        data: matched,
        message: '已确认目标预约存在'
      }
    };
  }

  function shouldVerifyExistingReservation(error) {
    const message = String(error?.message || error?.apiResponse?.message || error?.apiResponse?.msg || '');
    return /当前时段有预约|已有预约|已存在预约/.test(message);
  }

  function terminalReservationFailureMessage(error) {
    const message = String(error?.message || error?.apiResponse?.message || error?.apiResponse?.msg || '');
    if (!message) return '';
    if (/正在被预约|请稍后重试/.test(message)) return '';
    if (/设备在该时间段内已被预约|设备在该时段内已被预约|当前设备已被预约|目标设备已被预约|设备已被预约/.test(message)) {
      return '目标座位该时间段已被预约';
    }
    if (/当前时段有预约|已有预约|已存在预约/.test(message)) {
      return '当前账号在该时段已有其他预约';
    }
    return '';
  }

  function targetReservationListParams(prepared) {
    return new URLSearchParams({
      beginDate: prepared.targetDate,
      endDate: prepared.targetDate,
      needStatus: '6',
      page: '1',
      pageNum: String(RESERVATION_PAGE_SIZE),
      orderKey: 'gmt_create',
      orderModel: 'desc'
    });
  }

  function reservationMatchesPrepared(row, prepared) {
    const device = reservationDeviceInfo(row);
    const rowDevId = Number(device.devId || row?.devId || row?.resvDevId || 0);
    const targetDevId = Number(prepared.payload?.resvDev?.[0] || 0);
    const seatMatches = normalizeSeatId(reservationSeatLabel(row)) === normalizeSeatId(prepared.seatId);
    const deviceMatches = targetDevId > 0 && rowDevId === targetDevId;
    if (!seatMatches && !deviceMatches) return false;

    const begin = formatReservationDateTime(row?.resvBeginTime || row?.beginTime);
    const end = formatReservationDateTime(row?.resvEndTime || row?.endTime);
    const expectedBegin = `${prepared.targetDate} ${prepared.startTime.slice(0, 5)}`;
    const expectedEnd = `${prepared.targetDate} ${prepared.endTime.slice(0, 5)}`;
    return begin === expectedBegin && end === expectedEnd;
  }

  async function prepareReserveRequest(task, control) {
    const roomId = getTaskRoomId(task);
    if (!roomId) throw new Error('任务未记录房间，请在目标房间页面重新创建任务');

    const targetDate = task.targetDate || resolveTargetDate(task.dayExpr);
    const reserveDate = compactDateText(targetDate);
    const [startTime, endTime] = task.timeRange.split('-').map(toTimeWithSeconds);
    if (!startTime || !endTime) throw new Error('预约时间段无效');

    const user = await getCurrentUser(control);
    const accNo = user.accNo;

    task.status = `准备中：查询座位 ${task.seatId}`;
    saveTasks();
    render();

    const reserveInfo = await requestApi(`/ic-web/reserve?roomIds=${encodeURIComponent(roomId)}&resvDates=${reserveDate}&sysKind=8`, {
      control,
      token: user.token
    });
    const device = findReserveDevice(reserveInfo.data, task.seatId);
    if (!device) throw new Error(`房间 ${roomId} 未找到座位 ${task.seatId}`);

    task.status = `准备完成：等待提交 ${task.seatId}`;
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
    return {
      endTime,
      payload,
      roomId,
      seatId: task.seatId,
      startTime,
      targetDate,
      token: user.token
    };
  }

  async function submitPreparedReservation(prepared, control) {
    const result = await requestApi('/ic-web/reserve', {
      body: JSON.stringify(prepared.payload),
      control,
      method: 'POST',
      token: prepared.token
    });
    return {
      data: result.data || null,
      message: result.message || '提交成功',
      raw: result
    };
  }

  function formatReservationSuccess(prepared, result) {
    return `预约成功：${prepared.seatId} ${prepared.targetDate} ${prepared.startTime.slice(0, 5)}-${prepared.endTime.slice(0, 5)}（${result.message}）`;
  }

  function appendTaskResponseLog(task, entry) {
    if (!Array.isArray(task.responseLogs)) task.responseLogs = [];
    task.responseLogs.push({
      attempt: entry.attempt,
      at: new Date().toISOString(),
      error: entry.error || '',
      message: entry.message || '',
      ok: Boolean(entry.ok),
      response: stringifyLogValue(entry.response)
    });
  }

  function apiErrorDetail(error) {
    return {
      message: error.message || String(error),
      method: error.method || '',
      status: error.httpStatus || '',
      url: error.url || '',
      response: error.apiResponse ?? null,
      responseText: error.responseText || ''
    };
  }

  function createApiError(message, detail = {}) {
    const error = new Error(message);
    Object.assign(error, detail);
    return error;
  }

  function stringifyLogValue(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  async function getCurrentUser(control) {
    const userInfo = await requestApi(LOGIN_PROBE_FALLBACK_PATH, { control });
    const user = userInfo.data || {};
    if (!user.accNo) throw new Error('无法读取当前登录用户');
    return user;
  }

  async function requestApi(url, options = {}) {
    const page = getPageWindow();
    const pageFetch = page?.fetch?.bind(page) || fetch;
    const Controller = page?.AbortController || AbortController;
    const controller = new Controller();
    const control = options.control;
    if (isRunStopped(control)) throw createCancelError();
    if (control?.controllers) control.controllers.add(controller);
    const timeoutMs = options.timeoutMs ?? API_REQUEST_TIMEOUT_MS;
    const timeoutId = timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : 0;
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
      try {
        response = await pageFetch(url, {
          body: options.body,
          cache: 'no-store',
          credentials: 'include',
          headers,
          method: options.method || 'GET',
          redirect: 'manual',
          signal: controller.signal
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (isRunStopped(control)) throw createCancelError();
          throw createApiError(`网络请求超时：${Math.round(timeoutMs / 1000)} 秒内未收到响应`, { url, method: options.method || 'GET' });
        }
        throw createApiError(`网络请求失败：${error.message || error}`, { url, method: options.method || 'GET' });
      }

      let text = '';
      try {
        text = await response.text();
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (isRunStopped(control)) throw createCancelError();
          throw createApiError(`网络请求超时：${Math.round(timeoutMs / 1000)} 秒内未收到完整响应`, {
            httpStatus: response.status,
            url: response.url || url,
            method: options.method || 'GET'
          });
        }
        throw createApiError(`读取响应失败：${error.message || error}`, {
          httpStatus: response.status,
          url: response.url || url,
          method: options.method || 'GET'
        });
      }
      const data = parseJson(text);

      if (response.type === 'opaqueredirect' || response.status === 0) {
        throw createApiError('登录可能已失效：请求被重定向到统一认证', {
          responseText: text,
          httpStatus: response.status,
          url: response.url || url,
          method: options.method || 'GET'
        });
      }
      if (response.status >= 300 && response.status < 400) {
        throw createApiError(`登录可能已失效：接口发生重定向（HTTP ${response.status}）`, {
          responseText: text,
          httpStatus: response.status,
          url: response.url || url,
          method: options.method || 'GET'
        });
      }
      if (!response.ok) {
        throw createApiError(`接口请求失败（HTTP ${response.status}）`, {
          apiResponse: data,
          responseText: text,
          httpStatus: response.status,
          url: response.url || url,
          method: options.method || 'GET'
        });
      }
      if (!data) {
        throw createApiError('接口返回不是 JSON', {
          responseText: text,
          httpStatus: response.status,
          url: response.url || url,
          method: options.method || 'GET'
        });
      }
      if (data.code !== undefined && data.code !== 0 && data.code !== '0') {
        throw createApiError(data.message || data.msg || `接口返回错误：${data.code}`, {
          apiResponse: data,
          responseText: text,
          httpStatus: response.status,
          url: response.url || url,
          method: options.method || 'GET'
        });
      }
      return data;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (control?.controllers) control.controllers.delete(controller);
    }
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

  function continuousRequestLabel(task) {
    return task.continuousRequest === false ? '单次请求' : '连续请求';
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
    return `执行：${formatDateTimeInput(date)}`;
  }

  function formatRunAtInput(value) {
    const date = scheduledDateTime(value);
    return date ? formatDateTimeInput(date) : (value || '');
  }

  function formatDateTimeInput(date) {
    return `${toDateText(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatClock(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatTimeInput(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function defaultRunAt() {
    return `${toDateText(new Date())}T${DEFAULT_RUN_TIME}`;
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
        runAt: task.runAt === LEGACY_RUN_TIME ? defaultRunAt() : (normalizeRunAt(task.runAt) || defaultRunAt()),
        continuousRequest: task.continuousRequest !== false,
        dayExpr: isValidDayExpr(task.dayExpr) ? task.dayExpr : '明天',
        targetDate: normalizeDateText(task.targetDate) || resolveTargetDate(isValidDayExpr(task.dayExpr) ? task.dayExpr : '明天'),
        timeRange: normalizeTimeRange(task.timeRange) || DEFAULT_TIME_RANGE,
        completedAt: task.completedAt || '',
        missedAt: task.missedAt || '',
        responseLogs: Array.isArray(task.responseLogs) ? task.responseLogs : [],
        responseCount: Number(task.responseCount) || 0,
        sentCount: Number(task.sentCount) || 0,
        running: false,
        status: task.status || '等待执行'
      }));
    } catch {
      return [];
    }
  }

  function saveTasks() {
    const persistedTasks = state.tasks.map(task => {
      const { responseLogs, ...persistedTask } = task;
      return persistedTask;
    });
    localStorage.setItem(STORE_KEY, JSON.stringify(persistedTasks));
  }

  function loadForm() {
    const fallback = {
      seatId: '',
      runAt: defaultRunAt(),
      continuousRequest: true,
      dayExpr: '明天',
      timeRange: DEFAULT_TIME_RANGE,
      routeHash: location.hash,
      roomName: ''
    };
    try {
      const saved = { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
      saved.runAt = saved.runAt === LEGACY_RUN_TIME
        ? defaultRunAt()
        : (normalizeRunAt(saved.runAt) || defaultRunAt());
      saved.continuousRequest = saved.continuousRequest !== false;
      if (!isValidDayExpr(saved.dayExpr)) saved.dayExpr = '明天';
      saved.timeRange = normalizeTimeRange(saved.timeRange) || DEFAULT_TIME_RANGE;
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
