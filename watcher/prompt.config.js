/**
 * prompt.config.js — 프로젝트별 커스터마이징 지점
 *
 * 이 파일만 수정하면 됩니다. watch.js는 건드리지 마세요.
 *
 * 수정 방법:
 *   1. CODEX_GOALS  → Codex(구현 담당)에게 줄 목표를 작성합니다
 *   2. CLAUDE_GOALS → Claude(리뷰 담당)에게 줄 목표를 작성합니다
 *   3. 나머지 공통 규칙은 그대로 두거나 프로젝트에 맞게 조정합니다
 *
 * 실제 작성 예시는 examples/ 폴더를 참고하세요.
 */

const fs = require('fs');
const path = require('path');

// npm run kick으로 전달된 작업 내용을 읽어 프롬프트에 포함합니다.
function readTask() {
  const taskPath = path.join(__dirname, 'task.txt');
  if (fs.existsSync(taskPath)) {
    const task = fs.readFileSync(taskPath, 'utf8').trim();
    if (task) return `현재 작업 지시: "${task}"`;
  }
  return null;
}

// -----------------------------------------------
// Codex 목표 (구현 담당)
// 무엇을 어떻게 만들지 구체적으로 적어주세요.
// -----------------------------------------------
const CODEX_GOALS = `
1. src/ 안의 코드를 읽고 현재 상태를 파악한다.
2. 누락된 기능이나 구조를 구현한다.
3. 하나의 작업 단위를 완결성 있게 작성한다 (절반만 구현 금지).
4. 구현 후 변경 내용을 간결하게 요약한다.
`;

// -----------------------------------------------
// Claude 목표 (리뷰 담당)
// 무엇을 기준으로 검토하고 수정할지 적어주세요.
// -----------------------------------------------
const CLAUDE_GOALS = `
1. src/ 안의 코드를 읽고 전체 구조를 파악한다.
2. 버그, 문법 오류, 누락된 구현, 보안 문제를 찾는다.
3. 문제가 있으면 직접 수정한다.
4. 수정 후 가능하면 npm run build 또는 npm test로 검증한다.
5. 수정 내용을 간결하게 요약한다.
`;

// -----------------------------------------------
// 공통 중단 규칙 — 일반적으로 수정 불필요
// -----------------------------------------------
const STOP_RULES = `
중요한 중단 규칙:
- 목표가 완료되어 사용자가 확인할 단계라면 마지막 줄에 "STATUS: COMPLETE"를 출력한다.
- 상대 에이전트가 이어서 작업해야 한다면 마지막 줄에 "STATUS: NEEDS_NEXT"를 출력한다.
- 같은 변경을 반복하지 말고, 충분한 상태라면 COMPLETE로 멈춘다.
- reviews/, watcher/, node_modules/는 수정하지 않는다.
`;

/**
 * @param {object} ctx
 * @param {'claude' | 'codex'} ctx.agentName
 * @param {string} ctx.agentLabel
 * @param {string} ctx.peerLabel
 * @param {string} ctx.rootDir
 * @param {string} ctx.reason
 * @param {number} ctx.round
 * @param {number} ctx.maxRounds
 * @returns {string}
 */
function buildPrompt({ agentName, agentLabel, peerLabel, rootDir, reason, round, maxRounds }) {
  const goals = agentName === 'codex' ? CODEX_GOALS : CLAUDE_GOALS;
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
