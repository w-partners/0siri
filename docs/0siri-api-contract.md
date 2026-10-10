# 0Siri API 계약 — 화면 설계(«0Siri 종합 기획» §03) 100% 대응분

> 화면 11종이 요구하는데 v0.3.1 서버에 없던 표면을 여기서 한 번만 정한다. 서버·클라이언트 모두 이 파일을 정본으로 구현한다.
> 모든 경로는 `/api` 아래, 인증은 기존 Bearer 세션, 에러는 기존 `{ "error": "<문장>" }`. 모든 행은 소유자(owner)로 격리.
> 기존 응답 필드는 이름을 바꾸거나 지우지 않는다(추가만). 예외는 마스터가 직접 지시한 삭제뿐이고, 그 자리에 «삭제» 로 적는다.

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
- (v0.4.0) `GET /rooms` 항목에 추가: `archived: boolean`(해지 기간이 끝난 방 — 읽기 전용), `thirdParty: boolean`(타사 입점 팀의 방), `digest?: string`(마지막으로 본 뒤의 진척 한 줄 — 없으면 필드 자체가 없다. 방을 열면 `timeline.digest` 로 같은 문장을 받고 목록에서는 사라진다).
  `pendingApprovals` 는 승인 대기에 그 방의 개인 스킬 초안 수를 더한 값이다.
- (v0.4.0) `archived` 방에 글을 쓰면(사용자 `POST /rooms/:id/messages` · 워커 `POST /worker/messages`) 409 `{ error: "해지된 방입니다 — 읽기 전용" }` (도메인 `ARCHIVED_ROOM_NOTICE`). 읽기는 그대로 된다.
- (v0.4.0) 방 메시지 카드 `kind: "card"`, `payload: { card: "escalation", label: "확인 필요", goalId, title, rejects, actor }` — 같은 작업의 검수 반려가 `REVIEW_ESCALATION_THRESHOLD`(3)회 쌓일 때마다 올라온다. 그 목표는 `status: "blocked"` 가 되고 초안으로 되돌리지 않는다.
  워커 `POST /worker/audit` 응답에 `escalated?: true` 추가(그 반려가 에스컬레이션을 일으켰을 때만).
  카드 payload 에 `summary: string`(«검수에서 N번 반려되어 멈췄습니다 — 마지막 사유: …»), `reasonKind?: "tone"|"fact"|"topic"` 도 실린다.
  워커 `POST /worker/audit` 본문에 `reason_kind?: "tone"|"fact"|"topic"`, `detail?: string`(반려 사유 문장) 추가 — `review.reject` 에 실으면 목표 줄과 카드 요약이 쓴다.
- (v0.4.0) `Activity` 에 `messageId?: string` 추가 — 그 활동이 가리키는 방 메시지(승인 요청·승인·반려·만료 활동은 승인 카드 메시지). 없는 활동은 필드가 없다.
- (v0.4.0) `GET /rooms/:id/files` 의 `approved[]` 에 `goalId: string|null`, `messageId: string|null` 추가.

## 승인 (화면 3·4)

- `POST /approvals/:id/decide` `{ decision: "approve"|"reject", reasonKind?: "tone"|"fact"|"topic", reason?: string, frozenHash }`.
  반려는 `reasonKind` 필수(400). 이미 처리된 건은 409 + 현재 `status`.
- `GET /inbox` — `?room_id=`·`?kind=publish|consult|skill` 필터. pending 항목에 `kind`, `roomCharacter` 추가.
  한 팀 조회가 실패해도 나머지는 준다: `failed: { roomId, roomTitle, error }[]`.
