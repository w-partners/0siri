// 단체 톡 봇: 방장이 구독 팀 도구로 봇을 만들고, /명령어·특정 단어·크론에 도구를 불러 방에 답한다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { Bots, cronMatches, type GroupBot, triggerText } from "../apps/server/src/osiri/bots.ts";
import { Groups } from "../apps/server/src/osiri/groups.ts";
import type { ToolResult } from "../apps/server/src/osiri/mcp.ts";

let db: Store, directory: string, accounts: Accounts, groups: Groups;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-bots-"));
  db = await createStore({ dataDir: join(directory, "db") });
  accounts = new Accounts(db);
  groups = new Groups(db, accounts);
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const kst = (iso: string) => new Date(`${iso}+09:00`);

test("크론은 서울 시각 다섯 칸 — 범위·간격·목록·일요일 7, 틀린 식은 거절", () => {
  assert.equal(cronMatches("0 9 * * 1", kst("2026-10-12T09:00:00")), true, "월 09:00");
  assert.equal(cronMatches("0 9 * * 1", kst("2026-10-12T09:01:00")), false);
  assert.equal(cronMatches("0 9 * * 1", kst("2026-10-13T09:00:00")), false, "화요일");
  assert.equal(cronMatches("*/15 8-10 * * *", kst("2026-10-13T10:45:00")), true);
  assert.equal(cronMatches("*/15 8-10 * * *", kst("2026-10-13T11:00:00")), false);
  assert.equal(cronMatches("30 7 1,15 * *", kst("2026-10-15T07:30:00")), true);
  assert.equal(cronMatches("0 0 * * 7", kst("2026-10-11T00:00:00")), true, "일요일=7");
  assert.throws(() => cronMatches("0 9 * *", new Date()), /다섯 칸/);
  assert.throws(() => cronMatches("61 * * * *", new Date()), /읽지 못했습니다/);
});

test("트리거: /명령어는 뒤 글을, 특정 단어는 말 전체를 넘긴다", () => {
  const command = { kind: "command" as const, value: "티타임" };
  assert.equal(triggerText(command, "/티타임 내일 오전"), "내일 오전");
  assert.equal(triggerText(command, "/티타임"), "");
  assert.equal(triggerText(command, "/티타임스"), null);
  assert.equal(triggerText(command, "티타임 알려줘"), null);
  assert.equal(triggerText({ kind: "keyword", value: "날씨" }, "내일 날씨 어때"), "내일 날씨 어때");
  assert.equal(triggerText({ kind: "keyword", value: "날씨" }, "골프 치자"), null);
  assert.equal(triggerText({ kind: "cron", value: "* * * * *" }, "아무 말"), null);
});

