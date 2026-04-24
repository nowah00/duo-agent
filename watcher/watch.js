const chokidar = require('chokidar');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildPrompt: buildProjectPrompt } = require('./prompt.config');

const ROOT_DIR = path.resolve(__dirname, '..');

const CONFIG = {
  watchDir: path.join(ROOT_DIR, 'src'),
  reviewsDir: path.join(ROOT_DIR, 'reviews'),
  statePath: path.join(__dirname, 'state.json'),
  donePath: path.join(ROOT_DIR, 'TASK_DONE.md'),
  triggerPath: path.join(__dirname, '.kick-trigger'),
  goalsPath: path.join(__dirname, 'task-goals.json'),
  debounceMs: Number(process.env.WATCH_DEBOUNCE_MS || 3000),
  maxRounds: Number(process.env.AGENT_MAX_ROUNDS || 8),
  maxRetries: Number(process.env.AGENT_MAX_RETRIES || 1),
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 600000),
  extensions: new Set(['.js', '.ts', '.json', '.css', '.html']),
  agentA: process.env.AGENT_A || 'codex',   // 구현 담당 (role 'a')
  agentB: process.env.AGENT_B || 'claude',  // 리뷰 담당 (role 'b')
};

// 에이전트 구현체 레지스트리 — 키만 추가하면 새 에이전트 지원 가능
const AGENT_REGISTRY = {
  claude: {
    label: 'Claude Code',
    command: process.env.CLAUDE_CMD || 'claude',
    args() {
      const allowedTools = process.env.CLAUDE_ALLOWED_TOOLS || 'Read,Edit,Bash(npm run build),Bash(npm test)';
      return [
        '--print',
        '--allowedTools',
        allowedTools,
        '--permission-mode',
        'acceptEdits',
      ];
    },
  },
  codex: {
    label: 'Codex',
    command: process.env.CODEX_CMD || 'codex',
    args() {
      return [
        'exec',
        '--cd',
        ROOT_DIR,
        '--sandbox',
        'workspace-write',
      ];
    },
  },
};

const timers = new Map();
let running = false;
let queuedReason = null;

// role 'a' | 'b' → 에이전트 설정 반환
function getAgent(role) {
  const key = role === 'a' ? CONFIG.agentA : CONFIG.agentB;
  const agent = AGENT_REGISTRY[key];
  if (!agent) throw new Error(`알 수 없는 에이전트 키: ${key}`);
  return { ...agent, key };
}

function nextRole(lastRole) {
  if (!lastRole) return 'a';
  return lastRole === 'a' ? 'b' : 'a';
}

// 이전 state(lastAgent 기반)에서 lastRole을 추론 — 하위 호환
function deriveRole(lastAgent) {
  if (!lastAgent) return null;
  if (lastAgent === CONFIG.agentA) return 'a';
  if (lastAgent === CONFIG.agentB) return 'b';
  return null;
}

function ensureDirs() {
  fs.mkdirSync(CONFIG.reviewsDir, { recursive: true });
  fs.mkdirSync(CONFIG.watchDir, { recursive: true });
}

