// 감사에서 나온 조용한 실패·SSOT·배선 누락 수정의 회귀 테스트. 항목 번호는 수정 목록의 번호다.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import type { DockerRunner } from "../apps/server/src/computer.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { privateAccountRoutes } from "../apps/server/src/osiri/account-routes.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { type Approval, Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Mcp, mcpRoutes } from "../apps/server/src/osiri/mcp.ts";
import { Memories } from "../apps/server/src/osiri/memories.ts";
import { Provisioner } from "../apps/server/src/osiri/provisioner.ts";
import {
  issueWorkerToken,
  roomRoutes,
  workerRoutes,
} from "../apps/server/src/osiri/room-routes.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Routing, routingRoutes } from "../apps/server/src/osiri/routing.ts";
import { Catalog, storeRoutes, type TeamPackage } from "../apps/server/src/osiri/store.ts";
import {
  gatewayLlm,
  TeamRuntime,
  type TeamSpec,
  tickInterval,
} from "../apps/server/src/osiri/team-runtime.ts";
import {
  BOARD_STAGES,
  missingTeamRoles,
  PRESENCE_LABELS,
  REQUIRED_TEAM_ROLES,
  STORE_CATEGORIES,
  STORE_CATEGORY_IDS,
} from "../packages/domain/src/osiri.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

let db: Store, directory: string, bus: EventBus, rooms: Rooms, approvals: Approvals, mcp: Mcp;
let app: Hono<{ Variables: { owner: string } }>;
const OWNER = "audit-user";
let publishFails = true;
const user = (path: string, body?: unknown, method?: string, owner = OWNER) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const draft = { title: "글", body: "본문", sources: ["민법 제1117조"] };
const team: TeamSpec = {
  version: 1,
  package: { slug: "t", name: "팀", character: "c", approval_points: ["발행"] },
  agents: Object.fromEntries(
    ["root", "monitor", "drafter", "geo", "reviewer", "publisher", "analyst"].map((key) => [
      key,
      { title: key, description: key, instruction: key },
    ]),
  ),
};
const fakeLlm = async (role: string) =>
  role === "reviewer"
    ? JSON.stringify({ pass: true, reasons: [] })
    : role === "monitor"
      ? "신호"
      : JSON.stringify(draft);

