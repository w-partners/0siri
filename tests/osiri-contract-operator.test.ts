// 계약 «운영자 콘솔 (화면 10)» · 0SIRI-SPEC §15.5·§16: 운영자·관리자만, 자기 패키지만. 심사 탈락은 배포를 막고, 카나리·롤백·집계·공지.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import {
  Operator,
  type OperatorMetrics,
  operatorRoutes,
  type PackageVersion,
  type ReviewCheck,
} from "../apps/server/src/osiri/operator.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Skills } from "../apps/server/src/osiri/skills.ts";
import { Catalog, type TeamPackage } from "../apps/server/src/osiri/store.ts";
import {
  REVIEW_ITEM_LABELS,
  REVIEW_ITEMS,
  REVIEW_MANUAL_REASON,
  type ReviewItem,
} from "../packages/domain/src/osiri.ts";

let db: Store, directory: string, rooms: Rooms, catalog: Catalog, accounts: Accounts;
let skills: Skills, strict: Operator;
let app: Hono<{ Variables: { owner: string } }>;
let adminId: string, operatorId: string, otherOperatorId: string;
let subscriberA: string, subscriberB: string, outsider: string;
let legalId: string, contentId: string;
let roomA: string, roomB: string, outsiderRoom: string;
/** 주입 검사가 떨어뜨릴 항목. 비어 있으면 9항 전부 통과. */
const failing = new Set<ReviewItem>();
const injected = Object.fromEntries(
  REVIEW_ITEMS.map((id) => [
    id,
    (() =>
      failing.has(id) ? { pass: false, reason: "주입된 실패" } : { pass: true }) as ReviewCheck,
  ]),
) as Record<ReviewItem, ReviewCheck>;
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const call = (path: string, owner: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T>(response: Response) => (await response.json()) as T;
const team = (slug: string, name: string): Omit<TeamPackage, "id" | "createdAt"> => ({
  slug,
  name,
  character: "counsel",
  category: "legal",
  summary: "테스트 팀",
  roles: [
    { name: "root", title: "팀장", summary: "목표 분해" },
    { name: "reviewer", title: "검수", summary: "검수" },
    { name: "publisher", title: "발행", summary: "발행" },
    { name: "analyst", title: "분석", summary: "보고" },
  ],
  approvalPoints: ["발행 전 승인"],
  reportCadence: "weekly",
  verified: true,
  metrics: { published: 0, indexed: 0, ai_citations: 0 },
  runtime: { teamYaml: `teams/${slug}.yaml`, image: "osiri/team-runtime" },
});
const submit = async (seed: string) =>
  json<PackageVersion>(
    await call("/api/operator/versions", operatorId, {
      packageId: legalId,
      imageDigest: digest(seed),
    }),
  );
const advance = (id: string, owner = operatorId) =>
  call(`/api/operator/versions/${id}/canary`, owner, { action: "advance" });
/** 제출 → profile → partial → all(운영 중) */
async function shipped(seed: string) {
  const version = await submit(seed);
  assert.equal(version.status, "canary");
  await advance(version.id);
  return json<PackageVersion>(await advance(version.id));
}
const currentVersion = async () =>
  (
    await json<{ id: string; currentVersion: string | null }[]>(
      await call("/api/operator/packages", operatorId),
    )
  ).find((pkg) => pkg.id === legalId)?.currentVersion;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-operator-"));
  db = await createStore({ dataDir: join(directory, "db") });
  accounts = new Accounts(db);
  rooms = new Rooms(db, new EventBus());
  catalog = new Catalog(db, rooms, async () => undefined);
  skills = new Skills(db, rooms);
  const operator = new Operator(db, rooms, catalog, accounts, skills, { checks: injected });
  // 운영과 같은 기본 심사 — MCP 확인만 테스트용으로 바꾼다
  strict = new Operator(db, rooms, catalog, accounts, skills, {
    probeMcp: async (url) => {
      if (url.includes("down")) throw new Error("ECONNREFUSED");
      return 3;
    },
  });

  const user = async (phone: string, role?: "operator" | "admin") =>
    (await accounts.createUser({ phone, password: "1234", role })).id;
  adminId = await user("01022220000", "admin");
  operatorId = await user("01022220001", "operator");
  otherOperatorId = await user("01022220002", "operator");
  subscriberA = await user("01022220003");
  subscriberB = await user("01022220004");
  outsider = await user("01022220005");
  legalId = (await catalog.upsertPackage(team("legal-marketing", "법률 마케팅팀"))).id;
  contentId = (await catalog.upsertPackage(team("content-studio", "콘텐츠팀"))).id;
  await operator.assignOperator(legalId, operatorId);
  await operator.assignOperator(contentId, otherOperatorId);
  roomA = (await catalog.subscribe(subscriberA, legalId)).roomId;
  roomB = (await catalog.subscribe(subscriberB, legalId)).roomId;
  outsiderRoom = (await catalog.subscribe(outsider, contentId)).roomId;

  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", operatorRoutes(operator));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("권한 — 운영자·관리자가 아니면 전부 403(문장), 운영자는 자기 패키지만", async () => {
  const q = `package_id=${legalId}`;
  const attempts: [string, unknown?][] = [
    ["/api/operator/packages"],
    [`/api/operator/versions?${q}`],
    ["/api/operator/versions", { packageId: legalId, imageDigest: digest("a") }],
    ["/api/operator/versions/any/canary", { action: "advance" }],
    ["/api/operator/rollback", { packageId: legalId }],
    [`/api/operator/metrics?${q}`],
    [`/api/operator/skills?${q}`],
    ["/api/operator/skills/any/decide", { decision: "approve" }],
    ["/api/operator/notices", { packageId: legalId, text: "공지" }],
  ];
  for (const [path, body] of attempts) {
    const denied = await call(path, subscriberA, body);
    assert.equal(denied.status, 403, `일반 사용자 ${path}`);
    assert.match((await json<{ error: string }>(denied)).error, /운영자/);
  }
  // 남의 패키지: 목록에 없고, 건드리면 403
  const mine = await json<{ id: string }[]>(await call("/api/operator/packages", otherOperatorId));
  assert.deepEqual(
    mine.map((pkg) => pkg.id),
    [contentId],
  );
  for (const [path, body] of attempts.filter(([path]) => !path.includes("/any/")).slice(1)) {
    const denied = await call(path, otherOperatorId, body);
    assert.equal(denied.status, 403, `남의 패키지 ${path}`);
    assert.match((await json<{ error: string }>(denied)).error, /자기 패키지/);
  }
  assert.equal((await call("/api/operator/versions", operatorId)).status, 422, "package_id 필수");
  // 관리자는 플랫폼 전체 패키지를 본다
  const all = await json<{ id: string }[]>(await call("/api/operator/packages", adminId));
  assert.deepEqual(new Set(all.map((pkg) => pkg.id)), new Set([legalId, contentId]));
  // 일반 사용자는 패키지 담당이 될 수 없다
  await assert.rejects(strict.assignOperator(legalId, subscriberA), /운영자/);
});