function log(message) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  console.log(`[${time}] ${message}`);
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}초`;
  if (sec === 0) return `${min}분`;
  return `${min}분 ${sec}초`;
}

function readState() {
  const defaults = { round: 0, lastRole: null, lastAgent: null, status: 'idle', updatedAt: null, lastReason: null, retries: 0 };

  if (!fs.existsSync(CONFIG.statePath)) return defaults;

  try {
    const state = JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8'));
    // lastRole 없는 이전 state → lastAgent에서 추론
    const lastRole = state.lastRole ?? deriveRole(state.lastAgent);
    return { ...defaults, ...state, lastRole };
  } catch {
    return { ...defaults, lastReason: 'state reset after invalid JSON' };
  }
}

function writeState(nextState) {
  const data = JSON.stringify({ ...nextState, updatedAt: new Date().toISOString() }, null, 2);
  const tmpPath = CONFIG.statePath + '.tmp';
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, CONFIG.statePath);
}

function listSourceFiles(dir = CONFIG.watchDir) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (CONFIG.extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function sourceFingerprint() {
  const hash = crypto.createHash('sha256');

  for (const filePath of listSourceFiles()) {
    const relative = path.relative(ROOT_DIR, filePath);
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }

  return hash.digest('hex');
}

function saveReview(agentKey, output) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reviewPath = path.join(CONFIG.reviewsDir, `${timestamp}_${agentKey}.md`);
  fs.writeFileSync(reviewPath, output.trim() ? output : '(no output)');
  log(`결과 저장: ${path.relative(ROOT_DIR, reviewPath)}`);
}

function lastLines(text, n = 20) {
  return text.split('\n').slice(-n).join('\n');
}

// 마지막 줄에서 JSON 상태 파싱 시도
// 에이전트가 {"status":"COMPLETE","summary":"..."} 형태로 출력하면 신뢰도 높은 파싱
function parseStatusJson(output) {
  const lines = output.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    try {
      const parsed = JSON.parse(lines[i].trim());
      if (typeof parsed.status === 'string') {
        return {
          status: parsed.status.toUpperCase(),
          summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        };
      }
    } catch {}
  }
  return null;
}

// JSON 파싱 우선, 실패 시 텍스트 regex로 fallback
function getOutputStatus(output) {
  const json = parseStatusJson(output);
  if (json) return json;

  const tail = lastLines(output);
  if (/STATUS:\s*COMPLETE/i.test(tail)) return { status: 'COMPLETE', summary: '' };
  if (/STATUS:\s*NEEDS_NEXT/i.test(tail)) return { status: 'NEEDS_NEXT', summary: '' };
  return null;
}

function buildPrompt(role, reason, state) {
  const agent = getAgent(role);
  const peer = getAgent(role === 'a' ? 'b' : 'a');

  return buildProjectPrompt({
    role,
    agentLabel: agent.label,
    peerLabel: peer.label,
    rootDir: ROOT_DIR,
    reason,
    round: state.round + 1,
    maxRounds: CONFIG.maxRounds,
  });
}

function runAgent(role, reason) {
  if (fs.existsSync(CONFIG.donePath)) {
    log(`완료 파일이 있어 실행하지 않음: ${path.relative(ROOT_DIR, CONFIG.donePath)}`);
    return;
  }

  if (running) {
    queuedReason = reason;
    log(`실행 중이라 다음 라운드로 예약: ${reason}`);
    return;
  }

  const state = readState();
  if (state.round >= CONFIG.maxRounds) {
    writeState({ ...state, status: 'paused', lastReason: 'max rounds reached' });
    log(`최대 라운드(${CONFIG.maxRounds})에 도달해 멈춤`);
    return;
  }

  const agent = getAgent(role);
  const prompt = buildPrompt(role, reason, state);
  const beforeHash = sourceFingerprint();
  const nextState = {
    ...state,
    round: state.round + 1,
    lastRole: role,
    lastAgent: agent.key,
    status: 'running',
    lastReason: reason,
    retries: state.retries || 0,
  };

  writeState(nextState);
  running = true;
  queuedReason = null;

  log(`${agent.label} 실행 시작 (${nextState.round}/${CONFIG.maxRounds}) [role:${role}]`);

  const child = spawn(agent.command, agent.args(), {
    cwd: ROOT_DIR,
    shell: process.platform === 'win32',
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.on('error', () => {});
  child.stdin.write(prompt, 'utf8');
  child.stdin.end();

  let output = '';

  const timeoutId = setTimeout(() => {
    log(`${agent.label} 시간 초과 (${formatDuration(CONFIG.agentTimeoutMs)}) — 강제 종료`);
    child.kill();
  }, CONFIG.agentTimeoutMs);

  child.on('error', (err) => {
    clearTimeout(timeoutId);
    running = false;
    log(`${agent.label} 실행 실패: ${err.message}`);
    writeState({ ...readState(), status: 'error', lastReason: err.message });
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  child.on('close', (code) => {
    clearTimeout(timeoutId);
    running = false;
    saveReview(agent.key, output);

    const afterHash = sourceFingerprint();
    const changed = beforeHash !== afterHash;
    const parsed = getOutputStatus(output);
    const complete = parsed?.status === 'COMPLETE';
    const needsNext = parsed?.status === 'NEEDS_NEXT';
    const summary = parsed?.summary || '';
    const latestState = readState();

    // 리뷰어(role 'b')만 루프를 종료할 수 있음
    if (complete && role === 'b') {
      const doneText = [
        '# Task Done',
        '',
        `Completed by: ${agent.label}`,
        `Round: ${latestState.round}/${CONFIG.maxRounds}`,
        `Exit code: ${code}`,
        `Changed source: ${changed ? 'yes' : 'no'}`,
        summary ? `Summary: ${summary}` : null,
        `Completed at: ${new Date().toLocaleString('ko-KR')}`,
        '',
        '사용자가 최종 확인할 단계입니다.',
      ].filter(l => l !== null).join('\n');

      fs.writeFileSync(CONFIG.donePath, doneText);
      writeState({ ...latestState, status: 'complete', lastSummary: summary, lastReason: 'agent reported complete', retries: 0 });
      log(`완료됨: ${path.relative(ROOT_DIR, CONFIG.donePath)}`);
      return;
    }

    if (complete && role !== 'b') {
      log(`${agent.label}가 COMPLETE를 출력했지만 리뷰어 확인이 필요해 다음 라운드로 넘김`);
    }

    if (latestState.round >= CONFIG.maxRounds) {
      writeState({ ...latestState, status: 'paused', lastReason: 'max rounds reached', retries: 0 });
      log(`최대 라운드(${CONFIG.maxRounds})에 도달해 사용자 확인 대기`);
      return;
    }

    // 실패 시 재시도
    if (code !== 0 && !changed) {
      const retries = latestState.retries || 0;
      if (retries < CONFIG.maxRetries) {
        writeState({ ...latestState, status: 'running', lastReason: `retry ${retries + 1}/${CONFIG.maxRetries}`, retries: retries + 1 });
        log(`${agent.label} 실패 — 재시도 (${retries + 1}/${CONFIG.maxRetries})`);
        setTimeout(() => runAgent(role, `retry: ${reason}`), CONFIG.debounceMs);
        return;
      }
      writeState({ ...latestState, status: 'error', lastReason: `${agent.label} exit ${code}`, retries: 0 });
      log(`${agent.label}가 실패했고 재시도 횟수 초과 — 멈춤`);
      return;
    }

    // 변경도 없고 계속 신호도 없으면 대기
    if (!changed && !needsNext) {
      writeState({ ...latestState, status: 'paused', lastReason: 'no changes and no NEEDS_NEXT', retries: 0 });
      log('변경 없음 + 상태 미출력 — 사용자 확인 대기');
      return;
    }

    const followUpReason = queuedReason || `${agent.label} completed; changed=${changed}`;
    writeState({ ...latestState, lastSummary: summary, retries: 0 });
    setTimeout(() => runAgent(nextRole(role), followUpReason), CONFIG.debounceMs);
  });
}

function schedule(reason) {
  clearTimeout(timers.get('main'));
  timers.set(
    'main',
    setTimeout(() => {
      const state = readState();
      runAgent(nextRole(state.lastRole), reason);
    }, CONFIG.debounceMs),
  );
}

function handleChange(filePath) {
  const ext = path.extname(filePath);
  if (!CONFIG.extensions.has(ext)) return;

  const relative = path.relative(ROOT_DIR, filePath);
  schedule(`file changed: ${relative}`);
}

function buildPreFlightPrompt(task) {
  const agentALabel = AGENT_REGISTRY[CONFIG.agentA]?.label || CONFIG.agentA;
  const agentBLabel = AGENT_REGISTRY[CONFIG.agentB]?.label || CONFIG.agentB;

  return [
    '다음은 사용자가 입력한 작업 지시다.',
    '',
    task,
    '',
    '이 내용을 분석해서 아래 JSON 형식만 출력하라. 설명 없이 JSON만 출력할 것.',
    '{',
    `  "codexGoals": "${agentALabel}(구현 담당)에게 줄 목표. 구체적인 구현 지침을 한국어로 작성.",`,
    `  "claudeGoals": "${agentBLabel}(리뷰 담당)에게 줄 검토 기준. 검토 항목을 한국어로 작성."`,
    '}',
  ].join('\n');
}

function runPreFlight(reason) {
  const taskPath = path.join(__dirname, 'task.txt');
  if (!fs.existsSync(taskPath)) {
    log('task.txt 없음 — pre-flight 생략, 기본 목표 사용');
    startMainLoop(reason);
    return;
  }

  const task = fs.readFileSync(taskPath, 'utf8').trim();
  if (!task) {
    log('task.txt 비어 있음 — pre-flight 생략, 기본 목표 사용');
    startMainLoop(reason);
    return;
  }

  log('Pre-flight: 작업 분석 중 → prompt 목표 생성...');

  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const prompt = buildPreFlightPrompt(task);
  const child = spawn(claudeCmd, ['--print', '--permission-mode', 'acceptEdits'], {
    cwd: ROOT_DIR,
    shell: process.platform === 'win32',
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.on('error', () => {});
  child.stdin.write(prompt, 'utf8');
  child.stdin.end();

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  child.on('close', (code) => {
    if (code !== 0) {
      log(`Pre-flight 실패 (exit ${code}) — 기본 목표 사용`);
      startMainLoop(reason);
      return;
    }

    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JSON 없음');
      const goals = JSON.parse(jsonMatch[0]);
      if (!goals.codexGoals || !goals.claudeGoals) throw new Error('필드 누락');

      fs.writeFileSync(CONFIG.goalsPath, JSON.stringify(goals, null, 2));
      log('Pre-flight 완료 — task-goals.json 생성됨');
    } catch (err) {
      log(`Pre-flight 파싱 실패 (${err.message}) — 기본 목표 사용`);
    }

    startMainLoop(reason);
  });
}

function startMainLoop(reason) {
  const state = readState();
  runAgent(nextRole(state.lastRole), reason);
}

function handleTrigger() {
  try { fs.unlinkSync(CONFIG.triggerPath); } catch {}

  const taskPath = path.join(__dirname, 'task.txt');
  const task = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8').trim() : '';
  const reason = task ? `kick: ${task}` : 'kick triggered';

  log(`트리거 감지 — ${reason}`);
  runPreFlight(reason);
}

ensureDirs();

const srcWatcher = chokidar.watch(CONFIG.watchDir, {
  ignored: /(^|[/\\])\../,
  persistent: true,
  ignoreInitial: true,
});
srcWatcher.on('add', handleChange).on('change', handleChange);

const triggerWatcher = chokidar.watch(CONFIG.triggerPath, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200 },
});
triggerWatcher.on('add', handleTrigger).on('change', handleTrigger);

const agentALabel = AGENT_REGISTRY[CONFIG.agentA]?.label || CONFIG.agentA;
const agentBLabel = AGENT_REGISTRY[CONFIG.agentB]?.label || CONFIG.agentB;
log('duo-agent 감시 시작');
log(`에이전트: A=${agentALabel} (구현) | B=${agentBLabel} (리뷰)`);
log(`감시 대상: ${CONFIG.watchDir}`);
log(`최대 라운드: ${CONFIG.maxRounds} | 재시도: ${CONFIG.maxRetries} | 타임아웃: ${formatDuration(CONFIG.agentTimeoutMs)}`);
log('시작하려면 npm run kick "작업 내용"을 실행하세요.');
