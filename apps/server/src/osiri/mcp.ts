// 0Siri MCP 연결 + 위험도 게이트 (0SIRI-SPEC §15.2, §22-6).
//  - 연결은 사용자별(owner) 또는 플랫폼 공통(owner="system"). URL·헤더(API 키)는 서버에만 저장된다.
//  - 도구 위험도는 선언(`x-osiri-risk`)을 읽고, 미선언이면 **최고 등급(external)** 으로 본다.
//  - read: 바로 실행 / write: 실행 후 활동 기록 / external: 승인 토큰 없이는 서버가 막는다 (fail-closed).
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Approvals } from "./approvals.ts";
import type { Rooms } from "./rooms.ts";

export type Risk = "read" | "write" | "external";
const RISKS: Risk[] = ["read", "write", "external"];
export interface McpServer {
  id: string;
  name: string;
  url: string;
  headers?: Record<string, string>; // 인증 헤더 — 응답에는 키 이름만 내보낸다
  riskDefault: Risk; // 도구가 위험도를 선언하지 않았을 때. 기본 external (= 최고 등급)
  createdAt: string;
}
export interface McpTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: Risk;
  declared: boolean; // 위험도를 서버가 선언했는가
  idempotent: boolean;
}
export type ToolResult =
  | { status: "done"; result: unknown }
  // MCP 결과가 isError 인 경우 — 도구는 불렸지만 실패했다. result 에 오류 본문이 그대로 있다
  | { status: "failed"; result: unknown; error: string }
  | { status: "pending_approval"; approvalId: string; inputHash: string };

/** 테스트는 InMemoryTransport 클라이언트를 주입한다. 운영은 Streamable HTTP. */
export type Connector = (server: McpServer) => Promise<Client>;
export const httpConnector: Connector = async (server) => {
  const client = new Client({ name: "0siri", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    }),
  );
  return client;
};

const riskOf = (
  tool: { _meta?: Record<string, unknown> } & Record<string, unknown>,
): Risk | undefined => {
  const raw = tool["x-osiri-risk"] ?? tool._meta?.["x-osiri-risk"];
  return RISKS.includes(raw as Risk) ? (raw as Risk) : undefined;
};

