// 구독 사용 — PC 러너 열쇠(보안 경로)와 대화 프롬프트
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { subscriptionPrompt } from "../apps/server/src/engine/conversation.ts";
import { Subscriptions } from "../apps/server/src/osiri/subscription.ts";

let db: Store, directory: string, server: Server, subs: Subscriptions, url: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-sub-"));
  db = await createStore({ dataDir: join(directory, "db") });
  subs = new Subscriptions(db, { dir: join(directory, "subs") });
  server = createServer();
  subs.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/subscription/runner`;
});
after(async () => {
  server.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

/** 러너처럼 접속해 hello 를 보내고, 서버가 처음 돌려준 것(ready 메시지 또는 닫힘 코드)을 받는다 */
const hello = (key: string) =>
  new Promise<string>((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", key, cwd: "/work" })));
    ws.on("message", (raw) => {
      resolve(JSON.parse(String(raw)).t);
      ws.close();
    });
    ws.on("close", (code) => resolve(String(code)));
  });

test("PC runner key: only the latest issued key for that owner connects", async () => {
  const owner = "user-a";
  assert.equal(await hello("bm9ib2R5.guess"), "4003");
  const old = await subs.issueRunnerKey(owner);
  const key = await subs.issueRunnerKey(owner);
  assert.equal(await hello(old), "4003", "re-issuing revokes the old key");
  // 다른 사람 열쇠의 비밀 부분을 붙여도 그 사람 소유자로 들어가지 못한다
  const other = await subs.issueRunnerKey("user-b");
  assert.equal(await hello(`${key.split(".")[0]}.${other.split(".")[1]}`), "4003");
  assert.equal(await hello(key), "ready");
  assert.equal((await subs.view(owner)).runnerKeyIssued, true);
});

test("server place cannot be activated without SUBSCRIPTION_IMAGE", async () => {
  await assert.rejects(
    subs.update("user-c", { active: true, place: "server" }),
    /SUBSCRIPTION_IMAGE/,
  );
  assert.equal((await subs.update("user-c", { active: true, place: "pc" })).active, true);
});

test("subscription prompt carries recent turns and ends on the user's message", () => {
  const prompt = subscriptionPrompt("PERSONA", [
    { id: "1", role: "user", content: "첫 질문" },
    { id: "2", role: "assistant", content: "첫 답" },
    { id: "3", role: "tool", content: "{}", toolCallId: "t" },
    { id: "4", role: "user", content: "둘째 질문" },
  ]);
  assert.match(prompt, /^PERSONA/);
  assert.ok(prompt.endsWith("사용자: 둘째 질문"));
  assert.ok(!prompt.includes("{}"), "tool results are not replayed");
});
