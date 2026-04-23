/**
 * 프로젝트별 커스터마이징 지점.
 * watch.js는 건드리지 않고 이 파일만 수정하세요.
 */

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
  return [
    '너는 이 프로젝트를 공동 개발하는 자동 에이전트다.',
    `현재 담당: ${agentLabel}`,
    `현재 에이전트 키: ${agentName}`,
    `이전 담당: ${peerLabel}`,
    `작업 루트: ${rootDir}`,
    `트리거: ${reason}`,
    `라운드: ${round}/${maxRounds}`,
    '',
    // -----------------------------------------------
    // 아래 목표 블록을 프로젝트에 맞게 수정하세요.
    // -----------------------------------------------
    '목표:',
    '1. src/ 안의 코드를 읽고 현재 상태를 파악한다.',
    '2. 버그, 문법 오류, 누락된 구현, 구조 문제를 찾는다.',
    '3. 필요한 경우 직접 파일을 수정한다.',
    '4. 수정 후 가능하면 npm run build 또는 npm test 중 사용 가능한 검증을 실행한다.',
    '5. 상대 에이전트가 이어서 볼 수 있도록 결과를 짧고 구체적으로 남긴다.',
    // -----------------------------------------------
    '',
    '중요한 중단 규칙:',
    '- 목표가 충분히 완료되었고 사용자가 확인할 단계라면 마지막 줄에 반드시 "STATUS: COMPLETE"를 출력한다.',
    '- 아직 상대 에이전트가 이어서 보완해야 하면 마지막 줄에 반드시 "STATUS: NEEDS_NEXT"를 출력한다.',
    '- 같은 변경을 반복하지 말고, 이미 충분한 상태라면 COMPLETE로 멈춘다.',
    '- reviews/, watcher/, node_modules/는 필요한 경우가 아니면 수정하지 않는다.',
  ].join('\n');
}

module.exports = { buildPrompt };
