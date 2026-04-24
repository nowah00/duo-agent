const POLL_INTERVAL_MS = 2000;
const STATUS_LABELS = {
  idle: 'idle',
  running: 'running',
  complete: 'complete',
  error: 'error',
  paused: 'paused',
};
const STATUS_CLASSES = new Set(Object.keys(STATUS_LABELS));
const AGENT_LABELS = {
  codex: 'Codex',
  claude: 'Claude Code',
};

const app = document.querySelector('#app');
const openReviews = new Set();
const reviewTabs = new Map();

let currentState = {
  round: 0,
  maxRounds: 8,
  lastAgent: null,
  status: 'idle',
  updatedAt: null,
  lastReason: null,
  lastSummary: null,
  lastChangedFiles: [],
  hasPendingFeedback: false,
  currentTask: null,
};
let currentHistory = [];
let currentPage = window.location.hash === '#history' ? 'history' : 'dashboard';
let loadError = null;
let controlError = null;
let pendingAction = null;
let kickForm = {
  goal: '',
  stack: '',
  rules: '',
  checklist: [],
};
let feedbackDraft = '';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatAgent(agent) {
  const normalizedAgent = String(agent || '').toLowerCase().replace(/\s+/g, '-');

  if (normalizedAgent === 'claude-code') {
    return AGENT_LABELS.claude;
  }

  return AGENT_LABELS[normalizedAgent] || '대기 중';
}

