// 0Siri 모델 라우팅(티어 0~4)·사용량·절감액·BYOK (0SIRI-SPEC §11, §12, §13, §22-9).
//  - 분류는 규칙만 쓴다. 분류에 LLM 을 부르지 않는다 (§11.1, §12).
//  - 티어 0·1 은 기기에서 돈다. 서버는 기기가 보고한 사용량을 적재하고, 기기 실패는 티어 2 로 받아 "서버에서 답함" 으로 표시한다 (마스터 결정 2026-10-09).
//  - 절감액 기준선("전부 최고 모델")은 여기 한 곳에서만 계산한다. 단가가 설정되기 전에는 "측정 중" 으로만 낸다.
//  - BYOK 키는 암호화 저장, 응답에는 끝 4자리만. OAuth 연결은 BYOK_OAUTH_ENABLED=true 일 때만.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  ANSWER_MODES,
  ANSWER_SOURCE_LABELS,
  type AnswerMode,
  type AnswerSource,
  CAP_REACHED_NOTICE,
  CAP_WARN_NEAR_PERCENT,
  CAP_WARN_REACHED_PERCENT,
  type CapWarnLevel,
  CHARACTER_INTENSITIES,
  type CharacterPrefs,
  DEFAULT_CHARACTER_PREFS,
  DEFAULT_NOTIFICATION_PREFS,
  DEVICE_FALLBACK_REASON,
  FIXED_TIERS,
  type FixedTier,
  MODEL_KEY_PROVIDERS,
  MODEL_KEY_REMOVED_NOTICE,
  MODEL_PROVIDERS,
  type ModelKeyErrorKind,
  type ModelKeyProvider,
  type ModelProvider,
  type ModelTier,
  type NotificationPrefs,
  PERSONAL_TIER_LABEL,
  ROUTE_KINDS,
  type RouteKind,
  TEAM_TIER_LABEL,
} from "../../../../packages/domain/src/osiri.ts";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { KindError } from "./accounts.ts";
import type { Room, Rooms } from "./rooms.ts";
import type { Catalog } from "./store.ts";

export type { ModelTier };
export type Provider = ModelProvider;
/**
 * 사용자 설정 한 벌 — 저장 기록은 이것 하나다(owner, "settings", "routing").
 * 라우팅이 읽는 값(답변 방식·가성비·고정·상한)과 화면 설정(알림·캐릭터)이 같은 기록에 있고, `GET /settings` 는 이 기록의 다른 모양일 뿐이다.
 */
export interface RoutingSettings {
  id: "routing";
  autoEconomy: boolean; // 가성비 자동 (기본 켬)
  fixedTier?: FixedTier; // 난이도 고정 (항상 주력 등)
  monthlyCapKrw?: number; // 월 상한. 도달 시 상향 억제 + 알림
  deviceLlmEnabled: boolean; // 티어 1 플래그 — 9단계 실측 통과 전 기본 꺼짐
  /** 답변 방식. 없으면 auto(규칙대로) */
  answerMode?: AnswerMode;
  notifications?: NotificationPrefs;
  character?: CharacterPrefs;
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
  source: "platform" | "byok" | "device" | "subscription";
  reason: string; // 라우팅 근거 (fallback_reason 포함)
  roomId?: string;
  /** 단가표에 없는 모델이 끼어 비용·기준선을 잴 수 없었던 기록. 이런 기록이 있으면 그 달 절감액은 "측정 중" */
  unpriced?: boolean;
  /** 제공자가 토큰 수를 알려주지 않았다 (tokensIn/Out 은 0 — 실제 0 이 아니다) */
  tokensUnreported?: boolean;
  /** 채팅 답변과 잇는 열쇠 — `GET /usage/answers` 가 answered_by 로 돌려준다 */
  threadId?: string;
  runId?: string;
  messageIds?: string[];
  createdAt: string;
}
/** 답변 메시지에 붙는 출처 정보 */
export interface AnsweredBy {
  tier: ModelTier;
  model: string;
  source: AnswerSource;
  reason: string;
}
export interface ModelAccount {
  id: ModelKeyProvider;
  keyCiphertext: string;
  last4: string;
  validatedAt: string;
  /** compatible(OpenAI 호환 엔드포인트)일 때만 */
  baseUrl?: string;
}
/** `GET /model-keys` 의 한 줄 — 제공자마다 하나 */
export interface ModelKeyRow {
  provider: ModelKeyProvider;
  status: "active" | "none";
  last4: string | null;
  baseUrl?: string;
}
type ProbeResult =
  | { ok: true }
  | { ok: false; reason: "network"; message: string }
  | { ok: false; reason: "auth" | "limit" | "status"; status: number };
