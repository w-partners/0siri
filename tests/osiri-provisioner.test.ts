// 0SIRI-SPEC §22-8: 구독 → 큐 → 서버 안 팀 루프(팀마다 컨테이너 없음) → workers 기록; 실패는 failed+활동;
// 해지 → 루프 멈춤(옛 컨테이너 기록이면 rm -f); 서버가 다시 뜨면 기록된 루프를 다시 띄운다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DockerRunner } from "../apps/server/src/computer.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Provisioner, type TeamLoop, type Worker } from "../apps/server/src/osiri/provisioner.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Catalog, type Provisioning } from "../apps/server/src/osiri/store.ts";
import { grantOnSubscribe } from "./grant-on-subscribe.ts";

let db: Store, directory: string, rooms: Rooms, catalog: Catalog;
const dockerCalls: string[][] = [];
const docker: DockerRunner = async (args) => {
  dockerCalls.push(args);
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    interrupted: false,
    truncated: false,
  };
};
/** 가짜 팀 루프 — 몇 번 돌았는지, 닫혔는지만 센다 */
function fakeLoops(fail = false) {
  const started: string[] = [];
  const ticks: string[] = [];
  const closed: string[] = [];
  const runtime = async (owner: string, roomId: string): Promise<TeamLoop> => {
    if (fail)
      throw new Error("OPENAI_BASE_URL / OPENAI_API_KEY 가 없어 팀 런타임을 시작할 수 없습니다");
    started.push(`${owner}:${roomId}`);
    return {
      tick: async () => (ticks.push(roomId), "idle"),
      weeklyReport: async () => undefined,
      close: async () => void closed.push(roomId),
    };
  };
  return { runtime, started, ticks, closed };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-prov-"));
  db = await createStore({ dataDir: join(directory, "db") });
  rooms = new Rooms(db, new EventBus());
  catalog = new Catalog(db, rooms);
  grantOnSubscribe(catalog);
  await catalog.upsertPackage({
    slug: "legal-marketing",
    name: "법률 마케팅팀",
    character: "counsel",
    category: "legal",
    summary: "",
    roles: [
      { name: "root", title: "팀장", summary: "" },
      { name: "drafter", title: "초안", summary: "" },
      { name: "monitor", title: "감지", summary: "감지" },
      { name: "geo", title: "GEO", summary: "GEO" },
      { name: "reviewer", title: "검수", summary: "" },
      { name: "publisher", title: "발행", summary: "" },
      { name: "analyst", title: "보고", summary: "" },
    ],
    approvalPoints: ["발행"],
    reportCadence: "weekly",
    verified: true,
    metrics: { published: 0, indexed: 0, ai_citations: 0 },
    runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
  });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("구독 큐 → 서버 안 팀 루프 → workers 기록 → 서버 재시작 때 다시 띄움 → 해지 시 루프 멈춤", async () => {
  const pkg = await catalog.packageBySlug("legal-marketing");
  const { roomId } = await catalog.subscribe("u1", pkg.id);
  const loops = fakeLoops();
  const provisioner = new Provisioner(db, rooms, catalog, {
    runtime: loops.runtime,
    docker,
    tickMs: 60_000,
    log: () => undefined,
  });
  assert.deepEqual(await provisioner.drainOnce(), { started: 1, failed: 0, stopped: 0 });
  assert.deepEqual(loops.started, [`u1:${roomId}`]);
  assert.deepEqual(loops.ticks, [roomId], "띄우자마자 한 번 돈다");
  assert.equal(dockerCalls.length, 0, "팀마다 컨테이너를 만들지 않는다");
  const worker = await db.get<Worker>("system", "workers", roomId);
  assert.equal(worker?.userId, "u1");
  assert.equal(worker?.containerId, undefined);
  assert.equal((await db.scan<Provisioning>("worker-provisioning")).length, 0, "큐 비움");
  assert.ok((await rooms.activities("u1")).some((a) => a.title === "팀이 일을 시작했습니다"));

  // 재실행: 큐가 비어 아무 일도 없다
  assert.deepEqual(await provisioner.drainOnce(), { started: 0, failed: 0, stopped: 0 });

  // 서버가 다시 뜬 것처럼: 새 프로비저너가 기록된 루프를 다시 띄운다
  provisioner.stop();
  const again = fakeLoops();
  const restarted = new Provisioner(db, rooms, catalog, {
    runtime: again.runtime,
    docker,
    tickMs: 60_000,
    log: () => undefined,
  });
  await restarted.resume();
  assert.deepEqual(again.started, [`u1:${roomId}`]);

  // 해지 예약 → 기간 말까지 루프는 그대로 돈다
  const mine = await catalog.mine("u1");
  const subscriptionId = (mine[0] as { id: string }).id;
  await catalog.cancel("u1", subscriptionId);
  assert.deepEqual(await restarted.drainOnce(), { started: 0, failed: 0, stopped: 0 });
  // 기간 말이 지남 → 구독 종료 · 방 archived → 루프 멈춤 (사용자가 앱을 열지 않아도)
  await db.put("u1", "subscriptions", {
    ...(await db.get<Record<string, unknown>>("u1", "subscriptions", subscriptionId)),
    id: subscriptionId,
    endsAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.deepEqual(await restarted.drainOnce(), { started: 0, failed: 0, stopped: 1 });
  assert.equal((await rooms.get("u1", roomId)).archived, true);
  assert.deepEqual(again.closed, [roomId], "워커 토큰을 거두며 닫힌다");
  assert.equal(await db.get("system", "workers", roomId), null);
  assert.equal(dockerCalls.length, 0);
});

test("팀 루프를 못 띄우면 → 큐 failed + 에러 활동, workers 기록 없음, 다시 돌지 않는다", async () => {
  const pkg = await catalog.packageBySlug("legal-marketing");
  const { roomId } = await catalog.subscribe("u2", pkg.id);
  const loops = fakeLoops(true);
  const provisioner = new Provisioner(db, rooms, catalog, {
    runtime: loops.runtime,
    log: () => undefined,
  });
  assert.deepEqual(await provisioner.drainOnce(), { started: 0, failed: 1, stopped: 0 });
  const job = (await db.scan<Provisioning & { error?: string }>("worker-provisioning")).find(
    (j) => j.value.roomId === roomId,
  )?.value;
  assert.equal(job?.status, "failed");
  assert.match(job?.error ?? "", /OPENAI_API_KEY/);
  assert.ok((await rooms.activities("u2")).some((a) => a.kind === "error"));
  assert.equal(await db.get("system", "workers", roomId), null);
  assert.deepEqual(
    await provisioner.drainOnce(),
    { started: 0, failed: 0, stopped: 0 },
    "failed 큐는 재시도하지 않는다",
  );
});
