// 0Siri 방·결재함·목표·승인·실시간 스트림·워커 API 라우트 (0SIRI-SPEC §21).
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  ACTIVITY_LABELS,
  ANSWER_SOURCES,
  type AnsweredByView,
  APPROVAL_KINDS,
  answerLabel,
  BOARD_STAGES,
  GOAL_LEVELS,
  GOAL_STATUSES,
  METRIC_PERIODS,
  MODEL_TIERS,
  type ModelTier,
  PRESENCE_LABELS,
  PROPOSAL_DECISIONS,
  REJECT_REASON_KINDS,
  WORKER_PRESENCE_STATES,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { AlreadyDecidedError, type Approvals, approvalKind } from "./approvals.ts";
import { type EventBus, toUserStreamEvent } from "./events.ts";
import type { Mcp } from "./mcp.ts";
import { assertProposed, type Room, type Rooms, type TaskStage, type TeamGoal } from "./rooms.ts";
import type { Routing } from "./routing.ts";
import type { Catalog } from "./store.ts";
import { gatewayLlm, type Llm, loadTeam, TeamRuntime } from "./team-runtime.ts";

type Env = { Variables: { owner: string } };
/**
 * 사용자가 시작한 장기 목표를 분해하는 길 (목표 → 분해 → 실행의 입구).
 * 부르면 «분해할 수 있는가» 를 먼저 확인한다 — 못 하면 이유를 담아 던진다(목표는 시작되지 않는다).
 * 돌려준 함수가 실제 분해를 돈다.
 */
