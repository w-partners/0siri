// docs/0siri-api-contract.md «스토어 · 연결 · 기억 · 설정 · 로그인·온보딩» 계약 시험.
// 기억 시험은 임베딩 모델(q8)을 실제로 쓴다 — osiri-memories.test.ts 와 같은 캐시를 읽는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as SdkServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  accountDeletionRoutes,
  privateAccountRoutes,
  publicAccountRoutes,
} from "../apps/server/src/osiri/account-routes.ts";
import { Accounts, type User } from "../apps/server/src/osiri/accounts.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Mcp, type McpServer, mcpRoutes } from "../apps/server/src/osiri/mcp.ts";
import { Memories, memoryRoutes } from "../apps/server/src/osiri/memories.ts";
import { type AuditLog, Rooms } from "../apps/server/src/osiri/rooms.ts";
import {
  type ModelAccount,
  Routing,
  routingRoutes,
  settingsRoutes,
} from "../apps/server/src/osiri/routing.ts";
import { Catalog, type Subscription, storeRoutes } from "../apps/server/src/osiri/store.ts";
import {
  DEFAULT_CHARACTER_PREFS,
  DEFAULT_NOTIFICATION_PREFS,
  MODEL_KEY_PROVIDERS,
  PERSONAL_TIER_LABEL,
  PLATFORM_DATA_HANDLING,
  REPORT_CADENCE_LABELS,
  RETENTION_DAYS,
  TEAM_TIER_LABEL,
} from "../packages/domain/src/osiri.ts";

const DAY = 24 * 60 * 60 * 1000;
const env = {
  MODEL: "gw/base",
  MODEL_TIER2: "gw/light",
  MODEL_TIER3: "gw/main",
  MODEL_TIER4: "gw/top",
  MODEL_PRICES_KRW: JSON.stringify({
    "gw/light": { in: 100, out: 400 },
    "gw/main": { in: 1000, out: 4000 },
    "gw/top": { in: 5000, out: 20000 },
  }),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENAI_BASE_URL: "http://fake.openai/v1",
} as NodeJS.ProcessEnv;

let db: Store, directory: string;
let accounts: Accounts, rooms: Rooms, routing: Routing, catalog: Catalog, memories: Memories;
let app: Hono<{ Variables: { owner: string } }>;
let adminId: string;
/** 제공자 검증 호출을 바꿔 끼운다 — 시험마다 다음 응답을 정한다 */
let provider: { status: number } | { fail: string } = { status: 200 };
const probed: string[] = [];
/** 시험 MCP 커넥터가 받은 서버(푼 헤더 포함) */
const connected: McpServer[] = [];