async function siteMcp() {
  const server = new McpServer({ name: "site", version: "0.0.1" });
  server.registerTool(
    "publish",
    {
      description: "발행",
      inputSchema: { title: z.string(), body: z.string(), sources: z.array(z.string()) },
      _meta: { "x-osiri-risk": "external" },
    },
    async () =>
      publishFails
        ? { isError: true, content: [{ type: "text", text: "사이트가 500 을 돌려줌" }] }
        : { content: [{ type: "text", text: "ok" }] },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return client;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-audit-"));
  db = await createStore({ dataDir: join(directory, "db") });
  bus = new EventBus();
  rooms = new Rooms(db, bus);
  approvals = new Approvals(db, rooms, bus);
  mcp = new Mcp(db, rooms, approvals, async (server) => {
    if (server.name === "down") throw new Error("connection refused");
    return siteMcp();
  });
  const deps = { db, rooms, approvals, bus, mcp };
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api/worker", workerRoutes(deps));
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", roomRoutes(deps));
  app.route("/api", mcpRoutes(mcp));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("#0 공용 상수 — 서버가 쓰는 목록이 domain/osiri.ts 한 곳에서 온다", () => {
  assert.deepEqual([...STORE_CATEGORIES], ["legal", "content", "office"]);
  for (const legacy of ["medical", "marketing", "other"] as const)
    assert.ok(STORE_CATEGORY_IDS.includes(legacy), "이전 id 는 계속 유효");
  assert.equal(BOARD_STAGES.length, 7);
  assert.deepEqual(missingTeamRoles(["root", "reviewer"]), ["publisher", "analyst"]);
  assert.deepEqual(missingTeamRoles([...REQUIRED_TEAM_ROLES]), []);
});

test("#1 #2 MCP isError → failed, 팀은 발행 완료로 올리지 않는다 · 승인 단계 목표는 tick 이 이어 간다", async () => {
  const room = await rooms.ensurePersonalRoom(OWNER);
  const token = await issueWorkerToken(db, OWNER, room.id, null);
  const site = await mcp.add(OWNER, { name: "site", url: "http://site.test/mcp" });
  const logs: string[] = [];
  const runtime = new TeamRuntime({
    apiUrl: "http://osiri.test/api/worker",
    workerToken: token,
    team,
    llm: fakeLlm,
    fetchFn: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
    maxPolls: 1,
    log: (line) => logs.push(line),
  });
  const publishTool = { serverId: site.id, tool: "publish" };
  const goal = await rooms.createGoal(OWNER, { roomId: room.id, title: "글 1", level: "short" });

  // 폴링이 끝나도 결재가 없으면 pending — 예전에는 여기서 영영 멈췄다
  assert.equal(await runtime.runShortGoal(goal, publishTool), "pending");
  assert.equal(await runtime.tick(publishTool), "pending", "아직 결재 전");
  const [first] = await approvals.pending(OWNER);
  assert.equal(first?.goalId, goal.id, "승인은 목표에 묶인다");

  // 서버 재시작으로 토큰 유실 → 같은 내용으로 새 승인을 요청한다
  await approvals.decide(OWNER, first?.id as string, "approve", { decidedBy: OWNER });
  (approvals as unknown as { issued: Map<string, string> }).issued.clear();
  assert.equal(await runtime.tick(publishTool), "pending");
  const [second] = await approvals.pending(OWNER);
  assert.ok(second && second.id !== first?.id, "새 승인 카드");
  assert.equal(second.inputHash, first?.inputHash, "같은 내용");

  // 승인 → 다음 tick 이 발행을 시도. 도구가 isError → 실패로 처리
  await approvals.decide(OWNER, second.id, "approve", { decidedBy: OWNER });
  assert.equal(await runtime.tick(publishTool), "publish_failed");
  const after = (await rooms.goals(OWNER, room.id)).find((g) => g.id === goal.id);
  assert.equal(after?.status, "blocked");
  assert.equal(after?.progress, 90, "100 이 아니다");
  const texts = (await rooms.timeline(OWNER, room.id)).map((m) => m.text ?? "");
  assert.ok(!texts.some((t) => t.startsWith("발행 완료")));
  assert.ok(texts.some((t) => t.includes("발행에 실패했습니다") && t.includes("500")));
  assert.equal(await runtime.tick(publishTool), "idle", "막힌 목표는 다시 돌리지 않는다");

  // Mcp.call 자체: isError → status failed + 오류 본문 유지
  publishFails = false;
  const pending = await mcp.call(OWNER, {
    roomId: room.id,
    serverId: site.id,
    tool: "publish",
    args: draft,
  });
  assert.equal(pending.status, "pending_approval");
  publishFails = true;
  const approved = (await approvals.decide(
    OWNER,
    (pending as { approvalId: string }).approvalId,
    "approve",
    { decidedBy: OWNER },
  )) as Approval & { token: string };
  const failed = await mcp.call(OWNER, {
    roomId: room.id,
    serverId: site.id,
    tool: "publish",
    args: draft,
    approval: { id: approved.id, token: approved.token },
  });
  assert.equal(failed.status, "failed");
  assert.match((failed as { error: string }).error, /500/);

  // #14 캐릭터 상태 전송 실패는 삼키지 않고 로그에 남긴다
  const offline = new TeamRuntime({
    apiUrl: "http://osiri.test/api/worker",
    workerToken: "wrong-token",
    team,
    llm: fakeLlm,
    fetchFn: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
    log: (line) => logs.push(line),
  });
  await (
    offline as unknown as { presence(state: string, label?: string): Promise<unknown> }
  ).presence("working");
  assert.ok(logs.some((line) => line.includes("상태 전송 실패")));
});

test("#3 프로비저너 — 방 조회가 404 가 아닌 오류로 실패하면 컨테이너를 지우지 않는다", async () => {
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await db.put("system", "workers", {
    id: "room-db-down",
    containerId: "c-keep",
    userId: "u-x",
    packageId: "p",
    image: "i",
    startedAt: new Date().toISOString(),
  });
  await db.put("system", "workers", {
    id: "room-gone",
    containerId: "c-reap",
    userId: "u-x",
    packageId: "p",
    image: "i",
    startedAt: new Date().toISOString(),
  });
  const flaky = {
    get: async (_owner: string, roomId: string) => {
      if (roomId === "room-db-down") throw new Error("connection terminated");
      throw new AppError("방을 찾을 수 없습니다", 404);
    },
    activity: async () => undefined,
  } as unknown as Rooms;
  const logs: string[] = [];
  const provisioner = new Provisioner(db, flaky, new Catalog(db, rooms), {
    docker,
    apiUrl: "http://127.0.0.1:1",
    modelEnv: {},
    log: (line) => logs.push(line),
  });
  assert.equal((await provisioner.drainOnce()).stopped, 1);
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    ["c-reap"],
  );
  assert.ok(await db.get("system", "workers", "room-db-down"), "워커 기록 유지");
  assert.ok(logs.some((line) => line.includes("room-db-down") && line.includes("워커 유지")));
});

test("#4 #5 만료된 승인은 목록·배지에서 빠지고 만료 처리된다 · 이미 처리된 승인 결재는 409", async () => {
  const owner = "expiry-user";
  const room = await rooms.ensurePersonalRoom(owner);
  const approval = await approvals.request(owner, {
    roomId: room.id,
    toolName: "site:publish",
    input: { n: 1 },
    title: "만료될 승인",
    summary: "",
    requestedBy: "publisher",
  });
  assert.equal((await rooms.board(owner, room.id)).pendingApprovals, 1);
  await db.put(owner, "approvals", {
    ...approval,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal((await rooms.board(owner, room.id)).pendingApprovals, 0, "배지에서 빠진다");
  const events: string[] = [];
  const off = bus.subscribe(owner, (event) =>
    events.push("status" in event ? `${event.type}:${event.status}` : event.type),
  );
  assert.deepEqual(await approvals.pending(owner), []);
  off();
  assert.ok(events.includes("approval:expired"), "결재와 같은 이벤트");
  assert.ok(events.includes("board") && events.includes("inbox"));
  assert.equal((await approvals.get(owner, approval.id)).status, "expired");
  const card = (await rooms.timeline(owner, room.id)).find((m) => m.id === approval.messageId);
  assert.equal(card?.payload?.status, "expired");
  const late = await user(
    `/api/approvals/${approval.id}/decide`,
    { decision: "approve" },
    "POST",
    owner,
  );
  assert.equal(late.status, 409);
  assert.match(((await late.json()) as { error: string }).error, /이미 처리된.*만료됨/);
});

test("#10 #14 스트림 첫 상태는 board() 와 같다 · after=NaN 422 · 못 읽은 MCP 서버는 error 필드", async () => {
  const owner = "stream-user";
  const room = await rooms.ensurePersonalRoom(owner);
  await approvals.request(owner, {
    roomId: room.id,
    toolName: "site:publish",
    input: {},
    title: "대기",
    summary: "",
    requestedBy: "publisher",
  });
  // 재시작을 흉내: 버스 메모리(상태)가 비어 있는 새 서버
  const freshBus = new EventBus();
  const freshRooms = new Rooms(db, freshBus);
  const fresh = new Hono<{ Variables: { owner: string } }>();
  fresh.use("/api/*", async (c, next) => {
    c.set("owner", owner);
    await next();
  });
  fresh.route(
    "/api",
    roomRoutes({
      db,
      rooms: freshRooms,
      approvals: new Approvals(db, freshRooms, freshBus),
      bus: freshBus,
    }),
  );
  assert.equal(freshBus.getPresence(owner, room.id), "idle");
  const response = await fresh.request(`/api/rooms/${room.id}/stream`);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!text.includes("room.presence")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  for (let i = 0; i < 5 && !/room\.presence\ndata: .*\n/.test(text); i++)
    text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const data = text.match(/event: room\.presence\ndata: (.*)\n/)?.[1] ?? "{}";
  assert.deepEqual(JSON.parse(data), {
    roomId: room.id,
    state: "waiting",
    label: PRESENCE_LABELS.waiting,
  });

  assert.equal((await user(`/api/rooms/${room.id}/timeline?after=abc`, undefined, "GET", owner)).status, 422);

  const token = await issueWorkerToken(db, owner, room.id, null);
  await db.put(owner, "mcp-servers", {
    id: "down-1",
    name: "down",
    url: "http://down.test/mcp",
    riskDefault: "external",
    createdAt: new Date().toISOString(),
  });
  const tools = (await (
    await app.request("/api/worker/tools", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { id: string; tools: unknown[]; error?: string }[];
  const down = tools.find((s) => s.id === "down-1");
  assert.deepEqual(down?.tools, []);
  assert.match(down?.error ?? "", /connection refused/);
});

test("#7 주간 보고의 승인 대기 수·지표는 워커 값이 아니라 board() 값", async () => {
  const owner = "report-user";
  const room = await rooms.ensurePersonalRoom(owner);
  const token = await issueWorkerToken(db, owner, room.id, null);
  await approvals.request(owner, {
    roomId: room.id,
    toolName: "site:publish",
    input: { a: 1 },
    title: "대기 1",
    summary: "",
    requestedBy: "publisher",
  });
  const goal = await rooms.createGoal(owner, { roomId: room.id, title: "g", level: "short" });
  await rooms.updateGoal(owner, goal.id, { progress: 100, metrics: { published: 2, indexed: 1 } });
  const posted = await app.request("/api/worker/reports/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      summary: "주간",
      metrics: {
        completed_tasks: 1,
        pending_approvals: 99,
        published: 77,
        next_week_plan: ["다음"],
      },
    }),
  });
  const { metrics } = (await posted.json()) as { metrics: Record<string, unknown> };
  assert.equal(metrics.pending_approvals, 1);
  assert.equal(metrics.published, 2);
  assert.equal(metrics.indexed, 1);
  assert.equal(metrics.ai_citations, 0);
  assert.throws(() => tickInterval("abc"), /TEAM_INTERVAL_MS/);
  assert.throws(() => tickInterval("0"), /TEAM_INTERVAL_MS/);
  assert.equal(tickInterval("5000"), 5000);
  assert.equal(tickInterval(undefined), 600_000);
});

test("#8 단가 없는 모델이 끼면 절감액은 measuring — 0원으로 measured 가 되지 않는다", async () => {
  const env = {
    MODEL: "gw/base",
    MODEL_TIER4: "gw/top",
    MODEL_PRICES_KRW: JSON.stringify({ "gw/top": { in: 5000, out: 20000 } }),
  } as NodeJS.ProcessEnv;
  const routing = new Routing(db, rooms, env);
  const priced = await routing.record("price-user", {
    tier: 4,
    model: "gw/top",
    tokensIn: 1000,
    tokensOut: 1000,
    scriptSaved: false,
    source: "platform",
    reason: "t",
  });
  assert.equal(priced.unpriced, undefined);
  assert.equal((await routing.month("price-user")).savingsStatus, "measured");
  const unpriced = await routing.record("price-user", {
    tier: 3,
    model: "gw/base",
    tokensIn: 1000,
    tokensOut: 1000,
    scriptSaved: false,
    source: "platform",
    reason: "t",
  });
  assert.equal(unpriced.unpriced, true);
  const month = await routing.month("price-user");
  assert.equal(month.savingsStatus, "measuring");
  assert.equal(month.savedKrw, null);
  assert.equal(month.unpricedCalls, 1);
  await routing.updateSettings("price-user", { monthlyCapKrw: 1_000_000 });
  assert.match(
    (await routing.route("price-user", { text: "안녕" })).reason,
    /단가 미설정 사용 1건/,
  );
});

test("#9 #15 가격은 쓸 때 검증·읽을 때 실패 · 구독 카드는 error 필드 · 필수 역할 목록은 런타임과 같다", async () => {
  const accounts = new Accounts(db);
  const adminId = (await accounts.ensureAdmin("01000000077", "1234"))?.id as string;
  const catalog = new Catalog(db, rooms, async () => undefined);
  const store = new Hono<{ Variables: { owner: string } }>();
  store.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof AppError ? error.status : error instanceof z.ZodError ? 422 : 500,
    ),
  );
  store.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  store.route("/api", storeRoutes(catalog, accounts));
  const admin = (path: string, body?: unknown, method?: string) =>
    store.request(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminId}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const base: Omit<TeamPackage, "id" | "createdAt"> = {
    slug: "content-team",
    name: "콘텐츠팀",
    character: "writer",
    category: "content",
    summary: "",
    roles: REQUIRED_TEAM_ROLES.map((name) => ({ name, title: name, summary: "" })),
    approvalPoints: ["발행"],
    reportCadence: "weekly",
    verified: false,
    metrics: { published: 0, indexed: 0, ai_citations: 0 },
    runtime: { teamYaml: "teams/x.yaml", image: "x" },
  };
  await assert.rejects(
    catalog.upsertPackage({ ...base, roles: base.roles.filter((r) => r.name !== "analyst") }),
    /analyst/,
  );
  const pkg = await catalog.upsertPackage(base);
  for (const value of [-1, "9900", null, Number.NaN])
    assert.equal(
      (await admin("/api/admin/settings", { key: "price:content-team", value }, "PATCH")).status,
      422,
      `가격 ${String(value)} 거절`,
    );
  assert.equal((await admin("/api/admin/settings", { key: "price:content-team" }, "PATCH")).status, 422);
  assert.equal(
    (await admin("/api/admin/settings", { key: "price:content-team", value: 9900 }, "PATCH"))
      .status,
    200,
  );
  assert.equal(await catalog.price(pkg), 9900);
  // 저장소에 잘못된 값이 들어가 있으면 0원으로 덮지 않고 실패한다
  await db.put("system", "settings", { id: "price:content-team", value: "free", updatedAt: "" });
  await assert.rejects(catalog.price(pkg), /가격 설정/);
  await db.remove("system", "settings", "price:content-team");
  assert.equal(await catalog.price(pkg), 0, "설정 없음 = 파일럿 무료");

  assert.equal((await admin("/api/store/packages?category=content")).status, 200);
  assert.equal((await admin("/api/store/packages?category=nope")).status, 422);

  const { subscription } = await catalog.subscribe("card-user", pkg.id);
  assert.equal((await catalog.cards("card-user"))[0]?.error, undefined);
  await db.remove("system", "packages", pkg.id);
  const [card] = await catalog.cards("card-user");
  assert.equal(card?.id, subscription.id);
  assert.match(card?.error ?? "", /팀 정보를 찾을 수 없습니다/);
});

test("#11 #14 관리자 시드는 둘 중 하나만 있으면 실패 · 초대 본문이 깨졌으면 400", async () => {
  const accounts = new Accounts(db);
  await assert.rejects(accounts.ensureAdmin("01000000078", undefined), /ADMIN_PASSWORD/);
  await assert.rejects(accounts.ensureAdmin(undefined, "1234"), /ADMIN_PHONE/);
  assert.equal(await accounts.ensureAdmin(undefined, undefined), null);
  const adminId = (await accounts.ensureAdmin("01000000078", "1234"))?.id as string;
  const routes = new Hono<{ Variables: { owner: string } }>();
  routes.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  routes.use("/api/*", async (c, next) => {
    c.set("owner", adminId);
    await next();
  });
  routes.route("/api", privateAccountRoutes(accounts, "http://x"));
  const post = (body?: string) =>
    routes.request("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post()).status, 200, "본문 없는 기본 초대는 그대로");
  assert.equal((await post(JSON.stringify({ role: "operator" }))).status, 200);
});

test("#12 실패한 준비 약속을 붙들지 않는다 · 기억 검색 실패는 error 로 알린다", async () => {
  let calls = 0;
  const flaky = {
    sql: async () => {
      if (++calls === 1) throw new Error("db not ready");
      return { rows: [] };
    },
  } as unknown as Store;
  const memories = new Memories(flaky);
  await assert.rejects(memories.list("u"), /db not ready/);
  assert.deepEqual(await memories.list("u"), [], "두 번째 호출은 다시 시도해 성공");
  const broken = new Memories({
    sql: async () => {
      throw new Error("vector extension missing");
    },
  } as unknown as Store);
  const recalled = await broken.forPrompt("u", "커피");
  assert.deepEqual(recalled.memories, []);
  assert.match(recalled.error ?? "", /vector extension missing/);
});

test("#14 게이트웨이의 빈 응답은 오류다", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
      status: 200,
    })) as typeof fetch;
  const llm = gatewayLlm({
    OPENAI_BASE_URL: "http://gw.test/v1",
    OPENAI_API_KEY: "k",
    MODEL: "m",
  } as NodeJS.ProcessEnv);
  await assert.rejects(llm("root", 3, "s", "u"), /빈 응답/);
});

