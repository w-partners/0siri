// 0Siri 승인 게이트 (0SIRI-SPEC §9, §15.2.3, §24-10).
//  - external 도구는 실행 전 승인 필수. 승인 상태를 확인할 수 없으면 실행하지 않는다 (fail-closed).
//  - 승인은 1회용 approval_token. 토큰은 도구명+입력 해시에 묶이며, 입력이 바뀌면 무효.
//  - 승인본은 동결(frozenHash). 법률 패키지 발행 승인은 변호사(방 소유자) 본인만 — 운영자·관리자 대리 승인 불가.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  APPROVAL_STATUS_LABELS,
  type ApprovalKind,
  type ApprovalStatus,
  PRESENCE_LABELS,
  type RejectReasonKind,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { EventBus } from "./events.ts";
import type { Rooms } from "./rooms.ts";

export type { ApprovalStatus };
export interface Approval {
  id: string;
  roomId: string;
  goalId?: string; // 이 승인을 기다리는 목표 (워커가 승인 단계에서 이어 갈 때 찾는다)
  toolName: string;
  input: unknown;
  inputHash: string; // sha256(canonical json) — 동결 해시
  title: string;
  summary: string;
  evidence?: string;
  status: ApprovalStatus;
  tokenHash?: string; // 승인 시 발급된 1회용 토큰의 해시
  tokenDelivered?: boolean; // 워커에게 토큰을 한 번 넘겼는가
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  reasonKind?: RejectReasonKind; // 반려 사유 종류 — 반려에는 반드시 있다
  /** 요청자가 밝힌 종류. 밝히지 않은 요청은 `approvalKind()` 가 정한다 */
  kind?: ApprovalKind;
  messageId?: string; // 방 타임라인의 승인 카드
  requestedBy: string; // 워커 역할명 또는 "chat"
  createdAt: string;
  expiresAt: string;
}

export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** 키 순서에 무관한 JSON 직렬화 — 같은 입력은 같은 해시. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const inputHash = (toolName: string, input: unknown) =>
  sha(`${toolName}\n${canonical(input)}`);

/** 이미 처리된 승인에 다시 결재했다 — 라우트가 409 와 함께 현재 `status` 를 돌려준다. */
export class AlreadyDecidedError extends AppError {
  constructor(public readonly approvalStatus: ApprovalStatus) {
    super(
      `이미 처리된 승인 요청입니다 (현재 상태: ${APPROVAL_STATUS_LABELS[approvalStatus]})`,
      409,
    );
  }
}
const alreadyDecided = (status: ApprovalStatus) => new AlreadyDecidedError(status);
/**
 * 승인 종류. 요청자가 밝혔으면 그 값. 밝히지 않은 승인은 "publish" 다 —
 * 승인 게이트는 밖으로 나가는(external) 도구 실행만 막고, 그것이 곧 발행 승인이기 때문이다.
 */
export const approvalKind = (approval: Pick<Approval, "kind">): ApprovalKind =>
  approval.kind ?? "publish";

