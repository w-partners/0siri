// 0SIRI-SPEC §22-9: 라우팅 로그에서 티어 배정 확인, BYOK 잘못된 키 거절, 월 상한 억제, OAuth 기본 닫힘.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Routing, routingRoutes } from "../apps/server/src/osiri/routing.ts";
import { DEVICE_FALLBACK_REASON } from "../packages/domain/src/osiri.ts";

let db: Store, directory: string, routing: Routing, rooms: Rooms;
let app: Hono<{ Variables: { owner: string } }>;
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
const call = (path: string, owner: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-routing-"));
  db = await createStore({ dataDir: join(directory, "db") });
  rooms = new Rooms(db, new EventBus());
  routing = new Routing(db, rooms, env);
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", routingRoutes(routing, env));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("티어 배정 규칙 — 짧은 잡담 2, 초안 3, 전략/검수 4, 도구 호출은 서버, 기기 실패는 2 + 서버 배지", async () => {
  const route = async (body: unknown) =>
    (await (await call("/api/route", "u1", body)).json()) as {
      tier: number;
      model: string;
      reason: string;
      badge: string;
    };
  assert.equal((await route({ text: "안녕 오늘 뭐해" })).tier, 2);
  assert.equal((await route({ text: "상속세 절세 전략을 비교 분석해줘" })).tier, 4);
  assert.equal((await route({ text: "블로그 초안", kind: "draft" })).tier, 3);
  assert.equal((await route({ text: "검수해", kind: "review" })).tier, 4);
  assert.equal(
    (await route({ text: "안녕", needsTools: true })).tier,
    3,
    "도구 호출은 무조건 서버",
  );
  const fallback = await route({ text: "안녕", deviceFailed: true });
  assert.equal(fallback.tier, 2);
  assert.equal(fallback.badge, "서버에서 답함");
  assert.equal(fallback.reason, DEVICE_FALLBACK_REASON);
  assert.equal(fallback.model, "gw/light");
  // 기기 LLM 플래그가 켜지면 짧은 잡담은 티어 1
  await call("/api/settings/routing", "u1", { deviceLlmEnabled: true }, "PATCH");
  const device = await route({ text: "안녕" });
  assert.equal(device.tier, 1);
  assert.equal(device.badge, "기기에서 답함");
  await call("/api/settings/routing", "u1", { deviceLlmEnabled: false, fixedTier: 4 }, "PATCH");
  assert.equal((await route({ text: "안녕" })).tier, 4, "난이도 고정");
  await call("/api/settings/routing", "u1", { fixedTier: null }, "PATCH");
});