test("기본 심사 — 확인 못 하는 항목은 통과가 아니라 «수동 심사 필요», 탈락하면 배포가 없다", async () => {
  const version = await strict.submit(operatorId, { packageId: legalId, imageDigest: digest("b") });
  assert.equal(version.status, "review_failed");
  assert.deepEqual(version.canary, { stage: "stopped", percent: 0 });
  assert.deepEqual(
    version.review.map((r) => r.id),
    [...REVIEW_ITEMS],
    "9항 전부, 정해진 순서",
  );
  assert.equal(version.review.length, 9);
  for (const result of version.review) {
    assert.equal(result.pass, false);
    assert.equal(result.reason, REVIEW_MANUAL_REASON);
    assert.equal(result.item, REVIEW_ITEM_LABELS[result.id]);
  }
  // 탈락한 버전은 카나리로 못 간다 · 현재 버전은 여전히 없다
  const blocked = await advance(version.id);
  assert.equal(blocked.status, 409);
  assert.match((await json<{ error: string }>(blocked)).error, /심사/);
  assert.equal(await currentVersion(), null);

  // MCP 서버가 tools/list 에 답하지 않으면 그 사실이 사유로 남는다
  const down = await strict.submit(operatorId, {
    packageId: legalId,
    mcpUrl: "https://down.example.com/mcp",
  });
  const tools = down.review.find((r) => r.id === "external_requires_token");
  assert.match(tools?.reason ?? "", /ECONNREFUSED/);
  // 답하더라도 그것만으로 통과시키지 않는다
  const up = await strict.submit(operatorId, {
    packageId: legalId,
    mcpUrl: "https://up.example.com/mcp",
  });
  assert.equal(up.status, "review_failed");
  assert.equal(
    up.review.find((r) => r.id === "external_requires_token")?.reason,
    REVIEW_MANUAL_REASON,
  );

  // 검수 역할이 빠진 패키지는 실제 사유로 탈락한다 (등록 검증을 우회해 저장된 경우)
  const broken: TeamPackage = {
    ...team("no-reviewer", "검수 없는 팀"),
    id: "pkg-no-reviewer",
    createdAt: new Date().toISOString(),
  };
  broken.roles = broken.roles.filter((role) => role.name !== "reviewer");
  await db.put("system", "packages", broken);
  const noReviewer = await strict.submit(adminId, {
    packageId: broken.id,
    imageDigest: digest("c"),
  });
  assert.match(
    noReviewer.review.find((r) => r.id === "reviewer_rejects")?.reason ?? "",
    /reviewer/,
  );
  await db.remove("system", "packages", broken.id);

  // 출처가 없거나 형식이 틀리면 심사 전에 422 — 주소에 박힌 비밀번호는 저장하지 않는다
  for (const source of [
    {},
    { imageDigest: "latest" },
    { mcpUrl: "http://plain.example.com/mcp" },
    { mcpUrl: "https://user:secret@example.com/mcp" },
    { mcpUrl: "not a url" },
  ])
    await assert.rejects(
      strict.submit(operatorId, { packageId: legalId, ...source }),
      (error: unknown) => error instanceof AppError && error.status === 422,
    );
  // 검사가 던지면 통과가 아니라 탈락이다
  const throwing = new Operator(db, rooms, catalog, accounts, skills, {
    checks: {
      ...injected,
      no_secret_exposure: () => {
        throw new Error("probe crashed");
      },
    },
  });
  const crashed = await throwing.submit(operatorId, {
    packageId: legalId,
    imageDigest: digest("d"),
  });
  assert.equal(crashed.status, "review_failed");
  assert.match(
    crashed.review.find((r) => r.id === "no_secret_exposure")?.reason ?? "",
    /probe crashed/,
  );
});

