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

let currentState = {
  round: 0,
  maxRounds: 8,
  lastAgent: null,
  status: 'idle',
  updatedAt: null,
  lastReason: null,
};
let currentReviews = [];
let loadError = null;
let controlError = null;
let pendingAction = null;
let kickForm = {
  goal: '',
  stack: '',
  rules: '',
};

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

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
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
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    kickAgent();
  });
  form.append(goalField, stackField, rulesField, actions);
  panel.append(header, form);

  if (controlError) {
    panel.append(createElement('p', {
      className: 'control-error',
      text: controlError,
    }));
  }

  container.append(panel);
}

function renderReviews(container, reviews) {
  const section = createElement('section', { className: 'reviews-panel' });
  const header = createElement('div', { className: 'section-header' });

  header.append(
    createElement('h2', { text: 'Recent Reviews' }),
    createElement('span', { text: `${reviews.length} files` }),
  );
  section.append(header);

  if (!reviews.length) {
    section.append(createElement('p', {
      className: 'empty-state',
      text: '아직 표시할 리뷰 로그가 없습니다.',
    }));
    container.append(section);
    return;
  }

  const list = createElement('div', { className: 'review-list' });

  reviews.forEach((review) => {
    const details = createElement('details', { className: 'review-item' });
    const summary = createElement('summary');
    const name = createElement('span', { className: 'review-name', text: review.name });
    const hint = createElement('span', { className: 'review-hint', text: 'open' });
    const content = createElement('pre', { text: review.content || '(empty)' });

    details.open = openReviews.has(review.name);
    hint.textContent = details.open ? 'close' : 'open';
    details.addEventListener('toggle', () => {
      if (details.open) {
        openReviews.add(review.name);
      } else {
        openReviews.delete(review.name);
      }

      hint.textContent = details.open ? 'close' : 'open';
    });

    summary.append(name, hint);
    details.append(summary, content);
    list.append(details);
  });

  section.append(list);
  container.append(section);
}

function renderError(container) {
  if (!loadError) return;

  container.append(createElement('p', {
    className: 'load-error',
    text: `API 연결 오류: ${loadError}`,
  }));
}

function render() {
  const fragment = document.createDocumentFragment();
  const shell = createElement('div', { className: 'dashboard-shell' });

  renderHeader(shell, currentState);
  renderKickPanel(shell, currentState);
  renderProgress(shell, currentState);
  renderMetrics(shell, currentState);
  renderReviews(shell, currentReviews);
  renderError(shell);

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
    await postJson('/api/kick', { task });
    kickForm = {
      goal: '',
      stack: '',
      rules: '',
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

async function refreshDashboard() {
  try {
    const [state, reviews] = await Promise.all([
      fetchJson('/api/state'),
      fetchJson('/api/reviews'),
    ]);

    currentState = state;
    currentReviews = Array.isArray(reviews) ? reviews : [];
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
    .dashboard-shell {
      display: grid;
      gap: 18px;
    }

    .dashboard-header,
    .kick-panel,
    .progress-panel,
    .metric,
    .reviews-panel {
      border: 1px solid #203629;
      background: rgba(5, 10, 8, 0.92);
      box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.05), 0 18px 60px rgba(0, 0, 0, 0.35);
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
      color: #7dd3a7;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    h1,
    h2 {
      margin: 0;
      color: #eafff1;
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
      color: #94a3b8;
      background: rgba(148, 163, 184, 0.08);
    }

    .status-badge--running {
      color: #34d399;
      background: rgba(52, 211, 153, 0.1);
    }

    .status-badge--complete {
      color: #60a5fa;
      background: rgba(96, 165, 250, 0.1);
    }

    .status-badge--error {
      color: #fb7185;
      background: rgba(251, 113, 133, 0.1);
    }

    .status-badge--paused {
      color: #fbbf24;
      background: rgba(251, 191, 36, 0.1);
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
      color: #c6f6d5;
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
      border: 1px solid #26543b;
      border-radius: 0;
      padding: 14px;
      background: #020403;
      color: #e2f7e9;
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
      color: #64748b;
    }

    .form-input:focus,
    .form-textarea:focus {
      border-color: #34d399;
      box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.12);
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
      color: #d6f5e3;
      cursor: pointer;
      font-weight: 700;
    }

    .control-button--kick {
      color: #34d399;
      background: rgba(52, 211, 153, 0.08);
    }

    .control-button--stop {
      color: #fb7185;
      background: rgba(251, 113, 133, 0.08);
    }

    .control-button:hover:not(:disabled) {
      background: rgba(214, 245, 227, 0.12);
    }

    .control-button:disabled {
      cursor: not-allowed;
      color: #64748b;
      background: rgba(100, 116, 139, 0.08);
    }

    .control-error {
      margin: 0;
      color: #fb7185;
      line-height: 1.5;
    }

    .progress-track {
      width: 100%;
      height: 16px;
      overflow: hidden;
      border: 1px solid #26543b;
      background: #020403;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #22c55e, #38bdf8);
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
      color: #f8fafc;
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
      border: 1px solid #173224;
      background: #07100c;
    }

    summary {
      min-height: 48px;
      padding: 12px 14px;
      cursor: pointer;
      color: #e2f7e9;
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
      color: #38bdf8;
    }

    pre {
      max-height: 380px;
      margin: 0;
      overflow: auto;
      border-top: 1px solid #173224;
      padding: 14px;
      color: #cbd5e1;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
    }

    .empty-state,
    .load-error {
      margin: 0;
      color: #94a3b8;
      line-height: 1.6;
    }

    .load-error {
      color: #fb7185;
    }

    @media (max-width: 760px) {
      #app {
        width: min(100% - 20px, 1120px);
        padding: 18px 0;
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

injectStyles();
render();
refreshDashboard();
const pollTimer = window.setInterval(refreshDashboard, POLL_INTERVAL_MS);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.clearInterval(pollTimer);
  });
}
