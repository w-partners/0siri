// 피드 (마스터 2026-10-10): 내가 적은 관심 프롬프트로 웹에서 모은 글 + 관리자가 모두에게 보내는 글.
// 글마다 좋아요(내 것만 저장) · 공유(기기 공유 시트, 서버 없음) · 토론(그 글로 새 대화방 — rooms.createTopic).
// 관심 프롬프트는 주기적으로 다시 찾는다 — 그 주기가 «자동화» 화면의 크론 목록이다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  FEED_EVERY_HOURS,
  FEED_PROMPT_MAX,
  FEED_RESULTS_PER_RUN,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { SearchService } from "../search.ts";
import type { Accounts } from "./accounts.ts";

export interface FeedPrompt {
  id: string;
  prompt: string;
  everyHours: number;
  active: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  /** 마지막 실행 결과 한 줄 — 실패도 여기 그대로 남아 화면에 보인다 */
  lastResult?: string;
  lastError?: string;
}
export interface FeedPost {
  id: string;
  source: "admin" | "prompt";
  promptId?: string;
  title: string;
  body: string;
  url?: string;
  createdAt: string;
}
interface Reaction {
  id: string; // = postId
  liked: boolean;
}
export type FeedItem = FeedPost & { liked: boolean; prompt?: string };

const PROMPTS = "feed-prompts";
const POSTS = "feed-posts";
const REACTIONS = "feed-reactions";
const BROADCAST = "system"; // 관리자 글은 모두가 보는 한 곳
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const now = () => new Date().toISOString();

type Search = Pick<SearchService, "search">;

