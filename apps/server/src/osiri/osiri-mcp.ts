// 0Siri MCP — 구독 세션(ACP: 그 사람 컨테이너·PC)에 «밖에서» 붙는 우리 도구.
//  - 기억은 서버 한 곳(Memories)에 있다. 어떤 모델·실행 위치든 이 MCP 로 같은 기억을 찾고 쓴다.
//  - 연결 도구(Mcp: 사용자 연결 + 플랫폼 공통 = 팀 서버 도구)는 서버에서 실행된다 — 구현·키는 밖으로 나가지 않는다.
//  - external 도구와 에이전트의 쓰기·명령은 앱 승인 카드(Approvals)를 거친다. 결정이 없으면 실행하지 않는다.
//  - 모든 호출은 서버를 지나가므로 감사 로그·신호(§17.1)가 여기서 쌓인다.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Approvals } from "./approvals.ts";
import type { Mcp } from "./mcp.ts";
import type { Memories } from "./memories.ts";
import type { Rooms } from "./rooms.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const TOKENS = "osiri-mcp-tokens";
/** 승인 카드를 기다리는 최대 시간 — 넘기면 거절로 본다(카드는 남아 있다가 기한에 만료된다) */
export const APPROVAL_WAIT_MS = 10 * 60_000;

/** 승인 카드 결정을 기다린다. 승인이면 1회용 토큰, 아니면 undefined(반려·만료·토큰 유실·시간 초과) */
export async function waitForApproval(
  approvals: Pick<Approvals, "pollForWorker">,
  owner: string,
  id: string,
  options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {},
): Promise<string | undefined> {
  const deadline = Date.now() + (options.timeoutMs ?? APPROVAL_WAIT_MS);
  while (Date.now() < deadline && !options.signal?.aborted) {
    const state = await approvals.pollForWorker(owner, id);
    if (state.status === "approved") return state.token; // tokenLost 면 undefined — 토큰 없이 실행하지 않는다
    if (state.status !== "pending") return undefined;
    await new Promise((r) => setTimeout(r, options.pollMs ?? 2000));
  }
  return undefined;
}

/** 이 대화(threadId)의 승인 카드를 띄울 방. 팀 세션은 그 팀 방, 사이드 대화는 그 방, 나머지는 영시리 개인 방 */
export async function roomForThread(
  rooms: Pick<Rooms, "get" | "ensurePersonalRoom">,
  owner: string,
  threadId: string,
): Promise<string> {
  const team = /^team:([^:]+):/.exec(threadId)?.[1];
  for (const id of team ? [team] : [threadId]) {
    try {
      return (await rooms.get(owner, id)).id;
    } catch {}
  }
  return (await rooms.ensurePersonalRoom(owner)).id;
}

export class OsiriMcp {
  constructor(
    private readonly db: Store,
    private readonly deps: {
      memories: Pick<Memories, "search" | "add">;
      mcp?: Pick<Mcp, "list" | "toolsFor" | "call">;
      approvals: Pick<Approvals, "pollForWorker">;
      rooms: Pick<Rooms, "get" | "ensurePersonalRoom">;
    },
  ) {}

  private readonly tokens = new Map<string, Promise<string>>();
  /** 이 프로세스에서 그 사람에게 낸 열쇠(없으면 새로). 서버가 다시 뜨면 세션을 다시 붙일 때 새 열쇠가 실린다 */
  tokenFor(owner: string): Promise<string> {
    let token = this.tokens.get(owner);
    if (!token) {
      token = this.issueToken(owner);
      this.tokens.set(owner, token);
      token.catch(() => this.tokens.delete(owner));
    }
    return token;
  }
  /** 그 사람 MCP 열쇠. 한 사람에 하나 — 새로 내면 옛 열쇠는 무효 */
  async issueToken(owner: string): Promise<string> {
    const token = `${Buffer.from(owner).toString("base64url")}.${randomBytes(24).toString("base64url")}`;
    await this.db.put("system", TOKENS, { id: owner, hash: sha(token) });
    return token;
  }
  async verify(token: string): Promise<string | undefined> {
    const owner = Buffer.from(token.split(".")[0] ?? "", "base64url").toString();
    if (!owner) return undefined;
    const stored = await this.db.get<{ hash: string }>("system", TOKENS, owner);
    if (!stored) return undefined;
    const a = Buffer.from(stored.hash);
    const b = Buffer.from(sha(token));
    return a.length === b.length && timingSafeEqual(a, b) ? owner : undefined;
  }