export interface RouteInput {
  text: string;
  needsTools?: boolean; // 도구 호출·외부 발행 → 무조건 서버
  longTask?: boolean;
  deviceFailed?: boolean; // 기기 모델이 실패해 서버로 넘어옴
  kind?: RouteKind;
  /** 요청이 이미 서버에 도착했다 — 기기(티어 1)로 돌려보내지 않는다 */
  serverOnly?: boolean;
  /** 본인 모델 계정으로 나간다 — 플랫폼 월 상한에서 빠진다 (§13) */
  byok?: boolean;
}
export interface RouteDecision {
  tier: ModelTier;
  model: string;
  reason: string;
  servedBy: "device" | "server";
  badge: "기기에서 답함" | "서버에서 답함";
  capped: boolean;
  /** 이 티어의 모델 환경변수(MODEL_TIERn)가 없어 기본 MODEL 을 썼다 */
  defaultModelUsed?: boolean;
}
/** 채팅 한 번의 실행 계획: 어떤 모델을 누구 키로 부를지 */
export interface ChatRoute {
  decision: RouteDecision;
  model: string;
  source: "platform" | "byok";
  /** BYOK 일 때만. 실행 시점에만 쓰고 로그·응답에 남기지 않는다 */
  apiKey?: string;
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
const tierEnvName = (tier: FixedTier) => `MODEL_TIER${tier}`;
/** `GET /admin/models` 응답 — 관리자 화면이 이 타입을 가져다 쓴다 */
export const modelsView = (env = process.env) => ({
  tiers: tierModels(env),
  unset: FIXED_TIERS.filter((t) => !env[tierEnvName(t)]).map(tierEnvName),
});
export type ModelsView = ReturnType<typeof modelsView>;
/** "provider/model" 문자열의 제공자 → BYOK 계정 종류. 모르는 제공자면 undefined. */
export function modelProvider(spec: string): Provider | undefined {
  const provider = spec
    .trim()
    .match(/^([^/:]*)[/:]/)?.[1]
    ?.toLowerCase();
  if (provider === "gemini" || provider === "google-gemini") return "google";
  return MODEL_PROVIDERS.find((p) => p === provider);
}
/** "provider/model" 의 모델 ID — 게이트웨이에 보내는 이름(채팅 엔진 adapter 와 같은 규칙). 접두가 없으면 그대로 */
export const modelId = (spec: string) => spec.trim().replace(/^[^/:]*[/:]/, "");
// 단가 없는 모델은 모델마다 한 번만 알린다 (호출마다 찍으면 로그가 묻힌다)
const warnedUnpriced = new Set<string>();
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
    // BYOK 는 본인 계정 지출이라 플랫폼 상한에서 빠진다 (§13)
    const capped =
      !input.byok &&
      settings.monthlyCapKrw !== undefined &&
      usage.costKrw >= settings.monthlyCapKrw;
    const decide = (tier: FixedTier, reason: string): RouteDecision => {
      let final = tier;
      let why = reason;
      // 가성비 자동이 꺼져 있으면 규칙으로 올리고 내리지 않는다 — 주력(티어 3)으로 고정
      if (!settings.autoEconomy) {
        final = 3;
        why = "가성비 자동 꺼짐: 주력 모델";
      }
      if (settings.fixedTier && !capped) {
        final = settings.fixedTier;
        why = `고정 티어 ${settings.fixedTier}`;
      }
      if (capped && final > 2) {
        final = 2;
        why = `${reason} → 월 상한 도달로 상향 억제`;
      }
      // 상한을 걸어 뒀는데 단가 없는 사용분이 있으면 지출을 다 잰 것이 아니다 — 근거에 밝힌다
      if (!input.byok && settings.monthlyCapKrw !== undefined && usage.unpricedCalls > 0)
        why += ` · 단가 미설정 사용 ${usage.unpricedCalls}건은 상한 계산에 빠져 있음`;
      // 티어 모델이 따로 설정되지 않았으면 지어내지 않고 기본 MODEL 을 쓰고, 그 사실을 근거에 남긴다
      const defaultModelUsed = !this.env[tierEnvName(final)];
      if (defaultModelUsed) why += ` · ${tierEnvName(final)} 미설정 → 기본 모델`;
      return {
        tier: final,
        model: models[final],
        reason: why,
        servedBy: "server",
        badge: ANSWER_SOURCE_LABELS.server,
        capped,
        ...(defaultModelUsed ? { defaultModelUsed } : {}),
      };
    };
    const onDevice = (reason: string): RouteDecision => ({
      tier: 1,
      model: "device",
      reason,
      servedBy: "device",
      badge: ANSWER_SOURCE_LABELS.device,
      capped,
    });
    // 답변 방식(설정 화면): auto = 아래 규칙대로 · device = 대화는 기기에서 · server = 기기로 보내지 않는다
    const mode = settings.answerMode ?? "auto";
    if (input.deviceFailed) return decide(2, DEVICE_FALLBACK_REASON);
    if (input.needsTools) return decide(3, "도구 호출·외부 행위는 서버");
    if (input.longTask) return decide(3, "긴 작업은 서버");
    const kind = input.kind ?? "chat";
    if (kind === "strategy" || kind === "review") return decide(4, `${kind}: 최고 모델`);
    if (kind === "draft") return decide(3, "초안: 주력 모델");
    if (kind === "monitor" || kind === "report") return decide(2, `${kind}: 경량 모델`);
    // 사용자가 «항상 기기» 를 골랐다 — 도구·긴 작업·팀 업무가 아닌 대화는 길이·난이도와 무관하게 기기로
    if (mode === "device" && !input.serverOnly) return onDevice("답변 방식: 항상 기기");
    const short = input.text.trim().length <= 40 && !/\n/.test(input.text);
    if (short && !HARD.test(input.text)) {
      if (mode === "auto" && settings.deviceLlmEnabled && !input.serverOnly)
        return onDevice("사소한 대화: 기기 LLM");
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
    // 단가가 없으면 0원으로 "측정됨" 이 되지 않게 표시한다 — month() 가 "측정 중" 으로 낸다
    const missing = [
      ...(entry.source === "platform" && entry.costKrw === undefined && !prices[entry.model]
        ? [entry.model]
        : []),
      ...(prices[top] ? [] : [top]),
    ];
    for (const model of missing)
      if (!warnedUnpriced.has(model)) {
        warnedUnpriced.add(model);
        console.warn(
          `[osiri] 모델 "${model || "(최고 모델 미설정: MODEL_TIER4·MODEL)"}" 의 단가가 MODEL_PRICES_KRW 에 없습니다 — 이 모델 사용분은 비용 0 으로 적재되고 절감액은 "측정 중", 월 상한 계산에서도 빠집니다`,
        );
      }
    const usage: UsageEntry = {
      ...entry,
      id: randomUUID(),
      costKrw: entry.source === "platform" ? (entry.costKrw ?? cost(entry.model)) : 0,
      baselineKrw: cost(top),
      ...(missing.length ? { unpriced: true } : {}),
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
          title: CAP_REACHED_NOTICE,
        });
    }
    return usage;
  }
  async month(owner: string, month = monthKey(new Date().toISOString())) {
    const entries = (await this.db.list<UsageEntry>(owner, "usage")).filter(
      (u) => monthKey(u.createdAt) === month,
    );
    const sum = (f: (u: UsageEntry) => number) => entries.reduce((s, u) => s + f(u), 0);
    const prices = priceTable(this.env);
    const pricesConfigured = Object.keys(prices).length > 0;
    // 적재 때 표시가 없던 옛 기록은 지금 단가표로 판정한다
    const unpricedCalls = entries.filter(
      (u) => u.unpriced ?? (u.source === "platform" && !prices[u.model]),
    ).length;
    const measured = pricesConfigured && unpricedCalls === 0;
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
      savedKrw: measured ? sum((u) => u.baselineKrw - u.costKrw) : null,
      savingsStatus: measured ? ("measured" as const) : ("measuring" as const), // §12: 측정 전엔 "절감액(측정 중)"
      unpricedCalls,
      scriptSavedCalls: entries.filter((u) => u.scriptSaved).length,
      byokCalls: entries.filter((u) => u.source === "byok").length,
      byTier,
    };
  }

  /**
   * 채팅·작업 한 번의 실행 계획. 요청은 이미 서버에 와 있으므로 서버 티어(2~4)만 고른다.
   * 모델 이름은 환경변수에서만 온다 — 티어 모델도 기본 MODEL 도 없으면 지어내지 않고 실패한다.
   */
  async forChat(
    owner: string,
    input: Pick<RouteInput, "text" | "needsTools" | "longTask" | "kind" | "deviceFailed">,
    defaultModel?: string,
  ): Promise<ChatRoute> {
    const plan = async (byok: boolean) => {
      const decision = await this.route(owner, { ...input, serverOnly: true, byok });
      // 티어 모델이 따로 없으면 서버가 실제로 쓰는 기본 모델(config.model)이 env MODEL 보다 먼저다
      const model = decision.defaultModelUsed ? defaultModel || decision.model : decision.model;
      if (!model)
        throw new AppError(
          `티어 ${decision.tier} 에 쓸 모델이 없습니다. MODEL 또는 MODEL_TIER${decision.tier} 를 설정하세요`,
          503,
        );
      const provider = modelProvider(model);
      return { decision, model, apiKey: provider ? await this.apiKey(owner, provider) : undefined };
    };
    let planned = await plan(false);
    // 본인 키가 있으면 상한 억제를 받지 않는다. 풀어서 다시 골랐을 때도 본인 키로 나가는 경우에만 바꾼다
    if (planned.apiKey && planned.decision.capped) {
      const uncapped = await plan(true);
      if (uncapped.apiKey) planned = uncapped;
    }
    // 공용 열쇠로 나가는데 월 상한에 닿았다 — 경량 모델로 몰래 이어 가지 않고 멈춘다. 본인 키(BYOK)는 위에서 이미 빠졌다
    if (!planned.apiKey && planned.decision.capped) throw new AppError(CAP_REACHED_NOTICE, 402);
    return {
      decision: planned.decision,
      model: planned.model,
      source: planned.apiKey ? "byok" : "platform",
      ...(planned.apiKey ? { apiKey: planned.apiKey } : {}),
    };
  }
  /** 모델 호출 뒤 사용량 적재. 토큰은 제공자가 알려준 값만 쓴다 — 못 받았으면 0 으로 적고 표시한다. */
  async recordChat(
    owner: string,
    route: ChatRoute,
    usage: { tokensIn: number; tokensOut: number; reported: boolean },
    link: { roomId?: string; threadId?: string; runId?: string; messageIds?: string[] } = {},
  ): Promise<UsageEntry> {
    if (!usage.reported)
      console.warn(
        `[osiri] 모델 "${route.model}" 이 토큰 사용량을 알려주지 않았습니다 — 0 으로 적재합니다 (run=${link.runId ?? "-"})`,
      );
    return this.record(owner, {
      tier: route.decision.tier,
      model: route.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      scriptSaved: false,
      source: route.source,
      reason: route.decision.reason,
      ...(usage.reported ? {} : { tokensUnreported: true }),
      ...link,
    });
  }
  /** 이 대화(threadId)의 답변별 출처 — 메시지 id 로 찾는다. */
  async answers(owner: string, threadId: string) {
    return (await this.db.listByField<UsageEntry>(owner, "usage", "threadId", threadId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((u) => ({
        runId: u.runId,
        messageIds: u.messageIds ?? [],
        createdAt: u.createdAt,
        answered_by: answeredBy(u),
      }));
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
  /** 제공자에게 실제로 물어 키를 검증한다 (모델 목록 조회). 아무것도 저장하지 않는다. */
  private async probeKey(
    provider: ModelKeyProvider,
    apiKey: string,
    baseUrl: string | undefined,
    fetchFn: typeof fetch,
  ): Promise<ProbeResult> {
    const bearer = { Authorization: `Bearer ${apiKey}` };
    const probe: Record<ModelKeyProvider, { url: string; headers: Record<string, string> }> = {
      openai: {
        url: `${this.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/models`,
        headers: bearer,
      },
      anthropic: {
        url: `${this.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/models`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      },
      google: {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        headers: {},
      },
      compatible: { url: `${(baseUrl ?? "").replace(/\/+$/, "")}/models`, headers: bearer },
    };
    let response: Response;
    try {
      response = await fetchFn(probe[provider].url, {
        headers: probe[provider].headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { ok: false, reason: "network", message: (error as Error).message };
    }
    if (response.status === 401 || response.status === 403)
      return { ok: false, reason: "auth", status: response.status };
    if (response.status === 429) return { ok: false, reason: "limit", status: response.status };
    if (!response.ok) return { ok: false, reason: "status", status: response.status };
    return { ok: true };
  }
  private async storeAccount(
    owner: string,
    provider: ModelKeyProvider,
    apiKey: string,
    encryptionKey: string,
    baseUrl?: string,
  ) {
    const account: ModelAccount = {
      id: provider,
      keyCiphertext: encryptSecret(apiKey, encryptionKey),
      last4: apiKey.slice(-4),
      validatedAt: new Date().toISOString(),
      ...(baseUrl ? { baseUrl } : {}),
    };
    await this.db.put(owner, "model-accounts", account);
    const { keyCiphertext: _k, ...safe } = account;
    return safe;
  }
  /** 검증 호출 → 통과해야 저장. 실패 사유는 구체적으로 (인증/한도/네트워크). */
  async connectAccount(
    owner: string,
    provider: Provider,
    apiKey: string,
    fetchFn: typeof fetch = fetch,
  ) {
    const key = this.key();
    const result = await this.probeKey(provider, apiKey, undefined, fetchFn);
    if (!result.ok) {
      if (result.reason === "network")
        throw new AppError(`네트워크 오류로 키를 검증하지 못했습니다: ${result.message}`, 502);
      if (result.reason === "auth") throw new AppError("인증 실패: 키가 올바르지 않습니다", 400);
      if (result.reason === "limit")
        throw new AppError("한도 초과: 제공자가 요청을 거부했습니다", 400);
      throw new AppError(`키 검증 실패 (${result.status})`, 400);
    }
    return this.storeAccount(owner, provider, apiKey, key);
  }
  /** `GET /model-keys` — 제공자마다 한 줄. 키가 없으면 status "none", last4 null. */
  async modelKeys(owner: string): Promise<ModelKeyRow[]> {
    const saved = await this.db.list<ModelAccount>(owner, "model-accounts");
    return MODEL_KEY_PROVIDERS.map((provider) => {
      const account = saved.find((a) => a.id === provider);
      return account
        ? {
            provider,
            status: "active" as const,
            last4: account.last4,
            ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
          }
        : { provider, status: "none" as const, last4: null };
    });
  }
  /**
   * `PUT /model-keys/:provider` — 키 교체. 형식 → 제공자 검증을 **통과한 뒤에만** 저장하므로, 실패하면 이전 키가 그대로 남는다.
   * 실패는 종류를 붙인다: format(모양이 틀림) · auth(제공자가 거절) · network(제공자에 닿지 못했거나 제공자가 판정을 주지 않음).
   */
  async replaceKey(
    owner: string,
    provider: ModelKeyProvider,
    input: { apiKey: string; baseUrl?: string },
    fetchFn: typeof fetch = fetch,
  ): Promise<ModelKeyRow> {
    const fail = (kind: ModelKeyErrorKind, message: string) =>
      new KindError<ModelKeyErrorKind>(message, 400, kind);
    const apiKey = input.apiKey.trim();
    if (apiKey.length < 8 || apiKey.length > 500 || /\s/.test(apiKey))
      throw fail("format", "키 형식이 올바르지 않습니다 (공백 없이 8~500자)");
    let baseUrl: string | undefined;
    if (provider === "compatible") {
      const raw = input.baseUrl?.trim();
      if (!raw || !URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol))
        throw fail("format", "호환 엔드포인트는 http(s) 주소(baseUrl)가 필요합니다");
      baseUrl = raw.replace(/\/+$/, "");
    } else if (input.baseUrl?.trim()) {
      throw fail("format", "baseUrl 은 호환 엔드포인트(compatible)에서만 쓸 수 있습니다");
    }
    const encryptionKey = this.key();
    const result = await this.probeKey(provider, apiKey, baseUrl, fetchFn);
    if (!result.ok) {
      if (result.reason === "auth")
        throw fail("auth", "인증 실패: 제공자가 이 키를 받아들이지 않았습니다");
      if (result.reason === "network")
        throw fail("network", `제공자에 연결하지 못해 키를 검증하지 못했습니다: ${result.message}`);
      throw fail(
        "network",
        result.reason === "limit"
          ? "제공자가 한도 초과로 응답해 키를 검증하지 못했습니다. 잠시 뒤 다시 시도하세요"
          : `제공자가 검증 요청에 ${result.status} 로 응답해 키를 확인하지 못했습니다`,
      );
    }
    const saved = await this.storeAccount(owner, provider, apiKey, encryptionKey, baseUrl);
    return {
      provider,
      status: "active",
      last4: saved.last4,
      ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
    };
  }
  /** 실행 시점에만 복호화해 주입한다. 로그·응답에 쓰지 않는다. */
  async apiKey(owner: string, provider: Provider): Promise<string | undefined> {
    const account = await this.db.get<ModelAccount>(owner, "model-accounts", provider);
    return account ? decryptSecret(account.keyCiphertext, this.key()) : undefined;
  }
  /** 키 삭제. 지운 키가 있었으면 팀 방마다(팀 방이 없으면 방 없이) 활동으로 알린다 — 그 뒤로는 공용 열쇠·월 상한이다. */
  async disconnectAccount(owner: string, provider: ModelKeyProvider) {
    const existed = await this.db.get<ModelAccount>(owner, "model-accounts", provider);
    await this.db.remove(owner, "model-accounts", provider);
    if (!existed) return;
    const teamRooms = (await this.db.list<Room>(owner, "rooms")).filter(
      (room) => room.packageId !== null && !room.archived,
    );
    for (const roomId of teamRooms.length ? teamRooms.map((room) => room.id) : [undefined])
      await this.rooms.activity(owner, {
        ...(roomId ? { roomId } : {}),
        kind: "system",
        actor: "0siri",
        title: MODEL_KEY_REMOVED_NOTICE,
        detail: provider,
      });
  }

  // ---- 설정 화면 (화면 11) — 위 settings() 기록의 다른 모양 ----
  /** `GET /billing/usage`. 잴 수 없는 값은 0 으로 꾸미지 않고 null("측정 중") 로 낸다. */
  async billing(owner: string) {
    const [settings, month, keys] = await Promise.all([
      this.settings(owner),
      this.month(owner),
      this.db.list<ModelAccount>(owner, "model-accounts"),
    ]);
    const capKrw = settings.monthlyCapKrw ?? null;
    // 단가 없는 사용분이 있으면 지출을 다 잰 것이 아니다 — 상한 대비 비율을 낼 수 없다
    const percent =
      capKrw === null || month.unpricedCalls > 0
        ? null
        : capKrw === 0
          ? 100
          : Math.min(100, Math.round((month.costKrw / capKrw) * 1000) / 10);
    // 경고 단계는 잰 지출만으로 낸다 — 단가 없는 사용분이 있어도 잰 값이 이미 문턱을 넘었으면 넘은 것이다
    const used = capKrw === null ? null : capKrw === 0 ? 100 : (month.costKrw / capKrw) * 100;
    const warn: CapWarnLevel =
      used === null || used < CAP_WARN_NEAR_PERCENT
        ? "none"
        : used < CAP_WARN_REACHED_PERCENT
          ? "near"
          : "reached";
    return {
      costKrw: month.costKrw,
      capKrw,
      percent,
      byok: keys.length > 0,
      savedKrw: month.savedKrw,
      /** 단가표에 없는 모델 사용 건수 — 비용 0 으로 적재되어 상한 계산에서 빠져 있다 */
      unpricedCalls: month.unpricedCalls,
      warn,
    };
  }
}

const settingsView = (
  settings: RoutingSettings,
  tier: Awaited<ReturnType<Catalog["tierSummary"]>>,
) => ({
  tier: {
    label: tier.subscribed ? TEAM_TIER_LABEL : PERSONAL_TIER_LABEL,
    subscription: tier.subscription,
  },
  answerMode: settings.answerMode ?? ("auto" as AnswerMode),
  autoEconomy: settings.autoEconomy,
  fixedModel: settings.fixedTier === undefined ? null : String(settings.fixedTier),
  monthlyCapKrw: settings.monthlyCapKrw ?? null,
  notifications: settings.notifications ?? DEFAULT_NOTIFICATION_PREFS,
  notificationsReady: NOTIFICATIONS_READY,
  character: settings.character ?? DEFAULT_CHARACTER_PREFS,
});
/** `GET /settings` 응답 모양 — 화면이 이 타입을 가져다 쓴다 */
export type SettingsView = ReturnType<typeof settingsView>;
const FIXED_MODELS = FIXED_TIERS.map(String);
/**
 * 알림(푸시·배지 알림)을 보내는 발송부가 아직 없다 — 알림 설정은 저장만 되고 읽는 곳이 없다.
 * 화면은 이 값이 false 면 토글을 «준비 중» 으로 보인다. 발송부가 notifications 를 읽게 되면 true 로 바꾼다.
 */
const NOTIFICATIONS_READY = false;

/**
 * S7·S11 계약 라우트: /settings · /settings/model · /billing/usage · /model-keys.
 * 저장은 전부 `Routing` 의 기록(설정 한 벌 · model-accounts)이다 — 라우팅이 읽는 바로 그 값.
 */
export function settingsRoutes(
  routing: Routing,
  catalog: Pick<Catalog, "tierSummary">,
  /** 키 검증 호출에 쓰는 fetch — 시험이 제공자 응답을 바꿔 끼운다 */
  fetchFn: typeof fetch = fetch,
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const view = async (owner: string) =>
    settingsView(await routing.settings(owner), await catalog.tierSummary(owner));
  app.get("/settings", async (c) => c.json(await view(c.get("owner"))));
  app.patch("/settings/model", async (c) => {
    const body = z
      .object({
        answerMode: z.enum(ANSWER_MODES).optional(),
        autoEconomy: z.boolean().optional(),
        fixedModel: z.enum(FIXED_MODELS).nullable().optional(),
        monthlyCapKrw: z.number().min(0).nullable().optional(),
      })
      .parse(await c.req.json());
    const patch: Partial<Omit<RoutingSettings, "id">> = {};
    if (body.answerMode !== undefined) patch.answerMode = body.answerMode;
    if (body.autoEconomy !== undefined) patch.autoEconomy = body.autoEconomy;
    if (body.fixedModel !== undefined)
      patch.fixedTier = FIXED_TIERS.find((tier) => String(tier) === body.fixedModel);
    if (body.monthlyCapKrw !== undefined) patch.monthlyCapKrw = body.monthlyCapKrw ?? undefined;
    await routing.updateSettings(c.get("owner"), patch);
    return c.json(await view(c.get("owner")));
  });
  app.patch("/settings", async (c) => {
    const body = z
      .object({
        notifications: z
          .object({ approvals: z.boolean().optional(), weeklyReport: z.boolean().optional() })
          .optional(),
        character: z
          .object({
            enabled: z.boolean().optional(),
            intensity: z.enum(CHARACTER_INTENSITIES).optional(),
          })
          .optional(),
      })
      .parse(await c.req.json());
    const current = await routing.settings(c.get("owner"));
    const patch: Partial<Omit<RoutingSettings, "id">> = {};
    // 일부만 보내도 된다 — 보내지 않은 항목은 지금 값을 지킨다
    if (body.notifications)
      patch.notifications = {
        ...(current.notifications ?? DEFAULT_NOTIFICATION_PREFS),
        ...definedOnly(body.notifications),
      };
    if (body.character)
      patch.character = {
        ...(current.character ?? DEFAULT_CHARACTER_PREFS),
        ...definedOnly(body.character),
      };
    await routing.updateSettings(c.get("owner"), patch);
    return c.json(await view(c.get("owner")));
  });
  app.get("/billing/usage", async (c) => c.json(await routing.billing(c.get("owner"))));

  const providerSchema = z.enum(MODEL_KEY_PROVIDERS);
  app.get("/model-keys", async (c) => c.json(await routing.modelKeys(c.get("owner"))));
  app.put("/model-keys/:provider", async (c) => {
    const provider = providerSchema.parse(c.req.param("provider"));
    try {
      const body = z
        .object({ apiKey: z.string(), baseUrl: z.string().max(500).optional() })
        .parse(await c.req.json());
      return c.json(await routing.replaceKey(c.get("owner"), provider, body, fetchFn));
    } catch (error) {
      // 종류가 붙은 실패는 본문에 kind 를 싣는다 — 공용 오류 처리기는 error 문장만 낸다
      if (error instanceof KindError)
        return c.json({ error: error.message, kind: error.kind }, error.status);
      if (error instanceof z.ZodError)
        return c.json(
          { error: "키 형식이 올바르지 않습니다", kind: "format" satisfies ModelKeyErrorKind },
          400,
        );
      throw error;
    }
  });
  app.delete("/model-keys/:provider", async (c) => {
    await routing.disconnectAccount(c.get("owner"), providerSchema.parse(c.req.param("provider")));
    return c.json({ ok: true });
  });
  return app;
}
/** undefined 인 키를 뺀다 — 펼쳐 덮을 때 지금 값을 undefined 로 지우지 않게 */
const definedOnly = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

const SOURCE_OF: Record<UsageEntry["source"], AnswerSource> = {
  platform: "server",
  byok: "byok",
  device: "device",
  subscription: "subscription",
};
export const answeredBy = (
  u: Pick<UsageEntry, "tier" | "model" | "source" | "reason">,
): AnsweredBy => ({ tier: u.tier, model: u.model, source: SOURCE_OF[u.source], reason: u.reason });

/** S7·S11 라우트: /connections/model-account, /usage, /settings/routing, /route */
export function routingRoutes(routing: Routing, env: NodeJS.ProcessEnv = process.env) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const providerSchema = z.enum(MODEL_PROVIDERS);
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
  // 답변 메시지별 출처(answered_by). 채팅 기록은 클라이언트가 저장하므로 메시지 id 로 여기서 찾는다
  app.get("/usage/answers", async (c) => {
    const threadId = c.req.query("threadId");
    if (!threadId) throw new AppError("threadId 가 필요합니다", 422);
    return c.json(await routing.answers(c.get("owner"), threadId));
  });
  app.get("/settings/routing", async (c) => c.json(await routing.settings(c.get("owner"))));
  app.patch("/settings/routing", async (c) => {
    const body = z
      .object({
        autoEconomy: z.boolean().optional(),
        fixedTier: z
          .literal([...FIXED_TIERS])
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
        kind: z.enum(ROUTE_KINDS).optional(),
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