export class Feed {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: Store,
    private readonly searchService: Search,
  ) {}

  async list(owner: string): Promise<FeedItem[]> {
    const [mine, broadcast, reactions, prompts] = await Promise.all([
      this.db.list<FeedPost>(owner, POSTS),
      this.db.list<FeedPost>(BROADCAST, POSTS),
      this.db.list<Reaction>(owner, REACTIONS),
      this.db.list<FeedPrompt>(owner, PROMPTS),
    ]);
    const liked = new Set(reactions.filter((r) => r.liked).map((r) => r.id));
    const promptOf = new Map(prompts.map((p) => [p.id, p.prompt]));
    return [...mine, ...broadcast]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((post) => ({
        ...post,
        liked: liked.has(post.id),
        ...(post.promptId && promptOf.has(post.promptId)
          ? { prompt: promptOf.get(post.promptId) }
          : {}),
      }));
  }

  async post(owner: string, id: string): Promise<FeedPost> {
    const post =
      (await this.db.get<FeedPost>(owner, POSTS, id)) ??
      (await this.db.get<FeedPost>(BROADCAST, POSTS, id));
    if (!post) throw new AppError("피드 글을 찾지 못했습니다", 404);
    return post;
  }

  async like(owner: string, id: string, liked: boolean) {
    await this.post(owner, id);
    await this.db.put<Reaction>(owner, REACTIONS, { id, liked });
    return { id, liked };
  }

  async broadcast(input: { title: string; body: string; url?: string }) {
    return this.db.put<FeedPost>(BROADCAST, POSTS, {
      id: randomUUID(),
      source: "admin",
      createdAt: now(),
      ...input,
    });
  }

  // ---- 관심 프롬프트 (주기 실행 = 자동화 화면의 크론) ----
  prompts(owner: string) {
    return this.db.list<FeedPrompt>(owner, PROMPTS);
  }

  async addPrompt(owner: string, prompt: string, everyHours: number) {
    if ((await this.prompts(owner)).length >= FEED_PROMPT_MAX)
      throw new AppError(`관심 프롬프트는 ${FEED_PROMPT_MAX}개까지입니다`, 409);
    const saved = await this.db.put<FeedPrompt>(owner, PROMPTS, {
      id: randomUUID(),
      prompt,
      everyHours,
      active: true,
      createdAt: now(),
      nextRunAt: now(),
    });
    return this.run(owner, saved); // 만들자마자 한 번 — 빈 피드를 보고 기다리지 않게
  }

  async setActive(owner: string, id: string, active: boolean) {
    const prompt = await this.db.get<FeedPrompt>(owner, PROMPTS, id);
    if (!prompt) throw new AppError("관심 프롬프트를 찾지 못했습니다", 404);
    return this.db.put(owner, PROMPTS, { ...prompt, active });
  }

  async removePrompt(owner: string, id: string) {
    await this.db.remove(owner, PROMPTS, id);
  }

  /** 프롬프트 하나를 지금 실행한다. 실패는 lastError 로 남기고 던지지 않는다 — 다음 주기에 다시 시도. */
  async run(owner: string, prompt: FeedPrompt): Promise<FeedPrompt> {
    const ran = now();
    try {
      const found = await this.searchService.search(owner, `feed-${prompt.id}`, {
        objective: `최신 소식·글: ${prompt.prompt}`,
        search_queries: [prompt.prompt],
      });
      const seen = new Set(
        (await this.db.listByField<FeedPost>(owner, POSTS, "promptId", prompt.id)).map(
          (p) => p.url,
        ),
      );
      const fresh = found.results.filter((r) => !seen.has(r.url)).slice(0, FEED_RESULTS_PER_RUN);
      for (const r of fresh)
        await this.db.put<FeedPost>(owner, POSTS, {
          id: randomUUID(),
          source: "prompt",
          promptId: prompt.id,
          title: r.title ?? r.url,
          body: (r.excerpts[0] ?? "").slice(0, 400),
          url: r.url,
          createdAt: now(),
        });
      return this.db.put(owner, PROMPTS, {
        ...prompt,
        lastRunAt: ran,
        nextRunAt: hours(prompt.everyHours),
        lastResult: `새 글 ${fresh.length}건`,
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[osiri] 피드 실행 실패 ${prompt.id}: ${message}`);
      return this.db.put(owner, PROMPTS, {
        ...prompt,
        lastRunAt: ran,
        nextRunAt: hours(1),
        lastError: message.slice(0, 300),
      });
    }
  }

  async runNow(owner: string, id: string) {
    const prompt = await this.db.get<FeedPrompt>(owner, PROMPTS, id);
    if (!prompt) throw new AppError("관심 프롬프트를 찾지 못했습니다", 404);
    return this.run(owner, prompt);
  }

  /** 때가 된 프롬프트를 모두 돌린다. ponytail: 순차 실행 — 지인 규모에서는 충분, 많아지면 동시 실행 상한을 둔다. */
  async tick() {
    for (const { owner, value } of await this.db.scan<FeedPrompt>(PROMPTS))
      if (value.active && value.nextRunAt <= now()) await this.run(owner, value);
  }

  start(intervalMs = 10 * 60_000) {
    this.timer ??= setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    clearInterval(this.timer);
  }
}

export function feedRoutes(feed: Feed, accounts: Pick<Accounts, "requireRole">) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/feed", async (c) => c.json(await feed.list(c.get("owner"))));
  app.post("/feed/:id/like", async (c) => {
    const { liked } = z.object({ liked: z.boolean() }).parse(await c.req.json());
    return c.json(await feed.like(c.get("owner"), c.req.param("id"), liked));
  });
  app.get("/feed/prompts", async (c) => c.json(await feed.prompts(c.get("owner"))));
  app.post("/feed/prompts", async (c) => {
    const body = z
      .object({
        prompt: z.string().trim().min(2).max(200),
        everyHours: z.number().int().min(1).max(168).default(FEED_EVERY_HOURS),
      })
      .parse(await c.req.json());
    return c.json(await feed.addPrompt(c.get("owner"), body.prompt, body.everyHours));
  });
  app.patch("/feed/prompts/:id", async (c) => {
    const { active } = z.object({ active: z.boolean() }).parse(await c.req.json());
    return c.json(await feed.setActive(c.get("owner"), c.req.param("id"), active));
  });
  app.post("/feed/prompts/:id/run", async (c) =>
    c.json(await feed.runNow(c.get("owner"), c.req.param("id"))),
  );
  app.delete("/feed/prompts/:id", async (c) => {
    await feed.removePrompt(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/admin/feed", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    const body = z
      .object({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(2000),
        url: z.url({ protocol: /^https?$/ }).optional(),
      })
      .parse(await c.req.json());
    return c.json(await feed.broadcast(body));
  });
  return app;
}
