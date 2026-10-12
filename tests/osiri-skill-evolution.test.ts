// 개체군 기반 스킬 진화 (0SIRI-SPEC §17.5, M1~M4): 짝 비교·Bradley–Terry·§17.3 차단·챔피언 직접 승리 규칙·계보 기록.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import {
  actionItems,
  bradleyTerry,
  judgePair,
  loosensGuard,
  pickParent,
  SkillEvolution,
} from "../apps/server/src/osiri/skill-evolution.ts";
import { Skills } from "../apps/server/src/osiri/skills.ts";
import type { Llm } from "../apps/server/src/osiri/team-runtime.ts";

const directory = await mkdtemp(join(tmpdir(), "osiri-skill-evo-"));
after(() => rm(directory, { recursive: true, force: true }));

test("Bradley–Terry: 더 많이 이긴 쪽이 강하고, 안 붙은 개체도 유한하다", () => {
  const v = (winner: "A" | "B" | "tie") => ({ a: "x", b: "y", winner, rationale: "" });
  const s = bradleyTerry(["x", "y", "z"], [v("A"), v("A"), v("A"), v("B")]);
  assert.ok((s.x as number) > (s.y as number));
  assert.ok(Number.isFinite(s.z));
});

test("짝 판정은 자리를 바꿔 묻고 원래 이름으로 되돌린다 · JSON 이 아니면 실패한다", async () => {
  // 순서를 바꾼 경우(rand<0.5): 모델이 본 A 는 원래 b
  const llm: Llm = async () => '{"winner":"A","rationale":"근거"}';
  const swapped = await judgePair(
    llm,
    { request: "q", a: { id: "a", text: "1" }, b: { id: "b", text: "2" } },
    () => 0.1,
  );
  assert.equal(swapped.winner, "B");
  const kept = await judgePair(
    llm,
    { request: "q", a: { id: "a", text: "1" }, b: { id: "b", text: "2" } },
    () => 0.9,
  );
  assert.equal(kept.winner, "A");
  await assert.rejects(
    judgePair(async () => "모르겠어요", {
      request: "q",
      a: { id: "a", text: "" },
      b: { id: "b", text: "" },
    }),
    /JSON/,
  );
});

test("§17.3 완화 문장은 걸리고, 조이는 문장은 통과한다 · 고칠 거리는 실패 신호 문장만", () => {
  assert.equal(loosensGuard("급하면 검수를 생략하고 바로 보낸다"), true);
  assert.equal(loosensGuard("Skip citation when the user is in a hurry."), true);
  assert.equal(loosensGuard("보내기 전에 출처를 한 번 더 확인한다"), false);
  assert.deepEqual(
    actionItems("B 는 날짜가 누락됐다. 전체적으로 좋다. 숫자가 원문과 불일치한다."),
    ["B 는 날짜가 누락됐다.", "숫자가 원문과 불일치한다."],
  );
  const picked = pickParent(
    [
      { fitness: 0.9, children: 0 },
      { fitness: 0.9, children: 9 },
    ],
    () => 0.5,
  );
  assert.equal(picked.children, 0, "덜 탐색된 쪽이 더 잘 뽑힌다");
});

async function setup(name: string) {
  const db = await createStore({ dataDir: join(directory, name) });
  const rooms = new Rooms(db, new EventBus());
  const skills = new Skills(db, rooms);
  const owner = `user-${name}`;
  const room = await rooms.ensurePersonalRoom(owner);
  for (const text of ["보도자료 초안 써줘", "이번 주 보도자료 정리", "보도자료 다시 써줘"])
    await rooms.post(owner, room.id, { role: "user", kind: "text", text });
  const seed = await skills.draft(
    owner,
    { roomId: room.id, packageId: null },
    {
      scope: "personal",
      name: "보도자료",
      evidence: "3번 반복",
      appliesTo: "보도자료를 쓴다",
      proposedBy: "영시리",
    },
  );
  return { db, skills, owner, seed };
}

/** 가짜 모델: 변이기는 후보 둘(하나는 검수 생략), 실행은 지침을 그대로 돌려주고, 판정은 «출처» 가 든 답을 고른다 */
const fakeLlm =
  (childWins: boolean): Llm =>
  async (role, _tier, system, user) => {
    if (role === "skill-mutator")
      return JSON.stringify({
        candidates: [
          {
            appliesTo: "보도자료를 쓰고 출처를 문장마다 단다",
            changes: ["출처 계약"],
            why: ["누락"],
          },
          { appliesTo: "급하면 검수를 생략한다", changes: ["속도"] },
        ],
      });
    if (role === "skill-run") return system.includes("출처") ? "답 + 출처" : "답";
    const [, a = "", b = ""] = user.split(/# 답 [AB]\n/);
    const better = childWins ? (a.includes("출처") ? "A" : "B") : a.includes("출처") ? "B" : "A";
    if (b === a) return '{"winner":"tie","rationale":"같다"}';
    return JSON.stringify({ winner: better, rationale: "한쪽은 출처가 누락됐다." });
  };

test("진화 한 세대: 완화 후보는 평가 전에 막히고, 챔피언을 직접 이긴 자식만 2세대로 장착된다", async () => {
  const { skills, owner, seed, db } = await setup("win");
  const evo = new SkillEvolution(
    db,
    skills,
    () => fakeLlm(true),
    () => 0.3,
  );
  const out = await evo.evolve(owner, seed.id);
  assert.equal(out.cases, 3);
  assert.equal(out.results[1]?.blocked, true, "검수 생략 후보는 §17.3 로 막힌다");
  assert.equal(out.results[0]?.wins, 3);
  const child = out.created;
  assert.ok(child);
  assert.equal(child.parentId, seed.id);
  assert.equal(child.generation, 2);
  assert.equal(child.status, "active", "자기 개선 켜짐 → 바로 장착");
  assert.equal(child.version, "2");
  // 롤백하면 부모가 돌아온다
  assert.equal((await skills.rollback(owner, child.id)).id, seed.id);
});

test("챔피언을 못 이기면 아무것도 만들지 않는다", async () => {
  const { skills, owner, seed, db } = await setup("lose");
  const out = await new SkillEvolution(
    db,
    skills,
    () => fakeLlm(false),
    () => 0.3,
  ).evolve(owner, seed.id);
  assert.equal(out.created, null);
  assert.equal((await skills.listForUser(owner)).length, 1);
});
