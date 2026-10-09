// 0Siri 개인 기억 (0SIRI-SPEC §4.8, §17.4, §19 memories). pgvector 에 소유자별로 저장하고, 모든 질의에 owner 를 건다.
// "이 사용자에게만 적용" — 다른 사용자의 기억은 어떤 경로로도 섞이지 않는다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  memorySourceLabel,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { asDocument, asQuery, EMBED_DIM, embed } from "./embeddings.ts";

export interface Memory {
  id: string;
  text: string;
  source: string; // "user" | "chat" | "feedback" …
  createdAt: string;
  score?: number; // 검색 결과에만
  category: MemoryCategory;
  /** 출처를 화면 문구로 ("대화에서 학습" 등) */
  sourceLabel: string;
}
type MemoryRow = {
  id: string;
  text: string;
  source: string;
  created_at: string;
  category: string | null;
  score?: number;
};
const toVector = (v: number[]) => `[${v.join(",")}]`;
const COLUMNS = "id,text,source,created_at,category";
/** 한 번에 읽는 상한 (목록·분류 필터). 파일럿 규모 — 넘으면 페이지네이션이 필요하다 */
const LIST_MAX = 200;
const isCategory = (value: unknown): value is MemoryCategory =>
  MEMORY_CATEGORIES.some((c) => c === value);

// 분류는 규칙만 쓴다 (라우팅과 같은 원칙 — 분류에 LLM 을 부르지 않는다). 위에서부터 먼저 맞는 것.
const GOAL = /목표|계획|예정|하려고|할 거|할 것|하기로|준비 중|달성|까지 .*(한다|할|하기)/;
const PREFERENCE =
  /좋아|싫어|선호|취향|편하|불편|못 먹|안 먹|피한다|만 마신|만 먹|말투|톤|스타일|즐겨|원한다|원해|해 ?줘|하지 ?마/;
/** 기억 분류: 피드백 출처 → feedback, 그 밖에는 문장 규칙으로 goal · preference, 어느 쪽도 아니면 profile(그 사람에 대한 사실). */
export function classifyMemory(text: string, source: string): MemoryCategory {
  if (source === "feedback") return "feedback";
  if (GOAL.test(text)) return "goal";
  if (PREFERENCE.test(text)) return "preference";
  return "profile";
}
const MCP_ACCESS_ID = "memory-mcp-access";
/**
 * 다른 LLM 앱이 실제로 들어오는 기억 MCP 문(외부 엔드포인트)은 아직 서버에 없다 — 스위치는 저장만 된다.
 * 열려 있지 않은 문이므로 켜도 새는 것은 없다. 화면은 ready 가 false 면 «준비 중» 으로 보인다.
 * 문을 만들 때 그 진입점이 `mcpAccess(owner).enabled` 를 검사하게 하고 이 값을 true 로 바꾼다.
 */
