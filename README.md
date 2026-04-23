# AI Collab Template

Claude Code + Codex CLI가 `src/`를 공유하며 턴제로 협업하는 템플릿.

## 구조

```
├── src/                    ← 실제 작업 코드 (여기에 개발)
├── watcher/
│   ├── watch.js            ← 협업 오케스트레이터 (수정 불필요)
│   └── prompt.config.js    ← 프로젝트별 프롬프트 (수정 지점)
├── reviews/                ← 에이전트 출력 자동 저장 (gitignore)
├── CLAUDE.md               ← Claude 행동 지침
├── AGENTS.md               ← Codex 행동 지침
└── .env.example            ← 환경변수 설정 예시
```

## 새 프로젝트에 적용하는 법

1. 이 레포를 클론
2. 아래 3개 파일을 프로젝트에 맞게 수정:
   - `CLAUDE.md` — Claude 리뷰 기준
   - `AGENTS.md` — Codex 개발 규칙
   - `watcher/prompt.config.js` — 목표 블록 교체
3. `package.json`에 프로젝트 의존성 추가
4. `.env.example` → `.env` 복사 후 필요시 값 수정

## 실행

```bash
npm install
npm run watch    # 파일 감시만
npm run start    # 개발 서버 + 파일 감시 동시 실행
```

## 협업 흐름

```
src/ 파일 변경 감지
      ↓ (WATCH_DEBOUNCE_MS 대기)
FIRST_AGENT 실행
      ↓ STATUS: NEEDS_NEXT
상대 에이전트 실행
      ↓ STATUS: COMPLETE
TASK_DONE.md 생성 → 루프 종료
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `WATCH_DEBOUNCE_MS` | 3000 | 파일 변경 후 대기 시간 (ms) |
| `AGENT_MAX_ROUNDS` | 8 | 최대 협업 라운드 |
| `FIRST_AGENT` | codex | 첫 번째 실행 에이전트 |
| `CLAUDE_CMD` | claude | Claude CLI 명령어 |
| `CODEX_CMD` | codex | Codex CLI 명령어 |

## 재시작

`TASK_DONE.md` 삭제 후 `src/` 파일을 수정하면 루프가 다시 시작된다.