test("한 항목이라도 실패하면 review_failed, 전부 통과하면 카나리 profile → partial → all", async () => {
  failing.add("cross_user_denied");
  const failed = await submit("e");
  failing.clear();
  assert.equal(failed.status, "review_failed");
  assert.equal(failed.review.filter((r) => !r.pass).length, 1);
  assert.equal((await advance(failed.id)).status, 409);

  const version = await submit("f");
  assert.equal(version.status, "canary");
  assert.deepEqual(version.canary, { stage: "profile", percent: 0 });
  assert.equal((await advance(version.id, otherOperatorId)).status, 403, "남의 버전은 못 넓힌다");
  const partial = await json<PackageVersion>(await advance(version.id));
  assert.equal(partial.canary.stage, "partial");
  assert.equal(partial.canary.percent > 0 && partial.canary.percent < 100, true);
  assert.equal(partial.status, "canary");
  assert.equal(await currentVersion(), null, "전체 배포 전에는 현재 버전이 아니다");
  const all = await json<PackageVersion>(await advance(version.id));
  assert.deepEqual(all.canary, { stage: "all", percent: 100 });
  assert.equal(all.status, "live");
  assert.equal(await currentVersion(), version.version);
  assert.equal((await advance(version.id)).status, 409, "전체 배포 뒤에는 더 넓힐 수 없다");

  // 중단: 그 자리에서 멈추고 다시 넓힐 수 없다
  const halted = await submit("1");
  const stopped = await json<PackageVersion>(
    await call(`/api/operator/versions/${halted.id}/canary`, operatorId, { action: "stop" }),
  );
  assert.deepEqual(stopped.canary, { stage: "stopped", percent: 0 });
  assert.equal((await advance(halted.id)).status, 409);
  assert.equal(
    await currentVersion(),
    version.version,
    "중단된 카나리는 현재 버전을 바꾸지 않는다",
  );
  assert.equal(
    (await call("/api/operator/versions/no-such-id/canary", operatorId, { action: "stop" })).status,
    404,
  );
});

