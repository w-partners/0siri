// 0Siri 방·결재함·목표·승인·실시간 스트림·워커 API 라우트 (0SIRI-SPEC §21).
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Approvals } from "./approvals.ts";
import type { EventBus, PresenceState } from "./events.ts";
import type { Mcp } from "./mcp.ts";
import type { Rooms, TaskStage } from "./rooms.ts";

type Env = { Variables: { owner: string } };
export interface RoomDeps {
  db: Store;
  rooms: Rooms;
  approvals: Approvals;
  bus: EventBus;
  mcp?: Mcp;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stageSchema = z.enum(["detect", "draft", "geo", "review", "approval", "publish", "done"]);
const levelSchema = z.enum(["long", "mid", "short", "task"]);
const presenceLabel: Record<PresenceState, string> = {
  working: "작업 중",
  waiting: "승인 대기 중",
  done: "완료",
  idle: "휴식 중",
};

/** 사용자(소유자 토큰) 라우트 — /api 아래, 인증 미들웨어 뒤에 마운트. */
export function roomRoutes({ db, rooms, approvals, bus }: RoomDeps) {
  const app = new Hono<Env>();

  // S2 방 목록 (+배지 집계)
  app.get("/rooms", async (c) => {
    await rooms.ensurePersonalRoom(c.get("owner"));
    return c.json(await rooms.list(c.get("owner")));
  });
  app.post("/rooms/:id/pin", async (c) => {
    const body = z.object({ pinned: z.boolean() }).parse(await c.req.json());
    return c.json(await rooms.patch(c.get("owner"), c.req.param("id"), body));
  });
  // S3 타임라인 — 진입 시 부재 중 요약 카드를 맨 위에 (§4.3)
  app.get("/rooms/:id/timeline", async (c) => {
    const owner = c.get("owner");
    const roomId = c.req.param("id");
    const after = c.req.query("after") ? Number(c.req.query("after")) : undefined;
    const room = await rooms.get(owner, roomId);
    const digest = after === undefined ? await rooms.digestSince(owner, roomId) : null;
    const messages = await rooms.timeline(owner, roomId, after);
    if (after === undefined)
      await rooms.patch(owner, roomId, { lastSeenAt: new Date().toISOString() });
    return c.json({ room, digest, messages, board: await rooms.board(owner, roomId) });
  });
  app.post("/rooms/:id/messages", async (c) => {
    const body = z
      .object({
        text: z.string().min(1).max(4000),
        kind: z.enum(["text", "report"]).default("text"),
      })
      .parse(await c.req.json());
    return c.json(
      await rooms.post(c.get("owner"), c.req.param("id"), {
        role: "user",
        kind: body.kind,
        text: body.text,
      }),
    );
  });
  app.get("/rooms/:id/board", async (c) =>
    c.json(await rooms.board(c.get("owner"), c.req.param("id"))),
  );
  // 캐릭터 탭 → 팀 상태 요약 시트 (§5)
  app.get("/rooms/:id/summary", async (c) => {
    const owner = c.get("owner");
    const roomId = c.req.param("id");
    const [board, pending, goals] = await Promise.all([
      rooms.board(owner, roomId),
      approvals.pending(owner),
      rooms.goals(owner, roomId),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const doneToday = goals.filter(
      (g) => g.status === "completed" && g.updatedAt.startsWith(today),
    ).length;
    return c.json({
      presence: board.presence,
      label: presenceLabel[board.presence as PresenceState] ?? board.presence,
      flow: board.flow,
      pendingApprovals: pending
        .filter((a) => a.roomId === roomId)
        .map((a) => ({ id: a.id, title: a.title })),
      doneToday,
      progress: board.progress,
      nextReportAt: board.nextReportAt ?? null,
    });
  });
  // S3 실시간 스트림 (SSE). 이벤트: presence · approval · board · message · goal
  app.get("/rooms/:id/stream", async (c) => {
    const owner = c.get("owner");
    const roomId = c.req.param("id");
    await rooms.get(owner, roomId);
    return streamSSE(c, async (stream) => {
      let id = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data), id: String(++id) });
      await send("board", await rooms.board(owner, roomId));
      const state = bus.getPresence(owner, roomId);
      await send("room.presence", { roomId, state, label: presenceLabel[state] });
      let open = true;
      const unsubscribe = bus.subscribe(owner, (event) => {
        if (!open) return;
        if ("roomId" in event && event.roomId !== roomId) return;
        void (async () => {
          if (event.type === "board") await send("board", await rooms.board(owner, roomId));
          else if (event.type === "approval") {
            await send("approval", event);
            await send("board", await rooms.board(owner, roomId));
          } else await send(event.type, event);
        })();
      });
      const heartbeat = setInterval(
        () => void stream.writeSSE({ event: "ping", data: "" }),
        25_000,
      );
      stream.onAbort(() => {
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
      });
      // 연결이 끊길 때까지 유지
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });

  // S3/S4 승인·반려
  app.post("/approvals/:id/decide", async (c) => {
    const body = z
      .object({
        decision: z.enum(["approve", "reject"]),
        reason: z.string().max(1000).optional(),
        frozenHash: z.string().optional(),
      })
      .parse(await c.req.json());
    const result = await approvals.decide(c.get("owner"), c.req.param("id"), body.decision, {
      reason: body.reason,
      decidedBy: c.get("owner"),
      frozenHash: body.frozenHash,
    });
    const {
      token: _token,
      tokenHash: _hash,
      ...safe
    } = result as typeof result & { token?: string };
    return c.json(safe);
  });
  // S4 결재함 — 전 팀 승인 대기 + 활동 (§10 ③층)
  app.get("/inbox", async (c) => {
    const owner = c.get("owner");
    const [pending, activities, roomList] = await Promise.all([
      approvals.pending(owner),
      rooms.activities(owner),
      db.list<{ id: string; title: string }>(owner, "rooms"),
    ]);
    const titles = new Map(roomList.map((r) => [r.id, r.title]));
    return c.json({
      pending: pending.map(({ tokenHash: _t, ...a }) => ({
        ...a,
        roomTitle: titles.get(a.roomId) ?? "",
      })),
      activities: activities.map((a) => ({
        ...a,
        roomTitle: a.roomId ? (titles.get(a.roomId) ?? "") : "",
      })),
    });
  });
  // S5 목표 (조회·순서 전용; 생성은 대화/워커)
  app.get("/goals", async (c) => {
    const roomId = c.req.query("room_id");
    if (!roomId) throw new AppError("room_id 가 필요합니다", 422);
    return c.json(await rooms.goals(c.get("owner"), roomId));
  });
  app.patch("/goals/:id/order", async (c) => {
    const body = z.object({ order: z.number().int().min(0) }).parse(await c.req.json());
    const goal = await rooms.updateGoal(
      c.get("owner"),
      c.req.param("id"),
      { order: body.order },
      "user",
    );
    await rooms.post(c.get("owner"), goal.roomId, {
      role: "system",
      kind: "text",
      text: `단기 목표 순서가 바뀌었습니다: "${goal.title}" → ${body.order + 1}번째`,
    });
    return c.json(goal);
  });
  // 테스트·운영용: 이 방의 워커 토큰 발급 (구독 프로비저닝도 같은 함수를 쓴다)
  app.post("/rooms/:id/worker-token", async (c) => {
    const owner = c.get("owner");
    const room = await rooms.get(owner, c.req.param("id"));
    return c.json({ token: await issueWorkerToken(db, owner, room.id, room.packageId) });
  });
  app.get("/audit", async (c) => c.json(await rooms.auditLogs(c.get("owner"))));
  return app;
}

export async function issueWorkerToken(
  db: Store,
  owner: string,
  roomId: string,
  packageId: string | null,
) {
  const token = randomBytes(32).toString("base64url");
  await db.put("system", "worker-tokens", {
    id: sha(token),
    userId: owner,
    roomId,
    packageId,
    createdAt: new Date().toISOString(),
  });
  return token;
}

/** 워커(도커 컨테이너) 라우트 — 워커 토큰으로 인증. /api/worker 에 마운트, 사용자 인증 미들웨어보다 앞에. */
export function workerRoutes({ db, rooms, approvals, bus, mcp }: RoomDeps) {
  type WorkerEnv = { Variables: { owner: string; roomId: string; packageId: string | null } };
  const app = new Hono<WorkerEnv>();
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) throw new AppError("워커 토큰이 필요합니다", 401);
    const grant = await db.get<{ userId: string; roomId: string; packageId: string | null }>(
      "system",
      "worker-tokens",
      sha(header.slice(7)),
    );
    if (!grant) throw new AppError("워커 토큰이 유효하지 않습니다", 401);
    c.set("owner", grant.userId);
    c.set("roomId", grant.roomId);
    c.set("packageId", grant.packageId);
    await next();
  });
  // external 실행 보류 → 승인 카드
  app.post("/approvals/request", async (c) => {
    const body = z
      .object({
        toolName: z.string().min(1),
        input: z.unknown(),
        title: z.string().min(1).max(200),
        summary: z.string().max(4000),
        evidence: z.string().max(20000).optional(),
        actor: z.string().min(1).max(60),
      })
      .parse(await c.req.json());
    const approval = await approvals.request(c.get("owner"), {
      roomId: c.get("roomId"),
      toolName: body.toolName,
      input: body.input,
      title: body.title,
      summary: body.summary,
      evidence: body.evidence,
      requestedBy: body.actor,
    });
    return c.json({ id: approval.id, status: approval.status, inputHash: approval.inputHash });
  });
  // 워커 폴링: 승인되면 1회용 토큰을 한 번만 돌려준다
  app.get("/approvals/:id", async (c) => {
    const approval = await approvals.get(c.get("owner"), c.req.param("id"));
    if (approval.roomId !== c.get("roomId")) throw new AppError("다른 방의 승인입니다", 403);
    const polled = await approvals.pollForWorker(c.get("owner"), approval.id);
    return c.json({ id: approval.id, reason: approval.reason, ...polled });
  });
  // 워커가 사용자의 MCP 연결 도구를 쓴다 — 위험도 게이트는 Mcp.call 이 건다
  app.get("/tools", async (c) => {
    if (!mcp) throw new AppError("MCP 연결 기능이 꺼져 있습니다", 503);
    const owner = c.get("owner");
    const servers = await mcp.list(owner);
    const tools = await Promise.all(servers.map((s) => mcp.toolsFor(owner, s.id).catch(() => [])));
    return c.json(servers.map((s, i) => ({ id: s.id, name: s.name, tools: tools[i] })));
  });
  app.post("/tools/call", async (c) => {
    if (!mcp) throw new AppError("MCP 연결 기능이 꺼져 있습니다", 503);
    const body = z
      .object({
        serverId: z.string().min(1),
        tool: z.string().min(1),
        args: z.unknown().optional(),
        approval: z.object({ id: z.string(), token: z.string() }).optional(),
        actor: z.string().max(60).default("team"),
      })
      .parse(await c.req.json());
    return c.json(await mcp.call(c.get("owner"), { roomId: c.get("roomId"), ...body }));
  });
  // 승인 토큰 집행 — 서버가 게이트. 토큰·도구·입력이 전부 맞을 때만 1회 통과
  app.post("/approvals/:id/consume", async (c) => {
    const body = z
      .object({ token: z.string().min(1), toolName: z.string().min(1), input: z.unknown() })
      .parse(await c.req.json());
    const consumed = await approvals.consume(c.get("owner"), {
      approvalId: c.req.param("id"),
      ...body,
    });
    return c.json({ id: consumed.id, status: consumed.status });
  });
  // 목표 트리 (팀장이 분해해 보고)
  app.get("/goals", async (c) => c.json(await rooms.goals(c.get("owner"), c.get("roomId"))));
  app.post("/goals", async (c) => {
    const body = z
      .object({
        title: z.string().min(1).max(300),
        level: levelSchema,
        parentId: z.string().nullable().optional(),
        stage: stageSchema.optional(),
        assignee: z.string().max(60).optional(),
        nextActions: z.array(z.string()).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await rooms.createGoal(c.get("owner"), {
        roomId: c.get("roomId"),
        ...body,
        parentId: body.parentId ?? null,
      }),
    );
  });
  app.post("/goals/:id/progress", async (c) => {
    const body = z
      .object({
        progress: z.number().min(0).max(100),
        stage: stageSchema.optional(),
        status: z.enum(["active", "paused", "completed", "blocked"]).optional(),
        metrics: z
          .object({
            published: z.number().optional(),
            indexed: z.number().optional(),
            ai_citations: z.number().optional(),
          })
          .optional(),
        next_actions: z.array(z.string()).optional(),
        actor: z.string().max(60).default("team"),
      })
      .parse(await c.req.json());
    const goal = await rooms.updateGoal(
      c.get("owner"),
      c.req.param("id"),
      {
        progress: body.progress,
        stage: body.stage,
        status: body.status,
        metrics: body.metrics,
        nextActions: body.next_actions,
      },
      body.actor,
    );
    return c.json(goal);
  });
  // 감사 로그 (§15.4.1) — 필수 필드 검증, external 은 approval_id 필수
  app.post("/audit", async (c) => {
    const body = z
      .object({
        ts: z.string().optional(),
        goal_id: z.string().optional(),
        actor: z.string().min(1),
        action: z.string().min(1),
        source_refs: z.array(z.string()).optional(),
        approval_id: z.string().optional(),
        result: z.enum(["ok", "error", "blocked"]),
        external: z.boolean().optional(),
      })
      .parse(await c.req.json());
    if (body.external && !body.approval_id)
      throw new AppError("외부 행위 감사 로그에는 approval_id 가 필요합니다", 422);
    const entry = await rooms.audit(c.get("owner"), {
      packageId: c.get("packageId"),
      goalId: body.goal_id,
      actor: body.actor,
      action: body.action,
      sourceRefs: body.source_refs,
      approvalId: body.approval_id,
      result: body.result,
    });
    if (body.result === "error")
      await rooms.activity(c.get("owner"), {
        roomId: c.get("roomId"),
        kind: "error",
        actor: body.actor,
        title: `오류: ${body.action}`,
      });
    return c.json({ id: entry.id });
  });
  // 주간 보고 (§15.4.3) — 최소 지표 3종
  app.post("/reports/weekly", async (c) => {
    const body = z
      .object({
        summary: z.string().min(1).max(8000),
        metrics: z.object({
          completed_tasks: z.number(),
          pending_approvals: z.number(),
          next_week_plan: z.array(z.string()).min(1),
          published: z.number().optional(),
          indexed: z.number().optional(),
          ai_citations: z.number().optional(),
        }),
        actor: z.string().max(60).default("analyst"),
      })
      .parse(await c.req.json());
    const message = await rooms.post(c.get("owner"), c.get("roomId"), {
      role: "assistant",
      kind: "report",
      text: body.summary,
      payload: { card: "weekly-report", metrics: body.metrics, actor: body.actor },
    });
    await rooms.activity(c.get("owner"), {
      roomId: c.get("roomId"),
      kind: "report",
      actor: body.actor,
      title: "주간 보고 도착",
    });
    return c.json({ id: message.id });
  });
  // 타임라인에 카드·텍스트 게시 (팀장 메시지, 현황 카드 등)
  app.post("/messages", async (c) => {
    const body = z
      .object({
        kind: z.enum(["text", "card", "widget", "report"]).default("text"),
        text: z.string().max(8000).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        actor: z.string().max(60).optional(),
      })
      .parse(await c.req.json());
    const message = await rooms.post(c.get("owner"), c.get("roomId"), {
      role: "assistant",
      kind: body.kind,
      text: body.text,
      payload: { ...body.payload, actor: body.actor },
    });
    if (body.actor)
      await rooms.activity(c.get("owner"), {
        roomId: c.get("roomId"),
        kind: "system",
        actor: body.actor,
        title: body.text?.slice(0, 80) ?? body.kind,
      });
    return c.json({ id: message.id });
  });
  // 캐릭터 상태 (§5): 작업 중/완료는 워커가 알린다. 승인 대기는 서버가 승인 카드에서 자동 판정
  app.post("/presence", async (c) => {
    const body = z
      .object({ state: z.enum(["working", "done", "idle"]), label: z.string().max(80).optional() })
      .parse(await c.req.json());
    bus.setPresence(
      c.get("owner"),
      c.get("roomId"),
      body.state,
      body.label ?? presenceLabel[body.state],
    );
    return c.json({ ok: true });
  });
  return app;
}
export type { TaskStage };