- (v0.4.0) 승인 카드 방 메시지 `payload` 에 `inputHash: string` 추가 — 화면은 이 값을 `frozenHash` 로 되돌려 보낸다. 다르면 409 «화면에 보인 내용과 승인 대상이 다릅니다(동결 해시 불일치)…», 결재는 반영되지 않는다.
- (v0.4.0) 반려하면 그 방 상태(presence·`board.character.state`)가 `working` 이 된다(재작업). 승인이 만료되면 목표가 `stage: "geo"`·`progress: 60` 으로 돌아가 팀이 승인 카드를 다시 올리고, 활동에 «승인 요청 만료: …» 가 남는다.
- (v0.4.0) `GET /inbox` 의 `pending` 에 개인 스킬 초안이 섞여 온다: `{ id, skillId, kind: "skill", roomId, roomTitle, roomCharacter, title, summary, evidence, status: "pending", requestedBy, createdAt }`. 결재는 `POST /skills/:skillId/decide`(승인 경로가 아니다). `?kind=skill` 이면 초안만, `publish|consult` 면 초안은 빠진다. 초안이 생기면 사용자 스트림에 `inbox` 이벤트가 나간다.

## 목표 (화면 1·5)

- `TeamGoal.status` 에 `"proposed"` 추가(장기 목표는 사용자 승인 전에는 시작하지 않는다). 달성은 기존 `"completed"`.
- `POST /goals` `{ roomId, title }` → 장기 목표 `status: "proposed"` (온보딩 «첫 목표 한 줄»).
- `POST /goals/:id/activate` → `proposed` → `active`. 그 밖의 상태면 409.
- (v0.4.0) `POST /goals/:id/unblock` → `blocked` → `active` (`TeamGoal`). [확인 필요] 로 멈춘 목표를 주인이 풀면 워커가 다시 집는다 — 단계·진척은 멈춘 자리 그대로. 막힌 목표가 아니면 409, 남의 목표는 404. 활동(`kind: "goal"`)에 «다시 진행: …» 이 남는다.
- `GET /goals/:id/metrics?period=week|month|quarter` → `{ period, measuredAt: string|null, metrics: { published, indexed, ai_citations, conversions } }` — 각 값은 `number|null`, `null` = 아직 측정 전("수집 중").
- `GoalProposal = { id, roomId, title, detail, status: "pending"|"accepted"|"held", proposedBy, createdAt }`
  - `GET /goals/proposals?room_id=` · `POST /goals/proposals/:id/decide` `{ decision: "accept"|"hold" }` (accept → 다음 중기 목표로 편입 + 방 공지).
  - 워커: `POST /worker/goals/proposals` `{ title, detail }`.
- (v0.4.0) `GET /goals?room_id=` 항목(`TeamGoal`)에 추가: `dueAt: string|null`(목표 기간의 끝 — 정한 적이 없으면 `null`. 서버가 기간을 지어내지 않는다), `reasonKind?: "tone"|"fact"|"topic"`(가장 최근 반려의 사유 종류), `rejects?: { total: number, byKind: { tone?, fact?, topic? } }`(검수 반려 `review.reject` + 사용자 반려를 합친 건수. `byKind` 는 사유 종류가 기록된 것만 — 합이 `total` 보다 작을 수 있다. 반려가 없으면 두 필드 모두 없다).
  `POST /goals` 가 `dueAt?: string`(ISO 8601)을 받는다. 워커: `POST /worker/goals` `dueAt?`, `POST /worker/goals/:id/progress` `due_at?`.
- (v0.4.0) 제안 상태 문구는 버튼과 같은 «반영» 계열로 맞췄다: 버튼 `PROPOSAL_DECISION_LABELS`(목표에 반영·보류) ↔ 상태 `PROPOSAL_STATUS_LABELS`(대기·반영됨·보류됨). 수락 활동 제목도 «제안 반영: …».

## 스토어 (화면 6)

- `GET /store/packages` 항목에 추가: `subscribed: boolean`, `roomId: string|null`, `reviewing: boolean`("입점 심사 중"), `reportCadence: string`, `dataHandling: string`, `conversionRate: number|null`(발행→인용 전환율), `allowed: boolean`(관리자가 이 회원에게 사용을 허용했는가 — 없으면 `POST /subscriptions`·`/resume` 은 403 `kind: "grant"`).
  카테고리 id: `legal`(법률) · `content`(콘텐츠) · `office`(사무).
