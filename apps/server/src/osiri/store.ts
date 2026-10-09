// 0Siri 스토어·구독·관리자 설정 (0SIRI-SPEC §6, §18, §24).
//  - 패키지(팀) 정본은 owner="system" 의 packages. 공개 범위는 "무엇을·성과"만 — 팀 YAML·검수 규칙은 응답에서 뺀다 (§19).
//  - 가격은 코드 상수가 아니라 관리자 설정값(settings `price:<slug>`). 설정이 없으면 파일럿 무료(0).
//  - 수수료율만 상수 한 곳: MARKET_FEE_RATE.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  ACCOUNT_TIERS,
  type AccountTier,
  missingTeamRoles,
  PLATFORM_DATA_HANDLING,
  REPORT_CADENCE_LABELS,
  RETENTION_DAYS,
  type ReportCadence,
  STORE_CATEGORY_IDS,
  type StoreCategory,
  type SubscribeErrorKind,
  type SubscriptionStatus,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { type Accounts, KindError } from "./accounts.ts";
import type { Rooms } from "./rooms.ts";

export const MARKET_FEE_RATE = 0.3; // 앱스토어 벤치마크 30% (§18 결정). 변경은 여기 한 곳.
export type Category = StoreCategory;
export interface PackageRole {
  name: string; // yaml 의 에이전트 키 (root, drafter …) — 필수 키는 REQUIRED_TEAM_ROLES
  title: string; // 사용자에게 보이는 역할명
  summary: string;
}
export interface TeamPackage {
  id: string;
  slug: string;
  name: string;
  character: string;
  category: Category;
  summary: string;
  roles: PackageRole[];
  approvalPoints: string[]; // 승인 없이는 나가지 않는 행위 (§7.1-4)
  reportCadence: ReportCadence;
  verified: boolean;
  metrics: { published: number; indexed: number; ai_citations: number };
  operatorNotice?: string;
  /** "입점 심사 중" — 목록에는 보이지만 아직 구독할 수 없다 */
  reviewing?: boolean;
  /** 이 팀의 데이터 처리 방식. 없으면 플랫폼 공통 문구(PLATFORM_DATA_HANDLING) */
  dataHandling?: string;
  /** 이 등급(`users.tier`)이어야 구독할 수 있다. 없으면 누구나 */
  requiredTier?: AccountTier;
  /** 비공개: 팀 YAML 경로·실행 이미지. 응답에 내보내지 않는다. */
  runtime: { teamYaml: string; image: string };
  createdAt: string;
}
export interface Subscription {
  id: string;
  packageId: string;
  roomId: string;
  /** active → (해지) cancelled: 기간 말(`endsAt`)까지 해지 예약 → ended */
  status: SubscriptionStatus;
  priceMonthly: number; // 구독 시점 가격(원). 0 = 파일럿 무료
  startedAt: string;
  nextBillingAt: string;
  cancelledAt?: string;
  dataRetainedUntil?: string; // 해지 후 30일 (§6.2, §15.4.5)
  /** 해지했을 때의 기간 말. 이 시각이 지나면 ended */
  endsAt?: string;
  /** 결제 수단 표시 문구. 파일럿은 결제가 없어 비어 있다 */
  paymentMethod?: string;
}
/** 응답 모양 — 없는 값은 빠뜨리지 않고 null 로 낸다 (계약: `paymentMethod`·`endsAt`). */
export const subscriptionView = (s: Subscription) => ({
  ...s,
  paymentMethod: s.paymentMethod ?? null,
  endsAt: s.endsAt ?? null,
});
export interface Provisioning {
  id: string;
  userId: string;
  packageId: string;
  roomId: string;
  status: "queued" | "running" | "failed";
  createdAt: string;
}
type Setting = { id: string; value: unknown; updatedAt: string };

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PRICE_PREFIX = "price:";
const validPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
/** 발행→인용 전환율(0~100). 발행이 0건이면 아직 잴 수 없다 — null. */
const conversionRate = ({ published, ai_citations }: TeamPackage["metrics"]): number | null =>
  published > 0 ? Math.min(100, Math.round((ai_citations / published) * 1000) / 10) : null;
/** `mine` = 보는 사람의 구독 상태. 주지 않으면(상세를 소유자 없이 조립할 때) 구독 안 함으로 낸다. */
export const publicPackage = (
  { runtime: _runtime, ...pkg }: TeamPackage,
  priceMonthly: number,
  mine: { subscribed: boolean; roomId: string | null } = { subscribed: false, roomId: null },
) => ({
  ...pkg,
  priceMonthly,
  roleCount: pkg.roles.length,
  ...mine,
  reviewing: pkg.reviewing === true,
  reportCadence: REPORT_CADENCE_LABELS[pkg.reportCadence] as string,
  dataHandling: pkg.dataHandling ?? PLATFORM_DATA_HANDLING,
  conversionRate: conversionRate(pkg.metrics),
});

