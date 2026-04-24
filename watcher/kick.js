#!/usr/bin/env node
/**
 * 사용법: npm run kick "작업 내용을 여기에 적어주세요"
 *
 * 이 스크립트가 하는 일:
 *   1. 이전 완료 파일(TASK_DONE.md) 제거
 *   2. 협업 상태(state.json) 초기화
 *   3. 작업 내용을 watcher/task.txt에 저장
 *   4. watcher/.kick-trigger 생성 → watch.js가 감지해 첫 에이전트 실행
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const PATHS = {
  task:      path.join(__dirname, 'task.txt'),
  state:     path.join(__dirname, 'state.json'),
  checklist: path.join(__dirname, 'checklist.json'),
  done:      path.join(ROOT_DIR, 'TASK_DONE.md'),
  trigger:   path.join(__dirname, '.kick-trigger'),
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
    { round: 0, lastRole: null, lastAgent: null, status: 'idle', updatedAt: new Date().toISOString(), lastReason: null },
    null,
    2,
  ),
);
log('상태 초기화');

// 3. 작업 내용 저장 및 체크리스트 초기화 (CLI 사용 시 체크리스트 없음)
fs.writeFileSync(PATHS.task, task, 'utf8');
fs.writeFileSync(PATHS.checklist, JSON.stringify({ items: [] }, null, 2));
log(`작업 저장: "${task}"`);

// 4. 트리거 파일 생성 → watch.js가 감지해 첫 에이전트 실행 (watcher/ 안에 생성, src/ 오염 없음)
fs.writeFileSync(PATHS.trigger, new Date().toISOString(), 'utf8');
log('watcher 트리거 전송');
log('잠시 후 에이전트가 시작됩니다...');