test("롤백 — 심사 없이 바로 이전 운영 버전으로, 버전 목록은 최신순", async () => {
  const before = await currentVersion();
  const next = await shipped("2");
  assert.equal(next.status, "live");
  assert.equal(await currentVersion(), next.version);

  const rolled = await call("/api/operator/rollback", operatorId, { packageId: legalId });
  assert.equal(rolled.status, 200);
  const result = await json<{ rolledBack: PackageVersion; current: PackageVersion }>(rolled);
  assert.equal(result.rolledBack.id, next.id);
  assert.equal(result.rolledBack.status, "rolled_back");
  assert.equal(result.current.version, before);
  assert.equal(await currentVersion(), before);
  // 더 되돌릴 운영 버전이 없으면 409
  assert.equal(
    (await call("/api/operator/rollback", operatorId, { packageId: legalId })).status,
    409,
  );

  const list = await json<PackageVersion[]>(
    await call(`/api/operator/versions?package_id=${legalId}`, operatorId),
  );
  const numbers = list.map((v) => Number(v.version));
  assert.deepEqual(
    numbers,
    [...numbers].sort((a, b) => b - a),
  );
  assert.equal(numbers.length > 3, true);
  assert.equal(
    list.every((v) => !("submittedBy" in v)),
    true,
    "제출자 id 는 응답에 싣지 않는다",
  );
  // 제출·배포·롤백은 감사 로그에 남는다
  const actions = (await rooms.auditLogs(operatorId)).map((entry) => entry.action);
  for (const prefix of ["version.submit:", "version.canary.advance:", "version.rollback:"])
    assert.equal(
      actions.some((action) => action.startsWith(prefix)),
      true,
      prefix,
    );
});