test("사용량·절감액 — 기준선은 최고 모델, 월 상한 도달 시 상향 억제 + 알림 1회", async () => {
  await routing.record("u2", {
    tier: 2,
    model: "gw/light",
    tokensIn: 1000,
    tokensOut: 500,
    scriptSaved: false,
    source: "platform",
    reason: "r",
  });
  await routing.record("u2", {
    tier: 3,
    model: "gw/main",
    tokensIn: 1000,
    tokensOut: 500,
    scriptSaved: false,
    source: "platform",
    reason: "r",
  });
  await routing.record("u2", {
    tier: 0,
    model: "device",
    tokensIn: 0,
    tokensOut: 0,
    scriptSaved: true,
    source: "device",
    reason: "script",
  });
  const usage = (await (await call("/api/usage", "u2")).json()) as {
    costKrw: number;
    baselineKrw: number;
    savedKrw: number;
    savingsStatus: string;
    scriptSavedCalls: number;
  };
  // light: 0.1+0.2=0.3, main: 1+2=3 → 3.3 ; baseline top: (5+10)*2 = 30
  assert.equal(usage.costKrw.toFixed(2), "3.30");
  assert.equal(usage.baselineKrw, 30);
  assert.equal(usage.savedKrw.toFixed(2), "26.70");
  assert.equal(usage.savingsStatus, "measured");
  assert.equal(usage.scriptSavedCalls, 1);
  // 단가표 없으면 "측정 중"
  const measuring = await new Routing(db, rooms, { ...env, MODEL_PRICES_KRW: undefined }).month(
    "u2",
  );
  assert.equal(measuring.savingsStatus, "measuring");
  assert.equal(measuring.savedKrw, null);

  // 월 상한 3원 → 이미 넘었다 → 상향 억제
  await call("/api/settings/routing", "u2", { monthlyCapKrw: 3 }, "PATCH");
  const capped = (await (
    await call("/api/route", "u2", { text: "상속세 절세 전략을 비교 분석해줘" })
  ).json()) as { tier: number; capped: boolean; reason: string };
  assert.equal(capped.tier, 2);
  assert.equal(capped.capped, true);
  assert.match(capped.reason, /월 상한/);
  // 상한을 넘기는 기록에서 알림 1회
  await call("/api/settings/routing", "u3", { monthlyCapKrw: 1 }, "PATCH");
  await routing.record("u3", {
    tier: 3,
    model: "gw/main",
    tokensIn: 1000,
    tokensOut: 0,
    scriptSaved: false,
    source: "platform",
    reason: "r",
  });
  await routing.record("u3", {
    tier: 3,
    model: "gw/main",
    tokensIn: 1000,
    tokensOut: 0,
    scriptSaved: false,
    source: "platform",
    reason: "r",
  });
  const notices = (await rooms.activities("u3")).filter((a) => /상한/.test(a.title));
  assert.equal(notices.length, 1);
  // BYOK 호출은 플랫폼 비용 0
  const byok = await routing.record("u2", {
    tier: 4,
    model: "gw/top",
    tokensIn: 1000,
    tokensOut: 1000,
    scriptSaved: false,
    source: "byok",
    reason: "r",
  });
  assert.equal(byok.costKrw, 0);
});

test("BYOK — 검증 호출 실패(인증/한도/네트워크)는 저장 안 함, 성공 시 끝 4자리만, OAuth 기본 닫힘", async () => {
  const fakeFetch = (status: number) =>
    (async () => new Response("{}", { status })) as unknown as typeof fetch;
  await assert.rejects(
    routing.connectAccount("u4", "openai", "sk-badkey-0000", fakeFetch(401)),
    /인증 실패/,
  );
  await assert.rejects(
    routing.connectAccount("u4", "openai", "sk-badkey-0000", fakeFetch(429)),
    /한도/,
  );
  await assert.rejects(
    routing.connectAccount("u4", "openai", "sk-badkey-0000", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch),
    /네트워크/,
  );
  assert.equal((await routing.accounts("u4")).length, 0);
  const saved = await routing.connectAccount(
    "u4",
    "anthropic",
    "sk-ant-goodkey-7890",
    fakeFetch(200),
  );
  assert.equal(saved.last4, "7890");
  assert.ok(!("keyCiphertext" in saved));
  const stored = (await db.get<{ keyCiphertext: string }>("u4", "model-accounts", "anthropic")) as {
    keyCiphertext: string;
  };
  assert.ok(!stored.keyCiphertext.includes("goodkey"), "평문 저장 금지");
  assert.equal(await routing.apiKey("u4", "anthropic"), "sk-ant-goodkey-7890");
  const listed = (await (await call("/api/connections/model-account", "u4")).json()) as {
    id: string;
    last4: string;
  }[];
  assert.deepEqual(
    listed.map((a) => [a.id, a.last4]),
    [["anthropic", "7890"]],
  );
  assert.equal(
    ((await (await call("/api/connections/model-account", "u5")).json()) as unknown[]).length,
    0,
    "소유자 격리",
  );
  // 실제 라우트는 fetch 를 쓴다 — 가짜 base URL 로 네트워크 오류 → 502
  const viaRoute = await call("/api/connections/model-account", "u4", {
    provider: "openai",
    apiKey: "sk-whatever-1234",
  });
  assert.equal(viaRoute.status, 502);
  assert.equal((await call("/api/connections/model-account/oauth", "u4", {})).status, 403);
  assert.equal(
    (await call("/api/connections/model-account/anthropic", "u4", undefined, "DELETE")).status,
    200,
  );
  assert.equal((await routing.accounts("u4")).length, 0);
});
