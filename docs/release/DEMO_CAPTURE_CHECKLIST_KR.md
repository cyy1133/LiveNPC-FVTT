# 데모 촬영 체크리스트

이 문서는 출시 직전에 30초~90초 데모 영상을 만들 때 바로 따라 할 수 있도록 정리한 체크리스트입니다.

## 촬영 목표

영상 하나로 아래가 보여야 합니다.

1. 이 앱이 무엇인지
2. 설치 후 어떤 버튼을 누르면 되는지
3. NPC가 대화, 소셜 연기, 전투를 실제로 수행하는지
4. 맵별 준비를 preset으로 빠르게 교체할 수 있는지

## 권장 길이

- 짧은 버전: 30초
- 권장 버전: 45초~60초
- 확장 버전: 75초~90초

## 권장 해상도

- 1920x1080
- UI 배율이 너무 크면 1600x900도 가능

## 촬영 전 준비

- 비밀번호, 토큰, API Key가 보이지 않도록 가림
- Discord 채널과 Foundry 씬을 미리 열어 둠
- 테스트용 NPC 2명 이상 활성화
- Diagnostics가 통과된 상태로 시작
- `소셜 연기` 탭에 Scene Preset 하나 이상 준비
- 결석 플레이어 대행 demo를 할 경우 extra session 계정도 로그인 완료
- 로그 패널에 너무 긴 민감 로그가 남아 있지 않게 정리

## 이번 기능 기준 추천 영상 아이디어

### 1. 여관이 살아 있는 장면

핵심 메시지:

- 플레이어가 말을 안 걸어도 NPC들이 완전히 멈춰 있지 않다
- Director와 Ambient를 따로 조절할 수 있다

구성:

1. `소셜 연기` 탭에서 `Enable social director`와 `Enable ambient chatter`를 켠다
2. `@Barkeep`, `@Town Guard` world activity를 보여 준다
3. Foundry 여관 맵으로 전환
4. 플레이어가 근처를 지나가자 짧은 ambient line과 follow-up이 나온다

### 2. 결석 플레이어 대행 장면

핵심 메시지:

- NPC뿐 아니라 오늘 못 온 플레이어 캐릭터도 다른 세션으로 대행할 수 있다

구성:

1. `Quick Setup`에서 `Extra FVTT Sessions` JSON을 짧게 보여 준다
2. 해당 캐릭터의 NPC 카드에서 `FVTT Ownership / Session`을 지정한다
3. 실제 씬에서 그 캐릭터가 반응하거나 이동하는 장면을 보여 준다

### 3. 맵 전환 프리셋 장면

핵심 메시지:

- DM 준비물이 맵별로 한 번에 바뀐다

구성:

1. `Scene Preset`에서 `Tavern Night` preset을 보여 준다
2. `Import Preset` 또는 `Apply Preset`을 실행한다
3. `Current World Setup`이 즉시 바뀌는 모습을 보여 준다
4. Foundry 씬을 전환하고 자동 매칭되는 흐름을 보여 준다

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
- `Default FVTT Session ID`
- `Extra FVTT Sessions`

자막 예시:

- `Quick Setup으로 Discord, Foundry, LLM, 세션 라우팅까지 한 번에 설정`

### Shot 3. NPC 패널 7초

보여줄 것:

- 토큰 썸네일
- 카드 펼침/접힘
- Soul / Battle Rule / World Lore 연결
- `FVTT Ownership / Session`

자막 예시:

- `NPC별 문서, 소유권, 소셜 weight를 따로 관리`

### Shot 4. 소셜 연기 탭 8초

보여줄 것:

- Director on/off
- Ambient on/off
- `Current World Setup`
- `Capture Current` 또는 `Apply Preset`

자막 예시:

- `맵별 소셜 연기 준비를 preset으로 저장하고 즉시 교체`

### Shot 5. Diagnostics 성공 4초

보여줄 것:

- `discord ok`
- `fvtt ok`
- `llm ok`

자막 예시:

- `연결 상태를 먼저 점검`

### Shot 6. 소셜 반응 8초

보여줄 것:

- 여관이나 마을 맵
- 플레이어 주변 NPC의 ambient 대사 또는 짧은 후속 대화

자막 예시:

- `NPC가 플레이어 주변 장면을 짧게 살아 있게 유지`

### Shot 7. Discord 응답 8초

보여줄 것:

- Discord 채널에서 NPC 호출
- 앱 로그 또는 결과 확인

자막 예시:

- `NPC가 캐릭터 톤으로 응답`

### Shot 8. 전투 자동 턴 12초

보여줄 것:

- Foundry 전투 시작
- NPC 턴 도착
- 이동 / 행동 / 턴 종료

자막 예시:

- `HP, 상태이상, 경로, 행동경제를 보고 턴 수행`

### Shot 9. 마무리 4초

보여줄 것:

- GitHub Release 또는 README

자막 예시:

- `Windows EXE로 바로 실행 가능`

## 촬영 팁

- 로그는 한글/영문이 섞여도 괜찮지만, 핵심 성공 메시지만 보이게 자릅니다.
- `Current World Setup`은 2~3줄만 보여 주는 편이 전달력이 좋습니다.
- Ambient는 너무 길게 말하면 템포가 무너집니다. 1문장 또는 짧은 2문장 컷이 좋습니다.
- preset Import는 파일 선택 화면을 길게 잡지 말고, 적용 후 값이 바뀌는 장면을 중심으로 편집합니다.
- Foundry에서는 전투 턴이 한 번 깔끔하게 끝나는 장면만 넣는 편이 좋습니다.

## 영상이 없을 때 최소 대체물

- `docs/images/readme-hero.png`
- `docs/images/readme-dashboard.png`
- `docs/images/readme-npc-panel.png`
- `소셜 연기` 탭 캡처 이미지 1장
