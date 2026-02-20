# FVTT AI NPC Runtime (Standalone Desktop EXE) - Spec Proposal

Version: v0.2 (proposal)  
Last updated: 2026-02-15  
Primary target: Windows (EXE)  
Secondary target: macOS (dmg), Linux (AppImage)  

## 0. Summary

OpenClaw 없이, 로컬에서 실행되는 데스크톱 앱 하나로 다음을 제공한다.

- Discord 채널에서 NPC에게 말을 걸거나, FVTT 안에서 NPC 주변에서 상호작용이 발생하면 NPC가 자연스럽게 반응한다.
- NPC의 성격/행동/전투 패턴은 Markdown 문서(Soul/Identity/Rules 등)로 관리한다.
- FVTT에 연결되면 NPC는 실제 토큰을 제어하고(이동, 타겟, 아이템/주문 사용, 범위 템플릿 확정 등) 결과가 FVTT 채팅 카드로 출력될 때까지 자동으로 확인/완료한다.
- LLM 연결은 API Key 방식과 OAuth 방식 모두 지원한다(특히 OpenAI Codex OAuth를 목표로 한다).
- 보안상 외부 노출 포트를 만들지 않고, OAuth 콜백이 필요한 경우에도 `127.0.0.1` 루프백만 사용한다.

본 문서는 “스펙 제안서”이며, 구현은 기존 `fvtt-discord-npc/`의 자동화 로직을 재사용하고 OpenClaw 부분만 제거/대체하는 방향으로 설계한다.

## 1. Goals / Non-goals

### 1.1 Goals (Must)

- OpenClaw 없이 동작하는 독립 런타임.
- 깔끔한 GUI로 NPC, 계정, 문서, 연결 상태를 관리.
- Discord 입력 <-> LLM <-> FVTT 액션의 end-to-end 파이프라인.
- NPC별 개별 활성/비활성.
- “대화 모드”와 “FVTT 연결 시 행동 모드”를 자동 전환.
- FVTT에서 다음이 가능해야 함.
- 최근 채팅 읽기(컨텍스트 파악).
- 씬/맵/토큰 목록과 위치 파악(최소한 좌표/거리 계산).
- NPC 토큰 이동.
- 타겟 지정(토큰 ID 기반 안정 동작).
- 액터 시트 읽기(인벤토리, 스펠/피처, 사용 가능한 액션).
- 아이템/주문 사용이 실제로 실행되어 FVTT 채팅 카드에 결과가 뜰 때까지 자동 처리.
- 범위 공격(템플릿 배치 후 확정 클릭 포함) 자동 처리.
- 메모리 갱신은 FVTT 이벤트 기반으로만 반영(Discord 대화는 메모리에 직접 반영하지 않음).

### 1.2 Non-goals (Now)

- “GM 완전 대행” 수준의 게임 운영 자동화.
- 시스템/모듈별 모든 변형을 1차에서 완벽 지원.
- 서버 외부 공개(인터넷 노출) 운영. 기본은 로컬 단독 실행.

## 2. Glossary

- Runtime: 본 프로젝트의 데스크톱 앱(실행 파일).
- Bridge: 외부 시스템(Discord, FVTT, LLM)과 연결하는 어댑터 계층.
- NPC: FVTT Actor/Token에 매핑된 AI 캐릭터.
- PC: 플레이어 캐릭터.
- Action: FVTT에서 실행되는 단일 유닛 행동(타겟/이동/아이템 사용 등). LLM이 직접 다중 액션을 한 번에 내지 않도록 “원자화”한다.

## 3. User Stories

- 운영자는 GUI에서 NPC 3명을 등록하고, 각 NPC에 `SOUL.md`, `IDENTITY.md`, `BATTLE_RULES.md`를 연결한다.
- 운영자는 “활성화” 버튼을 눌러 FVTT 로그인과 Discord 봇 로그인을 수행한다.
- Discord `#aibot`에서 NPC를 멘션하면 NPC가 캐릭터로서 자연스럽게 답한다.
- FVTT에서 PC가 NPC 근처(예: 15ft)에서 말을 걸면, NPC가 해당 이벤트를 감지하고 FVTT 채팅으로 반응하며 필요 시 토큰을 움직인다.
- 전투 중 PC가 NPC를 공격하면, NPC가 규칙/성향 문서에 따라 반격하거나 도망가거나 대화한다.
- 운영자는 GUI에서 특정 NPC만 비활성화할 수 있다.
- FVTT 연결이 끊기면 NPC는 “탑 안의 방에서 통신하는” 상태로 대화 모드로 전환된다.

