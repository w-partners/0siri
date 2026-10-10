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
import { type SubscriptionPrefs, Subscriptions } from "../apps/server/src/osiri/subscription.ts";

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
async function fakeRunner(target: string, key: string, calls: string[], seen: string[] = []) {
  const ws = new WebSocket(target);
  const agents = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === "data") agents.get(msg.id)?.enqueue(new TextEncoder().encode(msg.d));
    if (msg.t === "mkdir") calls.push(`mkdir ${msg.path}`);
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
        newSession: async ({ cwd, mcpServers }) => {
          calls.push("new");
          seen.push(`${cwd} ${mcpServers.map((m) => m.name).join(",")}`);
          return { sessionId: `s${calls.length}` };
        },
        resumeSession: async ({ sessionId }) => {
          calls.push(`resume ${sessionId}`);
          if (sessionId === "gone") throw new Error("no such session");
          return {};
        },
        // 사용자가 tmux 에서 쓰던 세션 — ACP session/list 로 보인다
        listSessions: async () => ({
          sessions: [
            {
              sessionId: "tmux-1",
              cwd: "/home/me/proj",
              title: "블로그 정리",
              updatedAt: "2026-10-10",
            },
          ],
        }),
        cancel: async () => {},
        prompt: async ({ sessionId, prompt }) => {
          const text = prompt[0]?.type === "text" ? prompt[0].text : "";
          calls.push(`prompt ${sessionId} ${text}`);
          if (text.includes("파일을 써")) {
            const { outcome } = await agent.requestPermission({
              sessionId,
              toolCall: {
                toolCallId: "w1",
                title: "메모.md 쓰기",
                kind: "edit",
                rawInput: { path: "메모.md" },
              },
              options: [
                { optionId: "yes", name: "허용", kind: "allow_once" },
                { optionId: "no", name: "거절", kind: "reject_once" },
              ],
            });
            calls.push(
              `permission ${outcome.outcome === "selected" ? outcome.optionId : "cancelled"}`,
            );
          }
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
        { threadId: "t1", brief: "B", opening: `OPEN ${latest}`, latest },
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

/** 옵션이 다른 Subscriptions 를 자기 HTTP 서버와 함께 띄운다 */
async function standUp(options: Partial<ConstructorParameters<typeof Subscriptions>[1]> = {}) {
  const s = new Subscriptions(db, { dir: join(directory, "subs"), ...options });
  const http = createServer();
  s.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    s,
    target: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/api/subscription/runner`,
    close: () => http.close(),
  };
}
const collect = async (run: (onText: (t: string) => void) => Promise<unknown>) => {
  let said = "";
  const result = await run((t) => {
    said += t;
  });
  return { result, said };
};

test("agent write/exec requests go to the app approval gate; no gate or a refusal means reject", async () => {
  const owner = "user-e";
  const prefs = await subs.update(owner, { active: true, place: "pc", provider: "claude" });
  const asked: string[] = [];
  let answer = true;
  const { s, target, close } = await standUp({
    gate: async (_owner, ask) => {
      asked.push(
        `${ask.actor} ${ask.threadId} ${ask.kind} ${ask.title} ${JSON.stringify(ask.input)}`,
      );
      return answer;
    },
  });
  const calls: string[] = [];
  const runner = await fakeRunner(target, await s.issueRunnerKey(owner), calls);
  const turn = (latest: string) =>
    s.ask(
      owner,
      prefs,
      { threadId: "t-gate", brief: "B", opening: latest, latest },
      () => {},
      new AbortController().signal,
    );
  await turn("파일을 써 줘");
  answer = false;
  await turn("파일을 써 줘 다시");
  assert.deepEqual(asked, [
    '영시리 t-gate edit 메모.md 쓰기 {"path":"메모.md"}',
    '영시리 t-gate edit 메모.md 쓰기 {"path":"메모.md"}',
  ]);
  assert.ok(calls.includes("permission yes") && calls.includes("permission no"));
  runner.close();
  close();

  // 게이트가 없는 구성은 전부 거절(fail-closed)
  const bare = await standUp();
  const calls2: string[] = [];
  const runner2 = await fakeRunner(bare.target, await bare.s.issueRunnerKey(owner), calls2);
  await bare.s.ask(
    owner,
    prefs,
    { threadId: "t-gate2", brief: "B", opening: "파일을 써", latest: "파일을 써" },
    () => {},
    new AbortController().signal,
  );
  assert.ok(calls2.includes("permission no"));
  runner2.close();
  bare.close();
});

test("a room attaches to a session the user ran in tmux on their PC: resumed every turn, never silently replaced", async () => {
  const owner = "user-tmux";
  const prefs = await subs.update(owner, { active: true, place: "pc", provider: "claude" });
  const { s, target, close } = await standUp();
  const calls: string[] = [];
  const runner = await fakeRunner(target, await s.issueRunnerKey(owner), calls);
  const listed = await s.pcSessions(owner);
  assert.deepEqual(
    listed.map((x) => `${x.sessionId} ${x.title}`),
    ["tmux-1 블로그 정리"],
  );
  await assert.rejects(
    s.attachSession(owner, "room-x", { sessionId: "nope", cwd: "/x" }),
    /찾지 못했습니다/,
  );
  await s.attachSession(owner, "room-x", { sessionId: "tmux-1", cwd: "/home/me/proj" });
  assert.deepEqual(await s.attachedSession(owner, "room-x"), {
    sessionId: "tmux-1",
    cwd: "/home/me/proj",
  });
  const turn = (latest: string) =>
    s.ask(
      owner,
      prefs,
      { threadId: "room-x", brief: "영시리 지시", opening: latest, latest },
      () => {},
      new AbortController().signal,
    );
  assert.equal((await turn("이어서 해 줘")).session, "resumed");
  await turn("하나 더");
  assert.deepEqual(
    calls.filter((c) => /^(new|resume|prompt)/.test(c)),
    [
      "resume tmux-1",
      "prompt tmux-1 [지시가 바뀌었습니다 — 지금부터 아래 지시를 따른다]\n영시리 지시\n\n이어서 해 줘",
      "resume tmux-1", // tmux 에서 친 말까지 알도록 매 턴 다시 잇는다
      "prompt tmux-1 하나 더",
    ],
    "첫 턴에 영시리 지시를 한 번 알리고, 새 세션은 만들지 않는다",
  );

  // 그 세션이 사라졌으면 새 세션으로 바꿔치지 않고 실패한다
  await s.attachSession(owner, "room-y", { sessionId: "tmux-1", cwd: "/home/me/proj" });
  await db.put(owner, "subscriptionSessions", {
    ...(await db.get(owner, "subscriptionSessions", "room-y")),
    id: "room-y",
    sessionId: "gone",
  });
  await assert.rejects(turn2(s, owner, prefs, "room-y"), /잇지 못했습니다/);
  assert.ok(!calls.includes("new"));
  await s.detachSession(owner, "room-y");
  assert.equal(await s.attachedSession(owner, "room-y"), null);
  runner.close();
  close();
});
const turn2 = (s: Subscriptions, owner: string, prefs: SubscriptionPrefs, threadId: string) =>
  s.ask(
    owner,
    prefs,
    { threadId, brief: "B", opening: "x", latest: "x" },
    () => {},
    new AbortController().signal,
  );

test("team roles: one session per role in teams/<slug>, 0Siri MCP attached, new instructions announced", async () => {
  const owner = "user-f";
  const prefs = await subs.update(owner, { active: true, place: "pc", provider: "codex" });
  const { s, target, close } = await standUp({
    mcpServers: async (_owner, threadId) => [
      { type: "http", name: "0siri", url: `https://x/api/mcp?thread=${threadId}`, headers: [] },
    ],
  });
  const calls: string[] = [];
  const seen: string[] = [];
  const runner = await fakeRunner(target, await s.issueRunnerKey(owner), calls, seen);
  const llm = s.teamLlm(owner, prefs, { roomId: "r1", slug: "legal-marketing" });
  assert.equal(await llm("drafter", 3, "초안 담당", "글 1"), "답");
  assert.equal(await llm("drafter", 3, "초안 담당", "글 2"), "답");
  assert.equal(await llm("reviewer", 3, "검수 담당", "검토 1"), "답");
  assert.equal(await llm("drafter", 3, "초안 담당 + 스킬", "글 3"), "답");
  assert.deepEqual(calls, [
    "spawn",
    "mkdir teams/legal-marketing",
    "new",
    "prompt s3 초안 담당\n\n글 1",
    "prompt s3 글 2",
    "mkdir teams/legal-marketing",
    "new",
    "prompt s7 검수 담당\n\n검토 1",
    "prompt s3 [지시가 바뀌었습니다 — 지금부터 아래 지시를 따른다]\n초안 담당 + 스킬\n\n글 3",
  ]);
  assert.deepEqual(seen, [
    "/work/teams/legal-marketing 0siri",
    "/work/teams/legal-marketing 0siri",
  ]);
  assert.ok(await db.get(owner, "subscriptionSessions", "team:r1:drafter"));

  // 유휴 정리: 쓰지 않는 어댑터를 닫는다 → 다음 호출은 같은 세션을 resume
  assert.deepEqual(await s.reap(Date.now() + 31 * 60_000), { adapters: 1, containers: 0 });
  calls.length = 0;
  assert.equal(await llm("drafter", 3, "초안 담당 + 스킬", "글 4"), "답");
  assert.deepEqual(calls, ["spawn", "resume s3", "prompt s3 글 4"]);
  runner.close();
  close();
});