- `POST /subscriptions` `{ packageId, restore?: boolean }` — 해지했던 팀을 다시 구독할 때 `restore` 로 기존 방·기억 복원/새로 시작을 고른다. 이미 구독 중이면 409.
- `POST /subscriptions/:id/resume` — 해지 예약 취소.
- 구독 항목에 추가: `endsAt: string|null`(해지 시 기간 말), `status` 에 `"ended"`.
  (2026-10-10 삭제) `paymentMethod` — 결제는 앱에 넣지 않는다(마스터 지시). «추가만» 원칙의 예외로 응답에서 뺐다.
- (v0.4.0) `GET /store/packages` 항목에 `thirdParty: boolean` 추가(타사 입점 — 라벨은 도메인 `THIRD_PARTY_LABEL`). `POST /admin/packages` 가 `thirdParty?: boolean`, `greeting?: string` 을 받는다.
- (v0.4.0) 새 방으로 구독이 시작되면 팀장의 첫 인사가 방에 올라온다: `role: "assistant"`, `payload: { actor: "root", greeting: true }`, 본문은 패키지 `greeting` 또는 도메인 `DEFAULT_TEAM_GREETING`(첫 목표를 말해 달라는 초대). 복원(`restore`)에는 올리지 않는다.
- (v0.4.0) 해지(`cancel`)는 방을 잠그지 않는다 — `endsAt` 까지 그대로 쓰고, 활동에 «구독 해지 예약 — YYYY-MM-DD 까지 …» 가 남는다. `endsAt` 이 지나면 구독이 `ended` 가 되면서 방이 `archived`(읽기 전용)로 바뀌고 안내 한 줄이 남는다. 해지 예약 중에 새로 시작(`restore` 없이)으로 다시 구독하면 옛 구독은 그 자리에서 `ended`, 옛 방은 `archived` 가 된다.

## 연결 (화면 7)

- `POST /connections/mcp/test` `{ url, auth: { type: "none"|"header"|"oauth", name?, value? } }` → `{ tools: { name, risk: "read"|"write"|"external" }[] }` (저장하지 않는다).
- `GET /connections` 의 MCP 항목에 `toolCount`, `risks: { read, write, external }` 추가.
- 모델 계정: `GET /model-keys` → 제공자별 `{ provider, status: "active"|"none", last4: string|null, baseUrl?: string }` (OpenAI·Anthropic·Google·compatible 전부 한 줄씩).
  `PUT /model-keys/:provider` `{ apiKey, baseUrl? }` — 검증 통과 후에만 이전 키 폐기(교체). 실패는 `{ error, kind: "format"|"auth"|"network" }` 400.
  `DELETE /model-keys/:provider`.
  (v0.4.0) 있던 키를 지우면 활동(팀 방마다, 팀 방이 없으면 방 없이)에 «내 키를 지웠습니다 — 공용 열쇠로 전환, 월 상한 적용»(도메인 `MODEL_KEY_REMOVED_NOTICE`)이 남고 `inbox` 이벤트가 나간다.

## 기억 (화면 8)

- `GET /memories?category=profile|preference|goal|feedback&q=` — 항목에 `category`, `sourceLabel`("대화에서 학습" 등) 추가.
- `PATCH /memories/:id` `{ text }` (임베딩 다시 계산).
- `GET /memories/mcp-access` · `PATCH /memories/mcp-access` `{ enabled: boolean }` (다른 LLM 앱이 읽는 기억 MCP 문 — 켤 때만 열린다).
  (v0.4.0) 두 응답에 `ready: boolean` 추가 — 지금은 항상 `false`: 밖에서 읽는 기억 MCP 문이 아직 없어 스위치는 저장만 된다. 화면은 `ready: false` 면 «준비 중» 으로 보인다.

## 스킬 (화면 9)

