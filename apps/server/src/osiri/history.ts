// 대화 기록 검색 — 방마다 쌓인 대화(records kind "conversations")를 EmbeddingGemma 2 로 색인해,
// 다른 방(세션)에서 한 말·한 일을 찾고, 최근에 움직인 방을 한눈에 본다. 모든 질의에 owner 를 건다.
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";
import { asDocument, asQuery, EMBED_DIM, embed } from "./embeddings.ts";

export interface HistoryHit {
  id: string;
  threadId: string;
  title: string;
  role: "user" | "assistant";
  text: string;
  score: number;
}
export interface RecentThread {
  threadId: string;
  title: string;
  updatedAt: string;
  /** 마지막 사용자 말 · 마지막 답 (앞부분만) */
  lastAsk?: string;
  lastAnswer?: string;
}
type Line = { id: string; role: "user" | "assistant"; text: string };

/** 색인·표시에 쓰는 글자 수 상한 — EmbeddingGemma 입력 길이와 화면 한 줄 요약 */
const TEXT_MAX = 2000;
const SNIPPET = 300;
const BATCH = 16;
export const DEFAULT_THREAD_TITLE = "기본 대화";
const toVector = (v: number[]) => `[${v.join(",")}]`;

/** AG-UI 메시지에서 사람이 읽는 글만 뽑는다 (도구 호출·시스템 메시지 제외) */
export function linesOf(messages: unknown[]): Line[] {
  const lines: Line[] = [];
  for (const raw of messages) {
    const m = raw as { id?: unknown; role?: unknown; content?: unknown };
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.id !== "string") continue;
    const text = (
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((part) =>
                (part as { type?: string }).type === "text" ? (part as { text?: string }).text : "",
              )
              .join("\n")
          : ""
    ).trim();
    if (text) lines.push({ id: m.id, role: m.role, text: text.slice(0, TEXT_MAX) });
  }
  return lines;
}

export class History {
  private ready: Promise<void> | undefined;
  constructor(
    private readonly db: Store,
    private readonly log: (line: string) => void = (line) =>
      console.error(`[osiri/history] ${line}`),
  ) {}
  private ensure() {
    this.ready ??= this.db
      .sql(
        `CREATE TABLE IF NOT EXISTS history(owner text NOT NULL,id text NOT NULL,thread_id text NOT NULL,role text NOT NULL,text text NOT NULL,embedding vector(${EMBED_DIM}) NOT NULL,indexed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,id))`,
      )
      .then(() =>
        this.db.sql("CREATE INDEX IF NOT EXISTS history_owner ON history(owner,thread_id)"),
      )
      .then(() => undefined)
      .catch((error) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }

  /** 새 메시지만 임베딩한다 — 이미 색인한 id 는 건너뛴다(대화는 매번 전체 배열로 저장된다). 색인한 줄 수를 돌려준다. */
  async index(owner: string, threadId: string, messages: unknown[]): Promise<number> {
    await this.ensure();
    const { rows } = await this.db.sql<{ id: string }>(
      "SELECT id FROM history WHERE owner=$1 AND thread_id=$2",
      [owner, threadId],
    );
    const seen = new Set(rows.map((r) => r.id));
    const fresh = linesOf(messages)
      .map((line) => ({ ...line, key: `${threadId}:${line.id}` }))
      .filter((line) => !seen.has(line.key));
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      const vectors = await embed(batch.map((line) => asDocument(line.text)));
      for (const [j, line] of batch.entries())
        await this.db.sql(
          "INSERT INTO history(owner,id,thread_id,role,text,embedding) VALUES($1,$2,$3,$4,$5,$6::vector) ON CONFLICT(owner,id) DO NOTHING",
          [owner, line.key, threadId, line.role, line.text, toVector(vectors[j] as number[])],
        );
    }
    return fresh.length;
  }

  /** 저장 경로에서 부른다 — 응답을 막지 않고, 실패는 로그로 남긴다(조용히 삼키지 않는다) */
  indexLater(owner: string, threadId: string, messages: unknown[]) {
    this.index(owner, threadId, messages).catch((error) =>
      this.log(`색인 실패 owner=${owner} thread=${threadId}: ${(error as Error).message}`),
    );
  }

