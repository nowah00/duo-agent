/**
 * 예시: Phaser.js 2D 게임 프로젝트
 *
 * 이 파일을 watcher/prompt.config.js에 복사해서 사용하세요.
 * CODEX_GOALS와 CLAUDE_GOALS만 프로젝트에 맞게 바꾸면 됩니다.
 *
 * 프로젝트 구조 가정:
 *   src/
 *   ├── main.js           ← Phaser 게임 초기화
 *   ├── scenes/           ← 씬 파일 (GameScene, MenuScene 등)
 *   └── entities/         ← 게임 오브젝트 (Player, Enemy 등)
 */

// -----------------------------------------------
// Codex 목표 (구현 담당)
// -----------------------------------------------
const CODEX_GOALS = `
1. src/ 안의 Phaser.js 게임 코드를 읽고 현재 구현 상태를 파악한다.
2. 아직 구현되지 않은 게임 기능(이동, 충돌, 점수, 씬 전환 등)을 구현한다.
3. 씬은 src/scenes/, 게임 오브젝트는 src/entities/ 에 작성한다.
4. Phaser 3 API를 사용한다 (import Phaser from 'phaser').
5. 구현한 내용을 간결하게 요약한다.
`;

// -----------------------------------------------
// Claude 목표 (리뷰 담당)
// -----------------------------------------------
const CLAUDE_GOALS = `
1. src/ 안의 Phaser.js 게임 코드를 읽고 전체 구조를 파악한다.
2. 아래 항목을 순서대로 점검하고, 문제가 있으면 직접 수정한다:
   - 런타임 에러 / 문법 오류
   - Phaser API 오용 (잘못된 씬 생명주기, 잘못된 이벤트 사용 등)
   - 메모리 누수 (destroy 누락, 이벤트 리스너 미제거)
   - 게임 로직 버그 (충돌 판정, 점수 계산 오류 등)
3. 수정 후 npm run build로 빌드 오류 여부를 확인한다.
4. 수정 내용을 간결하게 요약한다.
`;

// -----------------------------------------------
// 공통 중단 규칙 — 수정 불필요
// -----------------------------------------------
const STOP_RULES = `
중요한 중단 규칙:
- 목표가 완료되어 사용자가 확인할 단계라면 마지막 줄에 "STATUS: COMPLETE"를 출력한다.
- 상대 에이전트가 이어서 작업해야 한다면 마지막 줄에 "STATUS: NEEDS_NEXT"를 출력한다.
- 같은 변경을 반복하지 말고, 충분한 상태라면 COMPLETE로 멈춘다.
- reviews/, watcher/, node_modules/는 수정하지 않는다.
`;

function buildPrompt({ agentName, agentLabel, peerLabel, rootDir, reason, round, maxRounds }) {
  const goals = agentName === 'codex' ? CODEX_GOALS : CLAUDE_GOALS;

  return [
    '너는 이 프로젝트를 공동 개발하는 자동 에이전트다.',
    `현재 담당: ${agentLabel}`,
    `이전 담당: ${peerLabel}`,
    `작업 루트: ${rootDir}`,
    `트리거: ${reason}`,
    `라운드: ${round}/${maxRounds}`,
    '',
    '목표:',
    goals.trim(),
    '',
    STOP_RULES.trim(),
  ].join('\n');
}

module.exports = { buildPrompt };
