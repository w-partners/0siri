// «화면 설계» 대조 감사(v0.4.0)의 서버 쪽 빈칸 대응 시험:
// 승인 카드 동결 해시 · 반려 뒤 «작업 중» · 만료 뒤 재요청 신호 · 방 항목(archived·thirdParty·digest) · 읽기 전용 방 ·
// 팀장 첫 인사 · 스킬 초안의 결재함 유입·효과 측정 · 검수 반려 반복 에스컬레이션.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { type Approval, Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus, type RoomEvent } from "../apps/server/src/osiri/events.ts";
import {
  issueWorkerToken,
  roomRoutes,
  workerRoutes,
} from "../apps/server/src/osiri/room-routes.ts";
import {
  type GoalView,
  type RoomBoard,
  type RoomCard,
  Rooms,
} from "../apps/server/src/osiri/rooms.ts";
import {
  type Skill,
  Skills,
  skillRoutes,
  skillWorkerRoutes,
} from "../apps/server/src/osiri/skills.ts";
import { Catalog, type TeamPackage } from "../apps/server/src/osiri/store.ts";
import {
  APPROVAL_STATUS_LABELS,
  ARCHIVED_ROOM_NOTICE,
  DEFAULT_TEAM_GREETING,
  ESCALATION_LABEL,
  GOAL_TREE_LEVELS,
  PROPOSAL_DECISION_LABELS,
  PROPOSAL_STATUS_LABELS,
  REVIEW_ESCALATION_THRESHOLD,
  SKILL_MEASURE_NOTE,
} from "../packages/domain/src/osiri.ts";
import { grantOnSubscribe } from "./grant-on-subscribe.ts";

type TestApp = Hono<{ Variables: { owner: string } }>;
let db: Store, directory: string, rooms: Rooms, bus: EventBus, approvals: Approvals;
let catalog: Catalog, skills: Skills, app: TestApp;
let platformPkg: TeamPackage, partnerPkg: TeamPackage;

const call = (token: string, path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(response: Response | Promise<Response>) => (await response).json() as T;
const team = (slug: string, extra: Partial<TeamPackage> = {}) =>
  catalog.upsertPackage({
    slug,
    name: `${slug} 팀`,
    character: "counsel",
    category: "legal",
    summary: "감지부터 발행까지",
    roles: [
      { name: "root", title: "팀장", summary: "목표 분해" },
      { name: "monitor", title: "감지", summary: "감지" },
      { name: "drafter", title: "초안", summary: "초안" },
      { name: "geo", title: "GEO", summary: "GEO" },
      { name: "reviewer", title: "검수", summary: "인용 규정" },
      { name: "publisher", title: "발행", summary: "승인된 것만" },
      { name: "analyst", title: "분석", summary: "주간 보고" },
    ],
    approvalPoints: ["발행 전 승인"],
    reportCadence: "weekly",
    verified: true,
    metrics: { published: 0, indexed: 0, ai_citations: 0 },
    runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
    ...extra,
  });
type Inbox = {
  pending: { id: string; kind: string; skillId?: string; roomId: string; title: string }[];
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-screens-"));
  db = await createStore({ dataDir: join(directory, "db") });
  bus = new EventBus();
  rooms = new Rooms(db, bus);
  approvals = new Approvals(db, rooms, bus);
  catalog = new Catalog(db, rooms, async () => undefined);
  grantOnSubscribe(catalog);
  skills = new Skills(db, rooms);
  platformPkg = await team("screens-own");
  partnerPkg = await team("screens-partner", {
    thirdParty: true,
    greeting: "제휴 팀장입니다. 첫 목표를 말씀해 주세요.",
  });
  app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.message }, 422);
    return c.json({ error: error.message }, error instanceof AppError ? error.status : 500);
  });
  const deps = { db, rooms, approvals, bus, catalog, skills };
  app.route("/api/worker", workerRoutes(deps));
  app.route("/api/worker", skillWorkerRoutes(skills));
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", roomRoutes(deps));
  app.route("/api", skillRoutes(skills));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("도메인 라벨: 서버가 쓰던 표가 도메인에 있다", () => {
  assert.equal(APPROVAL_STATUS_LABELS.expired, "만료됨");
  assert.deepEqual([...GOAL_TREE_LEVELS], ["long", "mid", "short"]);
  // 제안 상태 칩과 버튼이 같은 말(«반영») 을 쓴다
  assert.equal(PROPOSAL_DECISION_LABELS.accept, "목표에 반영");
  assert.equal(PROPOSAL_STATUS_LABELS.accepted, "반영됨");
});

