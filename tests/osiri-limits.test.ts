// 등급별 사용 제한: 설정이 없으면 제한 없음 · 승인 수 · 팀별 덮어쓰기 · 막힌 행위·역할 · 집행 수 · 개인 방 제외 · 방에 한 번만 알림
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { limitsSchema, UsageLimits } from "../apps/server/src/osiri/limits.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";

let db: Store, directory: string, rooms: Rooms, approvals: Approvals;
const settings = new Map<string, unknown>();
const OWNER = "friend";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-limits-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const bus = new EventBus();
  rooms = new Rooms(db, bus);
  approvals = new Approvals(db, rooms, bus);
  approvals.limits = new UsageLimits(
    db,
    rooms,
    async (key) => settings.get(key),
    async () => "free",
    async () => "legal-marketing",
  );
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
const ask = (roomId: string, n: number, kind?: "consult") =>
  approvals.request(OWNER, {
    roomId,
    toolName: "site:publish",
    input: { n },
    title: `글 ${n}`,
    summary: "s",
    requestedBy: "publisher",
    ...(kind ? { kind } : {}),
  });
const status = (e: unknown) => (e as { status?: number }).status;

test("usage limits gate team rooms by tier, with per-team override, and tell the room once", async () => {
  const team = await rooms.create(OWNER, {
    packageId: "pkg-legal",
    title: "법률팀",
    character: "counsel",
  });
  const home = await rooms.create(OWNER, {
    packageId: null,
    title: "영시리",
    character: "yeongsil",
  });

  // 설정 없음 = 제한 없음
  await ask(team.id, 1);
  // 등급 공통: 30일 승인 1건 → 두 번째는 429, 방에 알림 한 번
  settings.set("limits:free", { approvalsPerMonth: 1 });
  await assert.rejects(ask(team.id, 2), (e) => status(e) === 429);
  await assert.rejects(ask(team.id, 3), (e) => status(e) === 429);
  const told = (await rooms.timeline(OWNER, team.id)).filter((m) =>
    m.text?.includes("승인 요청 한도"),
  );
  assert.equal(told.length, 1, "같은 막힘은 한 번만 알린다");
  // 개인 방은 팀 제한 대상이 아니다
  await ask(home.id, 4);
  // 팀별 설정이 등급 공통을 덮는다
  settings.set("limits:free:legal-marketing", { approvalsPerMonth: 5, blockedKinds: ["consult"] });
  const second = await ask(team.id, 5);
  await assert.rejects(ask(team.id, 6, "consult"), (e) => status(e) === 429);

  // 집행 수: 0 이면 승인을 받아도 내보내지 못한다
  settings.set("limits:free:legal-marketing", { publishesPerMonth: 0 });
  const approved = (await approvals.decide(OWNER, second.id, "approve", {
    decidedBy: OWNER,
  })) as { token?: string };
  await assert.rejects(
    approvals.consume(OWNER, {
      approvalId: second.id,
      token: approved.token as string,
      toolName: "site:publish",
      input: { n: 5 },
    }),
    (e) => status(e) === 429,
  );
  settings.delete("limits:free:legal-marketing");
  settings.delete("limits:free");
  assert.equal(
    (
      await approvals.consume(OWNER, {
        approvalId: second.id,
        token: approved.token as string,
        toolName: "site:publish",
        input: { n: 5 },
      })
    ).status,
    "consumed",
    "제한을 풀면 같은 토큰으로 집행된다(막힘은 토큰을 쓰지 않는다)",
  );

  // 역할
  settings.set("limits:free", { blockedRoles: ["monitor"] });
  const limits = approvals.limits as UsageLimits;
  await assert.rejects(
    limits.beforeRole(OWNER, team.id, "pkg-legal", "monitor"),
    (e) => status(e) === 429,
  );
  await limits.beforeRole(OWNER, team.id, "pkg-legal", "drafter");

  // 저장된 값이 형식에 안 맞으면 제한 없음으로 넘기지 않는다
  settings.set("limits:free", { approvalsPerMonth: "많이" });
  await assert.rejects(limits.for(OWNER, "pkg-legal"), (e) => status(e) === 500);
  assert.equal(limitsSchema.safeParse({ approvalsPerMonth: 3, extra: 1 }).success, false);
});
