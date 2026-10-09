# 0Siri API 계약 — 화면 설계(«0Siri 종합 기획» §03) 100% 대응분

> 화면 11종이 요구하는데 v0.3.1 서버에 없던 표면을 여기서 한 번만 정한다. 서버·클라이언트 모두 이 파일을 정본으로 구현한다.
> 모든 경로는 `/api` 아래, 인증은 기존 Bearer 세션, 에러는 기존 `{ "error": "<문장>" }`. 모든 행은 소유자(owner)로 격리.
> 기존 응답 필드는 이름을 바꾸거나 지우지 않는다(추가만).

## 방 (화면 2·3)

- `GET /rooms` — 정렬을 기획대로: ① 승인 대기 있는 방(대기 많은 순) → ② 최근 활동 순 → ③ 이름순. 고정(pin)은 **그 그룹 안에서** 최우선.
  항목에 추가: `muted: boolean`, `stalled: boolean`(약속한 보고 주기를 넘긴 팀 — "멈춘 팀"), `tierLabel: string`(개인 방은 "일반 등급").
- `POST /rooms/:id/mute` `{ muted: boolean }` → 방 항목.
- `GET /rooms/:id/feed` → `Activity[]` (그 방의 활동만, 최신순. `/inbox` 의 activities 와 같은 모양 + `label`).
- `GET /rooms/:id/files` → `{ approved: { approvalId, title, summary, decidedAt }[], audit: { id, ts, action, actor, approvalId? }[] }` (승인본·감사 문서).
- `GET /rooms/:id/ideas` → `GoalProposal[]` (아래) — 그 방 팀이 낸 주제·목표 제안.
- `GET /stream` (SSE, 사용자 단위) — 이벤트 `rooms`(payload `{ roomId }`): 어느 방의 배지·진척·상태가 바뀌었다. 목록·탭 배지가 이걸 받고 `/rooms` 를 다시 읽는다. `ping` 은 기존과 같다.
- `GET /rooms/:id/board` 응답에 추가: `character: { assetId, state: "working"|"awaiting_approval"|"reporting"|"idle", summary }`, `recentDone: string[]`(최근 완료 3건 제목).
  `agents[]` 항목에 `role?: string`(역할 설명), `current?: string`(지금 하는 일) — 없으면 화면은 그 줄을 보이지 않는다.
- `GET /rooms/:id/summary` 응답에 `recentDone: string[]` 추가(현황판과 같은 값).
- `GET /rooms/:id/timeline` 응답에 `answers: Record<채팅 답변 messageId, AnsweredBy>` 추가 — 화면이 답변 아래에 «누가 답했는지» 를 붙인다. 워커가 올린 방 메시지는 `payload.answeredBy` 로 같은 모양을 싣는다.
- 메시지(채팅 응답) 메타데이터: `answeredBy: { tier: 0|1|2|3|4, label: string, model: string, source: "device"|"server"|"byok", reason?: string }`, `memoryRefs?: { id, text, at }[]`.

## 승인 (화면 3·4)

- `POST /approvals/:id/decide` `{ decision: "approve"|"reject", reasonKind?: "tone"|"fact"|"topic", reason?: string, frozenHash }`.
  반려는 `reasonKind` 필수(400). 이미 처리된 건은 409 + 현재 `status`.
- `GET /inbox` — `?room_id=`·`?kind=publish|consult|skill` 필터. pending 항목에 `kind`, `roomCharacter` 추가.
  한 팀 조회가 실패해도 나머지는 준다: `failed: { roomId, roomTitle, error }[]`.

## 목표 (화면 1·5)

- `TeamGoal.status` 에 `"proposed"` 추가(장기 목표는 사용자 승인 전에는 시작하지 않는다). 달성은 기존 `"completed"`.
- `POST /goals` `{ roomId, title }` → 장기 목표 `status: "proposed"` (온보딩 «첫 목표 한 줄»).
- `POST /goals/:id/activate` → `proposed` → `active`. 그 밖의 상태면 409.
- `GET /goals/:id/metrics?period=week|month|quarter` → `{ period, measuredAt: string|null, metrics: { published, indexed, ai_citations, conversions } }` — 각 값은 `number|null`, `null` = 아직 측정 전("수집 중").
- `GoalProposal = { id, roomId, title, detail, status: "pending"|"accepted"|"held", proposedBy, createdAt }`
  - `GET /goals/proposals?room_id=` · `POST /goals/proposals/:id/decide` `{ decision: "accept"|"hold" }` (accept → 다음 중기 목표로 편입 + 방 공지).
  - 워커: `POST /worker/goals/proposals` `{ title, detail }`.

## 스토어 (화면 6)

- `GET /store/packages` 항목에 추가: `subscribed: boolean`, `roomId: string|null`, `reviewing: boolean`("입점 심사 중"), `reportCadence: string`, `dataHandling: string`, `conversionRate: number|null`(발행→인용 전환율).
  카테고리 id: `legal`(법률) · `content`(콘텐츠) · `office`(사무).
