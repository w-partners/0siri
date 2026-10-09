// 0Siri 모델 라우팅(티어 0~4)·사용량·절감액·BYOK (0SIRI-SPEC §11, §12, §13, §22-9).
//  - 분류는 규칙만 쓴다. 분류에 LLM 을 부르지 않는다 (§11.1, §12).
//  - 티어 0·1 은 기기에서 돈다. 서버는 기기가 보고한 사용량을 적재하고, 기기 실패는 티어 2 로 받아 "서버에서 답함" 으로 표시한다 (마스터 결정 2026-10-09).
//  - 절감액 기준선("전부 최고 모델")은 여기 한 곳에서만 계산한다. 단가가 설정되기 전에는 "측정 중" 으로만 낸다.
//  - BYOK 키는 암호화 저장, 응답에는 끝 4자리만. OAuth 연결은 BYOK_OAUTH_ENABLED=true 일 때만.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Rooms } from "./rooms.ts";

export type ModelTier = 0 | 1 | 2 | 3 | 4;
export type Provider = "openai" | "anthropic" | "google";
export interface RoutingSettings {
  id: "routing";
  autoEconomy: boolean; // 가성비 자동 (기본 켬)
  fixedTier?: 2 | 3 | 4; // 난이도 고정 (항상 주력 등)
  monthlyCapKrw?: number; // 월 상한. 도달 시 상향 억제 + 알림
  deviceLlmEnabled: boolean; // 티어 1 플래그 — 9단계 실측 통과 전 기본 꺼짐
}
export interface UsageEntry {
  id: string;
  tier: ModelTier;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costKrw: number; // 실제 지출 (BYOK 면 0 — 본인 계정으로 나간다)
  baselineKrw: number; // 같은 토큰을 최고 모델로 돌렸을 때
  scriptSaved: boolean; // 스크립트가 LLM 호출을 대신했는가 (§12)
  source: "platform" | "byok" | "device";
  reason: string; // 라우팅 근거 (fallback_reason 포함)
  roomId?: string;
  createdAt: string;
}
export interface ModelAccount {
  id: Provider;
  keyCiphertext: string;
  last4: string;
  validatedAt: string;
}
export interface RouteInput {
  text: string;
  needsTools?: boolean; // 도구 호출·외부 발행 → 무조건 서버
  longTask?: boolean;
  deviceFailed?: boolean; // 기기 모델이 실패해 서버로 넘어옴
  kind?: "chat" | "monitor" | "draft" | "review" | "report" | "strategy";
}
export interface RouteDecision {
  tier: ModelTier;
  model: string;
  reason: string;
  servedBy: "device" | "server";
  badge: "기기에서 답함" | "서버에서 답함";
  capped: boolean;
}

const DEFAULT_SETTINGS: RoutingSettings = {
  id: "routing",
  autoEconomy: true,
  deviceLlmEnabled: false,
};
/** 티어별 모델은 환경변수로만 정한다 (코드에 모델명 상수 금지). 없으면 MODEL 로 통일. */
export function tierModels(env = process.env) {
  const base = env.MODEL ?? "";
  return { 2: env.MODEL_TIER2 ?? base, 3: env.MODEL_TIER3 ?? base, 4: env.MODEL_TIER4 ?? base };
}
/** 단가표(원/1M 토큰) — MODEL_PRICES_KRW='{"openai/gpt-5.5":{"in":2500,"out":10000}}'. 없으면 절감액은 "측정 중". */
export function priceTable(env = process.env): Record<string, { in: number; out: number }> {
  try {
    return env.MODEL_PRICES_KRW ? JSON.parse(env.MODEL_PRICES_KRW) : {};
  } catch {
    throw new Error("MODEL_PRICES_KRW 가 JSON 이 아닙니다");
  }
}
const HARD = /전략|판단|비교 분석|왜|근거|법적|쟁점|리스크|계약|소송|판례|세금|절세|설계|검토해/;
const monthKey = (iso: string) => iso.slice(0, 7);

export class Routing {
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async settings(owner: string): Promise<RoutingSettings> {
    return (await this.db.get<RoutingSettings>(owner, "settings", "routing")) ?? DEFAULT_SETTINGS;
  }
  async updateSettings(owner: string, patch: Partial<Omit<RoutingSettings, "id">>) {
    const next = { ...(await this.settings(owner)), ...patch, id: "routing" as const };
    await this.db.put(owner, "settings", next);
    return next;
  }

