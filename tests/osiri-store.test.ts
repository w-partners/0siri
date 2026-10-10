// 0SIRI-SPEC §22-7: 탐색→상세→구독→방 생성. 구독 트랜잭션 실패 시 롤백. 가격은 설정값(기본 파일럿 무료).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import {
  Catalog,
  MARKET_FEE_RATE,
  type Provisioning,
  storeRoutes,
} from "../apps/server/src/osiri/store.ts";

let db: Store, directory: string, rooms: Rooms, adminId: string;
let catalog: Catalog;
let app: Hono<{ Variables: { owner: string } }>;
const queue: Provisioning[] = [];
let failNextEnqueue = false;
const audits: string[] = [];
const call = (path: string, owner: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const legalTeam = {
  slug: "legal-marketing",
  name: "법률 마케팅팀",
  character: "counsel",
  category: "legal",
  summary: "판례·법령 감지부터 GEO 콘텐츠 발행까지",
  roles: [
    { name: "root", title: "팀장", summary: "목표 분해·배분" },
    { name: "monitor", title: "감지", summary: "새 소식 감지" },
    { name: "drafter", title: "초안 생성", summary: "법령 근거 초안" },
    { name: "geo", title: "GEO 최적화", summary: "AI 검색 인용 구조" },
    { name: "reviewer", title: "검수·컴플라이언스", summary: "인용·광고 규정" },
    { name: "publisher", title: "발행", summary: "승인된 것만 발행" },
    { name: "analyst", title: "성과 분석", summary: "주간 보고" },
  ],
  approvalPoints: ["발행 전 변호사 승인"],
  verified: true,
  metrics: { published: 12, indexed: 9, ai_citations: 4 },
  runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-store-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const accounts = new Accounts(db);
  adminId = (await accounts.ensureAdmin("01000000009", "1234"))?.id as string;
  rooms = new Rooms(db, new EventBus());
  catalog = new Catalog(db, rooms, async (job) => {
    if (failNextEnqueue) {
      failNextEnqueue = false;
      throw new Error("provisioning queue down");
    }
    queue.push(job);
  });
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route(
    "/api",
    storeRoutes(
      catalog,
      accounts,
      async (owner, input) => {
        audits.push(`${owner} ${input.action}`);
      },
      join(directory, "teams"),
    ),
  );
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("패키지 등록 검증 — 검수 역할·승인 지점 없으면 거절, 일반 사용자는 403", async () => {
  assert.equal((await call("/api/admin/packages", "user-1", legalTeam)).status, 403);
  const noReviewer = { ...legalTeam, roles: legalTeam.roles.filter((r) => r.name !== "reviewer") };
  assert.equal((await call("/api/admin/packages", adminId, noReviewer)).status, 422);
  assert.equal(
    (await call("/api/admin/packages", adminId, { ...legalTeam, approvalPoints: [] })).status,
    422,
  );
  const created = await call("/api/admin/packages", adminId, legalTeam);
  assert.equal(created.status, 200);
  const pkg = (await created.json()) as {
    runtime?: unknown;
    priceMonthly: number;
    roleCount: number;
  };
  assert.equal(pkg.runtime, undefined, "팀 YAML·이미지는 비공개");
  assert.equal(pkg.priceMonthly, 0, "기본 파일럿 무료");
  assert.equal(pkg.roleCount, 7);
});

test("탐색·검색·정렬, 가격은 설정값, 구독 트랜잭션(성공·롤백), 해지", async () => {
  await call("/api/admin/packages", adminId, {
    ...legalTeam,
    slug: "clinic-marketing",
    name: "병원 마케팅팀",
    summary: "병원 블로그·후기 관리",
    category: "medical",
    verified: false,
    metrics: { published: 1, indexed: 0, ai_citations: 0 },
  });
  const all = (await (await call("/api/store/packages", "user-1")).json()) as { slug: string }[];
  assert.deepEqual(
    all.map((p) => p.slug),
    ["legal-marketing", "clinic-marketing"],
    "성과순",
  );
  const legalOnly = (await (await call("/api/store/packages?category=legal", "user-1")).json()) as {
    slug: string;
  }[];
  assert.deepEqual(
    legalOnly.map((p) => p.slug),
    ["legal-marketing"],
  );
  const searched = (await (
    await call(`/api/store/packages?q=${encodeURIComponent("판례")}`, "user-1")
  ).json()) as { slug: string }[];
  assert.deepEqual(
    searched.map((p) => p.slug),
    ["legal-marketing"],
  );

  // 가격은 관리자 설정 — 코드에 금액 없음
  assert.equal(
    (
      await call(
        "/api/admin/settings",
        "user-1",
        { key: "price:legal-marketing", value: 99000 },
        "PATCH",
      )
    ).status,
    403,
  );
  await call(
    "/api/admin/settings",
    adminId,
    { key: "price:legal-marketing", value: 99000 },
    "PATCH",
  );
  const detail = (await (await call("/api/store/packages/legal-marketing", "user-1")).json()) as {
    id: string;
    priceMonthly: number;
  };
  assert.equal(detail.priceMonthly, 99000);
  const settings = (await (await call("/api/admin/settings", adminId)).json()) as {
    marketFeeRate: number;
  };
  assert.equal(settings.marketFeeRate, MARKET_FEE_RATE);

  // 사용 허용: 관리자가 허용하기 전에는 목록에 보이기만 하고 구독은 403 kind "grant"
  const grants = "/api/admin/grants";
  const ungranted = await call("/api/subscriptions", "user-1", { packageId: detail.id });
  assert.equal(ungranted.status, 403);
  assert.equal(((await ungranted.json()) as { kind: string }).kind, "grant");
  const grant = { userId: adminId, packageId: detail.id, allowed: true };
  assert.equal((await call(grants, "user-1", grant, "PUT")).status, 403, "허용은 관리자만");
  assert.equal(
    (await call(grants, adminId, { ...grant, userId: "no-such-user" }, "PUT")).status,
    404,
  );
  // 테스트의 "user-1" 은 계정이 없는 이름표라, 허용 기록은 카탈로그로 직접 넣는다
  await catalog.setGrant("user-1", detail.id, true);
  assert.equal((await call(grants, adminId, grant, "PUT")).status, 200);
  assert.ok(audits.some((line) => line.includes(`store.grant user=${adminId}`)));
  assert.deepEqual(
    ((await (await call(`${grants}/${adminId}`, adminId)).json()) as { packageIds: string[] })
      .packageIds,
    [detail.id],
  );
  const listed = (await (await call("/api/store/packages", "user-1")).json()) as {
    allowed: boolean;
  }[];
  assert.equal(listed[0]?.allowed, true);
  assert.equal(
    ((await (await call("/api/store/packages", "user-2")).json()) as typeof listed)[0]?.allowed,
    false,
  );

  // 롤백: 큐 등록 실패 → 구독·방 모두 없어야 한다
  failNextEnqueue = true;
  const failed = await call("/api/subscriptions", "user-1", { packageId: detail.id });
  assert.equal(failed.status, 502);
  assert.equal((await db.list("user-1", "subscriptions")).length, 0);
  assert.equal((await db.list("user-1", "rooms")).length, 0);
  assert.equal(queue.length, 0);

  // 성공: 구독 + 방 + 큐
  const ok = await call("/api/subscriptions", "user-1", { packageId: detail.id });
  assert.equal(ok.status, 200);
  const { subscription, roomId } = (await ok.json()) as {
    subscription: { id: string; priceMonthly: number };
    roomId: string;
  };
  assert.equal(subscription.priceMonthly, 99000);
  const room = await rooms.get("user-1", roomId);
  assert.equal(room.title, "법률 마케팅팀");
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.roomId, roomId);
  // 중복 구독 409
  assert.equal((await call("/api/subscriptions", "user-1", { packageId: detail.id })).status, 409);
  // 내 구독 카드
  const cards = (await (await call("/api/subscriptions/mine", "user-1")).json()) as {
    packageName: string;
    pendingApprovals: number;
  }[];
  assert.equal(cards[0]?.packageName, "법률 마케팅팀");
  assert.equal(cards[0]?.pendingApprovals, 0);
  // 다른 사용자에게는 없다
  assert.equal(
    ((await (await call("/api/subscriptions/mine", "user-2")).json()) as unknown[]).length,
    0,
  );

  // 해지(예약) → 30일 보존 고지. 방은 기간 말까지 그대로 쓴다
  const cancelled = (await (
    await call(`/api/subscriptions/${subscription.id}/cancel`, "user-1", {})
  ).json()) as {
    status: string;
    dataRetainedUntil: string;
  };
  assert.equal(cancelled.status, "cancelled");
  assert.ok(Date.parse(cancelled.dataRetainedUntil) > Date.now() + 29 * 24 * 3600 * 1000);
  assert.notEqual((await rooms.get("user-1", roomId)).archived, true);
  // 해지 후 재구독 가능 — 새로 시작하면 옛 방은 그때 읽기 전용이 된다
  assert.equal((await call("/api/subscriptions", "user-1", { packageId: detail.id })).status, 200);
  assert.equal((await rooms.get("user-1", roomId)).archived, true);

  // 허용을 거두면 쓰던 구독은 해지 예약이 되고, 해지 취소도 새 구독도 막힌다
  await catalog.setGrant("user-1", detail.id, false);
  const mine = (await (await call("/api/subscriptions/mine", "user-1")).json()) as {
    id: string;
    status: string;
  }[];
  const revoked = mine.find((sub) => sub.status === "cancelled");
  assert.ok(revoked, "쓰던 구독이 해지 예약으로 바뀐다");
  assert.ok(mine.every((sub) => sub.status !== "active"));
  const resumed = await call(`/api/subscriptions/${revoked.id}/resume`, "user-1", {});
  assert.equal(resumed.status, 403);
  assert.equal(((await resumed.json()) as { kind: string }).kind, "grant");
});

test("스토어 등록(관리자 화면): 팀 YAML 이 이름·역할·승인 지점의 정본, 심사 중으로 올리면 구독 불가", async () => {
  const yaml = await readFile("teams/legal-marketing.yaml", "utf8");
  const form = { summary: "소개", image: "osiri/team:1", reviewing: true };
  assert.equal((await call("/api/admin/packages/yaml", "user-1", { ...form, yaml })).status, 403);
  const broken = await call("/api/admin/packages/yaml", adminId, { ...form, yaml: "package: [" });
  assert.equal(broken.status, 422, "읽지 못한 YAML 은 이유와 함께 거절");
  const noReviewer = yaml.replace(/\n {2}reviewer:/, "\n  checker:");
  const rejected = await call("/api/admin/packages/yaml", adminId, { ...form, yaml: noReviewer });
  assert.equal(rejected.status, 422);
  const ok = await call("/api/admin/packages/yaml", adminId, { ...form, yaml });
  assert.equal(ok.status, 200);
  const pkg = (await ok.json()) as {
    id: string;
    name: string;
    reviewing: boolean;
    roleCount: number;
  };
  assert.equal(pkg.name, "법률 마케팅팀");
  assert.equal(pkg.reviewing, true);
  assert.equal(pkg.roleCount, 8, "YAML 의 agents 전부");
  const saved = (
    await db.list<{ slug: string; runtime: { teamYaml: string } }>("system", "packages")
  ).find((p) => p.slug === "legal-marketing");
  assert.equal(await readFile(saved?.runtime.teamYaml as string, "utf8"), yaml);
  await catalog.setGrant("user-3", pkg.id, true);
  assert.equal((await call("/api/subscriptions", "user-3", { packageId: pkg.id })).status, 409);
  assert.ok(audits.some((line) => line.includes("store.register legal-marketing reviewing=true")));
});