- `Skill = { id, roomId: string|null, scope: "personal"|"package", name, version, status: "draft"|"active"|"retire_proposed"|"rejected"|"retired", evidence, appliesTo, proposedBy, measuring: boolean, effect: string|null, createdAt }`
- `GET /skills?room_id=&status=&scope=` · `POST /skills/:id/decide` `{ decision: "approve"|"reject"|"retire"|"keep", reason? }` · `POST /skills/:id/rollback` · `PATCH /skills/:id` `{ enabled }`(개인 스킬 끄기).
- `POST /skills/scan` → `{ scanned, created: Skill[] }` — 내 최근 요청(최대 `SKILL_SCAN_LIMIT`)을 EmbeddingGemma 로 묶어 유사도 ≥ `SKILL_SIMILARITY_MIN` 이 `SKILL_REPEAT_MIN` 번 이상이면 개인 스킬 초안(제안: 영시리)을 낸다. 같은 이름은 다시 내지 않는다. 임베딩 실패는 5xx 로 그대로 보인다.
- `POST /rooms` `{ title, seed? }` → 주제방(영시리 · `topic: true`, seed 는 첫 카드) · `PATCH /rooms/:id` `{ title }`(주제방만, 아니면 409) · `DELETE /rooms/:id`(주제방만). 홈 방 판정은 도메인 `isHomeRoom` 하나.
- 피드: `GET /feed` → 내 관심 프롬프트 글 + 관리자 글(최신 100, `liked`·`prompt`) · `POST /feed/:id/like` `{ liked }` · `GET|POST /feed/prompts` `{ prompt, everyHours? }`(만들자마자 1회 실행) · `PATCH /feed/prompts/:id` `{ active }` · `POST /feed/prompts/:id/run` · `DELETE /feed/prompts/:id` · `POST /admin/feed` `{ title, body, url? }`(관리자). 실패는 프롬프트의 `lastError` 로 남는다. 주기 실행은 작업 워커(`TASK_WORKER_ENABLED`)와 함께 10분마다.
- 개인 스킬은 사용자가, 패키지 공통 스킬은 운영자가 승인한다(사용자 화면에서 패키지 초안은 보이지만 버튼이 없다 → 403).
- 검수·컴플라이언스 기준을 완화하는 초안은 서버가 만들지 않는다(§17.3) — 워커 `POST /worker/skills` 가 `loosens: true` 면 422.
- (v0.4.0) `Skill` 에 `measureNote?: string` 추가 — `measuring: true` 일 때만 실린다(측정이 어떻게 끝나는지 한 줄, 도메인 `SKILL_MEASURE_NOTE`).
- (v0.4.0) 워커: `GET /worker/skills` → 그 방의 개인 스킬 + 패키지 스킬(`Skill` + `reason?` — 반려 사유가 초안을 낸 팀에게 돌아간다) · `POST /worker/skills/:id/effect` `{ effect: string, worse: boolean }` → `Skill`. 그 방의 개인 스킬만(아니면 403). `worse: true` 면 `status: "retire_proposed"`(폐기 제안 — 결정은 사용자), 아니면 `measuring: false` + `effect` 만 남긴다.
- (v0.4.0) 개인 스킬 초안·폐기 제안은 활동(`kind: "skill"`)으로 남고 결재함(`/inbox`)에 들어온다 — 위 «승인» 절.

## 운영자 콘솔 (화면 10) — `role` 이 operator·admin 일 때만, 자기 패키지만