- `POST /subscriptions` `{ packageId, restore?: boolean }` — 해지했던 팀을 다시 구독할 때 `restore` 로 기존 방·기억 복원/새로 시작을 고른다. 이미 구독 중이면 409.
- `POST /subscriptions/:id/resume` — 해지 예약 취소.
- 구독 항목에 추가: `paymentMethod: string|null`, `endsAt: string|null`(해지 시 기간 말), `status` 에 `"ended"`.

## 연결 (화면 7)

- `POST /connections/mcp/test` `{ url, auth: { type: "none"|"header"|"oauth", name?, value? } }` → `{ tools: { name, risk: "read"|"write"|"external" }[] }` (저장하지 않는다).
- `GET /connections` 의 MCP 항목에 `toolCount`, `risks: { read, write, external }` 추가.
- 모델 계정: `GET /model-keys` → 제공자별 `{ provider, status: "active"|"none", last4: string|null, baseUrl?: string }` (OpenAI·Anthropic·Google·compatible 전부 한 줄씩).
  `PUT /model-keys/:provider` `{ apiKey, baseUrl? }` — 검증 통과 후에만 이전 키 폐기(교체). 실패는 `{ error, kind: "format"|"auth"|"network" }` 400.
  `DELETE /model-keys/:provider`.

## 기억 (화면 8)

- `GET /memories?category=profile|preference|goal|feedback&q=` — 항목에 `category`, `sourceLabel`("대화에서 학습" 등) 추가.
- `PATCH /memories/:id` `{ text }` (임베딩 다시 계산).
- `GET /memories/mcp-access` · `PATCH /memories/mcp-access` `{ enabled: boolean }` (다른 LLM 앱이 읽는 기억 MCP 문 — 켤 때만 열린다).

## 스킬 (화면 9)

- `Skill = { id, roomId: string|null, scope: "personal"|"package", name, version, status: "draft"|"active"|"retire_proposed"|"rejected"|"retired", evidence, appliesTo, proposedBy, measuring: boolean, effect: string|null, createdAt }`
- `GET /skills?room_id=&status=&scope=` · `POST /skills/:id/decide` `{ decision: "approve"|"reject"|"retire"|"keep", reason? }` · `POST /skills/:id/rollback` · `PATCH /skills/:id` `{ enabled }`(개인 스킬 끄기).
- 개인 스킬은 사용자가, 패키지 공통 스킬은 운영자가 승인한다(사용자 화면에서 패키지 초안은 보이지만 버튼이 없다 → 403).
- 검수·컴플라이언스 기준을 완화하는 초안은 서버가 만들지 않는다(§17.3) — 워커 `POST /worker/skills` 가 `loosens: true` 면 422.

## 운영자 콘솔 (화면 10) — `role` 이 operator·admin 일 때만, 자기 패키지만

- `GET /operator/packages` → 내 패키지 `{ id, name, character, currentVersion, pendingSkills }[]`
- `GET /operator/versions?package_id=` → `{ id, version, source: { imageDigest? , mcpUrl? }, review: { item, pass, reason? }[], canary: { stage: "profile"|"partial"|"all"|"stopped", percent }, status: "review_failed"|"canary"|"live"|"rolled_back", createdAt }[]`
- `POST /operator/versions` `{ packageId, imageDigest?, mcpUrl? }` → 심사 체크리스트 9항(§15.5) 자동 재시험. 하나라도 실패면 `status: "review_failed"`, 배포 없음.
- `POST /operator/versions/:id/canary` `{ action: "advance"|"stop" }` · `POST /operator/rollback` `{ packageId }`(심사 없이 즉시 이전 버전).
- `GET /operator/metrics?package_id=` → `{ approvalRate: number|null, topRejectReason: string|null, citations: number|null }` (집계만).
- `GET /operator/skills?package_id=` · `POST /operator/skills/:id/decide` `{ decision: "approve"|"reject", reason? }`
- `POST /operator/notices` `{ packageId, text }` → 구독자 방에 공지.

## 설정 (화면 11)

- `GET /settings` → `{ tier: { label, subscription: string|null, nextBillingAt: string|null }, answerMode: "auto"|"device"|"server", autoEconomy: boolean, fixedModel: string|null, monthlyCapKrw: number|null, notifications: { approvals: boolean, weeklyReport: boolean }, character: { enabled: boolean, intensity: "motion"|"face"|"text" } }`
- `PATCH /settings/model` `{ answerMode?, autoEconomy?, fixedModel?, monthlyCapKrw? }` · `PATCH /settings` `{ notifications?, character? }`
- `GET /billing/usage` → `{ costKrw, capKrw: number|null, percent: number|null, byok: boolean, savedKrw: number|null }` (`null` = "측정 중").
- `POST /account/delete` → `{ deleteAfter }` (30일 내 삭제 + 증적 기록).

## 로그인·온보딩 (화면 1)

- 초대 링크 `…/?invite=<code>` 로 열면 초대 코드가 자동 입력된다.
- `POST /auth/waitlist` `{ phone }` — 초대 코드가 없을 때 "초대 대기 신청".
- `PATCH /me/profile` 에 `specialty`, `region` 추가(사무소 프로필 — 이름·전문 분야·지역).
- 온보딩 3단계: 계정 → 프로필 → 첫 목표(`POST /goals`).
