# duo-agent

> Claude Code와 Codex, 두 AI가 번갈아 가며 코드를 개발하고 리뷰하는 자동 협업 템플릿입니다.

---

## 이게 뭔가요?

보통 AI에게 코드를 짜달라고 하면 한 명한테만 물어보죠.  
**duo-agent**는 두 AI를 팀처럼 묶어서, 한 명이 코드를 쓰면 다른 한 명이 자동으로 검토하고 고치는 구조입니다.

- **Codex** → 기능 구현 담당
- **Claude Code** → 오류 탐지 및 수정 담당
- 사람은 중간에 개입하지 않아도 됩니다

---

## 시작하기 전에 필요한 것

처음 사용하는 분도 이 순서대로 따라오면 됩니다.

### 1. Node.js 설치

[https://nodejs.org](https://nodejs.org) 에서 **LTS 버전**을 설치하세요.  
설치 후 터미널에서 확인:

```bash
node -v   # v18 이상이면 OK
npm -v
```

### 2. Claude Code CLI 설치

```bash
npm install -g @anthropic-ai/claude-code
claude --version  # 설치 확인
```

> Claude Code를 처음 실행하면 Anthropic 계정 로그인이 필요합니다.

### 3. Codex CLI 설치

```bash
npm install -g @openai/codex
codex --version  # 설치 확인
```

> OpenAI 계정과 API 키가 필요합니다. [https://platform.openai.com](https://platform.openai.com) 에서 발급받으세요.

---

## 설치 및 실행

### 1. 레포 클론

```bash
git clone https://github.com/nowah00/duo-agent.git
cd duo-agent
```

### 2. 패키지 설치

```bash
npm install
```

### 3. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어서 필요하면 값을 바꿔도 됩니다. 기본값으로도 바로 실행됩니다.

### 4. 실행

```bash
npm run start
```

터미널에 아래처럼 뜨면 정상입니다:

```
[오전 10:00:00] AI 협업 감시 시작
[오전 10:00:00] 감시 대상: .../src
[오전 10:00:00] 최대 라운드: 8 | 재시도: 1
```

브라우저에서 `http://localhost:3000` 이 자동으로 열리며 모니터링 대시보드를 확인할 수 있습니다.

---

## 어떻게 사용하나요?

### 1단계 — 감시 시작

```bash
npm run start
```

터미널에 `AI 협업 감시 시작` 메시지가 뜨고, 브라우저에서 `http://localhost:3000` 대시보드가 열립니다.

### 2단계 — 작업 지시

**방법 A — 대시보드 (권장)**

브라우저 대시보드의 `Agent Control` 패널에 작업 내용을 입력하고 `▶ Kick` 버튼을 누릅니다. 터미널을 추가로 열 필요가 없습니다.

**방법 B — 터미널**

```bash
npm run kick "로그인 기능을 구현해줘"
```

### 3단계 — 자동 실행

```
Codex → 기능 구현 (STATUS: NEEDS_NEXT)
  ↓
Claude → 오류 검토 및 수정 (STATUS: COMPLETE)
  ↓
완료 시 TASK_DONE.md 생성 + 자동 종료
```

진행 상황은 대시보드에서 실시간으로 확인할 수 있습니다. 실행 중 중단하려면 `■ Stop` 버튼을 누르세요.

### 4단계 — 결과 확인

- **대시보드 `Recent Reviews`** — 각 에이전트의 출력을 바로 펼쳐볼 수 있습니다
- **`reviews/`** — 전체 출력 기록 파일
- **`TASK_DONE.md`** — 완료 여부와 라운드 정보

### 다음 작업 지시

이전 작업이 완료된 상태에서도 바로 다음 작업을 입력하면 됩니다. 초기화는 자동으로 처리됩니다.

---

## 새 프로젝트에 적용하는 법

이 템플릿을 다른 프로젝트에 쓸 때는 파일 3개만 수정하면 됩니다.

| 파일 | 수정 내용 |
|------|----------|
| `CLAUDE.md` | Claude에게 무엇을 리뷰할지 알려주는 지침 |
| `AGENTS.md` | Codex에게 어떻게 개발할지 알려주는 지침 |
| `watcher/prompt.config.js` | 두 AI에게 전달할 목표 (Codex용/Claude용 분리 작성) |

`watcher/watch.js`는 수정하지 않아도 됩니다.

---

## prompt.config.js 작성 방법

`watcher/prompt.config.js` 안에는 두 개의 목표 블록이 있습니다.

```js
// Codex(구현 담당)에게 줄 목표
const CODEX_GOALS = `
1. 누락된 기능을 구현한다.
2. ...
`;

// Claude(리뷰 담당)에게 줄 목표
const CLAUDE_GOALS = `
1. 버그와 오류를 찾아 수정한다.
2. ...
`;
```

두 블록만 프로젝트에 맞게 바꾸면 됩니다. 나머지는 건드리지 않아도 됩니다.

### 예시 파일 참고

`examples/` 폴더에 실제 프로젝트 기준으로 작성된 예시가 있습니다.

| 예시 | 경로 |
|------|------|
| Phaser.js 2D 게임 | `examples/phaser-game/prompt.config.js` |

예시를 복사해서 `watcher/prompt.config.js`에 붙여넣은 뒤 내용만 수정하면 됩니다.

```bash
cp examples/phaser-game/prompt.config.js watcher/prompt.config.js
```

---

## 프로젝트 구조

```
duo-agent/
├── src/                      ← 실제 작업 코드 (대시보드 UI 포함)
├── watcher/
│   ├── watch.js              ← 협업 자동화 엔진 (수정 불필요)
│   ├── kick.js               ← 작업 시작 스크립트
│   └── prompt.config.js      ← AI에게 전달할 목표 (프로젝트마다 수정)
├── reviews/                  ← AI 작업 결과 자동 저장 (git 제외)
├── CLAUDE.md                 ← Claude 행동 지침
├── AGENTS.md                 ← Codex 행동 지침
├── vite.config.js            ← 대시보드 API 엔드포인트 포함
├── .env.example              ← 환경변수 예시
└── README.md
```

---

## 환경변수 설정

`.env` 파일에서 아래 값을 조정할 수 있습니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `WATCH_DEBOUNCE_MS` | `3000` | 파일 저장 후 AI 실행까지 대기 시간 (밀리초) |
| `AGENT_MAX_ROUNDS` | `8` | AI 간 최대 교대 횟수 (초과 시 자동 중단) |
| `AGENT_MAX_RETRIES` | `1` | 에이전트 실패 시 자동 재시도 횟수 |
| `FIRST_AGENT` | `codex` | 먼저 실행할 AI (`codex` 또는 `claude`) |
| `CLAUDE_CMD` | `claude` | Claude CLI 실행 명령어 |
| `CODEX_CMD` | `codex` | Codex CLI 실행 명령어 |
| `CLAUDE_ALLOWED_TOOLS` | `Read,Edit,Bash(npm run build),Bash(npm test)` | Claude에게 허용할 툴 목록 |

---

## 협업 흐름

```
src/ 파일 변경 감지
        ↓ 3초 대기
  Codex 실행 → 기능 구현
        ↓ STATUS: NEEDS_NEXT
  Claude 실행 → 오류 수정
        ↓ STATUS: COMPLETE
  TASK_DONE.md 생성 → 종료
```

---

## 자주 묻는 질문

**Q. AI가 실행되지 않아요**  
`claude`와 `codex` 명령어가 터미널에서 작동하는지 확인하세요. 안 되면 CLI 설치 단계를 다시 진행해보세요.

**Q. TASK_DONE.md가 생기지 않아요**  
Claude가 `STATUS: COMPLETE`를 출력하지 않으면 루프가 계속됩니다. 대시보드의 `Recent Reviews`에서 마지막 결과를 확인해보세요.

**Q. 라운드가 8번 넘어가면 어떻게 되나요?**  
자동으로 멈추고 사용자 확인을 기다립니다. `.env`에서 `AGENT_MAX_ROUNDS` 값을 늘릴 수 있습니다.

**Q. 실행 중에 작업을 중단할 수 있나요?**  
대시보드의 `■ Stop` 버튼을 누르면 현재 라운드 완료 후 루프가 중단됩니다.

**Q. 게임 말고 다른 프로젝트에도 쓸 수 있나요?**  
네. 웹, 백엔드, 스크립트 등 어떤 프로젝트든 `CLAUDE.md`, `AGENTS.md`, `prompt.config.js` 세 파일만 바꾸면 됩니다.

---

## 개발 로그

### 2026-04-23 ~ 2026-04-24

**모니터링 대시보드 구현** (duo-agent 자체 제작)
- Vite + Vanilla JS 기반 대시보드 UI 구현
- `/api/state`, `/api/reviews` API 엔드포인트 추가 (vite.config.js 커스텀 플러그인)
- 실시간 2초 폴링으로 라운드 진행 상황, 에이전트 상태, 리뷰 로그 표시
- 다크 테마 + 터미널 감성 스타일

**에이전트 루프 개선**
- Codex의 `STATUS: COMPLETE` 무시 — Claude 리뷰를 반드시 거친 후 종료
- 에이전트 실패 시 자동 재시도 (`AGENT_MAX_RETRIES`, 기본 1회)
- `src/duo-agent.kick.js` 트리거 방식 → `watcher/.kick-trigger`로 변경 (src/ 오염 제거)
- stdin 미종료 문제 수정 (`stdio: ['ignore', 'pipe', 'pipe']`)

**대시보드 컨트롤 패널 추가**
- `▶ Kick` 버튼: goal / 기술 스택 / 제약 조건 구조화 폼 입력 후 에이전트 시작
- `■ Stop` 버튼: 실행 중 루프 즉시 중단
- `/api/kick`, `/api/stop` API 엔드포인트 추가
- 폼 입력 중 폴링 재렌더 방지 (포커스 유지)

**Pre-flight 단계 도입**
- Kick 시 Claude Code가 task.txt 분석 → `task-goals.json` 자동 생성
- 생성된 목표를 에이전트 프롬프트에 반영 — `prompt.config.js` 수동 수정 불필요

**코드 구조 개선**
- `--allowedTools` 환경변수(`CLAUDE_ALLOWED_TOOLS`)로 분리
- 역할 정의 중복 제거 (`CLAUDE.md`, `AGENTS.md`, `prompt.config.js` 통일)
- `@anthropic-ai/sdk` 의존성 추가 (채팅 기능 구현 후 폼 방식으로 전환하며 제거)