- `GET /operator/packages` → 내 패키지 `{ id, name, character, currentVersion, pendingSkills }[]`
- `GET /operator/versions?package_id=` → `{ id, version, source: { imageDigest? , mcpUrl? }, review: { item, pass, reason? }[], canary: { stage: "profile"|"partial"|"all"|"stopped", percent }, status: "review_failed"|"canary"|"live"|"rolled_back", createdAt }[]`
- `POST /operator/versions` `{ packageId, imageDigest?, mcpUrl? }` → 심사 체크리스트 9항(§15.5) 자동 재시험. 하나라도 실패면 `status: "review_failed"`, 배포 없음.
- `POST /operator/versions/:id/canary` `{ action: "advance"|"stop" }` · `POST /operator/rollback` `{ packageId }`(심사 없이 즉시 이전 버전).
- `GET /operator/metrics?package_id=` → `{ approvalRate: number|null, topRejectReason: string|null, citations: number|null }` (집계만).
  (v0.4.0) 추가: `degraded: boolean`, `canaryApprovalRate: number|null`, `previousApprovalRate: number|null` — 카나리 배포 중(멈춤 제외)인 최신 버전의 `createdAt` 을 기준으로 결재(`decidedAt`)를 앞뒤로 나눠 승인율을 견준다. 뒤가 낮으면 `degraded: true`. 카나리가 없거나 한쪽에 결재가 없으면 `false`·`null`. 결재가 버전별로 표시되지 않아 시각 기준의 근사다.
- `GET /operator/skills?package_id=` · `POST /operator/skills/:id/decide` `{ decision: "approve"|"reject", reason? }`
- `POST /operator/notices` `{ packageId, text }` → 구독자 방에 공지.

## 설정 (화면 11)

- (2026-10-10 삭제) `GET /settings` 의 `tier.nextBillingAt` — 결제는 앱에 넣지 않는다(마스터 지시). «추가만» 원칙의 예외.
- `GET /settings` → `{ tier: { label, subscription: string|null }, answerMode: "auto"|"device"|"server", autoEconomy: boolean, fixedModel: string|null, monthlyCapKrw: number|null, notifications: { approvals: boolean, weeklyReport: boolean }, character: { enabled: boolean, intensity: "motion"|"face"|"text" } }`
- `PATCH /settings/model` `{ answerMode?, autoEconomy?, fixedModel?, monthlyCapKrw? }` · `PATCH /settings` `{ notifications?, character? }`
- `GET /billing/usage` → `{ costKrw, capKrw: number|null, percent: number|null, byok: boolean, savedKrw: number|null }` (`null` = "측정 중").
  (v0.4.0) 추가: `unpricedCalls: number`(단가가 없어 비용을 못 잰 호출 수 — 0 보다 크면 `percent` 는 `null`), `warn: "none"|"near"|"reached"`(도메인 `CAP_WARN_NEAR_PERCENT` 80 · `CAP_WARN_REACHED_PERCENT` 100. 상한이 없으면 `"none"`. 잰 지출만으로 내므로 `percent` 가 `null` 이어도 값이 실린다).
- (v0.4.0) 공용 열쇠로 월 상한에 닿으면 채팅이 402 `{ error: "이번 달 사용 상한에 도달해 … 내 모델 키를 연결하세요" }`(도메인 `CAP_REACHED_NOTICE`). 내 키(BYOK)로 답하는 경로는 막지 않는다.
- (v0.4.0) `GET /settings` 에 `notificationsReady: boolean` 추가 — 지금은 `false`: 알림 설정은 저장되지만 실제로 보내는 발송기가 아직 없다.
- (v0.4.0) 기기 모델이 실패해 서버가 대신 답한 경우 `answeredBy.reason` 이 «기기 실패 — 서버로 답했습니다»(도메인 `DEVICE_FALLBACK_REASON`)가 된다. 서버는 화면이 알려 줄 때만 안다: 채팅 실행 요청의 `forwardedProps.deviceFailed: true`, 또는 `POST /route` `{ deviceFailed: true }`.
- (v0.4.0) 서버 타입: `SettingsView`(`osiri/routing.ts`, `GET /settings` 응답) · `MeResponse`(`osiri/account-routes.ts`, `GET /me` 응답) · `GoalView`(`osiri/rooms.ts`, `GET /goals` 항목).
- `POST /account/delete` → `{ deleteAfter }` (30일 내 삭제 + 증적 기록).

## 로그인·온보딩 (화면 1)

