# FVTT AI NPC Runtime v0.1.0

FVTT AI NPC Runtime은 Foundry VTT, Discord, LLM을 하나의 Windows 데스크톱 앱으로 연결해 NPC가 대화하고 전투 턴을 수행할 수 있게 돕는 런타임입니다.

## 무엇을 해 주나

- Discord에서 NPC가 캐릭터다운 말투로 응답
- Foundry 전투 상태를 읽고 자기 턴 행동 결정
- 이동, 행동, 보조 행동, 짧은 대사를 순서대로 실행
- 죽은 적, HP 0 적, 비전투 참가 적을 공격 대상에서 제외
- DND5e 행동경제를 반영해 무리한 2중 액션 방지
- 시야, 벽, 경로, difficult terrain, cover를 반영한 1차 전술 판단
- NPC별 Soul / Battle Rule / World Lore Markdown 문서 연결

## 이런 GM에게 적합함

- 장기 캠페인에서 NPC 수가 많은 경우
- Discord와 Foundry를 같이 쓰는 경우
- NPC를 단순 챗봇이 아니라 지속적으로 운영하고 싶은 경우
- 전투 판단이 HP, 상태이상, 집중, 자원에 맞게 움직이길 원하는 경우

## 이번 릴리스 포함 파일

- `FVTT AI NPC Runtime Setup 0.1.0.exe`

## 빠른 시작

1. EXE 설치
2. 앱 실행
3. `Quick Setup` 입력
4. `Install Prerequisites`
5. `Codex Login`
6. `Diagnostics`
7. `Start`

자세한 문서:

- `README.md`
- `QUICKSTART_KR.md`

## 0.1.0 핵심 변경점

- Windows 설치형 EXE 배포
- Discord / FVTT / LLM Quick Setup UI
- 토큰 썸네일과 접힘 카드 기반 NPC 패널
- 전투 자동 턴 실행과 자동 턴 종료
- dead / HP 0 / 비전투 참가 적 제외
- LOS, 벽, difficult terrain, 대각선 비용, cover 반영 전술 경로 판단
- 런타임 stop 이후 queued FVTT 작업 레이스 수정
- 퍼블리시용 문서와 런치 자산 정리

## 참고

- 이 릴리스는 standalone 데스크톱 런타임이며, Foundry 모듈 자체는 아닙니다.
- Stable Diffusion WebUI 연동은 선택 사항입니다.

## 피드백

버그 제보와 기능 요청은 GitHub Issues로 부탁드립니다.
