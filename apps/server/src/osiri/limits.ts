// 등급별 사용 제한 (마스터 2026-10-11): 관리자 설정 `limits:<등급>` (모든 팀) 위에 `limits:<등급>:<팀 슬러그>` 를 덮는다.
// 값이 없으면 제한 없음 — 등급표·수치는 마스터가 나중에 정한다. 막히면 조용히 넘어가지 않고 방에 한 번 알리고 실패한다.
import { z } from "zod";
import {
  type AccountTier,
  APPROVAL_KINDS,
  type ApprovalKind,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Approval } from "./approvals.ts";
import type { Room, Rooms } from "./rooms.ts";

export const LIMITS_PREFIX = "limits:";
export const limitsSchema = z
  .object({
    /** 한 팀에서 30일 동안 올릴 수 있는 승인 요청 수 */
    approvalsPerMonth: z.number().int().min(0),
    /** 한 팀에서 30일 동안 실제로 내보낼(집행) 수 있는 수 — 발행·상담 답변 전송 등 */
    publishesPerMonth: z.number().int().min(0),
    /** 이 등급에서 쓸 수 없는 행위 종류 (발행·상담 답변 등) */
    blockedKinds: z.array(z.enum(APPROVAL_KINDS)),
    /** 이 등급에서 일하지 않는 팀 역할 (팀 YAML 의 역할 이름) */
    blockedRoles: z.array(z.string().min(1)),
  })
  .partial()
  .strict();
export type Limits = z.infer<typeof limitsSchema>;

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // ponytail: 달력 월 대신 최근 30일. 결제 주기에 맞출 때 구독 시작일 기준으로

export class UsageLimits {
  private readonly told = new Set<string>();
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly setting: (key: string) => Promise<unknown>,
    private readonly tierOf: (owner: string) => Promise<AccountTier>,
    private readonly slugOf: (packageId: string) => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  /** 그 사람·그 팀에 걸린 제한 — 등급 공통 위에 팀별 설정을 덮는다. 저장된 값이 형식에 안 맞으면 제한 없음으로 넘기지 않고 실패한다 */
  async for(owner: string, packageId: string): Promise<Limits> {
    const tier = await this.tierOf(owner);
    const keys = [
      `${LIMITS_PREFIX}${tier}`,
      `${LIMITS_PREFIX}${tier}:${await this.slugOf(packageId)}`,
    ];
    const merged: Limits = {};
    for (const key of keys) {
      const raw = await this.setting(key);
      if (raw === undefined) continue;
      const parsed = limitsSchema.safeParse(raw);
      if (!parsed.success) throw new AppError(`사용 제한 설정 ${key} 값이 올바르지 않습니다`, 500);
      Object.assign(merged, parsed.data);
    }
    return merged;
  }

  /** 승인 요청 전: 막힌 행위 종류·30일 승인 수 */
  async beforeRequest(owner: string, roomId: string, kind: ApprovalKind) {
    const scope = await this.scope(owner, roomId);
    if (!scope) return;
    const { limits, inTeam } = scope;
    if (limits.blockedKinds?.includes(kind))
      return this.deny(
        owner,
        roomId,
        `kind:${kind}`,
        "지금 등급에서는 이 팀이 이 일을 할 수 없습니다",
      );
    if (limits.approvalsPerMonth === undefined) return;
    const since = this.now() - WINDOW_MS;
    const used = inTeam.filter((a) => Date.parse(a.createdAt) >= since).length;
    if (used >= limits.approvalsPerMonth)
      return this.deny(
        owner,
        roomId,
        "approvals",
        `이번 달 승인 요청 한도(${limits.approvalsPerMonth}건)를 다 썼습니다`,
      );
  }

  /** 집행 전: 30일 집행 수 */
  async beforeConsume(owner: string, roomId: string) {
    const scope = await this.scope(owner, roomId);
    if (!scope || scope.limits.publishesPerMonth === undefined) return;
    const since = this.now() - WINDOW_MS;
    const used = scope.inTeam.filter(
      (a) => a.status === "consumed" && Date.parse(a.decidedAt ?? a.createdAt) >= since,
    ).length;
    if (used >= scope.limits.publishesPerMonth)
      return this.deny(
        owner,
        roomId,
        "publishes",
        `이번 달 내보내기 한도(${scope.limits.publishesPerMonth}건)를 다 썼습니다`,
      );
  }

  /** 팀 역할이 일하기 전 */
  async beforeRole(owner: string, roomId: string, packageId: string, role: string) {
    const limits = await this.for(owner, packageId);
    if (limits.blockedRoles?.includes(role))
      return this.deny(
        owner,
        roomId,
        `role:${role}`,
        `지금 등급에서는 «${role}» 역할을 쓸 수 없습니다`,
      );
  }

  /** 팀 방이 아니면(개인 대화방) 제한 대상이 아니다 */
  private async scope(owner: string, roomId: string) {
    const room = await this.db.get<Room>(owner, "rooms", roomId);
    if (!room?.packageId) return null;
    const limits = await this.for(owner, room.packageId);
    const teamRooms = new Set(
      (await this.db.list<Room>(owner, "rooms"))
        .filter((r) => r.packageId === room.packageId)
        .map((r) => r.id),
    );
    const inTeam = (await this.db.list<Approval>(owner, "approvals")).filter((a) =>
      teamRooms.has(a.roomId),
    );
    return { limits, inTeam };
  }

  /** 팀 루프는 tick 마다 다시 시도한다 — 같은 막힘은 방에 한 번만 알린다(서버가 다시 뜨면 한 번 더) */
  private async deny(owner: string, roomId: string, what: string, message: string): Promise<never> {
    const key = `${owner}:${roomId}:${what}`;
    if (!this.told.has(key)) {
      this.told.add(key);
      await this.rooms.post(owner, roomId, {
        role: "system",
        kind: "text",
        text: `${message}. 등급을 올리거나 관리자에게 문의하세요.`,
      });
    }
    throw new AppError(message, 429);
  }
}
