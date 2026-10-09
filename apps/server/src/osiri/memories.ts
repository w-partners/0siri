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
      .then(() => undefined)
      .catch((error) => {
        // 실패한 준비를 붙들고 있지 않는다 — 다음 호출이 다시 시도한다
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
  /** `fixed.id` 를 주면 같은 id 는 한 번만 들어간다 (채팅 재시도·이관의 멱등성). */
  async add(
    owner: string,
    text: string,
    source = "user",
    fixed: { id?: string; createdAt?: string } = {},
  ): Promise<Memory> {
    await this.ensure();
    const [vector] = await embed([asDocument(text)]);
    const memory: Memory = {
      id: fixed.id ?? randomUUID(),
      text,
      source,
      createdAt: fixed.createdAt ?? new Date().toISOString(),
    };
    await this.db.sql(
      "INSERT INTO memories(owner,id,text,source,embedding,created_at) VALUES($1,$2,$3,$4,$5::vector,$6) ON CONFLICT(owner,id) DO NOTHING",
      [owner, memory.id, text, source, toVector(vector as number[]), memory.createdAt],
    );
    return memory;
  }
  /**
   * 프롬프트용 관련 기억 (소유자 한정). 검색이 실패하면 빈 목록으로 숨기지 않고 `error` 로 알린다 —
   * 호출자는 "기억을 못 읽었다"고 모델에게 말해야 한다.
   */
  async forPrompt(
    owner: string,
    query: string,
    limit = 8,
  ): Promise<{ memories: Pick<Memory, "text" | "source">[]; error?: string }> {
    try {
      await this.ensure();
      // 기억이 한 건도 없으면 임베딩(모델 적재)을 돌리지 않는다
      const { rows } = await this.db.sql("SELECT 1 FROM memories WHERE owner=$1 LIMIT 1", [owner]);
      if (rows.length === 0) return { memories: [] };
      const found = query.trim()
        ? await this.search(owner, query, limit)
        : await this.list(owner, limit);
      return { memories: found.map(({ text, source }) => ({ text, source })) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[osiri] 기억 검색 실패 owner=${owner}: ${message}`);
      return { memories: [], error: message };
    }
  }
  /**
   * 옛 저장소(records kind "memories" — 채팅 remember_fact 가 쓰던 곳)를 이 테이블로 한 번 옮긴다.
   * 같은 id 가 이미 있으면 건너뛰므로 매 기동마다 불러도 된다. 원본 records 는 지우지 않는다.
   */
  async migrateLegacy(): Promise<{ found: number; migrated: number; skipped: number }> {
    const legacy = await this.db.scan<{
      id: string;
      text?: unknown;
      source?: unknown;
      createdAt?: unknown;
    }>("memories");
    if (legacy.length === 0) return { found: 0, migrated: 0, skipped: 0 };
    await this.ensure();
    let migrated = 0;
    let skipped = 0;
    for (const { owner, value } of legacy) {
      if (typeof value.text !== "string" || !value.text.trim()) {
        // 한 건 때문에 나머지 이관을 막지 않는다 — 원본은 records 에 그대로 남는다
        console.error(`[osiri] 옛 기억 ${owner}/${value.id} 에 text 가 없어 건너뜁니다`);
        skipped++;
        continue;
      }
      const { rows } = await this.db.sql("SELECT 1 FROM memories WHERE owner=$1 AND id=$2", [
        owner,
        value.id,
      ]);
      if (rows.length) continue;
      await this.add(owner, value.text, typeof value.source === "string" ? value.source : "chat", {
        id: value.id,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
      });
      migrated++;
    }
    return { found: legacy.length, migrated, skipped };
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
