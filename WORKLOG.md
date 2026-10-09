# WORKLOG — 0Siri 개발 (0SIRI-SPEC.md §22 10단계)

> 각 단계의 "확인"을 실제로 실행한 명령과 출력을 남긴다. 다음 세션은 이 파일부터 읽는다.

## 환경 (2026-10-09 실측)
- 머신 gcp-seoul · Node 22.23 · pnpm 11.19 (`~/.local/bin`) · docker (llm 을 docker 그룹에 추가, 현 세션은 `sg docker -c`)
- DB: 컨테이너 `osiri-db` = pgvector/pgvector:pg16, `postgresql://osiri:osiri@127.0.0.1:5440/osiri`, vector 0.8.7
- Android SDK `~/android-sdk` (platforms 35/36, build-tools 34/35, cmdline-tools) · JDK 17 · adb 로컬 연결 기기 없음(폰은 device-lease 로 다른 머신)
- 레포: origin=github.com/w-partners/yeongsil (private) · public=github.com/w-partners/0siri · upstream=CopilotKit/openmuse
- 기준 상태: 브랜치 `0siri`, 포크 기준 1ac68f3. typecheck 통과. 테스트 기준선: search.test.ts 1건 실패(업스트림 버전 문자열 0.1.0≠0.2.0, 우리 변경 아님)
- 서버 실행: `env -u DATABASE_URL TEAM_PROVISIONER_ENABLED=true sg docker -c "pnpm exec tsx apps/server/src/index.ts"` (셸에 잘못된 `DATABASE_URL=sqlite:…` 가 박혀 있어 `.env` 를 가린다)
- 🔴 **포트 8788** — 8787 은 이 머신의 `headroom proxy`(27일째 떠 있음)가 `100.101.237.9:8787` 에 묶고 있다. `.env` 에 `PORT=8788 HOST=0.0.0.0 PUBLIC_API_URL=http://100.101.237.9:8788 WEB_DIST=apps/mobile/dist/web`. HOST 기본 127.0.0.1 이라 폰에서 못 붙는다 — 반드시 0.0.0.0.
- 웹 빌드: `cd apps/mobile && CI=1 pnpm exec expo export --platform web --output-dir dist/web --clear` → 서버가 같은 포트에서 낸다(`WEB_DIST`). 🔴 `--clear` 없으면 Metro 변환 캐시가 옛 `EXPO_PUBLIC_API_URL` 을 다시 박는다(실측: 8788 로 바꿔 export 했는데 번들에 8787 남음).
- Android: `scratchpad/build-android.sh` = `expo prebuild --platform android` + `./gradlew assembleRelease --no-daemon`(JDK 17, ANDROID_HOME=~/android-sdk). Bash 훅이 gradle 을 막으므로 스크립트 파일로 돌린다. 1회 빌드 ≈ 30분+ (load 35).
- UI 렌더 검증: `scratchpad/pw/verify.js` (playwright-core + 시스템 google-chrome 152, headless). Claude-in-Chrome 은 이 머신에 없다.
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
| 2 | 한국어화 | ✅ 2026-10-09 | 서브에이전트: 서버 `AppError`·라우트 메시지 전부 한국어(`apps/server/src/**`), mobile `strings.ts` 한국어. 게이트 `pnpm typecheck && pnpm lint && pnpm test` 통과(에이전트 보고, 본 세션 재확인 typecheck 0) |
| 3 | 계정 | ✅ 서버+UI | 서버 `tests/osiri-accounts.test.ts` 3/3. UI `auth.tsx`: 로그인(전화+비번)·초대·온보딩 4단계·**서버 주소 바꾸기**. 렌더: `pw/shots/01-mobile-login.png` 로그인 화면 정상(2026-10-10). API 스모크 `scratchpad/smoke.py`: login 200 role=admin · /me 200 |
| 4 | 채팅방·현황판·승인 | ✅ 서버+UI | 서버 `tests/osiri-rooms.test.ts` 2/2. UI `rooms.tsx`(방 목록·방 화면: 캐릭터 4상태 presence SSE·현황판 핀·승인 카드·타임라인·채팅), `inbox.tsx`, `team-goals.tsx`. 스모크: /rooms 200 (1방 '영시리'), /timeline 200(board.presence=idle), /conversation?threadId 200 |
| 5 | 기억 + 서버 임베딩 | ✅ 2026-10-09 | `tests/osiri-memories.test.ts`: 한국어 질의 12건 **top-1 12/12**, 소유자 격리, 삭제. 스모크: dim 768, 관련 0.886 vs 무관 0.627. API: /memories?q=커피 200 |
| 6 | MCP 연결 | ✅ 서버+UI | `tests/osiri-mcp.test.ts`. UI 설정 탭 MCP 서버 등록/위험도 표시 |
| 7 | 스토어 | ✅ 서버+UI | `tests/osiri-store.test.ts` 2/2. UI `store.tsx`(둘러보기/내 구독, `?tab=`). 스모크 /store/packages 200 — **0건**: 패키지는 관리자가 `POST /api/admin/packages` 로 올려야 노출(법률팀은 «붙일 수 있는 준비까지» 가 범위, 마스터 지시) |
| 8 | 법률팀 + 목표 + 도커 | ✅ 2026-10-09 | 런타임 `tests/osiri-team.test.ts` 2/2. **프로비저너** `osiri/provisioner.ts` + `tests/osiri-provisioner.test.ts` 2/2(env-file 로 토큰 전달·인자에 시크릿 없음·env-file 삭제·실패 시 status=failed+activity, 재시도 없음·archived 방 → `rm -f`). 이미지 `Dockerfile.team` → `osiri/team-runtime` 2.52GB 빌드 성공, 스모크 run 은 기대대로 `OSIRI_API_URL 이 필요합니다` 로 종료 |
| 9 | 라우팅 + BYOK + 기기 임베딩 | ✅ 서버+웹 / 네이티브는 서버 폴백 | `tests/osiri-routing.test.ts` 3/3. 기기: 웹 `device-embed.web.ts`(transformers.js **CDN 런타임 로드**, WebGPU→WASM), 네이티브 `device-embed.native.ts` 는 **스텁(항상 실패→서버 폴백)**. `tier0.ts` 기기 우선→실패 시 `/api/memories?q=` + `POST /api/usage/device {tier:0, reason:"fallback:…"}` + "서버에서 답함" 배지. 스모크: usage/device 200 (reason=fallback:smoke 기록됨). 설정 탭 «기기 실측» 패널은 브라우저에서 눌러야 수치가 나온다 — [확인 필요] headless 실측은 미실시 |
| 10 | Android APK + 실기기 | 🔄 빌드 중 2026-10-10 | prebuild EXIT=0(`android-prebuild.log`). gradle assembleRelease 진행 중. 폰은 influencer(zalman) `device_lease.py` 가 점유 → APK 를 `http://100.101.237.9:8789/` 로 내고 influencer-primary 에게 설치 위임 예정 |

## 남은 일 (2026-10-10 기준)
1. gradle 완료 → APK 번들에 8787 이 박혀 있지 않은지 확인(`unzip -p app-release.apk assets/index.android.bundle | grep -c 8787` = 0) → 아니면 Metro 캐시 비우고 재빌드.
2. APK 를 tailnet HTTP 로 내고(`python3 -m http.server 8789`) influencer-primary 에 설치 위임(`scratchpad/msg-apk.txt`) → 읽음확인·설치 결과 회신 받기.
3. 웹 UI 렌더 검증(`pw/verify.js`) 전 화면 통과 → 스크린샷 증거를 vault RR 에 첨부.
4. 네이티브 기기 임베딩(LiteRT-LM 또는 onnxruntime-react-native)은 미착수 — 현재는 전부 서버 폴백(배지로 드러남). 스펙 §11.2 실측 후 `deviceLlmEnabled` 판단.
5. 서브에이전트가 보고한 서버 공백: 승인 decide 에 "revise" 없음 · 승인 카드 payload 에 inputHash 없음 · `RoomBoard.nextReportAt` 미기록 · BYOK 공급자 목록 API 없음 · 구독별 월 사용량 없음.