const call = (path: string, owner: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(response: Response | Promise<Response>) => (await response).json() as T;
const as = (owner: string) => `owner:${owner}`;

async function testMcp(server: McpServer) {
  connected.push(server);
  const sdk = new SdkServer({ name: "contract-test", version: "0.0.1" });
  sdk.registerTool(
    "doc_read",
    { description: "읽기", inputSchema: {}, _meta: { "x-osiri-risk": "read" } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  sdk.registerTool(
    "doc_write",
    { description: "쓰기", inputSchema: { text: z.string() }, _meta: { "x-osiri-risk": "write" } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  sdk.registerTool("doc_unknown", { description: "미선언", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "?" }],
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await sdk.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}
const team = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: `${slug} 팀`,
  character: "counsel",
  category: "legal",
  summary: "시험용 팀",
  roles: [
    { name: "root", title: "팀장", summary: "배분" },
    { name: "reviewer", title: "검수", summary: "검수" },
    { name: "publisher", title: "발행", summary: "발행" },
    { name: "analyst", title: "분석", summary: "보고" },
  ],
  approvalPoints: ["발행 전 승인"],
  metrics: { published: 8, indexed: 6, ai_citations: 2 },
  runtime: { teamYaml: "teams/x.yaml", image: "osiri/team-runtime" },
  ...extra,
});
type Pkg = {
  id: string;
  subscribed: boolean;
  roomId: string | null;
  reviewing: boolean;
  reportCadence: string;
  dataHandling: string;
  conversionRate: number | null;
  runtime?: unknown;
};
type Card = Subscription & { paymentMethod: string | null; endsAt: string | null };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-contract-account-"));
  db = await createStore({ dataDir: join(directory, "db") });
  accounts = new Accounts(db);
  adminId = (await accounts.ensureAdmin("01000000001", "1234"))?.id as string;
  const bus = new EventBus();
  rooms = new Rooms(db, bus);
  routing = new Routing(db, rooms, env);
  catalog = new Catalog(db, rooms, async () => undefined);
  memories = new Memories(db);
  const mcp = new Mcp(db, rooms, new Approvals(db, rooms, bus), testMcp, env);
  const auth = await createAuth(db, {
    mode: "live",
    dataDir: directory,
    publicUrl: "http://t",
  } as Config);
  const fakeFetch = (async (url: string | URL | Request) => {
    probed.push(String(url));
    if ("fail" in provider) throw new Error(provider.fail);
    return new Response("{}", { status: provider.status });
  }) as typeof fetch;

  app = new Hono<{ Variables: { owner: string } }>();
  // app.ts 의 공용 오류 처리기와 같은 규칙 (본문은 error 문장만)
  app.onError((error, c) =>
    error instanceof z.ZodError
      ? c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422)
      : c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api/auth", publicAccountRoutes(accounts));
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    // "owner:<id>" 는 시험용 직접 지정, 그 밖에는 실제 세션 토큰
    c.set(
      "owner",
      header.startsWith("Bearer owner:") ? header.slice(13) : await auth.owner(header),
    );
    await next();
  });
  app.route("/api", privateAccountRoutes(accounts, "http://t"));
  app.route("/api", memoryRoutes(memories));
  app.route("/api", mcpRoutes(mcp));
  app.route("/api", storeRoutes(catalog, accounts));
  app.route("/api", routingRoutes(routing, env));
  app.route("/api", settingsRoutes(routing, catalog, fakeFetch));
  app.route(
    "/api",
    accountDeletionRoutes(accounts, (owner, input) => rooms.audit(owner, input)),
  );
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 연결: 모델 키
test("모델 키: 제공자마다 한 줄 · 검증을 통과한 뒤에만 교체 · 실패 종류(format·auth·network)", async () => {
  const owner = as("key-user");
  type Row = { provider: string; status: string; last4: string | null; baseUrl?: string };
  const rows = await json<Row[]>(call("/api/model-keys", owner));
  assert.deepEqual(
    rows.map((r) => r.provider),
    [...MODEL_KEY_PROVIDERS],
  );
  assert.ok(rows.every((r) => r.status === "none" && r.last4 === null));

  provider = { status: 200 };
  const first = await call("/api/model-keys/openai", owner, { apiKey: "sk-first-key-AAAA" }, "PUT");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { provider: "openai", status: "active", last4: "AAAA" });
  assert.equal(await routing.apiKey("key-user", "openai"), "sk-first-key-AAAA");

  // 제공자가 거절 → auth. 이전 키는 그대로 남는다
  provider = { status: 401 };
  const rejected = await call(
    "/api/model-keys/openai",
    owner,
    { apiKey: "sk-second-key-BBBB" },
    "PUT",
  );
  assert.equal(rejected.status, 400);
  assert.equal((await json<{ kind: string; error: string }>(rejected)).kind, "auth");
  assert.equal(await routing.apiKey("key-user", "openai"), "sk-first-key-AAAA");

  // 제공자에 닿지 못함 → network. 이전 키는 그대로 남는다
  provider = { fail: "getaddrinfo ENOTFOUND" };
  const unreachable = await call(
    "/api/model-keys/openai",
    owner,
    { apiKey: "sk-second-key-BBBB" },
    "PUT",
  );
  assert.equal(unreachable.status, 400);
  assert.equal((await json<{ kind: string }>(unreachable)).kind, "network");
  // 제공자가 판정을 주지 않음(5xx) 도 network
  provider = { status: 503 };
  assert.equal(
    (
      await json<{ kind: string }>(
        call("/api/model-keys/openai", owner, { apiKey: "sk-second-key-BBBB" }, "PUT"),
      )
    ).kind,
    "network",
  );
  assert.equal(await routing.apiKey("key-user", "openai"), "sk-first-key-AAAA");

  // 형식 오류는 제공자에게 묻지도 않는다
  provider = { status: 200 };
  const before = probed.length;
  for (const body of [{ apiKey: "short" }, { apiKey: "has space in key" }, { apiKey: 1234 }, {}]) {
    const bad = await call("/api/model-keys/openai", owner, body, "PUT");
    assert.equal(bad.status, 400);
    assert.equal((await json<{ kind: string }>(bad)).kind, "format");
  }
  // compatible 은 baseUrl 이 필요하고, 다른 제공자는 baseUrl 을 받지 않는다
  for (const [name, body] of [
    ["compatible", { apiKey: "sk-compat-key-CCCC" }],
    ["compatible", { apiKey: "sk-compat-key-CCCC", baseUrl: "ftp://x" }],
    ["anthropic", { apiKey: "sk-ant-key-DDDDDD", baseUrl: "http://llm.local/v1" }],
  ] as const) {
    const bad = await call(`/api/model-keys/${name}`, owner, body, "PUT");
    assert.equal((await json<{ kind: string }>(bad)).kind, "format");
  }
  assert.equal(probed.length, before, "형식 오류에서는 검증 호출이 나가면 안 된다");

  // 검증 통과 → 교체
  const replaced = await call(
    "/api/model-keys/openai",
    owner,
    { apiKey: "sk-second-key-BBBB" },
    "PUT",
  );
  assert.equal(replaced.status, 200);
  assert.equal(await routing.apiKey("key-user", "openai"), "sk-second-key-BBBB");

  const compat = await call(
    "/api/model-keys/compatible",
    owner,
    { apiKey: "sk-compat-key-CCCC", baseUrl: "http://llm.local/v1/" },
    "PUT",
  );
  assert.equal(compat.status, 200);
  assert.equal(probed.at(-1), "http://llm.local/v1/models");
  const after = await json<Row[]>(call("/api/model-keys", owner));
  assert.deepEqual(
    after.find((r) => r.provider === "compatible"),
    { provider: "compatible", status: "active", last4: "CCCC", baseUrl: "http://llm.local/v1" },
  );
  assert.equal(after.find((r) => r.provider === "openai")?.last4, "BBBB");
  // 키는 암호화돼 저장되고 응답 어디에도 평문이 없다
  const stored = await db.get<ModelAccount>("key-user", "model-accounts", "openai");
  assert.ok(stored && !JSON.stringify(stored).includes("sk-second-key-BBBB"));
  assert.ok(!JSON.stringify(after).includes("sk-"));
  // 소유자 격리
  const others = await json<Row[]>(call("/api/model-keys", as("someone-else")));
  assert.ok(others.every((r) => r.status === "none"));

  assert.equal((await call("/api/model-keys/openai", owner, undefined, "DELETE")).status, 200);
  const cleared = await json<Row[]>(call("/api/model-keys", owner));
  assert.equal(cleared.find((r) => r.provider === "openai")?.status, "none");
  assert.equal((await call("/api/model-keys/nope", owner, { apiKey: "x" }, "PUT")).status, 422);
});

