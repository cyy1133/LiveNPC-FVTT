# Changelog

## 0.1.0 - 2026-03-11

첫 공개 배포 준비 버전입니다.

### Added

- Windows 설치형 EXE 기반 데스크톱 런타임
- Quick Setup 기반 Discord / FVTT / LLM 설정 UI
- NPC별 Soul / Battle Rule / World Lore Markdown 연결
- 전투 자동 턴 실행과 자동 턴 종료
- 전투 중 이동 / 행동 / 보조행동 / 대사 액션 세트 실행
- dead / HP 0 / 비전투 참가 적 제외 로직
- DND5e 행동 경제 반영
- 상태이상 / 집중 / 주문 슬롯 / HP 반영
- 시야 / 벽 / 경로 / 엄폐 / 지형 기반 1차 전술 판단
- NPC 카드 썸네일, 카드 접힘 저장, 리스트 가상화
- 전술 유닛 테스트와 전투 시나리오 테스트

### Changed

- README를 EXE 사용자 기준으로 재구성
- QUICKSTART 문서를 실행 절차 중심으로 정리
- 내부 설계 메모를 정리해 인코딩이 깨진 문서를 교체

### Fixed

- 이미 죽은 적을 공격 대상으로 선택하던 문제
- 전투에 참여하지 않은 적을 타겟팅하던 문제
- stop 이후 남아 있던 큐 작업이 `FVTT not configured`를 발생시키던 종료 레이스