  /** 한 요청마다 서버를 새로 만든다(무상태) — 소유자·방은 요청에서 정해진다 */
  server(owner: string, thread: string) {
    const server = new McpServer({ name: "0siri", version: "1" });
    const text = (value: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
        },
      ],
    });
    server.registerTool(
      "memory_search",
      {
        description:
          "이 사람에 대한 기억(누적 기록)을 찾는다. 답하기 전에 이 사람의 취향·사정·이전 결정이 필요하면 먼저 부른다.",
        inputSchema: { query: z.string().min(1).max(500) },
      },
      async ({ query }) =>
        text(
          (await this.deps.memories.search(owner, query, 8)).map((m) => ({
            text: m.text,
            createdAt: m.createdAt,
          })),
        ),
    );
    server.registerTool(
      "memory_save",
      {
        description:
          "이 사람에 대해 오래 기억할 사실을 저장한다(취향·사정·결정). 한 번 쓰고 끝날 내용은 저장하지 않는다.",
        inputSchema: { text: z.string().min(1).max(2000) },
      },
      async ({ text: fact }) => {
        await this.deps.memories.add(owner, fact, "subscription");
        return text("저장했습니다");
      },
    );
    const mcp = this.deps.mcp;
    if (mcp) {
      server.registerTool(
        "tools_list",
        {
          description:
            "0Siri 에 연결된 도구(이 사람의 연결 + 구독한 팀의 서버 도구)를 서버별로 보여 준다.",
          inputSchema: {},
        },
        async () =>
          text(
            await Promise.all(
              (await mcp.list(owner)).map(async (s) => ({
                serverId: s.id,
                server: s.name,
                tools: await mcp.toolsFor(owner, s.id).then(
                  (tools) =>
                    tools.map((t) => ({ name: t.name, risk: t.risk, description: t.description })),
                  (error: Error) => `불러오지 못함: ${error.message}`,
                ),
              })),
            ),
          ),
      );
      server.registerTool(
        "tool_call",
        {
          description:
            "연결된 도구를 0Siri 서버에서 실행한다. 외부 행위(external) 도구는 사용자가 앱에서 승인해야 실행된다.",
          inputSchema: {
            serverId: z.string().min(1),
            tool: z.string().min(1),
            args: z.record(z.string(), z.unknown()).optional(),
          },
        },
        async ({ serverId, tool, args }, extra) => {
          const roomId = await roomForThread(this.deps.rooms, owner, thread);
          const call = { roomId, serverId, tool, args, actor: "subscription" };
          let result = await mcp.call(owner, call);
          if (result.status === "pending_approval") {
            const token = await waitForApproval(this.deps.approvals, owner, result.approvalId, {
              signal: extra.signal,
            });
            if (!token)
              return { ...text("사용자가 승인하지 않아 실행하지 않았습니다"), isError: true };
            result = await mcp.call(owner, {
              ...call,
              approval: { id: result.approvalId, token },
            });
          }
          if (result.status === "failed") return { ...text(result.error), isError: true };
          return text(result.status === "done" ? result.result : result);
        },
      );
    }
    return server;
  }
}

/** POST /mcp (Streamable HTTP, 무상태). 인증 = Authorization: Bearer <0Siri MCP 열쇠>. ?thread= 로 승인 카드 방을 고른다 */
export function osiriMcpRoutes(osiriMcp: OsiriMcp) {
  const app = new Hono();
  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization");
    const owner = header?.startsWith("Bearer ")
      ? await osiriMcp.verify(header.slice(7))
      : undefined;
    if (!owner) throw new AppError("0Siri MCP 열쇠가 맞지 않습니다", 401);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = osiriMcp.server(owner, c.req.query("thread") ?? "");
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}
