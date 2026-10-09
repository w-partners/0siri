import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { roomRoutes, workerRoutes } from "../apps/server/src/osiri/room-routes.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";

let db: Store, directory: string, app: Hono, rooms: Rooms, bus: EventBus;
const OWNER = "user-a";
const call = (path: string, body?: unknown, token = OWNER, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-rooms-"));
  db = await createStore({ dataDir: join(directory, "db") });
  bus = new EventBus();
  rooms = new Rooms(db, bus);
  const approvals = new Approvals(db, rooms, bus);
  const deps = { db, rooms, approvals, bus };
  app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api/worker", workerRoutes(deps));
  // 테스트용 인증: Bearer 값이 곧 소유자
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) throw new AppError("로그인이 필요합니다", 401);
    c.set("owner", header.slice(7));
    await next();
  });
  app.route("/api", roomRoutes(deps));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("승인 카드 → 배지 → 승인 → 현황판/결재함 갱신 → 토큰 1회 집행, 입력 변경·무토큰 차단", async () => {
  // 개인 방은 첫 조회에 자동 생성
  const list = (await (await call("/api/rooms")).json()) as { id: string; title: string; pendingApprovals: number }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.title, "영시리");
  const roomId = list[0]?.id as string;
  const { token: workerToken } = (await (await call(`/api/rooms/${roomId}/worker-token`, {})).json()) as { token: string };

  // 워커 토큰 없이는 워커 API 거절
  assert.equal((await app.request("/api/worker/goals")).status, 401);

  const events: string[] = [];
  const stop = bus.subscribe(OWNER, (event) => events.push(event.type));

  const input = { url: "https://example.com/post", title: "블로그 초안" };
  const requested = await call(
    "/api/worker/approvals/request",
    { toolName: "blog.publish", input, title: "블로그 발행", summary: "초안 발행 승인 요청", actor: "writer" },
    workerToken,
  );
  assert.equal(requested.status, 200);
  const { id: approvalId, inputHash } = (await requested.json()) as { id: string; inputHash: string };
  // 같은 도구·입력 재요청은 같은 승인으로 합쳐진다
  const again = (await (
    await call("/api/worker/approvals/request", { toolName: "blog.publish", input, title: "블로그 발행", summary: "x", actor: "writer" }, workerToken)
  ).json()) as { id: string };
  assert.equal(again.id, approvalId);

  // 방 목록 배지 + 타임라인 카드 + 결재함
  const badge = (await (await call("/api/rooms")).json()) as { pendingApprovals: number; presence: string }[];
  assert.equal(badge[0]?.pendingApprovals, 1);
  assert.equal(badge[0]?.presence, "waiting");
  const timeline = (await (await call(`/api/rooms/${roomId}/timeline`)).json()) as {
    messages: { kind: string; payload?: { card?: string; status?: string } }[];
  };
  const card = timeline.messages.find((m) => m.kind === "card");
  assert.equal(card?.payload?.card, "approval");
  assert.equal(card?.payload?.status, "pending");
  const inbox = (await (await call("/api/inbox")).json()) as { pending: { id: string; roomTitle: string; tokenHash?: string }[] };
  assert.equal(inbox.pending[0]?.id, approvalId);
  assert.equal(inbox.pending[0]?.roomTitle, "영시리");

  // 승인 전 집행은 차단 (토큰이 없다)
  const early = await call(`/api/worker/approvals/${approvalId}/consume`, { token: "guess", toolName: "blog.publish", input }, workerToken);
  assert.equal(early.status, 403);
  // 다른 사용자는 남의 승인을 결재할 수 없다
  assert.equal((await call(`/api/approvals/${approvalId}/decide`, { decision: "approve" }, "user-b")).status, 404);
  // 동결 해시가 다르면 409
  assert.equal((await call(`/api/approvals/${approvalId}/decide`, { decision: "approve", frozenHash: "stale" })).status, 409);

  const decided = await call(`/api/approvals/${approvalId}/decide`, { decision: "approve", frozenHash: inputHash });
  assert.equal(decided.status, 200);
  const decidedBody = (await decided.json()) as { status: string; token?: string; tokenHash?: string };
  assert.equal(decidedBody.status, "approved");
  assert.equal(decidedBody.token, undefined, "사용자 응답에 토큰이 새면 안 된다");
  assert.equal(decidedBody.tokenHash, undefined);

  // 현황판·결재함·카드 갱신
  const board = (await (await call(`/api/rooms/${roomId}/board`)).json()) as { pendingApprovals: number; presence: string };
  assert.equal(board.pendingApprovals, 0);
  assert.notEqual(board.presence, "waiting");
  assert.equal(((await (await call("/api/inbox")).json()) as { pending: unknown[] }).pending.length, 0);
  const after = (await (await call(`/api/rooms/${roomId}/timeline`)).json()) as { messages: { kind: string; payload?: { status?: string } }[] };
  assert.equal(after.messages.find((m) => m.kind === "card")?.payload?.status, "approved");
  assert.ok(events.includes("approval") && events.includes("board") && events.includes("inbox"));
  stop();

  // 토큰은 워커 폴링이 아닌 decide 내부에서만 생성된다 → 저장소의 해시로는 역산 불가. 여기선 승인 레코드를 직접 읽어 토큰 미보관을 확인
  const stored = (await db.get<{ tokenHash: string; token?: string }>(OWNER, "approvals", approvalId)) as { tokenHash: string; token?: string };
  assert.ok(stored.tokenHash);
  assert.equal(stored.token, undefined);

  // 집행 — 올바른 토큰은 테스트에서 approvals.decide 를 직접 불러야 얻을 수 있으므로 새 승인으로 검증
  const requested2 = (await (
    await call("/api/worker/approvals/request", { toolName: "mail.send", input: { to: "a@b.c" }, title: "메일 발송", summary: "s", actor: "writer" }, workerToken)
  ).json()) as { id: string; inputHash: string };
  const approvals = new Approvals(db, rooms, bus);
  const withToken = (await approvals.decide(OWNER, requested2.id, "approve", { decidedBy: OWNER })) as { token?: string };
  assert.ok(withToken.token);
  // 입력이 바뀌면 403
  const changed = await call(`/api/worker/approvals/${requested2.id}/consume`, { token: withToken.token, toolName: "mail.send", input: { to: "x@y.z" } }, workerToken);
  assert.equal(changed.status, 403);
  // 도구명이 바뀌어도 403
  const otherTool = await call(`/api/worker/approvals/${requested2.id}/consume`, { token: withToken.token, toolName: "mail.delete", input: { to: "a@b.c" } }, workerToken);
  assert.equal(otherTool.status, 403);
  // 정확히 일치하면 1회 통과
  const ok = await call(`/api/worker/approvals/${requested2.id}/consume`, { token: withToken.token, toolName: "mail.send", input: { to: "a@b.c" } }, workerToken);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { status: string }).status, "consumed");
  // 재사용은 403
  const reuse = await call(`/api/worker/approvals/${requested2.id}/consume`, { token: withToken.token, toolName: "mail.send", input: { to: "a@b.c" } }, workerToken);
  assert.equal(reuse.status, 403);
  // 감사 로그에 blocked 와 ok 가 남는다
  const audit = (await (await call("/api/audit")).json()) as { action: string; result: string }[];
  assert.ok(audit.some((a) => a.action === "approval.consume:mail.send" && a.result === "blocked"));
  assert.ok(audit.some((a) => a.action === "approval.consume:mail.send" && a.result === "ok"));
  // 외부 행위 감사 로그는 approval_id 필수
  assert.equal((await call("/api/worker/audit", { actor: "writer", action: "post", result: "ok", external: true }, workerToken)).status, 422);
});

