# Smoke Test Guide

이 문서는 `Quick Director`, `Node Storybook`, 전투 자동화, LLM provider 변경이 최소 기능 수준에서 정상 동작하는지 빠르게 확인하기 위한 체크리스트다.

## 1. 자동화 스모크 테스트

다음 테스트는 `npm test`에 포함된다.

- `test/director-orchestration-smoke.test.js`
  - 근접 NPC lead 선택
  - ambient chatter와 follow-up 직렬 실행
  - scene cooldown 적용
- `test/noncombat-parallel-smoke.test.js`
  - 비전투 연기가 공유 FVTT client 위에서 직렬화되는지 확인
- `test/storybook-runtime.test.js`
  - Node Storybook 활성 노드/전이 상태가 런타임에서 유지되는지 확인
- `test/openai-client.test.js`
  - provider별 API 선택(`responses` vs `chat.completions`) 확인
- `test/vertex-ai-client.test.js`
  - Vertex AI endpoint 구성
  - gcloud/manual token auth 분기 확인

실행:

```powershell
npm test
```

## 2. 수동 스모크 테스트

### A. Runtime 기본

1. 앱 실행
2. `Quick Setup`에 Discord/FVTT/LLM 기본값 입력
3. `Diagnostics` 실행
4. `Start` 실행
5. `Stop` 실행

성공 기준:

- Diagnostics에서 `discord`, `fvtt`, `llm` 모두 `ok`
- `Start` 후 로그에 `runtime started`
- `Stop` 후 추가 전투/대화 작업이 이어지지 않음

### B. Quick Director

1. `Social > Quick Director`에서 `enabled` 켜기
2. `allowAmbientTalk`, `allowNpcToNpc` 켜기
3. 플레이어 토큰을 NPC 근처로 이동
4. NPC가 주변 잡담 또는 짧은 follow-up을 생성하는지 확인

성공 기준:

- lead NPC 1명이 먼저 말함
- 필요 시 다른 NPC 1명이 짧게 이어받음
- 같은 장면에서 바로 무한 반복하지 않음

### C. Node Storybook

1. `Social > Node Storybook` 진입
2. 새 그래프 생성
3. 노드 2개 생성
   - `guard-shift`
   - `alert`
4. 전이 1개 생성
   - 조건: `player-nearby`
   - target: `alert`
5. 저장 후 runtime 시작
6. 플레이어를 가까이 이동
7. `Social > Live Status`에서 active node와 recent transition 확인

성공 기준:

- 처음에는 `guard-shift`
- 플레이어 접근 뒤 `alert`로 전이
- `recentTransitions`에 이유와 시간이 남음

### D. 전투 자동화

1. active combat에 NPC와 적 배치
2. 벽, 엄폐, dead target, out-of-combat target을 같이 준비
3. NPC 턴이 올 때 자동 행동 확인

성공 기준:

- dead / HP 0 / non-participant target 무시
- LOS/path를 고려해 이동 또는 다른 대상 선택
- 행동 세트 종료 후 턴 자동 종료

### E. LLM Provider 교체

#### Codex CLI

1. provider를 `Codex CLI`로 설정
2. `Install Prerequisites`
3. `Codex Login`
4. `Diagnostics`

#### OpenAI API Key

1. provider를 `OpenAI API Key`로 설정
2. key 입력
3. `Diagnostics`

#### Vertex AI

1. provider를 `Vertex AI`로 설정
2. `projectId`, `location`, `model` 입력
3. auth mode 선택
   - `gcloud CLI`: `gcloud Login` 후 `Diagnostics`
   - `Access Token`: token 입력 후 `Diagnostics`

#### OpenAI-Compatible API

1. provider를 `OpenAI-Compatible API`로 설정
2. `baseUrl`, `model`, `apiKey` 입력
3. `Diagnostics`

성공 기준:

- provider status 문구가 설정 상태를 반영
- Diagnostics `llm.ok=true`
- 실제 대화 1회 또는 전투 1회에서 JSON completion 성공

## 3. 릴리스 전 최소 기준

릴리스 직전에는 아래만 통과하면 된다.

1. `npm test`
2. `npm run diagnose`
3. 수동으로 `Quick Director` 1개 장면 확인
4. 수동으로 `Node Storybook` 1개 전이 확인
5. 수동으로 전투 1턴 자동 종료 확인
6. 사용할 기본 provider 1종 이상 실제 completion 확인