## 4. Product Requirements

### 4.1 Runtime Modes

- Offline Mode (FVTT not connected)
- Discord 대화는 가능(선택).
- NPC는 “고정된 세계관 위치(예: 첨탑 집무실/방)” 컨텍스트로만 대화한다.
- FVTT 행동은 하지 않는다.

- Online Mode (FVTT connected)
- FVTT 이벤트(채팅, 전투, 토큰 이동 등)를 관찰한다.
- NPC가 이벤트에 반응해야 하면 LLM을 호출하고, 필요 시 FVTT 액션을 실행한다.
- “실행 확인”을 자동으로 수행한다(카드 결과 확인, 템플릿 확정 등).

### 4.2 Interaction Detection (Triggering)

1차(MVP) 트리거는 “FVTT 채팅 감시”가 중심.

- PC가 NPC를 멘션하거나(이름 포함), 같은 씬에서 근거리 내에서 대화 시도 메시지를 보낸 경우.
- 전투 카드/공격 카드에서 NPC가 대상(타겟, 피해 대상)으로 등장한 경우.
- 운영자(Discord)에서 명령 없이 자연어로 “디아나, 브랫 장에게 무릿매” 같은 문장을 보낸 경우.

거리 기반 감지 규칙(구성 가능):

- 기본 범위: 2ft ~ 30ft
- 씬에 NPC 토큰이 존재.
- PC 토큰과 NPC 토큰의 거리 계산(그리드 기반).

주의:

- “거리 계산”은 1차에서는 FVTT 내장 거리 측정 API(가능하면)로 한다.
- 대각선 입력 정확도가 떨어지는 문제를 회피하기 위해, 이동 명령은 내부적으로 X축 이동 후 Y축 이동으로 분리한다(Manhattan steps).

### 4.3 NPC Autonomy Policy

NPC는 다음의 조건을 모두 만족할 때만 “자율 행동”을 한다.

- NPC가 활성화 상태.
- FVTT 연결 상태에서 NPC 토큰이 씬에 존재.
- 운영자 계정이 해당 NPC Actor/Token에 Owner 권한을 보유.
- 행동이 NPC 허용 목록(allowlist)에 속함.

## 5. Architecture Proposal

### 5.1 High-level

권장: Electron(Windows EXE) + Node.js + TypeScript.

이유:

- 기존 `fvtt-discord-npc/`의 Playwright/Discord.js 로직을 그대로 재사용하기 쉽다.
- OAuth 로컬 콜백 서버(`127.0.0.1`) 내장, 키체인 연동 등 데스크톱 기능이 수월하다.

구성(프로세스 관점):

- Renderer (GUI)
- Main (Runtime Core)
- Worker(옵션): FVTT Playwright, LLM 호출, Discord 이벤트 처리

### 5.2 Modules

- GUI
- NPC Manager
- Persona Docs Manager (MD 파일 연결, 미리보기, 유효성 검사)
- Secret Vault (OS 키체인/DPAPI)
- LLM Provider Layer
- Discord Bridge
- FVTT Bridge
- Event Observer (FVTT/Discord 이벤트)
- Policy Engine (보안/권한/allowlist/속도 제한)
- Planner (LLM 호출 및 plan 생성)
- Executor (plan을 원자 액션으로 분해하고 FVTT에서 실행)
- Verifier (실행 결과가 채팅 카드로 실제 출력될 때까지 확인)
- Memory Engine (FVTT 이벤트만 반영)
- Logging/Diagnostics

### 5.3 Reuse Plan (from existing code)

기존 `fvtt-discord-npc/` 자산을 다음 방식으로 재사용한다.

- Playwright 기반 FVTT 제어 로직은 라이브러리화하여 Runtime에서 호출.
- Discord 메시지 라우팅 로직은 “다중 NPC 라우터”로 확장.
- OpenClaw 전용 프롬프트/태그 파서 의존성은 제거하고, Runtime 내부 `plan` 스키마로 대체한다.

## 6. Data Model

### 6.1 Config Files

설정은 두 층으로 분리한다.