  /** 규칙 기반 배정 (§11.1). 티어 0 은 호출자가 이미 돌렸다는 전제(후보 고르기). */
  async route(owner: string, input: RouteInput): Promise<RouteDecision> {
    const settings = await this.settings(owner);
    const models = tierModels(this.env);
    const usage = await this.month(owner);
    const capped = settings.monthlyCapKrw !== undefined && usage.costKrw >= settings.monthlyCapKrw;
    const decide = (tier: 2 | 3 | 4, reason: string): RouteDecision => {
      let final = tier;
      let why = reason;
      if (settings.fixedTier && !capped) {
        final = settings.fixedTier;
        why = `고정 티어 ${settings.fixedTier}`;
      }
      if (capped && final > 2) {
        final = 2;
        why = `${reason} → 월 상한 도달로 상향 억제`;
      }
      return {
        tier: final,
        model: models[final],
        reason: why,
        servedBy: "server",
        badge: "서버에서 답함",
        capped,
      };
    };
    if (input.deviceFailed) return decide(2, "fallback_reason=device_model_failed");
    if (input.needsTools) return decide(3, "도구 호출·외부 행위는 서버");
    if (input.longTask) return decide(3, "긴 작업은 서버");
    const kind = input.kind ?? "chat";
    if (kind === "strategy" || kind === "review") return decide(4, `${kind}: 최고 모델`);
    if (kind === "draft") return decide(3, "초안: 주력 모델");
    if (kind === "monitor" || kind === "report") return decide(2, `${kind}: 경량 모델`);
    const short = input.text.trim().length <= 40 && !/\n/.test(input.text);
    if (short && !HARD.test(input.text)) {
      if (settings.deviceLlmEnabled)
        return {
          tier: 1,
          model: "device",
          reason: "사소한 대화: 기기 LLM",
          servedBy: "device",
          badge: "기기에서 답함",
          capped,
        };
      return decide(2, "사소한 대화: 경량 모델");
    }
    if (HARD.test(input.text) || input.text.length > 600)
      return decide(4, "어려운 추론: 최고 모델");
    return decide(3, "일반 질문: 주력 모델");
  }

  /** 사용 기록 — 기준선·절감은 여기서만 계산한다. */
  async record(
    owner: string,
    entry: Omit<UsageEntry, "id" | "createdAt" | "costKrw" | "baselineKrw"> & { costKrw?: number },
  ): Promise<UsageEntry> {
    const prices = priceTable(this.env);
    const top = tierModels(this.env)[4];
    const cost = (model: string) => {
      const p = prices[model];
      return p ? (entry.tokensIn * p.in + entry.tokensOut * p.out) / 1_000_000 : 0;
    };
    const usage: UsageEntry = {
      ...entry,
      id: randomUUID(),
      costKrw: entry.source === "platform" ? (entry.costKrw ?? cost(entry.model)) : 0,
      baselineKrw: cost(top),
      createdAt: new Date().toISOString(),
    };
    await this.db.put(owner, "usage", usage);
    const settings = await this.settings(owner);
    if (settings.monthlyCapKrw !== undefined) {
      const month = await this.month(owner);
      // 상한을 이번 기록으로 넘겼을 때 한 번만 알린다
      if (
        month.costKrw >= settings.monthlyCapKrw &&
        month.costKrw - usage.costKrw < settings.monthlyCapKrw
      )
        await this.rooms.activity(owner, {
          roomId: entry.roomId ?? "",
          kind: "system",
          actor: "0siri",
          title: "월 사용 상한에 도달했습니다. 이번 달은 경량 모델로만 답합니다",
        });
    }
    return usage;
  }
  async month(owner: string, month = monthKey(new Date().toISOString())) {
    const entries = (await this.db.list<UsageEntry>(owner, "usage")).filter(
      (u) => monthKey(u.createdAt) === month,
    );
    const sum = (f: (u: UsageEntry) => number) => entries.reduce((s, u) => s + f(u), 0);
    const pricesConfigured = Object.keys(priceTable(this.env)).length > 0;
    const byTier = [0, 1, 2, 3, 4].map((tier) => ({
      tier: tier as ModelTier,
      calls: entries.filter((u) => u.tier === tier).length,
      tokens: sum((u) => (u.tier === tier ? u.tokensIn + u.tokensOut : 0)),
    }));
    return {
      month,
      calls: entries.length,
      tokensIn: sum((u) => u.tokensIn),
      tokensOut: sum((u) => u.tokensOut),
      costKrw: sum((u) => u.costKrw),
      baselineKrw: sum((u) => u.baselineKrw),
      savedKrw: pricesConfigured ? sum((u) => u.baselineKrw - u.costKrw) : null,
      savingsStatus: pricesConfigured ? ("measured" as const) : ("measuring" as const), // §12: 측정 전엔 "절감액(측정 중)"
      scriptSavedCalls: entries.filter((u) => u.scriptSaved).length,
      byokCalls: entries.filter((u) => u.source === "byok").length,
      byTier,
    };
  }