// ---------------------------------------------------------------- 설정
test("설정: GET /settings 가 라우팅이 읽는 바로 그 기록이다 — 고정 모델·답변 방식이 배정을 바꾼다", async () => {
  const owner = as("settings-user");
  type Settings = {
    tier: { label: string; subscription: string | null; nextBillingAt: string | null };
    answerMode: string;
    autoEconomy: boolean;
    fixedModel: string | null;
    monthlyCapKrw: number | null;
    notifications: { approvals: boolean; weeklyReport: boolean };
    character: { enabled: boolean; intensity: string };
  };
  const initial = await json<Settings>(call("/api/settings", owner));
  assert.deepEqual(initial, {
    tier: { label: PERSONAL_TIER_LABEL, subscription: null, nextBillingAt: null },
    answerMode: "auto",
    autoEconomy: true,
    fixedModel: null,
    monthlyCapKrw: null,
    notifications: DEFAULT_NOTIFICATION_PREFS,
    character: DEFAULT_CHARACTER_PREFS,
  });
  const question = { text: "오늘 일정 알려줘" };
  assert.equal((await routing.forChat("settings-user", question)).decision.tier, 2);

  // 고정 모델 "4" → 채팅 실행 계획이 최고 모델로 바뀐다
  const fixed = await json<Settings>(
    call("/api/settings/model", owner, { fixedModel: "4", monthlyCapKrw: 5000 }, "PATCH"),
  );
  assert.equal(fixed.fixedModel, "4");
  assert.equal(fixed.monthlyCapKrw, 5000);
  const routed = await routing.forChat("settings-user", question);
  assert.equal(routed.decision.tier, 4);
  assert.equal(routed.model, "gw/top");
  // 옛 경로(/settings/routing)도 같은 기록을 본다 — 사본이 없다
  assert.equal(
    (await json<{ fixedTier?: number }>(call("/api/settings/routing", owner))).fixedTier,
    4,
  );
  assert.equal((await db.list("settings-user", "settings")).length, 1);

  // 고정 해제 · 상한 해제
  const cleared = await json<Settings>(
    call("/api/settings/model", owner, { fixedModel: null, monthlyCapKrw: null }, "PATCH"),
  );
  assert.equal(cleared.fixedModel, null);
  assert.equal(cleared.monthlyCapKrw, null);
  assert.equal((await routing.forChat("settings-user", question)).decision.tier, 2);
  // 가성비 자동 끔 → 주력으로 고정
  await call("/api/settings/model", owner, { autoEconomy: false }, "PATCH");
  assert.equal((await routing.forChat("settings-user", question)).decision.tier, 3);
  await call("/api/settings/model", owner, { autoEconomy: true }, "PATCH");

  // 답변 방식: device → 긴 질문도 기기, server → 기기 LLM 이 켜져 있어도 서버
  const long = {
    text: "다음 주 출장 준비물을 날씨와 일정에 맞춰 자세히 정리해서 알려줄 수 있을까?",
  };
  type Decision = { servedBy: string; tier: number };
  assert.equal((await json<Decision>(call("/api/route", owner, long))).servedBy, "server");
  await call("/api/settings/model", owner, { answerMode: "device" }, "PATCH");
  assert.equal((await json<Settings>(call("/api/settings", owner))).answerMode, "device");
  assert.equal((await json<Decision>(call("/api/route", owner, long))).servedBy, "device");
  // 도구가 필요한 일과 기기 실패는 «항상 기기» 여도 서버다
  assert.equal(
    (await json<Decision>(call("/api/route", owner, { ...long, needsTools: true }))).servedBy,
    "server",
  );
  assert.equal(
    (await json<Decision>(call("/api/route", owner, { ...long, deviceFailed: true }))).servedBy,
    "server",
  );
  await call("/api/settings/routing", owner, { deviceLlmEnabled: true }, "PATCH");
  await call("/api/settings/model", owner, { answerMode: "auto" }, "PATCH");
  assert.equal(
    (await json<Decision>(call("/api/route", owner, { text: "안녕" }))).servedBy,
    "device",
  );
  await call("/api/settings/model", owner, { answerMode: "server" }, "PATCH");
  assert.equal(
    (await json<Decision>(call("/api/route", owner, { text: "안녕" }))).servedBy,
    "server",
  );

  // 알림·캐릭터: 일부만 보내도 나머지는 지킨다
  const prefs = await json<Settings>(
    call(
      "/api/settings",
      owner,
      { notifications: { weeklyReport: false }, character: { intensity: "text" } },
      "PATCH",
    ),
  );
  assert.deepEqual(prefs.notifications, { approvals: true, weeklyReport: false });
  assert.deepEqual(prefs.character, { enabled: true, intensity: "text" });
  assert.equal(prefs.answerMode, "server", "화면 설정을 바꿔도 모델 설정은 그대로다");
  const off = await json<Settings>(
    call("/api/settings", owner, { character: { enabled: false } }, "PATCH"),
  );
  assert.deepEqual(off.character, { enabled: false, intensity: "text" });

  // 잘못된 값은 저장되지 않는다
  for (const body of [{ fixedModel: "5" }, { fixedModel: 4 }, { answerMode: "cloud" }])
    assert.equal((await call("/api/settings/model", owner, body, "PATCH")).status, 422);
  assert.equal(
    (await call("/api/settings", owner, { character: { intensity: "loud" } }, "PATCH")).status,
    422,
  );
  // 소유자 격리
  assert.equal(
    (await json<Settings>(call("/api/settings", as("settings-other")))).answerMode,
    "auto",
  );
});

