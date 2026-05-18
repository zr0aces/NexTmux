# TermHub

tmux를 활용한 멀티 터미널 세션 웹 대시보드. Claude, Gemini, GPT 등 어떤 CLI든 실행하고 한 곳에서 모니터링하세요.

이 프로젝트가 유용했다면 GitHub 스타로 응원해 주세요.

## 프로젝트 상태

TermHub는 현재 활발히 개발 중이며, 일부 버그나 미완성된 부분이 있을 수 있습니다.
문제를 발견하셨다면 재현 방법과 함께 이슈를 등록해 주세요.
버그 제보와 기여는 언제나 환영합니다.

## 주요 기능

- **모든 명령어 실행** — 원하는 CLI 도구로 세션 생성 (기본: `claude`)
- **멀티 터미널 관리** — 각 세션이 독립적인 tmux 세션으로 실행
- **실시간 로그** — tmux 출력을 실시간으로 캡처 및 표시
- **AI 상태 감지** — 터미널 출력을 분석하여 AI 상태를 자동 감지:
  - 🔵 작업 중 → 🟢 대기 → 🟡 결정 필요 (권한 요청)
- **Telegram 대기 알림** — AI CLI가 입력을 기다릴 때 Telegram으로 아웃바운드 알림
- **양방향 미러링** — 대시보드와 로컬 터미널에서 동일 세션을 동시에 확인

### 부가 기능

- **tmux 세션 스캔** — 기존 세션 자동 감지 및 연결
- **Tab / Split 레이아웃** — Tab으로 집중, Split으로 나란히 보기
- **즐겨찾기 & 최근 경로** — 자주 사용하는 디렉토리 빠른 접근
- **비밀번호 인증 + 외부 터널** — Cloudflare(권장) 또는 ngrok으로 외부 접근
- **적응형 터미널 크기** — 화면에 맞게 tmux 자동 리사이즈
- **키보드 단축키** — Esc, Shift+Tab, Ctrl+C, 방향키를 활성 워커에 전달

## 사전 요구사항