test("목표 트리 — 생성·진척 롤업·순서 변경·현황판 진척, 주간 보고 카드", async () => {
  const roomId = ((await (await call("/api/rooms")).json()) as { id: string }[])[0]?.id as string;
  const { token } = (await (await call(`/api/rooms/${roomId}/worker-token`, {})).json()) as { token: string };
  const w = (path: string, body?: unknown) => call(`/api/worker${path}`, body, token);
  const long = (await (await w("/goals", { title: "AI 검색 노출", level: "long" })).json()) as { id: string };
  const mid = (await (await w("/goals", { title: "이달 10건 발행", level: "mid", parentId: long.id })).json()) as { id: string };
  const s1 = (await (await w("/goals", { title: "이슈 1 초안", level: "short", parentId: mid.id })).json()) as { id: string };
  const s2 = (await (await w("/goals", { title: "이슈 2 초안", level: "short", parentId: mid.id })).json()) as { id: string };
  await w(`/goals/${s1.id}/progress`, { progress: 100, status: "completed", stage: "done" });
  await w(`/goals/${s2.id}/progress`, { progress: 50, stage: "draft" });
  const goals = (await (await call(`/api/goals?room_id=${roomId}`)).json()) as { id: string; progress: number }[];
  assert.equal(goals.find((g) => g.id === mid.id)?.progress, 75);
  assert.equal(goals.find((g) => g.id === long.id)?.progress, 75);
  const reordered = await call(`/api/goals/${s2.id}/order`, { order: 0 }, OWNER, "PATCH");
  assert.equal(reordered.status, 200);
  const summary = (await (await call(`/api/rooms/${roomId}/summary`)).json()) as { doneToday: number; progress: Record<string, number> };
  assert.equal(summary.doneToday, 1);
  const report = await w("/reports/weekly", {
    summary: "이번 주 2건 진행",
    metrics: { completed_tasks: 1, pending_approvals: 0, next_week_plan: ["이슈 3 초안"] },
  });
  assert.equal(report.status, 200);
  const badReport = await w("/reports/weekly", { summary: "x", metrics: { completed_tasks: 1 } });
  assert.ok(badReport.status >= 400, "지표 3종이 빠진 주간 보고는 거절된다");
  const timeline = (await (await call(`/api/rooms/${roomId}/timeline`)).json()) as { messages: { kind: string; payload?: { card?: string } }[] };
  assert.ok(timeline.messages.some((m) => m.kind === "report" && m.payload?.card === "weekly-report"));
});