test("사용량: 상한 대비 비율은 잴 수 있을 때만 — 못 재면 null(측정 중)", async () => {
  const owner = as("billing-user");
  type Usage = {
    costKrw: number;
    capKrw: number | null;
    percent: number | null;
    byok: boolean;
    savedKrw: number | null;
  };
  // 상한이 없으면 비율도 없다
  assert.deepEqual(await json<Usage>(call("/api/billing/usage", owner)), {
    costKrw: 0,
    capKrw: null,
    percent: null,
    byok: false,
    savedKrw: 0,
  });
  await call("/api/settings/model", owner, { monthlyCapKrw: 1000 }, "PATCH");
  await routing.record("billing-user", {
    tier: 3,
    model: "gw/main",
    tokensIn: 100_000,
    tokensOut: 50_000,
    scriptSaved: false,
    source: "platform",
    reason: "t",
  });
  const measured = await json<Usage>(call("/api/billing/usage", owner));
  assert.equal(measured.costKrw, 300); // 0.1M×1000 + 0.05M×4000
  assert.equal(measured.capKrw, 1000);
  assert.equal(measured.percent, 30);
  assert.equal(measured.savedKrw, 1200); // 기준선 1500 − 300
  // 상한을 넘어도 100 을 넘기지 않는다
  await call("/api/settings/model", owner, { monthlyCapKrw: 100 }, "PATCH");
  assert.equal((await json<Usage>(call("/api/billing/usage", owner))).percent, 100);
  // 단가 없는 사용분이 끼면 지출을 다 잰 것이 아니다 → 비율·절감액 모두 null
  await routing.record("billing-user", {
    tier: 3,
    model: "gw/unpriced",
    tokensIn: 10,
    tokensOut: 10,
    scriptSaved: false,
    source: "platform",
    reason: "t",
  });
  const measuring = await json<Usage>(call("/api/billing/usage", owner));
  assert.equal(measuring.percent, null);
  assert.equal(measuring.savedKrw, null);
  assert.equal(measuring.capKrw, 100);
  // 본인 키가 있으면 byok
  provider = { status: 200 };
  await call("/api/model-keys/anthropic", owner, { apiKey: "sk-ant-key-EEEE" }, "PUT");
  assert.equal((await json<Usage>(call("/api/billing/usage", owner))).byok, true);
});