function formatDate(value) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);

  if (diffSec < 10) return '방금';
  if (diffSec < 60) return `${diffSec}초 전`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatReviewName(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d+Z_(\w+)\.md$/);
  if (!match) return filename;

  const [, datePart, hh, mm, ss, agent] = match;
  const date = new Date(`${datePart}T${hh}:${mm}:${ss}Z`);
  if (Number.isNaN(date.getTime())) return filename;

  const agentLabel = AGENT_LABELS[agent] || agent;
  const isToday = new Date().toDateString() === date.toDateString();

  const timeStr = new Intl.DateTimeFormat('ko-KR', {
    ...(isToday ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  return `${timeStr} · ${agentLabel}`;
}

function formatSessionTimestamp(ms) {
  if (!ms) return '-';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '-';
  const isToday = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat('ko-KR', {
    ...(isToday ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function getStatus(state) {
  const status = state.status || 'idle';
  return STATUS_CLASSES.has(status) ? status : 'idle';
}

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  return element;
}

function createMetric(label, value) {
  const metric = createElement('section', { className: 'metric' });
  metric.append(
    createElement('span', { className: 'metric__label', text: label }),
    createElement('strong', { className: 'metric__value', text: value }),
  );

  return metric;
}

function renderHeader(container, state) {
  const status = getStatus(state);
  const header = createElement('header', { className: 'dashboard-header' });
  const titleGroup = createElement('div', { className: 'title-group' });
  const prompt = createElement('span', { className: 'prompt', text: 'duo-agent@monitor:~$' });
  const title = createElement('h1', { text: 'Monitoring Dashboard' });
  const badge = createElement('span', {
    className: `status-badge status-badge--${status}`,
    text: STATUS_LABELS[status],
  });

  titleGroup.append(prompt, title);
  header.append(titleGroup, badge);
  container.append(header);
}

function renderProgress(container, state) {
  const round = Number(state.round || 0);
  const maxRounds = Math.max(Number(state.maxRounds || 8), 1);
  const percent = clamp((round / maxRounds) * 100, 0, 100);
  const progressSection = createElement('section', { className: 'progress-panel' });
  const progressHeader = createElement('div', { className: 'progress-header' });
  const progressTrack = createElement('div', { className: 'progress-track' });
  const progressFill = createElement('div', { className: 'progress-fill' });

  progressHeader.append(
    createElement('span', { text: 'round progress' }),
    createElement('strong', { text: `${round} / ${maxRounds}` }),
  );

  progressFill.style.width = `${percent}%`;
  progressFill.setAttribute('aria-label', `round progress ${Math.round(percent)}%`);
  progressTrack.append(progressFill);
  progressSection.append(progressHeader, progressTrack);
  container.append(progressSection);
}

function renderMetrics(container, state) {
  const metrics = createElement('div', { className: 'metrics-grid' });

  metrics.append(
    createMetric('active agent', formatAgent(state.lastAgent)),
    createMetric('last trigger', state.lastReason || '-'),
    createMetric('updated at', formatDate(state.updatedAt)),
  );

  container.append(metrics);
}

function renderKickPanel(container, state) {
  const status = getStatus(state);
  const panel = createElement('section', { className: 'kick-panel' });
  const header = createElement('div', { className: 'section-header' });
  const form = createElement('form', { className: 'kick-form' });
  const goalField = createElement('label', { className: 'form-field' });
  const goalLabel = createElement('span', { className: 'form-field__label', text: '목표' });
  const goalInput = createElement('textarea', { className: 'form-textarea' });
  const stackField = createElement('label', { className: 'form-field' });
  const stackLabel = createElement('span', { className: 'form-field__label', text: '기술 스택' });
  const stackInput = createElement('input', { className: 'form-input' });
  const rulesField = createElement('label', { className: 'form-field' });
  const rulesLabel = createElement('span', { className: 'form-field__label', text: '제약 조건' });
  const rulesInput = createElement('textarea', { className: 'form-textarea' });
  const actions = createElement('div', { className: 'control-actions' });
  const kickButton = createElement('button', {
    className: 'control-button control-button--kick',
    text: pendingAction === 'kick' ? '...' : '▶ Kick',
  });
  const stopButton = createElement('button', {
    className: 'control-button control-button--stop',
    text: pendingAction === 'stop' ? 'Stopping...' : '■ Stop',
  });
  const isRunning = status === 'running';
  const isBusy = Boolean(pendingAction);
  const isFormDisabled = isRunning || isBusy;
  const hasGoal = kickForm.goal.trim().length > 0;

  header.append(
    createElement('h2', { text: 'New Task' }),
    createElement('span', { text: isRunning ? 'agent running' : status }),
  );

  goalInput.name = 'goal';
  goalInput.rows = 5;
  goalInput.placeholder = '무엇을 만들거나 수정할지 구체적으로 적어주세요.';
  goalInput.value = kickForm.goal;
  goalInput.disabled = isFormDisabled;
  goalInput.addEventListener('input', (event) => {
    kickForm.goal = event.target.value;
    kickButton.disabled = !kickForm.goal.trim() || isFormDisabled;
  });
  goalField.append(goalLabel, goalInput);

  stackInput.type = 'text';
  stackInput.name = 'stack';
  stackInput.placeholder = '예: React, Node.js, PostgreSQL';
  stackInput.value = kickForm.stack;
  stackInput.disabled = isFormDisabled;
  stackInput.addEventListener('input', (event) => {
    kickForm.stack = event.target.value;
  });
  stackField.append(stackLabel, stackInput);

  rulesInput.name = 'rules';
  rulesInput.rows = 4;
  rulesInput.placeholder = '예: 테스트 필수, REST API, 기존 코드 유지';
  rulesInput.value = kickForm.rules;
  rulesInput.disabled = isFormDisabled;
  rulesInput.addEventListener('input', (event) => {
    kickForm.rules = event.target.value;
  });
  rulesField.append(rulesLabel, rulesInput);

  kickButton.type = 'submit';
  kickButton.disabled = !hasGoal || isFormDisabled;

  stopButton.type = 'button';
  stopButton.disabled = status !== 'running' || isBusy;
  stopButton.addEventListener('click', () => {
    stopAgent();
  });

  actions.append(kickButton, stopButton);

  const checklistField = createElement('div', { className: 'form-field' });
  const checklistLabel = createElement('span', { className: 'form-field__label', text: '완료 체크리스트 (선택)' });
  const checklistItems = createElement('div', { className: 'checklist-inputs' });

  kickForm.checklist.forEach((item, index) => {
    const row = createElement('div', { className: 'checklist-row' });
    const input = createElement('input', { className: 'form-input' });
    const removeBtn = createElement('button', { className: 'checklist-remove-btn', text: '×' });

    input.type = 'text';
    input.value = item;
    input.placeholder = `항목 ${index + 1}`;
    input.disabled = isFormDisabled;
    input.addEventListener('input', (e) => { kickForm.checklist[index] = e.target.value; });

    removeBtn.type = 'button';
    removeBtn.disabled = isFormDisabled;
    removeBtn.addEventListener('click', () => {
      kickForm.checklist.splice(index, 1);
      render();
    });

    row.append(input, removeBtn);
    checklistItems.append(row);
  });

  const addItemBtn = createElement('button', { className: 'checklist-add-btn', text: '+ 항목 추가' });
  addItemBtn.type = 'button';
  addItemBtn.disabled = isFormDisabled;
  addItemBtn.addEventListener('click', () => {
    kickForm.checklist.push('');
    render();
  });

  checklistField.append(checklistLabel, checklistItems, addItemBtn);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    kickAgent();
  });
  form.append(goalField, stackField, rulesField, checklistField, actions);
  panel.append(header, form);

  if (controlError) {
    panel.append(createElement('p', {
      className: 'control-error',
      text: controlError,
    }));
  }

  container.append(panel);
}

function buildReviewItem(review) {
  const details = createElement('details', { className: 'review-item' });
  const summaryEl = createElement('summary');
  const nameEl = createElement('span', { className: 'review-name', text: formatReviewName(review.name) });
  const hint = createElement('span', { className: 'review-hint', text: 'open' });

  details.open = openReviews.has(review.name);
  hint.textContent = details.open ? 'close' : 'open';
  details.addEventListener('toggle', () => {
    if (details.open) openReviews.add(review.name);
    else openReviews.delete(review.name);
    hint.textContent = details.open ? 'close' : 'open';
  });

  summaryEl.append(nameEl, hint);
  details.append(summaryEl);

  if (review.promptSummary) {
    const activeTab = reviewTabs.get(review.name) || 'output';
    const tabBar = createElement('div', { className: 'review-tabs' });
    const outputTab = createElement('button', {
      className: `review-tab${activeTab === 'output' ? ' review-tab--active' : ''}`,
      text: 'Output',
    });
    const promptTab = createElement('button', {
      className: `review-tab${activeTab === 'prompt' ? ' review-tab--active' : ''}`,
      text: 'Prompt',
    });
    const outputContent = createElement('pre', { text: review.content || '(empty)' });
    const promptContent = createElement('pre', { text: review.promptSummary });

    outputTab.type = 'button';
    promptTab.type = 'button';

    if (activeTab !== 'output') outputContent.style.display = 'none';
    if (activeTab !== 'prompt') promptContent.style.display = 'none';

    outputTab.addEventListener('click', () => {
      reviewTabs.set(review.name, 'output');
      outputContent.style.display = '';
      promptContent.style.display = 'none';
      outputTab.classList.add('review-tab--active');
      promptTab.classList.remove('review-tab--active');
    });
    promptTab.addEventListener('click', () => {
      reviewTabs.set(review.name, 'prompt');
      outputContent.style.display = 'none';
      promptContent.style.display = '';
      outputTab.classList.remove('review-tab--active');
      promptTab.classList.add('review-tab--active');
    });

    tabBar.append(outputTab, promptTab);
    details.append(tabBar, outputContent, promptContent);
  } else {
    details.append(createElement('pre', { text: review.content || '(empty)' }));
  }

  return details;
}

function renderCurrentTask(container, state) {
  if (!state.currentTask) return;

  const panel = createElement('section', { className: 'current-task-panel' });
  const header = createElement('div', { className: 'section-header' });
  const statusLabel = getStatus(state) === 'running' ? '실행 중' : '대기';

  header.append(
    createElement('h2', { text: 'Current Task' }),
    createElement('span', { text: statusLabel }),
  );
  panel.append(header, createElement('pre', { text: state.currentTask }));
  container.append(panel);
}

function renderNav(container) {
  const nav = createElement('nav', { className: 'main-nav' });
  const dashLink = createElement('a', {
    className: `nav-link${currentPage === 'dashboard' ? ' nav-link--active' : ''}`,
    text: 'Dashboard',
  });
  const historyLink = createElement('a', {
    className: `nav-link${currentPage === 'history' ? ' nav-link--active' : ''}`,
    text: 'History',
  });

  dashLink.href = '#';
  historyLink.href = '#history';
  nav.append(dashLink, historyLink);
  container.append(nav);
}

function renderHistoryPage(container) {
  const section = createElement('section', { className: 'history-panel' });
  const header = createElement('div', { className: 'section-header' });

  header.append(
    createElement('h2', { text: 'History' }),
    createElement('span', { text: `${currentHistory.length} sessions` }),
  );
  section.append(header);

  if (!currentHistory.length) {
    section.append(createElement('p', {
      className: 'empty-state',
      text: 'Kick으로 작업을 시작하면 여기에 히스토리가 쌓입니다.',
    }));
    container.append(section);
    return;
  }

  const list = createElement('div', { className: 'history-list' });

  currentHistory.forEach((session) => {
    const sessionEl = createElement('details', { className: 'history-session' });
    const summaryEl = createElement('summary', { className: 'session-summary' });

    summaryEl.append(
      createElement('span', { className: 'session-time', text: formatSessionTimestamp(session.taskTimestamp) }),
      createElement('span', { className: 'session-count', text: `${session.reviews.length} reviews` }),
    );
    sessionEl.append(summaryEl);

    if (session.taskContent) {
      const taskBlock = createElement('div', { className: 'session-task' });
      taskBlock.append(
        createElement('div', { className: 'session-task__label', text: 'Task' }),
        createElement('pre', { className: 'session-task__content', text: session.taskContent }),
      );
      sessionEl.append(taskBlock);
    }

    if (session.reviews.length) {
      const reviewList = createElement('div', { className: 'session-reviews' });
      session.reviews.forEach((review) => reviewList.append(buildReviewItem(review)));
      sessionEl.append(reviewList);
    }

    list.append(sessionEl);
  });

  section.append(list);
  container.append(section);
}

function renderChecklist(container, state) {
  const items = Array.isArray(state.checklist) ? state.checklist : [];
  if (!items.length) return;

  const section = createElement('section', { className: 'checklist-panel' });
  const header = createElement('div', { className: 'section-header' });
  header.append(
    createElement('h2', { text: '완료 체크리스트' }),
    createElement('span', { text: `${items.length}개 항목` }),
  );

  const list = createElement('ol', { className: 'checklist-list' });
  items.forEach((item) => {
    list.append(createElement('li', { className: 'checklist-list-item', text: item }));
  });

  section.append(header, list);
  container.append(section);
}

function renderError(container) {
  if (!loadError) return;

  container.append(createElement('p', {
    className: 'load-error',
    text: `API 연결 오류: ${loadError}`,
  }));
}

function renderFeedbackPanel(container, state) {
  const panel = createElement('section', { className: 'feedback-panel' });
  const header = createElement('div', { className: 'section-header' });
  const statusText = state.hasPendingFeedback ? '대기 중 — 다음 라운드에 전달됩니다' : '전송 가능';

  header.append(
    createElement('h2', { text: 'Mid-run Feedback' }),
    createElement('span', { className: state.hasPendingFeedback ? 'feedback-pending-badge' : '', text: statusText }),
  );

  const textarea = createElement('textarea', { className: 'form-textarea' });
  textarea.placeholder = '실행 중 방향을 바꾸고 싶을 때 입력하세요. 다음 라운드 시작 시 에이전트에게 전달됩니다.';
  textarea.value = feedbackDraft;
  textarea.rows = 3;
  textarea.addEventListener('input', (e) => {
    feedbackDraft = e.target.value;
    sendBtn.disabled = !feedbackDraft.trim() || Boolean(pendingAction);
  });

  const sendBtn = createElement('button', {
    className: 'control-button control-button--feedback',
    text: pendingAction === 'feedback' ? '전송 중...' : '↑ 전달',
  });
  sendBtn.type = 'button';
  sendBtn.disabled = !feedbackDraft.trim() || Boolean(pendingAction);
  sendBtn.addEventListener('click', () => sendFeedback());

  panel.append(header, textarea, sendBtn);
  container.append(panel);
}

function renderLastRound(container, state) {
  const summary = state.lastSummary;
  const files = Array.isArray(state.lastChangedFiles) ? state.lastChangedFiles : [];
  if (!summary && !files.length) return;

  const panel = createElement('section', { className: 'last-round-panel' });
  const header = createElement('div', { className: 'section-header' });
  header.append(
    createElement('h2', { text: 'Last Round' }),
    createElement('span', { text: `round ${state.round}` }),
  );
  panel.append(header);

  if (summary) {
    panel.append(createElement('p', { className: 'last-round-summary', text: summary }));
  }

  if (files.length) {
    const fileList = createElement('ul', { className: 'changed-files-list' });
    files.forEach((f) => fileList.append(createElement('li', { className: 'changed-file', text: f })));
    panel.append(fileList);
  }

  container.append(panel);
}

function renderDashboardPage(container) {
  const columns = createElement('div', { className: 'dashboard-columns' });
  const leftCol = createElement('div', { className: 'dashboard-col' });
  const rightCol = createElement('div', { className: 'dashboard-col' });

  renderHeader(container, currentState);

  renderKickPanel(leftCol, currentState);
  renderFeedbackPanel(leftCol, currentState);
  renderChecklist(leftCol, currentState);

  renderCurrentTask(rightCol, currentState);
  renderProgress(rightCol, currentState);
  renderMetrics(rightCol, currentState);
  renderLastRound(rightCol, currentState);

  columns.append(leftCol, rightCol);
  container.append(columns);
  renderError(container);
}

function render() {
  const fragment = document.createDocumentFragment();
  const shell = createElement('div', { className: 'dashboard-shell' });

  renderNav(shell);

  if (currentPage === 'history') {
    renderHistoryPage(shell);
  } else {
    renderDashboardPage(shell);
  }

  fragment.append(shell);
  app.replaceChildren(fragment);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }

  return response.json();
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${url} ${response.status}`);
  }

  return payload;
}

async function kickAgent() {
  const goal = kickForm.goal.trim();
  const stack = kickForm.stack.trim();
  const rules = kickForm.rules.trim();

  if (!goal || pendingAction || getStatus(currentState) === 'running') return;

  const task = [
    `goal: ${goal}`,
    stack ? `stack: ${stack}` : null,
    rules ? `rules: ${rules}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  pendingAction = 'kick';
  controlError = null;
  render();

  try {
    await postJson('/api/kick', {
      task,
      checklist: kickForm.checklist.filter(s => s.trim()),
    });
    kickForm = {
      goal: '',
      stack: '',
      rules: '',
      checklist: [],
    };
    await refreshDashboard();
  } catch (error) {
    controlError = error instanceof Error ? error.message : 'Kick 요청에 실패했습니다.';
    render();
  } finally {
    pendingAction = null;
    render();
  }
}

async function stopAgent() {
  if (getStatus(currentState) !== 'running' || pendingAction) return;

  pendingAction = 'stop';
  controlError = null;
  render();

  try {
    await postJson('/api/stop');
    await refreshDashboard();
  } catch (error) {
    controlError = error instanceof Error ? error.message : 'Stop 요청에 실패했습니다.';
    render();
  } finally {
    pendingAction = null;
    render();
  }
}

async function sendFeedback() {
  const feedback = feedbackDraft.trim();
  if (!feedback || pendingAction) return;

  pendingAction = 'feedback';
  controlError = null;
  render();

  try {
    await postJson('/api/feedback', { feedback });
    feedbackDraft = '';
    await refreshDashboard();
  } catch (error) {
    controlError = error instanceof Error ? error.message : '피드백 전송에 실패했습니다.';
    render();
  } finally {
    pendingAction = null;
    render();
  }
}

async function refreshDashboard() {
  try {
    const promises = [fetchJson('/api/state')];
    if (currentPage === 'history') promises.push(fetchJson('/api/history'));

    const [state, history] = await Promise.all(promises);
    currentState = state;
    if (history !== undefined) currentHistory = Array.isArray(history) ? history : [];
    loadError = null;
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'unknown error';
  }

  const active = document.activeElement;
  const isTyping = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
  if (!isTyping) render();
}

function injectStyles() {
  document.querySelector('#duo-agent-dashboard-styles')?.remove();

  const style = document.createElement('style');
  style.id = 'duo-agent-dashboard-styles';
  style.textContent = `
    :root {
      --bg-canvas: #faf8f5;
      --bg-wash: #f5f0e8;
      --panel-bg: #fdf9f4;
      --panel-bg-alt: #f8f3ec;
      --border-soft: #ddcfbe;
      --border-strong: #cbb69b;
      --accent: #836942;
      --accent-strong: #7a5f38;
      --accent-soft: #c4a882;
      --text-strong: #3d2b1f;
      --text-base: #5c4033;
      --text-muted: #8d7868;
      --error: #8c5a4b;
      --input-bg: #fffdfa;
      --track-bg: #efe6da;
      --pre-bg: #f7f0e6;
    }

    .dashboard-shell {
      display: grid;
      gap: 18px;
      color: var(--text-base);
    }

    .main-nav {
      display: flex;
      gap: 0;
      border: 1px solid var(--border-soft);
      background: var(--panel-bg);
      width: fit-content;
    }

    .nav-link {
      display: block;
      padding: 10px 20px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-right: 1px solid var(--border-soft);
    }

    .nav-link:last-child {
      border-right: none;
    }

    .nav-link:hover {
      color: var(--text-base);
      background: var(--bg-wash);
    }

    .nav-link--active {
      color: var(--accent-strong);
      background: var(--bg-wash);
    }

    .current-task-panel {
      border: 1px solid var(--border-soft);
      background: linear-gradient(180deg, var(--panel-bg) 0%, var(--panel-bg-alt) 100%);
      box-shadow: 0 0 0 1px rgba(160, 132, 92, 0.06), 0 18px 40px rgba(96, 71, 45, 0.1);
      padding: 18px;
      display: grid;
      gap: 12px;
    }

    .current-task-panel pre {
      border-top: 1px solid var(--border-soft);
      max-height: 160px;
    }

    .history-panel {
      border: 1px solid var(--border-soft);
      background: linear-gradient(180deg, var(--panel-bg) 0%, var(--panel-bg-alt) 100%);
      box-shadow: 0 0 0 1px rgba(160, 132, 92, 0.06), 0 18px 40px rgba(96, 71, 45, 0.1);
      padding: 18px;
    }

    .history-list {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }

    .history-session {
      border: 1px solid var(--border-soft);
      background: var(--input-bg);
    }

    .session-summary {
      min-height: 48px;
      padding: 12px 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      list-style: none;
    }

    .session-summary::-webkit-details-marker {
      display: none;
    }

    .session-time {
      color: var(--text-strong);
      font-weight: 700;
    }

    .session-count {
      color: var(--accent);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .session-task {
      border-top: 1px solid var(--border-soft);
      padding: 14px;
      background: var(--bg-wash);
    }

    .session-task__label {
      color: var(--accent);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }

    .session-task__content {
      margin: 0;
      border: none;
      padding: 0;
      background: transparent;
      max-height: 120px;
      color: var(--text-base);
    }

    .session-reviews {
      border-top: 1px solid var(--border-soft);
      padding: 12px;
      display: grid;
      gap: 8px;
    }

    .dashboard-columns {
      display: grid;
      grid-template-columns: 380px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }

    .dashboard-col {
      display: grid;
      gap: 18px;
    }

    .dashboard-header,
    .kick-panel,
    .progress-panel,
    .feedback-panel,
    .last-round-panel,
    .metric,
    .reviews-panel {
      border: 1px solid var(--border-soft);
      background: linear-gradient(180deg, var(--panel-bg) 0%, var(--panel-bg-alt) 100%);
      box-shadow: 0 0 0 1px rgba(160, 132, 92, 0.06), 0 18px 40px rgba(96, 71, 45, 0.1);
    }

    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 22px;
    }

    .title-group {
      min-width: 0;
    }

    .prompt,
    .metric__label,
    .section-header span,
    .review-hint,
    .form-field__label {
      color: var(--accent);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    h1,
    h2 {
      margin: 0;
      color: var(--text-strong);
      letter-spacing: 0;
    }

    h1 {
      margin-top: 8px;
      font-size: clamp(1.8rem, 5vw, 3.6rem);
      line-height: 1;
    }

    h2 {
      font-size: 1rem;
    }

    .status-badge {
      flex: 0 0 auto;
      min-width: 104px;
      border: 1px solid currentColor;
      padding: 10px 14px;
      text-align: center;
      font-weight: 700;
      text-transform: uppercase;
    }

    .status-badge--idle {
      color: var(--text-muted);
      background: rgba(141, 120, 104, 0.12);
    }

    .status-badge--running {
      color: var(--accent-strong);
      background: rgba(139, 111, 71, 0.12);
    }

    .status-badge--complete {
      color: var(--accent);
      background: rgba(160, 132, 92, 0.14);
    }

    .status-badge--error {
      color: var(--error);
      background: rgba(140, 90, 75, 0.12);
    }

    .status-badge--paused {
      color: var(--accent-soft);
      background: rgba(196, 168, 130, 0.18);
    }

    .kick-panel {
      display: grid;
      gap: 14px;
      padding: 18px;
    }

    .progress-panel,
    .reviews-panel {
      padding: 18px;
    }

    .progress-header,
    .section-header,
    summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .progress-header {
      margin-bottom: 12px;
      color: var(--text-base);
    }

    .kick-form {
      display: grid;
      gap: 14px;
    }

    .form-field {
      display: grid;
      gap: 8px;
    }

    .form-input,
    .form-textarea {
      width: 100%;
      border: 1px solid var(--border-strong);
      border-radius: 0;
      padding: 14px;
      background: var(--input-bg);
      color: var(--text-strong);
      font: inherit;
      line-height: 1.55;
      outline: none;
      box-sizing: border-box;
    }

    .form-textarea {
      min-height: 108px;
      resize: vertical;
    }

    .form-input::placeholder,
    .form-textarea::placeholder {
      color: var(--text-muted);
    }

    .form-input:focus,
    .form-textarea:focus {
      border-color: var(--accent-strong);
      box-shadow: 0 0 0 3px rgba(160, 132, 92, 0.14);
    }

    .form-input:disabled,
    .form-textarea:disabled {
      cursor: wait;
      opacity: 0.72;
    }

    .control-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .control-button {
      min-height: 44px;
      min-width: 120px;
      border: 1px solid currentColor;
      padding: 10px 16px;
      background: transparent;
      color: var(--text-base);
      cursor: pointer;
      font-weight: 700;
    }

    .control-button--kick {
      color: var(--accent-strong);
      background: rgba(196, 168, 130, 0.18);
    }

    .control-button--stop {
      color: var(--error);
      background: rgba(140, 90, 75, 0.08);
    }

    .control-button:hover:not(:disabled) {
      background: rgba(196, 168, 130, 0.24);
    }

    .control-button:disabled {
      cursor: not-allowed;
      color: var(--text-muted);
      background: rgba(141, 120, 104, 0.1);
    }

    .control-error {
      margin: 0;
      color: var(--error);
      line-height: 1.5;
    }

    .progress-track {
      width: 100%;
      height: 16px;
      overflow: hidden;
      border: 1px solid var(--border-strong);
      background: var(--track-bg);
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent-soft), var(--accent-strong));
      transition: width 180ms ease;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 18px;
    }

    .metric {
      min-height: 120px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 20px;
    }

    .metric__value {
      color: var(--text-strong);
      font-size: 1.05rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .review-list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    .review-item {
      border: 1px solid var(--border-soft);
      background: var(--input-bg);
    }

    summary {
      min-height: 48px;
      padding: 12px 14px;
      cursor: pointer;
      color: var(--text-strong);
      list-style: none;
    }

    summary::-webkit-details-marker {
      display: none;
    }

    .review-name {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .review-item[open] .review-hint {
      color: var(--accent-strong);
    }

    pre {
      max-height: 380px;
      margin: 0;
      overflow: auto;
      border-top: 1px solid var(--border-soft);
      padding: 14px;
      color: var(--text-base);
      background: var(--pre-bg);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
    }

    .checklist-panel {
      border: 1px solid var(--border-soft);
      background: linear-gradient(180deg, var(--panel-bg) 0%, var(--panel-bg-alt) 100%);
      padding: 18px;
    }

    .checklist-list {
      margin: 14px 0 0 0;
      padding-left: 22px;
      display: grid;
      gap: 8px;
    }

    .checklist-list-item {
      color: var(--text-base);
      line-height: 1.55;
    }

    .checklist-inputs {
      display: grid;
      gap: 8px;
      margin-bottom: 8px;
    }

    .checklist-row {
      display: flex;
      gap: 8px;
    }

    .checklist-row .form-input {
      flex: 1;
    }

    .checklist-remove-btn {
      flex: 0 0 auto;
      width: 36px;
      border: 1px solid var(--border-strong);
      background: transparent;
      color: var(--error);
      cursor: pointer;
      font-size: 1rem;
    }

    .checklist-remove-btn:hover:not(:disabled) {
      background: rgba(140, 90, 75, 0.1);
    }

    .checklist-remove-btn:disabled {
      cursor: not-allowed;
      color: var(--text-muted);
    }

    .checklist-add-btn {
      border: 1px dashed var(--border-strong);
      background: transparent;
      color: var(--accent-strong);
      cursor: pointer;
      padding: 8px 14px;
      font: inherit;
      text-align: left;
    }

    .checklist-add-btn:hover:not(:disabled) {
      background: rgba(196, 168, 130, 0.16);
    }

    .checklist-add-btn:disabled {
      cursor: not-allowed;
      color: var(--text-muted);
    }

    .empty-state,
    .load-error {
      margin: 0;
      color: var(--text-muted);
      line-height: 1.6;
    }

    .load-error {
      color: var(--error);
    }

    .feedback-panel,
    .last-round-panel {
      padding: 18px;
      display: grid;
      gap: 12px;
    }

    .feedback-pending-badge {
      color: #b45309;
      font-weight: 700;
    }

    .control-button--feedback {
      color: var(--accent-strong);
      background: rgba(196, 168, 130, 0.18);
      border-color: var(--accent-strong);
      min-width: 80px;
      align-self: start;
    }

    .last-round-summary {
      margin: 0;
      color: var(--text-base);
      line-height: 1.6;
    }

    .changed-files-list {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 4px;
    }

    .changed-file {
      color: var(--accent);
      font-size: 0.85rem;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .review-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-soft);
      background: var(--pre-bg);
    }

    .review-tab {
      padding: 8px 14px;
      border: none;
      border-right: 1px solid var(--border-soft);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font: inherit;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .review-tab:hover {
      color: var(--text-base);
      background: rgba(196, 168, 130, 0.1);
    }

    .review-tab--active {
      color: var(--accent-strong);
      background: var(--input-bg);
      font-weight: 700;
    }

    @media (max-width: 860px) {
      #app {
        width: min(100% - 20px, 1120px);
        padding: 18px 0;
      }

      .dashboard-columns {
        grid-template-columns: 1fr;
      }

      .dashboard-header {
        align-items: flex-start;
        flex-direction: column;
      }

      .status-badge,
      .control-button,
      .control-actions {
        width: 100%;
      }

      .metrics-grid {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.append(style);
}

window.addEventListener('hashchange', () => {
  currentPage = window.location.hash === '#history' ? 'history' : 'dashboard';
  refreshDashboard();
});

injectStyles();
render();
refreshDashboard();
const pollTimer = window.setInterval(refreshDashboard, POLL_INTERVAL_MS);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.clearInterval(pollTimer);
  });
}
