// 스킬 후보 찾기 (마스터 2026-10-10): 비슷한 요청이 SKILL_REPEAT_MIN 번 반복되면 영시리가 개인 스킬 초안을 낸다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Skills } from "../apps/server/src/osiri/skills.ts";
import { SKILL_REPEAT_PREFIX } from "../packages/domain/src/osiri.ts";

const directory = await mkdtemp(join(tmpdir(), "osiri-skill-scan-"));
after(() => rm(directory, { recursive: true, force: true }));

/** «보도자료» 가 든 요청끼리만 같은 방향 — 진짜 모델 없이 묶음 규칙만 본다. */
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => (t.includes("보도자료") ? [1, 0] : [0, 1]));

test("반복된 요청만 초안이 되고, 다시 찾아도 같은 초안을 또 내지 않는다", async () => {
  const db = await createStore({ dataDir: join(directory, "db") });
  const rooms = new Rooms(db, new EventBus());
  const skills = new Skills(db, rooms);
  const owner = "user-1";
  const room = await rooms.ensurePersonalRoom(owner);
  for (const text of [
    "보도자료 초안 써줘",
    "이번 주 보도자료 정리",
    "보도자료 다시 써줘",
    "점심 메뉴 추천해줘",
  ])
    await rooms.post(owner, room.id, { role: "user", kind: "text", text });

  const first = await skills.findCandidates(owner, fakeEmbed);
  assert.equal(first.scanned, 4);
  assert.equal(first.created.length, 1);
  const [draft] = first.created;
  assert.ok(draft?.name.startsWith(SKILL_REPEAT_PREFIX));
  assert.equal(draft?.status, "draft");
  assert.equal(draft?.proposedBy, "영시리");
  assert.match(draft?.evidence ?? "", /3번/);

  assert.equal((await skills.findCandidates(owner, fakeEmbed)).created.length, 0);
});

test("임베딩이 실패하면 «후보 없음» 이 아니라 실패로 보인다", async () => {
  const db = await createStore({ dataDir: join(directory, "db2") });
  const rooms = new Rooms(db, new EventBus());
  const skills = new Skills(db, rooms);
  const room = await rooms.ensurePersonalRoom("user-2");
  for (const text of ["보고서 요약해줘", "보고서 요약 부탁", "이 보고서 요약"])
    await rooms.post("user-2", room.id, { role: "user", kind: "text", text });
  await assert.rejects(
    skills.findCandidates("user-2", async () => {
      throw new Error("model down");
    }),
    /model down/,
  );
});