test("구독 직후 팀장 첫 인사 · 스토어와 방 항목의 thirdParty", async () => {
  const owner = "greet-user";
  const own = await catalog.subscribe(owner, platformPkg.id);
  const partner = await catalog.subscribe(owner, partnerPkg.id);
  const last = async (roomId: string) => (await rooms.timeline(owner, roomId)).at(-1);
  // 패키지가 따로 적지 않으면 기본 인사 — 첫 목표를 말해 달라는 초대가 들어 있다
  assert.equal((await last(own.roomId))?.text, DEFAULT_TEAM_GREETING);
  assert.match(DEFAULT_TEAM_GREETING, /첫 목표/);
  assert.equal((await last(own.roomId))?.role, "assistant");
  assert.equal((await last(partner.roomId))?.text, "제휴 팀장입니다. 첫 목표를 말씀해 주세요.");

  const store = await catalog.packages({}, owner);
  assert.equal(store.find((p) => p.id === platformPkg.id)?.thirdParty, false);
  assert.equal(store.find((p) => p.id === partnerPkg.id)?.thirdParty, true);
  const cards = await json<RoomCard[]>(call(owner, "/api/rooms"));
  assert.equal(cards.find((r) => r.id === own.roomId)?.thirdParty, false);
  assert.equal(cards.find((r) => r.id === partner.roomId)?.thirdParty, true);
  assert.equal(cards.find((r) => r.packageId === null)?.thirdParty, false);
  assert.ok(cards.every((r) => r.archived === false));
});