- 일반 설정(JSON): UI/로깅/NPC 연결/경로 등
- 비밀 설정(Vault): Discord 토큰, FVTT 비밀번호, LLM API Key, OAuth refresh token

예시(비밀은 참조만):

```json
{
  "app": { "lang": "ko-KR", "logLevel": "info" },
  "discord": { "guildId": "…", "listenChannelName": "aibot", "botTokenRef": "vault:discord:main" },
  "fvtt": { "serverUrl": "https://…", "userRef": "vault:fvtt:user", "passRef": "vault:fvtt:pass" },
  "llm": { "activeProvider": "openai-oauth", "profiles": { "openai-oauth": { "enabled": true } } },
  "npcs": [
    {
      "id": "diana",
      "displayName": "양치기 디아나",
      "enabled": true,
      "fvtt": { "actorSelector": { "type": "actorName", "value": "양치기 디아나" } },
      "docs": {
        "identity": "persona/diana/IDENTITY.md",
        "soul": "persona/diana/SOUL.md",
        "behavior": "persona/diana/BEHAVIOR_RULES.md",
        "battle": "persona/diana/BATTLE_RULES.md",
        "relations": "persona/diana/RELATIONS.md",
        "memory": "persona/diana/MEMORY.md"
      },
      "triggers": { "minFt": 2, "maxFt": 30 },
      "policy": { "actionAllowlist": ["chat", "move", "target", "useItem", "castSpell"] }
    }
  ]
}
```

### 6.2 NPC Persona Doc Contract

문서들은 “메타 설명(나는 봇이다, 이렇게 사용하세요)”을 최소화하고, 세계관 내부의 자연스러운 서술로 작성되도록 한다.

- `IDENTITY.md`
- 세계관 배경, 현재 처지, 관계, 역할.

- `SOUL.md`
- 말투/기질/금기/정서 반응을 규정.

- `BEHAVIOR_RULES.md`
- 대화 중 행동 원칙, 정보 취급(사적 정보 보호), 외부 전송 전 확인 같은 정책을 “세계관 방식”으로 우회 서술.

- `BATTLE_RULES.md`
- 전투 시 우선순위, 거리/자원(슬롯) 관리, 범위 주문 처리 원칙.

- `RELATIONS.md`
- 인물 관계도(세션 인물 포함). 예: “다익스트라 일급사제 …”

- `MEMORY.md`
- FVTT 사건에 기반한 장기 기억 요약.

## 7. LLM Layer

### 7.1 Provider Abstraction

Provider는 아래 인터페이스를 구현한다.

- `listModels()`
- `chat(request)` (streaming optional)
- `getAuthStatus()`
- `login()` (OAuth일 때)
- `logout()` (OAuth일 때)

요구 Provider:

- OpenAI (API Key)
- OpenAI (OAuth for Codex 목표)
- Gemini (API Key)
- Claude (API Key)

### 7.2 OpenAI OAuth (Codex) - Risk & Plan

요구사항은 “OpenAI OAuth로 Codex 사용”이다. 다만 OpenAI OAuth가 제3자 데스크톱 앱에서 어떤 범위로 허용되는지, 어떤 클라이언트 등록이 필요한지에 따라 구현 난이도가 크게 달라진다.

스펙 수준에서의 대응:

- Provider를 플러그인 구조로 만들어, OAuth 방식이 불가/제약이 있어도 API Key 방식으로 대체 가능하게 한다.
- OpenAI OAuth는 Authorization Code + PKCE + localhost callback을 기본안으로 한다.
- 콜백 서버는 `127.0.0.1`에 ephemeral port로 띄우고, 로그인 완료 즉시 종료한다.

확인 필요(Implementation Gate):

- OAuth client_id 발급/사용 가능 여부.
- OAuth로 받은 토큰이 실제 Codex/모델 호출에 사용 가능한지.

## 8. Planner / Executor Contract (Critical)

### 8.1 핵심 원칙

- LLM은 한 번의 응답에 “여러 FVTT 액션”을 묶어 내지 않는다.
- Runtime이 고수준 intent를 받아, 내부적으로 원자 액션을 순차 실행한다.
- 각 원자 액션은 완료 여부가 검증되어야 다음 단계로 넘어간다.

### 8.2 Plan Schema (internal)

