# DECISIONS

양식: `날짜 | 결정 | 근거(단순 / openmuse 패턴 / 가역 / 마스터 지시)`

2026-10-09 | 로그인 식별자는 이메일이 아니라 **전화번호**(+비밀번호). `users.phone` 유일키, 이메일은 선택 컬럼. 스펙 §24-4 의 "이메일"은 마스터 구두 결정(2026-10-09 "전화번호와 비밀번호로 자체 로그인 확정")으로 대체 | 마스터 지시 · 가역(컬럼 추가만)
2026-10-09 | 기기 모델(티어 0/1) 로드·추론 실패 시 **서버 티어로 자동 폴백**한다. 단 조용히 하지 않는다 — 응답에 "서버에서 답함" 출처 배지 + 라우팅 로그 `fallback_reason` 기록. §2.3(실패 비노출)과 §11.1(말없이 넘기지 않음) 충돌을 이렇게 합친다 | 마스터 지시 2026-10-09 "기기 모델 실패시 서버로 넘길 것" · 하네스 조용한 실패 금지
2026-10-09 | 저장소: private `origin` 에 push 하고 **public 미러**를 병행한다. 시크릿은 `.env` 로만, 커밋 금지(`.gitignore`) | 마스터 지시 2026-10-09 "공개 레포 병행"
2026-10-09 | DB 는 docker `pgvector/pgvector:pg16` 컨테이너(`osiri-db`, 127.0.0.1:5440). 호스트 Postgres 서버가 없고 pgvector 패키지도 없다 | 단순
2026-10-09 | 관리자 계정은 시드 스크립트로 넣는다(전화·비밀번호는 환경변수 `ADMIN_PHONE`·`ADMIN_PASSWORD`, 코드에 박지 않음) | 마스터 지시(관리자 계정 지정) · 시크릿 금지
2026-10-09 | §20 의 테이블은 openmuse `records(owner, kind, id, data jsonb)` 의 `kind` 로 대응한다(users·sessions·rooms·messages·goals·approvals·audit-logs·packages·subscriptions·settings·usage·model-accounts·mcp-servers). 벡터가 필요한 `memories` 만 pgvector 실제 테이블 | openmuse 패턴 · 가역(한 kind 씩 테이블로 뺄 수 있음)
2026-10-09 | 서버 임베딩은 `onnx-community/embeddinggemma-2-ONNX` **q8 텍스트 전용**(vision/audio config 제거, 299MB). 모델 파일은 레포에 넣지 않고 첫 호출 때 `EMBED_CACHE_DIR`(기본 `~/.cache/osiri-models`)에 받는다 | 스펙 §11.2 q8 확정 · 실측 12/12 |
2026-10-09 | 승인 토큰: 승인 시 1회용 토큰을 만들고 **해시만 저장**, 평문은 프로세스 메모리에 두었다가 워커 폴링 1회에 넘긴다. 서버 재시작으로 미수령 토큰이 사라지면 워커는 `tokenLost` 를 받고 새 승인을 요청한다 — 토큰 없이는 절대 실행하지 않는다 | 스펙 §9 fail-closed · 단순(파일럿 1대)
2026-10-09 | 구독 트랜잭션(§6.3)은 문서 저장소라 DB 트랜잭션 대신 **보상 롤백**(실패 시 만든 구독·방 삭제) | 단순 · 가역(Postgres 트랜잭션으로 교체 가능)
2026-10-09 | MCP 위험도: `x-osiri-risk` 는 도구 최상위 또는 `_meta` 에서 읽고 미선언이면 서버 `riskDefault`(기본 external) | 스펙 §15.2 "미선언 시 최고 등급"
2026-10-09 | 라우팅 분류는 규칙만(길이·키워드·도구 필요·종류). 티어별 모델명은 `MODEL_TIER2/3/4` 환경변수, 단가는 `MODEL_PRICES_KRW` JSON. 단가 없으면 절감액은 "측정 중" | 스펙 §11.1·§12 · 코드에 모델명·금액 상수 금지
2026-10-09 | 팀 런타임은 별도 패키지가 아니라 `apps/server/src/osiri/team-runtime.ts` + 진입점 `team-entry.ts` 로 두고 컨테이너는 같은 이미지를 다른 CMD 로 돌린다. 팀 정의는 `teams/*.yaml`(cagent 형식 + `x-osiri-tier`) | 단순(새 워크스페이스 배선 생략) · 가역
2026-10-09 | 워커가 외부 도구를 쓸 때는 `/api/worker/tools/call` 로 서버의 MCP 게이트를 거친다(워커가 MCP 서버에 직접 붙지 않음) — 승인 토큰 검증이 서버 한 곳에 남는다 | 스펙 §15.4-6 "DB 직접 접근 금지, 0Siri API 로만"
