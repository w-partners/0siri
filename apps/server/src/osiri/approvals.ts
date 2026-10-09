// 0Siri 승인 게이트 (0SIRI-SPEC §9, §15.2.3, §24-10).
//  - external 도구는 실행 전 승인 필수. 승인 상태를 확인할 수 없으면 실행하지 않는다 (fail-closed).
//  - 승인은 1회용 approval_token. 토큰은 도구명+입력 해시에 묶이며, 입력이 바뀌면 무효.
//  - 승인본은 동결(frozenHash). 법률 패키지 발행 승인은 변호사(방 소유자) 본인만 — 운영자·관리자 대리 승인 불가.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { EventBus } from "./events.ts";
import type { Rooms } from "./rooms.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";
export interface Approval {
  id: string;
  roomId: string;
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
  async pending(owner: string): Promise<Approval[]> {
    return (await this.db.listByStatus<Approval>(owner, "approvals", "pending")).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  /** external 도구 실행 보류 → 승인 카드 생성 (§15.2, §21 워커 /approvals/request). 같은 도구·입력이 이미 대기 중이면 그것을 돌려준다. */
  async request(
    owner: string,
    input: {
      roomId: string;
      toolName: string;
      input: unknown;
      title: string;
      summary: string;
      evidence?: string;
      requestedBy: string;
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
      toolName: input.toolName,
      input: input.input,
      inputHash: hash,
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
      status: "pending",
      requestedBy: input.requestedBy,
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
    options: { reason?: string; decidedBy: string; frozenHash?: string },
  ): Promise<Approval> {
    const approval = await this.get(owner, id);
    if (options.frozenHash && options.frozenHash !== approval.inputHash)
      throw new AppError("승인 대상이 바뀌었습니다. 최신 내용을 다시 확인하세요", 409);
    if (approval.status !== "pending") return approval;
    if (Date.parse(approval.expiresAt) <= this.now()) {
      await this.db.compareAndSwap(
        owner,
        "approvals",
        id,
        { status: "pending" },
        { status: "expired" },
      );
      throw new AppError("승인 요청이 만료되었습니다", 409);
    }
    const token = decision === "approve" ? randomBytes(32).toString("base64url") : undefined;
    const patch: Partial<Approval> = {
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: options.decidedBy,
      decidedAt: new Date(this.now()).toISOString(),
      reason: options.reason,
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
    if (!updated) return this.get(owner, id);
    if (approval.messageId)
      await this.rooms.updateMessage(owner, approval.messageId, {
        payload: { status: updated.status, reason: options.reason, decidedAt: updated.decidedAt },
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
        approvalId: id,
        createdAt: new Date(this.now()).toISOString(),
      });
    await this.rooms.audit(owner, {
      packageId: null,
      actor: options.decidedBy,
      action: `approval.${decision}:${approval.toolName}`,
      approvalId: id,
      result: "ok",
    });
    const stillPending = (await this.pending(owner)).some((a) => a.roomId === approval.roomId);
    this.bus.setPresence(
      owner,
      approval.roomId,
      stillPending ? "waiting" : "done",
      stillPending ? "승인 대기 중" : "결재 완료",
    );
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