test("방장만 구독 팀 도구로 봇을 만들고, 명령어·단어·크론에 도구 결과를 방에 남긴다", async () => {
  const owner = await accounts.createUser({ phone: "01012345680", password: "pass1234" });
  const friend = await accounts.createUser({ phone: "01012345681", password: "pass1234" });
  const calls: { bot: string; args: Record<string, unknown> }[] = [];
  let next: ToolResult = {
    status: "done",
    result: { content: [{ type: "text", text: "7:10 · 8:20" }] },
  };
  const bots = new Bots(db, groups, {
    teamTools: async (who) =>
      who === owner.id
        ? [
            {
              roomId: "room-w",
              packageId: "pkg-w",
              team: "W 골프팀",
              tools: ["w:teetimes", "w:book"],
            },
          ]
        : [],
    runTool: async (bot, args) => {
      calls.push({ bot: bot.name, args });
      return next;
    },
  });
  const group = await groups.create(owner.id, "골프 모임");
  await groups.invite(owner.id, group.id, { phone: "01012345681", nickname: "김프로" });
  const input = {
    roomId: "room-w",
    name: "티봇",
    tool: "w:teetimes",
    args: { date: "{text}", size: 4 },
    trigger: { kind: "command" as const, value: "/티타임" },
  };

  await assert.rejects(bots.create(friend.id, group.id, input), /방장만/);
  await assert.rejects(bots.create(owner.id, group.id, { ...input, tool: "x:other" }), /없는 도구/);
  await assert.rejects(
    bots.create(owner.id, group.id, { ...input, roomId: "room-x" }),
    /구독 중인 팀이 아닙니다/,
  );
  await assert.rejects(
    bots.create(owner.id, group.id, { ...input, trigger: { kind: "cron", value: "매일" } }),
    /다섯 칸/,
  );
  const bot = await bots.create(owner.id, group.id, input);
  assert.equal(bot.trigger.value, "티타임", "앞 / 는 떼고 저장");
  assert.equal(bot.teamName, "W 골프팀", "봇은 팀에 속한다");
  assert.deepEqual(
    (await bots.list(friend.id, group.id)).map((b) => b.name),
    ["티봇"],
    "멤버는 본다",
  );

  const settle = () => new Promise((r) => setTimeout(r, 30));
  const botLines = async () =>
    (await groups.messages(owner.id, group.id))
      .filter((m) => m.authorId.startsWith("bot:"))
      .map((m) => `${m.nickname}: ${m.text}`);

  // 멤버 누구의 말이든 명령어면 방장 이름으로 도구를 부른다. {text} 자리에 명령어 뒤 글
  await groups.say(friend.id, group.id, "/티타임 2026-10-12");
  await groups.say(friend.id, group.id, "그냥 수다");
  await settle();
  assert.deepEqual(calls, [{ bot: "티봇", args: { date: "2026-10-12", size: 4 } }]);
  assert.deepEqual(await botLines(), ["티봇: 7:10 · 8:20"]);

  // 결재가 필요하거나 실패하면 그 사실이 방에 보인다(조용히 삼키지 않음)
  next = { status: "pending_approval", approvalId: "a", inputHash: "h" };
  await groups.say(owner.id, group.id, "/티타임");
  await settle();
  next = { status: "failed", result: null, error: "W 점검 중" };
  await groups.say(owner.id, group.id, "/티타임");
  await settle();
  assert.deepEqual((await botLines()).slice(1), [
    "티봇: 승인이 필요한 도구라 방장 결재함에 올렸습니다",
    "티봇: 실패: W 점검 중",
  ]);

  // 크론 봇: 맞는 분에 한 번만(같은 분 두 번 tick 해도 한 번)
  next = { status: "done", result: { content: [{ type: "text", text: "오늘 예약 2건" }] } };
  await bots.create(owner.id, group.id, {
    ...input,
    name: "아침봇",
    args: {},
    trigger: { kind: "cron", value: "0 9 * * *" },
  });
  await bots.tick(kst("2026-10-12T08:59:00"));
  await bots.tick(kst("2026-10-12T09:00:10"));
  await bots.tick(kst("2026-10-12T09:00:40"));
  assert.deepEqual((await botLines()).slice(3), ["아침봇: 오늘 예약 2건"]);

  // 빼면 더 반응하지 않는다. 방장 아닌 사람은 못 뺀다
  await assert.rejects(bots.remove(friend.id, group.id, bot.id), /방장만/);
  await bots.remove(owner.id, group.id, bot.id);
  calls.length = 0;
  await groups.say(friend.id, group.id, "/티타임");
  await settle();
  assert.equal(calls.length, 0);
  // 운영자 방에는 봇을 못 넣는다
  const opRoom = await groups.operatorChat(
    owner.id,
    { id: "pkg-w", name: "W" },
    { ids: [], fallback: true },
  );
  await assert.rejects(bots.create(owner.id, opRoom.id, input), /운영자와의 대화/);
  assert.ok(!(await bots.list(owner.id, group.id)).some((b: GroupBot) => b.id === bot.id));
});
