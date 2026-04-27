const POLL_INTERVAL_MS = 2000;
const STATUS_CLASSES = new Set(['idle', 'running', 'complete', 'error', 'paused']);
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
  lastSummary: null,
  lastChangedFiles: [],
  hasPendingFeedback: false,
  currentTask: null,
  projectName: null,
  checklist: [],
};
let currentReviews = [];
let currentHistory = [];
let currentPage = window.location.hash === '#history' ? 'history' : window.location.hash === '#preview' ? 'preview' : 'dashboard';
let loadError = null;
let controlError = null;
let pendingAction = null;
let kickForm = {
  projectName: '',
  goal: '',
  stack: '',
  rules: '',
  checklist: [],
};
let confirmReset = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getStatus(state) {
  const status = state.status || 'idle';
  return STATUS_CLASSES.has(status) ? status : 'idle';
}

function formatAgent(agent) {
  const normalizedAgent = String(agent || '').toLowerCase().replace(/\s+/g, '-');
  if (normalizedAgent === 'claude-code') return AGENT_LABELS.claude;
  return AGENT_LABELS[normalizedAgent] || '대기 중';
}

function formatDate(value) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 10) return '방금 전';
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
  const parsed = parseReviewMeta(filename);
  if (!parsed.createdAt) return filename;

  const isToday = new Date().toDateString() === parsed.createdAt.toDateString();
  const timeLabel = new Intl.DateTimeFormat('ko-KR', {
    ...(isToday ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(parsed.createdAt);

  return `${timeLabel} · ${parsed.agentLabel}`;
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

function parseReviewMeta(filename, content = '') {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z_(.+)\.md$/);
  let createdAt = null;
  let agent = null;

  if (match) {
    const [, datePart, hh, mm, ss, ms, agentPart] = match;
    createdAt = new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`);
    agent = agentPart;
  }

  const normalizedAgent = String(agent || '')
    .replace(/_prompt$/, '')
    .replace(/_task$/, '')
    .toLowerCase();
  const agentLabel = normalizedAgent === 'task'
    ? '작업 요청'
    : formatAgent(normalizedAgent);
  const hasComplete = /STATUS:\s*COMPLETE/i.test(content) || /"status"\s*:\s*"COMPLETE"/i.test(content);
  const hasNeedsNext = /STATUS:\s*NEEDS_NEXT/i.test(content) || /"status"\s*:\s*"NEEDS_NEXT"/i.test(content);

  let typeLabel = '검토 로그';
  if (normalizedAgent === 'task') typeLabel = '작업 요청';
  else if (hasComplete) typeLabel = '완료';
  else if (hasNeedsNext) typeLabel = '후속 작업 필요';
  else if (normalizedAgent === 'codex') typeLabel = '구현 결과';
  else if (normalizedAgent === 'claude') typeLabel = '검토 결과';

  return {
    createdAt: createdAt instanceof Date && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    agent: normalizedAgent || null,
    agentLabel,
    hasComplete,
    hasNeedsNext,
    typeLabel,
  };
}

function summarizeTask(task) {
  if (!task) return '현재 작업 정보가 없습니다.';

  const goalLine = task
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^goal:/i.test(line));

  if (goalLine) return goalLine.replace(/^goal:\s*/i, '').trim();

  return task.split('\n')[0].trim() || '현재 작업 정보가 없습니다.';
}

function getUserFacingErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text) return '요청 처리 중 문제가 발생했습니다.';

  const lower = text.toLowerCase();
  if (lower.includes('/api/kick')) return '작업 시작 요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.';
  if (lower.includes('/api/stop')) return '작업 중단 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  if (lower.includes('/api/feedback')) return '피드백 전달에 실패했습니다. 잠시 후 다시 시도해 주세요.';
  if (lower.includes('task is required')) return '작업 목표를 먼저 입력해 주세요.';
  if (lower.includes('project name is required')) return '프로젝트 이름을 먼저 입력해 주세요.';
  if (lower.includes('feedback is required')) return '전달할 피드백 내용을 입력해 주세요.';
  if (lower.includes('spawn') || lower.includes('eperm')) return '실행 환경 권한 문제로 작업을 진행하지 못했습니다.';
  if (lower.includes('exit')) return '에이전트 실행이 비정상 종료되었습니다. 설정과 로그를 확인해 주세요.';

  return text;
}

function mapStatus(state) {
  const status = getStatus(state);
  const agent = String(state.lastAgent || '').toLowerCase();
  const reason = String(state.lastReason || '').toLowerCase();

  if (status === 'running' && agent === 'codex') {
    return {
      badgeClass: 'running',
      badgeText: '구현 중',
      title: 'Codex가 구현 중입니다',
      description: '요청한 기능을 코드로 반영하고 있습니다.',
      nextAction: '작업이 끝날 때까지 기다려 주세요.',
    };
  }

  if (status === 'running' && agent === 'claude') {
    return {
      badgeClass: 'running',
      badgeText: '검토 중',
      title: 'Claude Code가 검토 중입니다',
      description: '구현 결과를 확인하고 다음 라운드를 판단하고 있습니다.',
      nextAction: '검토가 끝나면 결과 요약이 갱신됩니다.',
    };
  }

  if (status === 'complete') {
    return {
      badgeClass: 'complete',
      badgeText: '완료',
      title: '작업이 완료되었습니다',
      description: '구현과 검토가 모두 끝났습니다.',
      nextAction: '결과를 확인하고 다음 작업을 요청할 수 있습니다.',
    };
  }

  if (status === 'error') {
    return {
      badgeClass: 'error',
      badgeText: '오류',
      title: '실행 중 오류가 발생했습니다',
      description: 'CLI 설정이나 실행 환경을 확인해야 합니다.',
      nextAction: '오류 내용을 확인한 뒤 다시 시작해 주세요.',
    };
  }

  if (status === 'paused' && reason.includes('user stopped')) {
    return {
      badgeClass: 'paused',
      badgeText: '중단됨',
      title: '사용자가 작업을 중단했습니다',
      description: '즉시 강제 종료가 아니라 현재 라운드를 마무리한 뒤 자동 진행을 멈춘 상태입니다.',
      nextAction: '필요하면 같은 요청으로 다시 시작할 수 있습니다.',
    };
  }

  if (status === 'paused' && reason.includes('max rounds reached')) {
    return {
      badgeClass: 'paused',
      badgeText: '확인 필요',
      title: '검토 라운드 제한에 도달했습니다',
      description: '자동 진행이 멈췄습니다.',
      nextAction: '검토 결과를 확인하고 요청을 보완해 다시 시작해 주세요.',
    };
  }

  if (status === 'paused' && reason.includes('no changes and no needs_next')) {
    return {
      badgeClass: 'paused',
      badgeText: '확인 필요',
      title: '자동 진행 판단이 멈췄습니다',
      description: '추가 변경이나 후속 지시가 필요합니다.',
      nextAction: '검토 결과를 확인하고 필요한 피드백을 전달해 주세요.',
    };
  }

  return {
    badgeClass: status,
    badgeText: '대기 중',
    title: '새 작업을 요청할 수 있습니다',
    description: '현재 실행 중인 작업이 없습니다.',
    nextAction: '작업 요청을 입력하면 자동으로 구현과 검토를 시작합니다.',
  };
}

function summarizeHistorySession(session) {
  const reviews = Array.isArray(session.reviews) ? session.reviews : [];
  const latest = reviews[0] || null;

  if (!latest) {
    return {
      badgeText: '기록만 있음',
      badgeClass: 'paused',
      summary: summarizeTask(session.taskContent),
    };
  }

  const meta = parseReviewMeta(latest.name, latest.content);
  if (meta.hasComplete) {
    return {
      badgeText: '완료',
      badgeClass: 'complete',
      summary: `${meta.agentLabel}가 완료 신호를 남겼습니다.`,
    };
  }

  if (meta.hasNeedsNext) {
    return {
      badgeText: '후속 필요',
      badgeClass: 'paused',
      summary: `${meta.agentLabel}가 후속 작업이 필요하다고 남겼습니다.`,
    };
  }

  if (meta.agent === 'claude') {
    return {
      badgeText: '검토 기록',
      badgeClass: 'running',
      summary: 'Claude Code의 최근 검토 로그가 남아 있습니다.',
    };
  }

  if (meta.agent === 'codex') {
    return {
      badgeText: '구현 기록',
      badgeClass: 'running',
      summary: 'Codex의 구현 로그가 남아 있습니다.',
    };
  }

  return {
    badgeText: meta.typeLabel,
    badgeClass: 'paused',
    summary: summarizeTask(session.taskContent),
  };
}

function summarizeResult(state, reviews) {
  const latestReview = reviews[0] || null;
  const hasFiles = Array.isArray(state.lastChangedFiles) && state.lastChangedFiles.length > 0;
  const changedSummary = hasFiles
    ? `${state.lastChangedFiles.length}개 파일 변경`
    : '변경 파일 없음';

  if (state.status === 'complete') {
    return {
      title: '최근 결과 요약',
      summary: state.lastSummary || '마지막 라운드가 완료로 판정되었습니다.',
      changedText: changedSummary,
      decisionText: '현재 판단: 작업 완료',
      nextAction: '결과를 검토한 뒤 다음 작업을 요청할 수 있습니다.',
    };
  }

  if (latestReview) {
    const meta = parseReviewMeta(latestReview.name, latestReview.content);
    const baseSummary = state.lastSummary || `${meta.agentLabel}의 ${meta.typeLabel.toLowerCase()}가 기록되었습니다.`;
    const decisionText = meta.hasComplete
      ? '현재 판단: 완료 신호 감지'
      : meta.hasNeedsNext
        ? '현재 판단: 후속 작업 필요'
        : `현재 판단: ${meta.typeLabel}`;

    return {
      title: '최근 결과 요약',
      summary: baseSummary,
      changedText: changedSummary,
      decisionText,
      nextAction: state.status === 'running'
        ? '다음 라운드가 진행 중입니다.'
        : mapStatus(state).nextAction,
    };
  }

  return {
    title: '최근 결과 요약',
    summary: '아직 표시할 검토 결과가 없습니다.',
    changedText: changedSummary,
    decisionText: '현재 판단: 대기 중',
    nextAction: '작업을 시작하면 최근 결과가 여기에 표시됩니다.',
  };
}

function deriveViewModel(state, reviews) {
  const statusView = mapStatus(state);
  const round = Number(state.round || 0);
  const maxRounds = Math.max(Number(state.maxRounds || 8), 1);
  const percent = clamp((round / maxRounds) * 100, 0, 100);

  return {
    status: statusView,
    roundLabel: `${round} / ${maxRounds} 라운드`,
    progressPercent: percent,
    updatedAtText: formatDate(state.updatedAt),
    agentText: formatAgent(state.lastAgent),
    result: summarizeResult(state, reviews),
  };
}

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;

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

function renderNav(container) {
  const nav = createElement('nav', { className: 'main-nav' });
  const dashboardLink = createElement('a', {
    className: `nav-link${currentPage === 'dashboard' ? ' nav-link--active' : ''}`,
    text: '대시보드',
  });
  const historyLink = createElement('a', {
    className: `nav-link${currentPage === 'history' ? ' nav-link--active' : ''}`,
    text: '작업 기록',
  });

  const previewLink = createElement('a', {
    className: `nav-link${currentPage === 'preview' ? ' nav-link--active' : ''}`,
    text: '미리보기',
  });

  dashboardLink.href = '#';
  historyLink.href = '#history';
  previewLink.href = '#preview';
  nav.append(dashboardLink, historyLink, previewLink);
  container.append(nav);
}

function renderHeader(container, viewModel) {
  const header = createElement('header', { className: 'dashboard-header' });
  const titleGroup = createElement('div', { className: 'title-group' });
  const prompt = createElement('span', { className: 'prompt', text: 'duo-agent@monitor:~$' });
  const title = createElement('h1', { text: '작업 진행 현황' });
  const badge = createElement('span', {
    className: `status-badge status-badge--${viewModel.status.badgeClass}`,
    text: viewModel.status.badgeText,
  });

  titleGroup.append(prompt, title);
  header.append(titleGroup, badge);
  container.append(header);
}

function renderStatusSummary(container, state, viewModel) {
  const panel = createElement('section', { className: 'summary-panel' });
  const body = createElement('div', { className: 'summary-panel__body' });
  const meta = createElement('div', { className: 'metrics-grid' });

  body.append(
    createElement('p', { className: 'summary-eyebrow', text: '현재 상태' }),
    createElement('h2', { text: viewModel.status.title }),
    createElement('p', { className: 'summary-description', text: viewModel.status.description }),
    createElement('p', { className: 'summary-next-action', text: viewModel.status.nextAction }),
  );

  meta.append(
    createMetric('현재 담당', viewModel.agentText),
    createMetric('마지막 업데이트', viewModel.updatedAtText),
  );

  panel.append(body, meta);

  if (state.currentTask) {
    const taskPreview = createElement('div', { className: 'task-preview' });
    taskPreview.append(
      createElement('span', { className: 'task-preview__label', text: '현재 요청' }),
      createElement('pre', { className: 'task-preview__content', text: state.currentTask }),
    );
    panel.append(taskPreview);
  }

  container.append(panel);
}

function renderProgress(container, viewModel) {
  const section = createElement('section', { className: 'progress-panel' });
  const header = createElement('div', { className: 'progress-header' });
  const helper = createElement('p', {
    className: 'progress-helper',
    text: '이 작업은 구현과 검토를 번갈아 진행합니다.',
  });
  const track = createElement('div', { className: 'progress-track' });
  const fill = createElement('div', { className: 'progress-fill' });

  header.append(
    createElement('span', { text: '검토 라운드' }),
    createElement('strong', { text: viewModel.roundLabel }),
  );

  fill.style.width = `${viewModel.progressPercent}%`;
  fill.setAttribute('aria-label', `검토 라운드 ${Math.round(viewModel.progressPercent)}%`);
  track.append(fill);
  section.append(header, helper, track);
  container.append(section);
}

function renderResultSummary(container, viewModel) {
  const panel = createElement('section', { className: 'result-panel' });
  const header = createElement('div', { className: 'section-header' });
  const result = viewModel.result;

  header.append(
    createElement('h2', { text: result.title }),
    createElement('span', { text: result.changedText }),
  );

  panel.append(
    header,
    createElement('p', { className: 'result-summary', text: result.summary }),
  );

  container.append(panel);
}

function renderKickPanel(container, state) {
  const status = getStatus(state);
  const currentProjectName = String(state.projectName || '').trim();
  const panel = createElement('section', { className: 'kick-panel' });
  const header = createElement('div', { className: 'section-header' });
  const form = createElement('form', { className: 'kick-form' });
  const projectField = createElement('label', { className: 'form-field' });
  const projectLabel = createElement('span', { className: 'form-field__label', text: '프로젝트 이름' });
  const projectInput = createElement('input', { className: 'form-input' });
  const goalField = createElement('label', { className: 'form-field' });
  const goalLabel = createElement('span', { className: 'form-field__label', text: '무엇을 만들거나 수정할지' });
  const goalInput = createElement('textarea', { className: 'form-textarea' });
  const stackField = createElement('label', { className: 'form-field' });
  const stackLabel = createElement('span', { className: 'form-field__label', text: '기술 스택' });
  const stackInput = createElement('input', { className: 'form-input' });
  const rulesField = createElement('label', { className: 'form-field' });
  const rulesLabel = createElement('span', { className: 'form-field__label', text: '제약 조건' });
  const rulesInput = createElement('textarea', { className: 'form-textarea' });
  const checklistField = createElement('div', { className: 'form-field' });
  const checklistLabel = createElement('span', { className: 'form-field__label', text: '완료 기준 체크리스트' });
  const checklistHelp = createElement('p', {
    className: 'form-help',
    text: '완료로 보기 전에 확인할 항목을 적어둘 수 있습니다.',
  });
  const checklistItems = createElement('div', { className: 'checklist-inputs' });
  const actions = createElement('div', { className: 'control-actions' });
  const kickButton = createElement('button', {
    className: 'control-button control-button--kick',
    text: pendingAction === 'kick' ? '시작 중...' : '작업 시작',
  });
  const stopButton = createElement('button', {
    className: 'control-button control-button--stop',
    text: pendingAction === 'stop' ? '중단 중...' : '작업 중단',
  });
  const isRunning = status === 'running';
  const isBusy = Boolean(pendingAction);
  const isFormDisabled = isRunning || isBusy;
  const needsProjectName = !currentProjectName;
  const canSubmitKick = () => {
    const hasProjectName = !needsProjectName || kickForm.projectName.trim().length > 0;
    return kickForm.goal.trim().length > 0 && hasProjectName && !isFormDisabled;
  };

  header.append(
    createElement('h2', { text: '작업 요청' }),
    createElement('span', { text: isRunning ? '현재 작업 진행 중' : '새 작업 입력 가능' }),
  );

  projectInput.type = 'text';
  projectInput.name = 'projectName';
  projectInput.placeholder = '예: 퍼즐 게임';
  projectInput.value = currentProjectName || kickForm.projectName;
  projectInput.disabled = isFormDisabled || Boolean(currentProjectName);
  projectInput.addEventListener('input', (event) => {
    kickForm.projectName = event.target.value;
    kickButton.disabled = !canSubmitKick();
  });
  projectField.append(projectLabel, projectInput);

  goalInput.name = 'goal';
  goalInput.rows = 5;
  goalInput.placeholder = '예: 사용자 프로필 수정 화면을 만들고 저장 API와 연결해 주세요';
  goalInput.value = kickForm.goal;
  goalInput.disabled = isFormDisabled;
  goalInput.addEventListener('input', (event) => {
    kickForm.goal = event.target.value;
    kickButton.disabled = !canSubmitKick();
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
  rulesInput.placeholder = '예: 기존 API 유지, 테스트 포함, 모바일 대응';
  rulesInput.value = kickForm.rules;
  rulesInput.disabled = isFormDisabled;
  rulesInput.addEventListener('input', (event) => {
    kickForm.rules = event.target.value;
  });
  rulesField.append(rulesLabel, rulesInput);

  kickForm.checklist.forEach((item, index) => {
    const row = createElement('div', { className: 'checklist-row' });
    const input = createElement('input', { className: 'form-input' });
    const removeButton = createElement('button', {
      className: 'checklist-remove-btn',
      text: '삭제',
    });

    input.type = 'text';
    input.value = item;
    input.placeholder = `체크 항목 ${index + 1}`;
    input.disabled = isFormDisabled;
    input.addEventListener('input', (event) => {
      kickForm.checklist[index] = event.target.value;
    });

    removeButton.type = 'button';
    removeButton.disabled = isFormDisabled;
    removeButton.addEventListener('click', () => {
      kickForm.checklist.splice(index, 1);
      render();
    });

    row.append(input, removeButton);
    checklistItems.append(row);
  });

  const addItemButton = createElement('button', {
    className: 'checklist-add-btn',
    text: '+ 체크 항목 추가',
  });
  addItemButton.type = 'button';
  addItemButton.disabled = isFormDisabled;
  addItemButton.addEventListener('click', () => {
    kickForm.checklist.push('');
    render();
  });

  checklistField.append(checklistLabel, checklistHelp, checklistItems, addItemButton);

  kickButton.type = 'submit';
  kickButton.disabled = !canSubmitKick();

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
  form.append(projectField, goalField, stackField, rulesField, checklistField, actions);
  panel.append(header, form);

  if (isRunning) {
    panel.append(createElement('p', {
      className: 'form-help form-help--notice',
      text: '작업이 진행 중이라 새 요청 입력이 잠시 비활성화되었습니다.',
    }));
    panel.append(createElement('p', {
      className: 'form-help',
      text: '중단을 누르면 현재 라운드를 마친 뒤 자동 진행이 멈춥니다.',
    }));
  }

  if (controlError) {
    panel.append(createElement('p', {
      className: 'control-error',
      text: controlError,
    }));
  }

  container.append(panel);
}


function buildReviewItem(review) {
  const meta = parseReviewMeta(review.name, review.content);
  const details = createElement('details', { className: 'review-item' });
  const summaryEl = createElement('summary');
  const summaryLeft = createElement('div', { className: 'review-summary-main' });
  const nameEl = createElement('span', { className: 'review-name', text: formatReviewName(review.name) });
  const typeEl = createElement('span', { className: 'review-type', text: meta.typeLabel });
  const hint = createElement('span', { className: 'review-hint', text: '열기' });

  details.open = openReviews.has(review.name);
  hint.textContent = details.open ? '닫기' : '열기';
  details.addEventListener('toggle', () => {
    if (details.open) openReviews.add(review.name);
    else openReviews.delete(review.name);
    hint.textContent = details.open ? '닫기' : '열기';
  });

  summaryLeft.append(nameEl, typeEl);
  summaryEl.append(summaryLeft, hint);
  details.append(summaryEl);

  details.append(createElement('pre', { text: review.content || '(empty)' }));

  return details;
}

function renderReviewDetails(container, reviews) {
  const section = createElement('section', { className: 'reviews-panel' });
  const header = createElement('div', { className: 'section-header' });

  header.append(
    createElement('h2', { text: '검토 결과 상세' }),
    createElement('span', { text: `${reviews.length}개` }),
  );

  section.append(header);

  if (!reviews.length) {
    section.append(createElement('p', {
      className: 'empty-state',
      text: '아직 표시할 검토 결과가 없습니다.',
    }));
    container.append(section);
    return;
  }

  const list = createElement('div', { className: 'review-list' });
  reviews.forEach((review) => {
    list.append(buildReviewItem(review));
  });

  section.append(list);
  container.append(section);
}

function renderChecklist(container, state) {
  const items = Array.isArray(state.checklist) ? state.checklist : [];
  if (!items.length) return;

  const section = createElement('section', { className: 'checklist-panel' });
  const header = createElement('div', { className: 'section-header' });
  const list = createElement('ol', { className: 'checklist-list' });

  header.append(
    createElement('h2', { text: '완료 체크리스트' }),
    createElement('span', { text: `${items.length}개` }),
  );

  items.forEach((item) => {
    list.append(createElement('li', {
      className: 'checklist-list-item',
      text: item,
    }));
  });

  section.append(
    header,
    createElement('p', {
      className: 'form-help',
      text: '작업 완료 전에 아래 항목을 확인하세요.',
    }),
    list,
  );
  container.append(section);
}

function buildResetModal() {
  const overlay = createElement('div', { className: 'modal-overlay' });
  const card = createElement('div', { className: 'modal-card' });
  const title = createElement('h2', { className: 'modal-title', text: '프로젝트 초기화' });
  const body = createElement('p', {
    className: 'modal-body',
    text: 'src/ 생성 파일과 작업 내역이 모두 삭제됩니다. 초기화 후에는 되돌릴 수 없습니다.',
  });
  const actions = createElement('div', { className: 'modal-actions' });
  const cancelButton = createElement('button', {
    className: 'control-button',
    text: '취소',
  });
  const confirmButton = createElement('button', {
    className: 'control-button control-button--stop',
    text: pendingAction === 'reset' ? '초기화 중...' : '초기화 확인',
  });

  cancelButton.type = 'button';
  cancelButton.disabled = Boolean(pendingAction);
  cancelButton.addEventListener('click', () => {
    confirmReset = false;
    render();
  });

  confirmButton.type = 'button';
  confirmButton.disabled = Boolean(pendingAction);
  confirmButton.addEventListener('click', resetProject);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && !pendingAction) {
      confirmReset = false;
      render();
    }
  });

  actions.append(cancelButton, confirmButton);
  card.append(title, body, actions);
  overlay.append(card);
  return overlay;
}

function renderProjectPanel(container, state) {
  const status = getStatus(state);
  const isRunning = status === 'running';
  const isBusy = Boolean(pendingAction);
  const panel = createElement('section', { className: 'project-panel' });
  const header = createElement('div', { className: 'section-header' });

  header.append(
    createElement('h2', { text: '프로젝트 관리' }),
    createElement('span', { text: 'src/ 파일 관리' }),
  );

  const downloadButton = createElement('button', {
    className: 'control-button control-button--kick',
    text: 'ZIP 다운로드',
  });
  downloadButton.type = 'button';
  downloadButton.disabled = isBusy;
  downloadButton.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/download-src';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  const resetButton = createElement('button', {
    className: 'control-button control-button--stop',
    text: '초기화',
  });
  resetButton.type = 'button';
  resetButton.disabled = isBusy || isRunning;
  resetButton.addEventListener('click', () => {
    confirmReset = true;
    render();
  });

  const actions = createElement('div', { className: 'control-actions' });
  actions.append(downloadButton, resetButton);
  panel.append(header, actions);

  if (isRunning) {
    panel.append(createElement('p', {
      className: 'form-help form-help--notice',
      text: '작업이 진행 중일 때는 초기화할 수 없습니다.',
    }));
  }

  container.append(panel);
}

async function resetProject() {
  if (pendingAction) return;

  pendingAction = 'reset';
  controlError = null;
  render();

  try {
    await postJson('/api/reset');
    confirmReset = false;
    kickForm = { projectName: '', goal: '', stack: '', rules: '', checklist: [] };
    controlError = null;
    openReviews.clear();
    await refreshDashboard();
  } catch (error) {
    controlError = getUserFacingErrorMessage(error instanceof Error ? error.message : '');
    confirmReset = false;
    render();
  } finally {
    pendingAction = null;
    render();
  }
}

function renderHistoryPage(container) {
  const section = createElement('section', { className: 'history-panel' });
  const header = createElement('div', { className: 'section-header' });

  header.append(
    createElement('h2', { text: '작업 기록' }),
    createElement('span', { text: `${currentHistory.length}개 세션` }),
  );
  section.append(header);

  if (!currentHistory.length) {
    section.append(createElement('p', {
      className: 'empty-state',
      text: '작업을 시작하면 여기에 기록이 쌓입니다.',
    }));
    container.append(section);
    return;
  }

  const list = createElement('div', { className: 'history-list' });
  currentHistory.forEach((session) => {
    const sessionSummary = summarizeHistorySession(session);
    const sessionEl = createElement('details', { className: 'history-session' });
    const summaryEl = createElement('summary', { className: 'session-summary' });
    const taskSummary = summarizeTask(session.taskContent);
    const summaryMain = createElement('div', { className: 'session-summary-main' });
    const badge = createElement('span', {
      className: `inline-badge inline-badge--${sessionSummary.badgeClass}`,
      text: sessionSummary.badgeText,
    });

    summaryMain.append(
      createElement('span', { className: 'session-time', text: formatSessionTimestamp(session.taskTimestamp) }),
      createElement('span', { className: 'session-summary-text', text: sessionSummary.summary }),
    );
    summaryEl.append(
      summaryMain,
      createElement('div', { className: 'session-summary-meta' }),
    );
    summaryEl.lastChild.append(
      badge,
      createElement('span', { className: 'session-count', text: `${session.reviews.length}개 로그` }),
    );
    sessionEl.append(summaryEl);

    if (session.taskContent) {
      const taskBlock = createElement('div', { className: 'session-task' });
      taskBlock.append(
        createElement('div', { className: 'session-task__label', text: '요청 요약' }),
        createElement('p', { className: 'session-task__summary', text: taskSummary }),
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

function renderPreviewPage(container) {
  const section = createElement('section', { className: 'preview-panel' });
  const header = createElement('div', { className: 'section-header' });
  const projectName = currentState.projectName || '미리보기';

  header.append(
    createElement('h2', { text: projectName }),
    createElement('span', { text: currentState.projectName ? '실행 중' : '결과물 없음' }),
  );

  const actions = createElement('div', { className: 'preview-actions' });
  const openLink = createElement('a', {
    className: 'control-button control-button--kick',
    text: '새 탭에서 열기 ↗',
  });
  openLink.href = '/game';
  openLink.target = '_blank';
  openLink.rel = 'noopener';

  const downloadButton = createElement('button', {
    className: 'control-button',
    text: 'ZIP 다운로드',
  });
  downloadButton.type = 'button';
  downloadButton.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/download-src';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  const fullscreenButton = createElement('button', {
    className: 'control-button',
    text: '전체 화면',
  });
  fullscreenButton.type = 'button';
  fullscreenButton.addEventListener('click', () => {
    if (frame.requestFullscreen) frame.requestFullscreen();
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
  });

  actions.append(openLink, downloadButton, fullscreenButton);

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.src = '/game';
  frame.title = projectName;

  section.append(header, actions, frame);
  container.append(section);
}

function renderError(container) {
  if (!loadError) return;

  container.append(createElement('p', {
    className: 'load-error',
    text: `데이터를 불러오는 중 문제가 발생했습니다: ${getUserFacingErrorMessage(loadError)}`,
  }));
}

function renderDashboardPage(container) {
  const viewModel = deriveViewModel(currentState, currentReviews);
  const columns = createElement('div', { className: 'dashboard-columns' });
  const primary = createElement('div', { className: 'dashboard-col' });
  const secondary = createElement('div', { className: 'dashboard-col' });

  renderHeader(container, viewModel);
  renderStatusSummary(container, currentState, viewModel);

  renderKickPanel(primary, currentState);
  renderChecklist(primary, currentState);
  renderProjectPanel(primary, currentState);

  renderProgress(secondary, viewModel);
  renderResultSummary(secondary, viewModel);
  renderReviewDetails(secondary, currentReviews);

  columns.append(primary, secondary);
  container.append(columns);
  renderError(container);
}

function render() {
  const fragment = document.createDocumentFragment();
  const shell = createElement('div', { className: 'dashboard-shell' });

  renderNav(shell);

  if (currentPage === 'history') renderHistoryPage(shell);
  else if (currentPage === 'preview') renderPreviewPage(shell);
  else renderDashboardPage(shell);

  fragment.append(shell);
  if (confirmReset) fragment.append(buildResetModal());
  app.replaceChildren(fragment);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${url} ${response.status}`);
  }

  return payload;
}

async function kickAgent() {
  const projectName = kickForm.projectName.trim() || String(currentState.projectName || '').trim();
  const goal = kickForm.goal.trim();
  const stack = kickForm.stack.trim();
  const rules = kickForm.rules.trim();

  if (!projectName || !goal || pendingAction || getStatus(currentState) === 'running') return;

  const task = [
    `goal: ${goal}`,
    stack ? `stack: ${stack}` : null,
    rules ? `rules: ${rules}` : null,
  ].filter(Boolean).join('\n');

  pendingAction = 'kick';
  controlError = null;
  render();

  try {
    await postJson('/api/kick', {
      projectName,
      task,
      checklist: kickForm.checklist.filter((item) => item.trim()),
    });
    kickForm = {
      projectName: '',
      goal: '',
      stack: '',
      rules: '',
      checklist: [],
    };
    await refreshDashboard();
  } catch (error) {
    controlError = getUserFacingErrorMessage(error instanceof Error ? error.message : '');
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
    controlError = getUserFacingErrorMessage(error instanceof Error ? error.message : '');
    render();
  } finally {
    pendingAction = null;
    render();
  }
}


async function refreshDashboard() {
  try {
    if (currentPage === 'history') {
      const [state, history] = await Promise.all([
        fetchJson('/api/state'),
        fetchJson('/api/history'),
      ]);
      currentState = state;
      currentHistory = Array.isArray(history) ? history : [];
    } else {
      const [state, reviews] = await Promise.all([
        fetchJson('/api/state'),
        fetchJson('/api/reviews'),
      ]);
      currentState = state;
      currentReviews = Array.isArray(reviews) ? reviews : [];
    }

    loadError = null;
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'unknown error';
  }

  const active = document.activeElement;
  const isTyping = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
  if (!isTyping && currentPage !== 'preview') render();
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
      width: fit-content;
      border: 1px solid var(--border-soft);
      background: var(--panel-bg);
    }

    .nav-link {
      display: block;
      padding: 10px 18px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 700;
      border-right: 1px solid var(--border-soft);
    }

    .nav-link:last-child {
      border-right: none;
    }

    .nav-link:hover,
    .nav-link--active {
      color: var(--accent-strong);
      background: var(--bg-wash);
    }

    .dashboard-header,
    .summary-panel,
    .kick-panel,
    .progress-panel,
    .result-panel,
    .reviews-panel,
    .checklist-panel,
    .history-panel,
    .project-panel,
    .preview-panel {
      border: 1px solid var(--border-soft);
      background: linear-gradient(180deg, var(--panel-bg) 0%, var(--panel-bg-alt) 100%);
      box-shadow: 0 0 0 1px rgba(160, 132, 92, 0.06), 0 18px 40px rgba(96, 71, 45, 0.1);
    }

    .dashboard-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 18px;
      padding: 22px;
    }

    .title-group {
      min-width: 0;
    }

    .prompt,
    .metric__label,
    .section-header span,
    .form-field__label,
    .summary-eyebrow,
    .task-preview__label,
    .session-task__label,
    .review-hint {
      color: var(--accent);
      font-size: 0.78rem;
      text-transform: uppercase;
    }

    h1,
    h2 {
      margin: 0;
      color: var(--text-strong);
    }

    h1 {
      margin-top: 8px;
      font-size: clamp(1.8rem, 5vw, 3.4rem);
      line-height: 1;
    }

    h2 {
      font-size: 1.08rem;
    }

    .status-badge {
      min-width: 110px;
      border: 1px solid currentColor;
      padding: 10px 14px;
      text-align: center;
      font-weight: 700;
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

    .summary-panel,
    .kick-panel,
    .progress-panel,
    .result-panel,
    .reviews-panel,
    .checklist-panel,
    .history-panel,
    .project-panel,
    .preview-panel {
      padding: 18px;
    }

    .project-panel {
      display: grid;
      gap: 12px;
    }

    .summary-panel {
      display: grid;
      gap: 18px;
    }

    .summary-panel__body {
      display: grid;
      gap: 8px;
    }

    .summary-eyebrow,
    .summary-description,
    .summary-next-action,
    .result-summary,
    .progress-helper,
    .form-help,
    .session-task__summary {
      margin: 0;
      line-height: 1.6;
    }

    .summary-description,
    .result-summary,
    .session-task__summary {
      color: var(--text-strong);
    }

    .summary-next-action,
    .progress-helper,
    .form-help {
      color: var(--text-muted);
    }

    .form-help--notice {
      color: var(--accent-strong);
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }

    .metric {
      min-height: 110px;
      padding: 18px;
      border: 1px solid var(--border-soft);
      background: rgba(255, 253, 250, 0.8);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 18px;
    }

    .metric__value {
      color: var(--text-strong);
      font-size: 1rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .task-preview {
      display: grid;
      gap: 8px;
    }

    .task-preview__content {
      max-height: 160px;
      margin: 0;
      overflow: auto;
      border: 1px solid var(--border-soft);
      padding: 14px;
      background: var(--pre-bg);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
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

    .section-header,
    .progress-header,
    summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
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

    .control-error,
    .load-error {
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

    .result-panel {
      display: grid;
      gap: 12px;
    }

    .review-list,
    .history-list,
    .session-reviews {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    .review-item,
    .history-session {
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

    .review-summary-main {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .review-name {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .review-type {
      color: var(--text-muted);
      font-size: 0.85rem;
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

    .checklist-list {
      margin: 0;
      padding-left: 22px;
      display: grid;
      gap: 8px;
    }

    .checklist-list-item {
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

    .checklist-remove-btn,
    .checklist-add-btn {
      border: 1px solid var(--border-strong);
      background: transparent;
      color: var(--text-base);
      cursor: pointer;
      font: inherit;
      padding: 8px 12px;
    }

    .checklist-add-btn {
      border-style: dashed;
      color: var(--accent-strong);
      text-align: left;
    }

    .checklist-remove-btn:hover:not(:disabled),
    .checklist-add-btn:hover:not(:disabled) {
      background: rgba(196, 168, 130, 0.16);
    }

    .checklist-remove-btn:disabled,
    .checklist-add-btn:disabled {
      cursor: not-allowed;
      color: var(--text-muted);
    }

    .history-panel {
      display: grid;
      gap: 4px;
    }

    .preview-panel {
      display: grid;
      gap: 14px;
    }

    .preview-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .preview-actions .control-button {
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }

    .preview-frame {
      width: 100%;
      min-height: 600px;
      border: 1px solid var(--border-soft);
      background: #fff;
    }

    .session-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .session-summary-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .session-summary-text {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .session-summary-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .session-time {
      color: var(--text-strong);
      font-weight: 700;
    }

    .session-count {
      color: var(--accent);
      font-size: 0.82rem;
    }

    .inline-badge {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid currentColor;
      font-size: 0.78rem;
      font-weight: 700;
      white-space: nowrap;
    }

    .inline-badge--running {
      color: var(--accent-strong);
      background: rgba(139, 111, 71, 0.12);
    }

    .inline-badge--complete {
      color: var(--accent);
      background: rgba(160, 132, 92, 0.14);
    }

    .inline-badge--paused {
      color: var(--accent-soft);
      background: rgba(196, 168, 130, 0.18);
    }

    .inline-badge--error {
      color: var(--error);
      background: rgba(140, 90, 75, 0.12);
    }

    .session-task {
      border-top: 1px solid var(--border-soft);
      padding: 14px;
      background: var(--bg-wash);
      display: grid;
      gap: 8px;
    }

    .session-task__content {
      max-height: 140px;
      border: none;
      padding: 0;
      background: transparent;
    }

    .empty-state {
      margin: 0;
      color: var(--text-muted);
      line-height: 1.6;
    }

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(61, 43, 31, 0.52);
      display: grid;
      place-items: center;
      z-index: 1000;
    }

    .modal-card {
      width: min(100% - 40px, 440px);
      padding: 28px;
      border: 1px solid var(--border-strong);
      background: var(--panel-bg);
      box-shadow: 0 8px 40px rgba(61, 43, 31, 0.28);
      display: grid;
      gap: 18px;
    }

    .modal-title {
      margin: 0;
      font-size: 1.1rem;
      color: var(--text-strong);
    }

    .modal-body {
      margin: 0;
      color: var(--text-base);
      line-height: 1.65;
    }

    .modal-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }

    @media (max-width: 860px) {
      #app {
        width: min(100% - 20px, 1120px);
        padding: 18px 0;
      }

      .dashboard-columns,
      .metrics-grid {
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
    }
  `;
  document.head.append(style);
}

window.addEventListener('hashchange', () => {
  currentPage = window.location.hash === '#history' ? 'history' : window.location.hash === '#preview' ? 'preview' : 'dashboard';
  refreshDashboard();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && confirmReset && !pendingAction) {
    confirmReset = false;
    render();
  }
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
