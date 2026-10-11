// 내 PC tmux 창 붙이기(ACP): 그 창 폴더의 최신 세션을 load 해 잇고, 기록을 방에 보여 주고, 파일을 주고받는다
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
import { Panes, paneFileRoutes } from "../apps/server/src/osiri/panes.ts";
import { Subscriptions } from "../apps/server/src/osiri/subscription.ts";

const PANE = { target: "work:1.0", cli: "claude" as const, cwd: "/home/me/proj" };
let db: Store, directory: string, server: Server, subs: Subscriptions, ws: WebSocket;
const log: string[] = [];
/** 그 세션 파일에 쌓인 말 — tmux 에서 친 말도 여기 더해진다(같은 세션 파일을 공유) */
const sessionFile: { role: "user" | "agent"; text: string }[] = [
  { role: "user", text: "블로그 글 3개 정리해 줘" },
  { role: "agent", text: "3개 정리했습니다" },
];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-panes-"));
  db = await createStore({ dataDir: join(directory, "db") });
  subs = new Subscriptions(db, { dir: join(directory, "subs") });
  server = createServer();
  subs.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/subscription/runner`;
  ws = await fakeRunner(url, await subs.issueRunnerKey("me"));
});
after(async () => {
  ws.close();
  server.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

/** 가짜 PC 러너: tmux 창 목록·파일 주고받기(call)와, 창 폴더에서 띄운 가짜 ACP CLI(open) */
async function fakeRunner(target: string, key: string) {
  const socket = new WebSocket(target);
  const agents = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const reply = (value: unknown) =>
      socket.send(JSON.stringify({ t: "result", id: msg.id, value }));
    if (msg.t === "call") {
      log.push(`call ${msg.op} ${JSON.stringify(msg.args)}`);
      if (msg.op === "panes") return reply([PANE]);
      if (msg.op === "put") return reply({ path: `${msg.args.cwd}/.0siri/inbox/${msg.args.name}` });
      if (msg.op === "get")
        return reply({ name: "chart.png", b64: Buffer.from("PNGDATA").toString("base64") });
    }
    if (msg.t === "data") agents.get(msg.id)?.enqueue(new TextEncoder().encode(msg.d));
    if (msg.t !== "open") return;
    log.push(`open ${msg.provider} ${msg.cwd}`);
    const input = new ReadableStream<Uint8Array>({ start: (c) => void agents.set(msg.id, c) });
    const output = new WritableStream<Uint8Array>({
      write: (chunk) =>
        socket.send(JSON.stringify({ t: "data", id: msg.id, d: new TextDecoder().decode(chunk) })),
    });
    const agent: acp.AgentSideConnection = new acp.AgentSideConnection(
      () => ({
        initialize: async () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
        }),
        authenticate: async () => ({}),
        newSession: async () => ({ sessionId: "never" }),
        listSessions: async () => ({
          sessions: [
            { sessionId: "old", cwd: PANE.cwd, updatedAt: "2026-10-01" },
            { sessionId: "latest", cwd: PANE.cwd, updatedAt: "2026-10-11" },
            { sessionId: "elsewhere", cwd: "/other", updatedAt: "2026-10-12" },
          ],
        }),
        loadSession: async ({ sessionId }) => {
          log.push(`load ${sessionId}`);
          // 기록을 조각으로 다시 보내 준다(replay)
          for (const entry of sessionFile)
            for (const piece of [entry.text.slice(0, 2), entry.text.slice(2)])
              await agent.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate:
                    entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                  content: { type: "text", text: piece },
                },
              });
          return {};
        },
        cancel: async () => {},
        prompt: async ({ sessionId, prompt }) => {
          const text = prompt[0]?.type === "text" ? prompt[0].text : "";
          log.push(`prompt ${sessionId} ${text}`);
          sessionFile.push({ role: "user", text });
          await agent.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "차트 그리기" },
          });
          const answer = "그렸습니다\n[[0siri-file: out/chart.png]]";
          sessionFile.push({ role: "agent", text: answer });
          await agent.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: answer },
            },
          });
          return { stopReason: "end_turn" };
        },
      }),
      acp.ndJsonStream(output, input),
    );
  });
  await new Promise((resolve) => {
    socket.on("open", () => socket.send(JSON.stringify({ t: "hello", key, cwd: "/work" })));
    socket.once("message", resolve);
  });
  return socket;
}

test("tmux pane over ACP: latest session in that folder, history shown, tmux turns synced, files both ways", async () => {
  const filesDir = join(directory, "pane-files");
  const panes = new Panes(db, {
    runner: (owner) => subs.runner(owner),
    filesDir,
    publicUrl: "https://example.test",
  });
  assert.deepEqual(await panes.list("me"), [PANE]);
  await assert.rejects(
    panes.attach("me", "room", { ...PANE, target: "nope:0.0" }),
    /찾지 못했습니다/,
  );
  await assert.rejects(panes.list("stranger"), /러너가 연결되어 있지 않습니다/);

  const attached = await panes.attach("me", "room", PANE);
  assert.equal(attached.link.sessionId, "latest", "가장 최근 세션, 그 창 폴더 안에서만");
  assert.equal(attached.history, 2);
  assert.ok(log.includes(`open claude ${PANE.cwd}`), "CLI 는 그 창 폴더에서 띄운다");

  // 첫 턴: 이전 기록 → 도구 → 답 → 받은 파일 링크
  let out = "";
  const link = await panes.linked("me", "room");
  assert.ok(link);
  await panes.ask("me", link, "차트 그려 줘", (d) => (out += d), new AbortController().signal);
  assert.match(out, /이 세션의 이전 기록/);
  assert.match(out, /> \*\*나:\*\* 블로그 글 3개 정리해 줘/);
  assert.match(out, /3개 정리했습니다/);
  assert.match(out, /🔧 차트 그리기/);
  assert.ok(
    log.some((l) => l.startsWith("prompt latest 차트 그려 줘") && l.includes("0siri-file")),
  );
  const url = /📎 \[chart\.png\]\((\S+)\)/.exec(out)?.[1];
  assert.ok(url, out);
  assert.ok(log.some((l) => l.startsWith("call get") && l.includes("out/chart.png")));
  const res = await paneFileRoutes(filesDir).request(new URL(url).pathname.replace("/api", ""));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(await res.text(), "PNGDATA");
  assert.equal((await paneFileRoutes(filesDir).request("/pane-files/zz/../../etc")).status, 404);

  // 그 사이 tmux 에서 직접 말을 주고받았다 → 다음 턴 앞에 그것만 보인다
  sessionFile.push({ role: "user", text: "tmux 에서 친 말" }, { role: "agent", text: "tmux 답" });
  out = "";
  const again = await panes.linked("me", "room");
  assert.ok(again);
  await panes.ask("me", again, "이어서", (d) => (out += d), new AbortController().signal);
  assert.match(out, /tmux 에서 오간 말/);
  assert.match(out, /tmux 에서 친 말/);
  assert.doesNotMatch(out, /블로그 글 3개/, "이미 보여 준 기록은 다시 보이지 않는다");
  assert.ok(!log.some((l) => l.startsWith("prompt latest 이어서") && l.includes("0siri-file")));

  // 영시리 → PC
  const sent = await panes.send("me", "room", "메모.txt", new TextEncoder().encode("hi"));
  assert.equal(sent.path, `${PANE.cwd}/.0siri/inbox/메모.txt`);
  await panes.detach("me", "room");
  assert.ok(!(await panes.linked("me", "room")));
});