const MCP_DOOR_READY = false;

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
      // 분류 열은 나중에 생겼다 — 없던 테이블에 더한다. 옛 행은 NULL 로 남고 읽을 때 규칙으로 분류한다
      .then(() => this.db.sql("ALTER TABLE memories ADD COLUMN IF NOT EXISTS category text"))
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
    fixed: { id?: string; createdAt?: string; category?: MemoryCategory } = {},
  ): Promise<Memory> {
    await this.ensure();
    const [vector] = await embed([asDocument(text)]);
    const memory: Memory = {
      id: fixed.id ?? randomUUID(),
      text,
      source,
      createdAt: fixed.createdAt ?? new Date().toISOString(),
      category: fixed.category ?? classifyMemory(text, source),
      sourceLabel: memorySourceLabel(source),
    };
    await this.db.sql(
      "INSERT INTO memories(owner,id,text,source,embedding,created_at,category) VALUES($1,$2,$3,$4,$5::vector,$6,$7) ON CONFLICT(owner,id) DO NOTHING",
      [
        owner,
        memory.id,
        text,
        source,
        toVector(vector as number[]),
        memory.createdAt,
        memory.category,
      ],
    );
    return memory;
  }
  /** 문장을 고친다 — 임베딩을 다시 계산하고, 분류도 새 문장으로 다시 정한다(직접 고른 분류를 주면 그것). */
  async update(
    owner: string,
    id: string,
    text: string,
    category?: MemoryCategory,
  ): Promise<Memory> {
    await this.ensure();
    const { rows: current } = await this.db.sql<{ source: string }>(
      "SELECT source FROM memories WHERE owner=$1 AND id=$2",
      [owner, id],
    );
    const found = current[0];
    if (!found) throw new AppError("기억을 찾을 수 없습니다", 404);
    const [vector] = await embed([asDocument(text)]);
    const { rows } = await this.db.sql<MemoryRow>(
      `UPDATE memories SET text=$3,embedding=$4::vector,category=$5 WHERE owner=$1 AND id=$2 RETURNING ${COLUMNS}`,
      [
        owner,
        id,
        text,
        toVector(vector as number[]),
        category ?? classifyMemory(text, found.source),
      ],
    );
    const updated = rows[0];
    // 읽고 쓰는 사이에 지워졌다
    if (!updated) throw new AppError("기억을 찾을 수 없습니다", 404);
    return fromRow(updated);
  }
  /** 이 소유자의 기억을 전부 지운다 (탈퇴 정리). 지운 건수를 돌려준다. */
  async removeAll(owner: string): Promise<number> {
    await this.ensure();
    const { rows } = await this.db.sql<{ id: string }>(
      "DELETE FROM memories WHERE owner=$1 RETURNING id",
      [owner],
    );
    return rows.length;
  }
  // ---- 다른 LLM 앱이 읽는 기억 MCP 문 (화면 8). 켤 때만 열린다 — 기록이 없으면 닫힘 ----
  async mcpAccess(owner: string): Promise<{ enabled: boolean; ready: boolean }> {
    const saved = await this.db.get<{ enabled: boolean }>(owner, "settings", MCP_ACCESS_ID);
    return { enabled: saved?.enabled === true, ready: MCP_DOOR_READY };
  }
  async setMcpAccess(
    owner: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; ready: boolean }> {
    await this.db.put(owner, "settings", {
      id: MCP_ACCESS_ID,
      enabled,
      updatedAt: new Date().toISOString(),
    });
    return { enabled, ready: MCP_DOOR_READY };
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
  /**
   * `category` 를 주면 그 분류만. 분류 열이 생기기 전의 옛 행(NULL)은 읽을 때 규칙으로 분류하므로,
   * SQL 은 «그 분류이거나 NULL» 까지 넓게 읽고(상한 LIST_MAX) 여기서 마저 거른다.
   */
  async list(owner: string, limit = LIST_MAX, category?: MemoryCategory): Promise<Memory[]> {
    await this.ensure();
    if (!category) {
      const { rows } = await this.db.sql<MemoryRow>(
        `SELECT ${COLUMNS} FROM memories WHERE owner=$1 ORDER BY created_at DESC LIMIT $2`,
        [owner, limit],
      );
      return rows.map(fromRow);
    }
    const { rows } = await this.db.sql<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE owner=$1 AND (category=$2 OR category IS NULL) ORDER BY created_at DESC LIMIT $3`,
      [owner, category, LIST_MAX],
    );
    return rows
      .map(fromRow)
      .filter((m) => m.category === category)
      .slice(0, limit);
  }
  /** 코사인 유사도 상위 N. 임베딩은 단위 벡터라 `<=>` (코사인 거리) 로 충분. */
  async search(
    owner: string,
    query: string,
    limit = 10,
    category?: MemoryCategory,
  ): Promise<Memory[]> {
    await this.ensure();
    const [vector] = await embed([asQuery(query)]);
    if (!category) {
      const { rows } = await this.db.sql<MemoryRow>(
        `SELECT ${COLUMNS},1-(embedding<=>$2::vector) AS score FROM memories WHERE owner=$1 ORDER BY embedding<=>$2::vector LIMIT $3`,
        [owner, toVector(vector as number[]), limit],
      );
      return rows.map(fromRow);
    }
    const { rows } = await this.db.sql<MemoryRow>(
      `SELECT ${COLUMNS},1-(embedding<=>$2::vector) AS score FROM memories WHERE owner=$1 AND (category=$3 OR category IS NULL) ORDER BY embedding<=>$2::vector LIMIT $4`,
      [owner, toVector(vector as number[]), category, LIST_MAX],
    );
    return rows
      .map(fromRow)
      .filter((m) => m.category === category)
      .slice(0, limit);
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
  category: isCategory(row.category) ? row.category : classifyMemory(row.text, row.source),
  sourceLabel: memorySourceLabel(row.source),
});

/**
 * S8 기억 라우트 — /api 아래, 인증 뒤.
 * GET /memories?category=&q= · POST /memories · PATCH /memories/:id · DELETE /memories/:id · GET·PATCH /memories/mcp-access
 */
export function memoryRoutes(memories: Memories) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const categorySchema = z.enum(MEMORY_CATEGORIES).optional();
  const textSchema = z.string().trim().min(1).max(2000);
  app.get("/memories", async (c) => {
    const q = c.req.query("q")?.trim();
    const owner = c.get("owner");
    // 빈 값(?category=)은 필터 없음이다
    const category = categorySchema.parse(c.req.query("category") || undefined);
    return c.json(
      q
        ? await memories.search(owner, q, Number(c.req.query("limit") ?? 10), category)
        : await memories.list(owner, undefined, category),
    );
  });
  app.post("/memories", async (c) => {
    const body = z
      .object({
        text: z.string().min(1).max(2000),
        source: z.string().max(40).optional(),
        category: categorySchema,
      })
      .parse(await c.req.json());
    return c.json(
      await memories.add(c.get("owner"), body.text, body.source, { category: body.category }),
    );
  });
  // /memories/:id 보다 먼저 등록한다 — "mcp-access" 가 id 로 읽히지 않게
  app.get("/memories/mcp-access", async (c) => c.json(await memories.mcpAccess(c.get("owner"))));
  app.patch("/memories/mcp-access", async (c) => {
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    return c.json(await memories.setMcpAccess(c.get("owner"), body.enabled));
  });
  app.patch("/memories/:id", async (c) => {
    const body = z.object({ text: textSchema, category: categorySchema }).parse(await c.req.json());
    return c.json(
      await memories.update(c.get("owner"), c.req.param("id"), body.text, body.category),
    );
  });
  app.delete("/memories/:id", async (c) => {
    await memories.remove(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  return app;
}
