// ==UserScript==
// @name         LiXin Library Seat Helper
// @namespace    https://kjyy.lixin.edu.cn/
// @version      1.0.0
// @description  上海立信会计金融学院 IC 空间座位预约辅助：点座位自动填号、每日定时预约、任务列表与取消。
// @author       顾佳俊
// @match        https://kjyy.lixin.edu.cn/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'lixin-seat-helper.tasks.v1';
  const SETTINGS_KEY = 'lixin-seat-helper.form.v1';
  const TICK_MS = 1000;
  const RUN_GRACE_MS = 10 * 60 * 1000;
  const DEFAULT_APPLY_NOTE = '';

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
    automationClicking: false,
    toastTimer: 0
  };

  const dom = {};

  boot();

  function boot() {
    injectStyle();
    createUi();
    bindSeatPicker();
    render();
    setInterval(schedulerTick, TICK_MS);
    window.addEventListener('hashchange', () => {
      state.form.routeHash = location.hash;
      state.form.roomName = getRoomName();
      saveForm();
      render();
    });
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
            <div class="lsh-field lsh-field-wide">
              <label>目标座位号</label>
              <input data-lsh-field="seatId" autocomplete="off" placeholder="例如 PDW3FA3001">
            </div>
            <div class="lsh-field">
              <label>每天几点开始执行预约</label>
              <input data-lsh-field="runAt" autocomplete="off" placeholder="例如 22:30:00">
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
          <div class="lsh-help">左键点击座位圆点会打开本面板并自动填入座位号；任务只会在本页面打开且到达设定时间时运行。</div>
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
      if (state.automationClicking) return;
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

    const roomName = getRoomName();
    const task = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seatId: parsed.seatId,
      runAt: parsed.runAt,
      dayExpr: parsed.dayExpr,
      timeRange: parsed.timeRange,
      routeHash: location.hash,
      roomName,
      createdAt: new Date().toISOString(),
      lastRunOn: '',
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
    if (!['今天', '明天', '+2', '+3', '+7'].includes(state.form.dayExpr)) {
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
              <div class="lsh-task-meta">${escapeHtml(task.runAt)} / ${escapeHtml(dayLabel(task.dayExpr))} / ${escapeHtml(task.timeRange || '08:00-22:30')}</div>
              <div class="lsh-task-meta">${escapeHtml(task.roomName || task.routeHash || '当前座位页')}</div>
            </div>
            <button class="lsh-cancel" type="button" data-lsh-cancel="${escapeHtml(task.id)}">取消</button>
          </div>
          <div class="lsh-task-status">${escapeHtml(task.status || '等待执行')}</div>
        </div>
      `)
      .join('');
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
    if (!runAt) return fail('执行时间格式应为 HH:mm 或 HH:mm:ss');
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
    const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return '';
    return `${pad2(match[1])}:${match[2]}:${match[3] || '00'}`;
  }

  function normalizeDayExpr(value) {
    const text = String(value || '').trim();
    if (text === '今天') return '今天';
    if (text === '明天') return '明天';
    if (text === '后天' || text === '+2') return '+2';
    if (text === '三天后' || text === '+3') return '+3';
    if (text === '七天后' || text === '+7') return '+7';
    return '';
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
    const todayKey = toDateText(now);
    const dueTask = state.tasks.find(task => {
      if (task.running) return false;
      if (task.lastRunOn === todayKey) return false;
      const dueAt = scheduledDateTime(now, task.runAt);
      const diff = now.getTime() - dueAt.getTime();
      return diff >= 0 && diff <= RUN_GRACE_MS;
    });
    if (!dueTask) return;
    runTask(dueTask);
  }

  async function runTask(task) {
    state.busy = true;
    task.running = true;
    task.status = '执行中：准备页面';
    saveTasks();
    render();

    try {
      if (!isSeatPage()) throw new Error('请先打开立信 IC 空间管理系统的座位预约页面');
      await ensureRoute(task);

      const targetDate = resolveTargetDate(task.dayExpr);
      const [startTime, endTime] = task.timeRange.split('-');
      await setTopDate(targetDate);
      await setTopTimeRange(startTime, endTime);
      await waitForSeatMap();

      const seat = findSeat(task.seatId);
      if (!seat) throw new Error(`当前地点未找到座位 ${task.seatId}`);
      const status = detectSeatStatus(seat);
      if (status.key === 'yellow') throw new Error(`座位 ${task.seatId} 当前为使用中`);
      if (status.key === 'gray') throw new Error(`座位 ${task.seatId} 当前不开放`);
      if (!['green', 'yellowGreen'].includes(status.key)) throw new Error(`座位 ${task.seatId} 状态未知：${status.label}`);

      task.status = `执行中：选择座位 ${task.seatId}`;
      saveTasks();
      render();
      await clickSeatForSite(seat);
      await waitForBookingDialog();
      await setDialogTimeRange(startTime, endTime);
      fillApplyNote(DEFAULT_APPLY_NOTE);
      await submitDialog();

      const result = await waitForResultMessage();
      task.lastRunOn = toDateText(new Date());
      task.status = result || `已提交：${toDateText(new Date())} ${new Date().toLocaleTimeString()}`;
      notify('立信座位助手', task.status);
      toast(task.status);
    } catch (error) {
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

  async function ensureRoute(task) {
    if (!task.routeHash || task.routeHash === location.hash) return;
    task.status = `执行中：切换到 ${task.roomName || task.routeHash}`;
    saveTasks();
    render();
    location.hash = task.routeHash;
    await waitFor(() => location.hash === task.routeHash, 10000);
    await waitForSeatMap();
  }

  function isSeatPage() {
    return location.hostname === 'kjyy.lixin.edu.cn' && location.hash.includes('/ic/seatPredetermine/');
  }

  async function setTopDate(dateText) {
    const input = document.querySelector('.seatOperation input[placeholder="请选择"]');
    if (!input) throw new Error('未找到日期选择框');
    if (input.value === dateText) return;

    await chooseDateWithPicker(input, dateText);
    await waitFor(() => input.value === dateText, 5000);
    if (input.value !== dateText) throw new Error(`日期 ${dateText} 未选择成功`);
    await sleep(800);
  }

  async function chooseDateWithPicker(input, dateText) {
    input.click();
    const panel = await waitForElement('.el-picker-panel.el-date-picker', 3000, visibleElement);
    if (!panel) throw new Error('日期面板未打开');
    const target = parseDateText(dateText);

    for (let i = 0; i < 24; i++) {
      const current = getPickerYearMonth(panel);
      if (!current) break;
      const diff = (target.year - current.year) * 12 + (target.month - current.month);
      if (diff === 0) break;
      const selector = diff > 0 ? '.el-date-picker__next-btn.el-icon-arrow-right' : '.el-date-picker__prev-btn.el-icon-arrow-left';
      const btn = panel.querySelector(selector);
      if (!btn) break;
      btn.click();
      await sleep(180);
    }

    const day = String(target.day);
    const cell = Array.from(panel.querySelectorAll('td.available:not(.disabled)'))
      .find(td => textOf(td) === day && !td.className.includes('prev-month') && !td.className.includes('next-month'));
    if (!cell) throw new Error(`日期 ${dateText} 不可选`);
    cell.click();
  }

  function getPickerYearMonth(panel) {
    const text = textOf(panel.querySelector('.el-date-picker__header') || panel);
    const match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]) };
  }

  async function setTopTimeRange(start, end) {
    const inputs = Array.from(document.querySelectorAll('.seatOperation input'));
    const startInput = inputs.find(input => input.getAttribute('placeholder') === '请选择开始时间');
    const endInput = inputs.find(input => input.getAttribute('placeholder') === '请选择结束时间');
    if (!startInput || !endInput) throw new Error('未找到顶部时间选择框');
    if (startInput.value !== start) await chooseSelectOption(startInput, start);
    if (endInput.value !== end) await chooseSelectOption(endInput, end);
    await sleep(800);
  }

  async function setDialogTimeRange(start, end) {
    const dialog = getVisibleDialog();
    if (!dialog) throw new Error('预约弹窗已消失');
    const inputs = Array.from(dialog.querySelectorAll('input[placeholder="请选择"]'));
    if (inputs.length < 2) throw new Error('未找到预约弹窗时间选择框');
    if (inputs[0].value !== start) await chooseSelectOption(inputs[0], start);
    if (inputs[1].value !== end) await chooseSelectOption(inputs[1], end);
  }

  async function chooseSelectOption(input, value) {
    input.click();
    const dropdown = await waitForElement('.el-select-dropdown.el-popper', 3000, visibleElement);
    if (!dropdown) throw new Error(`时间选择框未打开：${value}`);
    const option = await waitFor(() => {
      const visibleDropdown = Array.from(document.querySelectorAll('.el-select-dropdown.el-popper')).find(visibleElement);
      if (!visibleDropdown) return null;
      return Array.from(visibleDropdown.querySelectorAll('.el-select-dropdown__item, li'))
        .find(item => textOf(item) === value && !item.classList.contains('is-disabled') && !item.classList.contains('disabled'));
    }, 3000);
    if (!option) throw new Error(`时间 ${value} 不可选`);
    option.scrollIntoView({ block: 'center' });
    await sleep(80);
    option.click();
    await waitFor(() => input.value === value, 3000);
    if (input.value !== value) throw new Error(`时间 ${value} 未选择成功`);
  }

  function findSeat(seatId) {
    return Array.from(document.querySelectorAll('.seat-area .grid .draggable[title]'))
      .find(el => normalizeSeatId(el.getAttribute('title') || el.textContent) === normalizeSeatId(seatId));
  }

  function detectSeatStatus(seat) {
    const classes = Array.from(seat.classList);
    const key = classes.find(cls => STATUS_LABELS[cls]) || 'unknown';
    return { key, label: STATUS_LABELS[key] || classes.join(' ') || '未知' };
  }

  async function clickSeatForSite(seat) {
    state.automationClicking = true;
    try {
      seat.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(150);
      seat.click();
    } finally {
      setTimeout(() => {
        state.automationClicking = false;
      }, 200);
    }
  }

  async function waitForBookingDialog() {
    const dialog = await waitFor(() => {
      const dialog = getVisibleDialog();
      return dialog && textOf(dialog).includes('申请预约') ? dialog : null;
    }, 5000);
    if (!dialog) throw new Error('预约弹窗未打开');
    return dialog;
  }

  function getVisibleDialog() {
    return Array.from(document.querySelectorAll('.el-dialog')).find(visibleElement);
  }

  function fillApplyNote(value) {
    const dialog = getVisibleDialog();
    if (!dialog) return;
    const textarea = dialog.querySelector('textarea');
    if (!textarea) return;
    setNativeValue(textarea, value || '');
  }

  async function submitDialog() {
    const dialog = getVisibleDialog();
    if (!dialog) throw new Error('预约弹窗已消失');
    const button = Array.from(dialog.querySelectorAll('button')).find(btn => textOf(btn) === '提交');
    if (!button) throw new Error('未找到提交按钮');
    button.click();
  }

  async function waitForResultMessage() {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const message = Array.from(document.querySelectorAll('.el-message, .el-notification, .el-message-box'))
        .filter(visibleElement)
        .map(el => textOf(el))
        .filter(Boolean)
        .pop();
      if (message) return message;
      await sleep(250);
    }
    return '已点击提交，请在页面确认结果';
  }

  async function waitForSeatMap() {
    const seat = await waitForElement('.seat-area .grid .draggable[title]', 10000);
    if (!seat) throw new Error('座位图未加载完成');
  }

  function resolveTargetDate(expr) {
    const text = normalizeDayExpr(expr);
    if (!text) throw new Error(`无法识别预约日期：${expr}`);
    const today = startOfDay(new Date());
    let offset = 0;
    if (text === '明天') offset = 1;
    else if (text.startsWith('+')) offset = Number(text.slice(1));
    const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    return toDateText(target);
  }

  function dayOptions() {
    return [
      { value: '今天', offset: 0, name: '今天' },
      { value: '明天', offset: 1, name: '明天' },
      { value: '+2', offset: 2, name: '后天' },
      { value: '+3', offset: 3, name: '三天后' },
      { value: '+7', offset: 7, name: '七天后' }
    ].map(option => {
      const date = addDays(new Date(), option.offset);
      return { value: option.value, label: `${option.name}（${date.getMonth() + 1}月${date.getDate()}日）` };
    });
  }

  function dayLabel(expr) {
    return dayOptions().find(option => option.value === expr)?.label || expr || '';
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function scheduledDateTime(now, runAt) {
    const [h, m, s] = runAt.split(':').map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s || 0, 0);
  }

  function parseDateText(text) {
    const [year, month, day] = text.split('-').map(Number);
    return { year, month, day };
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

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
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

  async function waitForElement(selector, timeoutMs, predicate = Boolean) {
    return waitFor(() => {
      const elements = Array.from(document.querySelectorAll(selector));
      return elements.find(predicate) || null;
    }, timeoutMs);
  }

  async function waitFor(getter, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = getter();
      if (result) return result;
      await sleep(100);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        runAt: task.runAt === '07:59:59' ? '22:30:00' : (normalizeRunAt(task.runAt) || '22:30:00'),
        dayExpr: ['今天', '明天', '+2', '+3', '+7'].includes(task.dayExpr) ? task.dayExpr : '明天',
        timeRange: normalizeTimeRange(task.timeRange) || '08:00-22:30'
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
      runAt: '22:30:00',
      dayExpr: '明天',
      timeRange: '08:00-22:30',
      routeHash: location.hash,
      roomName: ''
    };
    try {
      const saved = { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
      if (saved.runAt === '07:59:59') saved.runAt = '22:30:00';
      if (!['今天', '明天', '+2', '+3', '+7'].includes(saved.dayExpr)) saved.dayExpr = '明天';
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