  // ---- BYOK (§13) ----
  private key(): string {
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    if (!key)
      throw new AppError("서버에 TOKEN_ENCRYPTION_KEY 가 없어 모델 계정을 저장할 수 없습니다", 503);
    return key;
  }
  async accounts(owner: string) {
    return (await this.db.list<ModelAccount>(owner, "model-accounts")).map(
      ({ keyCiphertext: _k, ...a }) => a,
    );
  }
  /** 검증 호출 → 통과해야 저장. 실패 사유는 구체적으로 (인증/한도/네트워크). */
  async connectAccount(
    owner: string,
    provider: Provider,
    apiKey: string,
    fetchFn: typeof fetch = fetch,
  ) {
    const key = this.key();
    const probe: Record<Provider, { url: string; headers: Record<string, string> }> = {
      openai: {
        url: `${this.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      anthropic: {
        url: `${this.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/models`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      },
      google: {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        headers: {},
      },
    };
    let response: Response;
    try {
      response = await fetchFn(probe[provider].url, {
        headers: probe[provider].headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError(
        `네트워크 오류로 키를 검증하지 못했습니다: ${(error as Error).message}`,
        502,
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new AppError("인증 실패: 키가 올바르지 않습니다", 400);
    if (response.status === 429) throw new AppError("한도 초과: 제공자가 요청을 거부했습니다", 400);
    if (!response.ok) throw new AppError(`키 검증 실패 (${response.status})`, 400);
    const account: ModelAccount = {
      id: provider,
      keyCiphertext: encryptSecret(apiKey, key),
      last4: apiKey.slice(-4),
      validatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, "model-accounts", account);
    const { keyCiphertext: _k, ...safe } = account;
    return safe;
  }
  /** 실행 시점에만 복호화해 주입한다. 로그·응답에 쓰지 않는다. */
  async apiKey(owner: string, provider: Provider): Promise<string | undefined> {
    const account = await this.db.get<ModelAccount>(owner, "model-accounts", provider);
    return account ? decryptSecret(account.keyCiphertext, this.key()) : undefined;
  }
  async disconnectAccount(owner: string, provider: Provider) {
    await this.db.remove(owner, "model-accounts", provider);
  }
}

/** S7·S11 라우트: /connections/model-account, /usage, /settings/routing, /route */
export function routingRoutes(routing: Routing, env: NodeJS.ProcessEnv = process.env) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const providerSchema = z.enum(["openai", "anthropic", "google"]);
  app.get("/connections/model-account", async (c) =>
    c.json(await routing.accounts(c.get("owner"))),
  );
  app.post("/connections/model-account", async (c) => {
    const body = z
      .object({ provider: providerSchema, apiKey: z.string().min(8).max(500) })
      .parse(await c.req.json());
    return c.json(await routing.connectAccount(c.get("owner"), body.provider, body.apiKey));
  });
  app.delete("/connections/model-account/:provider", async (c) => {
    await routing.disconnectAccount(c.get("owner"), providerSchema.parse(c.req.param("provider")));
    return c.json({ ok: true });
  });
  app.post("/connections/model-account/oauth", async () => {
    if (env.BYOK_OAUTH_ENABLED !== "true")
      throw new AppError("구독 OAuth 연결은 아직 열려 있지 않습니다", 403);
    throw new AppError("구독 OAuth 연결은 제공자 공식 지원 후 구현됩니다", 503);
  });
  app.get("/usage", async (c) => c.json(await routing.month(c.get("owner"), c.req.query("month"))));
  app.get("/settings/routing", async (c) => c.json(await routing.settings(c.get("owner"))));
  app.patch("/settings/routing", async (c) => {
    const body = z
      .object({
        autoEconomy: z.boolean().optional(),
        fixedTier: z
          .union([z.literal(2), z.literal(3), z.literal(4)])
          .nullable()
          .optional(),
        monthlyCapKrw: z.number().min(0).nullable().optional(),
        deviceLlmEnabled: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const patch: Partial<Omit<RoutingSettings, "id">> = {};
    if (body.autoEconomy !== undefined) patch.autoEconomy = body.autoEconomy;
    if (body.deviceLlmEnabled !== undefined) patch.deviceLlmEnabled = body.deviceLlmEnabled;
    if (body.fixedTier !== undefined) patch.fixedTier = body.fixedTier ?? undefined;
    if (body.monthlyCapKrw !== undefined) patch.monthlyCapKrw = body.monthlyCapKrw ?? undefined;
    return c.json(await routing.updateSettings(c.get("owner"), patch));
  });
  // 라우팅 판정 조회 (클라이언트가 기기/서버를 고를 때) + 기기 사용량 보고
  app.post("/route", async (c) => {
    const body = z
      .object({
        text: z.string().max(20000),
        needsTools: z.boolean().optional(),
        longTask: z.boolean().optional(),
        deviceFailed: z.boolean().optional(),
        kind: z.enum(["chat", "monitor", "draft", "review", "report", "strategy"]).optional(),
      })
      .parse(await c.req.json());
    return c.json(await routing.route(c.get("owner"), body));
  });
  app.post("/usage/device", async (c) => {
    const body = z
      .object({
        tier: z.union([z.literal(0), z.literal(1)]),
        model: z.string().max(100),
        tokensIn: z.number().int().min(0).default(0),
        tokensOut: z.number().int().min(0).default(0),
        reason: z.string().max(200).default("device"),
        roomId: z.string().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await routing.record(c.get("owner"), { ...body, source: "device", scriptSaved: false }),
    );
  });
  return app;
}