// ---------------------------------------------------------------- 기억
test("기억: 분류·출처 문구 · PATCH 는 임베딩을 다시 계산 · MCP 문은 켤 때만 열린다", async () => {
  const owner = as("memory-user");
  type Fact = { id: string; text: string; category: string; sourceLabel: string; source: string };
  const coffee = await json<Fact>(
    call("/api/memories", owner, { text: "커피는 아이스 아메리카노를 좋아한다", source: "chat" }),
  );
  assert.equal(coffee.category, "preference");
  assert.equal(coffee.sourceLabel, "대화에서 학습");
  const office = await json<Fact>(
    call("/api/memories", owner, { text: "사무실은 서초동 법원 앞에 있다", source: "user" }),
  );
  assert.equal(office.category, "profile");
  assert.equal(office.sourceLabel, "직접 입력");
  await call("/api/memories", owner, { text: "올해 블로그 글 50편 발행이 목표", source: "user" });
  await call("/api/memories", owner, { text: "제목이 너무 길다고 했다", source: "feedback" });
  // 직접 고른 분류는 규칙보다 먼저다
  const chosen = await json<Fact>(
    call("/api/memories", owner, { text: "상속 사건을 주로 맡는다", category: "goal" }),
  );
  assert.equal(chosen.category, "goal");

  const all = await json<Fact[]>(call("/api/memories", owner));
  assert.equal(all.length, 5);
  assert.ok(all.every((m) => m.category && m.sourceLabel));
  const goals = await json<Fact[]>(call("/api/memories?category=goal", owner));
  assert.deepEqual(goals.map((m) => m.text).sort(), [
    "상속 사건을 주로 맡는다",
    "올해 블로그 글 50편 발행이 목표",
  ]);
  const feedback = await json<Fact[]>(call("/api/memories?category=feedback", owner));
  assert.deepEqual(
    feedback.map((m) => [m.text, m.sourceLabel]),
    [["제목이 너무 길다고 했다", "피드백에서 학습"]],
  );
  assert.equal((await call("/api/memories?category=nope", owner)).status, 422);
  // 검색 + 분류: 다른 분류의 것은 섞이지 않는다
  const found = await json<Fact[]>(
    call(`/api/memories?category=preference&q=${encodeURIComponent("커피 취향")}`, owner),
  );
  assert.deepEqual(
    found.map((m) => m.id),
    [coffee.id],
  );

  // 분류 열이 생기기 전의 옛 행(NULL)도 읽을 때 분류된다
  await db.sql("UPDATE memories SET category=NULL WHERE owner=$1 AND id=$2", [
    "memory-user",
    coffee.id,
  ]);
  const legacy = await json<Fact[]>(call("/api/memories?category=preference", owner));
  assert.deepEqual(
    legacy.map((m) => m.id),
    [coffee.id],
  );

  // PATCH: 문장을 고치면 새 문장으로 찾아진다 (임베딩 재계산)
  const patched = await call(
    `/api/memories/${office.id}`,
    owner,
    { text: "주차는 지하 2층 흰색 아이오닉 5" },
    "PATCH",
  );
  assert.equal(patched.status, 200);
  const updated = await json<Fact>(patched);
  assert.equal(updated.id, office.id);
  assert.equal(updated.text, "주차는 지하 2층 흰색 아이오닉 5");
  assert.equal(updated.source, "user");
  const car = await json<Fact[]>(
    call(`/api/memories?limit=1&q=${encodeURIComponent("차 어디에 세워뒀지")}`, owner),
  );
  assert.equal(car[0]?.id, office.id);
  const oldQuery = await json<Fact[]>(
    call(`/api/memories?limit=1&q=${encodeURIComponent("사무실 위치가 어디야")}`, owner),
  );
  assert.notEqual(oldQuery[0]?.text, "사무실은 서초동 법원 앞에 있다");
  assert.equal((await json<Fact[]>(call("/api/memories", owner))).length, 5);
  // 남의 기억은 고칠 수 없다 · 빈 문장은 안 된다
  assert.equal(
    (await call(`/api/memories/${office.id}`, as("memory-other"), { text: "가로챔" }, "PATCH"))
      .status,
    404,
  );
  assert.equal(
    (await call(`/api/memories/${office.id}`, owner, { text: "  " }, "PATCH")).status,
    422,
  );
  assert.equal(
    (await json<Fact[]>(call("/api/memories", owner))).find((m) => m.id === office.id)?.text,
    "주차는 지하 2층 흰색 아이오닉 5",
  );

  // MCP 문: 기본 닫힘, 켤 때만 열린다, 사용자별
  const door = "/api/memories/mcp-access";
  assert.deepEqual(await json(call(door, owner)), { enabled: false });
  assert.deepEqual(await json(call(door, owner, { enabled: true }, "PATCH")), { enabled: true });
  assert.deepEqual(await json(call(door, owner)), { enabled: true });
  assert.deepEqual(await json(call(door, as("memory-other"))), { enabled: false });
  assert.deepEqual(await json(call(door, owner, { enabled: false }, "PATCH")), { enabled: false });
  assert.equal((await call(door, owner, { enabled: "yes" }, "PATCH")).status, 422);
});

