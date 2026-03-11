# FVTT AI NPC Runtime 제품/구현 노트

Last updated: 2026-03-11

## 1. 제품 목적

`FVTT AI NPC Runtime`은 Foundry VTT, Discord, LLM을 하나의 데스크톱 앱으로 묶어 NPC를 실제 운영 가능한 수준으로 자동화하는 도구입니다.

핵심 목표는 아래와 같습니다.

- Discord 대화를 NPC 개성에 맞게 처리
- FVTT 전투에서 NPC 턴을 자동 수행
- DND5e 기본 제약을 가능한 한 전투 판단에 반영
- GM의 반복 조작 부담 감소

## 2. 현재 지원 범위

### 대화

- Discord 채널 기반 반응
- NPC별 성격 문서 연결
- 공용 세계관 문서 연결
- 이미지 프롬프트 확장

### 전투

- 자동 턴 감지
- 액션 세트 순차 실행
- 턴 종료 자동 처리
- 죽은 적 / HP 0 / 전투 미참가 적 제외
- 시야 / 벽 / 경로 / 엄폐 / 지형 반영 1차 전술 판단

### 운영

- Quick Setup
- Codex Login
- Diagnostics
- NPC 카드 기반 설정 UI
- 토큰 썸네일, 요약 상태, 카드 접힘 저장

## 3. 주요 런타임 구성

### `src/`

- Electron 메인/렌더러 UI
- 설정 편집, 버튼 액션, 상태 표시

### `runtime/`

- Discord 연동
- FVTT 연동
- LLM 프롬프트 및 응답 처리
- 전투 플래너
- 전술 경로/타겟 판단

### `test/`

- Node test 기반 유닛 테스트
- 전술/전투 시나리오 회귀 테스트

## 4. 전투 판단 기본 원칙

### 타겟 유효성

아래 조건 중 하나라도 만족하면 기본 공격 후보에서 제외합니다.

- dead / defeated / 사망 유사 상태
- HP 0
- 현재 전투 미참가
- 시야 없음
- line of effect 없음

### 행동 경제

한 턴에는 DND5e 기준 행동 자원을 초과해서 사용하지 않도록 제한합니다.

- 이동
- 액션
- 보조 행동
- 반응은 별도 맥락

예:

- `소검 공격` + `잔혹한 모욕`은 둘 다 액션이므로 기본적으로 같은 턴에 동시 사용 불가

### 이동

- 직선 강행 대신 경로를 우선 사용
- 경로 비용에 difficult terrain 반영
- 대각선 비용 규칙 반영
- 엄폐/시야를 고려한 공격 가능한 위치를 탐색

## 5. 현재 문서 구조

- `README.md`: 공개 소개 문서
- `QUICKSTART_KR.md`: EXE 실행 가이드
- `RELEASE_GUIDE_KR.md`: 배포 체크리스트
- `CHANGELOG.md`: 버전 변경 내역
- `Spec.md`: 내부 설계/운영 메모

## 6. 배포 기준

기본 배포 단위는 `Windows 설치형 EXE`입니다.

권장 사용자 흐름:

1. EXE 설치
2. Quick Setup 입력
3. Codex Login
4. Diagnostics
5. Start
6. NPC 설정
7. Discord / FVTT 연동 확인

## 7. 알려진 한계

현재 전술 판단은 1차 구현 범위입니다. 아래 항목은 지속 보강 대상입니다.

- Foundry 버전별 세부 API 차이
- 특수 벽/문 상태
- 복잡한 AoE 중심점 최적화
- 모듈별 커스텀 상태 처리 차이

## 8. 퍼블리시 원칙

퍼블리시 시에는 아래 순서를 유지합니다.

1. 문서 정리
2. 테스트 통과
3. EXE 빌드
4. Git 커밋/푸시
5. GitHub Release 작성
