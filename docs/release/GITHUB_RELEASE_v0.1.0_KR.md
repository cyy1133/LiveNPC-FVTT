# FVTT AI NPC Runtime 릴리스 본문 템플릿

아래 내용을 현재 버전에 맞게 치환해서 사용하세요.

## 제목

`FVTT AI NPC Runtime v[version]`

## 본문

FVTT AI NPC Runtime은 Foundry VTT, Discord, LLM을 하나의 Windows 데스크톱 앱으로 연결해 NPC가 대화하고 전투를 수행하며, 비전투 장면에서는 소셜 연기까지 이어 갈 수 있게 돕는 런타임입니다.

## 무엇을 해 주나

- Discord에서 NPC가 캐릭터다운 말투로 응답
- Foundry 전투 상태를 읽고 자기 턴 행동 결정
- 이동, 행동, 보조 행동, 짧은 대사를 순서대로 실행
- `소셜 연기` 탭에서 Director와 Ambient를 별도로 관리
- `@NPC 이름:` 형식의 World Activity를 장면 프롬프트에 반영
- Scene Preset 저장, 적용, Export, Import 지원
- 여러 FVTT 세션을 등록해 NPC ownership이나 결석 플레이어 대행 지원
- NPC별 Soul / Battle Rule / World Lore Markdown 문서 연결

## 이런 GM에게 적합함

- 장기 캠페인에서 NPC 수가 많은 경우
- Discord와 Foundry를 같이 쓰는 경우
- NPC를 단순 챗봇이 아니라 지속적으로 운영하고 싶은 경우
- 전투 판단이 HP, 상태이상, 집중, 자원에 맞게 움직이길 원하는 경우
- 맵별 장면 준비를 preset으로 미리 저장하고 싶은 경우

## 이번 릴리스 포함 파일

- `FVTT AI NPC Runtime Setup [version].exe`

## 빠른 시작

1. EXE 설치
2. 앱 실행
3. `Quick Setup` 입력
4. `Install Prerequisites`
5. `Codex Login`
6. `NPC 설정`과 `소셜 연기` 탭 정리
7. `Diagnostics`
8. `Start`

자세한 문서:

- `README.md`
- `QUICKSTART_KR.md`

## 이번 릴리스 핵심 변경점

- 소셜 연기 탭 추가
- Director / Ambient 분리 토글
- `@NPC` World Activity 입력 지원
- Scene Preset `Capture / Apply / Export / Import`
- multi-session FVTT ownership routing
- 전투 자동 턴과 전술 판단 유지

## 참고

- 이 릴리스는 standalone 데스크톱 런타임이며, Foundry 모듈 자체는 아닙니다.
- Stable Diffusion WebUI 연동은 선택 사항입니다.
- 비전투 연기는 체감상 자연스럽게 이어지도록 설계되었지만 내부 실행은 안전한 직렬 처리입니다.

## 피드백

버그 제보와 기능 요청은 GitHub Issues로 부탁드립니다.
