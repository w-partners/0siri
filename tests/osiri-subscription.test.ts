// 구독 사용 — PC 러너 열쇠(보안 경로)와 대화 프롬프트
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
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

/** 가짜 PC 러너 — 서버가 «open» 하면 이 프로세스 안의 가짜 ACP 에이전트로 이어 준다 */
async function fakeRunner(target: string, key: string, calls: string[]) {
  const ws = new WebSocket(target);
  const agents = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === "data") agents.get(msg.id)?.enqueue(new TextEncoder().encode(msg.d));
    if (msg.t !== "open") return;
    calls.push("spawn");
    const input = new ReadableStream<Uint8Array>({ start: (c) => void agents.set(msg.id, c) });
    const output = new WritableStream<Uint8Array>({
      write: (chunk) =>
        ws.send(JSON.stringify({ t: "data", id: msg.id, d: new TextDecoder().decode(chunk) })),
    });
    const agent: acp.AgentSideConnection = new acp.AgentSideConnection(
      () => ({
        initialize: async () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }),
        authenticate: async () => ({}),
        newSession: async () => {
          calls.push("new");
          return { sessionId: `s${calls.length}` };
        },
        resumeSession: async ({ sessionId }) => {
          calls.push(`resume ${sessionId}`);
          return {};
        },
        cancel: async () => {},
        prompt: async ({ sessionId, prompt }) => {
          const text = prompt[0]?.type === "text" ? prompt[0].text : "";
          calls.push(`prompt ${sessionId} ${text}`);
          await agent.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "답" } },
          });
          return { stopReason: "end_turn" };
        },
      }),
      acp.ndJsonStream(output, input),
    );
  });
  await new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", key, cwd: "/work" })));
    ws.once("message", resolve);
  });
  return ws;
}

test("one ACP session per chat thread: kept across turns, resumed after a restart", async () => {
  const owner = "user-d";
  const prefs = await subs.update(owner, { active: true, place: "pc", provider: "codex" });
  const calls: string[] = [];
  const runner = await fakeRunner(url, await subs.issueRunnerKey(owner), calls);
  const ask = (s: Subscriptions, latest: string) => {
    let said = "";
    return s
      .ask(
        owner,
        prefs,
        { threadId: "t1", opening: `OPEN ${latest}`, latest },
        (t) => (said += t),
        new AbortController().signal,
      )
      .then((r) => ({ ...r, said }));
  };
  assert.deepEqual(await ask(subs, "하나"), { session: "new", said: "답" });
  assert.deepEqual(await ask(subs, "둘"), { session: "live", said: "답" });
  assert.deepEqual(
    calls,
    ["spawn", "new", "prompt s2 OPEN 하나", "prompt s2 둘"],
    "one process, one session; later turns send only the new message",
  );

  // 서버가 다시 뜬 것처럼: 새 Subscriptions 가 같은 DB 에서 저장된 세션 ID 로 이어 붙인다
  runner.close();
  const restarted = new Subscriptions(db, { dir: join(directory, "subs") });
  const server2 = createServer();
  restarted.attach(server2);
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  calls.length = 0;
  const runner2 = await fakeRunner(
    `ws://127.0.0.1:${(server2.address() as AddressInfo).port}/api/subscription/runner`,
    await restarted.issueRunnerKey(owner),
    calls,
  );
  assert.deepEqual(await ask(restarted, "셋"), { session: "resumed", said: "답" });
  assert.deepEqual(calls, ["spawn", "resume s2", "prompt s2 셋"]);
  runner2.close();
  server2.close();
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
