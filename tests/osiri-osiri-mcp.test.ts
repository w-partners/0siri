// 0Siri MCP — 구독 세션에 밖에서 붙는 기억·도구. 열쇠 인증, 기억 찾기·저장, external 도구는 승인 뒤에만
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { OsiriMcp, osiriMcpRoutes } from "../apps/server/src/osiri/osiri-mcp.ts";

let db: Store, directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-omcp-"));
  db = await createStore({ dataDir: join(directory, "db") });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const saved: string[] = [];
  const toolCalls: unknown[] = [];
  let decision: "approved" | "rejected" = "approved";
  const osiriMcp = new OsiriMcp(db, {
    memories: {
      search: async (owner, query) =>
        [{ id: "m1", text: `${owner} 는 아침형 (${query})`, createdAt: "2026-10-10" }] as never,
      add: async (_owner, text) => {
        saved.push(text);
        return {} as never;
      },
    },
    mcp: {
      list: async () => [{ id: "srv", name: "site" }] as never,
      toolsFor: async () => [{ name: "publish", risk: "external", description: "발행" }] as never,
      call: async (_owner, input) => {
        toolCalls.push(input);
        return input.approval
          ? { status: "done", result: { url: "https://site/1" } }
          : { status: "pending_approval", approvalId: "a1", inputHash: "h" };
      },
    },
    approvals: {
      pollForWorker: async () =>
        decision === "approved" ? { status: "approved", token: "tok" } : { status: "rejected" },
    },
    rooms: {
      get: async (_owner: string, id: string) => {
        if (id === "room-1") return { id } as never;
        throw new AppError("방을 찾을 수 없습니다", 404);
      },
      ensurePersonalRoom: async () => ({ id: "home" }) as never,
    },
  });
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api", osiriMcpRoutes(osiriMcp));
  const connect = async (token: string, thread = "room-1") => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://x/api/mcp?thread=${thread}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => app.request(String(input), init),
      }),
    );
    return client;
  };
  return { osiriMcp, connect, saved, toolCalls, decide: (d: typeof decision) => (decision = d) };
}
const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0]?.text ?? "") as string;

test("0Siri MCP: only the owner's latest key works; memory comes from the server store", async () => {
  const f = fixture();
  await assert.rejects(f.connect("bm9ib2R5.guess"), /401|열쇠/);
  const old = await f.osiriMcp.issueToken("u1");
  const token = await f.osiriMcp.issueToken("u1");
  await assert.rejects(f.connect(old), /401|열쇠/, "re-issuing revokes the old key");
  assert.equal(
    await f.osiriMcp.tokenFor("u2"),
    await f.osiriMcp.tokenFor("u2"),
    "one key per process",
  );

  // 내 PC(tmux)에 넣는 열쇠는 따로 — 다시 받아도 서버 세션 열쇠는 그대로, 같은 사람으로 인증된다
  const external = await f.osiriMcp.issueToken("u1", "external");
  assert.equal(await f.osiriMcp.verify(external), "u1");
  await f.osiriMcp.issueToken("u1", "external");
  assert.equal(await f.osiriMcp.verify(external), undefined, "re-issuing revokes the old PC key");
  assert.equal(await f.osiriMcp.verify(token), "u1", "the server-session key is untouched");

  const client = await f.connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_save", "memory_search", "tool_call", "tools_list"]);
  assert.match(
    textOf(await client.callTool({ name: "memory_search", arguments: { query: "일정" } })),
    /u1 는 아침형 \(일정\)/,
  );
  await client.callTool({ name: "memory_save", arguments: { text: "커피는 디카페인" } });
  assert.deepEqual(f.saved, ["커피는 디카페인"]);
  await client.close();
});

test("0Siri MCP: external tool runs on the server only after the app approval, in the thread's room", async () => {
  const f = fixture();
  const client = await f.connect(await f.osiriMcp.issueToken("u3"));
  const ok = await client.callTool({
    name: "tool_call",
    arguments: { serverId: "srv", tool: "publish", args: { title: "글" } },
  });
  assert.match(textOf(ok), /https:\/\/site\/1/);
  assert.deepEqual(f.toolCalls, [
    {
      roomId: "room-1",
      serverId: "srv",
      tool: "publish",
      args: { title: "글" },
      actor: "subscription",
    },
    {
      roomId: "room-1",
      serverId: "srv",
      tool: "publish",
      args: { title: "글" },
      actor: "subscription",
      approval: { id: "a1", token: "tok" },
    },
  ]);
  f.decide("rejected");
  f.toolCalls.length = 0;
  const refused = await client.callTool({
    name: "tool_call",
    arguments: { serverId: "srv", tool: "publish", args: { title: "글2" } },
  });
  assert.equal(refused.isError, true);
  assert.equal(f.toolCalls.length, 1, "not executed without approval");
  await client.close();
});
