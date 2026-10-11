// 0Siri MCP 연결 + 위험도 게이트 (0SIRI-SPEC §15.2, §22-6).
//  - 연결은 사용자별(owner) 또는 플랫폼 공통(owner="system"). URL·헤더(API 키)는 서버에만 저장된다.
//  - 도구 위험도는 선언(`x-osiri-risk`)을 읽고, 미선언이면 **최고 등급(external)** 으로 본다.
//  - read: 바로 실행 / write: 실행 후 활동 기록 / external: 승인 토큰 없이는 서버가 막는다 (fail-closed).
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import {
  MCP_AUTH_TYPES,
  MCP_RISKS,
  type McpAuthType,
  type McpRisk,
} from "../../../../packages/domain/src/osiri.ts";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Approvals } from "./approvals.ts";
import {
  discover,
  newState,
  OAUTH_CALLBACK_PATH,
  OAUTH_PENDING_TTL_MS,
  type OAuthTokens,
  oauthClientFor,
  pkce,
  tokenRequest,
} from "./mcp-oauth.ts";
import type { Rooms } from "./rooms.ts";
import { BLOCKED_TOOLS_SETTING, settingValue } from "./store.ts";

export type Risk = McpRisk;
const RISKS: readonly Risk[] = MCP_RISKS;
export type RiskCounts = Record<Risk, number>;
export interface McpAuth {
  type: McpAuthType;
  name?: string;
  value?: string;
}
export interface McpServer {
  id: string;
  name: string;
  url: string;
  /**
   * 인증 헤더 — 응답에는 키 이름만 내보낸다. 저장할 때는 `headersCiphertext` 로 암호화하고 이 필드는 비운다.
   * (암호화 전에 저장된 옛 행, 또는 TOKEN_ENCRYPTION_KEY 가 없는 서버에서만 평문으로 남아 있다)
   */
  headers?: Record<string, string>;
  /** 인증 헤더(JSON)를 TOKEN_ENCRYPTION_KEY 로 암호화한 것 */
  headersCiphertext?: string;
  /** 헤더 키 이름 — 값을 풀지 않고도 목록에 보이게 따로 둔다 */
  headerNames?: string[];
  /** OAuth 로그인으로 붙은 연결: 토큰(JSON)을 TOKEN_ENCRYPTION_KEY 로 암호화한 것. 키 없는 시험 서버만 `oauth` 평문 */
  oauthCiphertext?: string;
  oauth?: OAuthTokens;
  riskDefault: Risk; // 도구가 위험도를 선언하지 않았을 때. 기본 external (= 최고 등급)
  /** 마지막으로 도구 목록을 받았을 때의 도구 수·위험도별 수 (목록 화면이 서버에 다시 붙지 않고 보인다) */
  toolSummary?: { toolCount: number; risks: RiskCounts };
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

const summarize = (tools: Pick<McpTool, "risk">[]): NonNullable<McpServer["toolSummary"]> => ({
  toolCount: tools.length,
  risks: {
    read: tools.filter((t) => t.risk === "read").length,
    write: tools.filter((t) => t.risk === "write").length,
    external: tools.filter((t) => t.risk === "external").length,
  },
});
/** `auth` 를 연결 헤더로. OAuth 는 헤더가 아니라 로그인(/connections/mcp/oauth/start)으로 붙는다. */
function authHeaders(auth?: McpAuth): Record<string, string> | undefined {
  if (!auth || auth.type === "none") return undefined;
  if (auth.type === "oauth")
    throw new AppError("OAuth 연결은 «로그인으로 연결» 로 붙습니다 (헤더로 보내지 않습니다)", 422);
  const name = auth.name?.trim();
  if (!name || !auth.value) throw new AppError("헤더 인증에는 헤더 이름과 값이 필요합니다", 422);
  return { [name]: auth.value };
}
// 암호화 키 없이 평문으로 저장하게 되는 경우는 한 번만 알린다 (연결마다 찍으면 로그가 묻힌다)
let warnedPlaintextHeaders = false;

export class Mcp {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly versions = new Map<string, string>();
  private readonly refreshing = new Map<string, Promise<McpServer>>();
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly approvals: Approvals,
    private readonly connect: Connector = httpConnector,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly http: typeof fetch = fetch,
  ) {}

