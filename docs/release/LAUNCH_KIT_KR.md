# Launch Kit (KR)

이 폴더는 `FVTT AI NPC Runtime v0.1.0`를 외부에 소개하고 배포할 때 필요한 문서와 문안을 한 번에 모아 둔 런치 킷입니다.

## 이 문서의 목적

이 킷을 기준으로 하면 실제 출시 작업은 아래만 하면 됩니다.

1. GitHub Release 생성
2. EXE 업로드
3. 릴리스 본문 붙여넣기
4. Discord / Reddit / SNS 글 붙여넣기

## 바로 써야 하는 파일

### GitHub Release 본문

- 한국어: `docs/release/GITHUB_RELEASE_v0.1.0_KR.md`
- 영어: `docs/release/GITHUB_RELEASE_v0.1.0_EN.md`

권장:

- GitHub Release 본문은 영어 버전을 기본으로 사용
- 저장소 README와 Quickstart는 한국어 유지

## 커뮤니티 소개글

- 한국어: `docs/release/COMMUNITY_POSTS_KR.md`
- 영어: `docs/release/COMMUNITY_POSTS_EN.md`

포함 내용:

- Discord용 짧은 소개글
- Reddit용 긴 소개글
- X / Bluesky용 짧은 글

## 데모/스크린샷 준비

- 촬영 체크리스트: `docs/release/DEMO_CAPTURE_CHECKLIST_KR.md`
- 기본 스크린샷:
  - `docs/images/readme-hero.png`
  - `docs/images/readme-dashboard.png`
  - `docs/images/readme-npc-panel.png`

## 업로드할 바이너리

- 설치형: `dist/FVTT AI NPC Runtime Setup 0.1.0.exe`
- 블록맵: `dist/FVTT AI NPC Runtime Setup 0.1.0.exe.blockmap`

## GitHub Release 권장 입력값

- Tag: `v0.1.0`
- Release title: `FVTT AI NPC Runtime v0.1.0`
- Primary asset: `FVTT AI NPC Runtime Setup 0.1.0.exe`

## 권장 출시 순서

1. GitHub에서 `v0.1.0` Release 생성
2. `dist/*.exe` 업로드
3. `GITHUB_RELEASE_v0.1.0_EN.md` 본문 붙여넣기
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
- Release 본문에 설치 순서가 들어 있는지 확인
- Discord / Reddit 글에 다운로드 링크가 들어 있는지 확인
- 영상이 없으면 최소 스크린샷 2장은 첨부

## 한 줄 전략

`배포는 GitHub Releases에서 하고, 유입은 Foundry Discord와 r/FoundryVTT에서 받고, 피드백은 GitHub Issues로 회수한다.`