// ---------------------------------------------------------------- 스토어
test("스토어: 목록 추가 필드 · 재구독 복원/새로 시작 · 이미 구독 중 409 · 해지 예약 취소 · 종료", async () => {
  const admin = as(adminId);
  const pkg = await json<Pkg>(call("/api/admin/packages", admin, team("contract-legal")));
  const fresh = await json<Pkg>(
    call(
      "/api/admin/packages",
      admin,
      team("contract-new", {
        metrics: { published: 0, indexed: 0, ai_citations: 0 },
        reviewing: true,
        dataHandling: "의뢰인 자료는 국내 서버에만 둡니다",
      }),
    ),
  );
  const owner = as("store-user");
  const list = async (who = owner) => json<Pkg[]>(call("/api/store/packages", who));
  const mine = async () => json<Card[]>(call("/api/subscriptions/mine", owner));

  const listed = (await list()).find((p) => p.id === pkg.id) as Pkg;
  assert.equal(listed.subscribed, false);
  assert.equal(listed.roomId, null);
  assert.equal(listed.reviewing, false);
  assert.equal(listed.reportCadence, REPORT_CADENCE_LABELS.weekly);
  assert.equal(listed.dataHandling, PLATFORM_DATA_HANDLING);
  assert.equal(listed.conversionRate, 25); // 인용 2 / 발행 8
  assert.equal(listed.runtime, undefined, "비공개 실행 정보는 여전히 나가지 않는다");
  const reviewing = (await list()).find((p) => p.id === fresh.id) as Pkg;
  assert.equal(reviewing.reviewing, true);
  assert.equal(reviewing.dataHandling, "의뢰인 자료는 국내 서버에만 둡니다");
  assert.equal(reviewing.conversionRate, null, "발행 0건이면 전환율은 아직 잴 수 없다");
  // 심사 중인 팀은 구독할 수 없다
  assert.equal((await call("/api/subscriptions", owner, { packageId: fresh.id })).status, 409);

  // 구독 → subscribed · roomId, 다시 구독은 409
  const subscribed = await call("/api/subscriptions", owner, { packageId: pkg.id });
  assert.equal(subscribed.status, 200);
  const { subscription, roomId } = await json<{ subscription: Card; roomId: string }>(subscribed);
  assert.equal(subscription.paymentMethod, null);
  assert.equal(subscription.endsAt, null);
  assert.deepEqual(
    ((p) => [p?.subscribed, p?.roomId])((await list()).find((p) => p.id === pkg.id)),
    [true, roomId],
  );
  assert.equal(
    (await json<Pkg>(call("/api/store/packages/contract-legal", owner))).subscribed,
    true,
  );
  // 남에게는 구독 중이 아니다
  assert.equal((await list(as("store-other"))).find((p) => p.id === pkg.id)?.subscribed, false);
  for (const body of [{ packageId: pkg.id }, { packageId: pkg.id, restore: true }])
    assert.equal((await call("/api/subscriptions", owner, body)).status, 409);
  assert.equal((await mine()).length, 1);
  // 복원할 이전 구독이 없는데 restore → 새 방으로 바꿔치지 않고 실패
  assert.equal(
    (await call("/api/subscriptions", as("store-other"), { packageId: pkg.id, restore: true }))
      .status,
    409,
  );
  assert.equal((await rooms.list("store-other")).length, 0);

  // 해지 → 기간 말(endsAt) · 구독 중 아님 · 방 읽기 전용
  const cancelled = await json<Card>(
    call(`/api/subscriptions/${subscription.id}/cancel`, owner, {}),
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.endsAt, subscription.nextBillingAt);
  assert.equal((await list()).find((p) => p.id === pkg.id)?.subscribed, false);
  assert.equal((await list()).find((p) => p.id === pkg.id)?.roomId, null);
  assert.equal((await rooms.get("store-user", roomId)).archived, true);
  // 해지 예약 취소 → 다시 active, 방 풀림
  const resumed = await json<Card>(call(`/api/subscriptions/${subscription.id}/resume`, owner, {}));
  assert.equal(resumed.status, "active");
  assert.equal(resumed.endsAt, null);
  assert.equal((await rooms.get("store-user", roomId)).archived, false);
  assert.equal((await list()).find((p) => p.id === pkg.id)?.subscribed, true);
  // 남의 구독은 건드릴 수 없다
  assert.equal(
    (await call(`/api/subscriptions/${subscription.id}/resume`, as("store-other"), {})).status,
    404,
  );

  // 다시 해지 → restore: true 로 재구독 → 같은 방이 되살아난다
  await call(`/api/subscriptions/${subscription.id}/cancel`, owner, {});
  const restored = await call("/api/subscriptions", owner, { packageId: pkg.id, restore: true });
  assert.equal(restored.status, 200);
  const again = await json<{ subscription: Card; roomId: string }>(restored);
  assert.equal(again.roomId, roomId);
  assert.notEqual(again.subscription.id, subscription.id);
  assert.equal((await rooms.get("store-user", roomId)).archived, false);
  assert.equal((await rooms.list("store-user")).length, 1, "복원은 방을 새로 만들지 않는다");
  const cards = await mine();
  assert.equal(cards.find((s) => s.id === subscription.id)?.status, "ended");
  assert.equal(cards.find((s) => s.id === again.subscription.id)?.status, "active");
  // 끝난 구독은 되살릴 수 없다 · 구독 중에는 다시 구독 409
  assert.equal((await call(`/api/subscriptions/${subscription.id}/resume`, owner, {})).status, 409);
  assert.equal((await call("/api/subscriptions", owner, { packageId: pkg.id })).status, 409);

  // 해지 뒤 restore 없이 재구독 → 새 방에서 시작
  await call(`/api/subscriptions/${again.subscription.id}/cancel`, owner, {});
  const started = await json<{ roomId: string }>(
    call("/api/subscriptions", owner, { packageId: pkg.id, restore: false }),
  );
  assert.notEqual(started.roomId, roomId);
  assert.equal((await rooms.get("store-user", roomId)).archived, true);

  // 기간 말이 지난 해지 예약은 ended 로 보인다
  const lapsed = (await mine()).find((s) => s.id === again.subscription.id) as Card;
  assert.equal(lapsed.status, "cancelled");
  await db.put<Subscription>("store-user", "subscriptions", {
    ...(await db.get<Subscription>("store-user", "subscriptions", lapsed.id)),
    endsAt: new Date(Date.now() - DAY).toISOString(),
  } as Subscription);
  assert.equal((await mine()).find((s) => s.id === lapsed.id)?.status, "ended");

  // 설정 화면의 등급 줄이 구독을 따라간다
  const tier = (
    await json<{ tier: { label: string; subscription: string; nextBillingAt: string } }>(
      call("/api/settings", owner),
    )
  ).tier;
  assert.equal(tier.label, TEAM_TIER_LABEL);
  assert.equal(tier.subscription, "contract-legal 팀");
  assert.ok(Date.parse(tier.nextBillingAt) > Date.now());
});

test("스토어: 등급이 모자라면 403 + kind: tier, 방·구독은 만들어지지 않는다", async () => {
  const pkg = await json<Pkg>(
    call("/api/admin/packages", as(adminId), team("contract-gated", { requiredTier: "package" })),
  );
  const free = await accounts.createUser({ phone: "01055550001", password: "1234" });
  const paid = await accounts.createUser({
    phone: "01055550002",
    password: "1234",
    tier: "package",
  });
  const denied = await call("/api/subscriptions", as(free.id), { packageId: pkg.id });
  assert.equal(denied.status, 403);
  const body = await json<{ error: string; kind: string }>(denied);
  assert.equal(body.kind, "tier");
  assert.ok(body.error.length > 0);
  assert.equal((await catalog.mine(free.id)).length, 0);
  assert.equal((await rooms.list(free.id)).length, 0);
  assert.equal((await call("/api/subscriptions", as(paid.id), { packageId: pkg.id })).status, 200);
});