- 로그인은 전화번호 + 비밀번호(`POST /auth/login`). 가입 경로는 둘뿐이다: **초대 링크** 또는 **가입 신청 → 관리자 승인**. 따로 입력하는 초대 코드는 없다(아래 «가입» 절).
- `PATCH /me/profile` 에 `specialty`, `region` 추가(사무소 프로필 — 이름·전문 분야·지역).
- 온보딩 3단계: 계정 → 프로필 → 첫 목표(`POST /goals`).

## 가입 — 전화번호 초대 · 가입 신청 · 가입 네트워크 (마스터 2026-10-10)

> 문구·라벨·상수는 도메인(`packages/domain/src/osiri.ts`)이 정본: `WAITLIST_PURPOSE_MIN`(30) · `WAITLIST_PURPOSE_MAX`(1000) · `INVITE_STATUS_LABELS` · `WAITLIST_STATUS_LABELS` · `NETWORK_NODE_STATUS_LABELS` · `INVITE_ALREADY_MEMBER_MESSAGE` · `INVITE_TAKEN_MESSAGE` · `INVITE_PHONE_MISMATCH_MESSAGE` · `WAITLIST_PURPOSE_MESSAGE` · `WAITLIST_ALREADY_PENDING_MESSAGE` · `WAITLIST_PENDING_LOGIN_MESSAGE` · `waitlistRejectedMessage(reason)`.
> 전화번호는 응답에서 숫자만(`01012345678`), 가린 번호는 `010-****-5678` 꼴.

- 사용자에 `invitedBy: string|null` 추가 — 나를 들인 회원 id(초대한 사람 · 승인 때 관리자가 붙인 상위 회원). 뿌리·관리자 시드·옛 계정은 `null`. `GET /me` 의 `user`, 로그인·초대 수락 응답의 `user` 에 실린다.
- **초대(로그인한 회원 누구나)**
  - `POST /invites` `{ phone }` → 201 `{ link, invite: { id, phone, status: "pending", createdAt, expiresAt } }`. `link` = `<publicUrl>/invite/<token>`, 시각은 ISO 문자열, 유효 7일. 초대는 그 번호에 묶이고 역할은 일반 회원.
    409 «이미 가입한 번호입니다» · 409 «이미 다른 분이 초대한 번호입니다»(다른 회원의 살아 있는 초대가 있을 때). 내가 초대 중인 번호를 다시 초대하면 새 링크가 나오고 옛 링크는 무효.
  - `GET /invites` → 내가 보낸 초대 `{ id, phone, status: "pending"|"joined"|"expired", createdAt, expiresAt, joinedUserId? }[]`(최신순).
  - `DELETE /invites/:id` → `{ ok: true }`. 내 것만(남의 것·없는 것 404), 이미 가입한 초대는 409.
- **초대 링크(공개)**
  - `GET /auth/invite/:token` → `{ phoneHint: string|null, inviterName: string|null }`. `phoneHint` 는 가린 번호(관리자의 번호 없는 초대는 `null`), `inviterName` 은 초대한 사람의 표시 이름(안 정했으면 `null`). 모르는 링크 404 · 이미 쓰였거나 만료 410.
  - `POST /auth/invite/accept` `{ token, phone, password }` → 로그인과 같은 `{ token, user }`. 입력한 번호가 초대받은 번호와 다르면 400 «초대받은 전화번호와 다릅니다». 가입한 사용자의 `invitedBy` = 초대한 사람.
- **가입 신청(공개)**
  - `POST /auth/waitlist` `{ phone, password, purpose }` → 201 `{ status: "pending" }`. `purpose`(무엇을 어떻게 쓰고 싶은지)는 앞뒤 공백을 뺀 길이가 `WAITLIST_PURPOSE_MIN` 이상이어야 한다 — 아니면 400 `WAITLIST_PURPOSE_MESSAGE`. 비밀번호는 가입과 같은 규칙(422), 해시로만 보관.
    409 «이미 가입한 번호입니다» · 409 `WAITLIST_ALREADY_PENDING_MESSAGE`. 반려된 번호는 다시 신청할 수 있다.
  - 신청자가 그 번호·비밀번호로 로그인하면: 검토 중 403 `WAITLIST_PENDING_LOGIN_MESSAGE` · 반려 403 `waitlistRejectedMessage(사유)`. (비밀번호가 틀리면 여느 실패와 같은 401.) 승인되면 그대로 로그인된다.
