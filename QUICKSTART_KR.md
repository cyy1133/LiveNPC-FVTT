# FVTT AI NPC Runtime 빠른 시작 (Windows)

## 1) 설치

1. `fvtt-ai-runtime/dist/FVTT AI NPC Runtime Setup 0.1.0.exe` 실행
2. 설치 후 시작 메뉴에서 `FVTT AI NPC Runtime` 실행

## 2) 추천 LLM 방식 (구독형)

기본 추천은 `Codex CLI (ChatGPT subscription)` 입니다.

- API Key 없이 사용 가능
- OpenClaw 없이 독립 실행 가능
- Codex 로그인만 완료하면 진단/실행 가능

## 3) 최초 설정 순서

1. `Quick Setup` 입력
- Discord Bot Token
- Discord Channel (기본 `aibot`)
- FVTT URL / Username / Password
- 필요 시 NPC Actor 이름

2. `LLM Provider = Codex CLI (ChatGPT subscription)` 선택
- Model: 기본 `gpt-5.3-codex`
- `Codex CLI Path`는 보통 비워도 됨 (`codex.exe`가 PATH에 있으면 자동 탐지)

3. `Install Prerequisites` 버튼 클릭 (최초 1회 권장)
- Codex가 없으면 자동 설치 시도
- npm/Node가 없으면 Windows에서 `winget`으로 Node LTS 설치 시도
- 설치가 끝나면 `codex` 경로를 자동 저장

4. `Codex Login` 버튼 클릭
- 터미널 창이 열림
- 해당 창에서 로그인 완료

5. `Diagnostics` 실행
- `discord`, `fvtt`, `llm`가 모두 `ok`인지 확인

6. `Start` 실행

## 3-1) 기본 세계관/NPC/전투 패턴 MD

- 첫 실행 시 설정 파일 폴더 아래에 `persona-defaults`가 자동 생성됩니다.
- 기본 파일:
  - `world.md` (공용 세계관)
  - `npc.md` (기본 성격/대화)
  - `battlePattern.md` (기본 전투 패턴)
- 기본 NPC `diana`는 위 3개 파일을 자동 연결해서 시작합니다.
- UI에서 파일 경로를 바꾸거나 `Edit`로 바로 수정/저장할 수 있습니다.

## 4) 사용 방법

- Discord의 `#aibot` 채널에서 봇 멘션 후 대화
- 멀티 NPC일 때는 이름 포함 호출 권장
- 설정 화면은 `기본 설정` / `NPC 설정` 탭으로 분리되어 있습니다.
- `기본 설정 > Image` 탭에서 SD WebUI URL 및 이미지 크기(px)를 설정할 수 있습니다.
- NPC 패널의 `Add NPC` 버튼으로 다중 NPC를 추가할 수 있습니다.
- 추가된 각 NPC 카드에는 `Delete NPC` 버튼이 있으며, 삭제 시 `yes` 입력 확인이 필요합니다.
- NPC 패널에서 `Save NPC` / `Reload NPC`로 NPC 설정만 별도로 저장/다시불러오기 할 수 있습니다.
- 각 NPC의 `React Distance <= (ft)`로 반응 거리 상한을 설정할 수 있습니다.
  - 소스 토큰 거리가 이 값보다 멀면 해당 NPC는 LLM 호출을 생략합니다.
  - 소스 토큰(발화자)을 찾지 못해도 해당 NPC는 반응을 생략합니다.
  - `0`이면 거리 게이트를 끕니다.
- 각 NPC 카드의 `Image Prompt Settings`(접기/펼치기)에서:
  - 이미지 생성 허용 on/off
  - NPC 기본 이미지 프롬프트(default prompt)
    를 개별 설정할 수 있습니다.
- FVTT 인바운드는 런타임 시작 시점 이후 메시지만 반응합니다.

## 4-2) 소스 원클릭 빌드

- 루트 폴더에서 `build-oneclick.bat` 실행
- 내부적으로 `npm run dist`를 수행하여 설치 파일(`dist/*.exe`)을 생성합니다.

## 4-1) 전체 왕복 로그 보기 (Discord <-> LLM <-> FVTT)

- Quick Setup에서 `Enable full trace log` 체크
- 실행 후 Log 패널에 `trace: full trace enabled: ...` 경로가 표시됨
- 해당 폴더에 `runtime-trace-YYYYMMDD-HHMMSS.ndjson` 파일 생성
- 이 파일에 다음이 순서대로 기록됨
  - Discord 인바운드/아웃바운드 원문
  - LLM 프롬프트/응답(JSON 파싱 전후)
  - FVTT 액션 요청/응답(이동, 타겟, 액션, AOE, 채팅)

참고:
- 로그가 매우 커질 수 있습니다.
- 민감정보 키 이름(`token`, `password`, `apiKey` 등)은 자동 마스킹됩니다.

## 5) 자주 발생하는 문제

### Codex 로그인 상태가 Not logged in
- `Codex Login` 다시 클릭 후 터미널에서 로그인 완료
- 완료 후 `Diagnostics` 재실행

### Codex 설치 실패
- 앱의 `Install Prerequisites`를 다시 실행
- 또는 터미널에서 수동 설치:
  - `npm install -g @openai/codex`

### OpenAI OAuth에서 401 권한 오류
- 조직/프로젝트 권한 부족 또는 scope 제한 키 문제
- 이 경우 `Codex CLI` 방식 사용을 권장

### Discord 응답 없음
- 채널명이 정확히 `aibot`인지 확인 (대소문자 무시)
- `requireMention=true`이면 반드시 멘션 필요

### FVTT 연결 실패
- FVTT 서버 실행 여부 확인
- URL/계정/비밀번호 재확인
- 해당 Actor/Token에 Owner 권한이 있는 계정인지 확인
