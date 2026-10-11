// 대화 기록 검색: 다른 방(세션)에서 오간 말을 EmbeddingGemma 2 로 찾고, 최근 방을 본다. 소유자 격리·중복 색인 없음.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { History, historyRoutes, linesOf } from "../apps/server/src/osiri/history.ts";

let db: Store, directory: string, history: History;
const msg = (id: string, role: string, content: unknown) => ({ id, role, content });
const golf = [
  msg("g1", "user", "다음 주 토요일 오전에 남서울CC 티타임 4명 잡아 줘"),
  msg(
    "g2",
    "assistant",
    "남서울CC 토요일 07:40 티타임 4명 예약 홀딩했습니다. 입금 기한은 목요일입니다.",
  ),
  msg("g3", "tool", "{}"),
];
const tax = [
  msg("t1", "user", [{ type: "text", text: "양도소득세 장기보유특별공제 계산 다시 해 줘" }]),
  msg("t2", "assistant", "보유 7년이면 공제율 14% 로 계산했습니다."),
];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-history-"));
  db = await createStore({ dataDir: join(directory, "db") });
  history = new History(db, () => undefined);
  await db.put("me", "rooms", { id: "room-golf", title: "골프 예약" });
  await db.put("me", "conversations", { id: "room-golf", messages: golf });
  await db.put("me", "rooms", { id: "room-tax", title: "세금" });
  await db.put("me", "rooms", { id: "room-echo", title: "시험" });
  await db.put("me", "conversations", { id: "room-tax", messages: tax });
  // 지운 방에 남은 대화 — 검색·최근 목록에 나오면 안 된다
  await db.put("me", "conversations", {
    id: "room-gone",
    messages: [msg("x1", "user", "남서울CC 티타임 지운 방 메모")],
  });
  await db.put("other", "rooms", { id: "room-x", title: "남의 방" });
  await db.put("other", "conversations", {
    id: "room-x",
    messages: [msg("o1", "user", "남서울CC 티타임 비밀 메모")],
  });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("linesOf: 사람이 읽는 글만(도구·빈 글 제외), 배열 content 는 text 조각만", () => {
  assert.deepEqual(
    linesOf([...golf, ...tax, msg("x", "user", "  ")]).map((l) => l.id),
    ["g1", "g2", "t1", "t2"],
  );
  assert.equal(linesOf(tax)[0]?.text, "양도소득세 장기보유특별공제 계산 다시 해 줘");
});

test("이전 대화 일괄 색인 → 다른 방에서 뜻으로 찾는다, 지금 방·남의 기록은 나오지 않는다", async () => {
  assert.equal(await history.backfill(), 6);
  assert.equal(await history.backfill(), 0, "이미 색인한 줄은 다시 임베딩하지 않는다");
  const hits = await history.search("me", "골프장 예약 언제였지", 3, "room-tax");
  assert.equal(hits[0]?.threadId, "room-golf");
  assert.equal(hits[0]?.title, "골프 예약", "방 제목이 붙는다");
  assert.ok(
    hits.every((h) => h.threadId !== "room-tax"),
    "지금 방은 뺀다",
  );
  assert.ok(
    hits.every((h) => h.threadId !== "room-x"),
    "다른 사람 기록은 섞이지 않는다",
  );
  assert.ok(
    hits.every((h) => h.threadId !== "room-gone"),
    "지운 방에 남은 대화는 나오지 않는다",
  );
  const tax2 = await history.search("me", "세금 공제율", 1, "room-golf");
  assert.equal(tax2[0]?.threadId, "room-tax");
  assert.equal(tax2[0]?.title, "세금");
});

test("같은 방에서 같은 말을 반복한 줄은 검색 결과에 한 번만", async () => {
  const echo = [1, 2, 3].map((n) => msg(`e${n}`, "user", "너는 누구야? 한 문장으로."));
  await history.index("me", "room-echo", echo);
  const hits = await history.search("me", "너는 누구야", 5, "room-golf");
  assert.equal(hits.filter((h) => h.threadId === "room-echo").length, 1);
});

test("저장할 때 새 줄만 색인, 최근 방 목록은 마지막 요청·답", async () => {
  const more = [...tax, msg("t3", "user", "그럼 종합소득세 신고는 5월이지?")];
  assert.equal(await history.index("me", "room-tax", more), 1);
  await db.put("me", "conversations", { id: "room-tax", messages: more });
  const recent = await history.recent("me", 5, "room-golf");
  assert.deepEqual(
    recent.map((r) => r.threadId),
    ["room-tax"],
  );
  assert.equal(recent[0]?.lastAsk, "그럼 종합소득세 신고는 5월이지?");
  assert.equal(recent[0]?.lastAnswer, "보유 7년이면 공제율 14% 로 계산했습니다.");
});

test("API: /history/search · /history/recent 는 요청한 사람 것만", async () => {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", "other");
    await next();
  });
  app.route("/api", historyRoutes(history));
  const hits = (await (await app.request("/api/history/search?q=티타임")).json()) as {
    threadId: string;
  }[];
  assert.deepEqual([...new Set(hits.map((h) => h.threadId))], ["room-x"]);
  const recent = (await (await app.request("/api/history/recent")).json()) as {
    threadId: string;
  }[];
  assert.deepEqual(
    recent.map((r) => r.threadId),
    ["room-x"],
  );
});
