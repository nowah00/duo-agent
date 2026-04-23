#!/usr/bin/env node
/**
 * 사용법: npm run kick "작업 내용을 여기에 적어주세요"
 *
 * 이 스크립트가 하는 일:
 *   1. 이전 완료 파일(TASK_DONE.md) 제거
 *   2. 협업 상태(state.json) 초기화
 *   3. 작업 내용을 watcher/task.txt에 저장
 *   4. src/duo-agent.kick.js 생성 → watch.js가 감지해 첫 에이전트 실행
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const PATHS = {
  task:    path.join(__dirname, 'task.txt'),
  state:   path.join(__dirname, 'state.json'),
  done:    path.join(ROOT_DIR, 'TASK_DONE.md'),
  trigger: path.join(ROOT_DIR, 'src', 'duo-agent.kick.js'),
  src:     path.join(ROOT_DIR, 'src'),
};

function log(msg) {
  const time = new Date().toLocaleTimeString('ko-KR');
  console.log(`[${time}] ${msg}`);
}

// 작업 내용 확인
const task = process.argv.slice(2).join(' ').trim();

if (!task) {
  console.error('');
  console.error('  작업 내용을 입력해주세요.');
  console.error('  예시: npm run kick "로그인 기능을 구현해줘"');
  console.error('');
  process.exit(1);
}

// 1. 이전 완료 파일 제거
if (fs.existsSync(PATHS.done)) {
  fs.rmSync(PATHS.done);
  log('이전 완료 파일 삭제');
}

// 2. 상태 초기화
fs.writeFileSync(
  PATHS.state,
  JSON.stringify(
    { round: 0, lastAgent: null, status: 'idle', updatedAt: new Date().toISOString(), lastReason: null },
    null,
    2,
  ),
);
log('상태 초기화');

// 3. 작업 내용 저장 (prompt.config.js가 읽어 프롬프트에 포함)
fs.writeFileSync(PATHS.task, task, 'utf8');
log(`작업 저장: "${task}"`);

// 4. 트리거 파일 생성 → watch.js가 감지해 첫 에이전트 실행
fs.mkdirSync(PATHS.src, { recursive: true });
fs.writeFileSync(
  PATHS.trigger,
  `// duo-agent kick trigger — 이 파일은 자동 생성됩니다. 수정하지 마세요.\n// task: ${task}\n// at: ${new Date().toISOString()}\n`,
  'utf8',
);
log('watcher 트리거 전송');
log('잠시 후 에이전트가 시작됩니다...');