test("#13 B1 RELEASES_DIR 없으면 /releases/* 는 404 · 채팅은 라우팅을 거치고 사용량·answered_by 가 남는다", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const fixture = await browserFixture(t, () => ({ data: {} }));
  const webDist = await mkdtemp(join(tmpdir(), "osiri-web-"));
  t.after(() => rm(webDist, { recursive: true, force: true }));
  await writeFile(join(webDist, "index.html"), "<html>spa</html>");
  const config = {
    ...fixture.config,
    agentBackend: "model",
    model: "openai/fixture",
    webDist,
  } as const;
  const server = await createApp(fixture.db, config);
  t.after(() => server.agent.stop());
  const releases = await server.app.request("/releases/latest.json");
  assert.equal(releases.status, 404, "SPA index.html 이 대신 나가지 않는다");
  assert.equal((await server.app.request("/anything")).status, 200);

  const previous = { tier2: process.env.MODEL_TIER2, key: process.env.TOKEN_ENCRYPTION_KEY };
  t.after(() => {
    for (const [name, value] of [
      ["MODEL_TIER2", previous.tier2],
      ["TOKEN_ENCRYPTION_KEY", previous.key],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.MODEL_TIER2 = "openai/light-fixture";
  const owner = "local-user";
  const run = (content: string, threadId: string): RunAgentInput => ({
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content }],
    tools: [],
    context: [],
    state: {},
  });
  const chat = (content: string, threadId: string) =>
    lastValueFrom(
      new ConversationAgent(config, server.agent, owner).run(run(content, threadId)).pipe(toArray()),
    );
  // 짧은 잡담 → 티어 2 → MODEL_TIER2 의 모델로 나간다
  await chat("안녕", "thread-a");
  assert.equal(JSON.parse(requests.at(-1)?.body ?? "{}").model, "light-fixture");
  // 어려운 질문 → 티어 4. MODEL_TIER4 가 없으니 지어내지 않고 기본 모델 + 근거 기록
  await chat("이 계약의 법적 쟁점과 리스크를 검토해 줘", "thread-a");
  assert.equal(JSON.parse(requests.at(-1)?.body ?? "{}").model, "fixture");
  // 가성비 자동을 끄면 규칙으로 내리지 않는다 → 주력(티어 3)
  await server.osiri.routing.updateSettings(owner, { autoEconomy: false });
  await chat("안녕", "thread-b");
  assert.equal(JSON.parse(requests.at(-1)?.body ?? "{}").model, "fixture");

  const usage = await fixture.db.list<{
    tier: number;
    model: string;
    source: string;
    tokensIn: number;
    tokensOut: number;
    reason: string;
    threadId: string;
  }>(owner, "usage");
  assert.equal(usage.length, 3, "모델 호출마다 사용량 1건");
  const light = usage.find((u) => u.model === "openai/light-fixture");
  assert.equal(light?.tier, 2);
  assert.equal(light?.source, "platform");
  assert.equal(light?.tokensIn, 10, "제공자가 알려준 토큰");
  assert.equal(light?.tokensOut, 5);
  assert.ok(usage.some((u) => u.tier === 4 && /MODEL_TIER4 미설정 → 기본 모델/.test(u.reason)));
  assert.ok(usage.some((u) => u.tier === 3 && /가성비 자동 꺼짐/.test(u.reason)));

  const answers = await server.osiri.routing.answers(owner, "thread-a");
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0]?.answered_by, {
    tier: 2,
    model: "openai/light-fixture",
    source: "server",
    reason: light?.reason,
  });
  assert.ok((answers[0]?.messageIds.length ?? 0) > 0, "답변 메시지 id 로 찾을 수 있다");

  // BYOK: 본인 키가 있으면 그 키로 나가고 source=byok, 비용은 0
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  await server.osiri.routing.connectAccount(owner, "openai", "sk-user-own-key-1234", (async () =>
    new Response("{}", { status: 200 })) as typeof fetch);
  const route = await server.osiri.routing.forChat(owner, { text: "안녕" }, config.model);
  assert.equal(route.source, "byok");
  assert.equal(route.apiKey, "sk-user-own-key-1234");
  const answersRoute = new Hono<{ Variables: { owner: string } }>();
  answersRoute.use("*", async (c, next) => {
    c.set("owner", owner);
    await next();
  });
  answersRoute.route("/", routingRoutes(server.osiri.routing));
  assert.equal((await answersRoute.request("/usage/answers?threadId=thread-b")).status, 200);
});