  /** 이 대화의 메시지 id → 색인된 시각 (message-times 가 옛 메시지 시각을 되찾는 데 쓴다) */
  async indexedAt(owner: string, threadId: string): Promise<Map<string, Date>> {
    await this.ensure();
    const { rows } = await this.db.sql<{ id: string; indexed_at: Date }>(
      "SELECT id,indexed_at FROM history WHERE owner=$1 AND thread_id=$2",
      [owner, threadId],
    );
    return new Map(rows.map((r) => [r.id.slice(threadId.length + 1), new Date(r.indexed_at)]));
  }

  /** 이 기능 이전에 쌓인 대화를 한 번 색인한다 (서버 시작 때). 이미 색인한 줄은 건너뛰므로 다시 돌려도 된다. */
  async backfill(): Promise<number> {
    const { rows } = await this.db.sql<{
      owner: string;
      id: string;
      data: { messages?: unknown[] };
    }>("SELECT owner,id,data FROM records WHERE kind='conversations'");
    let total = 0;
    for (const row of rows) total += await this.index(row.owner, row.id, row.data?.messages ?? []);
    return total;
  }

  /** 지금 있는 대화방(+기본 대화)의 제목. 여기 없는 대화(지운 방에 남은 대화)는 검색·최근 목록에 내지 않는다 */
  private async titles(owner: string): Promise<Map<string, string>> {
    const rooms = await this.db.list<{ id: string; title: string }>(owner, "rooms");
    return new Map([
      ["default", DEFAULT_THREAD_TITLE],
      ...rooms.map((room): [string, string] => [room.id, room.title]),
    ]);
  }

  async search(
    owner: string,
    query: string,
    limit = 8,
    exceptThread?: string,
  ): Promise<HistoryHit[]> {
    await this.ensure();
    const [vector] = await embed([asQuery(query)]);
    const { rows } = await this.db.sql<{
      id: string;
      thread_id: string;
      role: "user" | "assistant";
      text: string;
      score: number;
    }>(
      `SELECT id,thread_id,role,text,1-(embedding<=>$2::vector) AS score FROM history WHERE owner=$1 AND thread_id<>$3 ORDER BY embedding<=>$2::vector LIMIT $4`,
      // 같은 방에서 같은 말을 여러 번 한 줄은 한 번만 보인다 — 넉넉히 읽어 거른다
      [owner, toVector(vector as number[]), exceptThread ?? "", Math.min(limit, 30) * 4],
    );
    const titles = await this.titles(owner);
    const seen = new Set<string>();
    const unique = rows.filter((row) => {
      const key = `${row.thread_id}\n${row.text}`;
      return titles.has(row.thread_id) && !seen.has(key) && seen.add(key);
    });
    return unique.slice(0, Math.min(limit, 30)).map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      title: titles.get(row.thread_id) as string,
      role: row.role,
      text: row.text.slice(0, SNIPPET),
      score: Number(row.score),
    }));
  }

  /** 최근에 대화가 오간 방 — 다른 세션에서 무슨 일을 하고 있었는지 */
  async recent(owner: string, limit = 8, exceptThread?: string): Promise<RecentThread[]> {
    const { rows } = await this.db.sql<{
      id: string;
      updated_at: string;
      data: { messages?: unknown[] };
    }>(
      "SELECT id,updated_at,data FROM records WHERE owner=$1 AND kind='conversations' AND id<>$2 ORDER BY updated_at DESC LIMIT $3",
      [owner, exceptThread ?? "", Math.min(limit, 30) * 3],
    );
    const titles = await this.titles(owner);
    const live = rows.filter((row) => titles.has(row.id)).slice(0, Math.min(limit, 30));
    return live.map((row) => {
      const lines = linesOf(row.data?.messages ?? []);
      const last = (role: Line["role"]) =>
        // findLast 는 앱 tsconfig(lib)에 없다 — 이 파일 타입을 앱도 import 한다
        [...lines]
          .reverse()
          .find((l) => l.role === role)
          ?.text.slice(0, SNIPPET);
      return {
        threadId: row.id,
        title: titles.get(row.id) as string,
        updatedAt: new Date(row.updated_at).toISOString(),
        lastAsk: last("user"),
        lastAnswer: last("assistant"),
      };
    });
  }
}

export function historyRoutes(history: History) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/history/search", async (c) => {
    const q = z.string().trim().min(1).max(500).parse(c.req.query("q"));
    return c.json(await history.search(c.get("owner"), q, 20));
  });
  app.get("/history/recent", async (c) => c.json(await history.recent(c.get("owner"), 12)));
  return app;
}
