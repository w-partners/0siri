# WORKLOG — 0Siri 개발 (0SIRI-SPEC.md §22 10단계)

> 각 단계의 "확인"을 실제로 실행한 명령과 출력을 남긴다. 다음 세션은 이 파일부터 읽는다.

## 환경 (2026-10-09 실측)
- 머신 gcp-seoul · Node 22.23 · pnpm 11.19 (`~/.local/bin`) · docker (llm 을 docker 그룹에 추가, 현 세션은 `sg docker -c`)
- DB: 컨테이너 `osiri-db` = pgvector/pgvector:pg16, `postgresql://osiri:osiri@127.0.0.1:5440/osiri`, vector 0.8.7
- Android SDK `~/android-sdk` (platforms 35/36, build-tools 34/35, cmdline-tools) · JDK 17 · adb 로컬 연결 기기 없음(폰은 device-lease 로 다른 머신)
- 레포: origin=github.com/w-partners/yeongsil (private) · public=github.com/w-partners/0siri · upstream=CopilotKit/openmuse
- 기준 상태: 브랜치 `0siri`, 포크 기준 1ac68f3. typecheck 통과. 테스트 기준선: search.test.ts 1건 실패(업스트림 버전 문자열 0.1.0≠0.2.0, 우리 변경 아님)

## 설계 결정 요약 (상세는 DECISIONS.md)
- 저장: openmuse `records(owner, kind, id, data jsonb)` 문서 저장소를 그대로 쓴다. §20 의 "테이블"은 `kind` 로 대응, `owner`=owner_user_id. 전역 데이터(패키지·사용자 색인·설정)는 owner=`system`. 벡터가 필요한 `memories` 만 실제 컬럼/테이블.
- 인증: `auth.ts` 의 owner="local-user" 를 사용자 id 로 바꾼다. 전화번호+비밀번호(scrypt). sample 모드는 테스트용으로 유지.
- 방 = CopilotKit threadId. 카드·위젯은 `messages` 레코드, 실시간은 서버 이벤트 버스 → SSE(`/api/rooms/:id/stream`).
- 승인: `ActionService`(해시·만료·원자 claim)를 일반화한 `approvals`.

## 단계 진행
| # | 단계 | 상태 | 증거 |
|---|---|---|---|
| 0 | 부록 B 초기화 (SPEC·FORK·DECISIONS·레포) | ✅ 2026-10-09 | 파일 존재, GitHub 레포 2개 생성(HTTP 201) |
| 1 | 서버 단독 실행 | 진행 중 | |
| 2 | 한국어화 | | |
| 3 | 계정 | | |
| 4 | 채팅방·현황판·승인 | | |
| 5 | 기억 + 서버 임베딩 | | |
| 6 | MCP 연결 | | |
| 7 | 스토어 | | |
| 8 | 법률팀 + 목표 | | |
| 9 | 라우팅 + BYOK + 기기 임베딩 | | |
| 10 | Android APK | | |