// ---------------------------------------------------------------- 연결: MCP
test("MCP: 목록에 도구 수·위험도별 수 · 연결 시험은 저장하지 않는다 · 인증 헤더는 암호화 저장", async () => {
  const owner = as("mcp-user");
  type Item = {
    id: string;
    headerNames: string[];
    toolCount: number;
    risks: { read: number; write: number; external: number };
  };
  // 시험: 도구 이름·위험도만, 저장 없음
  connected.length = 0;
  const tested = await call("/api/connections/mcp/test", owner, {
    url: "http://mcp.test/mcp",
    auth: { type: "header", name: "X-Api-Key", value: "test-only-secret" },
  });
  assert.equal(tested.status, 200);
  assert.deepEqual(await tested.json(), {
    tools: [
      { name: "doc_read", risk: "read" },
      { name: "doc_write", risk: "write" },
      { name: "doc_unknown", risk: "external" }, // 미선언 = 최고 등급
    ],
  });
  assert.deepEqual(connected[0]?.headers, { "X-Api-Key": "test-only-secret" });
  assert.deepEqual(await json(call("/api/connections/mcp", owner)), []);
  assert.equal((await db.list("mcp-user", "mcp-servers")).length, 0);
  // 헤더 인증인데 값이 없으면 422, OAuth 는 아직 없다고 분명히 말한다
  assert.equal(
    (
      await call("/api/connections/mcp/test", owner, {
        url: "http://mcp.test/mcp",
        auth: { type: "header", name: "X-Api-Key" },
      })
    ).status,
    422,
  );
  for (const path of ["/api/connections/mcp/test", "/api/connections/mcp"])
    assert.equal(
      (
        await call(path, owner, {
          name: "oauth",
          url: "http://mcp.test/mcp",
          auth: { type: "oauth" },
        })
      ).status,
      503,
    );
  assert.equal((await db.list("mcp-user", "mcp-servers")).length, 0);

  // 연결: auth 헤더는 암호화돼 저장되고, 커넥터에는 푼 값이 간다
  connected.length = 0;
  const added = await call("/api/connections/mcp", owner, {
    name: "docs",
    url: "http://mcp.test/mcp",
    auth: { type: "header", name: "Authorization", value: "Bearer very-secret-token" },
  });
  assert.equal(added.status, 200);
  const item = await json<Item>(added);
  assert.deepEqual(item.headerNames, ["Authorization"]);
  assert.equal(item.toolCount, 3);
  assert.deepEqual(item.risks, { read: 1, write: 1, external: 1 });
  assert.ok(!JSON.stringify(item).includes("very-secret-token"));
  assert.deepEqual(connected[0]?.headers, { Authorization: "Bearer very-secret-token" });
  const stored = await db.get<McpServer>("mcp-user", "mcp-servers", item.id);
  assert.ok(stored?.headersCiphertext);
  assert.equal(stored?.headers, undefined);
  assert.ok(!JSON.stringify(stored).includes("very-secret-token"));

  const listed = await json<Item[]>(call("/api/connections/mcp", owner));
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.toolCount, 3);
  assert.deepEqual(listed[0]?.risks, { read: 1, write: 1, external: 1 });
  assert.ok(!JSON.stringify(listed).includes("Ciphertext"));
  assert.ok(!JSON.stringify(listed).includes("very-secret-token"));
  // 요약이 없던 옛 연결(평문 헤더)도 세어서 보인다
  await db.put<McpServer>("mcp-user", "mcp-servers", {
    id: "legacy",
    name: "legacy",
    url: "http://mcp.test/legacy",
    headers: { "X-Old": "old-plain" },
    riskDefault: "read",
    createdAt: new Date().toISOString(),
  });
  const withLegacy = await json<Item[]>(call("/api/connections/mcp", owner));
  const legacy = withLegacy.find((s) => s.id === "legacy");
  assert.deepEqual(legacy?.headerNames, ["X-Old"]);
  assert.equal(legacy?.toolCount, 3);
  assert.deepEqual(legacy?.risks, { read: 2, write: 1, external: 0 }); // 미선언 → riskDefault(read)
  // 소유자 격리
  assert.deepEqual(await json(call("/api/connections/mcp", as("mcp-other"))), []);
});