- **관리자**
  - `GET /admin/waitlist` → `{ id, phone, purpose, status: "pending"|"approved"|"rejected", requestedAt, decidedAt?, parentId?, rejectReason? }[]`(신청순). `id` 는 전화번호가 아닌 식별자다.
  - `POST /admin/waitlist/:id/approve` `{ parentId }` → 갱신된 항목. `parentId` 는 실제 회원이어야 한다(없으면 404). 신청 때의 해시로 사용자를 만들고 `invitedBy = parentId`. 검토 중이 아니면 409. 비밀번호 없이 접수된 옛 항목은 409.
  - `POST /admin/waitlist/:id/reject` `{ reason }` → 갱신된 항목. 검토 중이 아니면 409.
  - `GET /admin/users?q=` → 회원 목록, 항목에 `id, phone, name: string|null, invitedBy: string|null` (+ `role`, `tier`, `createdAt`). `q` 는 이름 부분 일치 · 전화번호 숫자 부분 일치.
  - `PATCH /admin/users/:id/role` `{ role: "user"|"operator"|"admin" }` → 갱신된 회원. 관리자만. 자기 역할은 409(`ROLE_SELF_MESSAGE`) — 바꾸는 사람이 늘 관리자로 남아 관리자 0명이 되지 않는다. 없는 회원 404. 감사 로그 `role.set`.
  - `GET /admin/grants/:userId` → `{ packageIds: string[] }` — 그 회원에게 관리자가 사용을 허용한 팀.
  - `PUT /admin/grants` `{ userId, packageId, allowed }` → `{ packageIds }`. 허용을 거두면 쓰고 있던 구독은 해지 예약된다. 감사 로그 `store.grant`.
  - `POST /admin/packages/yaml` `{ yaml, summary, image, reviewing, requiredTier? }` → 등록된 패키지. 스토어 등록(관리자 화면). 팀 YAML 의 `package`(slug·name·character·category·approval_points)와 `agents` 가 정본이고, YAML 은 `<DATA_DIR>/teams/<slug>.yaml` 에 저장된다. 같은 slug 면 갱신. 읽지 못한 YAML·필수 역할 누락은 422. 감사 로그 `store.register`.
  - 승인·반려는 감사 로그에 남는다(`waitlist.approve …` · `waitlist.reject …`, 관리자 본인 것과 system 것).
  - 기존 `POST /admin/invites` · `GET /admin/invites` 는 그대로 동작한다.
- **가입 네트워크**
  - `GET /network` → `{ root: NetworkNode, counts: { direct, total } }`,
    `NetworkNode = { id, name: string|null, phone: string, status: "joined"|"invited", joinedAt: string|null, children: NetworkNode[] }`.
  - 뿌리는 항상 부르는 사람이다. **아래로만** 내려간다 — 나를 들인 사람(위)·같은 사람이 들인 다른 사람(옆)은 응답 어디에도 없고, 다른 가지를 고르는 인자도 없다.
  - 자식 = `invitedBy` 가 그 마디인 회원(가입순). 뿌리에는 내가 보낸 아직 가입 전인 초대가 `status: "invited"` 잎(`name: null`, `joinedAt: null`, `id` = 초대 id)으로 뒤에 붙는다.
  - `phone` 은 내 바로 아래 단계까지만 그대로, 그보다 깊으면 가린 번호.
  - `counts` 는 **가입한 회원만** 센다(`direct` = 바로 아래, `total` = 아래 전체). 초대 중인 잎은 세지 않는다.
  - 회원이 탈퇴로 지워지면 그 아래 사람들은 한 단계 위 회원에게 붙는다.
