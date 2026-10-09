// docs/0siri-api-contract.md «방 (화면 2·3)» · «승인 (화면 3·4)» · «목표 (화면 1·5)» 대응 시험.
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
import { EventBus } from "../apps/server/src/osiri/events.ts";
import {
  type GoalDecomposer,
  type RoomDeps,
  roomRoutes,
  teamDecomposer,
  workerRoutes,
} from "../apps/server/src/osiri/room-routes.ts";
import {
  type AuditLog,
  type GoalProposal,
  type Room,
  type RoomBoard,
  type RoomCard,
  type RoomMessage,
  Rooms,
  type TeamGoal,
} from "../apps/server/src/osiri/rooms.ts";
import {
  ANSWER_SOURCE_LABELS,
  answerLabel,
  GOAL_STATUSES,
  PERSONAL_TIER_LABEL,
  STAGE_LABELS,
  TEAM_TIER_LABEL,
} from "../packages/domain/src/osiri.ts";

type TestApp = Hono<{ Variables: { owner: string } }>;
let db: Store, directory: string, rooms: Rooms, bus: EventBus, approvals: Approvals;
let app: TestApp;
/** 시험마다 바꿔 끼우는 목표 분해기 */
let decomposer: GoalDecomposer;
const TEAM_PACKAGE = "pkg-legal";
const catalog = {
  packageById: async (id: string) => {
    if (id !== TEAM_PACKAGE) throw new AppError("팀을 찾을 수 없습니다", 404);
    return {
      roles: [{ name: "publisher", title: "발행 담당", summary: "승인된 글을 발행한다" }],
      runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
    };
  },
} as unknown as NonNullable<RoomDeps["catalog"]>;
/** 사용량 장부 대역 — 방 id(threadId) 별 답변 출처 */
const usage = new Map<string, Awaited<ReturnType<NonNullable<RoomDeps["routing"]>["answers"]>>>();
const routing: NonNullable<RoomDeps["routing"]> = {
  answers: async (_owner, threadId) => usage.get(threadId) ?? [],
};

function mount(deps: RoomDeps): TestApp {
  const built: TestApp = new Hono();
  built.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.message }, 422);
    return c.json({ error: error.message }, error instanceof AppError ? error.status : 500);
  });
  built.route("/api/worker", workerRoutes(deps));
  // 시험용 인증: Bearer 값이 곧 소유자
  built.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) throw new AppError("로그인이 필요합니다", 401);
    c.set("owner", header.slice(7));
    await next();
  });
  built.route("/api", roomRoutes(deps));
  return built;
}
const call = (owner: string, path: string, body?: unknown, on: TestApp = app) =>
  on.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(response: Response | Promise<Response>) => (await response).json() as T;
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`기다리던 일이 일어나지 않았습니다: ${what}`);
}
const teamRoom = (owner: string, title: string) =>
  rooms.create(owner, { packageId: TEAM_PACKAGE, title, character: "lawyer-cat" });
