// MCP OAuth(Authorization Code + PKCE S256) — 사람마다 자기 계정으로 MCP 서버에 붙는다 (wgolf RPT-20261011-05).
//  - 주소는 MCP 서버가 알려 준다: /.well-known/oauth-protected-resource<경로> → 인가 서버 → /.well-known/oauth-authorization-server
//  - 동적 등록이 없는 서버가 있어 client_id 는 서버 운영자가 미리 발급한다 → env MCP_OAUTH_CLIENTS (코드에 박지 않는다)
//    형식: {"teeup.cc":{"clientId":"…","scope":"read:courses …"}} — 키는 인가 서버 호스트 또는 그 상위 도메인
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.ts";

export interface OAuthClient {
  clientId: string;
  scope?: string;
}
export interface OAuthEndpoints {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** ISO — 없으면 만료를 모른다(401 을 받기 전까지 쓴다) */
  expiresAt?: string;
  tokenEndpoint: string;
  clientId: string;
  resource: string;
}
export const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
export const OAUTH_PENDING_TTL_MS = 10 * 60_000;

const b64url = (buf: Buffer) => buf.toString("base64url");
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
export const newState = () => b64url(randomBytes(24));

/** env 에서 이 인가 서버의 클라이언트를 찾는다. 설정이 깨졌으면 조용히 넘어가지 않고 실패한다. */
export function oauthClientFor(issuer: string, env: NodeJS.ProcessEnv): OAuthClient {
  const raw = env.MCP_OAUTH_CLIENTS;
  let map: Record<string, OAuthClient> = {};
  if (raw) {
    try {
      map = JSON.parse(raw) as Record<string, OAuthClient>;
    } catch {
      throw new AppError(
        "MCP_OAUTH_CLIENTS 설정이 JSON 이 아닙니다 — 서버 관리자에게 알려 주세요",
        503,
      );
    }
  }
  const host = new URL(issuer).hostname;
  const key = Object.keys(map).find((k) => host === k || host.endsWith(`.${k}`));
  const client = key ? map[key] : undefined;
  if (!client?.clientId)
    throw new AppError(
      `${host} 용 OAuth 클라이언트가 0Siri 에 등록돼 있지 않습니다 — 그 서비스 운영자에게 client_id 발급을 요청해야 합니다`,
      422,
    );
  return client;
}

async function json(http: typeof fetch, url: string, what: string) {
  const res = await http(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AppError(`${what}를 받지 못했습니다 (${res.status} ${url})`, 502);
  return (await res.json()) as Record<string, unknown>;
}

/** MCP 주소에서 인가 서버 주소들을 찾는다 (RFC 9728 → RFC 8414). */
export async function discover(mcpUrl: string, http: typeof fetch): Promise<OAuthEndpoints> {
  const u = new URL(mcpUrl);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  const prm = await json(
    http,
    `${u.origin}/.well-known/oauth-protected-resource${path}`,
    "MCP 서버의 OAuth 안내",
  );
  const issuer = (prm.authorization_servers as string[] | undefined)?.[0];
  if (!issuer) throw new AppError("MCP 서버가 인가 서버를 알려 주지 않습니다", 502);
  const meta = await json(
    http,
    `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    "인가 서버 정보",
  );
  const methods = meta.code_challenge_methods_supported as string[] | undefined;
  if (methods && !methods.includes("S256"))
    throw new AppError("인가 서버가 PKCE S256 을 지원하지 않습니다", 502);
  const authorizationEndpoint = String(meta.authorization_endpoint ?? "");
  const tokenEndpoint = String(meta.token_endpoint ?? "");
  if (!authorizationEndpoint || !tokenEndpoint)
    throw new AppError("인가 서버 정보에 authorize·token 주소가 없습니다", 502);
  return { resource: String(prm.resource ?? mcpUrl), authorizationEndpoint, tokenEndpoint };
}

/** 토큰 엔드포인트 호출 — 코드 교환과 갱신이 같은 모양을 쓴다. 공개 클라이언트라 비밀값은 없다. */
export async function tokenRequest(
  http: typeof fetch,
  tokenEndpoint: string,
  form: Record<string, string>,
  base: Pick<OAuthTokens, "tokenEndpoint" | "clientId" | "resource" | "refreshToken">,
): Promise<OAuthTokens> {
  const res = await http(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string")
    throw new AppError(
      `토큰을 받지 못했습니다: ${String(body.error_description ?? body.error ?? res.status)}`,
      502,
    );
  const expiresIn = Number(body.expires_in);
  return {
    ...base,
    accessToken: body.access_token,
    // 갱신 응답이 새 refresh 를 안 주면 쓰던 것을 그대로 쓴다
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : base.refreshToken,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined,
  };
}

/** 콜백 안내 페이지에 이름·오류 문장을 넣을 때 */
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
