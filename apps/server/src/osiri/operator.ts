// 0Siri 운영자 콘솔 (0SIRI-SPEC §15.5, §16 · 계약 «운영자 콘솔 (화면 10)»).
//  - 운영자·관리자만, 자기 패키지만. 패키지 담당은 owner="system" 의 `package-operators`(id=packageId) 가 정본이다.
//  - 새 버전은 심사 체크리스트 9항을 전부 통과해야 카나리로 들어간다. 서버가 아직 확인할 수 없는 항목은
//    통과로 치지 않고 "자동 검증 미지원 — 수동 심사 필요" 로 탈락시킨다 (fail-closed).
//  - 지표는 구독자 방을 가로지른 집계만 낸다. 사용자가 쓴 글·방·사용자 id 는 응답에 싣지 않는다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  CANARY_ACTIONS,
  CANARY_ADVANCE_ORDER,
  CANARY_PERCENT,
  type CanaryAction,
  type CanaryStage,
  missingTeamRoles,
  OPERATOR_SKILL_DECISIONS,
  type OperatorSkillDecision,
  REJECT_REASON_LABELS,
  REVIEW_ITEM_LABELS,
  REVIEW_ITEMS,
  REVIEW_MANUAL_REASON,
  type RejectReasonKind,
  type ReviewItem,
  type VersionStatus,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Accounts } from "./accounts.ts";
import type { Approval } from "./approvals.ts";
import { httpConnector } from "./mcp.ts";
import type { Rooms } from "./rooms.ts";
import type { Skills } from "./skills.ts";
import type { Catalog, Subscription, TeamPackage } from "./store.ts";

export interface VersionSource {
  imageDigest?: string;
  mcpUrl?: string;
}
export interface ReviewResult {
  /** 화면에 그대로 내는 항목 문장 (REVIEW_ITEM_LABELS) */
  item: string;
  /** 항목 식별자 (REVIEW_ITEMS) */
  id: ReviewItem;
  pass: boolean;
  reason?: string;
}
export interface PackageVersion {
  id: string;
  packageId: string;
  version: string; // 패키지 안에서 1부터 올라가는 정수 문자열
  source: VersionSource;
  review: ReviewResult[];
  canary: { stage: CanaryStage; percent: number };
  status: VersionStatus;
  createdAt: string;
}
/** 저장 전용 필드 — 응답에는 내보내지 않는다. */
interface StoredVersion extends PackageVersion {
  submittedBy: string;
  liveAt?: string; // 전체 배포가 된 시각 — 운영 중 버전이 여럿일 때 가장 늦은 것이 현재 버전이다
}
export interface OperatorMetrics {
  approvalRate: number | null; // 0~100
  topRejectReason: string | null;
  citations: number | null;
  /** 카나리 배포 중인 버전이 올라온 뒤의 승인율이 그 전보다 낮다 — 확대 중단·롤백을 권한다. 견줄 자료가 없으면 false */
  degraded: boolean;
  /** `degraded` 의 근거: 카나리 시작 뒤 / 그 전 승인율(0~100). 결재가 없던 쪽은 null */
  canaryApprovalRate: number | null;
  previousApprovalRate: number | null;
}
interface PackageOperators {
  id: string; // packageId
  operatorIds: string[];
  updatedAt: string;
}
type OwnedPackage = Pick<TeamPackage, "id" | "name" | "character">;

/** 심사 한 항목이 볼 수 있는 사실. 서버가 실제로 확인한 것만 담는다. */
export interface ReviewContext {
  pkg: TeamPackage;
  source: VersionSource;
  /** mcpUrl 이 있을 때 tools/list 를 실제로 불러 본 결과. mcpUrl 이 없으면 null */
  mcp: { ok: true; tools: number } | { ok: false; error: string } | null;
}
export type ReviewCheck = (
  context: ReviewContext,
) => Promise<{ pass: boolean; reason?: string }> | { pass: boolean; reason?: string };
export interface OperatorOptions {
  /** 항목별 검사 교체 — 실제 재시험 장치가 생기면 여기로 끼운다. 테스트도 이것으로 통과·실패를 주입한다. */
  checks?: Partial<Record<ReviewItem, ReviewCheck>>;
  /** MCP 서버에 붙어 tools/list 를 부르고 도구 수를 돌려준다. */
  probeMcp?: (url: string) => Promise<number>;
}

