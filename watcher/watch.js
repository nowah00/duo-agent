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
  chatHistoryPath: path.join(__dirname, 'chat-history.json'),
  goalsPath: path.join(__dirname, 'task-goals.json'),
  debounceMs: Number(process.env.WATCH_DEBOUNCE_MS || 3000),
  maxRounds: Number(process.env.AGENT_MAX_ROUNDS || 8),
  maxRetries: Number(process.env.AGENT_MAX_RETRIES || 1),
  extensions: new Set(['.js', '.ts', '.json', '.css', '.html']),
  firstAgent: process.env.FIRST_AGENT || 'codex',
};

const AGENTS = {
  claude: {
    label: 'Claude Code',
    command: process.env.CLAUDE_CMD || 'claude',
    args(prompt) {
      const allowedTools = process.env.CLAUDE_ALLOWED_TOOLS || 'Read,Edit,Bash(npm run build),Bash(npm test)';
      return [
        '--print',
        prompt,
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
    args(prompt) {
      return [
        'exec',
        '--cd',
        ROOT_DIR,
        '--sandbox',
        'workspace-write',
        prompt,
      ];
    },
  },
};

const timers = new Map();
let running = false;
let queuedReason = null;

function ensureDirs() {
  fs.mkdirSync(CONFIG.reviewsDir, { recursive: true });
  fs.mkdirSync(CONFIG.watchDir, { recursive: true });
}

function log(message) {
  const time = new Date().toLocaleTimeString('ko-KR');
  console.log(`[${time}] ${message}`);
}

function readState() {
  if (!fs.existsSync(CONFIG.statePath)) {
    return { round: 0, lastAgent: null, status: 'idle', updatedAt: null, lastReason: null, retries: 0 };
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8'));
  } catch {
    return { round: 0, lastAgent: null, status: 'idle', updatedAt: null, lastReason: 'state reset after invalid JSON', retries: 0 };
  }
}

function writeState(nextState) {
  fs.writeFileSync(
    CONFIG.statePath,
    JSON.stringify({ ...nextState, updatedAt: new Date().toISOString() }, null, 2),
  );
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

function saveReview(agentName, output) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reviewPath = path.join(CONFIG.reviewsDir, `${timestamp}_${agentName}.md`);
  fs.writeFileSync(reviewPath, output.trim() ? output : '(no output)');
  log(`결과 저장: ${path.relative(ROOT_DIR, reviewPath)}`);
}

function nextAgentName(lastAgent) {
  if (!lastAgent) return CONFIG.firstAgent;
  return lastAgent === 'claude' ? 'codex' : 'claude';
}

function hasCompleteStatus(output) {
  return /STATUS:\s*COMPLETE/i.test(output);
}

function hasNeedsNextStatus(output) {
  return /STATUS:\s*NEEDS_NEXT/i.test(output);
}

function buildPrompt(agentName, reason, state) {
  const peer = agentName === 'claude' ? 'Codex' : 'Claude Code';

  return buildProjectPrompt({
    agentName,
    agentLabel: AGENTS[agentName].label,
    peerLabel: peer,
    rootDir: ROOT_DIR,
    reason,
    round: state.round + 1,
    maxRounds: CONFIG.maxRounds,
  });
}

function runAgent(agentName, reason) {
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

  const agent = AGENTS[agentName];
  const prompt = buildPrompt(agentName, reason, state);
  const beforeHash = sourceFingerprint();
  const nextState = {
    ...state,
    round: state.round + 1,
    lastAgent: agentName,
    status: 'running',
    lastReason: reason,
    retries: state.retries || 0,
  };

  writeState(nextState);
  running = true;
  queuedReason = null;

  log(`${agent.label} 실행 시작 (${nextState.round}/${CONFIG.maxRounds})`);

  const child = spawn(agent.command, agent.args(prompt), {
    cwd: ROOT_DIR,
    shell: process.platform === 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';

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
    running = false;
    saveReview(agentName, output);

    const afterHash = sourceFingerprint();
    const changed = beforeHash !== afterHash;
    const complete = hasCompleteStatus(output);
    const needsNext = hasNeedsNextStatus(output);
    const latestState = readState();

    // Claude만 루프를 종료할 수 있음
    if (complete && agentName === 'claude') {
      const doneText = [
        '# Task Done',
        '',
        `Completed by: ${agent.label}`,
        `Round: ${latestState.round}/${CONFIG.maxRounds}`,
        `Exit code: ${code}`,
        `Changed source: ${changed ? 'yes' : 'no'}`,
        `Completed at: ${new Date().toISOString()}`,
        '',
        '사용자가 최종 확인할 단계입니다.',
      ].join('\n');

      fs.writeFileSync(CONFIG.donePath, doneText);
      writeState({ ...latestState, status: 'complete', lastReason: 'agent reported complete', retries: 0 });
      log(`완료됨: ${path.relative(ROOT_DIR, CONFIG.donePath)}`);
      return;
    }

    if (complete && agentName !== 'claude') {
      log(`${agent.label}가 COMPLETE를 출력했지만 Claude 리뷰가 필요해 다음 라운드로 넘김`);
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
        setTimeout(() => runAgent(agentName, `retry: ${reason}`), CONFIG.debounceMs);
        return;
      }
      writeState({ ...latestState, status: 'error', lastReason: `${agent.label} exit ${code}`, retries: 0 });
      log(`${agent.label}가 실패했고 재시도 횟수 초과 — 멈춤`);
      return;
    }

    // 변경도 없고 계속 신호도 없으면 대기
    if (!changed && !needsNext) {
      writeState({ ...latestState, status: 'paused', lastReason: 'no changes and no NEEDS_NEXT', retries: 0 });
      log('변경 없음 + STATUS 미출력 — 사용자 확인 대기');
      return;
    }

    const followUpReason = queuedReason || `${agent.label} completed; changed=${changed}`;
    writeState({ ...latestState, retries: 0 });
    setTimeout(() => runAgent(nextAgentName(agentName), followUpReason), CONFIG.debounceMs);
  });
}

function schedule(reason) {
  clearTimeout(timers.get('main'));
  timers.set(
    'main',
    setTimeout(() => {
      const state = readState();
      runAgent(nextAgentName(state.lastAgent), reason);
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
  return [
    '다음은 사용자가 입력한 작업 지시다.',
    '',
    task,
    '',
    '이 내용을 분석해서 아래 JSON 형식만 출력하라. 설명 없이 JSON만 출력할 것.',
    '{',
    '  "codexGoals": "Codex(구현 담당)에게 줄 목표. 구체적인 구현 지침을 한국어로 작성.",',
    '  "claudeGoals": "Claude(리뷰 담당)에게 줄 검토 기준. 검토 항목을 한국어로 작성."',
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
  const child = spawn(claudeCmd, ['--print', prompt], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
  runAgent(nextAgentName(state.lastAgent), reason);
}

function handleTrigger() {
  // 트리거 파일 즉시 삭제 (src/ 오염 방지)
  try { fs.unlinkSync(CONFIG.triggerPath); } catch {}

  const taskPath = path.join(__dirname, 'task.txt');
  const task = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8').trim() : '';
  const reason = task ? `kick: ${task}` : 'kick triggered';

  log(`트리거 감지 — ${reason}`);
  runPreFlight(reason);
}

ensureDirs();

// src/ 파일 변경 감시
const srcWatcher = chokidar.watch(CONFIG.watchDir, {
  ignored: /(^|[/\\])\../,
  persistent: true,
  ignoreInitial: true,
});
srcWatcher.on('add', handleChange).on('change', handleChange);

// watcher/.kick-trigger 감시 (src/ 오염 없이 kick 트리거)
const triggerWatcher = chokidar.watch(CONFIG.triggerPath, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200 },
});
triggerWatcher.on('add', handleTrigger).on('change', handleTrigger);

log('AI 협업 감시 시작');
log(`감시 대상: ${CONFIG.watchDir}`);
log(`최대 라운드: ${CONFIG.maxRounds} | 재시도: ${CONFIG.maxRetries}`);
log(`완료 파일: ${CONFIG.donePath}`);
log('재시작하려면 npm run kick "작업 내용"을 실행하세요.');
