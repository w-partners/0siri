// 말풍선 시각: 새 메시지에만 찍고(화면이 처음 본 시각, 미래는 지금으로), 시각 없던 옛 메시지는 비우고, 한 번 찍은 시각은 바뀌지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const put = async (body: object) =>
  (
    await app.request("/api/conversation?threadId=room-1", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(body),
    })
  ).json() as Promise<{ times: Record<string, string> }>;
const msg = (id: string, role = "user") => ({ id, role, content: `${id} 글` });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-conversation-times-"));
  db = await createStore();
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  }));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("새 메시지만 시각을 받고, 옛 메시지는 비우고, 찍힌 시각은 그대로", async () => {
  // 시각 기능 전부터 있던 대화 — 샘플 모드 세션의 주인은 local-user
  await db.put("local-user", "conversations", { id: "room-1", messages: [msg("old")] });
  const sent = "2026-10-11T10:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";
  const first = await put({
    messages: [msg("old"), msg("a"), msg("b", "assistant")],
    times: { old: sent, a: sent, b: future },
  });
  assert.equal(first.times.old, undefined, "시각 없던 옛 메시지는 비운다");
  assert.equal(first.times.a, sent, "화면이 처음 본 시각");
  assert.ok(first.times.b < future, "미래 시각은 지금으로");
  const second = await put({
    messages: [msg("old"), msg("a"), msg("b", "assistant"), msg("c")],
    times: { a: "2020-01-01T00:00:00.000Z" },
  });
  assert.equal(second.times.a, sent, "한 번 찍은 시각은 안 바뀐다");
  assert.equal(second.times.b, first.times.b);
  assert.ok(second.times.c);
  const got = (await (
    await app.request("/api/conversation?threadId=room-1", { headers: headers() })
  ).json()) as { times: Record<string, string> };
  assert.deepEqual(got.times, second.times);
});
