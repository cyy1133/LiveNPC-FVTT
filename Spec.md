# FVTT AI NPC Runtime 제품/구현 노트

Last updated: 2026-03-12

## 1. 제품 목적

`FVTT AI NPC Runtime`은 Foundry VTT, Discord, LLM을 하나의 데스크톱 앱으로 묶어 NPC를 실제 운영 가능한 수준으로 자동화하는 도구입니다.

핵심 목표는 아래와 같습니다.

- Discord 대화를 NPC 개성에 맞게 처리
- FVTT 전투에서 NPC 턴을 자동 수행
- 비전투 장면에서 소셜 연기를 장면 단위로 조율
- DND5e 기본 제약을 가능한 한 전투 판단에 반영
- GM의 반복 조작 부담 감소

## 2. 현재 지원 범위

### 대화

- Discord 채널 기반 반응
- NPC별 성격 문서 연결
- 공용 세계관 문서 연결
- 이미지 프롬프트 확장

### 소셜 연기

- 글로벌 `Director` on/off
- 글로벌 `Ambient Chatter` on/off
- `Director Mode`: `off / nearby / directed`
- NPC별 social override와 social weight
- `@NPC 이름:` 형식의 월드 상태 입력
- Scene ID / Scene Name 기준 social preset 자동 매칭
- preset Export / Import / Capture / Apply
- NPC-to-NPC 후속 대화와 idle chatter 예산/쿨다운 관리
- 여러 FVTT 세션 기반 ownership 라우팅

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
- 소셜 연기 전용 탭
- 토큰 썸네일, 요약 상태, 카드 접힘 저장

## 3. 주요 런타임 구성

### `src/`

- Electron 메인/렌더러 UI
- 설정 편집, 버튼 액션, 상태 표시
- social preset import/export file picker bridge

### `runtime/`

- Discord 연동
- FVTT 연동
- LLM 프롬프트 및 응답 처리
- 전투 플래너
- 전술 경로/타겟 판단
- 소셜 디렉터 / 앰비언트 채터 / world-state 해석
- multi-session ownership routing

### `test/`

- Node test 기반 유닛 테스트
- 전술/전투 시나리오 회귀 테스트
- director / ambient / preset / multi-session smoke test

## 4. 소셜 연기 기본 원칙

### 글로벌 설정과 NPC override

소셜 연기는 글로벌 기본값과 NPC별 override 두 층으로 구성됩니다.

- 글로벌: Director / Ambient / World Activity / Scene Preset
- NPC별: enabled override, NPC-to-NPC 허용, ambient 허용, social weight, prompt override, ownership

기본 운영은 글로벌 값으로 하되, 특정 NPC만 더 수다스럽게 하거나 덜 끼어들게 만드는 식으로 조정합니다.

### World Activity 파싱

`Current World Setup`은 아래 두 종류로 해석됩니다.

- `@NPC 이름: 내용`
  - 해당 NPC의 현재 행동 메모
- 일반 문장
  - 장면 전체 분위기, 사건, 긴장도

예:

```text
@Barkeep: polishing mugs and listening for rumors
@Town Guard: checking the ledger by the front door
The tavern is tense after sundown.
```

### Scene Preset 해석

Scene preset은 다음 정보를 한 번에 저장합니다.

- director snapshot
- ambient snapshot
- world state text
- NPC별 social override
- scene id / scene name match key

해석 우선순위:

1. Scene ID 일치
2. Scene Name 일치
3. 일치 없으면 글로벌 기본값 사용

### 다중 세션 ownership

Foundry는 기본 세션 하나와 추가 세션 배열을 가질 수 있습니다.

- 기본 세션: GM 또는 메인 세션
- 추가 세션: 결석 플레이어 대행, 동료 NPC 전용 계정, 소유권 분리용 계정

NPC마다 `sessionId / userId / username` 기준으로 실행 세션을 고를 수 있습니다.

### 직렬 실행 원칙

현재 비전투 연기는 "겉보기 동시성"을 목표로 하지만 내부적으로는 전역 작업 큐를 통해 직렬화됩니다.

이유:

- actor selector와 Foundry 상호작용 충돌 방지
- 무한 루프 완화
- 로그 추적 단순화
- multi-session 상태 관리 단순화

즉, 짧은 line delay를 두어 동시에 말하는 것처럼 보이게 하되 실제 실행은 안전하게 순차 처리합니다.

### 루프 방지 / 비용 관리

아래 제약으로 소셜 연기 비용을 관리합니다.

- NPC cooldown
- scene cooldown
- token budget per window
- max NPC-only chain turns
- max participants

## 5. 전투 판단 기본 원칙

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

## 6. 현재 문서 구조

- `README.md`: 공개 소개 문서
- `QUICKSTART_KR.md`: EXE 실행 가이드
- `RELEASE_GUIDE_KR.md`: 배포 체크리스트
- `CHANGELOG.md`: 버전 변경 내역
- `Spec.md`: 내부 설계/운영 메모
- `docs/release/*`: 릴리스 본문, 커뮤니티 소개글, 데모 체크리스트

## 7. 배포 기준

기본 배포 단위는 `Windows 설치형 EXE`입니다.

권장 사용자 흐름:

1. EXE 설치
2. Quick Setup 입력
3. Codex Login
4. Diagnostics
5. NPC 설정
6. 소셜 연기 preset 적용
7. Start
8. Discord / 비전투 / 전투 확인

## 8. 알려진 한계

현재 범위는 실전 운영형 1차 구현입니다. 아래 항목은 지속 보강 대상입니다.

- literal simultaneous playback는 아직 지원하지 않음
- Foundry 버전별 세부 API 차이
- 특수 벽/문 상태
- 복잡한 AoE 중심점 최적화
- 모듈별 커스텀 상태 처리 차이
- Scene Name 매칭은 씬 이름 정합성에 영향을 받음

## 9. 퍼블리시 원칙

퍼블리시 시에는 아래 순서를 유지합니다.

1. 문서 정리
2. 테스트 통과
3. EXE 빌드
4. Git 커밋/푸시
5. GitHub Release 작성