export class Catalog {
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    /** ponytail: 워커 프로비저닝은 큐 기록만. 실제 컨테이너 기동은 team-runtime(8단계)이 큐를 읽는다. 테스트는 실패 주입용으로 바꿔 끼운다. */
    private readonly enqueue: (job: Provisioning) => Promise<void> = async (job) => {
      await this.db.put("system", "worker-provisioning", job);
    },
  ) {}

  // ---- settings (§24) ----
  async setting<T = unknown>(key: string): Promise<T | undefined> {
    return (await this.db.get<Setting>("system", "settings", key))?.value as T | undefined;
  }
  async setSetting(key: string, value: unknown) {
    if (value === undefined) throw new AppError("설정 값이 필요합니다", 422);
    if (key.startsWith(PRICE_PREFIX) && !validPrice(value))
      throw new AppError("가격은 0 이상의 숫자여야 합니다", 422);
    await this.db.put<Setting>("system", "settings", {
      id: key,
      value,
      updatedAt: new Date().toISOString(),
    });
  }
  async settings() {
    return this.db.list<Setting>("system", "settings");
  }
  /** 가격: settings `price:<slug>` 없으면 파일럿 무료(§24-1). 저장된 값이 숫자가 아니면 0 으로 덮지 않고 실패한다. */
  async price(pkg: TeamPackage): Promise<number> {
    const value = await this.setting(`${PRICE_PREFIX}${pkg.slug}`);
    if (value === undefined) return 0;
    if (!validPrice(value))
      throw new AppError(`가격 설정 ${PRICE_PREFIX}${pkg.slug} 값이 올바르지 않습니다`, 500);
    return value;
  }

  // ---- packages ----
  async upsertPackage(input: Omit<TeamPackage, "id" | "createdAt"> & { id?: string }) {
    if (input.roles.length < 3)
      throw new AppError("팀장·전문 역할 2개 이상·검수 역할이 있어야 팀입니다", 422);
    // 런타임(loadTeam)이 요구하는 것과 같은 목록 — 등록은 됐는데 팀이 뜨지 않는 패키지를 막는다
    const missing = missingTeamRoles(input.roles.map((r) => r.name));
    if (missing.length) throw new AppError(`팀 필수 역할이 없습니다: ${missing.join(", ")}`, 422);
    if (input.approvalPoints.length === 0)
      throw new AppError("승인 지점을 1개 이상 선언해야 합니다", 422);
    const existing = (await this.db.list<TeamPackage>("system", "packages")).find(
      (p) => p.slug === input.slug,
    );
    const pkg: TeamPackage = {
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await this.db.put("system", "packages", pkg);
    return pkg;
  }
  /** 이 사용자가 지금 구독 중인(active) 패키지 → 그 방. 해지 예약·종료된 구독은 «구독 중» 이 아니다. */
  private async subscribedRooms(owner: string): Promise<Map<string, string>> {
    return new Map(
      (await this.mine(owner))
        .filter((s) => s.status === "active")
        .map((s) => [s.packageId, s.roomId]),
    );
  }
  /** 한 패키지의 공개 모양 (가격 + 보는 사람의 구독 상태). */
  async packageView(pkg: TeamPackage, owner?: string) {
    const roomId = owner ? (await this.subscribedRooms(owner)).get(pkg.id) : undefined;
    return publicPackage(pkg, await this.price(pkg), {
      subscribed: roomId !== undefined,
      roomId: roomId ?? null,
    });
  }
  async packages(
    filter: { q?: string; category?: Category; sort?: "performance" | "price" | "newest" } = {},
    owner?: string,
  ) {
    let list = await this.db.list<TeamPackage>("system", "packages");
    if (filter.category) list = list.filter((p) => p.category === filter.category);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      list = list.filter((p) =>
        [p.name, p.summary, p.category, ...p.roles.map((r) => `${r.title} ${r.summary}`)]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    const rooms = owner ? await this.subscribedRooms(owner) : new Map<string, string>();
    const priced = await Promise.all(
      list.map(async (p) =>
        publicPackage(p, await this.price(p), {
          subscribed: rooms.has(p.id),
          roomId: rooms.get(p.id) ?? null,
        }),
      ),
    );
    const sort = filter.sort ?? "performance";
    return priced.sort((a, b) =>
      sort === "price"
        ? a.priceMonthly - b.priceMonthly
        : sort === "newest"
          ? b.createdAt.localeCompare(a.createdAt)
          : b.metrics.ai_citations +
            b.metrics.published -
            (a.metrics.ai_citations + a.metrics.published),
    );
  }
  async packageBySlug(slug: string) {
    const pkg = (await this.db.list<TeamPackage>("system", "packages")).find(
      (p) => p.slug === slug,
    );
    if (!pkg) throw new AppError("팀을 찾을 수 없습니다", 404);
    return pkg;
  }
  async packageById(id: string) {
    const pkg = await this.db.get<TeamPackage>("system", "packages", id);
    if (!pkg) throw new AppError("팀을 찾을 수 없습니다", 404);
    return pkg;
  }

  // ---- subscriptions (§6.3 트랜잭션) ----
  /** 구독 + 방 + 프로비저닝 큐를 한 번에. 중간에 실패하면 만든 것을 전부 되돌린다 (보상 롤백). */
  /**
   * `options.restore` — 해지했던 팀을 다시 구독할 때 기존 방을 되살린다(읽기 전용 해제). 아니면 새 방에서 시작한다.
   * `options.tier` — 구독하는 사람의 등급. 패키지가 `requiredTier` 를 요구하는데 모자라면 403 `kind: "tier"`.
   */
  async subscribe(
    owner: string,
    packageId: string,
    options: { restore?: boolean; tier?: AccountTier } = {},
  ): Promise<{ subscription: ReturnType<typeof subscriptionView>; roomId: string }> {
    const pkg = await this.packageById(packageId);
    if (pkg.reviewing) throw new AppError("입점 심사 중인 팀은 아직 구독할 수 없습니다", 409);
    if (
      pkg.requiredTier &&
      ACCOUNT_TIERS.indexOf(options.tier ?? "free") < ACCOUNT_TIERS.indexOf(pkg.requiredTier)
    )
      throw new KindError<SubscribeErrorKind>(
        "지금 등급으로는 이 팀을 구독할 수 없습니다. 등급을 올린 뒤 다시 시도하세요",
        403,
        "tier",
      );
    const subs = (await this.mine(owner)).filter((s) => s.packageId === packageId);
    if (subs.some((s) => s.status === "active")) throw new AppError("이미 구독 중인 팀입니다", 409);
    const now = Date.now();
    // 복원: 가장 최근에 해지한 구독의 방. 복원할 방이 없으면 새 방으로 바꿔치지 않고 실패한다
    const prior = options.restore
      ? subs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
      : undefined;
    if (options.restore && !prior)
      throw new AppError("복원할 이전 구독이 없습니다. 새로 시작을 고르세요", 409);
    const room = prior
      ? await this.rooms.patch(owner, prior.roomId, { archived: false })
      : await this.rooms.create(owner, {
          packageId: pkg.id,
          title: pkg.name,
          character: pkg.character,
        });
    const subscription: Subscription = {
      id: randomUUID(),
      packageId: pkg.id,
      roomId: room.id,
      status: "active",
      priceMonthly: await this.price(pkg),
      startedAt: new Date(now).toISOString(),
      nextBillingAt: new Date(now + MONTH_MS).toISOString(),
    };
    try {
      await this.db.put(owner, "subscriptions", subscription);
      await this.enqueue({
        id: randomUUID(),
        userId: owner,
        packageId: pkg.id,
        roomId: room.id,
        status: "queued",
        createdAt: subscription.startedAt,
      });
    } catch (error) {
      // ponytail: 문서 저장소라 DB 트랜잭션 대신 보상 롤백. 다중 인스턴스가 되면 Postgres 트랜잭션으로.
      await this.db.remove(owner, "subscriptions", subscription.id);
      // 복원한 방은 지우지 않고 다시 읽기 전용으로 돌려놓는다
      if (prior) await this.rooms.patch(owner, room.id, { archived: true });
      else await this.db.remove(owner, "rooms", room.id);
      throw new AppError(`구독에 실패해 되돌렸습니다: ${(error as Error).message}`, 502);
    }
    // 복원한 방을 가리키던 옛 구독은 끝난 것으로 닫는다 — 한 방에 되살릴 수 있는 구독이 둘이 되지 않게
    if (prior && prior.status !== "ended")
      await this.db.put<Subscription>(owner, "subscriptions", {
        ...prior,
        status: "ended",
        endsAt: subscription.startedAt,
      });
    await this.rooms.post(owner, room.id, {
      role: "system",
      kind: "text",
      text: prior
        ? `${pkg.name} 구독을 다시 시작했습니다. 이전 방과 기록을 이어서 씁니다.`
        : `${pkg.name} 구독이 시작되었습니다. 팀이 준비되면 여기로 보고합니다.`,
    });
    return { subscription: subscriptionView(subscription), roomId: room.id };
  }
  /** 내 구독 전부. 해지 예약의 기간 말(`endsAt`)이 지났으면 여기서 ended 로 닫는다 (읽는 곳마다 따로 판정하지 않게). */
  async mine(owner: string): Promise<Subscription[]> {
    const subs = await this.db.list<Subscription>(owner, "subscriptions");
    const now = Date.now();
    return Promise.all(
      subs.map(async (s) =>
        s.status === "cancelled" && s.endsAt !== undefined && Date.parse(s.endsAt) <= now
          ? this.db.put<Subscription>(owner, "subscriptions", { ...s, status: "ended" })
          : s,
      ),
    );
  }
  private async own(owner: string, id: string): Promise<Subscription> {
    const subscription = (await this.mine(owner)).find((s) => s.id === id);
    if (!subscription) throw new AppError("구독을 찾을 수 없습니다", 404);
    return subscription;
  }
  /** 해지(예약): 방은 읽기 전용(archived)으로 남고 30일 뒤 삭제 대상. 기간 말(`endsAt`)까지는 되돌릴 수 있다 */
  async cancel(owner: string, id: string) {
    const subscription = await this.own(owner, id);
    if (subscription.status !== "active") return subscriptionView(subscription);
    const now = Date.now();
    const updated: Subscription = {
      ...subscription,
      status: "cancelled",
      cancelledAt: new Date(now).toISOString(),
      dataRetainedUntil: new Date(now + RETENTION_MS).toISOString(),
      endsAt: subscription.nextBillingAt,
    };
    await this.db.put(owner, "subscriptions", updated);
    await this.rooms.patch(owner, subscription.roomId, { archived: true });
    return subscriptionView(updated);
  }
  /** 해지 예약 취소: cancelled → active, 방 읽기 전용 해제. 이미 끝난 구독은 되살리지 못한다(다시 구독). */
  async resume(owner: string, id: string) {
    const subscription = await this.own(owner, id);
    if (subscription.status === "active") return subscriptionView(subscription);
    if (subscription.status === "ended")
      throw new AppError("이미 종료된 구독입니다. 스토어에서 다시 구독하세요", 409);
    const others = (await this.mine(owner)).filter(
      (s) => s.id !== id && s.packageId === subscription.packageId && s.status === "active",
    );
    if (others.length) throw new AppError("이미 구독 중인 팀입니다", 409);
    const {
      cancelledAt: _cancelledAt,
      dataRetainedUntil: _retained,
      endsAt: _endsAt,
      ...rest
    } = subscription;
    const updated: Subscription = { ...rest, status: "active" };
    await this.db.put(owner, "subscriptions", updated);
    await this.rooms.patch(owner, subscription.roomId, { archived: false });
    return subscriptionView(updated);
  }
  /** 설정 화면의 등급 줄: 지금 구독 중인 팀 이름들과 가장 가까운 다음 결제일. 구독이 없으면 둘 다 null. */
  async tierSummary(owner: string): Promise<{
    subscribed: boolean;
    subscription: string | null;
    nextBillingAt: string | null;
  }> {
    const active = (await this.mine(owner)).filter((s) => s.status === "active");
    if (active.length === 0) return { subscribed: false, subscription: null, nextBillingAt: null };
    const names = await Promise.all(
      active.map(async (s) => {
        const pkg = await this.db.get<TeamPackage>("system", "packages", s.packageId);
        if (pkg) return pkg.name;
        // 설정 화면 전체를 막지 않되, 없는 팀을 이름 있는 것처럼 꾸미지도 않는다
        console.error(`[osiri] 구독 ${s.id} 의 팀 ${s.packageId} 를 찾을 수 없습니다`);
        return `알 수 없는 팀(${s.packageId})`;
      }),
    );
    return {
      subscribed: true,
      subscription: names.join(" · "),
      nextBillingAt: active.map((s) => s.nextBillingAt).sort()[0] ?? null,
    };
  }
  /** 내 구독 카드 (§6.2): 팀·요금제·다음 결제일·승인 대기·진척 */
  async cards(owner: string) {
    const subs = await this.mine(owner);
    return Promise.all(
      subs.map(async (s) => {
        const pkg = await this.db.get<TeamPackage>("system", "packages", s.packageId);
        // 못 읽은 것은 빈 값으로 숨기지 않는다 — 카드에 error 로 싣고 로그를 남긴다
        const problems: string[] = [];
        if (!pkg) problems.push("팀 정보를 찾을 수 없습니다");
        let board: Awaited<ReturnType<Rooms["board"]>> | undefined;
        try {
          board = await this.rooms.board(owner, s.roomId);
        } catch (error) {
          problems.push(`현황을 불러오지 못했습니다: ${(error as Error).message}`);
        }
        if (problems.length)
          console.error(`[osiri] 구독 카드 불완전 subscription=${s.id}: ${problems.join(" / ")}`);
        return {
          ...subscriptionView(s),
          packageName: pkg?.name ?? "",
          character: pkg?.character ?? "",
          pendingApprovals: board?.pendingApprovals ?? 0,
          progress: board?.progress ?? 0,
          ...(problems.length ? { error: problems.join(" / ") } : {}),
        };
      }),
    );
  }
}

/** S6 스토어·구독 라우트 + 관리자 설정. /api 아래, 인증 뒤. */
export function storeRoutes(catalog: Catalog, accounts: Accounts) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/store/packages", async (c) =>
    c.json(
      await catalog.packages(
        {
          q: c.req.query("q"),
          // "전체" 는 값이 아니라 필터 없음 — category 를 보내지 않는다
          category: z
            .enum(STORE_CATEGORY_IDS)
            .optional()
            .parse(c.req.query("category") || undefined),
          sort: c.req.query("sort") as "performance" | "price" | "newest" | undefined,
        },
        c.get("owner"),
      ),
    ),
  );
  app.get("/store/packages/:slug", async (c) =>
    c.json(
      await catalog.packageView(await catalog.packageBySlug(c.req.param("slug")), c.get("owner")),
    ),
  );
  app.post("/subscriptions", async (c) => {
    const body = z
      .object({ packageId: z.string().min(1), restore: z.boolean().optional() })
      .parse(await c.req.json());
    const owner = c.get("owner");
    try {
      return c.json(
        await catalog.subscribe(owner, body.packageId, {
          restore: body.restore,
          tier: (await accounts.userById(owner))?.tier,
        }),
      );
    } catch (error) {
      // 종류가 붙은 실패(등급 미달)는 본문에 kind 를 싣는다 — 공용 오류 처리기는 error 문장만 낸다
      if (error instanceof KindError)
        return c.json({ error: error.message, kind: error.kind }, error.status);
      throw error;
    }
  });
  app.get("/subscriptions/mine", async (c) => c.json(await catalog.cards(c.get("owner"))));
  app.post("/subscriptions/:id/cancel", async (c) =>
    c.json(await catalog.cancel(c.get("owner"), c.req.param("id"))),
  );
  app.post("/subscriptions/:id/resume", async (c) =>
    c.json(await catalog.resume(c.get("owner"), c.req.param("id"))),
  );

  const admin = async (owner: string) => accounts.requireRole(owner, "admin");
  app.get("/admin/settings", async (c) => {
    await admin(c.get("owner"));
    return c.json({ settings: await catalog.settings(), marketFeeRate: MARKET_FEE_RATE });
  });
  app.patch("/admin/settings", async (c) => {
    await admin(c.get("owner"));
    const body = z
      .object({ key: z.string().min(1).max(80), value: z.unknown() })
      .parse(await c.req.json());
    await catalog.setSetting(body.key, body.value);
    return c.json({ ok: true });
  });
  app.post("/admin/packages", async (c) => {
    await admin(c.get("owner"));
    const body = z
      .object({
        slug: z.string().regex(/^[a-z0-9-]+$/),
        name: z.string().min(1).max(60),
        character: z.string().min(1).max(40),
        category: z.enum(STORE_CATEGORY_IDS),
        summary: z.string().max(500),
        roles: z.array(
          z.object({ name: z.string(), title: z.string(), summary: z.string().max(200) }),
        ),
        approvalPoints: z.array(z.string()),
        verified: z.boolean().default(false),
        metrics: z
          .object({ published: z.number(), indexed: z.number(), ai_citations: z.number() })
          .default({ published: 0, indexed: 0, ai_citations: 0 }),
        operatorNotice: z.string().max(500).optional(),
        reviewing: z.boolean().optional(),
        dataHandling: z.string().min(1).max(500).optional(),
        requiredTier: z.enum(ACCOUNT_TIERS).optional(),
        runtime: z.object({ teamYaml: z.string(), image: z.string() }),
      })
      .parse(await c.req.json());
    const pkg = await catalog.upsertPackage({ ...body, reportCadence: "weekly" });
    return c.json(publicPackage(pkg, await catalog.price(pkg)));
  });
  return app;
}
