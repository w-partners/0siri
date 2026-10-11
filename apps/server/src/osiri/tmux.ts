// 내 PC 의 tmux 를 영시리 대화방에 붙인다 (마스터 2026-10-11 «내 PC 의 TMUX 를 영시리에게 붙이는 거야»).
// 들어가는 길: 그 tmux 에 글을 넣어 주는 웹훅(포털 `/api/webhook/<터미널>` 형식 {"command": "..."}).
// 돌아오는 길: 터미널 속 에이전트가 이 턴에만 쓰는 회신 주소로 답을 POST 한다 — 화면 긁기(capture-pane) 대신.
// 서버가 남의 주소로 요청을 보내므로 붙이기는 관리자만. 답이 없으면 조용히 넘어가지 않고 «답이 없었다» 로 끝낸다.
import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export type TmuxLink = { id: string; webhook: string; attachedAt: string };
const LINKS = "tmuxLinks";
const WAIT_MS = 10 * 60 * 1000; // ponytail: 한 턴 최대 10분. 더 긴 작업은 터미널이 «진행 중» 을 먼저 회신하는 식으로

type Waiter = { owner: string; key: string; resolve: (text: string) => void };

export class Tmux {
  private readonly waiting = new Map<string, Waiter>();
  constructor(
    private readonly db: Store,
    private readonly publicUrl: string,
    private readonly send: typeof fetch = fetch,
    private readonly waitMs = WAIT_MS,
  ) {}

  linked(owner: string, threadId: string) {
    return this.db.get<TmuxLink>(owner, LINKS, threadId);
  }
  async attach(owner: string, threadId: string, webhook: string) {
    const link = { id: threadId, webhook, attachedAt: new Date().toISOString() };
    await this.db.put(owner, LINKS, link);
    return link;
  }
  detach(owner: string, threadId: string) {
    return this.db.remove(owner, LINKS, threadId);
  }

  /** 한 턴: tmux 로 보내고 회신을 기다린다. 보내기 실패·시간 초과는 던진다 */
  async ask(owner: string, link: TmuxLink, text: string, signal?: AbortSignal) {
    const turn = randomUUID();
    const key = randomBytes(24).toString("base64url");
    const replyUrl = `${this.publicUrl.replace(/\/$/, "")}/api/tmux/reply/${turn}`;
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(turn);
        reject(
          new AppError(`터미널이 ${Math.round(this.waitMs / 60000)}분 안에 답하지 않았습니다`, 503),
        );
      }, this.waitMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        this.waiting.delete(turn);
        reject(new AppError("대화가 멈춰 기다리기를 그만뒀습니다", 409));
      });
      this.waiting.set(turn, {
        owner,
        key,
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
      });
    });
    answer.catch(() => {}); // 보내기가 먼저 실패하면 이 거절은 아래 throw 가 대신 알린다
    const command = `[영시리] ${text}\n\n[영시리 회신] 답은 이 대화창이 아니라 아래로 보내세요. 이 턴에만 쓰는 주소입니다.\ncurl -X POST "${replyUrl}" -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"text":"답"}'`;
    const res = await this.send(link.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      this.waiting.delete(turn);
      throw new AppError(
        `터미널에 보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    });
    if (!res.ok) {
      this.waiting.delete(turn);
      throw new AppError(`터미널에 보내지 못했습니다: 웹훅 ${res.status}`, 502);
    }
    return answer;
  }

  /** 터미널의 회신. 열쇠가 맞고 아직 기다리는 턴이어야 한다 */
  reply(turn: string, bearer: string | undefined, text: string) {
    const waiter = this.waiting.get(turn);
    if (!waiter) throw new AppError("이미 끝났거나 없는 턴입니다", 410);
    if (bearer !== `Bearer ${waiter.key}`) throw new AppError("열쇠가 맞지 않습니다", 403);
    this.waiting.delete(turn);
    waiter.resolve(text);
  }
}

/** 회신은 로그인 없이 턴 열쇠로 — 인증 미들웨어 앞에 단다 */
export function tmuxReplyRoutes(tmux: Tmux) {
  const app = new Hono();
  app.post("/tmux/reply/:turn", async (c) => {
    const { text } = z.object({ text: z.string().min(1).max(20_000) }).parse(await c.req.json());
    tmux.reply(c.req.param("turn"), c.req.header("authorization"), text);
    return c.json({ ok: true });
  });
  return app;
}

export function tmuxRoutes(tmux: Tmux, requireAdmin: (owner: string) => Promise<unknown>) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/tmux/:threadId", async (c) =>
    c.json({ link: (await tmux.linked(c.get("owner"), c.req.param("threadId"))) ?? null }),
  );
  app.put("/tmux/:threadId", async (c) => {
    await requireAdmin(c.get("owner"));
    const { webhook } = z
      .object({
        webhook: z
          .string()
          .url()
          .regex(/^https?:\/\//),
      })
      .parse(await c.req.json());
    return c.json({ link: await tmux.attach(c.get("owner"), c.req.param("threadId"), webhook) });
  });
  app.delete("/tmux/:threadId", async (c) => {
    await tmux.detach(c.get("owner"), c.req.param("threadId"));
    return c.json({ link: null });
  });
  return app;
}