const PLATFORM = "system";
const VERSION_KIND = "package-versions";
const OPERATOR_KIND = "package-operators";
const PROBE_TIMEOUT_MS = 10_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const now = () => new Date().toISOString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const manual = () => ({ pass: false, reason: REVIEW_MANUAL_REASON });
const byVersionDesc = (a: PackageVersion, b: PackageVersion) =>
  Number(b.version) - Number(a.version);

export const publicVersion = ({
  submittedBy: _submittedBy,
  liveAt: _liveAt,
  ...version
}: StoredVersion): PackageVersion => version;

/** 운영용 MCP 확인: Streamable HTTP 로 붙어 tools/list 를 부른다. 시간 안에 답이 없으면 실패다. */
export async function probeMcpTools(url: string): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${PROBE_TIMEOUT_MS / 1000}초 안에 연결되지 않았습니다`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    const client = await Promise.race([
      httpConnector({
        id: "version-review",
        name: "version-review",
        url,
        riskDefault: "external",
        createdAt: now(),
      }),
      timeout,
    ]);
    try {
      const { tools } = await client.listTools(undefined, { timeout: PROBE_TIMEOUT_MS });
      return tools.length;
    } finally {
      await client
        .close()
        .catch((error: unknown) =>
          console.error(`[osiri] 심사용 MCP 연결을 닫지 못했습니다: ${errorText(error)}`),
        );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 기본 심사 (§15.5). 서버가 지금 실제로 확인할 수 있는 것은 «탈락 사유» 뿐이다:
 *  - 검수 역할이 팀에 없다 (missingTeamRoles)
 *  - MCP 서버가 tools/list 에 답하지 않는다
 * 9항 어느 것도 «이 버전이 지킨다» 를 서버가 증명하지는 못한다 — 제출된 이미지·서버를 격리해 돌려 보는
 * 재시험 장치가 아직 없다. 그래서 탈락 사유가 없어도 통과가 아니라 수동 심사로 남긴다.
 */
export const DEFAULT_REVIEW_CHECKS: Record<ReviewItem, ReviewCheck> = {
  external_requires_token: ({ mcp }) =>
    mcp && !mcp.ok
      ? {
          pass: false,
          reason: `MCP 서버가 tools/list 에 답하지 않아 도구를 확인하지 못했습니다: ${mcp.error}`,
        }
      : manual(),
  token_bound_to_input: manual,
  audit_has_approval_id: manual,
  reviewer_rejects: ({ pkg }) => {
    const missing = missingTeamRoles(pkg.roles.map((role) => role.name));
    return missing.length
      ? { pass: false, reason: `팀 필수 역할이 없습니다: ${missing.join(", ")}` }
      : manual();
  },
  cross_user_denied: manual,
  progress_reports_on_schedule: manual,
  weekly_report_min_metrics: manual,
  no_secret_exposure: manual,
  tool_failure_audited: manual,
};

function parseSource(input: VersionSource): VersionSource {
  const imageDigest = input.imageDigest?.trim() || undefined;
  const mcpUrl = input.mcpUrl?.trim() || undefined;
  if (!imageDigest && !mcpUrl)
    throw new AppError("이미지 digest 나 MCP 서버 주소 중 하나는 있어야 합니다", 422);
  if (imageDigest && !DIGEST_PATTERN.test(imageDigest))
    throw new AppError("이미지 digest 는 sha256:<64자리 16진수> 형식이어야 합니다", 422);
  if (mcpUrl) {
    if (!URL.canParse(mcpUrl)) throw new AppError("MCP 서버 주소가 URL 형식이 아닙니다", 422);
    const url = new URL(mcpUrl);
    if (url.protocol !== "https:") throw new AppError("MCP 서버 주소는 https 여야 합니다", 422);
    // 주소에 박힌 계정·비밀번호는 저장도 응답도 하지 않는다 (§15.5 시크릿 비노출)
    if (url.username || url.password)
      throw new AppError("MCP 서버 주소에 계정·비밀번호를 넣을 수 없습니다", 422);
  }
  return { ...(imageDigest ? { imageDigest } : {}), ...(mcpUrl ? { mcpUrl } : {}) };
}

/** 스킬 발견 기준: 최근 30일, 같은 사유 3건 이상 · 2명 이상 (한 사람의 취향은 개인 기억으로 간다 — §17.4) */
const DISCOVER_WINDOW_MS = 30 * 86_400_000;
const DISCOVER_MIN_REJECTS = 3;
const DISCOVER_MIN_PEOPLE = 2;
/** 사유 종류별 «조이는» 점검 — 완화하는 문장은 없다 (§17.3) */
const TIGHTEN: Record<RejectReasonKind, string> = {
  tone: "승인을 요청하기 전에 문체·톤이 이 팀의 기준(정중함·과장 금지·전문가 어조)에 맞는지 다시 점검하고, 고친 곳을 검수 메모에 남긴다.",
  fact: "사실·수치·인용은 출처(조문·판례·공식 자료의 원문 링크)를 붙여 확인된 것만 쓴다. 확인 못 한 문장은 [확인 필요]로 표시하고 승인을 요청하지 않는다.",
  topic:
    "초안을 쓰기 전에 주제가 사용자가 정한 목표·관심 범위 안인지 확인하고, 벗어나면 쓰지 않고 목표를 먼저 묻는다.",
};

export class Operator {
  private readonly checks: Record<ReviewItem, ReviewCheck>;
  private readonly probeMcp: (url: string) => Promise<number>;
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly catalog: Catalog,
    private readonly accounts: Accounts,
    private readonly skills: Skills,
    options: OperatorOptions = {},
  ) {
    this.checks = { ...DEFAULT_REVIEW_CHECKS, ...options.checks };
    this.probeMcp = options.probeMcp ?? probeMcpTools;
  }

  // ---- 권한: 운영자·관리자만, 자기 패키지만 ----
  private async operator(userId: string) {
    const user = await this.accounts.userById(userId);
    if (!user || (user.role !== "operator" && user.role !== "admin"))
      throw new AppError("운영자 콘솔은 운영자·관리자 계정만 쓸 수 있습니다", 403);
    return user;
  }
  /** 패키지 담당 지정. 관리자가 정한다 — ponytail: 이것을 부르는 관리자 라우트는 계약에 아직 없다. */
  async assignOperator(packageId: string, userId: string): Promise<void> {
    await this.catalog.packageById(packageId);
    await this.operator(userId);
    const current = await this.db.get<PackageOperators>(PLATFORM, OPERATOR_KIND, packageId);
    await this.db.put<PackageOperators>(PLATFORM, OPERATOR_KIND, {
      id: packageId,
      operatorIds: [...new Set([...(current?.operatorIds ?? []), userId])],
      updatedAt: now(),
    });
  }
  /** 내 패키지. 관리자는 플랫폼 전체 패키지의 담당으로 본다. */
  private async owned(userId: string): Promise<OwnedPackage[]> {
    const user = await this.operator(userId);
    if (user.role === "admin") return this.catalog.packages();
    const assigned = (await this.db.list<PackageOperators>(PLATFORM, OPERATOR_KIND)).filter(
      (entry) => entry.operatorIds.includes(userId),
    );
    return Promise.all(assigned.map((entry) => this.catalog.packageById(entry.id)));
  }
  /** 자기 패키지가 아니면 403. 없는 패키지와 남의 패키지를 구분해 알려 주지 않는다. */
  private async requirePackage(userId: string, packageId: string): Promise<TeamPackage> {
    const user = await this.operator(userId);
    if (user.role !== "admin") {
      const entry = await this.db.get<PackageOperators>(PLATFORM, OPERATOR_KIND, packageId);
      if (!entry?.operatorIds.includes(userId))
        throw new AppError("내 패키지가 아닙니다. 운영자는 자기 패키지만 다룰 수 있습니다", 403);
    }
    return this.catalog.packageById(packageId);
  }

  // ---- 패키지·버전 ----
  private versionsStored(packageId: string) {
    return this.db.listByField<StoredVersion>(PLATFORM, VERSION_KIND, "packageId", packageId);
  }
  /** 운영 중(live) 버전을 최근 전체 배포 순으로. 맨 앞이 현재 버전, 그 다음이 롤백 대상. */
  private async live(packageId: string): Promise<StoredVersion[]> {
    return (await this.versionsStored(packageId))
      .filter((v) => v.status === "live")
      .sort((a, b) => (b.liveAt ?? "").localeCompare(a.liveAt ?? ""));
  }
  async packages(userId: string) {
    const owned = await this.owned(userId);
    return Promise.all(
      owned.map(async (pkg) => {
        const [live, skills] = await Promise.all([
          this.live(pkg.id),
          this.skills.packageSkills(pkg.id),
        ]);
        return {
          id: pkg.id,
          name: pkg.name,
          character: pkg.character,
          currentVersion: live[0]?.version ?? null,
          pendingSkills: skills.filter(
            (s) => s.status === "draft" || s.status === "retire_proposed",
          ).length,
        };
      }),
    );
  }
  /** 최신순. */
  async versions(userId: string, packageId: string): Promise<PackageVersion[]> {
    await this.requirePackage(userId, packageId);
    return (await this.versionsStored(packageId)).map(publicVersion).sort(byVersionDesc);
  }
  private async review(pkg: TeamPackage, source: VersionSource): Promise<ReviewResult[]> {
    let mcp: ReviewContext["mcp"] = null;
    if (source.mcpUrl) {
      try {
        mcp = { ok: true, tools: await this.probeMcp(source.mcpUrl) };
      } catch (error) {
        console.error(`[osiri] 버전 심사 MCP 확인 실패 package=${pkg.id}: ${errorText(error)}`);
        mcp = { ok: false, error: errorText(error) };
      }
    }
    const results: ReviewResult[] = [];
    for (const id of REVIEW_ITEMS) {
      let outcome: { pass: boolean; reason?: string };
      try {
        outcome = await this.checks[id]({ pkg, source, mcp });
      } catch (error) {
        // 검사 자체가 깨지면 통과가 아니라 탈락이다
        console.error(
          `[osiri] 버전 심사 검사 실패 item=${id} package=${pkg.id}: ${errorText(error)}`,
        );
        outcome = { pass: false, reason: `검사를 실행하지 못했습니다: ${errorText(error)}` };
      }
      results.push({
        item: REVIEW_ITEM_LABELS[id],
        id,
        pass: outcome.pass === true,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });
    }
    return results;
  }
  /** 제출 → 자동 심사. 하나라도 실패면 review_failed 로 남고 배포는 시작되지 않는다. */
  async submit(
    userId: string,
    input: { packageId: string } & VersionSource,
  ): Promise<PackageVersion> {
    const pkg = await this.requirePackage(userId, input.packageId);
    const source = parseSource(input);
    const review = await this.review(pkg, source);
    const passed = review.every((r) => r.pass);
    const numbers = (await this.versionsStored(pkg.id)).map((v) => Number(v.version));
    const stage: CanaryStage = passed ? CANARY_ADVANCE_ORDER[0] : "stopped";
    const version: StoredVersion = {
      id: randomUUID(),
      packageId: pkg.id,
      version: String(Math.max(0, ...numbers) + 1),
      source,
      review,
      canary: { stage, percent: CANARY_PERCENT[stage] },
      status: passed ? "canary" : "review_failed",
      createdAt: now(),
      submittedBy: userId,
    };
    await this.db.put(PLATFORM, VERSION_KIND, version);
    await this.rooms.audit(userId, {
      packageId: pkg.id,
      actor: userId,
      action: `version.submit:v${version.version}`,
      sourceRefs: [version.id],
      result: passed ? "ok" : "blocked",
    });
    return publicVersion(version);
  }
  /** 카나리: profile → partial → all(=운영 중). stop 은 그 자리에서 멈춘다. */
  async canary(userId: string, versionId: string, action: CanaryAction): Promise<PackageVersion> {
    await this.operator(userId);
    const version = await this.db.get<StoredVersion>(PLATFORM, VERSION_KIND, versionId);
    if (!version) throw new AppError("버전을 찾을 수 없습니다", 404);
    await this.requirePackage(userId, version.packageId);
    if (version.status === "review_failed")
      throw new AppError("심사를 통과하지 못한 버전은 배포할 수 없습니다", 409);
    if (version.status !== "canary")
      throw new AppError(`카나리 배포 중인 버전이 아닙니다 (현재 상태: ${version.status})`, 409);
    if (version.canary.stage === "stopped")
      throw new AppError("중단된 카나리입니다. 새 버전을 제출하세요", 409);
    let next: StoredVersion;
    if (action === "stop")
      next = { ...version, canary: { stage: "stopped", percent: CANARY_PERCENT.stopped } };
    else {
      const index = CANARY_ADVANCE_ORDER.indexOf(
        version.canary.stage as (typeof CANARY_ADVANCE_ORDER)[number],
      );
      const stage = CANARY_ADVANCE_ORDER[index + 1];
      if (index < 0 || !stage)
        throw new AppError(`더 넓힐 단계가 없습니다 (현재 단계: ${version.canary.stage})`, 409);
      const last = stage === CANARY_ADVANCE_ORDER[CANARY_ADVANCE_ORDER.length - 1];
      next = {
        ...version,
        canary: { stage, percent: CANARY_PERCENT[stage] },
        ...(last ? { status: "live" as const, liveAt: now() } : {}),
      };
    }
    // 같은 단계에서 두 번 눌러도 한 번만 반영한다
    const updated = await this.db.compareAndSwap<StoredVersion>(
      PLATFORM,
      VERSION_KIND,
      version.id,
      { status: version.status, canary: version.canary },
      { canary: next.canary, status: next.status, ...(next.liveAt ? { liveAt: next.liveAt } : {}) },
    );
    if (!updated) throw new AppError("다른 배포 조작이 먼저 반영되었습니다. 다시 확인하세요", 409);
    await this.rooms.audit(userId, {
      packageId: version.packageId,
      actor: userId,
      action: `version.canary.${action}:v${version.version}->${updated.canary.stage}`,
      sourceRefs: [version.id],
      result: "ok",
    });
    return publicVersion(updated);
  }
  /** 심사 없이 즉시, 바로 이전 운영 버전으로 (§16.2-4). */
  async rollback(userId: string, packageId: string) {
    await this.requirePackage(userId, packageId);
    const [current, previous] = await this.live(packageId);
    if (!current) throw new AppError("운영 중인 버전이 없어 롤백할 수 없습니다", 409);
    if (!previous) throw new AppError("되돌릴 이전 운영 버전이 없습니다", 409);
    const rolledBack = await this.db.compareAndSwap<StoredVersion>(
      PLATFORM,
      VERSION_KIND,
      current.id,
      { status: "live" },
      { status: "rolled_back", canary: { stage: "stopped", percent: CANARY_PERCENT.stopped } },
    );
    if (!rolledBack) throw new AppError("이미 롤백된 버전입니다. 다시 확인하세요", 409);
    await this.rooms.audit(userId, {
      packageId,
      actor: userId,
      action: `version.rollback:v${current.version}->v${previous.version}`,
      sourceRefs: [current.id, previous.id],
      result: "ok",
    });
    return { rolledBack: publicVersion(rolledBack), current: publicVersion(previous) };
  }

  // ---- 구독자 방 (집계·공지 대상) ----
  private async subscribers(packageId: string): Promise<{ owner: string; roomId: string }[]> {
    return (await this.db.scan<Subscription>("subscriptions"))
      .filter(({ value }) => value.packageId === packageId && value.status === "active")
      .map(({ owner, value }) => ({ owner, roomId: value.roomId }));
  }
  /** 집계만. 자료가 없는 값은 0 이 아니라 null 이다. */
  async metrics(userId: string, packageId: string): Promise<OperatorMetrics> {
    await this.requirePackage(userId, packageId);
    let approved = 0;
    let rejected = 0;
    let citations: number | null = null;
    const reasons = new Map<RejectReasonKind, number>();
    // 카나리 배포 중인 버전(가장 최신)이 올라온 시각으로 결재를 앞뒤로 가른다
    const canarySince = (await this.versionsStored(packageId))
      .filter((v) => v.status === "canary" && v.canary.stage !== "stopped")
      .sort(byVersionDesc)[0]?.createdAt;
    const split = { before: { approved: 0, decided: 0 }, after: { approved: 0, decided: 0 } };
    const tally = (approval: Approval, ok: boolean) => {
      if (!canarySince || !approval.decidedAt) return;
      const side = approval.decidedAt >= canarySince ? split.after : split.before;
      side.decided++;
      if (ok) side.approved++;
    };
    const rate = (side: { approved: number; decided: number }) =>
      side.decided ? Math.round((side.approved / side.decided) * 100) : null;
    for (const { owner, roomId } of await this.subscribers(packageId)) {
      const [approvals, goals] = await Promise.all([
        this.db.listByField<Approval>(owner, "approvals", "roomId", roomId),
        this.rooms.goals(owner, roomId),
      ]);
      for (const approval of approvals) {
        if (approval.status === "approved" || approval.status === "consumed") {
          approved++;
          tally(approval, true);
        } else if (approval.status === "rejected") {
          rejected++;
          tally(approval, false);
          // 사유는 종류(톤·사실·주제)로만 센다 — 사용자가 쓴 반려 문장은 운영자에게 가지 않는다
          if (approval.reasonKind)
            reasons.set(approval.reasonKind, (reasons.get(approval.reasonKind) ?? 0) + 1);
        }
      }
      for (const goal of goals) {
        const value = goal.metrics?.ai_citations;
        if (typeof value === "number") citations = (citations ?? 0) + value;
      }
    }
    const decided = approved + rejected;
    const top = [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const canaryApprovalRate = rate(split.after);
    const previousApprovalRate = rate(split.before);
    return {
      approvalRate: decided ? Math.round((approved / decided) * 100) : null,
      topRejectReason: top ? REJECT_REASON_LABELS[top[0]] : null,
      citations,
      degraded:
        canaryApprovalRate !== null &&
        previousApprovalRate !== null &&
        canaryApprovalRate < previousApprovalRate,
      canaryApprovalRate,
      previousApprovalRate,
    };
  }

  // ---- 패키지 공통 스킬 ----
  async packageSkills(userId: string, packageId: string) {
    await this.requirePackage(userId, packageId);
    return this.skills.packageSkills(packageId);
  }
  async decideSkill(
    userId: string,
    skillId: string,
    decision: OperatorSkillDecision,
    reason?: string,
  ) {
    await this.operator(userId);
    const skill = await this.skills.packageSkill(skillId);
    if (!skill.packageId) throw new AppError("패키지 공통 스킬에 패키지 정보가 없습니다", 500);
    await this.requirePackage(userId, skill.packageId);
    return this.skills.decideAsOperator(userId, skillId, decision, reason);
  }

  /**
   * 신호 → 팀 공통 스킬 초안 (§17.1 수집 → §17.2 발견·초안). 구독자 전원의 결재 반려를 사유 종류로 모아,
   * 같은 사유가 여러 사람에게서 반복되면 «검수 보강» 초안을 운영자 콘솔에 올린다. 장착은 운영자 승인 뒤에만.
   * 사용자가 쓴 반려 문장·대화·파일은 쓰지 않는다 — 종류별 건수와 사람 수만. 기준을 «조이는» 초안만 낸다(§17.3).
   */
  async discoverSkills(packageId: string, now = Date.now()): Promise<{ drafted: string[] }> {
    const since = new Date(now - DISCOVER_WINDOW_MS).toISOString();
    const tally = new Map<RejectReasonKind, { rejects: number; people: Set<string> }>();
    const subscribers = await this.subscribers(packageId);
    for (const { owner, roomId } of subscribers)
      for (const approval of await this.db.listByField<Approval>(
        owner,
        "approvals",
        "roomId",
        roomId,
      )) {
        if (approval.status !== "rejected" || !approval.reasonKind) continue;
        if ((approval.decidedAt ?? "") < since) continue;
        const entry = tally.get(approval.reasonKind) ?? { rejects: 0, people: new Set<string>() };
        entry.rejects++;
        entry.people.add(owner);
        tally.set(approval.reasonKind, entry);
      }
    const existing = await this.skills.packageSkills(packageId);
    const drafted: string[] = [];
    for (const [kind, { rejects, people }] of tally) {
      if (rejects < DISCOVER_MIN_REJECTS || people.size < DISCOVER_MIN_PEOPLE) continue;
      const name = `검수 보강: ${REJECT_REASON_LABELS[kind]}`;
      // 운영자가 이미 보고 있거나(초안) 쓰고 있거나 거절한 같은 이름이면 다시 내지 않는다 — 폐기된 것만 다시 제안
      if (existing.some((s) => s.name === name && s.status !== "retired")) continue;
      const first = subscribers[0] as { owner: string; roomId: string };
      await this.skills.draft(
        "system",
        { roomId: first.roomId, packageId },
        {
          scope: "package",
          name,
          evidence: `최근 ${DISCOVER_WINDOW_MS / 86_400_000}일 «${REJECT_REASON_LABELS[kind]}» 반려 ${rejects}건 · 구독자 ${people.size}명 (반려 문장은 모으지 않음)`,
          appliesTo: TIGHTEN[kind],
          proposedBy: "signal",
        },
      );
      drafted.push(name);
    }
    if (drafted.length)
      console.log(`[osiri] 스킬 발견 package=${packageId}: ${drafted.join(", ")}`);
    return { drafted };
  }
  /** 운영자 콘솔 «지금 찾기» — 자기 패키지만 */
  async discoverSkillsAsOperator(userId: string, packageId: string) {
    await this.requirePackage(userId, packageId);
    return this.discoverSkills(packageId);
  }
  /** 매일 모든 패키지에서 찾는다 (기동 직후 한 번 + 주기) */
  startSkillDiscovery(intervalMs = 24 * 3600_000) {
    const run = async () => {
      for (const pkg of await this.db.list<TeamPackage>("system", "packages"))
        await this.discoverSkills(pkg.id).catch((error: Error) =>
          console.error(`[osiri] 스킬 발견 실패 package=${pkg.id}: ${error.message}`),
        );
    };
    void run().catch((error: Error) => console.error(`[osiri] 스킬 발견 실패: ${error.message}`));
    const timer = setInterval(() => void run().catch(() => undefined), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ---- 공지 ----
  /** 이 패키지 구독자 방마다 시스템 메시지로 공지한다. 못 보낸 방은 숨기지 않고 수로 돌려준다. */
  async notice(userId: string, packageId: string, text: string) {
    const pkg = await this.requirePackage(userId, packageId);
    const targets = await this.subscribers(packageId);
    let delivered = 0;
    let failed = 0;
    for (const { owner, roomId } of targets) {
      try {
        await this.rooms.post(owner, roomId, {
          role: "system",
          kind: "text",
          text,
          payload: { card: "operator-notice", packageId },
        });
        await this.rooms.activity(owner, {
          roomId,
          kind: "system",
          actor: "system",
          title: `${pkg.name} 공지`,
          detail: text.slice(0, 200),
        });
        delivered++;
      } catch (error) {
        failed++;
        console.error(
          `[osiri] 공지 전달 실패 package=${packageId} room=${roomId}: ${errorText(error)}`,
        );
      }
    }
    await this.rooms.audit(userId, {
      packageId,
      actor: userId,
      action: "notice.publish",
      result: failed ? "error" : "ok",
    });
    return { subscribers: targets.length, delivered, failed };
  }
}

/** 화면 10 운영자 콘솔 라우트 — /api 아래, 사용자 인증 뒤. 권한은 Operator 가 매 호출 확인한다. */
export function operatorRoutes(operator: Operator) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const packageId = (raw: string | undefined) => {
    if (!raw) throw new AppError("package_id 가 필요합니다", 422);
    return raw;
  };
  app.get("/operator/packages", async (c) => c.json(await operator.packages(c.get("owner"))));
  app.get("/operator/versions", async (c) =>
    c.json(await operator.versions(c.get("owner"), packageId(c.req.query("package_id")))),
  );
  app.post("/operator/versions", async (c) => {
    const body = z
      .object({
        packageId: z.string().min(1),
        imageDigest: z.string().max(200).optional(),
        mcpUrl: z.string().max(2000).optional(),
      })
      .parse(await c.req.json());
    return c.json(await operator.submit(c.get("owner"), body));
  });
  app.post("/operator/versions/:id/canary", async (c) => {
    const body = z.object({ action: z.enum(CANARY_ACTIONS) }).parse(await c.req.json());
    return c.json(await operator.canary(c.get("owner"), c.req.param("id"), body.action));
  });
  app.post("/operator/rollback", async (c) => {
    const body = z.object({ packageId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await operator.rollback(c.get("owner"), body.packageId));
  });
  app.get("/operator/metrics", async (c) =>
    c.json(await operator.metrics(c.get("owner"), packageId(c.req.query("package_id")))),
  );
  app.get("/operator/skills", async (c) =>
    c.json(await operator.packageSkills(c.get("owner"), packageId(c.req.query("package_id")))),
  );
  app.post("/operator/skills/discover", async (c) => {
    const body = z.object({ packageId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await operator.discoverSkillsAsOperator(c.get("owner"), body.packageId));
  });
  app.post("/operator/skills/:id/decide", async (c) => {
    const body = z
      .object({
        decision: z.enum(OPERATOR_SKILL_DECISIONS),
        reason: z.string().max(1000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await operator.decideSkill(c.get("owner"), c.req.param("id"), body.decision, body.reason),
    );
  });
  app.post("/operator/notices", async (c) => {
    const body = z
      .object({ packageId: z.string().min(1), text: z.string().trim().min(1).max(2000) })
      .parse(await c.req.json());
    return c.json(await operator.notice(c.get("owner"), body.packageId, body.text));
  });
  return app;
}
