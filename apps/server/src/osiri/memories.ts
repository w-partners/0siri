// 0Siri 개인 기억 (0SIRI-SPEC §4.8, §17.4, §19 memories). pgvector 에 소유자별로 저장하고, 모든 질의에 owner 를 건다.
// "이 사용자에게만 적용" — 다른 사용자의 기억은 어떤 경로로도 섞이지 않는다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { asDocument, asQuery, EMBED_DIM, embed } from "./embeddings.ts";

export interface Memory {
  id: string;
  text: string;
  source: string; // "user" | "chat" | "feedback" …
  createdAt: string;
  score?: number; // 검색 결과에만
}
type MemoryRow = { id: string; text: string; source: string; created_at: string; score?: number };
const toVector = (v: number[]) => `[${v.join(",")}]`;

export class Memories {
  private ready: Promise<void> | undefined;
  constructor(private readonly db: Store) {}
  private ensure() {
    // 차원은 EMBED_DIM 으로 고정된다 — 바꾸면 새 테이블이 아니라 재색인이 필요하다 (ponytail: 마이그레이션 없음, 파일럿 규모)
    this.ready ??= this.db
      .sql(
        `CREATE TABLE IF NOT EXISTS memories(owner text NOT NULL,id text NOT NULL,text text NOT NULL,source text NOT NULL,embedding vector(${EMBED_DIM}) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,id))`,
      )
      .then(() => this.db.sql("CREATE INDEX IF NOT EXISTS memories_owner ON memories(owner)"))
      .then(() => undefined);
    return this.ready;
  }
  async add(owner: string, text: string, source = "user"): Promise<Memory> {
    await this.ensure();
    const [vector] = await embed([asDocument(text)]);
    const memory: Memory = { id: randomUUID(), text, source, createdAt: new Date().toISOString() };
    await this.db.sql(
      "INSERT INTO memories(owner,id,text,source,embedding,created_at) VALUES($1,$2,$3,$4,$5::vector,$6)",
      [owner, memory.id, text, source, toVector(vector as number[]), memory.createdAt],
    );
    return memory;
  }
  async list(owner: string, limit = 200): Promise<Memory[]> {
    await this.ensure();
    const { rows } = await this.db.sql<MemoryRow>(
      "SELECT id,text,source,created_at FROM memories WHERE owner=$1 ORDER BY created_at DESC LIMIT $2",
      [owner, limit],
    );
    return rows.map(fromRow);
  }
  /** 코사인 유사도 상위 N. 임베딩은 단위 벡터라 `<=>` (코사인 거리) 로 충분. */
  async search(owner: string, query: string, limit = 10): Promise<Memory[]> {
    await this.ensure();
    const [vector] = await embed([asQuery(query)]);
    const { rows } = await this.db.sql<MemoryRow>(
      "SELECT id,text,source,created_at,1-(embedding<=>$2::vector) AS score FROM memories WHERE owner=$1 ORDER BY embedding<=>$2::vector LIMIT $3",
      [owner, toVector(vector as number[]), limit],
    );
    return rows.map(fromRow);
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.ensure();
    const { rows } = await this.db.sql<{ id: string }>(
      "DELETE FROM memories WHERE owner=$1 AND id=$2 RETURNING id",
      [owner, id],
    );
    if (rows.length === 0) throw new AppError("기억을 찾을 수 없습니다", 404);
  }
}
const fromRow = (row: MemoryRow): Memory => ({
  id: row.id,
  text: row.text,
  source: row.source,
  createdAt: new Date(row.created_at).toISOString(),
  ...(row.score === undefined ? {} : { score: Number(row.score) }),
});

/** S8 기억 라우트 — /api 아래, 인증 뒤. GET /memories?q= · POST /memories · DELETE /memories/:id */
export function memoryRoutes(memories: Memories) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/memories", async (c) => {
    const q = c.req.query("q")?.trim();
    const owner = c.get("owner");
    return c.json(
      q
        ? await memories.search(owner, q, Number(c.req.query("limit") ?? 10))
        : await memories.list(owner),
    );
  });
  app.post("/memories", async (c) => {
    const body = z
      .object({ text: z.string().min(1).max(2000), source: z.string().max(40).optional() })
      .parse(await c.req.json());
    return c.json(await memories.add(c.get("owner"), body.text, body.source));
  });
  app.delete("/memories/:id", async (c) => {
    await memories.remove(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  return app;
}
