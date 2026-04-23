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
  debounceMs: Number(process.env.WATCH_DEBOUNCE_MS || 3000),
  maxRounds: Number(process.env.AGENT_MAX_ROUNDS || 8),
  extensions: new Set(['.js', '.ts', '.json', '.css', '.html']),
  firstAgent: process.env.FIRST_AGENT || 'codex',
};

const AGENTS = {
  claude: {
    label: 'Claude Code',
    command: process.env.CLAUDE_CMD || 'claude',
    args(prompt) {
      return [
        '--print',
        prompt,
        '--allowedTools',
        'Read,Edit,Bash(npm run build),Bash(npm test)',
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
        '--ask-for-approval',
        'never',
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
    return {
      round: 0,
      lastAgent: null,
      status: 'idle',
      updatedAt: null,
      lastReason: null,
    };
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8'));
  } catch {
    return {
      round: 0,
      lastAgent: null,
      status: 'idle',
      updatedAt: null,
      lastReason: 'state reset after invalid JSON',
    };
  }
}

function writeState(nextState) {
  fs.writeFileSync(
    CONFIG.statePath,
    JSON.stringify(
      {
        ...nextState,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
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
  };

  writeState(nextState);
  running = true;
  queuedReason = null;

  log(`${agent.label} 실행 시작 (${nextState.round}/${CONFIG.maxRounds})`);

  const child = spawn(agent.command, agent.args(prompt), {
    cwd: ROOT_DIR,
    shell: process.platform === 'win32',
    env: process.env,
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

    if (complete) {
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
      writeState({ ...latestState, status: 'complete', lastReason: 'agent reported complete' });
      log(`완료됨: ${path.relative(ROOT_DIR, CONFIG.donePath)}`);
      return;
    }

    if (latestState.round >= CONFIG.maxRounds) {
      writeState({ ...latestState, status: 'paused', lastReason: 'max rounds reached' });
      log(`최대 라운드(${CONFIG.maxRounds})에 도달해 사용자 확인 대기`);
      return;
    }

    if (code !== 0 && !changed) {
      writeState({ ...latestState, status: 'error', lastReason: `${agent.label} exit ${code}` });
      log(`${agent.label}가 실패했고 변경도 없어 멈춤`);
      return;
    }

    if (!changed && !needsNext) {
      writeState({ ...latestState, status: 'paused', lastReason: 'no changes and no NEEDS_NEXT status' });
      log('변경도 명확한 계속 신호도 없어 사용자 확인 대기');
      return;
    }

    const followUpReason = queuedReason || `${agent.label} completed; changed=${changed}`;
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

ensureDirs();

const watcher = chokidar.watch(CONFIG.watchDir, {
  ignored: /(^|[/\\])\../,
  persistent: true,
  ignoreInitial: true,
});

watcher.on('add', handleChange).on('change', handleChange);

log('AI 협업 감시 시작');
log(`감시 대상: ${CONFIG.watchDir}`);
log(`최대 라운드: ${CONFIG.maxRounds}`);
log(`완료 파일: ${CONFIG.donePath}`);
log('완료 후 다시 시작하려면 TASK_DONE.md를 삭제하고 src 파일을 수정하세요.');
