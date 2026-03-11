# 데모 촬영 체크리스트

이 문서는 출시 직전에 30초~60초 데모 영상을 만들 때 바로 따라 할 수 있도록 정리한 체크리스트입니다.

## 촬영 목표

영상 하나로 아래가 보여야 합니다.

1. 이 앱이 무엇인지
2. 설치 후 어떤 버튼을 누르면 되는지
3. NPC가 실제로 대화/전투를 수행하는지

## 권장 길이

- 짧은 버전: 30초
- 권장 버전: 45초~60초

## 권장 해상도

- 1920x1080
- UI 배율이 너무 크면 1600x900도 가능

## 촬영 전 준비

- 비밀번호, 토큰, API Key가 보이지 않도록 가림
- Discord 채널과 Foundry 씬을 미리 열어 둠
- 테스트용 NPC 1개 이상 활성화
- Diagnostics가 통과된 상태로 시작
- 로그 패널에 너무 긴 민감 로그가 남아 있지 않게 정리

## 샷 구성

### Shot 1. 앱 메인 화면 5초

보여줄 것:
- 앱 실행 직후 화면
- `Install Prerequisites`, `Codex Login`, `Diagnostics`, `Start`

자막 예시:
- `Discord와 Foundry를 연결해 NPC를 자동 운영하는 데스크톱 런타임`

### Shot 2. Quick Setup 6초

보여줄 것:
- Discord / FVTT / LLM 설정 화면
- 실제 민감정보는 마스킹

자막 예시:
- `Quick Setup으로 Discord, Foundry, LLM 연결`

### Shot 3. NPC 패널 6초

보여줄 것:
- 토큰 썸네일
- 카드 펼침/접힘
- Soul / Battle Rule / World Lore 연결

자막 예시:
- `NPC별 문서와 전투 규칙을 따로 연결`

### Shot 4. Diagnostics 성공 4초

보여줄 것:
- `discord ok`
- `fvtt ok`
- `llm ok`

자막 예시:
- `연결 상태를 먼저 점검`

### Shot 5. Discord 응답 8초

보여줄 것:
- Discord 채널에서 NPC 호출
- 앱 로그 또는 결과 확인

자막 예시:
- `NPC가 캐릭터 톤으로 응답`

### Shot 6. 전투 자동 턴 12초

보여줄 것:
- Foundry 전투 시작
- NPC 턴 도착
- 이동 / 행동 / 턴 종료

자막 예시:
- `HP, 상태이상, 경로, 행동경제를 보고 턴 수행`

### Shot 7. 마무리 4초

보여줄 것:
- GitHub Release 또는 README

자막 예시:
- `Windows EXE로 바로 실행 가능`

## 촬영 팁

- 로그는 한글/영문이 섞여도 괜찮지만, 핵심 성공 메시지만 보이게 자릅니다.
- Foundry에서는 전투 턴이 한 번 깔끔하게 끝나는 장면만 넣는 편이 좋습니다.
- 기능을 많이 보여주기보다 `설치 -> 진단 -> 대화 -> 전투` 흐름이 더 중요합니다.

## 영상이 없을 때 최소 대체물

영상이 준비되지 않았다면 아래 3개만 먼저 올려도 됩니다.

- `docs/images/readme-hero.png`
- `docs/images/readme-dashboard.png`
- `docs/images/readme-npc-panel.png`