LLM 출력은 JSON 하나로 제한한다(파서 단순화, 주입 공격 방지).

```json
{
  "replyText": "…",
  "intent": {
    "type": "chat | move | target | useItem | castSpell | inspectActor | inspectScene | none",
    "npcId": "diana",
    "args": {}
  }
}
```

예시 intent:

- `chat`: FVTT/Discord로 말하기
- `inspectActor`: 인벤토리/주문/특성/슬롯 읽기
- `target`: 목표 토큰 선택
- `useItem`: “무릿매” 등 아이템 사용(사거리/접근/타겟 포함)
- `castSpell`: 주문 시전(단일 대상 또는 범위)
- `move`: 토큰 이동(내부적으로 X 이동 후 Y 이동)

### 8.3 Execution Pipeline

Executor는 intent를 micro-steps로 분해한다.

예: `useItem(무릿매, target=브랫 장)`은 내부적으로 다음을 실행할 수 있다.

- Resolve target tokenRef (name -> tokenId)
- Check range and line-of-sight (가능 범위 내)
- If out of range: move closer using Manhattan steps
- Set target to tokenId
- Use item (trigger workflow)
- Auto-resolve any confirmation dialogs
- Verify chat card output (attack roll/damage/save 메시지)

LLM이 `sequence` 같은 다중 호출 포맷을 직접 내지 않도록 설계한다. 다중 단계는 Runtime의 책임이다.

## 9. FVTT Bridge

### 9.1 Integration Options

옵션 A: Playwright Browser Automation (MVP)

- 장점: 서버 모듈 설치 없이 바로 적용 가능.
- 단점: UI 변화에 취약, 일부 동작은 클릭/확정이 필요.

옵션 B: Foundry Module + Socket API (Phase 2+ 권장)

- 장점: 구조화된 이벤트 스트림, 안정적인 상태 조회/행동 실행.
- 단점: 서버에 모듈 설치 필요.

본 스펙의 1차 구현은 옵션 A를 기본으로 하되, 옵션 B로 전환 가능한 추상화를 포함한다.

### 9.2 Required Capabilities (MVP)

- Connect/Login/Session keepalive
- Read recent chat messages (last N)
- Read scene summary
- Tokens: list, positions, ids, owners
- Actor sheet read
- Target set/clear
- Token movement
- Use item/spell and ensure result is posted to chat
- AoE template placement and confirm
- Combat awareness (whose turn/round 정도는 가능하면)

### 9.3 Chat Context Ingestion

Chat poller는 다음을 수집한다.

- message id, timestamp
- speaker(actor/token/user)
- content text (OOC/IC 구분 가능하면)
- flags(시스템/모듈 정보)
- roll outcomes (가능하면 구조화)

수집한 이벤트는 “LLM 입력 컨텍스트”로 사용하지만, 메모리 저장은 FVTT 사건일 때만 수행한다.

### 9.4 Targeting Contract

안정성을 위해 타겟은 “이름”이 아니라 “tokenId”를 최종 키로 사용한다.

- 입력이 이름이면 Resolver가 tokenId로 변환한다.
- 같은 이름이 여러 개면 우선순위를 둔다.
- 같은 씬, NPC 근처, 최근 상호작용 대상, 또는 GM/운영자가 지정한 preferred token.

### 9.5 AoE Contract

범위 주문은 다음 자동 처리를 포함한다.

- 템플릿 생성
- 목표 지점 결정(타겟 토큰 중앙, 혹은 지정 좌표)
- 템플릿 확정 클릭 또는 API 호출
- 결과 메시지(세이브/데미지 등)가 채팅에 뜰 때까지 확인

## 10. Discord Bridge

### 10.1 Channel Routing

- 기본: 특정 길드의 `#aibot`(대소문자 무시)만 수신.
- 메시지에 NPC 멘션/이름이 있으면 해당 NPC가 응답.
- 멘션이 없으면 “활성 NPC 1명” 또는 “최근 대화 NPC”로 라우팅(정책 설정 가능).

### 10.2 Safety Policy (Discord)

- allowlist된 채널 외 응답 금지.
- 개인 정보, 성적 발언 등 문제 입력은 캐릭터 톤을 유지하되 안전 정책에 따라 거절.
- 외부 전송(파일 업로드, 외부 API 호출)은 GUI에서 승인 옵션을 둘 수 있다(기본은 비활성).