export class Approvals {
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  async get(owner: string, id: string): Promise<Approval> {
    const approval = await this.db.get<Approval>(owner, "approvals", id);
    if (!approval) throw new AppError("승인 요청을 찾을 수 없습니다", 404);
    return approval;
  }
  /** 대기 중인 승인. 만료 시각이 지난 것은 여기서 만료 처리하고 목록에서 뺀다 — 결재함·배지 수가 실제와 맞도록. */
  async pending(owner: string): Promise<Approval[]> {
    return this.sweep(owner, await this.db.listByStatus<Approval>(owner, "approvals", "pending"));
  }
  /** 한 방의 대기 승인 — 결재함이 팀별로 따로 읽어 한 팀이 실패해도 나머지를 준다. 만료 처리는 `pending` 과 같다. */
  async pendingForRoom(owner: string, roomId: string): Promise<Approval[]> {
    return this.sweep(
      owner,
      (await this.db.listByField<Approval>(owner, "approvals", "roomId", roomId)).filter(
        (a) => a.status === "pending",
      ),
    );
  }
  private async sweep(owner: string, candidates: Approval[]): Promise<Approval[]> {
    const live: Approval[] = [];
    const expiredRooms = new Set<string>();
    for (const approval of candidates) {
      if (Date.parse(approval.expiresAt) > this.now()) live.push(approval);
      else if (await this.expire(owner, approval)) expiredRooms.add(approval.roomId);
    }
    for (const roomId of expiredRooms)
      if (!live.some((a) => a.roomId === roomId))
        this.bus.setPresence(owner, roomId, "idle", PRESENCE_LABELS.idle);
    return live.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** 만료 전이: 상태·카드·감사 로그·이벤트를 결재와 같은 경로로 갱신한다. 이미 다른 상태면 false. */
  private async expire(owner: string, approval: Approval): Promise<boolean> {
    const updated = await this.db.compareAndSwap<Approval>(
      owner,
      "approvals",
      approval.id,
      { status: "pending" },
      { status: "expired" },
    );
    if (!updated) return false;
    if (approval.messageId)
      await this.rooms.updateMessage(owner, approval.messageId, { payload: { status: "expired" } });
    await this.rooms.audit(owner, {
      packageId: null,
      actor: "system",
      action: `approval.expire:${approval.toolName}`,
      approvalId: approval.id,
      result: "ok",
    });
    await this.requeueGoal(owner, approval);
    this.bus.publish(owner, {
      type: "approval",
      roomId: approval.roomId,
      approvalId: approval.id,
      status: "expired",
    });
    this.bus.publish(owner, { type: "board", roomId: approval.roomId });
    this.bus.publish(owner, { type: "inbox" });
    return true;
  }
  /**
   * 만료된 승인이 붙잡고 있던 목표를 승인 단계에서 검수 뒤 단계로 되돌린다 — 워커의 다음 tick 이 다시 준비해 새 승인 카드를 낸다.
   * (워커가 만료를 직접 폴링했을 때 하는 일과 같은 값이다: 진척 60 · geo.)
   */
  private async requeueGoal(owner: string, approval: Approval) {
    if (!approval.goalId) return;
    const goal = (await this.rooms.goals(owner, approval.roomId)).find(
      (g) => g.id === approval.goalId,
    );
    if (!goal) {
      console.error(
        `[osiri] 만료된 승인 ${approval.id} 의 목표 ${approval.goalId} 를 방 ${approval.roomId} 에서 찾을 수 없어 재요청 신호를 내지 못했습니다`,
      );
      return;
    }
    if (goal.stage !== "approval" || goal.status !== "active") return;
    await this.rooms.updateGoal(owner, goal.id, { progress: 60, stage: "geo" }, "system");
    await this.rooms.activity(owner, {
      roomId: approval.roomId,
      kind: "approval",
      actor: "system",
      title: `승인 요청 만료: ${approval.title} — 팀이 다시 준비해 새 승인 카드를 올립니다`,
    });
  }

  /** 한 목표에 걸린 승인 전부(오래된 순). 만료 시각이 지난 대기 건은 먼저 만료 처리한다. */
  async forGoal(owner: string, roomId: string, goalId: string): Promise<Approval[]> {
    await this.pending(owner);
    return (await this.db.listByField<Approval>(owner, "approvals", "roomId", roomId))
      .filter((a) => a.goalId === goalId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** external 도구 실행 보류 → 승인 카드 생성 (§15.2, §21 워커 /approvals/request). 같은 도구·입력이 이미 대기 중이면 그것을 돌려준다. */
  async request(
    owner: string,
    input: {
      roomId: string;
      goalId?: string;
      toolName: string;
      input: unknown;
      title: string;
      summary: string;
      evidence?: string;
      requestedBy: string;
      kind?: ApprovalKind;
    },
  ): Promise<Approval> {
    const hash = inputHash(input.toolName, input.input);
    const duplicate = (await this.pending(owner)).find(
      (a) => a.roomId === input.roomId && a.inputHash === hash,
    );
    if (duplicate) return duplicate;
    const approval: Approval = {
      id: randomUUID(),
      roomId: input.roomId,
      goalId: input.goalId,
      toolName: input.toolName,
      input: input.input,
      inputHash: hash,
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
      status: "pending",
      requestedBy: input.requestedBy,
      ...(input.kind ? { kind: input.kind } : {}),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + APPROVAL_TTL_MS).toISOString(),
    };
    const card = await this.rooms.post(owner, input.roomId, {
      role: "assistant",
      kind: "card",
      payload: {
        card: "approval",
        approvalId: approval.id,
        status: "pending",
        title: approval.title,
        summary: approval.summary,
        evidence: approval.evidence,
        toolName: approval.toolName,
        // 카드가 그려질 때의 동결 해시 — 화면이 이 값을 decide 의 frozenHash 로 그대로 보낸다
        inputHash: approval.inputHash,
      },
    });
    approval.messageId = card.id;
    await this.db.put(owner, "approvals", approval);
    await this.rooms.activity(owner, {
      roomId: input.roomId,
      kind: "approval",
      actor: input.requestedBy,
      title: `승인 요청: ${approval.title}`,
    });
    await this.rooms.audit(owner, {
      packageId: null,
      actor: input.requestedBy,
      action: `approval.request:${approval.toolName}`,
      approvalId: approval.id,
      result: "ok",
      roomId: input.roomId,
    });
    this.bus.setPresence(owner, input.roomId, "waiting", `${approval.title} 승인 대기 중`);
    this.bus.publish(owner, {
      type: "approval",
      roomId: input.roomId,
      approvalId: approval.id,
      status: "pending",
    });
    this.bus.publish(owner, { type: "inbox" });
    return approval;
  }

  /** 승인/반려 (§9.1·9.2). 방 소유자 본인(owner)만 부를 수 있다 — 라우트가 owner 토큰으로 스코프한다. */
  async decide(
    owner: string,
    id: string,
    decision: "approve" | "reject",
    options: {
      reason?: string;
      reasonKind?: RejectReasonKind;
      decidedBy: string;
      frozenHash?: string;
    },
  ): Promise<Approval> {
    // 사유 종류는 반려에만 남긴다
    const reasonKind = decision === "reject" ? options.reasonKind : undefined;
    const approval = await this.get(owner, id);
    if (options.frozenHash && options.frozenHash !== approval.inputHash)
      throw new AppError(
        "화면에 보인 내용과 승인 대상이 다릅니다(동결 해시 불일치). 최신 승인 카드를 다시 확인하세요",
        409,
      );
    // 이미 처리된 건은 무엇을 보내든 409 (현재 상태를 알려 준다)
    if (approval.status !== "pending") throw alreadyDecided(approval.status);
    // 반려는 사유 종류(톤·사실·주제)가 있어야 팀이 무엇을 고칠지 안다 — 없으면 받지 않는다
    if (decision === "reject" && !reasonKind)
      throw new AppError("반려에는 사유 종류(reasonKind: tone·fact·topic)가 필요합니다", 400);
    if (Date.parse(approval.expiresAt) <= this.now()) {
      await this.expire(owner, approval);
      throw new AppError("승인 요청이 만료되었습니다", 409);
    }
    const token = decision === "approve" ? randomBytes(32).toString("base64url") : undefined;
    const patch: Partial<Approval> = {
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: options.decidedBy,
      decidedAt: new Date(this.now()).toISOString(),
      reason: options.reason,
      ...(reasonKind ? { reasonKind } : {}),
      ...(token ? { tokenHash: sha(token), tokenDelivered: false } : {}),
    };
    // pending 인 것만 원자적으로 바꾼다 (동시 결재 방지)
    const updated = await this.db.compareAndSwap<Approval>(
      owner,
      "approvals",
      id,
      { status: "pending", inputHash: approval.inputHash },
      patch,
    );
    // 동시에 다른 결재가 먼저 들어갔다 — 옛 상태를 200 으로 돌려주지 않는다
    if (!updated) throw alreadyDecided((await this.get(owner, id)).status);
    if (approval.messageId)
      await this.rooms.updateMessage(owner, approval.messageId, {
        payload: {
          status: updated.status,
          reason: options.reason,
          ...(reasonKind ? { reasonKind } : {}),
          decidedAt: updated.decidedAt,
        },
      });
    await this.rooms.activity(owner, {
      roomId: approval.roomId,
      kind: "approval",
      actor: "user",
      title: `${decision === "approve" ? "승인" : "반려"}: ${approval.title}`,
      detail: options.reason,
    });
    if (decision === "reject")
      await this.db.put(owner, "feedback-signals", {
        id: randomUUID(),
        packageId: null,
        kind: "reject",
        reason: options.reason ?? "",
        reasonKind,
        approvalId: id,
        createdAt: new Date(this.now()).toISOString(),
      });
    await this.rooms.audit(owner, {
      packageId: null,
      actor: options.decidedBy,
      action: `approval.${decision}:${approval.toolName}`,
      approvalId: id,
      result: "ok",
      roomId: approval.roomId,
      ...(reasonKind ? { reasonKind } : {}),
    });
    const stillPending = (await this.pending(owner)).some((a) => a.roomId === approval.roomId);
    // 반려는 끝이 아니라 재작업의 시작이다 — 캐릭터를 «작업 중» 으로 돌린다 (워커가 다음 상태를 알릴 때까지)
    if (stillPending)
      this.bus.setPresence(owner, approval.roomId, "waiting", PRESENCE_LABELS.waiting);
    else if (decision === "reject")
      this.bus.setPresence(owner, approval.roomId, "working", "반려 사유를 반영해 다시 작업 중");
    else this.bus.setPresence(owner, approval.roomId, "done", "결재 완료");
    this.bus.publish(owner, {
      type: "approval",
      roomId: approval.roomId,
      approvalId: id,
      status: updated.status,
    });
    this.bus.publish(owner, { type: "board", roomId: approval.roomId });
    this.bus.publish(owner, { type: "inbox" });
    // 토큰은 메모리로만 돌려준다 — 저장은 해시뿐. 워커가 가져갈 때까지 프로세스 메모리에 둔다.
    if (token) this.issued.set(`${owner}:${id}`, token);
    return { ...updated, ...(token ? { token } : {}) } as Approval & { token?: string };
  }
  // ponytail: 발급 토큰은 프로세스 메모리. 서버가 재시작되면 미수령 토큰은 사라지고 워커는 "approved, token 없음" 을 받아 새 승인을 요청한다.
  private readonly issued = new Map<string, string>();

  /** 워커 폴링: 승인됐으면 토큰을 **한 번만** 넘긴다. 이후에는 상태만. */
  async pollForWorker(
    owner: string,
    id: string,
  ): Promise<{ status: ApprovalStatus; token?: string; tokenLost?: boolean }> {
    const approval = await this.get(owner, id);
    if (approval.status === "approved" && !approval.tokenDelivered) {
      const pendingToken = this.issued.get(`${owner}:${id}`);
      if (!pendingToken) return { status: "approved", tokenLost: true };
      const delivered = await this.db.compareAndSwap<Approval>(
        owner,
        "approvals",
        id,
        { status: "approved", tokenDelivered: false },
        { tokenDelivered: true },
      );
      this.issued.delete(`${owner}:${id}`);
      if (delivered) return { status: "approved", token: pendingToken };
    }
    return { status: approval.status };
  }

  /**
   * 집행 (fail-closed): 토큰·도구명·입력이 모두 맞아야 1회 소비된다. 무엇 하나라도 확인 못 하면 403.
   * 입력이 승인본과 다르면 (해시 불일치) 무효 — §9.1 "입력이 바뀌면 무효".
   */
  async consume(
    owner: string,
    input: { approvalId: string; token: string; toolName: string; input: unknown },
  ): Promise<Approval> {
    const approval = await this.db.get<Approval>(owner, "approvals", input.approvalId);
    // 아직 승인되지 않았거나(토큰 해시 없음) 없는 승인이어도 시도 자체를 감사 로그에 남긴다
    const expected = Buffer.from(approval?.tokenHash ?? "", "hex");
    const actual = Buffer.from(sha(input.token), "hex");
    const tokenOk = expected.length === actual.length && timingSafeEqual(expected, actual);
    const hashOk = !!approval && inputHash(input.toolName, input.input) === approval.inputHash;
    if (!approval || !tokenOk || !hashOk || approval.status !== "approved") {
      await this.rooms.audit(owner, {
        packageId: null,
        actor: "gate",
        action: `approval.consume:${input.toolName}`,
        approvalId: input.approvalId,
        result: "blocked",
      });
      throw new AppError(
        !hashOk
          ? "승인된 내용과 입력이 다릅니다. 새 승인이 필요합니다"
          : "승인 토큰이 유효하지 않습니다",
        403,
      );
    }
    const consumed = await this.db.compareAndSwap<Approval>(
      owner,
      "approvals",
      input.approvalId,
      { status: "approved", tokenHash: approval.tokenHash },
      { status: "consumed" },
    );
    if (!consumed) throw new AppError("승인 토큰이 이미 사용되었습니다", 403);
    await this.rooms.audit(owner, {
      packageId: null,
      actor: "gate",
      action: `approval.consume:${input.toolName}`,
      approvalId: input.approvalId,
      result: "ok",
    });
    return consumed;
  }
}
