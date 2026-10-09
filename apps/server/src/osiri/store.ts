// 0Siri 스토어·구독·관리자 설정 (0SIRI-SPEC §6, §18, §24).
//  - 패키지(팀) 정본은 owner="system" 의 packages. 공개 범위는 "무엇을·성과"만 — 팀 YAML·검수 규칙은 응답에서 뺀다 (§19).
//  - 가격은 코드 상수가 아니라 관리자 설정값(settings `price:<slug>`). 설정이 없으면 파일럿 무료(0).
//  - 수수료율만 상수 한 곳: MARKET_FEE_RATE.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Accounts } from "./accounts.ts";
import type { Rooms } from "./rooms.ts";

export const MARKET_FEE_RATE = 0.3; // 앱스토어 벤치마크 30% (§18 결정). 변경은 여기 한 곳.
export type Category = "legal" | "medical" | "marketing" | "other";
export interface PackageRole {
  name: string; // yaml 의 에이전트 키 (orchestrator, drafter …)
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
  reportCadence: "weekly";
  verified: boolean;
  metrics: { published: number; indexed: number; ai_citations: number };
  operatorNotice?: string;
  /** 비공개: 팀 YAML 경로·실행 이미지. 응답에 내보내지 않는다. */
  runtime: { teamYaml: string; image: string };
  createdAt: string;
}
export interface Subscription {
  id: string;
  packageId: string;
  roomId: string;
  status: "active" | "cancelled";
  priceMonthly: number; // 구독 시점 가격(원). 0 = 파일럿 무료
  startedAt: string;
  nextBillingAt: string;
  cancelledAt?: string;
  dataRetainedUntil?: string; // 해지 후 30일 (§6.2, §15.4.5)
}
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
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const publicPackage = (
  { runtime: _runtime, ...pkg }: TeamPackage,
  priceMonthly: number,
) => ({
  ...pkg,
  priceMonthly,
  roleCount: pkg.roles.length,
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
    await this.db.put<Setting>("system", "settings", {
      id: key,
      value,
      updatedAt: new Date().toISOString(),
    });
  }
  async settings() {
    return this.db.list<Setting>("system", "settings");
  }
  /** 가격: settings `price:<slug>` 없으면 파일럿 무료 */
  async price(pkg: TeamPackage): Promise<number> {
    const value = await this.setting<number>(`price:${pkg.slug}`);
    return typeof value === "number" && value >= 0 ? value : 0;
  }

  // ---- packages ----
  async upsertPackage(input: Omit<TeamPackage, "id" | "createdAt"> & { id?: string }) {
    if (input.roles.length < 3)
      throw new AppError("팀장·전문 역할 2개 이상·검수 역할이 있어야 팀입니다", 422);
    if (!input.roles.some((r) => /orchestrator|팀장/i.test(`${r.name} ${r.title}`)))
      throw new AppError("팀장(오케스트레이터) 역할이 필요합니다", 422);
    if (!input.roles.some((r) => /review|검수/i.test(`${r.name} ${r.title}`)))
      throw new AppError("검수 역할이 필요합니다", 422);
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
  async packages(
    filter: { q?: string; category?: Category; sort?: "performance" | "price" | "newest" } = {},
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
    const priced = await Promise.all(list.map(async (p) => publicPackage(p, await this.price(p))));
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
  async subscribe(
    owner: string,
    packageId: string,
  ): Promise<{ subscription: Subscription; roomId: string }> {
    const pkg = await this.packageById(packageId);
    const active = (await this.mine(owner)).find(
      (s) => s.packageId === packageId && s.status === "active",
    );
    if (active) throw new AppError("이미 구독 중인 팀입니다", 409);
    const now = Date.now();
    const room = await this.rooms.create(owner, {
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
      await this.db.remove(owner, "rooms", room.id);
      throw new AppError(`구독에 실패해 되돌렸습니다: ${(error as Error).message}`, 502);
    }
    await this.rooms.post(owner, room.id, {
      role: "system",
      kind: "text",
      text: `${pkg.name} 구독이 시작되었습니다. 팀이 준비되면 여기로 보고합니다.`,
    });
    return { subscription, roomId: room.id };
  }
  async mine(owner: string) {
    return this.db.list<Subscription>(owner, "subscriptions");
  }
  /** 해지: 방은 읽기 전용(archived)으로 남고 30일 뒤 삭제 대상 */
  async cancel(owner: string, id: string) {
    const subscription = await this.db.get<Subscription>(owner, "subscriptions", id);
    if (!subscription) throw new AppError("구독을 찾을 수 없습니다", 404);
    if (subscription.status === "cancelled") return subscription;
    const now = Date.now();
    const updated: Subscription = {
      ...subscription,
      status: "cancelled",
      cancelledAt: new Date(now).toISOString(),
      dataRetainedUntil: new Date(now + RETENTION_MS).toISOString(),
    };
    await this.db.put(owner, "subscriptions", updated);
    await this.rooms.patch(owner, subscription.roomId, { archived: true });
    return updated;
  }
  /** 내 구독 카드 (§6.2): 팀·요금제·다음 결제일·승인 대기·진척 */
  async cards(owner: string) {
    const subs = await this.mine(owner);
    return Promise.all(
      subs.map(async (s) => {
        const pkg = await this.db.get<TeamPackage>("system", "packages", s.packageId);
        const board = await this.rooms.board(owner, s.roomId).catch(() => null);
        return {
          ...s,
          packageName: pkg?.name ?? "",
          character: pkg?.character ?? "",
          pendingApprovals: board?.pendingApprovals ?? 0,
          progress: board?.progress ?? {},
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
      await catalog.packages({
        q: c.req.query("q"),
        category: c.req.query("category") as Category | undefined,
        sort: c.req.query("sort") as "performance" | "price" | "newest" | undefined,
      }),
    ),
  );
  app.get("/store/packages/:slug", async (c) => {
    const pkg = await catalog.packageBySlug(c.req.param("slug"));
    return c.json(publicPackage(pkg, await catalog.price(pkg)));
  });
  app.post("/subscriptions", async (c) => {
    const body = z.object({ packageId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await catalog.subscribe(c.get("owner"), body.packageId));
  });
  app.get("/subscriptions/mine", async (c) => c.json(await catalog.cards(c.get("owner"))));
  app.post("/subscriptions/:id/cancel", async (c) =>
    c.json(await catalog.cancel(c.get("owner"), c.req.param("id"))),
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
        category: z.enum(["legal", "medical", "marketing", "other"]),
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
        runtime: z.object({ teamYaml: z.string(), image: z.string() }),
      })
      .parse(await c.req.json());
    const pkg = await catalog.upsertPackage({ ...body, reportCadence: "weekly" });
    return c.json(publicPackage(pkg, await catalog.price(pkg)));
  });
  return app;
}
