// 0SIRI-SPEC §22-8: 구독 → 큐 → docker run(env-file 로 토큰 주입) → workers 기록; 실패는 failed+활동; 해지 → rm -f.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DockerRunner } from "../apps/server/src/computer.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Provisioner, type Worker } from "../apps/server/src/osiri/provisioner.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Catalog, type Provisioning } from "../apps/server/src/osiri/store.ts";

let db: Store, directory: string, rooms: Rooms, catalog: Catalog;
const calls: { args: string[]; envFile?: string }[] = [];
let exitCode = 0;
const docker: DockerRunner = async (args) => {
  const envIndex = args.indexOf("--env-file");
  const envFile = envIndex >= 0 ? await readFile(args[envIndex + 1] as string, "utf8") : undefined;
  calls.push({ args, envFile });
  return {
    stdout: "abc123containerid\n",
    stderr: exitCode ? "docker: image not found" : "",
    exitCode,
    timedOut: false,
    interrupted: false,
    truncated: false,
  };
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-prov-"));
  db = await createStore({ dataDir: join(directory, "db") });
  rooms = new Rooms(db, new EventBus());
  catalog = new Catalog(db, rooms);
  await catalog.upsertPackage({
    slug: "legal-marketing",
    name: "법률 마케팅팀",
    character: "counsel",
    category: "legal",
    summary: "",
    roles: [
      { name: "root", title: "팀장", summary: "" },
      { name: "drafter", title: "초안", summary: "" },
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

test("구독 큐 → docker run (host 네트워크·env-file 토큰) → workers 기록 → 해지 시 rm -f", async () => {
  const pkg = await catalog.packageBySlug("legal-marketing");
  const { roomId } = await catalog.subscribe("u1", pkg.id);
  const provisioner = new Provisioner(db, rooms, catalog, {
    docker,
    apiUrl: "http://127.0.0.1:8787",
    registryUrl: "registry.test:5000/",
    modelEnv: { OPENAI_BASE_URL: "http://gw", OPENAI_API_KEY: "sk-secret" },
    log: () => undefined,
  });
  assert.deepEqual(await provisioner.drainOnce(), { started: 1, failed: 0, stopped: 0 });
  const run = calls[0] as { args: string[]; envFile: string };
  assert.equal(run.args[0], "run");
  assert.equal(run.args.at(-1), "registry.test:5000/osiri/team-runtime");
  assert.ok(run.args.includes("--env-file"), "시크릿은 env-file 로");
  assert.ok(!run.args.some((a) => a.includes("sk-secret")), "인자에 키가 없다");
  assert.match(run.envFile, /OSIRI_WORKER_TOKEN=[A-Za-z0-9_-]{20,}/);
  assert.match(run.envFile, /OPENAI_API_KEY=sk-secret/);
  assert.match(run.envFile, /TEAM_YAML=teams\/legal-marketing\.yaml/);
  assert.match(run.envFile, new RegExp(`OSIRI_ROOM_ID=${roomId}`));
  const envPath = run.args[run.args.indexOf("--env-file") + 1] as string;
  await assert.rejects(readFile(envPath), "env-file 은 실행 후 지운다");
  const worker = await db.get<Worker>("system", "workers", roomId);
  assert.equal(worker?.containerId, "abc123containerid");
  assert.equal((await db.scan<Provisioning>("worker-provisioning")).length, 0, "큐 비움");
  assert.equal((await db.list("system", "worker-tokens")).length, 1, "워커 토큰 1개 발급");
  assert.ok((await rooms.activities("u1")).some((a) => a.title === "팀이 일을 시작했습니다"));

  // 재실행: 큐가 비어 아무 일도 없다
  assert.deepEqual(await provisioner.drainOnce(), { started: 0, failed: 0, stopped: 0 });
  assert.equal(calls.length, 1);

  // 해지 예약 → 기간 말까지 워커는 그대로 돈다
  const mine = await catalog.mine("u1");
  const subscriptionId = (mine[0] as { id: string }).id;
  await catalog.cancel("u1", subscriptionId);
  assert.deepEqual(await provisioner.drainOnce(), { started: 0, failed: 0, stopped: 0 });
  // 기간 말이 지남 → 구독 종료 · 방 archived → rm -f (사용자가 앱을 열지 않아도)
  await db.put("u1", "subscriptions", {
    ...(await db.get<Record<string, unknown>>("u1", "subscriptions", subscriptionId)),
    id: subscriptionId,
    endsAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.deepEqual(await provisioner.drainOnce(), { started: 0, failed: 0, stopped: 1 });
  assert.equal((await rooms.get("u1", roomId)).archived, true);
  assert.deepEqual(calls[1]?.args, ["rm", "-f", "abc123containerid"]);
  assert.equal(await db.get("system", "workers", roomId), null);
});

test("docker run 실패 → 큐 failed + 에러 활동, 다시 돌지 않는다", async () => {
  const pkg = await catalog.packageBySlug("legal-marketing");
  const { roomId } = await catalog.subscribe("u2", pkg.id);
  exitCode = 125;
  const provisioner = new Provisioner(db, rooms, catalog, {
    docker,
    apiUrl: "http://127.0.0.1:8787",
    modelEnv: {},
    log: () => undefined,
  });
  assert.deepEqual(await provisioner.drainOnce(), { started: 0, failed: 1, stopped: 0 });
  const job = (await db.scan<Provisioning & { error?: string }>("worker-provisioning")).find(
    (j) => j.value.roomId === roomId,
  )?.value;
  assert.equal(job?.status, "failed");
  assert.match(job?.error ?? "", /docker run 실패\(125\)/);
  assert.ok((await rooms.activities("u2")).some((a) => a.kind === "error"));
  const before = calls.length;
  await provisioner.drainOnce();
  assert.equal(calls.length, before, "failed 큐는 재시도하지 않는다");
  exitCode = 0;
});