export class Mcp {
  private readonly clients = new Map<string, Promise<Client>>();
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly approvals: Approvals,
    private readonly connect: Connector = httpConnector,
  ) {}

  /** 사용자 연결 + 플랫폼 공통 연결. */
  async list(owner: string): Promise<McpServer[]> {
    const [mine, shared] = await Promise.all([
      this.db.list<McpServer>(owner, "mcp-servers"),
      owner === "system" ? [] : this.db.list<McpServer>("system", "mcp-servers"),
    ]);
    return [...mine, ...shared];
  }
  async add(
    owner: string,
    input: { name: string; url: string; headers?: Record<string, string>; riskDefault?: Risk },
  ) {
    const server: McpServer = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      headers: input.headers,
      riskDefault: input.riskDefault ?? "external",
      createdAt: new Date().toISOString(),
    };
    // 등록 전에 실제로 붙어 보고 도구 목록을 받는다 — 못 붙으면 저장하지 않는다
    await this.tools(owner, server);
    await this.db.put(owner, "mcp-servers", server);
    return server;
  }
  async remove(owner: string, id: string) {
    const server = await this.db.get<McpServer>(owner, "mcp-servers", id);
    if (!server) throw new AppError("연결을 찾을 수 없습니다", 404);
    await this.db.remove(owner, "mcp-servers", id);
    const client = this.clients.get(`${owner}:${id}`);
    this.clients.delete(`${owner}:${id}`);
    await client?.then((c) => c.close()).catch(() => undefined);
  }
  private async server(owner: string, id: string): Promise<{ server: McpServer; scope: string }> {
    const mine = await this.db.get<McpServer>(owner, "mcp-servers", id);
    if (mine) return { server: mine, scope: owner };
    const shared = await this.db.get<McpServer>("system", "mcp-servers", id);
    if (shared) return { server: shared, scope: "system" };
    throw new AppError("연결을 찾을 수 없습니다", 404);
  }
  private client(scope: string, server: McpServer): Promise<Client> {
    const key = `${scope}:${server.id}`;
    let client = this.clients.get(key);
    if (!client) {
      client = this.connect(server).catch((error) => {
        this.clients.delete(key);
        throw new AppError(`MCP 서버에 연결하지 못했습니다: ${(error as Error).message}`, 502);
      });
      this.clients.set(key, client);
    }
    return client;
  }
  async tools(owner: string, server: McpServer, scope = owner): Promise<McpTool[]> {
    const client = await this.client(scope, server);
    const { tools } = await client.listTools();
    return tools.map((tool) => {
      const declared = riskOf(tool as Parameters<typeof riskOf>[0]);
      return {
        serverId: server.id,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
        risk: declared ?? server.riskDefault,
        declared: declared !== undefined,
        idempotent:
          ((tool as Record<string, unknown>)["x-osiri-idempotent"] ??
            tool._meta?.["x-osiri-idempotent"]) === true,
      };
    });
  }
  async toolsFor(owner: string, serverId: string) {
    const { server, scope } = await this.server(owner, serverId);
    return this.tools(owner, server, scope);
  }

  /**
   * 위험도 게이트. external 은 승인 토큰이 있을 때만 실행되고, 토큰은 `Approvals.consume` 이 도구명+입력 해시로 검증한다.
   * 토큰이 없으면 실행하지 않고 승인 카드를 만든다 (pending_approval).
   */
  async call(
    owner: string,
    input: {
      roomId: string;
      serverId: string;
      tool: string;
      args?: unknown;
      approval?: { id: string; token: string };
      actor?: string;
    },
  ): Promise<ToolResult> {
    const { server, scope } = await this.server(owner, input.serverId);
    const tool = (await this.tools(owner, server, scope)).find((t) => t.name === input.tool);
    if (!tool) throw new AppError("도구를 찾을 수 없습니다", 404);
    const actor = input.actor ?? "chat";
    const toolName = `${server.name}:${tool.name}`;
    if (tool.risk === "external") {
      if (!input.approval) {
        const approval = await this.approvals.request(owner, {
          roomId: input.roomId,
          toolName,
          input: input.args,
          title: `${server.name} · ${tool.name}`,
          summary: tool.description || "외부 행위 도구 실행",
          evidence: JSON.stringify(input.args, null, 2),
          requestedBy: actor,
        });
        return {
          status: "pending_approval",
          approvalId: approval.id,
          inputHash: approval.inputHash,
        };
      }
      // 토큰·도구·입력이 전부 맞을 때만 통과. 아니면 403 + 감사 로그 blocked
      await this.approvals.consume(owner, {
        approvalId: input.approval.id,
        token: input.approval.token,
        toolName,
        input: input.args,
      });
    }
    const client = await this.client(scope, server);
    const result = await client.callTool({
      name: tool.name,
      arguments: (input.args ?? {}) as Record<string, unknown>,
    });
    if (tool.risk !== "read") {
      await this.rooms.activity(owner, {
        roomId: input.roomId,
        actor,
        title: result.isError ? `${toolName} 실패` : `${toolName} 실행`,
        kind: result.isError ? "error" : "system",
      });
      await this.rooms.audit(owner, {
        packageId: null,
        actor,
        action: `tool.${tool.risk}:${toolName}`,
        approvalId: input.approval?.id,
        result: result.isError ? "error" : "ok",
      });
    }
    if (result.isError) return { status: "failed", result, error: toolErrorText(result.content) };
    return { status: "done", result };
  }
}
const toolErrorText = (content: unknown): string => {
  const text = Array.isArray(content)
    ? content
        .flatMap((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
        .join("\n")
    : "";
  return text || "MCP 도구가 오류를 돌려주었습니다 (본문 없음)";
};

const publicServer = ({ headers, ...server }: McpServer) => ({
  ...server,
  headerNames: Object.keys(headers ?? {}),
});

/** S7 연결 라우트 — /api 아래, 인증 뒤. */
export function mcpRoutes(mcp: Mcp) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/connections/mcp", async (c) =>
    c.json((await mcp.list(c.get("owner"))).map(publicServer)),
  );
  app.post("/connections/mcp", async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(60),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
        riskDefault: z.enum(RISKS).optional(),
      })
      .parse(await c.req.json());
    return c.json(publicServer(await mcp.add(c.get("owner"), body)));
  });
  app.delete("/connections/mcp/:id", async (c) => {
    await mcp.remove(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/connections/mcp/:id/tools", async (c) =>
    c.json(await mcp.toolsFor(c.get("owner"), c.req.param("id"))),
  );
  app.post("/connections/mcp/:id/call", async (c) => {
    const body = z
      .object({
        roomId: z.string().min(1),
        tool: z.string().min(1),
        args: z.unknown().optional(),
        approval: z.object({ id: z.string(), token: z.string() }).optional(),
      })
      .parse(await c.req.json());
    return c.json(await mcp.call(c.get("owner"), { serverId: c.req.param("id"), ...body }));
  });
  return app;
}
