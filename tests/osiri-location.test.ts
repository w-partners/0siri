// 사용자 위치: 본인 것만, 끄면 지우고 받지 않으며, 오래된 위치는 답에 쓰지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  LOCATION_CURRENT_MS,
  LOCATION_FRESH_MS,
  locationNote,
  locationRoutes,
  weatherAt,
} from "../apps/server/src/osiri/location.ts";

let db: Store, directory: string;
const appAs = (owner: string) => {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", owner);
    await next();
  });
  return app.route("/api", locationRoutes(db));
};
const send = (owner: string, method: string, body: unknown) =>
  appAs(owner).request("/api/location", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const SEOUL = { lat: 37.56654, lng: 126.97796, accuracy: 12, address: "서울특별시 중구 태평로1가" };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-location-"));
  db = await createStore({ dataDir: join(directory, "db") });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("올린 위치가 프롬프트 한 줄이 되고, 남에게는 없다", async () => {
  assert.equal((await send("me", "PUT", SEOUL)).status, 200);
  const note = await locationNote(db, "me");
  assert.match(note ?? "", /서울특별시 중구 태평로1가/);
  assert.match(note ?? "", /lat 37\.56654/);
  assert.equal(await locationNote(db, "other"), undefined);
  assert.equal((await send("me", "PUT", { lat: 91, lng: 0 })).status >= 400, true);
});

test("오래된 위치는 쓰지 않는다", async () => {
  const later = Date.now() + LOCATION_FRESH_MS + 60_000;
  assert.equal(await locationNote(db, "me", later), undefined);
});

test("15분 넘은 위치는 «지금 위치» 가 아니라 «N분 전 마지막 위치» 로 넘긴다", async () => {
  assert.match((await locationNote(db, "me")) ?? "", /^User's current location/);
  const stale = await locationNote(db, "me", Date.now() + LOCATION_CURRENT_MS + 60_000);
  assert.match(stale ?? "", /^User's LAST KNOWN location/);
  assert.match(stale ?? "", /never state it as their current location/);
});

test("끄면 좌표를 지우고, 꺼진 동안 올린 위치는 저장하지 않는다", async () => {
  await send("me", "PATCH", { enabled: false });
  assert.equal(await locationNote(db, "me"), undefined);
  await send("me", "PUT", SEOUL);
  const stored = await (await appAs("me").request("/api/location")).json();
  assert.deepEqual(stored, { id: "me", enabled: false });
  await send("me", "PATCH", { enabled: true });
  await send("me", "PUT", SEOUL);
  assert.ok(await locationNote(db, "me"));
});

test("날씨: Open-Meteo 에 좌표·지금/오늘·내일을 묻고, 실패는 오류로 낸다", async () => {
  let asked = "";
  const ok = (async (url: URL) => {
    asked = String(url);
    return new Response(JSON.stringify({ current: { temperature_2m: 21.5 } }));
  }) as unknown as typeof fetch;
  const result = await weatherAt(35.15874, 129.16035, ok);
  assert.equal(result.source, "Open-Meteo");
  assert.match(asked, /latitude=35\.15874&longitude=129\.16035/);
  assert.match(asked, /forecast_days=2/);
  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(weatherAt(0, 0, down), /503/);
});