- [Node.js](https://nodejs.org)
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (선택사항, 외부 접근용 — 권장)
- [ngrok](https://ngrok.com) (선택사항, 외부 접근용)

## 빠른 설치

셋업 스크립트를 실행하면 의존성 설치, 설정 파일 생성, 백그라운드 서비스 등록이 한 번에 완료됩니다:

```bash
git clone https://github.com/sunmerrr/TermHub.git
cd termhub
npm run setup
```

셋업 스크립트가 수행하는 작업:
1. Node.js, tmux 확인 (없으면 Homebrew로 tmux 설치)
2. `npm install` 실행
3. `.env` 생성 — 비밀번호와 포트 입력
4. `config.json` 생성 — 기본 경로와 기본 명령어 입력
5. macOS launchd 서비스 등록 — 부팅 시 자동 시작, 크래시 시 자동 재시작

설치 후 TermHub는 백그라운드에서 실행됩니다. 서비스 관리:

```bash
launchctl unload ~/Library/LaunchAgents/com.termhub.server.plist   # 중지
launchctl load ~/Library/LaunchAgents/com.termhub.server.plist     # 시작
cat /tmp/termhub.log                                                # 로그 확인
```

## 수동 설치

셋업 스크립트 대신 수동으로 설정하려면:

```bash
npm install
cp config.example.json config.json   # basePath, favorites, defaultCommand 수정
echo -e "PORT=8081\nDASHBOARD_PASSWORD=yourpass" > .env
node server.js
```

launchd 없이 수동으로 실행하려면:

```bash
node server.js                                        # 서버 시작
cloudflared tunnel --url http://localhost:8081         # 터널 시작 (선택, 별도 프로세스)
```

## 외부 접근 (Cloudflare / ngrok)

로컬 네트워크 외부(모바일, 다른 PC 등)에서 TermHub에 접근할 때는 터널 도구를 사용하세요.

> **권장:** Cloudflare Tunnel (`cloudflared`)  
> 이유: 계정/도메인 없이도 빠르게 임시 URL(`*.trycloudflare.com`)을 열 수 있고, 설정이 간단합니다.

### 옵션 A. Cloudflare (권장)

1. 설치

```bash
brew install cloudflared
```

2. 끝 — `cloudflared`가 PATH에 설치되어 있으면 TermHub가 서버 시작 시 자동으로 Cloudflare 터널을 실행합니다. 터널 URL은:

- 서버 로그에 출력 (`☁️  Tunnel URL → https://...`)
- API로 조회 가능: `GET /api/tunnel`
- WebSocket으로 연결된 클라이언트에 브로드캐스트

**터널 자동 실행 비활성화** (원격 접근이 필요 없거나 수동으로 실행하고 싶은 경우):

```env
# .env
ENABLE_TUNNEL=0
```

또는 `config.json`에서:

```json
{ "tunnel": { "enabled": false } }
```

3. (선택) **Discord 알림** — `.env`에 webhook URL을 추가하면 서버 시작 시 터널 URL이 Discord로 전송됩니다:

```env
DISCORD_WEBHOOK=https://discord.com/api/webhooks/your/webhook-url
```

> **참고:** `trycloudflare.com` URL은 임시 주소입니다. 재시작할 때마다 바뀝니다.

### 옵션 B. ngrok

1. 설치

```bash
brew install ngrok
```

2. 계정 연결

[ngrok 대시보드](https://dashboard.ngrok.com)에서 무료 계정을 생성한 후 authtoken을 등록하세요:

```bash
ngrok config add-authtoken <your-token>
```

3. 터널 시작

```bash
ngrok http 8081
```

4. 접속

출력에 표시되는 URL(예: `https://xxxx-xxxx.ngrok-free.app`)을 브라우저에서 열면 됩니다.

> **참고:** 무료 플랜은 ngrok을 시작할 때마다 새로운 URL이 생성됩니다. 고정 도메인을 사용하려면 `ngrok http --url=your-domain.ngrok-free.app 8081`으로 실행하세요.

## 사용법

### 새 세션 시작
1. 우측 상단의 **+** 버튼을 클릭하여 생성 도구바 열기
2. 📁 클릭으로 프로젝트 경로 선택 (즐겨찾기 및 최근 경로 지원)
3. 필요시 명령어 변경 (기본: `claude`)
4. **+ New** 클릭하여 세션 시작

### 기존 tmux 세션 연결
1. 헤더의 🔍 클릭으로 실행 중인 tmux 세션 스캔
2. 확인하여 대시보드에 추가

### 로컬 터미널에서 세션 보기
```bash
tmux attach -t term-1   # 워커 #1
tmux attach -t term-2   # 워커 #2
```

### 레이아웃 전환
헤더의 **Tab / Split** 버튼으로 전환. 선택은 브라우저에 저장됩니다.

### 워커 중지 및 제거
- 실행 중: **Stop** 버튼 — tmux 세션 종료
- 중지됨: **Remove** 버튼 — 대시보드에서 제거

## AI 대기 상태 모니터링

TermHub는 tmux 세션을 감시하여 Claude Code, Codex CLI, Gemini CLI, aider 등의 AI CLI가 사용자 입력을 기다리는 상태를 설정 가능한 정규식 규칙으로 자동 감지합니다.

- 폴링 간격 및 스캔 깊이 설정 가능
- 정규식 패턴 설정 가능 (`config.json` → `aiMonitor.patterns`)
- Telegram 아웃바운드 알림 (아웃바운드 전용 — 콜백 버튼 없음), 중복 알림 방지(디바운스) 적용
- 워커 카드 메타데이터 행:
  - 마지막 활동 시각
  - 마지막으로 감지된 프롬프트/패턴
  - 마지막 알림 상태 및 시각

### Telegram 알림 설정

`.env`에 아래 두 변수를 설정하면 아웃바운드 알림이 활성화됩니다:

```env
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_CHAT_ID=<chat-id>
```

Telegram 변수를 설정하지 않으면 UI에서 대기 상태 감지는 계속 동작하며, 알림 전송 단계만 안전하게 건너뜁니다.

### 모니터 튜닝

모든 설정은 선택 사항이며, 기본값으로도 바로 동작합니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `AI_MONITOR_ENABLED` | `1` | `0`으로 설정하면 모니터링 완전 비활성화 |
| `AI_MONITOR_POLL_INTERVAL_MS` | `1000` | tmux 패인 캡처 간격 (ms) |
| `AI_MONITOR_IDLE_THRESHOLD_MS` | `5000` | 출력 변화 없을 때 idle로 전환까지 대기 시간 (ms) |
| `AI_MONITOR_LINES_TO_SCAN` | `120` | 패턴 검사에 사용할 최근 라인 수 |
| `AI_MONITOR_NOTIFY_COOLDOWN_MS` | `120000` | 동일 알림 중복 방지 대기 시간 (ms) |

`config.json` → `aiMonitor` 객체로도 모든 값을 재정의할 수 있습니다 (`config.example.json` 참고).

## 파일 구조

```
termhub/
├── server.js              # Node.js 서버 (tmux 관리, WebSocket)
├── index.html             # 웹 UI 진입점
├── setup.sh               # 원스텝 셋업 스크립트
├── lib/
│   ├── patternEngine.js   # 정규식 대기 상태 감지
│   ├── watcherEngine.js   # 폴링 루프 + 상태 전환
│   ├── telegramService.js # Telegram 아웃바운드 알림
│   └── sessionStateManager.js  # 메타데이터 + 디바운스 + 영속화
├── public/
│   ├── style.css          # 스타일
│   └── js/
│       ├── layout.js      # 레이아웃 & 탭 관리
│       ├── favorites.js   # 즐겨찾기 & 경로 관리
│       ├── ws.js          # WebSocket & API 통신
│       ├── workers.js     # 워커 카드 UI & 액션
│       └── app.js         # 초기화 & 이벤트 바인딩
├── state/
│   └── session-state.json # 런타임 모니터링 메타데이터 스냅샷 (자동 생성)
├── config.json            # 사용자 설정 (gitignored)
├── config.example.json    # 설정 템플릿
├── .env                   # 환경 변수 (gitignored)
├── .env.example           # 환경 변수 템플릿
├── docker-compose.yml     # 선택적 Docker 배포
├── .gitignore
├── package.json
├── README.md              # English
└── README.ko.md           # 한국어
```

## 라이선스

MIT
