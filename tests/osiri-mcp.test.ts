// 0SIRI-SPEC §22-6 합격 기준: 시험 MCP 로 read 무승인 실행, external 승인 후 1회 실행, 입력 변경 시 토큰 무효.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Mcp, mcpRoutes } from "../apps/server/src/osiri/mcp.ts";
import { roomRoutes } from "../apps/server/src/osiri/room-routes.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";

let db: Store, directory: string, approvals: Approvals;
let app: Hono<{ Variables: { owner: string } }>;
const calls: string[] = [];
const OWNER = "lawyer-1";
const call = (path: string, body?: unknown, owner = OWNER, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** 시험 MCP 서버: read 1개, external 1개, 위험도 미선언 1개 */
async function testMcpClient() {
  const server = new McpServer({ name: "blog-test", version: "0.0.1" });
  server.registerTool(
    "blog_list_posts",
    {
      description: "글 목록",
      inputSchema: { limit: z.number().optional() },
      _meta: { "x-osiri-risk": "read" },
    },
    async () => {
      calls.push("list");
      return {
        content: [{ type: "text", text: JSON.stringify([{ id: 1, title: "양도세 기본" }]) }],
      };
    },
  );
  server.registerTool(
    "blog_publish_post",
    {
      description: "글 발행 (외부 공개)",
      inputSchema: { title: z.string(), body: z.string() },
      _meta: { "x-osiri-risk": "external", "x-osiri-idempotent": false },
    },
    async ({ title }) => {
      calls.push(`publish:${title}`);
      return { content: [{ type: "text", text: `published ${title}` }] };
    },
  );
  server.registerTool(
    "blog_mystery",
    { description: "위험도 미선언", inputSchema: {} },
    async () => {
      calls.push("mystery");
      return { content: [{ type: "text", text: "?" }] };
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-mcp-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const bus = new EventBus();
  const rooms = new Rooms(db, bus);
  approvals = new Approvals(db, rooms, bus);
  const mcp = new Mcp(db, rooms, approvals, testMcpClient);
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", roomRoutes({ db, rooms, approvals, bus }));
  app.route("/api", mcpRoutes(mcp));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("MCP 연결 등록 → 위험도 분류(미선언=external) → read 무승인, external 승인 1회, 입력 변경 무효", async () => {
  const roomId = ((await (await call("/api/rooms")).json()) as { id: string }[])[0]?.id as string;
  const added = await call("/api/connections/mcp", {
    name: "blog",
    url: "http://mcp.test/mcp",
    headers: { Authorization: "Bearer secret-key" },
  });
  assert.equal(added.status, 200);
  const server = (await added.json()) as { id: string; headers?: unknown; headerNames: string[] };
  assert.equal(server.headers, undefined, "API 키가 응답에 새면 안 된다");
  assert.deepEqual(server.headerNames, ["Authorization"]);
  // 다른 사용자에게는 보이지 않는다
  assert.equal(
    ((await (await call("/api/connections/mcp", undefined, "someone-else")).json()) as unknown[])
      .length,
    0,
  );

  const tools = (await (await call(`/api/connections/mcp/${server.id}/tools`)).json()) as {
    name: string;
    risk: string;
    declared: boolean;
  }[];
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.blog_list_posts?.risk, "read");
  assert.equal(byName.blog_publish_post?.risk, "external");
  assert.equal(byName.blog_mystery?.risk, "external", "미선언은 최고 등급");
  assert.equal(byName.blog_mystery?.declared, false);

  // read: 승인 없이 바로 실행
  const read = (await (
    await call(`/api/connections/mcp/${server.id}/call`, {
      roomId,
      tool: "blog_list_posts",
      args: {},
    })
  ).json()) as { status: string };
  assert.equal(read.status, "done");
  assert.deepEqual(calls, ["list"]);

  // external: 토큰 없으면 실행 보류 + 승인 카드
  const args = { title: "양도세 절세 5가지", body: "본문" };
  const held = (await (
    await call(`/api/connections/mcp/${server.id}/call`, {
      roomId,
      tool: "blog_publish_post",
      args,
    })
  ).json()) as {
    status: string;
    approvalId: string;
    inputHash: string;
  };
  assert.equal(held.status, "pending_approval");
  assert.deepEqual(calls, ["list"], "승인 전에 external 이 실행되면 안 된다");
  const pending = (await (await call("/api/inbox")).json()) as {
    pending: { id: string; toolName: string }[];
  };
  assert.equal(pending.pending[0]?.id, held.approvalId);
  assert.equal(pending.pending[0]?.toolName, "blog:blog_publish_post");

  // 엉터리 토큰으로 집행 시도 → 403, 실행 안 됨
  const forged = await call(`/api/connections/mcp/${server.id}/call`, {
    roomId,
    tool: "blog_publish_post",
    args,
    approval: { id: held.approvalId, token: "forged" },
  });
  assert.equal(forged.status, 403);
  assert.deepEqual(calls, ["list"]);

  // 승인 (토큰은 서비스 계층에서만 나온다 — 워커 폴링 경로)
  const decided = (await approvals.decide(OWNER, held.approvalId, "approve", {
    decidedBy: OWNER,
    frozenHash: held.inputHash,
  })) as { token?: string };
  assert.ok(decided.token);
  // 입력이 바뀌면 토큰 무효
  const changed = await call(`/api/connections/mcp/${server.id}/call`, {
    roomId,
    tool: "blog_publish_post",
    args: { ...args, title: "다른 제목" },
    approval: { id: held.approvalId, token: decided.token },
  });
  assert.equal(changed.status, 403);
  assert.deepEqual(calls, ["list"]);
  // 승인본 그대로 → 1회 실행
  const ok = (await (
    await call(`/api/connections/mcp/${server.id}/call`, {
      roomId,
      tool: "blog_publish_post",
      args,
      approval: { id: held.approvalId, token: decided.token },
    })
  ).json()) as { status: string };
  assert.equal(ok.status, "done");
  assert.deepEqual(calls, ["list", "publish:양도세 절세 5가지"]);
  // 같은 토큰 재사용 → 403
  const reuse = await call(`/api/connections/mcp/${server.id}/call`, {
    roomId,
    tool: "blog_publish_post",
    args,
    approval: { id: held.approvalId, token: decided.token },
  });
  assert.equal(reuse.status, 403);
  assert.equal(calls.length, 2);
  // 감사 로그: blocked 3건(위조·입력변경·재사용) + consume ok + tool.external ok
  const audit = (await (await call("/api/audit")).json()) as { action: string; result: string }[];
  assert.equal(
    audit.filter(
      (a) => a.action === "approval.consume:blog:blog_publish_post" && a.result === "blocked",
    ).length,
    3,
  );
  assert.ok(
    audit.some((a) => a.action === "tool.external:blog:blog_publish_post" && a.result === "ok"),
  );

  // 미선언 도구도 external 취급 → 보류
  const mystery = (await (
    await call(`/api/connections/mcp/${server.id}/call`, { roomId, tool: "blog_mystery", args: {} })
  ).json()) as { status: string };
  assert.equal(mystery.status, "pending_approval");
  assert.equal(calls.length, 2);

  // 삭제 후 조회 불가
  assert.equal(
    (await call(`/api/connections/mcp/${server.id}`, undefined, OWNER, "DELETE")).status,
    200,
  );
  assert.equal((await call(`/api/connections/mcp/${server.id}/tools`)).status, 404);
});
