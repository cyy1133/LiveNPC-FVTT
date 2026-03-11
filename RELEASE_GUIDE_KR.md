# FVTT AI NPC Runtime 배포 가이드

이 문서는 저장소를 정리하고 GitHub에 퍼블리시할 때 필요한 최소 절차를 한 번에 확인하기 위한 문서입니다.

실제 붙여넣기용 릴리스 본문과 커뮤니티 소개글은 `docs/release/LAUNCH_KIT_KR.md`를 기준으로 사용하면 됩니다.

## 목표

배포 시 아래 4가지를 동시에 만족시키는 것이 목표입니다.

1. GitHub 방문자가 프로그램 목적을 바로 이해할 것
2. EXE 사용자 기준 실행 방법이 바로 보일 것
3. 최신 변경 사항이 무엇인지 확인할 수 있을 것
4. 릴리스 파일과 문서가 서로 모순되지 않을 것

## 저장소에 반드시 있어야 하는 문서

- `README.md`
  - 제품 개요
  - 핵심 효용
  - 스크린샷
  - 빠른 시작 진입점
- `QUICKSTART_KR.md`
  - 5분 내 실행 절차
  - 설치 후 버튼 순서
  - 자주 막히는 지점
- `CHANGELOG.md`
  - 버전별 변경 사항
- `Spec.md`
  - 내부 설계/운영 메모
- `docs/images/*`
  - README / Quickstart에 쓰이는 이미지

## 퍼블리시 직전 체크리스트

### 문서

- README 첫 화면에서 제품 성격이 10초 안에 이해되는가
- README에 실제 UI 스크린샷이 포함되어 있는가
- QUICKSTART가 README보다 짧고 실행 중심으로 정리되어 있는가
- 버전 번호가 문서와 EXE 파일명에서 일치하는가
- 깨진 인코딩 문서가 남아 있지 않은가

### 기능

- `npm test` 통과
- `npm run diagnose` 통과
- `npm run dist` 통과
- EXE 설치 후 실행 가능
- `Start -> 전투 자동 턴 -> 턴 종료`가 정상 동작

### 배포 자산

- 설치형 EXE
- 필요 시 `.blockmap`
- 스크린샷 이미지
- 릴리스 노트 초안

## 권장 배포 절차

1. 문서와 코드 정리
2. `CHANGELOG.md` 업데이트
3. 테스트 실행
4. EXE 재빌드
5. Git 커밋
6. GitHub 푸시
7. GitHub Release 생성
8. 설치형 EXE 업로드
9. 릴리스 노트 붙여넣기

## GitHub Release 작성 템플릿

아래 형식으로 작성하면 충분합니다.

### 제목

`FVTT AI NPC Runtime v0.1.0`

### 요약

- Foundry VTT, Discord, LLM을 연결하는 데스크톱 런타임
- EXE만 설치해서 바로 실행 가능
- NPC 자동 대화, 자동 전투, 문서 기반 개성 유지 지원

### 주요 변경 사항

- 전투 자동 턴 처리 안정화
- DND5e 행동 경제 반영 강화
- dead / HP 0 / 비전투 참가 대상 제외
- 시야 / 벽 / 경로 / 엄폐 기반 전술 판단 추가
- NPC 카드 UI 개선
- 종료 레이스 수정

### 포함 파일

- `FVTT AI NPC Runtime Setup 0.1.0.exe`

### 권장 문서

- `README.md`
- `QUICKSTART_KR.md`

## 배포 후 확인

GitHub 저장소에서 아래 동선이 자연스러워야 합니다.

1. 방문자가 `README.md`를 읽는다
2. 바로 `QUICKSTART_KR.md`로 이동한다
3. Releases 탭에서 EXE를 받는다
4. 설치 후 `Install Prerequisites -> Codex Login -> Diagnostics -> Start` 순서로 실행한다

이 흐름이 막히지 않으면 기본 배포 품질은 충분합니다.