const requestApproval = (owner: string, roomId: string, title: string, kind?: Approval["kind"]) =>
  approvals.request(owner, {
    roomId,
    toolName: "site:publish",
    input: { title },
    title,
    summary: `${title} 요약`,
    requestedBy: "publisher",
    kind,
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-contract-rooms-"));
  db = await createStore({ dataDir: join(directory, "db") });
  bus = new EventBus();
  rooms = new Rooms(db, bus);
  approvals = new Approvals(db, rooms, bus);
  app = mount({
    db,
    rooms,
    approvals,
    bus,
    catalog,
    routing,
    decomposer: (input) => decomposer(input),
  });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("도메인 상수: 답변 라벨 · 단계 라벨 · proposed 상태", () => {
  assert.equal(answerLabel("device", 1), "기기에서 답함");
  assert.equal(answerLabel("server", 3), "서버 주력 모델이 답함");
  assert.equal(answerLabel("server", 2), "서버 경량 모델이 답함");
  assert.equal(answerLabel("byok", 4), ANSWER_SOURCE_LABELS.byok);
  assert.deepEqual(STAGE_LABELS, {
    detect: "감지",
    draft: "초안",
    review: "검수",
    approval: "승인 대기",
    publish: "발행",
  });
  assert.ok((GOAL_STATUSES as readonly string[]).includes("proposed"));
});

test("GET /rooms 정렬: 승인 대기(많은 순) → 최근 활동 → 이름, 고정은 그룹 안에서만 · muted/stalled/tierLabel", async () => {
  const owner = "sort-user";
  const personal = await rooms.ensurePersonalRoom(owner);
  const [one, two, pinnedQuiet, recent, ga, na] = await Promise.all(
    ["대기 하나(고정)", "대기 둘", "조용한 고정", "최근 활동", "가 팀", "나 팀"].map((title) =>
      teamRoom(owner, title),
    ),
  );
  await requestApproval(owner, one.id, "글 1");
  await requestApproval(owner, two.id, "글 2");
  await requestApproval(owner, two.id, "글 3");
  await rooms.patch(owner, one.id, { pinned: true });
  await rooms.patch(owner, pinnedQuiet.id, { pinned: true });
  // 대기 없는 방의 최근 활동 시각을 정한다 (승인 대기 방보다 최근이어도 아래에 온다)
  const at = (iso: string) => async (room: Room) =>
    db.put(owner, "rooms", { ...(await rooms.get(owner, room.id)), lastActivityAt: iso });
  await at("2099-01-03T00:00:00.000Z")(recent);
  await at("2099-01-02T00:00:00.000Z")(personal);
  await at("2000-01-01T00:00:00.000Z")(pinnedQuiet);
  await at("2000-01-01T00:00:00.000Z")(na);
  await at("2000-01-01T00:00:00.000Z")(ga);
  // 약속한 보고 주기(주간)를 넘긴 팀 — 8일 전에 만들어졌고 보고가 없다
  await db.put(owner, "rooms", {
    ...(await rooms.get(owner, ga.id)),
    createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
  });

  const list = await json<RoomCard[]>(call(owner, "/api/rooms"));
  assert.deepEqual(
    list.map((room) => room.title),
    ["대기 하나(고정)", "대기 둘", "조용한 고정", "최근 활동", "영시리", "가 팀", "나 팀"],
  );
  assert.deepEqual(
    list.map((room) => room.pendingApprovals),
    [1, 2, 0, 0, 0, 0, 0],
  );
  const byTitle = (title: string) => list.find((room) => room.title === title) as RoomCard;
  assert.equal(byTitle("영시리").tierLabel, PERSONAL_TIER_LABEL);
  assert.equal(byTitle("가 팀").tierLabel, TEAM_TIER_LABEL);
  assert.equal(byTitle("가 팀").stalled, true, "보고 주기를 넘긴 팀은 멈춘 팀");
  assert.equal(byTitle("나 팀").stalled, false, "방금 만든 팀은 아직 주기 안");
  assert.equal(byTitle("영시리").stalled, false, "개인 방은 보고를 약속하지 않는다");
  assert.ok(list.every((room) => room.muted === false));
});

test("POST /rooms/:id/mute → 방 항목 · 남의 방은 404", async () => {
  const owner = "mute-user";
  const room = await teamRoom(owner, "알림 끌 방");
  const muted = await call(owner, `/api/rooms/${room.id}/mute`, { muted: true });
  assert.equal(muted.status, 200);
  const card = await json<RoomCard>(muted);
  assert.equal(card.muted, true);
  assert.equal(card.id, room.id);
  assert.equal(card.tierLabel, TEAM_TIER_LABEL);
  assert.equal(typeof card.pendingApprovals, "number");
  const list = await json<RoomCard[]>(call(owner, "/api/rooms"));
  assert.equal(list.find((r) => r.id === room.id)?.muted, true);
  assert.equal(
    (await json<RoomCard>(call(owner, `/api/rooms/${room.id}/mute`, { muted: false }))).muted,
    false,
  );
  assert.equal(
    (await call("someone-else", `/api/rooms/${room.id}/mute`, { muted: true })).status,
    404,
  );
  assert.equal((await call(owner, `/api/rooms/${room.id}/mute`, { muted: "yes" })).status, 422);
});

test("반려는 reasonKind 필수(400) · 사유 종류는 승인·감사 로그에 남는다 · 이미 처리된 건은 409 + status", async () => {
  const owner = "reject-user";
  const room = await teamRoom(owner, "반려 방");
  const approval = await requestApproval(owner, room.id, "반려할 글");

  const missing = await call(owner, `/api/approvals/${approval.id}/decide`, {
    decision: "reject",
    reason: "톤이 세다",
  });
  assert.equal(missing.status, 400);
  assert.match((await json<{ error: string }>(missing)).error, /reasonKind/);
  assert.equal(
    (await approvals.get(owner, approval.id)).status,
    "pending",
    "거절된 요청은 아무것도 바꾸지 않는다",
  );
  assert.equal(
    (
      await call(owner, `/api/approvals/${approval.id}/decide`, {
        decision: "reject",
        reasonKind: "mood",
      })
    ).status,
    422,
  );

  const rejected = await call(owner, `/api/approvals/${approval.id}/decide`, {
    decision: "reject",
    reasonKind: "tone",
    reason: "톤이 세다",
  });
  assert.equal(rejected.status, 200);
  const body = await json<Approval>(rejected);
  assert.equal(body.status, "rejected");
  assert.equal(body.reasonKind, "tone");
  assert.equal((await approvals.get(owner, approval.id)).reasonKind, "tone");
  const log = (await db.list<AuditLog>(owner, "audit")).find(
    (entry) => entry.approvalId === approval.id && entry.action.startsWith("approval.reject"),
  );
  assert.equal(log?.reasonKind, "tone");
  assert.equal(log?.roomId, room.id);

  const again = await call(owner, `/api/approvals/${approval.id}/decide`, { decision: "approve" });
  assert.equal(again.status, 409);
  assert.equal((await json<{ status: string }>(again)).status, "rejected");
});

test("GET /inbox: room_id·kind 필터 · kind·roomCharacter · 한 팀이 실패해도 나머지는 주고 failed 로 알린다", async () => {
  const owner = "inbox-user";
  const [roomA, roomB] = await Promise.all([teamRoom(owner, "A 팀"), teamRoom(owner, "B 팀")]);
  const publish = await requestApproval(owner, roomA.id, "발행 건");
  const consult = await requestApproval(owner, roomA.id, "상담 건", "consult");
  const other = await requestApproval(owner, roomB.id, "B 발행 건");
  type Inbox = {
    pending: (Approval & { roomTitle: string; roomCharacter: string })[];
    activities: { roomId?: string }[];
    failed: { roomId: string; roomTitle: string; error: string }[];
  };

  const all = await json<Inbox>(call(owner, "/api/inbox"));
  assert.deepEqual(all.pending.map((a) => a.id).sort(), [publish.id, consult.id, other.id].sort());
  assert.deepEqual(all.failed, []);
  const first = all.pending.find((a) => a.id === publish.id);
  assert.equal(first?.kind, "publish", "종류를 밝히지 않은 승인은 발행 승인");
  assert.equal(first?.roomCharacter, "lawyer-cat");
  assert.equal(first?.roomTitle, "A 팀");
  assert.ok(all.pending.every((a) => !("tokenHash" in a)));

  const onlyA = await json<Inbox>(call(owner, `/api/inbox?room_id=${roomA.id}`));
  assert.deepEqual(onlyA.pending.map((a) => a.id).sort(), [publish.id, consult.id].sort());
  assert.ok(onlyA.activities.length > 0 && onlyA.activities.every((a) => a.roomId === roomA.id));
  const consults = await json<Inbox>(call(owner, "/api/inbox?kind=consult"));
  assert.deepEqual(
    consults.pending.map((a) => a.id),
    [consult.id],
  );
  assert.equal((await call(owner, "/api/inbox?kind=nope")).status, 422);
  assert.equal((await call(owner, "/api/inbox?room_id=missing")).status, 404);

  // B 팀 조회만 실패시킨다
  const flaky = Object.create(approvals) as Approvals;
  flaky.pendingForRoom = async (o: string, roomId: string) => {
    if (roomId === roomB.id) throw new Error("B 팀 저장소 응답 없음");
    return approvals.pendingForRoom(o, roomId);
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => void errors.push(String(line));
  let partial: Inbox;
  try {
    partial = await json<Inbox>(
      call(owner, "/api/inbox", undefined, mount({ db, rooms, approvals: flaky, bus })),
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(partial.pending.map((a) => a.id).sort(), [publish.id, consult.id].sort());
  assert.deepEqual(partial.failed, [
    { roomId: roomB.id, roomTitle: "B 팀", error: "B 팀 저장소 응답 없음" },
  ]);
  assert.ok(
    errors.some((line) => line.includes(roomB.id)),
    "실패는 로그에도 남는다",
  );
});

test("POST /goals → proposed · activate → 분해기가 불리고 active · 그 밖의 상태는 409 · 분해 실패는 방에 남고 되돌린다", async () => {
  const owner = "goal-user";
  const room = await teamRoom(owner, "목표 방");
  const created = await call(owner, "/api/goals", {
    roomId: room.id,
    title: "상속 분야 AI 검색 선점",
  });
  assert.equal(created.status, 200);
  const goal = await json<TeamGoal>(created);
  assert.equal(goal.status, "proposed");
  assert.equal(goal.level, "long");
  assert.equal((await call(owner, "/api/goals", { roomId: "missing", title: "x" })).status, 404);
  assert.equal((await call(owner, "/api/goals", { roomId: room.id, title: " " })).status, 422);

  // ① 분해할 수 없으면 이유와 함께 거절하고 목표는 시작되지 않는다
  decomposer = async () => {
    throw new AppError("목표를 나눌 수 없습니다: 모델 계정이 없습니다", 503);
  };
  const refused = await call(owner, `/api/goals/${goal.id}/activate`, {});
  assert.equal(refused.status, 503);
  assert.match((await json<{ error: string }>(refused)).error, /모델 계정이 없습니다/);
  assert.equal((await rooms.goal(owner, goal.id)).status, "proposed");

  // ② 분해 도중 실패 → 방에 이유를 남기고 시작 전 상태로 되돌린다
  decomposer = async () => async () => {
    throw new Error("팀장 모델이 응답하지 않습니다");
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => void errors.push(String(line));
  try {
    assert.equal((await call(owner, `/api/goals/${goal.id}/activate`, {})).status, 200);
    // 실패 처리의 마지막 단계(오류 활동)까지 기다린다
    await until(
      async () => (await rooms.feed(owner, room.id)).some((a) => a.kind === "error"),
      "분해 실패 기록",
    );
  } finally {
    console.error = original;
  }
  assert.ok(
    (await rooms.timeline(owner, room.id)).some((m) =>
      m.text?.includes("목표를 나누지 못했습니다"),
    ),
    "방에 실패 이유를 남긴다",
  );
  assert.equal((await rooms.goal(owner, goal.id)).status, "proposed", "다시 시작할 수 있다");
  assert.ok(errors.some((line) => line.includes("팀장 모델이 응답하지 않습니다")));
  const feed = await json<{ kind: string; label: string; detail?: string }[]>(
    call(owner, `/api/rooms/${room.id}/feed`),
  );
  const failure = feed.find((a) => a.kind === "error");
  assert.equal(failure?.label, "오류");
  assert.equal(failure?.detail, "팀장 모델이 응답하지 않습니다");

  // ③ 성공: 분해기가 그 목표로 불리고 목표가 active 가 된다
  const decomposed: string[] = [];
  decomposer = async ({ goal: target, room: targetRoom, owner: targetOwner }) => {
    assert.equal(targetRoom.id, room.id);
    assert.equal(targetOwner, owner);
    return async () => void decomposed.push(target.id);
  };
  const activated = await call(owner, `/api/goals/${goal.id}/activate`, {});
  assert.equal(activated.status, 200);
  assert.equal((await json<TeamGoal>(activated)).status, "active");
  await until(async () => decomposed.length === 1, "분해기 호출");
  assert.deepEqual(decomposed, [goal.id]);

  // ④ 이미 시작한 목표는 409, 분해기는 다시 불리지 않는다
  const twice = await call(owner, `/api/goals/${goal.id}/activate`, {});
  assert.equal(twice.status, 409);
  assert.match((await json<{ error: string }>(twice)).error, /active/);
  assert.equal(decomposed.length, 1);
  assert.equal((await call(owner, "/api/goals/missing/activate", {})).status, 404);
  assert.equal((await call("someone-else", `/api/goals/${goal.id}/activate`, {})).status, 404);
});

test("기본 분해기(teamDecomposer): 팀장이 사용자의 장기 목표 아래로 나눠 등록한다 · 팀·모델이 없으면 이유를 밝힌다", async () => {
  const owner = "decompose-user";
  const room = await teamRoom(owner, "분해 방");
  const llmCalls: string[] = [];
  const deps = { db, rooms, approvals, bus, catalog };
  const withTeam = mount({
    ...deps,
    decomposer: teamDecomposer(deps, () => async (role, tier) => {
      llmCalls.push(`${role}:${tier}`);
      return JSON.stringify({
        long: "모델이 고쳐 쓴 장기 목표",
        mid: ["10월 상속 콘텐츠 4건"],
        short: [{ title: "유류분 반환청구 기한 글", tasks: ["판례 조사", "초안"] }],
      });
    }),
  });
  const goal = await json<TeamGoal>(
    call(owner, "/api/goals", { roomId: room.id, title: "상속 분야 AI 검색 선점" }, withTeam),
  );
  assert.equal((await call(owner, `/api/goals/${goal.id}/activate`, {}, withTeam)).status, 200);
  await until(
    async () => (await rooms.goals(owner, room.id)).filter((g) => g.level === "task").length === 2,
    "분해된 목표 트리",
  );
  const tree = await rooms.goals(owner, room.id);
  assert.deepEqual(tree.map((g) => g.level).sort(), ["long", "mid", "short", "task", "task"]);
  const long = tree.filter((g) => g.level === "long");
  assert.equal(long.length, 1, "장기 목표를 새로 만들지 않는다");
  assert.equal(long[0]?.id, goal.id);
  assert.equal(long[0]?.title, "상속 분야 AI 검색 선점");
  assert.equal(long[0]?.status, "active");
  assert.equal(tree.find((g) => g.level === "mid")?.parentId, goal.id);
  const short = tree.find((g) => g.level === "short");
  assert.equal(short?.status, "active", "팀 워커의 tick 이 집어 실행할 단기 목표");
  assert.equal(llmCalls[0], "root:4");
  // 분해에 쓴 워커 토큰은 남기지 않는다
  await until(
    async () =>
      (await db.list<{ roomId: string }>("system", "worker-tokens")).every(
        (t) => t.roomId !== room.id,
      ),
    "워커 토큰 정리",
  );

  // 개인 방에는 팀이 없다 → 422, 목표는 그대로 proposed
  const personal = await rooms.ensurePersonalRoom(owner);
  const lone = await json<TeamGoal>(
    call(owner, "/api/goals", { roomId: personal.id, title: "혼자 세운 목표" }, withTeam),
  );
  const noTeam = await call(owner, `/api/goals/${lone.id}/activate`, {}, withTeam);
  assert.equal(noTeam.status, 422);
  assert.match((await json<{ error: string }>(noTeam)).error, /팀/);
  assert.equal((await rooms.goal(owner, lone.id)).status, "proposed");

  // 모델 설정이 없다 → 503 + 이유
  const noModel = mount({
    ...deps,
    decomposer: teamDecomposer(deps, () => {
      throw new Error("OPENAI_BASE_URL / OPENAI_API_KEY 가 없습니다");
    }),
  });
  const second = await json<TeamGoal>(
    call(owner, "/api/goals", { roomId: room.id, title: "두 번째 목표" }, noModel),
  );
  const refused = await call(owner, `/api/goals/${second.id}/activate`, {}, noModel);
  assert.equal(refused.status, 503);
  assert.match((await json<{ error: string }>(refused)).error, /OPENAI_BASE_URL/);
  assert.equal((await rooms.goal(owner, second.id)).status, "proposed");

  // 분해기 자체가 연결되지 않은 서버 → 503 (조용히 active 로만 바꾸지 않는다)
  const bare = mount({ db, rooms, approvals, bus });
  const unwired = await call(owner, `/api/goals/${second.id}/activate`, {}, bare);
  assert.equal(unwired.status, 503);
  assert.equal((await rooms.goal(owner, second.id)).status, "proposed");
});

test("제안: 워커가 올리고 → 목록·방 아이디어 → 수락하면 다음 중기 목표 + 방 공지 · 다시 결정은 409", async () => {
  const owner = "proposal-user";
  const room = await teamRoom(owner, "제안 방");
  const long = await rooms.createGoal(owner, { roomId: room.id, title: "장기", level: "long" });
  await rooms.createGoal(owner, {
    roomId: room.id,
    title: "기존 중기",
    level: "mid",
    parentId: long.id,
  });
  const { token } = await json<{ token: string }>(
    call(owner, `/api/rooms/${room.id}/worker-token`, {}),
  );
  const propose = (title: string) =>
    json<GoalProposal>(
      call(token, "/api/worker/goals/proposals", {
        title,
        detail: `${title} 근거`,
        actor: "analyst",
      }),
    );
  const first = await propose("전세사기 주제 추가");
  const second = await propose("양육비 주제 추가");
  assert.equal(first.status, "pending");
  assert.equal(first.roomId, room.id);
  assert.equal(first.proposedBy, "analyst");
  assert.equal(
    (await call(token, "/api/worker/goals/proposals", { title: "근거 없음" })).status,
    422,
  );

  const listed = await json<GoalProposal[]>(call(owner, `/api/goals/proposals?room_id=${room.id}`));
  assert.deepEqual(listed.map((p) => p.id).sort(), [first.id, second.id].sort());
  const ideas = await json<GoalProposal[]>(call(owner, `/api/rooms/${room.id}/ideas`));
  assert.deepEqual(
    ideas.map((p) => p.id),
    listed.map((p) => p.id),
  );
  assert.deepEqual(await json<GoalProposal[]>(call("someone-else", "/api/goals/proposals")), []);

  const accepted = await call(owner, `/api/goals/proposals/${first.id}/decide`, {
    decision: "accept",
  });
  assert.equal(accepted.status, 200);
  assert.equal((await json<GoalProposal>(accepted)).status, "accepted");
  const mids = (await rooms.goals(owner, room.id)).filter((g) => g.level === "mid");
  assert.deepEqual(
    mids.map((g) => [g.title, g.parentId, g.order]),
    [
      ["기존 중기", long.id, 0],
      ["전세사기 주제 추가", long.id, 1],
    ],
  );
  const notice = (await rooms.timeline(owner, room.id)).find((m) => m.role === "system");
  assert.match(notice?.text ?? "", /전세사기 주제 추가/);

  const again = await call(owner, `/api/goals/proposals/${first.id}/decide`, { decision: "hold" });
  assert.equal(again.status, 409);
  assert.match((await json<{ error: string }>(again)).error, /accepted/);
  const held = await json<GoalProposal>(
    call(owner, `/api/goals/proposals/${second.id}/decide`, { decision: "hold" }),
  );
  assert.equal(held.status, "held");
  assert.equal((await rooms.goals(owner, room.id)).filter((g) => g.level === "mid").length, 2);
  assert.equal(
    (await call("someone-else", `/api/goals/proposals/${second.id}/decide`, { decision: "accept" }))
      .status,
    404,
  );
  assert.equal(
    (await call(owner, `/api/goals/proposals/${second.id}/decide`, { decision: "maybe" })).status,
    422,
  );
});

test("GET /stream (사용자 단위): 방이 바뀌면 rooms {roomId}, 결재함이 바뀌면 inbox · 끊기면 구독을 정리한다", async () => {
  const owner = "stream-owner";
  const room = await teamRoom(owner, "스트림 방");
  const before = bus.listenerCount(owner);
  const abort = new AbortController();
  const response = await app.request("/api/stream", {
    headers: { Authorization: `Bearer ${owner}` },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (pattern: RegExp) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) assert.fail(`스트림이 먼저 끝났습니다: ${text}`);
      text += decoder.decode(value);
    }
  };
  await readUntil(/event: ping\n/);
  await until(async () => bus.listenerCount(owner) === before + 1, "스트림 구독");

  // 다른 사용자의 변화는 오지 않는다
  const strangerRoom = await teamRoom("stream-stranger", "남의 방");
  await requestApproval("stream-stranger", strangerRoom.id, "남의 글");
  // 배지가 바뀐다(승인 요청) → rooms + inbox
  await requestApproval(owner, room.id, "스트림 글");
  await readUntil(/event: inbox\ndata: .*\n/);
  const roomEvents = [...text.matchAll(/event: rooms\ndata: (.*)\n/g)].map(
    (m) => JSON.parse(m[1] as string) as { roomId: string },
  );
  assert.ok(roomEvents.length >= 1, "방 변화 이벤트가 왔다");
  assert.ok(roomEvents.every((event) => event.roomId === room.id));
  // 승인 요청 1건이 방 이벤트 4개(message·board·room.presence·approval)를 내지만, 몰려온 것은 방마다 하나로 묶인다
  assert.ok(roomEvents.length < 4, `묶이지 않았습니다: ${roomEvents.length}건`);
  assert.ok(!text.includes(strangerRoom.id));

  // 알림 끔도 목록을 바꾼다
  text = "";
  await call(owner, `/api/rooms/${room.id}/mute`, { muted: true });
  await readUntil(/event: rooms\ndata: .*\n/);
  assert.deepEqual(JSON.parse(text.match(/event: rooms\ndata: (.*)\n/)?.[1] as string), {
    roomId: room.id,
  });

  await reader.cancel();
  abort.abort();
  await until(async () => bus.listenerCount(owner) === before, "끊긴 뒤 구독 해제");
});

test("현황판·요약·타임라인: character · recentDone · agents.role/current · answers · 방 파일 · 지표는 측정 전 null", async () => {
  const owner = "board-user";
  const room = await teamRoom(owner, "현황 방");
  const long = await rooms.createGoal(owner, { roomId: room.id, title: "장기", level: "long" });
  const short = await rooms.createGoal(owner, {
    roomId: room.id,
    title: "끝낸 글",
    level: "short",
    parentId: long.id,
  });
  await rooms.createGoal(owner, {
    roomId: room.id,
    title: "발행 준비",
    level: "task",
    parentId: short.id,
    assignee: "publisher",
  });

  // 아직 아무 지표도 보고되지 않았다 → 전부 null (0 이 아니다)
  const empty = await json<{
    period: string;
    measuredAt: string | null;
    metrics: Record<string, number | null>;
  }>(call(owner, `/api/goals/${long.id}/metrics?period=week`));
  assert.deepEqual(empty, {
    period: "week",
    measuredAt: null,
    metrics: { published: null, indexed: null, ai_citations: null, conversions: null },
  });
  assert.equal((await call(owner, `/api/goals/${long.id}/metrics?period=year`)).status, 422);
  assert.equal((await call(owner, `/api/goals/${long.id}/metrics`)).status, 422);

  const approval = await requestApproval(owner, room.id, "끝낸 글 발행");
  const waiting = await json<RoomBoard>(call(owner, `/api/rooms/${room.id}/board`));
  assert.deepEqual(waiting.character, {
    assetId: "lawyer-cat",
    state: "awaiting_approval",
    summary: "승인 1건을 기다리고 있습니다",
  });
  assert.deepEqual(
    waiting.agents.find((a) => a.actor === "publisher"),
    { actor: "publisher", done: 1, errors: 0, role: "승인된 글을 발행한다", current: "발행 준비" },
  );
  assert.deepEqual(waiting.recentDone, []);

  await call(owner, `/api/approvals/${approval.id}/decide`, { decision: "approve" });
  await rooms.updateGoal(
    owner,
    short.id,
    { progress: 100, metrics: { published: 1 } },
    "publisher",
  );
  const done = await json<RoomBoard>(call(owner, `/api/rooms/${room.id}/board`));
  assert.deepEqual(done.recentDone, ["끝낸 글"]);
  assert.notEqual(done.character.state, "awaiting_approval");
  const summary = await json<{ recentDone: string[]; doneToday: number }>(
    call(owner, `/api/rooms/${room.id}/summary`),
  );
  assert.deepEqual(summary.recentDone, done.recentDone);

  // 보고된 지표만 숫자, 나머지는 여전히 null
  const measured = await json<{
    measuredAt: string | null;
    metrics: Record<string, number | null>;
  }>(call(owner, `/api/goals/${long.id}/metrics?period=month`));
  assert.deepEqual(measured.metrics, {
    published: 1,
    indexed: null,
    ai_citations: null,
    conversions: null,
  });
  assert.ok(measured.measuredAt);

  // 타임라인 answers: 사용량 장부의 답변 출처 + 라벨
  usage.set(room.id, [
    {
      runId: "run-1",
      messageIds: ["m-device"],
      createdAt: "2026-10-10T00:00:00.000Z",
      answered_by: { tier: 1, model: "gemma-device", source: "device", reason: "짧은 질문" },
    },
    {
      runId: "run-2",
      messageIds: ["m-server"],
      createdAt: "2026-10-10T00:01:00.000Z",
      answered_by: { tier: 3, model: "main-model", source: "server", reason: "" },
    },
  ]);
  const { token } = await json<{ token: string }>(
    call(owner, `/api/rooms/${room.id}/worker-token`, {}),
  );
  await call(token, "/api/worker/messages", {
    text: "팀장 답변",
    answeredBy: { tier: 4, model: "top-model", source: "server" },
  });
  const timeline = await json<{
    answers: Record<string, unknown>;
    messages: RoomMessage[];
    board: RoomBoard;
  }>(call(owner, `/api/rooms/${room.id}/timeline`));
  assert.deepEqual(timeline.answers, {
    "m-device": {
      tier: 1,
      label: "기기에서 답함",
      model: "gemma-device",
      source: "device",
      reason: "짧은 질문",
    },
    "m-server": { tier: 3, label: "서버 주력 모델이 답함", model: "main-model", source: "server" },
  });
  assert.deepEqual(timeline.messages.find((m) => m.text === "팀장 답변")?.payload?.answeredBy, {
    tier: 4,
    label: "서버 최고 모델이 답함",
    model: "top-model",
    source: "server",
  });
  assert.ok(timeline.board.character);

  // 방 파일: 승인본 + 그 방의 감사 문서만
  const otherRoom = await teamRoom(owner, "다른 방");
  const otherApproval = await requestApproval(owner, otherRoom.id, "다른 방 글");
  const files = await json<{
    approved: { approvalId: string; title: string; summary: string; decidedAt: string }[];
    audit: { id: string; ts: string; action: string; actor: string; approvalId?: string }[];
  }>(call(owner, `/api/rooms/${room.id}/files`));
  assert.deepEqual(
    files.approved.map((a) => [a.approvalId, a.title, a.summary]),
    [[approval.id, "끝낸 글 발행", "끝낸 글 발행 요약"]],
  );
  assert.ok(files.approved[0]?.decidedAt);
  assert.ok(files.audit.some((log) => log.action === "approval.approve:site:publish"));
  assert.ok(files.audit.every((log) => log.approvalId !== otherApproval.id));
  assert.equal((await call("someone-else", `/api/rooms/${room.id}/files`)).status, 404);
  assert.equal((await call("someone-else", `/api/rooms/${room.id}/feed`)).status, 404);
});