export type GoalDecomposer = (input: {
  owner: string;
  room: Room;
  goal: TeamGoal;
}) => Promise<() => Promise<unknown>>;
export interface RoomDeps {
  db: Store;
  rooms: Rooms;
  approvals: Approvals;
  bus: EventBus;
  mcp?: Mcp;
  /** 팀 패키지(역할표·팀 정의 경로). 없으면 현황판 역할 설명과 기본 목표 분해기를 쓸 수 없다 */
  catalog?: Pick<Catalog, "packageById">;
  /** 사용량 장부 — 타임라인의 «누가 답했는지» 출처 */
  routing?: Pick<Routing, "answers">;
  /** 목표 분해기. 안 주면 catalog 로 `teamDecomposer` 를 만든다 */
  decomposer?: GoalDecomposer;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stageSchema = z.enum(BOARD_STAGES);
const levelSchema = z.enum(GOAL_LEVELS);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** 사용자 스트림이 한 번에 몰려온 방 이벤트를 묶는 시간 — 승인 1건이 이벤트 5~6개를 낸다 */
const USER_STREAM_COALESCE_MS = 100;
const answeredByView = (by: {
  tier: ModelTier;
  model: string;
  source: AnsweredByView["source"];
  reason?: string;
}): AnsweredByView => ({
  tier: by.tier,
  label: answerLabel(by.source, by.tier),
  model: by.model,
  source: by.source,
  ...(by.reason ? { reason: by.reason } : {}),
});

/**
 * SSE 연결 수명 — 방 스트림과 사용자 스트림이 같은 종료 처리를 쓴다.
 * 구독자·하트비트 안의 실패는 삼키지 않는다: 이유를 남기고 스트림을 닫아 클라이언트가 다시 붙게 한다.
 * 끊기면 하트비트 타이머와 `attach` 가 돌려준 정리 함수를 반드시 부른다.
 */
async function holdStream(
  stream: SSEStreamingApi,
  closeLabel: string,
  attach: (io: { fail: (error: unknown) => void; isOpen: () => boolean }) => () => void,
) {
  let open = true;
  let finish: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fail = (error: unknown) => {
    if (!open) return;
    open = false;
    console.error(`[osiri] ${closeLabel}: ${errorText(error)}`);
    finish();
  };
  const detach = attach({ fail, isOpen: () => open });
  const heartbeat = setInterval(
    () => void stream.writeSSE({ event: "ping", data: "" }).catch(fail),
    25_000,
  );
  stream.onAbort(finish);
  // 첫 전송 도중에 이미 끊긴 연결은 onAbort 가 다시 불리지 않는다 — 하트비트가 영영 남지 않게 바로 끝낸다
  if (stream.aborted) finish();
  // 연결이 끊기거나 전송이 실패할 때까지 유지
  await closed;
  open = false;
  clearInterval(heartbeat);
  detach();
}

/**
 * 기본 목표 분해기: 그 방 팀의 팀장(root)에게 분해를 맡긴다 — 팀 런타임의 `decompose()` 를 서버 안에서 돌리고,
 * 결과는 워커 API(이 프로세스의 `workerRoutes`)로 등록한다. 등록된 단기 목표는 팀 워커의 다음 tick 이 집어 실행한다.
 */
export function teamDecomposer(
  deps: RoomDeps & { catalog: Pick<Catalog, "packageById"> },
  llm: () => Llm = gatewayLlm,
): GoalDecomposer {
  const origin = "http://osiri.internal";
  return async ({ owner, room, goal }) => {
    if (room.packageId === null)
      throw new AppError(
        "이 방에는 구독한 팀이 없어 목표를 나눌 수 없습니다. 팀을 구독한 방에서 시작하세요",
        422,
      );
    const pkg = await deps.catalog.packageById(room.packageId);
    let team: Awaited<ReturnType<typeof loadTeam>>;
    let model: Llm;
    try {
      team = await loadTeam(pkg.runtime.teamYaml);
      model = llm();
    } catch (error) {
      throw new AppError(`목표를 나눌 수 없습니다: ${errorText(error)}`, 503);
    }
    const worker = workerRoutes(deps);
    worker.onError((error, c) =>
      c.json(
        { error: errorText(error) },
        error instanceof AppError ? error.status : error instanceof z.ZodError ? 422 : 500,
      ),
    );
    return async () => {
      const token = await issueWorkerToken(deps.db, owner, room.id, room.packageId);
      try {
        const runtime = new TeamRuntime({
          apiUrl: origin,
          workerToken: token,
          team,
          llm: model,
          fetchFn: async (input, init) => worker.request(String(input).slice(origin.length), init),
          log: (line) => console.log(`[osiri] 목표 분해 room=${room.id}: ${line}`),
        });
        return await runtime.decompose(goal.title, goal);
      } finally {
        // 이 분해에만 쓴 워커 토큰은 남기지 않는다
        await deps.db.remove("system", "worker-tokens", sha(token));
      }
    };
  };
}

/** 사용자(소유자 토큰) 라우트 — /api 아래, 인증 미들웨어 뒤에 마운트. */
export function roomRoutes(deps: RoomDeps) {
  const { db, rooms, approvals, bus, routing } = deps;
  const catalog = deps.catalog;
  const decomposer =
    deps.decomposer ?? (catalog ? teamDecomposer({ ...deps, catalog }) : undefined);
  // 현황판 역할 설명의 출처는 팀 패키지 역할표 하나다
  if (catalog) rooms.setRoleSource(async (id) => (await catalog.packageById(id)).roles);
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
  app.post("/rooms/:id/mute", async (c) => {
    const body = z.object({ muted: z.boolean() }).parse(await c.req.json());
    await rooms.patch(c.get("owner"), c.req.param("id"), body);
    return c.json(await rooms.card(c.get("owner"), c.req.param("id")));
  });
  app.get("/rooms/:id/feed", async (c) =>
    c.json(await rooms.feed(c.get("owner"), c.req.param("id"))),
  );
  app.get("/rooms/:id/files", async (c) =>
    c.json(await rooms.files(c.get("owner"), c.req.param("id"))),
  );
  app.get("/rooms/:id/ideas", async (c) =>
    c.json(await rooms.proposals(c.get("owner"), c.req.param("id"))),
  );
  // 사용자 단위 실시간 스트림 (SSE). 이벤트: rooms {roomId} · inbox · ping — 받은 쪽이 /rooms·/inbox 를 다시 읽는다
  app.get("/stream", (c) => {
    const owner = c.get("owner");
    return streamSSE(c, async (stream) => {
      let id = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data), id: String(++id) });
      // 연결 직후 한 번 — 프록시가 첫 바이트까지 응답을 붙잡지 않게 한다
      await stream.writeSSE({ event: "ping", data: "" });
      await holdStream(stream, `사용자 스트림 종료 owner=${owner}`, ({ fail, isOpen }) => {
        const changedRooms = new Set<string>();
        let inboxChanged = false;
        let timer: NodeJS.Timeout | undefined;
        const flush = () => {
          timer = undefined;
          if (!isOpen()) return;
          const roomIds = [...changedRooms];
          const inbox = inboxChanged;
          changedRooms.clear();
          inboxChanged = false;
          void (async () => {
            for (const roomId of roomIds) await send("rooms", { roomId });
            if (inbox) await send("inbox", {});
          })().catch(fail);
        };
        const unsubscribe = bus.subscribe(owner, (event) => {
          if (!isOpen()) return;
          const out = toUserStreamEvent(event);
          if (out.event === "inbox") inboxChanged = true;
          else changedRooms.add(out.roomId);
          timer ??= setTimeout(flush, USER_STREAM_COALESCE_MS);
        });
        return () => {
          if (timer) clearTimeout(timer);
          unsubscribe();
        };
      });
    });
  });
  // S3 타임라인 — 진입 시 부재 중 요약 카드를 맨 위에 (§4.3)
  app.get("/rooms/:id/timeline", async (c) => {
    const owner = c.get("owner");
    const roomId = c.req.param("id");
    const afterRaw = c.req.query("after");
    const after = afterRaw ? Number(afterRaw) : undefined;
    if (after !== undefined && !Number.isFinite(after))
      throw new AppError("after 는 숫자여야 합니다", 422);
    const room = await rooms.get(owner, roomId);
    const digest = after === undefined ? await rooms.digestSince(owner, roomId) : null;
    const messages = await rooms.timeline(owner, roomId, after);
    if (after === undefined)
      await rooms.patch(owner, roomId, { lastSeenAt: new Date().toISOString() });
    // 채팅 답변 messageId → «누가 답했는지». 채팅 threadId = 방 id. 사용량 장부가 없는 구성에는 기록된 답변도 없다
    const answers: Record<string, AnsweredByView> = {};
    if (routing)
      for (const entry of await routing.answers(owner, roomId))
        for (const messageId of entry.messageIds)
          answers[messageId] = answeredByView(entry.answered_by);
    return c.json({ room, digest, messages, board: await rooms.board(owner, roomId), answers });
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
      label: PRESENCE_LABELS[board.presence],
      flow: board.flow,
      pendingApprovals: pending
        .filter((a) => a.roomId === roomId)
        .map((a) => ({ id: a.id, title: a.title })),
      doneToday,
      progress: board.progress,
      nextReportAt: board.nextReportAt ?? null,
      recentDone: board.recentDone,
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
      // 첫 상태는 현황판과 같은 값이어야 한다 — 재시작 뒤 버스 메모리는 idle 이어도 승인 대기는 board() 가 안다
      const board = await rooms.board(owner, roomId);
      await send("board", board);
      await send("room.presence", {
        roomId,
        state: board.presence,
        label: PRESENCE_LABELS[board.presence],
      });
      await holdStream(stream, `방 스트림 종료 room=${roomId}`, ({ fail, isOpen }) =>
        bus.subscribe(owner, (event) => {
          if (!isOpen()) return;
          if ("roomId" in event && event.roomId !== roomId) return;
          void (async () => {
            if (event.type === "board") await send("board", await rooms.board(owner, roomId));
            else if (event.type === "approval") {
              await send("approval", event);
              await send("board", await rooms.board(owner, roomId));
            } else await send(event.type, event);
          })().catch(fail);
        }),
      );
    });
  });

  // S3/S4 승인·반려. 반려는 reasonKind 필수(400). 이미 처리된 건은 409 + 현재 status
  app.post("/approvals/:id/decide", async (c) => {
    const body = z
      .object({
        decision: z.enum(["approve", "reject"]),
        reasonKind: z.enum(REJECT_REASON_KINDS).optional(),
        reason: z.string().max(1000).optional(),
        frozenHash: z.string().optional(),
      })
      .parse(await c.req.json());
    let result: Awaited<ReturnType<Approvals["decide"]>>;
    try {
      result = await approvals.decide(c.get("owner"), c.req.param("id"), body.decision, {
        reason: body.reason,
        reasonKind: body.reasonKind,
        decidedBy: c.get("owner"),
        frozenHash: body.frozenHash,
      });
    } catch (error) {
      if (error instanceof AlreadyDecidedError)
        return c.json({ error: error.message, status: error.approvalStatus }, 409);
      throw error;
    }
    const {
      token: _token,
      tokenHash: _hash,
      ...safe
    } = result as typeof result & { token?: string };
    return c.json(safe);
  });
  // S4 결재함 — 전 팀 승인 대기 + 활동 (§10 ③층). ?room_id= · ?kind= 로 거른다.
  // 승인 대기는 팀(방)별로 읽는다 — 한 팀이 실패해도 나머지는 주고, 실패한 팀은 failed 로 알린다
  app.get("/inbox", async (c) => {
    const owner = c.get("owner");
    const roomId = c.req.query("room_id");
    const kindRaw = c.req.query("kind");
    const kind = kindRaw === undefined ? undefined : z.enum(APPROVAL_KINDS).parse(kindRaw);
    const [activities, roomList] = await Promise.all([
      rooms.activities(owner),
      db.list<Room>(owner, "rooms"),
    ]);
    if (roomId && !roomList.some((r) => r.id === roomId))
      throw new AppError("방을 찾을 수 없습니다", 404);
    const targets = roomId ? roomList.filter((r) => r.id === roomId) : roomList;
    const settled = await Promise.allSettled(
      targets.map((room) => approvals.pendingForRoom(owner, room.id)),
    );
    const failed: { roomId: string; roomTitle: string; error: string }[] = [];
    const pending = settled.flatMap((result, i) => {
      const room = targets[i] as Room;
      if (result.status === "rejected") {
        console.error(
          `[osiri] 결재함: 방 ${room.id} 의 승인 대기를 읽지 못했습니다: ${errorText(result.reason)}`,
        );
        failed.push({ roomId: room.id, roomTitle: room.title, error: errorText(result.reason) });
        return [];
      }
      return result.value
        .filter((a) => kind === undefined || approvalKind(a) === kind)
        .map(({ tokenHash: _t, ...a }) => ({
          ...a,
          kind: approvalKind(a),
          roomTitle: room.title,
          roomCharacter: room.character,
        }));
    });
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const titles = new Map(roomList.map((r) => [r.id, r.title]));
    return c.json({
      pending,
      activities: activities
        .filter((a) => !roomId || a.roomId === roomId)
        .map((a) => ({
          ...a,
          roomTitle: a.roomId ? (titles.get(a.roomId) ?? "") : "",
          label: ACTIVITY_LABELS[a.kind], // 방 피드(Rooms.feed)와 같은 이름
        })),
      failed,
    });
  });
  // S5 목표. 장기 목표는 사용자가 만들고(proposed) 시작을 눌러야(activate) 팀이 나눠 실행한다
  app.get("/goals", async (c) => {
    const roomId = c.req.query("room_id");
    if (!roomId) throw new AppError("room_id 가 필요합니다", 422);
    return c.json(await rooms.goals(c.get("owner"), roomId));
  });
  app.post("/goals", async (c) => {
    const body = z
      .object({ roomId: z.string().min(1), title: z.string().trim().min(1).max(300) })
      .parse(await c.req.json());
    return c.json(
      await rooms.createGoal(
        c.get("owner"),
        { roomId: body.roomId, title: body.title, level: "long", status: "proposed" },
        "user",
      ),
    );
  });
  // 팀이 낸 주제·목표 제안 (`/goals/:id/...` 보다 먼저 둔다)
  app.get("/goals/proposals", async (c) =>
    c.json(await rooms.proposals(c.get("owner"), c.req.query("room_id") || undefined)),
  );
  app.post("/goals/proposals/:id/decide", async (c) => {
    const body = z.object({ decision: z.enum(PROPOSAL_DECISIONS) }).parse(await c.req.json());
    return c.json(await rooms.decideProposal(c.get("owner"), c.req.param("id"), body.decision));
  });
  // proposed → active, 그리고 팀장이 목표를 나눈다(목표 → 분해 → 실행). 나눌 수 없으면 이유를 돌려주고 시작하지 않는다
  app.post("/goals/:id/activate", async (c) => {
    const owner = c.get("owner");
    const goalId = c.req.param("id");
    const goal = await rooms.goal(owner, goalId);
    assertProposed(goal);
    if (goal.level !== "long") return c.json(await rooms.activateGoal(owner, goalId));
    if (!decomposer)
      throw new AppError(
        "목표를 나눌 팀 구성이 서버에 연결되어 있지 않아 시작할 수 없습니다 (팀 카탈로그 미연결)",
        503,
      );
    const room = await rooms.get(owner, goal.roomId);
    const decompose = await decomposer({ owner, room, goal });
    const active = await rooms.activateGoal(owner, goalId);
    // 분해는 모델 호출이라 오래 걸린다 — 응답은 먼저 주고, 결과·실패는 방에 남긴다
    void decompose()
      .then(
        () => bus.setPresence(owner, room.id, "idle", PRESENCE_LABELS.idle),
        async (error: unknown) => {
          const reason = errorText(error);
          console.error(`[osiri] 목표 분해 실패 goal=${goalId} room=${room.id}: ${reason}`);
          // 다시 시작할 수 있게 시작 전 상태로 되돌린다
          await rooms.updateGoal(owner, goalId, { status: "proposed" });
          await rooms.audit(owner, {
            packageId: room.packageId,
            goalId,
            actor: "root",
            action: "goal.decompose",
            result: "error",
            roomId: room.id,
          });
          await rooms.post(owner, room.id, {
            role: "system",
            kind: "text",
            text: `목표를 나누지 못했습니다: ${reason}. 목표는 시작 전 상태로 되돌렸습니다 — 다시 시작할 수 있습니다.`,
            payload: { goalId, error: reason },
          });
          await rooms.activity(owner, {
            roomId: room.id,
            kind: "error",
            actor: "system",
            title: `목표 분해 실패: ${goal.title}`,
            detail: reason,
          });
          bus.setPresence(owner, room.id, "idle", PRESENCE_LABELS.idle);
        },
      )
      .catch((error: unknown) =>
        console.error(
          `[osiri] 목표 분해 실패를 방에 남기지 못했습니다 goal=${goalId}: ${errorText(error)}`,
        ),
      );
    return c.json(active);
  });
  app.get("/goals/:id/metrics", async (c) => {
    const period = z.enum(METRIC_PERIODS).parse(c.req.query("period"));
    return c.json(await rooms.goalMetrics(c.get("owner"), c.req.param("id"), period));
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
        goal_id: z.string().max(100).optional(),
        kind: z.enum(APPROVAL_KINDS).optional(),
      })
      .parse(await c.req.json());
    const approval = await approvals.request(c.get("owner"), {
      roomId: c.get("roomId"),
      goalId: body.goal_id,
      kind: body.kind,
      toolName: body.toolName,
      input: body.input,
      title: body.title,
      summary: body.summary,
      evidence: body.evidence,
      requestedBy: body.actor,
    });
    return c.json({ id: approval.id, status: approval.status, inputHash: approval.inputHash });
  });
  // 목표에 걸린 승인 목록(오래된 순) — 워커가 승인 단계에 멈춘 목표를 이어 갈 때 상태를 확인한다
  app.get("/approvals", async (c) => {
    const goalId = c.req.query("goal_id");
    if (!goalId) throw new AppError("goal_id 가 필요합니다", 422);
    const linked = await approvals.forGoal(c.get("owner"), c.get("roomId"), goalId);
    return c.json(
      linked.map(({ id, status, toolName, input, title, summary, evidence }) => ({
        id,
        status,
        toolName,
        input,
        title,
        summary,
        evidence,
      })),
    );
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
    // 도구 목록을 못 읽은 서버는 빈 목록으로 숨기지 않고 서버별 error 로 알린다
    const listed = await Promise.all(
      servers.map((s) =>
        mcp.toolsFor(owner, s.id).then(
          (tools) => ({ tools }),
          (error: unknown) => {
            console.error(`[osiri] MCP 도구 목록 실패 server=${s.id}: ${errorText(error)}`);
            return { tools: [], error: errorText(error) };
          },
        ),
      ),
    );
    return c.json(servers.map((s, i) => ({ id: s.id, name: s.name, ...listed[i] })));
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
  // 현황판 집계 — 워커도 승인 대기 수·지표를 여기서만 읽는다 (재계산 금지)
  app.get("/board", async (c) => c.json(await rooms.board(c.get("owner"), c.get("roomId"))));
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
  // 팀이 주제·목표를 제안한다 — 사용자가 수락하면 다음 중기 목표가 된다
  app.post("/goals/proposals", async (c) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(300),
        detail: z.string().max(4000),
        actor: z.string().min(1).max(60).default("team"),
      })
      .parse(await c.req.json());
    return c.json(
      await rooms.propose(c.get("owner"), {
        roomId: c.get("roomId"),
        title: body.title,
        detail: body.detail,
        proposedBy: body.actor,
      }),
    );
  });
  app.post("/goals/:id/progress", async (c) => {
    const body = z
      .object({
        progress: z.number().min(0).max(100),
        stage: stageSchema.optional(),
        status: z.enum(GOAL_STATUSES).optional(),
        metrics: z
          .object({
            published: z.number().optional(),
            indexed: z.number().optional(),
            ai_citations: z.number().optional(),
            conversions: z.number().optional(),
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
      roomId: c.get("roomId"),
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
          // 승인 대기 수·성과 지표는 워커가 보낸 값을 쓰지 않는다 — 아래에서 board() 값으로 덮는다
          pending_approvals: z.number().optional(),
          next_week_plan: z.array(z.string()).min(1),
          published: z.number().optional(),
          indexed: z.number().optional(),
          ai_citations: z.number().optional(),
        }),
        actor: z.string().max(60).default("analyst"),
      })
      .parse(await c.req.json());
    const board = await rooms.board(c.get("owner"), c.get("roomId"));
    const metrics = {
      ...body.metrics,
      pending_approvals: board.pendingApprovals,
      ...board.metrics,
    };
    const message = await rooms.post(c.get("owner"), c.get("roomId"), {
      role: "assistant",
      kind: "report",
      text: body.summary,
      payload: { card: "weekly-report", metrics, actor: body.actor },
    });
    await rooms.activity(c.get("owner"), {
      roomId: c.get("roomId"),
      kind: "report",
      actor: body.actor,
      title: "주간 보고 도착",
    });
    return c.json({ id: message.id, metrics });
  });
  // 타임라인에 카드·텍스트 게시 (팀장 메시지, 현황 카드 등)
  app.post("/messages", async (c) => {
    const body = z
      .object({
        kind: z.enum(["text", "card", "widget", "report"]).default("text"),
        text: z.string().max(8000).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        actor: z.string().max(60).optional(),
        // «누가 답했는지» — 라벨은 서버가 붙여 채팅 답변(timeline.answers)과 같은 모양으로 싣는다
        answeredBy: z
          .object({
            tier: z.union(MODEL_TIERS.map((tier) => z.literal(tier))),
            model: z.string().min(1).max(200),
            source: z.enum(ANSWER_SOURCES),
            reason: z.string().max(500).optional(),
          })
          .optional(),
      })
      .parse(await c.req.json());
    const message = await rooms.post(c.get("owner"), c.get("roomId"), {
      role: "assistant",
      kind: body.kind,
      text: body.text,
      payload: {
        ...body.payload,
        actor: body.actor,
        ...(body.answeredBy ? { answeredBy: answeredByView(body.answeredBy) } : {}),
      },
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
      .object({ state: z.enum(WORKER_PRESENCE_STATES), label: z.string().max(80).optional() })
      .parse(await c.req.json());
    bus.setPresence(
      c.get("owner"),
      c.get("roomId"),
      body.state,
      body.label ?? PRESENCE_LABELS[body.state],
    );
    return c.json({ ok: true });
  });
  return app;
}
export type { TaskStage };
