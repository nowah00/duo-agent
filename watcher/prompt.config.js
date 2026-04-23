/**
 * prompt.config.js — 프로젝트별 커스터마이징 지점
 *
 * CODEX_GOALS / CLAUDE_GOALS를 직접 수정하거나,
 * /api/confirm을 통해 task-goals.json이 생성된 경우 그 값을 우선 사용합니다.
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

// -----------------------------------------------
// 기본 목표 — task-goals.json이 없을 때 사용
// -----------------------------------------------
const DEFAULT_CODEX_GOALS = `
기존 duo-agent 대시보드(src/main.js, vite.config.js)의 채팅 패널을 구조화된 kick 폼으로 교체한다.

기술 스택: Vite + Vanilla JS (TypeScript 사용 금지, 외부 라이브러리 추가 금지)

1. vite.config.js에서 /api/chat, /api/confirm 엔드포인트를 제거한다. /api/kick, /api/stop, /api/state, /api/reviews는 그대로 유지한다.

2. src/main.js에서 채팅 관련 코드(currentMessages, chatDraft, sendChat, confirmChat, renderChatPanel 등)를 모두 제거하고, 아래 구조화된 폼 패널로 교체한다:

   패널 이름: "New Task"

   폼 필드 3개:
   - goal (필수): textarea, label "목표", placeholder "무엇을 만들거나 수정할지 구체적으로 적어주세요."
   - stack (선택): input[text], label "기술 스택", placeholder "예: React, Node.js, PostgreSQL"
   - rules (선택): textarea, label "제약 조건", placeholder "예: 테스트 필수, REST API, 기존 코드 유지"

   [▶ Kick] 버튼:
   - goal가 비어 있으면 비활성화
   - 클릭 시 세 필드를 아래 형식으로 조합해 POST /api/kick의 task로 전송:
     "goal: {goal}\\nstack: {stack}\\nrules: {rules}"
     (stack, rules가 비어 있으면 해당 줄 생략)
   - 전송 후 폼 초기화

   [■ Stop] 버튼: status가 'running'일 때만 활성화

   status가 'running'이면 폼 전체 비활성화

3. 스타일은 기존 다크 테마와 일관성 유지
`;

const DEFAULT_CLAUDE_GOALS = `
Codex가 구현한 구조화된 kick 폼을 검토하고 수정한다.

검토 항목:
1. vite.config.js에서 /api/chat, /api/confirm이 완전히 제거됐는지 확인한다.
2. src/main.js에서 채팅 관련 코드(currentMessages, chatDraft, sendChat, confirmChat 등)가 모두 제거됐는지 확인한다.
3. goal/stack/rules 필드가 올바르게 조합돼 POST /api/kick에 전달되는지 확인한다.
4. goal 비어 있을 때 Kick 버튼 비활성화, running 상태일 때 폼 비활성화가 올바른지 확인한다.
5. 기존 대시보드 기능(폴링, 진행 바, 메트릭, 리뷰 목록)이 그대로 동작하는지 확인한다.
6. 문제가 있으면 직접 수정하고 npm run build로 빌드 성공을 검증한다.
7. 수정 내용을 간결하게 요약한다.
`;

// -----------------------------------------------
// 공통 중단 규칙
// -----------------------------------------------
const STOP_RULES = `
중요한 중단 규칙:
- Codex는 절대 "STATUS: COMPLETE"를 출력하지 않는다. 구현이 끝나면 반드시 "STATUS: NEEDS_NEXT"를 출력한다.
- Claude Code만 "STATUS: COMPLETE"를 출력할 수 있다. 리뷰 후 수정할 것이 없으면 COMPLETE로 마무리한다.
- 같은 변경을 반복하지 말고, 충분한 상태라면 COMPLETE로 멈춘다.
- reviews/, watcher/, node_modules/는 수정하지 않는다.
`;

function buildPrompt({ agentName, agentLabel, peerLabel, rootDir, reason, round, maxRounds }) {
  const generated = readGeneratedGoals();
  const goals = agentName === 'codex'
    ? (generated?.codexGoals ?? DEFAULT_CODEX_GOALS)
    : (generated?.claudeGoals ?? DEFAULT_CLAUDE_GOALS);
  const task = readTask();

  return [
    '너는 이 프로젝트를 공동 개발하는 자동 에이전트다.',
    `현재 담당: ${agentLabel}`,
    `이전 담당: ${peerLabel}`,
    `작업 루트: ${rootDir}`,
    `트리거: ${reason}`,
    `라운드: ${round}/${maxRounds}`,
    task ? '' : null,
    task ?? null,
    '',
    '목표:',
    goals.trim(),
    '',
    STOP_RULES.trim(),
  ].filter(line => line !== null).join('\n');
}

module.exports = { buildPrompt };
