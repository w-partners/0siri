// 피드(관심 프롬프트 글 + 관리자 글 · 좋아요) 와 주제방(새 대화방 · 토론) — 마스터 2026-10-10.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Feed } from "../apps/server/src/osiri/feed.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { isHomeRoom, SIDE_CHAT_TITLE } from "../packages/domain/src/osiri.ts";

const directory = await mkdtemp(join(tmpdir(), "osiri-feed-"));
after(() => rm(directory, { recursive: true, force: true }));
const db = await createStore({ dataDir: join(directory, "db") });

let fail = false;
const search = {
  search: async () => {
    if (fail) throw new Error("search down");
    return {
      provider: "parallel" as const,
      results: ["a", "b"].map((k) => ({
        url: `https://example.com/${k}`,
        title: `글 ${k}`,
        excerpts: [`요약 ${k}`],
        publish_date: null,
      })),
      warnings: [],
      truncated: false,
    };
  },
};

test("관심 프롬프트: 만들자마자 글이 오고, 다시 돌려도 같은 글은 또 싣지 않고, 실패는 lastError 로 남는다", async () => {
  const feed = new Feed(db, search as never);
  const prompt = await feed.addPrompt("u1", "상속 판례 소식", 12);
  assert.equal(prompt.lastResult, "새 글 2건");
  assert.equal((await feed.runNow("u1", prompt.id)).lastResult, "새 글 0건");
  fail = true;
  const failed = await feed.runNow("u1", prompt.id);
  fail = false;
  assert.match(failed.lastError ?? "", /search down/);
  const items = await feed.list("u1");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.prompt, "상속 판례 소식");
});

test("관리자 글은 모두에게 보이고, 좋아요는 사람마다 따로다", async () => {
  const feed = new Feed(db, search as never);
  const post = await feed.broadcast({ title: "공지", body: "새 팀이 들어왔어요" });
  await feed.like("u2", post.id, true);
  assert.equal((await feed.list("u2")).find((p) => p.id === post.id)?.liked, true);
  assert.equal((await feed.list("u3")).find((p) => p.id === post.id)?.liked, false);
});

test("주제방은 홈 방으로 잡히지 않고, 주제방만 지울 수 있다", async () => {
  const rooms = new Rooms(db, new EventBus());
  const topic = await rooms.createTopic("u4", "토론 · 공지", "새 팀이 들어왔어요");
  const home = await rooms.ensurePersonalRoom("u4");
  assert.notEqual(home.id, topic.id);
  assert.equal(isHomeRoom(home), true);
  assert.equal(isHomeRoom(topic), false);
  await assert.rejects(rooms.removeTopic("u4", home.id), /직접 만든/);
  await rooms.removeTopic("u4", topic.id);
  await assert.rejects(rooms.get("u4", topic.id), /찾을 수 없/);
});

test("새 사이드 대화는 첫 메시지로 이름이 붙고, 고친 이름·다른 방은 그대로다", async () => {
  const rooms = new Rooms(db, new EventBus());
  const side = await rooms.createTopic("u5", SIDE_CHAT_TITLE);
  const say = (content: unknown) => [
    { id: "a", role: "assistant", content: "안녕" },
    { id: "m", role: "user", content },
  ];
  await rooms.nameSideChat(
    "u5",
    side.id,
    say("  다음 주   제주 여행\n일정 같이 짜 줘. 렌터카랑 숙소까지 전부"),
  );
  const named = (await rooms.get("u5", side.id)).title;
  assert.equal(named, "다음 주 제주 여행 일정 같이 짜 줘. 렌터");
  await rooms.nameSideChat("u5", side.id, say("다른 말"));
  assert.equal((await rooms.get("u5", side.id)).title, named);
  const fixed = await rooms.createTopic("u5", "이사 준비");
  await rooms.nameSideChat("u5", fixed.id, say("바꾸면 안 됨"));
  assert.equal((await rooms.get("u5", fixed.id)).title, "이사 준비");
  const parts = await rooms.createTopic("u5", SIDE_CHAT_TITLE);
  await rooms.nameSideChat("u5", parts.id, say([{ type: "text", text: "사진 정리" }]));
  assert.equal((await rooms.get("u5", parts.id)).title, "사진 정리");
  await rooms.nameSideChat("u5", "default", say("없는 방")); // 방이 아닌 대화는 조용히 지나간다
});
