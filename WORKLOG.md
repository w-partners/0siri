# WORKLOG — 0Siri 개발 (0SIRI-SPEC.md §22 10단계)

> 각 단계의 "확인"을 실제로 실행한 명령과 출력을 남긴다. 다음 세션은 이 파일부터 읽는다.

## 환경 (2026-10-09 실측)
- 머신 gcp-seoul · Node 22.23 · pnpm 11.19 (`~/.local/bin`) · docker (llm 을 docker 그룹에 추가, 현 세션은 `sg docker -c`)
- DB: 컨테이너 `osiri-db` = pgvector/pgvector:pg16, `postgresql://osiri:osiri@127.0.0.1:5440/osiri`, vector 0.8.7
- Android SDK `~/android-sdk` (platforms 35/36, build-tools 34/35, cmdline-tools) · JDK 17 · adb 로컬 연결 기기 없음(폰은 device-lease 로 다른 머신)
- 레포: origin=github.com/w-partners/yeongsil (private) · public=github.com/w-partners/0siri · upstream=CopilotKit/openmuse
- 기준 상태: 브랜치 `0siri`, 포크 기준 1ac68f3. typecheck 통과. 테스트 기준선: search.test.ts 1건 실패(업스트림 버전 문자열 0.1.0≠0.2.0, 우리 변경 아님)
- 서버 실행: `env -u DATABASE_URL pnpm exec tsx apps/server/src/index.ts` (셸에 잘못된 `DATABASE_URL=sqlite:…` 가 박혀 있어 `.env` 를 가린다)
- 임베딩 모델 캐시: `~/.cache/osiri-models` (EmbeddingGemma 2 ONNX q8 텍스트 전용 299MB, 첫 호출 때 자동 다운로드). 테스트·서버 공용.
- 0Siri 테스트만: `pnpm exec tsx --import ./tests/setup.ts --test tests/osiri-*.test.ts`

## 설계 결정 요약 (상세는 DECISIONS.md)
- 저장: openmuse `records(owner, kind, id, data jsonb)` 문서 저장소를 그대로 쓴다. §20 의 "테이블"은 `kind` 로 대응, `owner`=owner_user_id. 전역 데이터(패키지·사용자 색인·설정)는 owner=`system`. 벡터가 필요한 `memories` 만 실제 테이블(pgvector).
- 인증: 전화번호+비밀번호(scrypt). 세션은 `system/sessions`(토큰 해시). sample 모드는 테스트용으로 유지.
- 방 = CopilotKit threadId. 카드·위젯은 `messages` 레코드, 실시간은 서버 이벤트 버스 → SSE(`/api/rooms/:id/stream`).
- 승인: 1회용 토큰 = sha256(도구명+정규화 입력)에 묶임. 토큰은 발급 시 메모리로만 돌려주고 저장은 해시. 워커는 폴링 1회로 수령.
- 서버 모듈은 전부 `apps/server/src/osiri/*` 에 새 파일로 둔다 (업스트림 파일 충돌 최소화).

## 단계 진행
| # | 단계 | 상태 | 증거 |
|---|---|---|---|
| 0 | 부록 B 초기화 (SPEC·FORK·DECISIONS·레포) | ✅ 2026-10-09 | 파일 존재, GitHub 레포 2개 생성(HTTP 201) |
| 1 | 서버 단독 실행 | ✅ 2026-10-09 | `curl -s localhost:8787/api/health` → 200 JSON (DB=docker pgvector) |
| 2 | 한국어화 | 진행 중 (서브에이전트) | mobile 커밋 5814ae0·71123cc 반영. 서버 메시지 번역 + 게이트 실행 중 |
| 3 | 계정 | ✅ 서버 (UI 미착수) | `tests/osiri-accounts.test.ts` 3/3: 정규화·관리자 시드→로그인→/me→프로필, 초대 e2e(잘못된/재사용 토큰 400, 일반사용자 admin API 403, 소유자 격리, 로그아웃 401) |
| 4 | 채팅방·현황판·승인 | ✅ 서버 (UI 미착수) | `tests/osiri-rooms.test.ts` 2/2: 승인 카드→배지→승인→현황판/결재함 갱신, 토큰 1회 집행, 무토큰/입력변경/재사용 403, 감사 blocked+ok. 목표 롤업·순서·주간보고 카드 |
| 5 | 기억 + 서버 임베딩 | ✅ 2026-10-09 | `tests/osiri-memories.test.ts`: 한국어 질의 12건 **top-1 12/12**, 소유자 격리, 삭제. 스모크: dim 768, 관련 0.886 vs 무관 0.627 |
| 6 | MCP 연결 | ✅ 서버 (UI 미착수) | `tests/osiri-mcp.test.ts`: 미선언=external, read 무승인, external 승인 후 1회, 위조/입력변경/재사용 403(감사 blocked 3), API 키 응답 비노출 |
| 7 | 스토어 | ✅ 서버 (UI 미착수) | `tests/osiri-store.test.ts` 2/2: 검수역할·승인지점 없으면 422, 가격=설정값(기본 0), 구독 트랜잭션 롤백(큐 실패 시 구독·방 0건), 해지→방 archived+30일 |
| 8 | 법률팀 + 목표 | ✅ 런타임 (도커 프로비저너 미착수) | `teams/legal-marketing.yaml` 8역할. `tests/osiri-team.test.ts` 2/2: 분해(장기1·중기1·단기1·작업2), 검수 실패→승인요청 없음, 통과→승인 카드에서 정지(발행 0), 승인→토큰 1회 수령→발행 1회, 재사용 403, 주간보고 3지표 |
| 9 | 라우팅 + BYOK + 기기 임베딩 | ✅ 서버 (기기 실측 미착수) | `tests/osiri-routing.test.ts` 3/3: 잡담 2·초안 3·전략/검수 4·도구=서버·기기실패=2+"서버에서 답함"·fallback_reason 로그, 상한 도달 시 억제+알림 1회, 절감액 기준선/측정 중, BYOK 401/429/네트워크 거절·끝4자리·암호화·OAuth 403 |
| 10 | Android APK | | |

## 남은 일 (2026-10-09 기준)
1. 2단계 서브에이전트 완료 후 `app.ts` 에 라우트 조립: `/api/auth`(공개) · `/api/worker`(워커 토큰) · `/api`(계정·방·기억·MCP·스토어·라우팅), 기동 시 `ensureAdmin(ADMIN_PHONE, ADMIN_PASSWORD)`, 대화 프롬프트에 방·팀 페르소나 주입.
2. 모바일/웹 UI: 로그인·온보딩, 5탭 셸, 방 화면(캐릭터·승인 카드·현황판), 결재함, 스토어(`?tab=`), 설정(기억·연결·BYOK·라우팅·사용량).
3. 8단계 도커: team-runtime 이미지 + 프로비저너(큐 → `docker run`, env 주입).
4. 9단계 기기 실측: 웹 transformers.js q4/q8, Android LiteRT-LM 또는 onnx → 리포트 → 티어 1 플래그.
5. 10단계: `expo prebuild` + gradle APK → device-lease 로 Flip·S25+ 설치 → 실기기 흐름.
