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
[오전 10:00:00] 최대 라운드: 8
```

---

## 어떻게 사용하나요?

1. `src/` 폴더 안에 파일을 만들거나 수정합니다
2. 3초 후 자동으로 첫 번째 AI(Codex)가 실행됩니다
3. Codex가 끝나면 Claude Code가 이어서 리뷰 및 수정을 합니다
4. 작업이 완료되면 `TASK_DONE.md` 파일이 생성되고 자동으로 멈춥니다
5. 결과는 `reviews/` 폴더에 저장됩니다

### 다시 시작하려면

```bash
rm TASK_DONE.md   # 완료 파일 삭제
# 이후 src/ 파일을 수정하면 루프 재시작
```

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
├── src/                      ← 실제 작업 코드를 여기에 작성
├── watcher/
│   ├── watch.js              ← 협업 자동화 엔진 (수정 불필요)
│   └── prompt.config.js      ← AI에게 전달할 목표 (프로젝트마다 수정)
├── reviews/                  ← AI 작업 결과 자동 저장 (git 제외)
├── CLAUDE.md                 ← Claude 행동 지침
├── AGENTS.md                 ← Codex 행동 지침
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
| `FIRST_AGENT` | `codex` | 먼저 실행할 AI (`codex` 또는 `claude`) |
| `CLAUDE_CMD` | `claude` | Claude CLI 실행 명령어 |
| `CODEX_CMD` | `codex` | Codex CLI 실행 명령어 |

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
AI가 `STATUS: COMPLETE`를 출력하지 않으면 루프가 계속됩니다. `reviews/` 폴더에서 마지막 결과를 확인해보세요.

**Q. 라운드가 8번 넘어가면 어떻게 되나요?**  
자동으로 멈추고 사용자 확인을 기다립니다. `.env`에서 `AGENT_MAX_ROUNDS` 값을 늘릴 수 있습니다.

**Q. 게임 말고 다른 프로젝트에도 쓸 수 있나요?**  
네. 웹, 백엔드, 스크립트 등 어떤 프로젝트든 `CLAUDE.md`, `AGENTS.md`, `prompt.config.js` 세 파일만 바꾸면 됩니다.
