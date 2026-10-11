// MCP OAuth(PKCE S256): 가짜 인가 서버로 시작 → 콜백 → 토큰 암호화 저장 → 만료 직전 갱신 → Bearer 로 붙기. state 는 한 번만.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Mcp, type McpServer as Saved } from "../apps/server/src/osiri/mcp.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";

const W = "https://hq.example-golf.test";
const PUBLIC = "https://app.example.test";
let db: Store, directory: string, mcp: Mcp;
const seenAuth: string[] = [];
const challenges = new Map<string, string>(); // code → challenge
let refreshes = 0;

const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === `${W}/.well-known/oauth-protected-resource/api/v1/mcp`)
    return json({ resource: `${W}/api/v1/mcp`, authorization_servers: [W] });
  if (url === `${W}/.well-known/oauth-authorization-server`)
    return json({
      authorization_endpoint: `${W}/api/v1/oauth/authorize`,
      token_endpoint: `${W}/api/v1/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
  if (url === `${W}/api/v1/oauth/token`) {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") {
      const verifier = form.get("code_verifier") ?? "";
      const ok =
        createHash("sha256").update(verifier).digest("base64url") ===
          challenges.get(form.get("code") ?? "") &&
        form.get("redirect_uri") === `${PUBLIC}/api/mcp/oauth/callback` &&
        form.get("client_id") === "oax_test";
      if (!ok) return json({ error: "invalid_grant" }, 400);
      // 30초짜리 — 1분 안에 끝나므로 다음 사용 때 바로 갱신돼야 한다
      return json({ access_token: "a1", refresh_token: "r1", expires_in: 30 });
    }
    if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "r1") {
      refreshes++;
      return json({ access_token: "a2", expires_in: 3600 });
    }
    return json({ error: "invalid_grant" }, 400);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function connector(server: { headers?: Record<string, string> }) {
  seenAuth.push(server.headers?.Authorization ?? "");
  const mock = new McpServer({ name: "w", version: "0.0.1" });
  mock.registerTool("search_teetimes", { description: "티타임" }, async () => ({ content: [] }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mock.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  return client;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-mcp-oauth-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const bus = new EventBus();
  const rooms = new Rooms(db, bus);
  const env = {
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MCP_OAUTH_CLIENTS: JSON.stringify({
      "example-golf.test": { clientId: "oax_test", scope: "read:teetimes" },
    }),
  };
  mcp = new Mcp(db, rooms, new Approvals(db, rooms, bus), connector, env, fakeFetch);
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("OAuth 로그인 → 토큰은 암호문으로만 저장 → 만료 직전 갱신 → 그 사람 토큰으로 붙는다", async () => {
  const { authorizeUrl } = await mcp.startOAuth(
    "user-1",
    { name: "W", url: `${W}/api/v1/mcp` },
    PUBLIC,
  );
  const q = new URL(authorizeUrl).searchParams;
  assert.equal(
    new URL(authorizeUrl).origin + new URL(authorizeUrl).pathname,
    `${W}/api/v1/oauth/authorize`,
  );
  assert.equal(q.get("client_id"), "oax_test");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("scope"), "read:teetimes");
  assert.equal(q.get("redirect_uri"), `${PUBLIC}/api/mcp/oauth/callback`);
  const state = q.get("state") as string;
  challenges.set("code-1", q.get("code_challenge") as string);

  const saved = await mcp.finishOAuth(state, "code-1", PUBLIC);
  assert.equal(saved.toolSummary?.toolCount, 1);
  assert.equal(refreshes, 1, "30초 남은 토큰은 쓰기 전에 갱신");
  assert.equal(seenAuth.at(-1), "Bearer a2");
  const stored = (await db.list<Saved>("user-1", "mcp-servers"))[0];
  assert.ok(stored?.oauthCiphertext);
  assert.equal(stored?.oauth, undefined);
  const files = (
    await readdir(join(directory, "db"), { recursive: true, withFileTypes: true })
  ).filter((f) => f.isFile());
  assert.ok(files.length > 0, "저장소 파일이 있어야 검사가 의미 있다");
  for (const f of files) {
    const raw = await readFile(join(f.parentPath, f.name), "latin1");
    assert.ok(!raw.includes("Bearer") && !/"a2"|"r1"/.test(raw), `평문 토큰이 ${f.name} 에 없다`);
  }

  // state 는 한 번만
  await assert.rejects(mcp.finishOAuth(state, "code-1", PUBLIC), /찾을 수 없습니다/);
  // 갱신된 토큰(1시간)은 다시 갱신하지 않는다
  await mcp.toolsFor("user-1", saved.id);
  assert.equal(refreshes, 1);
});

test("client_id 가 없는 인가 서버는 시작부터 거절(지어내지 않는다)", async () => {
  const other = new Mcp(
    db,
    new Rooms(db, new EventBus()),
    {} as Approvals,
    connector,
    {},
    fakeFetch,
  );
  await assert.rejects(
    other.startOAuth("user-1", { name: "W", url: `${W}/api/v1/mcp` }, PUBLIC),
    /OAuth 클라이언트가 0Siri 에 등록돼 있지 않습니다/,
  );
});