## 11. Memory Engine

### 11.1 Memory Update Rule

- 장기 기억은 FVTT 이벤트 기반으로만 갱신한다.
- Discord 대화는 단기 컨텍스트로만 사용하고, 장기 메모리에 직접 반영하지 않는다.

### 11.2 Storage

- `events.jsonl`: 원본 이벤트 로그(감사/디버깅용)
- `MEMORY.md`: 요약된 장기 기억

요약 정책:

- 이벤트 N개 누적 시 요약 수행.
- 요약은 “사건, 관계 변화, 약속, 적대/우호 변화” 중심.

## 12. GUI Requirements

### 12.1 Screens

- Dashboard
- 연결 상태(FVTT/Discord/LLM)
- 활성 NPC 목록, 큐 길이, 마지막 액션/오류

- NPC Editor
- 문서 연결(Identity/Soul/Rules/Memory)
- 트리거 범위 설정(2~30ft)
- 허용 액션 설정
- 테스트 버튼(예: “인벤토리 읽기”, “최근 채팅 읽기”, “대상 타겟팅”, “아이템 사용 테스트”)

- Settings
- LLM Provider 설정(API Key / OAuth 로그인 상태)
- FVTT 서버 URL 및 계정(비밀은 Vault)
- Discord 봇 토큰(비밀은 Vault)

- Logs / Diagnostics
- 필터 가능한 로그
- 최근 스크린샷/에러 리포트(민감정보 마스킹)

### 12.2 UX Notes

- “활성화”는 1회 클릭으로 FVTT 로그인, Discord 로그인, LLM 인증 상태 확인까지 한 번에 수행.
- 문제 발생 시 어떤 단계에서 실패했는지(Discord, FVTT, LLM)를 명확히 보여준다.
- FVTT 연결이 끊기면 NPC는 자동으로 Offline Mode로 전환하고, 재연결을 백오프 재시도한다.

## 13. Security Requirements

- 비밀은 OS 키체인/DPAPI에 저장.
- 로그에 비밀 문자열이 찍히지 않도록 전처리.
- 네트워크 서버는 기본적으로 열지 않는다.
- OAuth 콜백 서버는 `127.0.0.1` 루프백만.
- FVTT에서 실행 가능한 행동은 allowlist로 제한.
- LLM 출력은 strict JSON 파싱. 스키마 위반 시 실행 금지.
- FVTT 액션은 반드시 Verifier가 “채팅 결과가 실제로 뜸”을 확인해야 완료로 처리.

## 14. Packaging / Deployment

### 14.1 Windows

- electron-builder
- NSIS installer
- 자동 업데이트는 1차에서 제외(옵션)

### 14.2 macOS 이식 준비

- 경로/권한/키체인 추상화
- Playwright 브라우저 번들링 이슈를 고려해 빌드 파이프라인 분리

## 15. Implementation Roadmap

Phase 0: Core 정리

- `fvtt-discord-npc/`에서 OpenClaw 의존 제거.
- Runtime intent schema 확정.
- 단일 NPC로 end-to-end(Discord -> FVTT item use -> chat card verify) 성공.

Phase 1: Multi-NPC + GUI

- NPC 프로필 관리 UI.
- 개별 enable/disable.
- 상태/로그/테스트 도구 탑재.

Phase 2: FVTT 안정화

- 템플릿 확정 자동화 강화.
- 거리/이동/타겟 Resolver 고도화.
- 채팅 읽기와 전투 카드 파싱 안정화.

Phase 3: OAuth

- OpenAI OAuth 구현(가능하면).
- 실패 시 API Key 대체 경로를 UI에서 제공.

Phase 4: Foundry Module(선택)

- 이벤트 스트리밍.
- 안정적인 액터/아이템/주문 사용 API 호출.

## 16. Open Questions (Need user confirmation)

- OpenAI Codex OAuth를 “제3자 데스크톱 앱”에서 정식으로 구현 가능한지(클라이언트 등록/토큰 사용 범위).
- FVTT 게임 시스템/모듈 구성(dnd5e 버전, midi-qol 사용 여부 등). 시스템에 따라 “아이템 사용 API”가 달라진다.
- NPC가 여러 명일 때 Discord 봇을 NPC별로 분리할지, 하나의 봇이 여러 NPC를 역할로 연기할지.

