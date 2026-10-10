// 계약 «스킬 (화면 9)» · 0SIRI-SPEC §17: 초안(워커) → 승인(사람) → 장착 → 롤백. 기준 완화 초안은 422, 패키지 공통 스킬은 운영자만.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Operator, operatorRoutes } from "../apps/server/src/osiri/operator.ts";
import { issueWorkerToken, workerRoutes } from "../apps/server/src/osiri/room-routes.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import {
  type Skill,
  Skills,
  skillRoutes,
  skillWorkerRoutes,
} from "../apps/server/src/osiri/skills.ts";
import { Catalog } from "../apps/server/src/osiri/store.ts";
import { grantOnSubscribe } from "./grant-on-subscribe.ts";

let db: Store, directory: string, rooms: Rooms, skills: Skills;
let app: Hono<{ Variables: { owner: string } }>;
let userId: string, otherUserId: string, operatorId: string, strangerOperatorId: string;
let personalRoomId: string, teamRoomId: string, packageId: string;
let personalWorker: string, teamWorker: string;

const call = (path: string, token: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(response: Response) => (await response.json()) as T;
const draftBody = (name: string, scope: "personal" | "package" = "personal") => ({
  scope,
  name,
  evidence: "정의문으로 시작한 글의 인용률 2배 (최근 4주, 12건)",
  appliesTo: "상속 콘텐츠 초안",
  actor: "analyst",
});
/** 워커가 초안을 내고 사용자가 승인한 개인 스킬. */
async function approvedPersonal(name: string) {
  const draft = await json<Skill>(
    await call("/api/worker/skills", personalWorker, draftBody(name)),
  );
  return json<Skill>(await call(`/api/skills/${draft.id}/decide`, userId, { decision: "approve" }));
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-skills-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const accounts = new Accounts(db);
  const bus = new EventBus();
  rooms = new Rooms(db, bus);
  const approvals = new Approvals(db, rooms, bus);
  const catalog = new Catalog(db, rooms, async () => undefined);
  grantOnSubscribe(catalog);
  skills = new Skills(db, rooms);
  const operator = new Operator(db, rooms, catalog, accounts, skills);

  userId = (await accounts.createUser({ phone: "01011110001", password: "1234" })).id;
  otherUserId = (await accounts.createUser({ phone: "01011110002", password: "1234" })).id;
  operatorId = (
    await accounts.createUser({ phone: "01011110003", password: "1234", role: "operator" })
  ).id;
  strangerOperatorId = (
    await accounts.createUser({ phone: "01011110004", password: "1234", role: "operator" })
  ).id;
  const pkg = await catalog.upsertPackage({
    slug: "legal-marketing",
    name: "법률 마케팅팀",
    character: "counsel",
    category: "legal",
    summary: "판례·법령 감지부터 GEO 콘텐츠 발행까지",
    roles: [
      { name: "root", title: "팀장", summary: "목표 분해·배분" },
      { name: "reviewer", title: "검수", summary: "인용·광고 규정" },
      { name: "publisher", title: "발행", summary: "승인된 것만 발행" },
      { name: "analyst", title: "성과 분석", summary: "주간 보고" },
    ],
    approvalPoints: ["발행 전 변호사 승인"],
    reportCadence: "weekly",
    verified: true,
    metrics: { published: 0, indexed: 0, ai_citations: 0 },
    runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
  });
  packageId = pkg.id;
  await operator.assignOperator(packageId, operatorId);
  personalRoomId = (await rooms.ensurePersonalRoom(userId)).id;
  teamRoomId = (await catalog.subscribe(userId, packageId)).roomId;
  personalWorker = await issueWorkerToken(db, userId, personalRoomId, null);
  teamWorker = await issueWorkerToken(db, userId, teamRoomId, packageId);

  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  // app.ts 와 같은 순서: 워커 인증 미들웨어(workerRoutes) → 스킬 워커 라우트 → 사용자 인증
  app.route("/api/worker", workerRoutes({ db, rooms, approvals, bus }));
  app.route("/api/worker", skillWorkerRoutes(skills));
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", skillRoutes(skills));
  app.route("/api", operatorRoutes(operator));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("워커 초안 — 토큰 없으면 401, 기준 완화(loosens)는 422 이고 초안이 생기지 않는다", async () => {
  assert.equal((await call("/api/worker/skills", "not-a-token", draftBody("x"))).status, 401);
  // 인증 미들웨어 없이 마운트되면 열리지 않고 401 (fail-closed)
  const bare = new Hono().route("/api/worker", skillWorkerRoutes(skills));
  bare.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  const unguarded = await bare.request("/api/worker/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${personalWorker}` },
    body: JSON.stringify(draftBody("x")),
  });
  assert.equal(unguarded.status, 401);

  const loosened = await call("/api/worker/skills", personalWorker, {
    ...draftBody("검수 기준 완화"),
    loosens: true,
  });
  assert.equal(loosened.status, 422);
  assert.match((await json<{ error: string }>(loosened)).error, /완화/);
  const list = await json<Skill[]>(await call("/api/skills", userId));
  assert.equal(
    list.some((s) => s.name === "검수 기준 완화"),
    false,
  );
  const blocked = (await rooms.auditLogs(userId)).find(
    (entry) => entry.action === "skill.draft:검수 기준 완화",
  );
  assert.equal(blocked?.result, "blocked", "막힌 시도도 감사 로그에 남는다");
  // 개인 방에서 패키지 공통 스킬은 제안할 수 없다
  assert.equal(
    (await call("/api/worker/skills", personalWorker, draftBody("공통", "package"))).status,
    422,
  );
});

test("개인 스킬 — 초안은 계약 모양, 본인만 승인하고 결정은 감사 로그에 남는다", async () => {
  const created = await call("/api/worker/skills", personalWorker, draftBody("변호사 톤"));
  assert.equal(created.status, 200);
  const draft = await json<Skill>(created);
  assert.deepEqual(
    {
      roomId: draft.roomId,
      scope: draft.scope,
      version: draft.version,
      status: draft.status,
      proposedBy: draft.proposedBy,
      measuring: draft.measuring,
      effect: draft.effect,
    },
    {
      roomId: personalRoomId,
      scope: "personal",
      version: "1",
      status: "draft",
      proposedBy: "analyst",
      measuring: false,
      effect: null,
    },
  );
  // 남의 개인 스킬은 보이지도, 결정되지도 않는다
  assert.deepEqual(await json<Skill[]>(await call("/api/skills", otherUserId)), []);
  assert.equal(
    (await call(`/api/skills/${draft.id}/decide`, otherUserId, { decision: "approve" })).status,
    404,
  );
  const approved = await call(`/api/skills/${draft.id}/decide`, userId, {
    decision: "approve",
    reason: "톤이 맞다",
  });
  assert.equal(approved.status, 200);
  const active = await json<Skill & { decidedBy?: string }>(approved);
  assert.equal(active.status, "active");
  assert.equal(active.measuring, true, "장착 직후는 효과 측정 중");
  assert.equal(active.decidedBy, undefined, "결정자 id 는 응답에 싣지 않는다");
  // 이미 결정된 초안은 다시 결정할 수 없다
  assert.equal(
    (await call(`/api/skills/${draft.id}/decide`, userId, { decision: "reject" })).status,
    409,
  );
  const logged = (await rooms.auditLogs(userId)).find(
    (entry) => entry.action === "skill.approve:변호사 톤@v1",
  );
  assert.equal(logged?.result, "ok");
  assert.deepEqual(logged?.sourceRefs, [draft.id]);
});

test("패키지 공통 스킬 — 구독자에게 보이지만 사용자 결정은 403, 그 패키지 운영자만 승인한다", async () => {
  const draft = await json<Skill>(
    await call("/api/worker/skills", teamWorker, draftBody("민법 인용 표기", "package")),
  );
  assert.equal(draft.scope, "package");
  assert.equal(draft.roomId, null);
  const visible = await json<Skill[]>(await call(`/api/skills?room_id=${teamRoomId}`, userId));
  assert.equal(
    visible.some((s) => s.id === draft.id),
    true,
    "패키지 초안은 구독자 화면에 보인다",
  );
  // 구독하지 않은 사용자에게는 존재하지 않는 것과 같다
  assert.equal(
    (await call(`/api/skills/${draft.id}/decide`, otherUserId, { decision: "approve" })).status,
    404,
  );
  const denied = await call(`/api/skills/${draft.id}/decide`, userId, { decision: "approve" });
  assert.equal(denied.status, 403);
  assert.match((await json<{ error: string }>(denied)).error, /운영자/);
  assert.equal((await call(`/api/skills/${draft.id}/rollback`, userId, {})).status, 403);
  assert.equal(
    (await call(`/api/skills/${draft.id}`, userId, { enabled: false }, "PATCH")).status,
    403,
  );
  // 운영자 콘솔: 일반 사용자·남의 패키지 운영자는 403
  const path = `/api/operator/skills/${draft.id}/decide`;
  assert.equal((await call(path, userId, { decision: "approve" })).status, 403);
  assert.equal((await call(path, strangerOperatorId, { decision: "approve" })).status, 403);
  assert.equal(
    (await call(`/api/operator/skills?package_id=${packageId}`, strangerOperatorId)).status,
    403,
  );
  // 운영자는 승인·반려만 — 폐기·유지는 받지 않는다
  assert.notEqual((await call(path, operatorId, { decision: "retire" })).status, 200);
  const queue = await json<Skill[]>(
    await call(`/api/operator/skills?package_id=${packageId}`, operatorId),
  );
  assert.deepEqual(
    queue.map((s) => s.id),
    [draft.id],
  );
  const approved = await call(path, operatorId, { decision: "approve" });
  assert.equal(approved.status, 200);
  assert.equal((await json<Skill>(approved)).status, "active");
  const logged = (await rooms.auditLogs(operatorId)).find(
    (entry) => entry.action === "skill.approve:민법 인용 표기@v1",
  );
  assert.equal(logged?.packageId, packageId, "운영자 결정도 감사 로그에 패키지와 함께 남는다");
});

test("롤백 — 새 버전을 장착하면 이전 버전이 물러나고, 롤백하면 이전 버전이 다시 장착된다", async () => {
  const v1 = await approvedPersonal("GEO 구조");
  const v2 = await approvedPersonal("GEO 구조");
  assert.equal(v2.version, "2");
  const byId = async () =>
    new Map(
      (await json<Skill[]>(await call(`/api/skills?room_id=${personalRoomId}`, userId))).map(
        (s) => [s.id, s.status],
      ),
    );
  assert.equal((await byId()).get(v1.id), "retired");
  assert.equal((await byId()).get(v2.id), "active");

  const rolled = await call(`/api/skills/${v2.id}/rollback`, userId, {});
  assert.equal(rolled.status, 200);
  const restored = await json<Skill>(rolled);
  assert.equal(restored.id, v1.id);
  assert.equal(restored.status, "active");
  assert.equal((await byId()).get(v2.id), "retired");
  // 더 되돌릴 이전 버전이 없다
  assert.equal((await call(`/api/skills/${v1.id}/rollback`, userId, {})).status, 409);
  const logged = (await rooms.auditLogs(userId)).some(
    (entry) => entry.action === "skill.rollback:GEO 구조@v2->v1",
  );
  assert.equal(logged, true);
});

test("끄기·폐기 제안(유지/폐기)·필터", async () => {
  const skill = await approvedPersonal("광고 규정 체크");
  const off = await call(`/api/skills/${skill.id}`, userId, { enabled: false }, "PATCH");
  assert.equal(off.status, 200);
  const disabled = await json<Skill>(off);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "active", "끄기는 장착 상태를 바꾸지 않는다");

  // 유지(keep)는 폐기 제안이 있을 때만
  assert.equal(
    (await call(`/api/skills/${skill.id}/decide`, userId, { decision: "keep" })).status,
    409,
  );
  const proposed = await skills.proposeRetire(userId, skill.id, "반려율 12% → 19%");
  assert.equal(proposed.status, "retire_proposed");
  assert.equal(proposed.effect, "반려율 12% → 19%");
  const kept = await json<Skill>(
    await call(`/api/skills/${skill.id}/decide`, userId, { decision: "keep" }),
  );
  assert.equal(kept.status, "active");
  const retired = await json<Skill>(
    await call(`/api/skills/${skill.id}/decide`, userId, { decision: "retire" }),
  );
  assert.equal(retired.status, "retired");

  const only = async (query: string) => json<Skill[]>(await call(`/api/skills?${query}`, userId));
  assert.equal(
    (await only("scope=package")).every((s) => s.scope === "package"),
    true,
  );
  assert.equal(
    (await only("status=retired")).every((s) => s.status === "retired"),
    true,
  );
  assert.equal((await only("status=retired")).length > 0, true);
  assert.equal(
    (await only(`room_id=${personalRoomId}&scope=personal`)).every(
      (s) => s.roomId === personalRoomId,
    ),
    true,
  );
  // 남의 방 id 로는 조회할 수 없다
  assert.equal((await call(`/api/skills?room_id=${teamRoomId}`, otherUserId)).status, 404);
});
