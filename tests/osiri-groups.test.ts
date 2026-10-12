// 단체 톡: 방장이 번호로 초대(회원은 바로, 비회원은 가입 뒤 방 목록을 열면 들어옴) · 닉네임 · 멤버만 읽기/쓰기 · 봇 리스너 · 나가기.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { type GroupMessage, Groups } from "../apps/server/src/osiri/groups.ts";
import { GROUP_DEFAULT_TITLE } from "../packages/domain/src/osiri.ts";

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

test("운영자와 대화: 구독자·팀마다 방 하나, 운영자 자동 참여, 초대 금지, 지정 운영자 없으면 관리자가 받는다고 적는다", async () => {
  const subscriber = await accounts.createUser({ phone: "01012345672", password: "pass1234" });
  const op = await accounts.createUser({
    phone: "01012345673",
    password: "pass1234",
    role: "operator",
  });
  const pkg = { id: "pkg-1", name: "법률 마케팅팀" };
  const first = await groups.operatorChat(subscriber.id, pkg, { ids: [op.id], fallback: false });
  const again = await groups.operatorChat(subscriber.id, pkg, { ids: [op.id], fallback: false });
  assert.equal(first.id, again.id);
  assert.equal(first.title, "법률 마케팅팀 · 운영자");
  assert.deepEqual((await groups.get(first.id)).members.map((m) => m.nickname).slice(1), [
    "운영자",
  ]);
  assert.ok(
    (await groups.mine(op.id)).some((g) => g.id === first.id),
    "운영자 목록에 보인다",
  );
  await groups.say(op.id, first.id, "무엇을 도와드릴까요?");
  await assert.rejects(
    groups.invite(subscriber.id, first.id, { phone: "01012345674", nickname: "x" }),
    /초대할 수 없습니다/,
  );
  const fallback = await groups.operatorChat(
    subscriber.id,
    { id: "pkg-2", name: "W" },
    { ids: [op.id], fallback: true },
  );
  assert.ok(
    (await groups.messages(subscriber.id, fallback.id)).some((m) =>
      /관리자가 받습니다/.test(m.text),
    ),
  );
});

test("이름 없이 만든 단체 톡은 보는 사람마다 다른 멤버 닉네임으로 보인다", async () => {
  const a = await accounts.createUser({ phone: "01022223331", password: "pass1234" });
  const b = await accounts.createUser({ phone: "01022223332", password: "pass1234" });
  const group = await groups.create(a.id, GROUP_DEFAULT_TITLE);
  assert.equal(groups.view(group, a.id).title, GROUP_DEFAULT_TITLE); // 혼자면 그 이름 그대로
  await groups.invite(a.id, group.id, { phone: "01022223332", nickname: "민지" });
  assert.equal((await groups.mine(a.id)).find((g) => g.id === group.id)?.title, "민지");
  const seenByB = (await groups.mine(b.id)).find((g) => g.id === group.id);
  assert.notEqual(seenByB?.title, "민지");
  assert.notEqual(seenByB?.title, GROUP_DEFAULT_TITLE);
});
