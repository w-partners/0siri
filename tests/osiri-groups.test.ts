// 단체 톡: 방장이 번호로 초대(회원은 바로, 비회원은 가입 뒤 방 목록을 열면 들어옴) · 닉네임 · 멤버만 읽기/쓰기 · 봇 리스너 · 나가기.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { type GroupMessage, Groups } from "../apps/server/src/osiri/groups.ts";

let db: Store, directory: string, accounts: Accounts, groups: Groups;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-groups-"));
  db = await createStore({ dataDir: join(directory, "db") });
  accounts = new Accounts(db);
  groups = new Groups(db, accounts);
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("단체 톡 초대·대화·나가기", async () => {
  const owner = await accounts.createUser({ phone: "01012345678", password: "pass1234" });
  const friend = await accounts.createUser({ phone: "01012345679", password: "pass1234" });
  const heard: GroupMessage[] = [];
  groups.onMessage(async (_g, m) => {
    heard.push(m);
  });
  const group = await groups.create(owner.id, "골프 모임");

  // 회원 번호 → 바로 들어온다, 닉네임은 방장이 정한 것
  const joined = await groups.invite(owner.id, group.id, {
    phone: "010-1234-5679",
    nickname: "김프로",
  });
  assert.equal(joined.joined, true);
  assert.equal(joined.phoneHint, "010-****-5679");
  assert.deepEqual(
    (await groups.mine(friend.id)).map((g) => g.title),
    ["골프 모임"],
  );
  // 멤버 아닌 사람·방장 아닌 사람
  const stranger = await accounts.createUser({ phone: "01012345670", password: "pass1234" });
  await assert.rejects(groups.messages(stranger.id, group.id), /찾을 수 없습니다/);
  await assert.rejects(groups.say(stranger.id, group.id, "hi"), /찾을 수 없습니다/);
  await assert.rejects(
    groups.invite(friend.id, group.id, { phone: "01012345670", nickname: "x" }),
    /방장만/,
  );

  // 비회원 번호 → 대기 + 가입 초대 토큰. 가입하고 방 목록을 열면 들어온다
  const pending = await groups.invite(owner.id, group.id, {
    phone: "01012345671",
    nickname: "이총무",
  });
  assert.equal(pending.joined, false);
  assert.ok(pending.inviteToken);
  const newbie = await accounts.acceptInvite({
    token: pending.inviteToken as string,
    phone: "01012345671",
    password: "pass1234",
    agreeTerms: "v1",
  });
  assert.deepEqual(
    (await groups.mine(newbie.user.id)).map((g) => g.title),
    ["골프 모임"],
  );
  assert.equal(
    (await groups.get(group.id)).members.find((m) => m.userId === newbie.user.id)?.nickname,
    "이총무",
  );

  // 대화: 순번대로, 닉네임으로, 봇 리스너가 사람 말을 받는다
  await groups.say(friend.id, group.id, "토요일 7시?");
  await groups.rename(owner.id, group.id, "회장");
  await groups.say(owner.id, group.id, "좋아요");
  const lines = await groups.messages(newbie.user.id, group.id);
  assert.deepEqual(
    lines.filter((m) => m.authorId !== "system").map((m) => `${m.nickname}: ${m.text}`),
    ["김프로: 토요일 7시?", "회장: 좋아요"],
  );
  assert.deepEqual(
    lines.map((m) => m.seq),
    [...lines.map((m) => m.seq)].sort((a, b) => a - b),
  );
  const last = lines.at(-1)?.seq ?? 0;
  assert.equal((await groups.messages(friend.id, group.id, last)).length, 0, "after 이후만");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    heard.map((m) => m.text),
    ["토요일 7시?", "좋아요"],
  );

  // 나가기: 스스로 나가면 목록에서 빠지고 못 읽는다. 방장은 못 나간다
  await groups.remove(friend.id, group.id, friend.id);
  assert.equal((await groups.mine(friend.id)).length, 0);
  await assert.rejects(groups.messages(friend.id, group.id), /찾을 수 없습니다/);
  await assert.rejects(groups.remove(owner.id, group.id, owner.id), /방장은/);
});