// ---------------------------------------------------------------- 로그인·온보딩
test("초대 대기: 같은 번호는 한 번만 남고, 관리자만 본다", async () => {
  const post = (phone: unknown) =>
    app.request("/api/auth/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  for (const phone of ["010-7777-0001", "01077770001", "+82 10 7777 0001"]) {
    const response = await post(phone);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.equal((await post("01077770002")).status, 200);
  assert.equal((await post("12345")).status, 422);
  assert.equal((await post(undefined)).status, 422);
  const list = await json<{ id: string; requestedAt: string }[]>(
    call("/api/admin/waitlist", as(adminId)),
  );
  assert.deepEqual(
    list.map((w) => w.id),
    ["01077770001", "01077770002"],
  );
  assert.ok(list.every((w) => !Number.isNaN(Date.parse(w.requestedAt))));
  const user = await accounts.createUser({ phone: "01077770009", password: "1234" });
  assert.equal((await call("/api/admin/waitlist", as(user.id))).status, 403);
});

test("프로필: 전문 분야·지역을 저장한다", async () => {
  const user = await accounts.createUser({ phone: "01066660001", password: "1234" });
  const saved = await call(
    "/api/me/profile",
    as(user.id),
    { displayName: "김변호사", specialty: "상속 · 가사", region: "서울 서초" },
    "PATCH",
  );
  assert.equal(saved.status, 200);
  const me = await json<{ profile: Record<string, string> }>(call("/api/me", as(user.id)));
  assert.equal(me.profile.displayName, "김변호사");
  assert.equal(me.profile.specialty, "상속 · 가사");
  assert.equal(me.profile.region, "서울 서초");
  // 다른 항목만 고쳐도 남는다
  await call("/api/me/profile", as(user.id), { region: "부산" }, "PATCH");
  const next = await json<{ profile: Record<string, string> }>(call("/api/me", as(user.id)));
  assert.equal(next.profile.specialty, "상속 · 가사");
  assert.equal(next.profile.region, "부산");
});

test("탈퇴: deleteAfter = 지금 + 보존 기간 · 증적 기록 · 로그인 차단 · 기한 뒤 정리가 지우고 남긴다", async () => {
  const phone = "01088880001";
  await accounts.createUser({ phone, password: "pass1234" });
  const keeper = await accounts.createUser({ phone: "01088880002", password: "pass1234" });
  const login = () =>
    app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password: "pass1234" }),
    });
  const { token, user } = await json<{ token: string; user: { id: string } }>(login());
  // 지워져야 할 본인 데이터 + 남아야 할 남의 데이터
  await call("/api/me/profile", token, { displayName: "떠나는 사람" }, "PATCH");
  await memories.add(user.id, "떠나는 사람의 기억");
  await rooms.ensurePersonalRoom(user.id);
  await memories.add(keeper.id, "남는 사람의 기억");
  await rooms.ensurePersonalRoom(keeper.id);

  const before = Date.now();
  const requested = await call("/api/account/delete", token, {});
  assert.equal(requested.status, 200);
  const { deleteAfter } = await json<{ deleteAfter: string }>(requested);
  const expected = before + RETENTION_DAYS * DAY;
  assert.ok(Math.abs(Date.parse(deleteAfter) - expected) < 60_000);

  // 증적: 본인 감사 로그 + 삭제 뒤에도 남는 system 감사 로그
  const trail = (owner: string, action: string) =>
    db
      .list<AuditLog>(owner, "audit")
      .then((logs) => logs.filter((l) => l.action === action && l.actor === `user:${user.id}`));
  assert.equal((await trail(user.id, "account.delete_requested")).length, 1);
  assert.equal((await trail("system", "account.delete_requested")).length, 1);

  // 차단: 쓰던 세션은 끊기고, 로그인은 사유와 함께 거절된다
  assert.equal((await call("/api/me", token)).status, 401);
  const blocked = await login();
  assert.equal(blocked.status, 403);
  const reason = (await json<{ error: string }>(blocked)).error;
  assert.match(reason, /탈퇴/);
  assert.ok(reason.includes(deleteAfter.slice(0, 10)));
  // 틀린 비밀번호에는 탈퇴 여부를 알려주지 않는다
  const wrong = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: "wrong-pass" }),
  });
  assert.equal(wrong.status, 401);
  // 같은 요청을 다시 해도 기한은 밀리지 않는다
  assert.deepEqual(
    await accounts.requestDeletion(user.id, (owner, input) => rooms.audit(owner, input)),
    { deleteAfter },
  );
  assert.equal((await trail("system", "account.delete_requested")).length, 1);

  // 기한 전의 정리는 아무것도 지우지 않는다
  const deps = {
    memories,
    audit: (owner: string, input: Parameters<Rooms["audit"]>[1]) => rooms.audit(owner, input),
  };
  assert.deepEqual(await accounts.purgeDeleted({ ...deps, now: Date.parse(deleteAfter) - 1 }), []);
  assert.ok(await accounts.userById(user.id));
  assert.equal((await memories.list(user.id)).length, 1);

  // 기한이 지나면 지우고, 무엇을 지웠는지 돌려준다
  const reports = await accounts.purgeDeleted({ ...deps, now: Date.parse(deleteAfter) + 1 });
  assert.equal(reports.length, 1);
  const report = reports[0];
  assert.equal(report?.userId, user.id);
  assert.equal(report?.error, undefined);
  assert.equal(report?.memories, 1);
  assert.equal(report?.records.profiles, 1);
  assert.equal(report?.records.rooms, 1);
  assert.equal(report?.records.audit, 1);
  assert.equal(await accounts.userById(user.id), null);
  assert.equal(await accounts.userByPhone(phone), null);
  assert.equal((await db.list(user.id, "rooms")).length, 0);
  assert.equal((await db.list(user.id, "profiles")).length, 0);
  assert.equal((await memories.list(user.id)).length, 0);
  assert.equal((await trail("system", "account.purged")).length, 1);
  assert.equal((await trail("system", "account.delete_requested")).length, 1);
  // 다시 돌려도 지울 것이 없다
  assert.deepEqual(await accounts.purgeDeleted({ ...deps, now: Date.parse(deleteAfter) + 2 }), []);
  // 남의 데이터는 그대로다
  assert.ok(await accounts.userById(keeper.id));
  assert.equal((await memories.list(keeper.id)).length, 1);
  assert.equal((await db.list(keeper.id, "rooms")).length, 1);
  // 지워진 번호로는 로그인할 계정이 없다
  assert.equal((await login()).status, 401);
  assert.equal(
    ((await db.list<User>("system", "users")) as User[]).some((u) => u.phone === phone),
    false,
  );
});