test("방 목록 digest — 마지막으로 본 뒤의 진척 한 줄, 없으면 싣지 않는다", async () => {
  const owner = "digest-user";
  const room = await rooms.create(owner, { packageId: null, title: "개인", character: "yeongsil" });
  const card = async () =>
    (await json<RoomCard[]>(call(owner, "/api/rooms"))).find((r) => r.id === room.id) as RoomCard;
  assert.equal("digest" in (await card()), false, "한 번도 안 본 방은 «부재» 가 아니다");
  await rooms.patch(owner, room.id, { lastSeenAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal("digest" in (await card()), false);
  await rooms.activity(owner, {
    roomId: room.id,
    kind: "publish",
    actor: "publisher",
    title: "발행",
  });
  const digest = (await card()).digest;
  assert.match(digest ?? "", /부재 중 1건/);
  // 방을 열면(타임라인) 같은 문장을 받고, 그 뒤 목록에서는 사라진다
  const timeline = await json<{ digest: string | null }>(
    call(owner, `/api/rooms/${room.id}/timeline`),
  );
  assert.equal(timeline.digest, digest);
  assert.equal("digest" in (await card()), false);
});

test("해지된 방은 읽기 전용 — 사용자·워커 글 모두 409", async () => {
  const owner = "archived-user";
  const room = await rooms.create(owner, { packageId: null, title: "닫힌 방", character: "c" });
  const worker = await issueWorkerToken(db, owner, room.id, null);
  await rooms.patch(owner, room.id, { archived: true });
  const posted = await call(owner, `/api/rooms/${room.id}/messages`, { text: "안녕" });
  assert.equal(posted.status, 409);
  assert.equal((await json<{ error: string }>(posted)).error, ARCHIVED_ROOM_NOTICE);
  assert.equal(
    (await call(worker, "/api/worker/messages", { kind: "text", text: "보고" })).status,
    409,
  );
  assert.equal((await rooms.timeline(owner, room.id)).length, 0);
  const card = (await json<RoomCard[]>(call(owner, "/api/rooms"))).find((r) => r.id === room.id);
  assert.equal(card?.archived, true);
});

test("승인 카드가 동결 해시를 싣고, 다른 해시로는 결재할 수 없다 · 반려하면 «작업 중»", async () => {
  const owner = "hash-user";
  const room = await rooms.create(owner, { packageId: null, title: "승인", character: "c" });
  const request = (title: string) =>
    approvals.request(owner, {
      roomId: room.id,
      toolName: "site:publish",
      input: { title },
      title,
      summary: "요약",
      requestedBy: "publisher",
    });
  const first = await request("첫 글");
  const cardOf = async (approval: Approval) =>
    (await rooms.timeline(owner, room.id)).find((m) => m.id === approval.messageId);
  assert.equal((await cardOf(first))?.payload?.inputHash, first.inputHash);

  const stale = await call(owner, `/api/approvals/${first.id}/decide`, {
    decision: "approve",
    frozenHash: "0".repeat(64),
  });
  assert.equal(stale.status, 409);
  assert.match((await json<{ error: string }>(stale)).error, /동결 해시/);
  assert.equal(
    (await approvals.get(owner, first.id)).status,
    "pending",
    "거절된 결재는 반영되지 않는다",
  );

  const ok = await call(owner, `/api/approvals/${first.id}/decide`, {
    decision: "approve",
    frozenHash: (await cardOf(first))?.payload?.inputHash,
  });
  assert.equal(ok.status, 200);

  // 반려 → 캐릭터·현황판이 «작업 중»(재작업)
  const second = await request("둘째 글");
  const rejected = await call(owner, `/api/approvals/${second.id}/decide`, {
    decision: "reject",
    reasonKind: "tone",
    frozenHash: second.inputHash,
  });
  assert.equal(rejected.status, 200);
  assert.equal(bus.getPresence(owner, room.id), "working");
  const board = await json<RoomBoard>(call(owner, `/api/rooms/${room.id}/board`));
  assert.equal(board.character.state, "working");
});

test("승인이 만료되면 목표가 승인 단계에서 풀려 워커가 다시 요청한다", async () => {
  const owner = "expire-user";
  const room = await rooms.create(owner, { packageId: null, title: "만료", character: "c" });
  const goal = await rooms.createGoal(owner, { roomId: room.id, title: "글 1건", level: "short" });
  await rooms.updateGoal(owner, goal.id, { progress: 90, stage: "approval" });
  const approval = await approvals.request(owner, {
    roomId: room.id,
    goalId: goal.id,
    toolName: "site:publish",
    input: { title: "글" },
    title: "발행 승인",
    summary: "요약",
    requestedBy: "publisher",
  });
  await db.put(owner, "approvals", {
    ...(await approvals.get(owner, approval.id)),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  // 결재함을 읽는 것만으로 만료가 정리된다 — 워커가 폴링하지 않아도 목표가 풀린다
  const inbox = await json<Inbox>(call(owner, "/api/inbox"));
  assert.equal(inbox.pending.length, 0);
  const requeued = await rooms.goal(owner, goal.id);
  assert.equal(requeued.stage, "geo");
  assert.equal(requeued.progress, 60);
  assert.equal(requeued.status, "active");
  assert.ok((await rooms.activities(owner)).some((a) => /승인 요청 만료/.test(a.title)));
  const card = (await rooms.timeline(owner, room.id)).find((m) => m.id === approval.messageId);
  assert.equal(card?.payload?.status, "expired");
});

test("스킬 초안이 결재함·배지·inbox 이벤트로 온다 · 효과 측정은 팀 보고로 끝난다", async () => {
  const owner = "skill-user";
  const room = await rooms.ensurePersonalRoom(owner);
  const worker = await issueWorkerToken(db, owner, room.id, null);
  const events: RoomEvent[] = [];
  const unsubscribe = bus.subscribe(owner, (event) => events.push(event));
  const draft = (name: string) =>
    json<Skill>(
      call(worker, "/api/worker/skills", {
        scope: "personal",
        name,
        evidence: "정의문으로 시작한 글의 인용률 2배",
        appliesTo: "상속 콘텐츠 초안",
        actor: "analyst",
      }),
    );
  const first = await draft("정의문 먼저");
  unsubscribe();
  assert.ok(
    events.some((event) => event.type === "inbox"),
    "초안이 생기면 inbox 이벤트가 나간다",
  );

  const inbox = await json<Inbox>(call(owner, "/api/inbox"));
  const item = inbox.pending.find((p) => p.skillId === first.id);
  assert.equal(item?.kind, "skill");
  assert.equal(item?.roomId, room.id);
  assert.equal((await json<Inbox>(call(owner, "/api/inbox?kind=skill"))).pending.length, 1);
  assert.equal((await json<Inbox>(call(owner, "/api/inbox?kind=publish"))).pending.length, 0);
  // 방 목록 배지도 같은 수를 센다
  const badge = async () =>
    (await json<RoomCard[]>(call(owner, "/api/rooms"))).find((r) => r.id === room.id)
      ?.pendingApprovals;
  assert.equal(await badge(), 1);

  // 기존 결정 경로로 승인 → 결재함·배지에서 빠지고, 측정 중임과 측정 방식이 함께 보인다
  const active = await json<Skill>(
    call(owner, `/api/skills/${first.id}/decide`, { decision: "approve" }),
  );
  assert.equal(active.measuring, true);
  assert.equal(active.measureNote, SKILL_MEASURE_NOTE);
  assert.equal((await json<Inbox>(call(owner, "/api/inbox"))).pending.length, 0);
  assert.equal(await badge(), 0);

  // 팀이 «나빠졌다» 고 보고 → 폐기 제안 (측정 끝, 결정은 사람이)
  const proposed = await json<Skill>(
    call(worker, `/api/worker/skills/${first.id}/effect`, { effect: "인용률 −12%", worse: true }),
  );
  assert.equal(proposed.status, "retire_proposed");
  assert.equal(proposed.measuring, false);
  assert.equal(proposed.effect, "인용률 −12%");
  assert.equal("measureNote" in proposed, false);
  assert.ok((await rooms.activities(owner)).some((a) => /스킬 폐기 제안/.test(a.title)));

  // «좋아졌다» 는 효과만 남기고 계속 장착
  const second = await draft("표 먼저");
  await call(owner, `/api/skills/${second.id}/decide`, { decision: "approve" });
  const kept = await json<Skill>(
    call(worker, `/api/worker/skills/${second.id}/effect`, { effect: "인용률 +8%", worse: false }),
  );
  assert.equal(kept.status, "active");
  assert.equal(kept.measuring, false);
  assert.equal(kept.effect, "인용률 +8%");
  // 다른 방의 워커는 보고할 수 없다
  const elsewhere = await rooms.create(owner, {
    packageId: null,
    title: "다른 방",
    character: "c",
  });
  const stranger = await issueWorkerToken(db, owner, elsewhere.id, null);
  assert.equal(
    (await call(stranger, `/api/worker/skills/${second.id}/effect`, { effect: "x", worse: true }))
      .status,
    403,
  );

  // 반려 사유는 초안을 낸 팀(워커)에게 돌아간다
  const third = await draft("길게 쓰기");
  await call(owner, `/api/skills/${third.id}/decide`, {
    decision: "reject",
    reason: "너무 길어요",
  });
  const seen = await json<(Skill & { reason?: string })[]>(call(worker, "/api/worker/skills"));
  assert.equal(seen.find((s) => s.id === third.id)?.reason, "너무 길어요");
  assert.equal(seen.find((s) => s.id === third.id)?.status, "rejected");
});

test("같은 작업의 검수 반려가 쌓이면 [확인 필요] 카드로 올리고 목표를 멈춘다", async () => {
  const owner = "escalate-user";
  const room = await rooms.create(owner, { packageId: null, title: "검수", character: "c" });
  const worker = await issueWorkerToken(db, owner, room.id, null);
  const goal = await rooms.createGoal(owner, { roomId: room.id, title: "상속 글", level: "short" });
  const reject = () =>
    json<{ id: string; escalated?: boolean }>(
      call(worker, "/api/worker/audit", {
        actor: "reviewer",
        action: "review.reject",
        result: "error",
        goal_id: goal.id,
        reason_kind: "fact",
        detail: "판례 번호가 원문과 다릅니다",
      }),
    );
  for (let i = 1; i < REVIEW_ESCALATION_THRESHOLD; i++)
    assert.equal((await reject()).escalated, undefined, `${i}회째는 아직 올리지 않는다`);
  assert.equal((await rooms.goal(owner, goal.id)).status, "active");
  assert.equal((await reject()).escalated, true);
  assert.equal((await rooms.goal(owner, goal.id)).status, "blocked");
  const cards = (await rooms.timeline(owner, room.id)).filter(
    (m) => m.kind === "card" && m.payload?.card === "escalation",
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.payload?.label, ESCALATION_LABEL);
  assert.equal(cards[0]?.payload?.goalId, goal.id);
  assert.equal(cards[0]?.payload?.rejects, REVIEW_ESCALATION_THRESHOLD);
  assert.equal(cards[0]?.payload?.title, "상속 글");
  assert.match(String(cards[0]?.payload?.summary), /3번 반려.*판례 번호가 원문과 다릅니다/);
  // 목표 줄: 가장 최근 반려의 사유 종류와 사유별 건수
  const view = (await json<GoalView[]>(call(owner, `/api/goals?room_id=${room.id}`))).find(
    (g) => g.id === goal.id,
  );
  assert.equal(view?.reasonKind, "fact");
  assert.deepEqual(view?.rejects, { total: REVIEW_ESCALATION_THRESHOLD, byKind: { fact: 3 } });
});

test("막힌 목표를 [다시 진행] 으로 풀면 active 로 돌아가 워커가 다시 집는다 · 막힌 목표가 아니면 409", async () => {
  const owner = "unblock-user";
  const room = await rooms.create(owner, { packageId: null, title: "해제", character: "c" });
  const goal = await rooms.createGoal(owner, { roomId: room.id, title: "상속 글", level: "short" });
  // 막히지 않은 목표는 풀 것이 없다
  assert.equal((await call(owner, `/api/goals/${goal.id}/unblock`, {})).status, 409);
  await rooms.updateGoal(owner, goal.id, { status: "blocked", stage: "draft", progress: 40 });
  // 남의 목표는 보이지 않는다
  assert.equal((await call("someone-else", `/api/goals/${goal.id}/unblock`, {})).status, 404);
  const released = await call(owner, `/api/goals/${goal.id}/unblock`, {});
  assert.equal(released.status, 200);
  const after = await json<GoalView>(released);
  assert.equal(after.status, "active");
  assert.equal(after.stage, "draft"); // 멈춘 자리 그대로
  assert.equal(after.progress, 40);
  assert.equal((await rooms.goal(owner, goal.id)).status, "active");
  const activity = (await rooms.activities(owner)).find((a) => a.title === "다시 진행: 상속 글");
  assert.equal(activity?.kind, "goal");
  assert.equal(activity?.roomId, room.id);
  assert.ok(
    (await rooms.auditLogs(owner)).some(
      (log) => log.goalId === goal.id && log.action === "goal.unblock",
    ),
  );
  // 두 번 누르면 두 번째는 409
  assert.equal((await call(owner, `/api/goals/${goal.id}/unblock`, {})).status, 409);
});

test("활동·승인본이 방 메시지를 가리킨다 · 목표 기간(dueAt) · 사용자 반려도 목표 줄에 센다", async () => {
  const owner = "link-user";
  const room = await rooms.create(owner, { packageId: null, title: "연결", character: "c" });
  const worker = await issueWorkerToken(db, owner, room.id, null);
  const dueAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const long = await json<GoalView>(
    call(owner, "/api/goals", { roomId: room.id, title: "상속 분야 1위", dueAt }),
  );
  const task = await rooms.createGoal(owner, { roomId: room.id, title: "글 1건", level: "task" });
  const request = (title: string) =>
    approvals.request(owner, {
      roomId: room.id,
      goalId: task.id,
      toolName: "site:publish",
      input: { title },
      title,
      summary: "요약",
      requestedBy: "publisher",
    });
  const rejected = await request("첫 글");
  await approvals.decide(owner, rejected.id, "reject", {
    decidedBy: owner,
    reasonKind: "tone",
    frozenHash: rejected.inputHash,
  });
  const approved = await request("고친 글");
  await approvals.decide(owner, approved.id, "approve", {
    decidedBy: owner,
    frozenHash: approved.inputHash,
  });

  // 활동 줄 → 그 승인 카드 메시지
  const activities = await rooms.activities(owner);
  assert.equal(
    activities.find((a) => a.title === "승인 요청: 고친 글")?.messageId,
    approved.messageId,
  );
  assert.equal(activities.find((a) => a.title === "반려: 첫 글")?.messageId, rejected.messageId);
  // 승인본 → 목표·메시지
  const files = await json<{
    approved: { approvalId: string; goalId: string | null; messageId: string | null }[];
  }>(call(owner, `/api/rooms/${room.id}/files`));
  assert.deepEqual(
    files.approved.map(({ approvalId, goalId, messageId }) => ({ approvalId, goalId, messageId })),
    [{ approvalId: approved.id, goalId: task.id, messageId: approved.messageId }],
  );
  // 목표: 기간은 정한 것만, 없으면 null · 사용자 반려의 사유 종류
  const views = await json<GoalView[]>(call(owner, `/api/goals?room_id=${room.id}`));
  assert.equal(views.find((g) => g.id === long.id)?.dueAt, dueAt);
  const taskView = views.find((g) => g.id === task.id);
  assert.equal(taskView?.dueAt, null);
  assert.equal(taskView?.reasonKind, "tone");
  assert.deepEqual(taskView?.rejects, { total: 1, byKind: { tone: 1 } });
  assert.equal("rejects" in (views.find((g) => g.id === long.id) ?? {}), false);
  // 팀이 기간을 고칠 수 있다
  const next = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await call(worker, `/api/worker/goals/${task.id}/progress`, { progress: 10, due_at: next });
  assert.equal((await rooms.goalViews(owner, room.id)).find((g) => g.id === task.id)?.dueAt, next);
});
