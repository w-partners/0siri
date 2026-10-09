// 0SIRI-SPEC §22-5 합격 기준: 한국어 질의 12건 샘플에서 기대 항목 상위 노출, 소유자 격리.
// 모델(q8, 299MB)은 EMBED_CACHE_DIR(기본 ~/.cache/huggingface) 에서 읽고 없으면 내려받는다 — 첫 실행은 느리다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Memories, memoryRoutes } from "../apps/server/src/osiri/memories.ts";

let db: Store, directory: string, memories: Memories;
let app: Hono<{ Variables: { owner: string } }>;
const call = (path: string, owner: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const SEED = [
  "커피는 아이스 아메리카노만 마신다. 시럽은 넣지 않는다",
  "딸 이름은 서연이고 2019년생, 초등학교 1학년",
  "매주 화요일 저녁 7시에 테니스 레슨이 있다",
  "회사는 판교에 있고 출근은 신분당선으로 한다",
  "고양이 두 마리를 키운다. 이름은 모모와 나비",
  "글은 존댓말보다 반말 톤이 편하다고 했다",
  "2026년 11월에 제주도 가족 여행을 계획 중이다",
  "블로그 주제는 부동산 세금, 특히 양도소득세 위주",
  "매운 음식을 못 먹는다. 특히 마라탕은 피한다",
  "주로 쓰는 차는 흰색 아이오닉 5, 주차는 지하 2층",
  "어머니 생신은 음력 3월 12일",
  "운동은 아침 6시에 한강에서 러닝, 주 3회",
];
const QUERIES: [string, number][] = [
  ["커피 취향이 뭐였지", 0],
  ["딸아이 몇 살이야", 1],
  ["테니스 수업 언제야", 2],
  ["출근할 때 무슨 지하철 타", 3],
  ["우리집 고양이 이름", 4],
  ["말투는 어떻게 해줄까", 5],
  ["가족 여행 어디로 가기로 했지", 6],
  ["블로그에 뭐 쓰기로 했더라", 7],
  ["못 먹는 음식", 8],
  ["차 어디에 세워뒀어", 9],
  ["엄마 생일 언제", 10],
  ["운동 루틴", 11],
];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-memories-"));
  db = await createStore({ dataDir: join(directory, "db") });
  memories = new Memories(db);
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", memoryRoutes(memories));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("한국어 질의 12건 — 기대 기억이 1위, 소유자 격리, 삭제", { timeout: 600_000 }, async () => {
  for (const text of SEED)
    assert.equal((await call("/api/memories", "owner-a", { text })).status, 200);
  // 다른 사용자의 기억은 비슷한 내용이어도 섞이지 않는다
  await call("/api/memories", "owner-b", { text: "커피는 라떼만 마신다" });

  const misses: string[] = [];
  let top1 = 0;
  for (const [q, expected] of QUERIES) {
    const result = (await (
      await call(`/api/memories?q=${encodeURIComponent(q)}&limit=3`, "owner-a")
    ).json()) as { text: string; score: number }[];
    assert.equal(result.length, 3);
    assert.ok(
      result.every((r) => r.text !== "커피는 라떼만 마신다"),
      "남의 기억이 섞였다",
    );
    if (result[0]?.text === SEED[expected]) top1++;
    else misses.push(`${q} → 1위 "${result[0]?.text}" (기대 "${SEED[expected]}")`);
    assert.ok(
      result.slice(0, 3).some((r) => r.text === SEED[expected]),
      `상위 3 밖: ${q}`,
    );
  }
  console.log(
    `# top1 ${top1}/${QUERIES.length}${misses.length ? `\n# ${misses.join("\n# ")}` : ""}`,
  );
  assert.ok(top1 >= 10, `1위 적중 ${top1}/12 — 기준 10 미만`);

  // 목록·삭제·격리
  const listA = (await (await call("/api/memories", "owner-a")).json()) as { id: string }[];
  assert.equal(listA.length, SEED.length);
  const listB = (await (await call("/api/memories", "owner-b")).json()) as { id: string }[];
  assert.equal(listB.length, 1);
  // 남의 기억 id 로 삭제 시도 → 404 (존재 여부도 알려주지 않는다)
  assert.equal(
    (await call(`/api/memories/${listB[0]?.id}`, "owner-a", undefined, "DELETE")).status,
    404,
  );
  assert.equal(
    (await call(`/api/memories/${listA[0]?.id}`, "owner-a", undefined, "DELETE")).status,
    200,
  );
  assert.equal(
    ((await (await call("/api/memories", "owner-a")).json()) as unknown[]).length,
    SEED.length - 1,
  );
});

test("옛 records 기억은 한 번만 옮겨지고 프롬프트용 조회는 소유자 것만 낸다", {
  timeout: 600_000,
}, async () => {
  await db.put("legacy-a", "memories", {
    id: "legacy-1",
    text: "생일 선물로는 만년필을 좋아한다",
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  await db.put("legacy-b", "memories", { id: "legacy-2", text: "주말에는 등산을 간다" });
  await db.put("legacy-b", "memories", { id: "broken", note: "text 없음" });
  assert.deepEqual(await memories.migrateLegacy(), { found: 3, migrated: 2, skipped: 1 });
  assert.deepEqual(await memories.migrateLegacy(), { found: 3, migrated: 0, skipped: 1 });
  const moved = await memories.list("legacy-a");
  assert.equal(moved.length, 1, "두 번 돌려도 한 건");
  assert.equal(moved[0]?.id, "legacy-1");
  assert.equal(moved[0]?.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(moved[0]?.source, "chat");
  assert.ok(await db.get("legacy-a", "memories", "legacy-1"), "원본은 지우지 않는다");
  // 같은 id 로 다시 쓰면(채팅 재시도) 늘지 않는다
  await memories.add("legacy-a", "생일 선물로는 만년필을 좋아한다", "chat", { id: "legacy-1" });
  assert.equal((await memories.list("legacy-a")).length, 1);
  const recalled = await memories.forPrompt("legacy-a", "선물 뭐가 좋을까");
  assert.equal(recalled.error, undefined);
  assert.deepEqual(recalled.memories, [
    { text: "생일 선물로는 만년필을 좋아한다", source: "chat" },
  ]);
  assert.deepEqual((await memories.forPrompt("nobody", "선물")).memories, []);
});
