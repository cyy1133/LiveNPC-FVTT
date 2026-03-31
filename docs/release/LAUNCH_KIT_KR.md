# Launch Kit (KR)

이 폴더는 최신 `FVTT AI NPC Runtime` 빌드를 외부에 소개하고 배포할 때 필요한 문서와 문안을 한 번에 모아 둔 런치 킷입니다.

## 이 문서의 목적

이 킷을 기준으로 하면 실제 출시 작업은 아래만 하면 됩니다.

1. GitHub Release 생성
2. EXE 업로드
3. 릴리스 본문 붙여넣기
4. Discord / Reddit / SNS 글 붙여넣기
5. 필요하면 데모 영상 설명란 복사

## 바로 써야 하는 파일

### GitHub Release 본문

- 한국어: `docs/release/GITHUB_RELEASE_v0.1.0_KR.md`
- 영어: `docs/release/GITHUB_RELEASE_v0.1.0_EN.md`

주의:

- 파일명은 현재 템플릿 기준입니다.
- 실제 배포 시 제목, 태그, 바이너리 파일명은 현재 버전으로 치환해서 사용합니다.

### 커뮤니티 소개글

- 한국어: `docs/release/COMMUNITY_POSTS_KR.md`
- 영어: `docs/release/COMMUNITY_POSTS_EN.md`

포함 내용:

- Discord용 짧은 소개글
- Reddit용 긴 소개글
- X / Bluesky용 짧은 글
- 영상 설명란 초안

## 포지셔닝 핵심 문장

최신 빌드 소개에서 아래 포인트를 반복하는 것이 좋습니다.

- EXE 기반으로 바로 실행 가능
- Discord + Foundry + LLM을 한 런타임으로 묶음
- 전투뿐 아니라 `소셜 연기`와 `Scene Preset`까지 지원
- 결석 플레이어 대행이나 ownership 분리를 위한 multi-session 지원

## 데모/스크린샷 준비

- 촬영 체크리스트: `docs/release/DEMO_CAPTURE_CHECKLIST_KR.md`
- 기본 스크린샷:
  - `docs/images/readme-hero.png`
  - `docs/images/readme-dashboard.png`
  - `docs/images/readme-npc-panel.png`

추가 권장:

- `소셜 연기` 탭 캡처
- Scene Preset 적용 전/후 비교 컷
- 결석 플레이어 대행용 ownership 화면 캡처

## 업로드할 바이너리

- 설치형: `dist/FVTT AI NPC Runtime Setup [version].exe`
- 블록맵: `dist/FVTT AI NPC Runtime Setup [version].exe.blockmap`

## GitHub Release 권장 입력값

- Tag: `v[version]`
- Release title: `FVTT AI NPC Runtime v[version]`
- Primary asset: `FVTT AI NPC Runtime Setup [version].exe`

## 권장 출시 순서

1. GitHub에서 `v[version]` Release 생성
2. `dist/*.exe` 업로드
3. 릴리스 본문 템플릿을 현재 버전에 맞게 치환해서 붙여넣기
4. 공식 Foundry Discord에 `COMMUNITY_POSTS_EN.md`의 Discord 버전 게시
5. `r/FoundryVTT`에 `COMMUNITY_POSTS_EN.md`의 Reddit 버전 게시
6. 한국 커뮤니티에는 `COMMUNITY_POSTS_KR.md` 사용
7. 버그/요청은 GitHub Issues로 유도

## 출시 후 대응 동선

이미 템플릿을 준비해 두었습니다.

- 버그 리포트: `.github/ISSUE_TEMPLATE/bug-report.yml`
- 기능 요청: `.github/ISSUE_TEMPLATE/feature-request.yml`

## 출시 당일 체크리스트

- EXE가 최신 빌드인지 확인
- README 링크가 깨지지 않는지 확인
- Quickstart가 현재 UI와 일치하는지 확인
- `소셜 연기` 탭 스크린샷이나 영상 컷이 포함되어 있는지 확인
- Release 본문에 Scene Preset과 multi-session 설명이 들어 있는지 확인
- Discord / Reddit 글에 다운로드 링크가 들어 있는지 확인
- 영상이 없으면 최소 스크린샷 3장과 social tab 1장을 첨부

## 한 줄 전략

`배포는 GitHub Releases에서 하고, 유입은 Foundry Discord와 r/FoundryVTT에서 받고, 피드백은 실제 세션 운영 흐름 개선으로 다시 회수한다.`
