// 푸시 알림 — FCM HTTP v1 직접 (tplanner·wgolf 와 같은 방식, PUSH-20261012-01 회신). firebase-admin 없이 서비스 계정 JWT → access token.
//  - 자격증명은 서버 env 에만: FIREBASE_PROJECT_ID · FIREBASE_CLIENT_EMAIL · FIREBASE_PRIVATE_KEY. 없으면 «꺼짐» 을 로그와 /push/status 로 드러낸다.
//  - 기기 토큰은 사용자별, TOKEN_ENCRYPTION_KEY 가 있으면 암호문으로만 저장. FCM 이 죽은 토큰이라 하면 지운다.
// ponytail: 보내기는 한 번만 시도(outbox·재시도 없음) — 놓친 알림이 문제 되면 wgolf 처럼 outbox + 지수 재시도로.
import { createHash, createSign } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { PUSH_CHANNEL } from "../../../../packages/domain/src/osiri.ts";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Store } from "../db.ts";

const TOKENS = "push-tokens";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** 다시 보내도 소용없는 FCM 오류 — 토큰을 지운다 */
const DEAD = ["UNREGISTERED", "NOT_FOUND", "INVALID_ARGUMENT"];

interface StoredToken {
  id: string;
  platform: "android";
  token?: string;
  tokenCiphertext?: string;
  createdAt: string;
}
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export class Push {
  private access?: { token: string; expiresAt: number };
  private warned = false;
  constructor(
    private readonly db: Store,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly http: typeof fetch = fetch,
  ) {}

  /** 꺼져 있으면 왜인지(빠진 env 이름) */
  missing(): string[] {
    return ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"].filter(
      (k) => !this.env[k],
    );
  }
  async register(owner: string, token: string) {
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    await this.db.put(owner, TOKENS, {
      id: createHash("sha256").update(token).digest("hex"),
      platform: "android",
      ...(key ? { tokenCiphertext: encryptSecret(token, key) } : { token }),
      createdAt: new Date().toISOString(),
    } satisfies StoredToken);
  }
  async unregister(owner: string, token: string) {
    await this.db.remove(owner, TOKENS, createHash("sha256").update(token).digest("hex"));
  }
  async status(owner: string) {
    return {
      configured: this.missing().length === 0,
      missing: this.missing(),
      devices: (await this.db.list<StoredToken>(owner, TOKENS)).length,
    };
  }

  /** 서비스 계정 JWT(RS256) → OAuth access token. 만료 1분 전까지 재사용 */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - 60_000 > Date.now()) return this.access.token;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.env.FIREBASE_CLIENT_EMAIL,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    // env 에 한 줄로 넣으면 줄바꿈이 \n 글자로 남는다
    const key = (this.env.FIREBASE_PRIVATE_KEY as string).replace(/\\n/g, "\n");
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
    const response = await this.http("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token)
      throw new Error(`FCM 인증 실패 ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
    this.access = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  /** 사람들의 모든 기기로. 꺼져 있으면 보내지 않고 한 번 알린다. 실패는 로그에 남기고 대화를 막지 않는다. */
  async notify(userIds: string[], message: PushMessage) {
    const missing = this.missing();
    if (missing.length) {
      if (!this.warned)
        console.warn(`[osiri/push] 푸시 꺼짐 — 서버 env 에 ${missing.join(", ")} 이(가) 없습니다`);
      this.warned = true;
      return { sent: 0, skipped: "not_configured" as const };
    }
    let sent = 0;
    for (const owner of userIds)
      for (const stored of await this.db.list<StoredToken>(owner, TOKENS)) {
        const key = this.env.TOKEN_ENCRYPTION_KEY;
        const token =
          stored.tokenCiphertext && key ? decryptSecret(stored.tokenCiphertext, key) : stored.token;
        if (!token) continue;
        try {
          const response = await this.http(
            `https://fcm.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/messages:send`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${await this.accessToken()}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                message: {
                  token,
                  notification: { title: message.title, body: message.body },
                  data: message.data ?? {},
                  android: { priority: "HIGH", notification: { channel_id: PUSH_CHANNEL } },
                },
              }),
            },
          );
          if (response.ok) {
            sent++;
            continue;
          }
          const error = (await response.json().catch(() => ({}))) as {
            error?: { status?: string; details?: { errorCode?: string }[] };
          };
          const code =
            error.error?.details?.find((d) => d.errorCode)?.errorCode ?? error.error?.status;
          if (code && DEAD.includes(code)) await this.db.remove(owner, TOKENS, stored.id);
          console.error(`[osiri/push] 보내기 실패 ${response.status} ${code ?? ""} user=${owner}`);
        } catch (error) {
          console.error(`[osiri/push] 보내기 실패 user=${owner}: ${(error as Error).message}`);
        }
      }
    return { sent };
  }
}

export function pushRoutes(push: Push) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const body = z.object({ token: z.string().min(10).max(4096) });
  app.get("/push/status", async (c) => c.json(await push.status(c.get("owner"))));
  app.post("/push/tokens", async (c) => {
    await push.register(c.get("owner"), body.parse(await c.req.json()).token);
    return c.json(await push.status(c.get("owner")), 201);
  });
  app.delete("/push/tokens", async (c) => {
    await push.unregister(c.get("owner"), body.parse(await c.req.json()).token);
    return c.json({ ok: true });
  });
  return app;
}