test("지표 — 구독자 방 집계만, 자료가 없으면 null", async () => {
  const path = `/api/operator/metrics?package_id=${legalId}`;
  assert.deepEqual(await json<OperatorMetrics>(await call(path, operatorId)), {
    approvalRate: null,
    topRejectReason: null,
    citations: null,
    degraded: false,
    canaryApprovalRate: null,
    previousApprovalRate: null,
  });
  const approval = (roomId: string, id: string, status: string, extra: object = {}) => ({
    id,
    roomId,
    status,
    title: "의뢰인 실명이 들어간 제목",
    ...extra,
  });
  const reject = { reasonKind: "tone", reason: "김OO 의뢰인 건이라 톤을 낮춰 주세요" };
  await db.put(subscriberA, "approvals", approval(roomA, "a1", "approved"));
  await db.put(subscriberA, "approvals", approval(roomA, "a2", "rejected", reject));
  await db.put(subscriberA, "approvals", approval(roomA, "a3", "pending"));
  await db.put(subscriberB, "approvals", approval(roomB, "b1", "consumed"));
  await db.put(subscriberB, "approvals", approval(roomB, "b2", "rejected", reject));
  await db.put(subscriberB, "approvals", approval(roomB, "b3", "rejected", { reasonKind: "fact" }));
  await db.put(subscriberB, "approvals", approval(roomB, "b4", "expired"));
  // 다른 패키지 구독자의 결재는 섞이지 않는다
  await db.put(
    outsider,
    "approvals",
    approval(outsiderRoom, "o1", "rejected", { reasonKind: "topic" }),
  );
  await db.put(
    outsider,
    "approvals",
    approval(outsiderRoom, "o2", "rejected", { reasonKind: "topic" }),
  );
  await db.put(
    outsider,
    "approvals",
    approval(outsiderRoom, "o3", "rejected", { reasonKind: "topic" }),
  );
  for (const [owner, roomId, citations] of [
    [subscriberA, roomA, 3],
    [subscriberB, roomB, 4],
    [outsider, outsiderRoom, 100],
  ] as const) {
    const goal = await rooms.createGoal(owner, { roomId, title: "인용 늘리기", level: "short" });
    await rooms.updateGoal(owner, goal.id, { progress: 10, metrics: { ai_citations: citations } });
  }

  const response = await call(path, operatorId);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    approvalRate: 40, // 승인 2(approved+consumed) / 결정 5 — 대기·만료는 분모에 넣지 않는다
    topRejectReason: "톤",
    citations: 7,
    // 카나리 배포 중인 버전이 없으면 견줄 것이 없다
    degraded: false,
    canaryApprovalRate: null,
    previousApprovalRate: null,
  });
  assert.equal(body.includes("김OO"), false, "사용자가 쓴 반려 문장은 운영자에게 가지 않는다");
  assert.equal(body.includes(subscriberA) || body.includes(roomA), false);
  // 남의 패키지 지표는 그 패키지 것만
  assert.deepEqual(
    await json<OperatorMetrics>(
      await call(`/api/operator/metrics?package_id=${contentId}`, otherOperatorId),
    ),
    {
      approvalRate: 0,
      topRejectReason: "주제",
      citations: 100,
      degraded: false,
      canaryApprovalRate: null,
      previousApprovalRate: null,
    },
  );

  // 카나리 배포 뒤의 승인율이 그 전보다 낮으면 degraded — 화면이 «되돌리기» 를 권할 근거
  const since = new Date().toISOString();
  await db.put("system", "package-versions", {
    id: "ver-degraded",
    packageId: contentId,
    version: "99",
    source: { kind: "upload" },
    review: [],
    canary: { stage: "profile", percent: 10 },
    status: "canary",
    createdAt: since,
    submittedBy: otherOperatorId,
  });
  const decided = (id: string, status: string, offsetMs: number) =>
    db.put(outsider, "approvals", {
      ...approval(outsiderRoom, id, status, { reasonKind: "topic" }),
      decidedAt: new Date(Date.parse(since) + offsetMs).toISOString(),
    });
  await decided("o4", "approved", -60_000);
  await decided("o5", "rejected", 60_000);
  const degraded = await json<OperatorMetrics>(
    await call(`/api/operator/metrics?package_id=${contentId}`, otherOperatorId),
  );
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.previousApprovalRate, 100);
  assert.equal(degraded.canaryApprovalRate, 0);
  // 카나리를 멈추면 견줄 대상이 없어진다
  await db.put("system", "package-versions", {
    ...(await db.get<{ id: string }>("system", "package-versions", "ver-degraded")),
    canary: { stage: "stopped", percent: 0 },
  } as { id: string });
  const stopped = await json<OperatorMetrics>(
    await call(`/api/operator/metrics?package_id=${contentId}`, otherOperatorId),
  );
  assert.equal(stopped.degraded, false);
  assert.equal(stopped.canaryApprovalRate, null);
});

test("공지 — 그 패키지 구독자 방에만 시스템 메시지로 도착한다", async () => {
  const text = "v2 배포: 조문 단위 인용 표기를 적용했습니다";
  const cancelled = await accounts.createUser({ phone: "01022220006", password: "1234" });
  const gone = await catalog.subscribe(cancelled.id, legalId);
  await catalog.cancel(cancelled.id, gone.subscription.id);

  const sent = await call("/api/operator/notices", operatorId, { packageId: legalId, text });
  assert.equal(sent.status, 200);
  assert.deepEqual(await json(sent), { subscribers: 2, delivered: 2, failed: 0 });
  const got = async (owner: string, roomId: string) =>
    (await rooms.timeline(owner, roomId)).filter((m) => m.text === text);
  for (const [owner, roomId] of [
    [subscriberA, roomA],
    [subscriberB, roomB],
  ] as const) {
    const [message] = await got(owner, roomId);
    assert.equal(message?.role, "system");
    assert.equal(message?.payload?.card, "operator-notice");
  }
  assert.equal(
    (await got(outsider, outsiderRoom)).length,
    0,
    "다른 패키지 구독자에게는 가지 않는다",
  );
  assert.equal((await got(cancelled.id, gone.roomId)).length, 0, "해지한 구독자에게는 가지 않는다");
  assert.equal(
    (await call("/api/operator/notices", operatorId, { packageId: legalId, text: "  " })).status >=
      400,
    true,
    "빈 공지는 보내지 않는다",
  );
});