  /** 사용자 연결 + 플랫폼 공통 연결. */
  async list(owner: string): Promise<McpServer[]> {
    return (await this.scoped(owner)).map(({ server }) => server);
  }
  private async scoped(owner: string): Promise<{ server: McpServer; scope: string }[]> {
    const [mine, shared] = await Promise.all([
      this.db.list<McpServer>(owner, "mcp-servers"),
      owner === "system" ? [] : this.db.list<McpServer>("system", "mcp-servers"),
    ]);
    return [
      ...mine.map((server) => ({ server, scope: owner })),
      ...shared.map((server) => ({ server, scope: "system" })),
    ];
  }
  /**
   * 목록 화면용: 공개 모양 + 도구 수·위험도별 수. 수는 저장해 둔 요약을 쓰고, 요약이 없는 옛 연결만 지금 붙어서 센다.
   * 못 센 연결은 0 으로 꾸미지 않는다 — `toolCount`·`risks` 를 null 로 내고 사유를 `toolsError` 에 싣는다.
   */
  async overview(owner: string) {
    return Promise.all(
      (await this.scoped(owner)).map(async ({ server, scope }) => {
        if (server.toolSummary) return { ...publicServer(server), ...server.toolSummary };
        try {
          const summary = summarize(await this.tools(owner, server, scope));
          await this.db.put(scope, "mcp-servers", { ...server, toolSummary: summary });
          return { ...publicServer(server), ...summary };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[osiri] MCP 연결 ${server.id} 의 도구 수를 세지 못했습니다: ${message}`);
          return { ...publicServer(server), toolCount: null, risks: null, toolsError: message };
        }
      }),
    );
  }
  /** 인증 헤더를 저장 모양으로. 키가 있으면 암호화하고 평문은 남기지 않는다. */
  private sealHeaders(
    headers: Record<string, string> | undefined,
  ): Pick<McpServer, "headers" | "headersCiphertext" | "headerNames"> {
    if (!headers || Object.keys(headers).length === 0) return {};
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    if (!key) {
      // live 모드는 기동 때 이 키를 요구한다 — 여기로 오는 것은 키 없는 sample·시험 서버뿐이다
      if (!warnedPlaintextHeaders) {
        warnedPlaintextHeaders = true;
        console.warn(
          "[osiri] TOKEN_ENCRYPTION_KEY 가 없어 MCP 인증 헤더를 암호화하지 못하고 평문으로 저장합니다 — 운영 서버에서는 키를 설정하세요",
        );
      }
      return { headers, headerNames: Object.keys(headers) };
    }
    return {
      headersCiphertext: encryptSecret(JSON.stringify(headers), key),
      headerNames: Object.keys(headers),
    };
  }
  /** 연결할 때만 푼다. 로그·응답에 쓰지 않는다. OAuth 연결은 그 사람의 access 토큰을 Bearer 로 싣는다. */
  private openHeaders(server: McpServer): Record<string, string> | undefined {
    const oauth = this.openOAuth(server);
    const headers = this.openStoredHeaders(server);
    return oauth ? { ...headers, Authorization: `Bearer ${oauth.accessToken}` } : headers;
  }
  private sealOAuth(tokens: OAuthTokens): Pick<McpServer, "oauth" | "oauthCiphertext"> {
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    if (!key) {
      console.warn(
        "[osiri] TOKEN_ENCRYPTION_KEY 가 없어 MCP OAuth 토큰을 평문으로 저장합니다(시험 서버 전용)",
      );
      return { oauth: tokens };
    }
    return { oauthCiphertext: encryptSecret(JSON.stringify(tokens), key) };
  }
  private openOAuth(server: McpServer): OAuthTokens | undefined {
    if (!server.oauthCiphertext) return server.oauth;
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    if (!key)
      throw new AppError("서버에 TOKEN_ENCRYPTION_KEY 가 없어 OAuth 토큰을 읽을 수 없습니다", 503);
    return JSON.parse(decryptSecret(server.oauthCiphertext, key)) as OAuthTokens;
  }
  /** access 가 1분 안에 끝나면 refresh 로 바꿔 저장한다. refresh 가 없거나 거절되면 다시 로그인하라고 알린다. */
  private async freshOAuth(scope: string, server: McpServer): Promise<McpServer> {
    const tokens = this.openOAuth(server);
    if (!tokens?.expiresAt || Date.parse(tokens.expiresAt) - Date.now() > 60_000) return server;
    // refresh 는 회전형일 수 있다(W: 쓴 refresh 는 바로 무효) — 같은 연결의 동시 갱신은 한 번만 보내고 결과를 나눠 쓴다
    const key = `${scope}:${server.id}`;
    let pending = this.refreshing.get(key);
    if (!pending) {
      pending = this.refreshOAuth(scope, server, tokens).finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, pending);
    }
    return pending;
  }
  private async refreshOAuth(
    scope: string,
    server: McpServer,
    tokens: OAuthTokens,
  ): Promise<McpServer> {
    const relogin = `${server.name} 로그인이 만료됐습니다 — 연결을 지우고 다시 로그인해 주세요`;
    if (!tokens.refreshToken) throw new AppError(relogin, 401);
    let next: OAuthTokens;
    try {
      next = await tokenRequest(
        this.http,
        tokens.tokenEndpoint,
        {
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: tokens.clientId,
          resource: tokens.resource,
        },
        tokens,
      );
    } catch (error) {
      throw new AppError(`${relogin} (${(error as Error).message})`, 401);
    }
    const { oauth: _o, oauthCiphertext: _c, ...rest } = server;
    const updated = { ...rest, ...this.sealOAuth(next) };
    await this.db.put(scope, "mcp-servers", updated);
    return updated;
  }
  /** 로그인 시작: 인가 주소를 찾아 PKCE·state 를 만들고, 돌아올 때까지 10분 들고 있는다. 브라우저로 열 주소를 준다. */
  async startOAuth(
    owner: string,
    input: { name: string; url: string; riskDefault?: Risk },
    publicUrl: string,
  ): Promise<{ authorizeUrl: string }> {
    const endpoints = await discover(input.url, this.http);
    const client = oauthClientFor(endpoints.authorizationEndpoint, this.env);
    const { verifier, challenge } = pkce();
    const state = newState();
    await this.db.put("system", "mcp-oauth-pending", {
      id: state,
      owner,
      ...input,
      ...endpoints,
      clientId: client.clientId,
      verifier,
      createdAt: new Date().toISOString(),
    });
    const url = new URL(endpoints.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: `${publicUrl.replace(/\/$/, "")}${OAUTH_CALLBACK_PATH}`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: endpoints.resource,
      ...(client.scope ? { scope: client.scope } : {}),
    }).toString();
    return { authorizeUrl: url.toString() };
  }
  /** 로그인 끝(공개 콜백): state 로 누구의 어떤 연결인지 찾고, 코드를 토큰으로 바꿔 붙어 본 뒤 저장한다. state 는 한 번만 쓴다. */
  async finishOAuth(state: string, code: string, publicUrl: string): Promise<McpServer> {
    const pending = await this.db.get<{
      id: string;
      owner: string;
      name: string;
      url: string;
      riskDefault?: Risk;
      resource: string;
      tokenEndpoint: string;
      clientId: string;
      verifier: string;
      createdAt: string;
    }>("system", "mcp-oauth-pending", state);
    if (!pending)
      throw new AppError("로그인 요청을 찾을 수 없습니다 — 0Siri 에서 다시 시작해 주세요", 400);
    await this.db.remove("system", "mcp-oauth-pending", state);
    if (Date.now() - Date.parse(pending.createdAt) > OAUTH_PENDING_TTL_MS)
      throw new AppError("로그인 요청이 만료됐습니다(10분) — 0Siri 에서 다시 시작해 주세요", 400);
    const tokens = await tokenRequest(
      this.http,
      pending.tokenEndpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: `${publicUrl.replace(/\/$/, "")}${OAUTH_CALLBACK_PATH}`,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
        resource: pending.resource,
      },
      {
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        resource: pending.resource,
      },
    );
    const server: McpServer = {
      id: randomUUID(),
      name: pending.name,
      url: pending.url,
      ...this.sealOAuth(tokens),
      riskDefault: pending.riskDefault ?? "external",
      createdAt: new Date().toISOString(),
    };
    // 먼저 저장하고 붙어 본다 — 붙는 동안 토큰이 갱신되면 그 갱신이 저장본에 남아야 한다. 못 붙으면 지운다
    await this.db.put(pending.owner, "mcp-servers", server);
    let toolSummary: McpServer["toolSummary"];
    try {
      toolSummary = summarize(await this.tools(pending.owner, server));
    } catch (error) {
      await this.db.remove(pending.owner, "mcp-servers", server.id);
      throw error;
    }
    const latest =
      (await this.db.get<McpServer>(pending.owner, "mcp-servers", server.id)) ?? server;
    const saved = { ...latest, toolSummary };
    await this.db.put(pending.owner, "mcp-servers", saved);
    return saved;
  }
  private openStoredHeaders(server: McpServer): Record<string, string> | undefined {
    if (!server.headersCiphertext) return server.headers;
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    if (!key)
      throw new AppError(
        "서버에 TOKEN_ENCRYPTION_KEY 가 없어 MCP 인증 헤더를 읽을 수 없습니다",
        503,
      );
    return JSON.parse(decryptSecret(server.headersCiphertext, key)) as Record<string, string>;
  }
  async add(
    owner: string,
    input: {
      name: string;
      url: string;
      headers?: Record<string, string>;
      auth?: McpAuth;
      riskDefault?: Risk;
    },
  ) {
    const server: McpServer = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      ...this.sealHeaders({ ...input.headers, ...authHeaders(input.auth) }),
      riskDefault: input.riskDefault ?? "external",
      createdAt: new Date().toISOString(),
    };
    // 등록 전에 실제로 붙어 보고 도구 목록을 받는다 — 못 붙으면 저장하지 않는다
    server.toolSummary = summarize(await this.tools(owner, server));
    await this.db.put(owner, "mcp-servers", server);
    return server;
  }
  /** 연결 시험 — 붙어서 도구 이름·위험도만 받아 오고 아무것도 저장하지 않는다. 연결도 남기지 않고 닫는다. */
  async test(input: { url: string; auth?: McpAuth }): Promise<Pick<McpTool, "name" | "risk">[]> {
    const server: McpServer = {
      id: randomUUID(),
      name: "test",
      url: input.url,
      headers: authHeaders(input.auth),
      riskDefault: "external",
      createdAt: new Date().toISOString(),
    };
    let client: Client;
    try {
      client = await this.connect(server);
    } catch (error) {
      throw new AppError(`MCP 서버에 연결하지 못했습니다: ${(error as Error).message}`, 502);
    }
    try {
      return (await describeTools(server, client)).map(({ name, risk }) => ({ name, risk }));
    } catch (error) {
      throw new AppError(`MCP 도구 목록을 받지 못했습니다: ${(error as Error).message}`, 502);
    } finally {
      await client
        .close()
        .catch((error) =>
          console.warn(`[osiri] 시험용 MCP 연결을 닫지 못했습니다: ${(error as Error).message}`),
        );
    }
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
  private async client(scope: string, stored: McpServer): Promise<Client> {
    const server = await this.freshOAuth(scope, stored);
    const key = `${scope}:${server.id}`;
    // OAuth 토큰이 바뀌었으면(갱신) 옛 토큰을 든 연결은 닫고 새로 붙는다
    const version = server.oauthCiphertext ?? server.oauth?.accessToken ?? "";
    if (this.versions.get(key) !== version) {
      void this.clients
        .get(key)
        ?.then((c) => c.close())
        .catch(() => undefined);
      this.clients.delete(key);
      this.versions.set(key, version);
    }
    let client = this.clients.get(key);
    if (!client) {
      // 커넥터에는 푼 헤더를 메모리로만 넘긴다 (저장 모양의 암호문은 넘기지 않는다)
      client = Promise.resolve()
        .then(() => {
          const {
            headersCiphertext: _sealed,
            oauthCiphertext: _token,
            oauth: _plain,
            ...rest
          } = server;
          return this.connect({ ...rest, headers: this.openHeaders(server) });
        })
        .catch((error) => {
          this.clients.delete(key);
          if (error instanceof AppError) throw error;
          throw new AppError(`MCP 서버에 연결하지 못했습니다: ${(error as Error).message}`, 502);
        });
      this.clients.set(key, client);
    }
    return client;
  }
  async tools(owner: string, server: McpServer, scope = owner): Promise<McpTool[]> {
    return describeTools(server, await this.client(scope, server));
  }
  async toolsFor(owner: string, serverId: string) {
    const { server, scope } = await this.server(owner, serverId);
    const tools = await this.tools(owner, server, scope);
    // 서버가 도구를 바꿨으면 목록 화면의 수도 따라가게 요약을 새로 적는다
    const summary = summarize(tools);
    if (JSON.stringify(summary) !== JSON.stringify(server.toolSummary))
      await this.db.put(scope, "mcp-servers", { ...server, toolSummary: summary });
    return tools;
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
      /** 구독자 조정(wgolf RPT-02 C 가·나) — 끈 도구는 거절, 올린 도구는 read·write 도 승인 */
      controls?: { disabledTools?: string[]; approvalTools?: string[] };
    },
  ): Promise<ToolResult> {
    const { server, scope } = await this.server(owner, input.serverId);
    const tool = (await this.tools(owner, server, scope)).find((t) => t.name === input.tool);
    if (!tool) throw new AppError("도구를 찾을 수 없습니다", 404);
    const actor = input.actor ?? "chat";
    const toolName = `${server.name}:${tool.name}`;
    const blocked = (await settingValue<string[]>(this.db, BLOCKED_TOOLS_SETTING)) ?? [];
    if (blocked.includes(toolName) || blocked.includes(`${server.name}:*`))
      throw new AppError(`관리자가 차단한 도구입니다: ${toolName}`, 403);
    if (input.controls?.disabledTools?.includes(toolName))
      throw new AppError(`구독자가 끈 도구입니다: ${toolName}`, 403);
    if (tool.risk === "external" || input.controls?.approvalTools?.includes(toolName)) {
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

async function describeTools(server: McpServer, client: Client): Promise<McpTool[]> {
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

/** 응답 모양 — 헤더 값·암호문·내부 요약은 빼고 헤더 키 이름만 낸다. */
const publicServer = ({
  headers,
  headersCiphertext: _sealed,
  headerNames,
  toolSummary: _summary,
  oauth,
  oauthCiphertext,
  ...server
}: McpServer) => ({
  ...server,
  headerNames: headerNames ?? Object.keys(headers ?? {}),
  oauth: !!(oauth || oauthCiphertext),
});

/** S7 연결 라우트 — /api 아래, 인증 뒤. */
export function mcpRoutes(mcp: Mcp, publicUrl: string) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const authSchema = z.object({
    type: z.enum(MCP_AUTH_TYPES),
    name: z.string().max(100).optional(),
    value: z.string().max(4000).optional(),
  });
  app.get("/connections/mcp", async (c) => c.json(await mcp.overview(c.get("owner"))));
  // 저장 없이 붙어만 본다. /connections/mcp/:id/… 와 겹치지 않는다 (그쪽은 세 조각 경로)
  app.post("/connections/mcp/test", async (c) => {
    const body = z
      .object({ url: z.string().url(), auth: authSchema.optional() })
      .parse(await c.req.json());
    return c.json({ tools: await mcp.test(body) });
  });
  app.post("/connections/mcp", async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(60),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
        auth: authSchema.optional(),
        riskDefault: z.enum(RISKS).optional(),
      })
      .parse(await c.req.json());
    const server = await mcp.add(c.get("owner"), body);
    return c.json({ ...publicServer(server), ...server.toolSummary });
  });
  // OAuth 로그인 시작 — 브라우저로 열 주소를 준다. 끝은 공개 콜백(app.ts OAUTH_CALLBACK_PATH)이 받는다
  app.post("/connections/mcp/oauth/start", async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(60),
        url: z.string().url(),
        riskDefault: z.enum(RISKS).optional(),
      })
      .parse(await c.req.json());
    return c.json(await mcp.startOAuth(c.get("owner"), body, publicUrl));
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
