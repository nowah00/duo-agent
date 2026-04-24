/**
 * prompt.config.js — 프로젝트별 커스터마이징 지점
 *
 * DEFAULT_GOALS를 직접 수정하거나,
 * pre-flight가 task-goals.json을 생성한 경우 그 값을 우선 사용합니다.
 *
 * role 'a' = 구현 담당 (기본: Codex)
 * role 'b' = 리뷰 담당 (기본: Claude Code)
 */

const fs = require('fs');
const path = require('path');

const GOALS_PATH = path.join(__dirname, 'task-goals.json');

function readGeneratedGoals() {
  if (!fs.existsSync(GOALS_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(GOALS_PATH, 'utf8'));
    if (parsed.codexGoals && parsed.claudeGoals) return parsed;
  } catch {}
  return null;
}

function readTask() {
  const taskPath = path.join(__dirname, 'task.txt');
  if (fs.existsSync(taskPath)) {
    const task = fs.readFileSync(taskPath, 'utf8').trim();
    if (task) return `현재 작업 지시: "${task}"`;
  }
  return null;
}

function readChecklist() {
  const checklistPath = path.join(__dirname, 'checklist.json');
  if (!fs.existsSync(checklistPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(checklistPath, 'utf8'));
    const items = Array.isArray(data.items) ? data.items.filter(s => s.trim()) : [];
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------
// 기본 목표 — task-goals.json이 없을 때 사용
// -----------------------------------------------
const DEFAULT_IMPLEMENTER_GOALS = `
주어진 작업 지시를 분석하고 코드를 구현한다.
- 기존 코드 스타일과 구조를 유지한다.
- 구현이 완료되면 반드시 JSON 상태를 출력한다.
`;

const DEFAULT_REVIEWER_GOALS = `
구현된 코드를 검토하고 문제가 있으면 직접 수정한다.

검토 항목:
1. 런타임 오류 및 문법 오류
2. 로직 버그
3. 보안 취약점
4. 기존 기능 회귀 여부
5. 문제가 없으면 COMPLETE로 마무리한다.
`;

// -----------------------------------------------
// 종료 규칙 — JSON 출력 형식 강제
// -----------------------------------------------
const STOP_RULES = `
[종료 규칙 — 반드시 준수]
작업이 끝나면 마지막 줄에 아래 JSON 형식으로만 상태를 출력한다. 다른 텍스트를 붙이지 않는다.

  구현 완료 또는 추가 검토 필요:
  {"status":"NEEDS_NEXT","summary":"작업 내용을 한 줄로 요약"}

  검토 완료 및 수정 사항 없음 (role:b 전용):
  {"status":"COMPLETE","summary":"검토 결과를 한 줄로 요약"}

- role:a (구현 담당)는 절대 COMPLETE를 출력하지 않는다.
- role:b (리뷰 담당)만 COMPLETE를 출력할 수 있다. 수정할 것이 없을 때만 사용한다.
- 같은 변경을 반복하지 말고, 충분한 상태라면 COMPLETE로 멈춘다.
- reviews/, watcher/, node_modules/는 수정하지 않는다.
`;

function buildPrompt({ role, agentLabel, peerLabel, rootDir, reason, round, maxRounds }) {
  const generated = readGeneratedGoals();
  const goals = role === 'a'
    ? (generated?.codexGoals ?? DEFAULT_IMPLEMENTER_GOALS)
    : (generated?.claudeGoals ?? DEFAULT_REVIEWER_GOALS);

  const task = readTask();
  const checklist = readChecklist();

  const checklistBlock = checklist
    ? [
        '',
        '완료 체크리스트 (모든 항목이 완료됐을 때만 COMPLETE를 출력한다):',
        ...checklist.map((item, i) => `${i + 1}. ${item}`),
      ].join('\n')
    : null;

  return [
    '너는 이 프로젝트를 공동 개발하는 자동 에이전트다.',
    `현재 담당: ${agentLabel} (role:${role})`,
    `상대 담당: ${peerLabel}`,
    `작업 루트: ${rootDir}`,
    `트리거: ${reason}`,
    `라운드: ${round}/${maxRounds}`,
    task ? '' : null,
    task ?? null,
    checklistBlock,
    '',
    '목표:',
    goals.trim(),
    '',
    STOP_RULES.trim(),
  ].filter(line => line !== null).join('\n');
}

module.exports = { buildPrompt };
