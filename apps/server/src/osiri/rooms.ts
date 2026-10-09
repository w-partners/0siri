// 0Siri 방·타임라인·목표·활동·감사 로그 (0SIRI-SPEC §4.2~4.5, §8, §10, §15.4, §20).
// 전부 owner=userId 의 records 에 저장한다. 집계(배지·진척·현황판)는 board() 한 곳에서만 계산한다 (§8, §10 "집계는 서버 한 곳").
import { randomUUID } from "node:crypto";
import {
  ACTIVITY_LABELS,
  type ActivityKind,
  ARCHIVED_ROOM_NOTICE,
  BOARD_STAGES,
  CHARACTER_STATE_OF,
  type CharacterState,
  GOAL_METRIC_KEYS,
  GOAL_TREE_LEVELS,
  GOAL_UNBLOCK_LABEL,
  type GoalLevel,
  type GoalMetricKey,
  type GoalStatus,
  METRIC_PERIOD_DAYS,
  type MetricPeriod,
  PERSONAL_CHARACTER_ID,
  PERSONAL_ROOM_TITLE,
  PERSONAL_TIER_LABEL,
  PRESENCE_LABELS,
  type ProposalDecision,
  type ProposalStatus,
  REPORT_CADENCE_DAYS,
  type RejectReasonKind,
  type TaskStage,
  TEAM_TIER_LABEL,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { EventBus, PresenceState } from "./events.ts";

export interface Room {
  id: string;
  packageId: string | null; // null = 일반 등급 개인 방(영시리)
  title: string;
  character: string; // 캐릭터 식별자 (패키지 캐릭터 또는 "yeongsil")
  pinned: boolean;
  createdAt: string;
  lastActivityAt: string;
  lastReport?: string; // 마지막 보고 한 줄 (방 목록 카드)
  lastSeenAt?: string; // 부재 중 진척 요약 기준
  archived?: boolean; // 해지 시 읽기 전용
  muted?: boolean; // 알림 끔 (방 목록 항목은 항상 boolean 으로 낸다)
}
/** 방 목록 카드 — `GET /rooms` 항목 */
export type RoomCard = Room & {
  muted: boolean;
  /** 해지되어 기간이 끝난 방 — 읽기 전용 */
  archived: boolean;
  /** 운영자가 플랫폼이 아닌 팀의 방 («타사 입점»). 개인 방은 false */
  thirdParty: boolean;
  /** 마지막으로 본 뒤의 진척 한 줄 («부재 중 진척»). 그 사이 활동이 없으면 싣지 않는다 */
  digest?: string;
  pendingApprovals: number;
  progress: number;
  presence: PresenceState;
  /** 약속한 보고 주기를 넘긴 팀 ("멈춘 팀") */
  stalled: boolean;
  tierLabel: string;
};
/** 팀이 낸 주제·목표 제안 */
export interface GoalProposal {
  id: string;
  roomId: string;
  title: string;
  detail: string;
  status: ProposalStatus;
  proposedBy: string;
  createdAt: string;
  decidedAt?: string;
  goalId?: string; // 수락되어 편입된 중기 목표
}
export interface GoalMetrics {
  period: MetricPeriod;
  /** 마지막으로 지표가 보고된 시각. null = 아직 측정 전 */
  measuredAt: string | null;
  /** null = 아직 측정 전("수집 중") — 0 과 다르다 */
  metrics: Record<GoalMetricKey, number | null>;
}
/** 역할 키(yaml 의 에이전트 키) → 사용자에게 보이는 역할 설명. 팀 패키지가 출처다. */
export type RoleSource = (
  packageId: string,
) => Promise<{ name: string; title: string; summary: string }[]>;
/** 패키지가 «타사 입점» 인지. 팀 패키지가 출처다. */
export type ThirdPartySource = (packageId: string) => Promise<boolean>;
export type MessageKind = "text" | "card" | "widget" | "report" | "digest";
export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  role: "user" | "assistant" | "system";
  kind: MessageKind;
  text?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}
export type { GoalLevel, TaskStage };
export interface TeamGoal {
  id: string;
  roomId: string;
  parentId: string | null;
  level: GoalLevel;
  title: string;
  progress: number; // 0~100
  status: GoalStatus;
  order: number;
  stage?: TaskStage; // level=task 일 때 흐름 단계
  assignee?: string; // 에이전트 역할명
  metrics?: { published?: number; indexed?: number; ai_citations?: number; conversions?: number };
  nextActions?: string[];
  dueAt?: string; // 목표 기간의 끝 — 정한 사람(사용자·팀)이 있을 때만
  createdAt: string;
  updatedAt: string;
}
/** 목표 화면용 모양 — 기간(`dueAt`, 없으면 null)과 그 목표에 쌓인 반려(검수·사용자)를 붙인다 */
export type GoalView = Omit<TeamGoal, "dueAt"> & {
  dueAt: string | null;
  /** 가장 최근 반려의 사유 종류 — 사유 종류가 기록된 반려가 있을 때만 */
  reasonKind?: RejectReasonKind;
  /** `byKind` 는 사유 종류가 기록된 반려만 센다 (합이 total 보다 작을 수 있다) */
  rejects?: { total: number; byKind: Partial<Record<RejectReasonKind, number>> };
};
export interface Activity {
  id: string;
  roomId?: string;
  messageId?: string; // 이 활동이 가리키는 방 메시지 — 결재함 줄에서 그 메시지로 바로 연다
  kind: ActivityKind;
  actor: string;
  title: string;
  detail?: string;
  createdAt: string;
}
export interface AuditLog {
  id: string;
  ts: string;
  packageId: string | null;
  userId: string;
  goalId?: string;
  actor: string;
  action: string;
  sourceRefs?: string[];
  approvalId?: string;
  result: "ok" | "error" | "blocked";
  roomId?: string; // 방의 감사 문서 목록(`/rooms/:id/files`)이 이것으로 거른다
  reasonKind?: RejectReasonKind; // 반려 사유 종류 (approval.reject · review.reject)
  detail?: string; // 반려 사유 문장 (review.reject)
}
export interface RoomBoard {
  roomId: string;
  flow: Record<TaskStage, number>;
  pendingApprovals: number;
  /** role·current 는 알 수 있을 때만 싣는다 — 없으면 화면은 그 줄을 보이지 않는다 */
  agents: { actor: string; done: number; errors: number; role?: string; current?: string }[];
  character: { assetId: string; state: CharacterState; summary: string };
  /** 최근 완료 3건 제목 (최신순) */
  recentDone: string[];
  /** 약속한 보고 주기를 넘겼다 (팀 방만 true 가 될 수 있다) */
  stalled: boolean;
  goals: { level: GoalLevel; count: number; progress: number }[];
  progress: number; // 방 전체 진척(단기 목표 평균)
  /** 성과 지표 합계 (목표에 보고된 값의 합) — 주간 보고·구독 카드가 이 값을 쓴다 */
  metrics: { published: number; indexed: number; ai_citations: number };
  presence: PresenceState;
  nextReportAt?: string;
}

const now = () => new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** 시작(activate)은 제안 상태에서만 — 그 밖의 상태면 409. */
export function assertProposed(goal: Pick<TeamGoal, "status">) {
  if (goal.status !== "proposed")
    throw new AppError(`제안 상태인 목표만 시작할 수 있습니다 (현재 상태: ${goal.status})`, 409);
}

export class Rooms {
  private roleSource: RoleSource | undefined;
  constructor(
    private readonly db: Store,
    private readonly bus: EventBus,
  ) {}
  /** 현황판 `agents[].role` 의 출처(팀 패키지 역할표)를 잇는다. 잇지 않으면 role 은 싣지 않는다. */
  setRoleSource(source: RoleSource) {
    this.roleSource = source;
  }
  private thirdPartySource: ThirdPartySource | undefined;
  /** 방 항목 `thirdParty` 의 출처(팀 패키지)를 잇는다. 잇지 않으면 false 로 낸다(패키지를 모르는 구성). */
  setThirdPartySource(source: ThirdPartySource) {
    this.thirdPartySource = source;
  }
  private async thirdPartyOf(room: Room): Promise<boolean> {
    if (room.packageId === null || !this.thirdPartySource) return false;
    try {
      return await this.thirdPartySource(room.packageId);
    } catch (error) {
      console.error(
        `[osiri] 팀 정보를 읽지 못해 방 목록에 «타사 입점» 표기를 싣지 않습니다 room=${room.id} package=${room.packageId}: ${errorText(error)}`,
      );
      return false;
    }
  }

  // --- 방 ---
  async create(
    owner: string,
    input: { packageId: string | null; title: string; character: string },
  ): Promise<Room> {
    const room: Room = {
      id: randomUUID(),
      packageId: input.packageId,
      title: input.title,
      character: input.character,
      pinned: false,
      createdAt: now(),
      lastActivityAt: now(),
    };
    await this.db.put(owner, "rooms", room);
    return room;
  }
  async get(owner: string, roomId: string): Promise<Room> {
    const room = await this.db.get<Room>(owner, "rooms", roomId);
    if (!room) throw new AppError("방을 찾을 수 없습니다", 404);
    return room;
  }
  async ensurePersonalRoom(owner: string): Promise<Room> {
    const rooms = await this.db.list<Room>(owner, "rooms");
    const personal = rooms.find((room) => room.packageId === null);
    return (
      personal ??
      this.create(owner, {
        packageId: null,
        title: PERSONAL_ROOM_TITLE,
        character: PERSONAL_CHARACTER_ID,
      })
    );
  }
  async patch(
    owner: string,
    roomId: string,
    patch: Partial<
      Pick<Room, "pinned" | "title" | "lastSeenAt" | "archived" | "lastReport" | "muted">
    >,
  ) {
    const room = await this.get(owner, roomId);
    const next = { ...room, ...patch };
    await this.db.put(owner, "rooms", next);
    // 목록에 보이는 값이 바뀌면 알린다 (lastSeenAt 은 목록에 안 보인다)
    if (Object.keys(patch).some((key) => key !== "lastSeenAt"))
      this.bus.publish(owner, { type: "board", roomId });
    return next;
  }
  /** 방 항목 하나 (고정·알림 끔 응답) — 목록과 같은 모양·같은 집계. */
  async card(owner: string, roomId: string): Promise<RoomCard> {
    const room = await this.get(owner, roomId);
    return this.toCard(
      room,
      await this.board(owner, roomId),
      await this.db.list<Activity>(owner, "activity"),
    );
  }
  private async toCard(room: Room, board: RoomBoard, activities: Activity[]): Promise<RoomCard> {
    const digest = this.digestOf(room, activities);
    return {
      ...room,
      muted: room.muted === true,
      archived: room.archived === true,
      thirdParty: await this.thirdPartyOf(room),
      ...(digest ? { digest } : {}),
      pendingApprovals: board.pendingApprovals,
      progress: board.progress,
      presence: board.presence,
      stalled: board.stalled,
      tierLabel: room.packageId === null ? PERSONAL_TIER_LABEL : TEAM_TIER_LABEL,
    };
  }
  /**
   * 방 목록 + 배지 집계. 정렬(화면 2): ① 승인 대기 있는 방(대기 많은 순) → ② 최근 활동 순 → ③ 이름순.
   * 고정은 그 그룹(대기 있음 / 없음) 안에서만 맨 위로 올린다.
   */
  async list(owner: string): Promise<RoomCard[]> {
    const rooms = await this.db.list<Room>(owner, "rooms");
    const [activities, ...boards] = await Promise.all([
      this.db.list<Activity>(owner, "activity"),
      ...rooms.map((room) => this.board(owner, room.id)),
    ]);
    const cards = await Promise.all(
      rooms.map((room, i) => this.toCard(room, boards[i] as RoomBoard, activities)),
    );
    cards.sort(
      (a, b) =>
        Number(b.pendingApprovals > 0) - Number(a.pendingApprovals > 0) ||
        Number(b.pinned) - Number(a.pinned) ||
        b.pendingApprovals - a.pendingApprovals ||
        b.lastActivityAt.localeCompare(a.lastActivityAt) ||
        a.title.localeCompare(b.title, "ko"),
    );
    return cards;
  }
  /** 그 방의 활동만, 최신순 (`/inbox` 의 activities 와 같은 모양 + label). */
  async feed(owner: string, roomId: string) {
    const room = await this.get(owner, roomId);
    return (await this.db.list<Activity>(owner, "activity"))
      .filter((a) => a.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => ({ ...a, roomTitle: room.title, label: ACTIVITY_LABELS[a.kind] ?? a.kind }));
  }
  /** 그 방의 승인본·감사 문서 (최신순). */
  async files(owner: string, roomId: string) {
    await this.get(owner, roomId);
    const [approvals, goals, logs] = await Promise.all([
      this.db.listByField<{
        id: string;
        status: string;
        title: string;
        summary: string;
        decidedAt?: string;
        goalId?: string;
        messageId?: string;
      }>(owner, "approvals", "roomId", roomId),
      this.goals(owner, roomId),
      this.auditLogs(owner),
    ]);
    const approvalIds = new Set(approvals.map((a) => a.id));
    const goalIds = new Set(goals.map((g) => g.id));
    return {
      // 승인본 = 승인됐거나 이미 집행된 것. decidedAt 이 없는 승인본은 없다(승인 시 함께 기록된다)
      approved: approvals
        .filter((a) => (a.status === "approved" || a.status === "consumed") && a.decidedAt)
        .map((a) => ({
          approvalId: a.id,
          title: a.title,
          summary: a.summary,
          decidedAt: a.decidedAt as string,
          goalId: a.goalId ?? null,
          messageId: a.messageId ?? null,
        }))
        .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
      audit: logs
        .filter(
          (log) =>
            log.roomId === roomId ||
            (log.approvalId !== undefined && approvalIds.has(log.approvalId)) ||
            (log.goalId !== undefined && goalIds.has(log.goalId)),
        )
        .map((log) => ({
          id: log.id,
          ts: log.ts,
          action: log.action,
          actor: log.actor,
          ...(log.approvalId ? { approvalId: log.approvalId } : {}),
        })),
    };
  }

  // --- 타임라인 ---
  async post(
    owner: string,
    roomId: string,
    input: Omit<RoomMessage, "id" | "roomId" | "seq" | "createdAt">,
  ): Promise<RoomMessage> {
    const room = await this.get(owner, roomId);
    // 해지되어 기간이 끝난 방은 읽기 전용 — 사용자·워커·시스템 누구의 글도 받지 않는다
    if (room.archived) throw new AppError(ARCHIVED_ROOM_NOTICE, 409);
    const seq = Date.now(); // ponytail: 단일 서버의 ms 시각이면 순서가 보장된다. 다중 인스턴스면 시퀀스 테이블로
    const message: RoomMessage = { id: randomUUID(), roomId, seq, createdAt: now(), ...input };
    await this.db.put(owner, "messages", message);
    await this.db.put(owner, "rooms", {
      ...room,
      lastActivityAt: message.createdAt,
      ...(input.kind === "report" && input.text ? { lastReport: input.text.slice(0, 80) } : {}),
    });
    this.bus.publish(owner, { type: "message", roomId, messageId: message.id });
    return message;
  }
  async timeline(owner: string, roomId: string, after?: number): Promise<RoomMessage[]> {
    await this.get(owner, roomId);
    const messages = await this.db.listByField<RoomMessage>(owner, "messages", "roomId", roomId);
    return messages
      .filter((message) => after === undefined || message.seq > after)
      .sort((a, b) => a.seq - b.seq);
  }
  async updateMessage(owner: string, messageId: string, patch: Partial<RoomMessage>) {
    const message = await this.db.get<RoomMessage>(owner, "messages", messageId);
    if (!message) return null;
    const next = { ...message, ...patch, payload: { ...message.payload, ...patch.payload } };
    await this.db.put(owner, "messages", next);
    this.bus.publish(owner, { type: "message", roomId: message.roomId, messageId });
    return next;
  }
  /** 방 재진입 시 "밤새 진척" 요약 — lastSeenAt 이후 활동을 한 카드로 (§4.3 부재 중 진척). */
  async digestSince(owner: string, roomId: string): Promise<string | null> {
    return this.digestOf(
      await this.get(owner, roomId),
      await this.db.list<Activity>(owner, "activity"),
    );
  }
  /** 부재 중 요약 한 줄 — 방 타임라인(`digestSince`)과 방 목록 항목(`digest`)이 같은 문장을 쓴다. */
  private digestOf(room: Room, all: Activity[]): string | null {
    if (!room.lastSeenAt) return null;
    const since = room.lastSeenAt;
    const activities = all.filter((a) => a.roomId === room.id && a.createdAt > since);
    if (activities.length === 0) return null;
    const counts = new Map<ActivityKind, number>();
    for (const a of activities) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    return `부재 중 ${activities.length}건: ${[...counts].map(([k, n]) => `${ACTIVITY_LABELS[k] ?? k} ${n}`).join(" · ")}`;
  }

  // --- 목표 (§8 트리) ---
  async createGoal(
    owner: string,
    input: Pick<TeamGoal, "roomId" | "title" | "level"> &
      Partial<
        Pick<TeamGoal, "parentId" | "stage" | "assignee" | "order" | "nextActions" | "dueAt">
      > & {
        /** "proposed" = 사용자가 시작을 누르기 전. 안 주면 바로 "active" */
        status?: Extract<GoalStatus, "active" | "proposed">;
      },
    actor = "system",
  ): Promise<TeamGoal> {
    await this.get(owner, input.roomId);
    if (input.parentId) {
      const parent = await this.db.get<TeamGoal>(owner, "team-goals", input.parentId);
      if (!parent || parent.roomId !== input.roomId)
        throw new AppError("상위 목표를 찾을 수 없습니다", 404);
    }
    const siblings = await this.goals(owner, input.roomId);
    const goal: TeamGoal = {
      id: randomUUID(),
      roomId: input.roomId,
      parentId: input.parentId ?? null,
      level: input.level,
      title: input.title,
      progress: 0,
      status: input.status ?? "active",
      order: input.order ?? siblings.filter((g) => g.parentId === (input.parentId ?? null)).length,
      stage: input.stage ?? (input.level === "task" ? "detect" : undefined),
      assignee: input.assignee,
      nextActions: input.nextActions,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    await this.db.put(owner, "team-goals", goal);
    await this.audit(owner, {
      packageId: null,
      goalId: goal.id,
      actor,
      action: "goal.create",
      result: "ok",
      roomId: goal.roomId,
    });
    this.bus.publish(owner, { type: "goal", roomId: goal.roomId, goalId: goal.id });
    this.bus.publish(owner, { type: "board", roomId: goal.roomId });
    return goal;
  }
  async goal(owner: string, goalId: string): Promise<TeamGoal> {
    const goal = await this.db.get<TeamGoal>(owner, "team-goals", goalId);
    if (!goal) throw new AppError("목표를 찾을 수 없습니다", 404);
    return goal;
  }
  /** proposed → active. 그 밖의 상태면 409 (동시에 두 번 눌러도 한 번만 통과한다). */
  async activateGoal(owner: string, goalId: string, actor = "user"): Promise<TeamGoal> {
    const goal = await this.goal(owner, goalId);
    const updated = await this.db.compareAndSwap<TeamGoal>(
      owner,
      "team-goals",
      goalId,
      { status: "proposed" },
      { status: "active", updatedAt: now() },
    );
    if (!updated) {
      assertProposed(await this.goal(owner, goalId));
      throw new AppError("목표 상태를 바꾸지 못했습니다. 다시 시도하세요", 409);
    }
    await this.audit(owner, {
      packageId: null,
      goalId,
      actor,
      action: "goal.activate",
      result: "ok",
      roomId: goal.roomId,
    });
    this.bus.publish(owner, { type: "goal", roomId: goal.roomId, goalId });
    this.bus.publish(owner, { type: "board", roomId: goal.roomId });
    return updated;
  }
  /**
   * blocked → active (사용자가 [다시 진행]). 막힘은 진행 중(active)이던 목표에만 걸리므로 풀면 active 로 돌아가고,
   * 워커의 tick 이 그 목표를 다시 집는다. 단계·진척은 멈춘 자리 그대로다. 그 밖의 상태면 409.
   */
  async unblockGoal(owner: string, goalId: string, actor = "user"): Promise<TeamGoal> {
    const goal = await this.goal(owner, goalId);
    const updated = await this.db.compareAndSwap<TeamGoal>(
      owner,
      "team-goals",
      goalId,
      { status: "blocked" },
      { status: "active", updatedAt: now() },
    );
    if (!updated)
      throw new AppError(
        `막힌 목표만 다시 진행할 수 있습니다 (현재 상태: ${(await this.goal(owner, goalId)).status})`,
        409,
      );
    await this.audit(owner, {
      packageId: null,
      goalId,
      actor,
      action: "goal.unblock",
      result: "ok",
      roomId: goal.roomId,
    });
    await this.activity(owner, {
      roomId: goal.roomId,
      kind: "goal",
      actor,
      title: `${GOAL_UNBLOCK_LABEL}: ${goal.title}`,
    });
    this.bus.publish(owner, { type: "goal", roomId: goal.roomId, goalId });
    return updated;
  }
  /**
   * 목표(와 그 아래 목표 전부)의 성과 지표. 한 번도 보고되지 않은 지표는 null("수집 중") — 0 으로 채우지 않는다.
   * 보고된 적이 있는 지표는 기간 안에 갱신된 목표의 값만 더한다(기간 안에 없으면 0).
   * ponytail: 지표는 목표에 누적값으로만 남아 있어 "기간" 은 그 목표의 마지막 갱신 시각으로 가른다. 일자별 이력이 필요해지면 지표 기록을 따로 쌓는다.
   */
  async goalMetrics(owner: string, goalId: string, period: MetricPeriod): Promise<GoalMetrics> {
    const root = await this.goal(owner, goalId);
    const all = await this.goals(owner, root.roomId);
    const subtree = new Set([root.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of all)
        if (g.parentId && subtree.has(g.parentId) && !subtree.has(g.id)) {
          subtree.add(g.id);
          grew = true;
        }
    }
    const since = new Date(Date.now() - METRIC_PERIOD_DAYS[period] * DAY_MS).toISOString();
    const metrics = Object.fromEntries(GOAL_METRIC_KEYS.map((key) => [key, null])) as Record<
      GoalMetricKey,
      number | null
    >;
    let measuredAt: string | null = null;
    for (const g of all) {
      if (!subtree.has(g.id) || !g.metrics) continue;
      for (const key of GOAL_METRIC_KEYS) {
        const value = g.metrics[key];
        if (value === undefined) continue;
        metrics[key] = (metrics[key] ?? 0) + (g.updatedAt >= since ? value : 0);
        if (measuredAt === null || g.updatedAt > measuredAt) measuredAt = g.updatedAt;
      }
    }
    return { period, measuredAt, metrics };
  }

  // --- 팀의 주제·목표 제안 ---
  async propose(
    owner: string,
    input: Pick<GoalProposal, "roomId" | "title" | "detail" | "proposedBy">,
  ): Promise<GoalProposal> {
    await this.get(owner, input.roomId);
    const proposal: GoalProposal = {
      id: randomUUID(),
      ...input,
      status: "pending",
      createdAt: now(),
    };
    await this.db.put(owner, "goal-proposals", proposal);
    await this.audit(owner, {
      packageId: null,
      actor: input.proposedBy,
      action: "goal.propose",
      result: "ok",
      roomId: input.roomId,
    });
    await this.activity(owner, {
      roomId: input.roomId,
      kind: "goal",
      actor: input.proposedBy,
      title: `목표 제안: ${input.title}`,
      detail: input.detail,
    });
    return proposal;
  }
  /** 제안 목록(최신순). roomId 를 주면 그 방 것만. */
  async proposals(owner: string, roomId?: string): Promise<GoalProposal[]> {
    if (roomId) await this.get(owner, roomId);
    const list = roomId
      ? await this.db.listByField<GoalProposal>(owner, "goal-proposals", "roomId", roomId)
      : await this.db.list<GoalProposal>(owner, "goal-proposals");
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** 수락 → 다음 중기 목표로 편입 + 방 공지. 보류 → held. 이미 결정된 제안은 409. */
  async decideProposal(
    owner: string,
    proposalId: string,
    decision: ProposalDecision,
  ): Promise<GoalProposal> {
    const proposal = await this.db.get<GoalProposal>(owner, "goal-proposals", proposalId);
    if (!proposal) throw new AppError("제안을 찾을 수 없습니다", 404);
    const decided = await this.db.compareAndSwap<GoalProposal>(
      owner,
      "goal-proposals",
      proposalId,
      { status: "pending" },
      { status: decision === "accept" ? "accepted" : "held", decidedAt: now() },
    );
    if (!decided) {
      const current = await this.db.get<GoalProposal>(owner, "goal-proposals", proposalId);
      throw new AppError(
        `이미 결정된 제안입니다 (현재 상태: ${current?.status ?? "알 수 없음"})`,
        409,
      );
    }
    await this.audit(owner, {
      packageId: null,
      actor: "user",
      action: `goal.proposal.${decision}`,
      result: "ok",
      roomId: proposal.roomId,
    });
    if (decision === "hold") {
      this.bus.publish(owner, { type: "board", roomId: proposal.roomId });
      return decided;
    }
    // 진행 중인 장기 목표 아래의 다음(맨 뒤) 중기 목표로 넣는다. 장기 목표가 없으면 최상위 중기 목표가 된다
    const long = (await this.goals(owner, proposal.roomId)).find(
      (g) => g.level === "long" && g.status === "active",
    );
    const goal = await this.createGoal(
      owner,
      { roomId: proposal.roomId, title: proposal.title, level: "mid", parentId: long?.id ?? null },
      "user",
    );
    const linked = { ...decided, goalId: goal.id };
    await this.db.put(owner, "goal-proposals", linked);
    await this.post(owner, proposal.roomId, {
      role: "system",
      kind: "text",
      text: `제안을 수락했습니다: "${proposal.title}" — 다음 중기 목표로 넣었습니다.`,
      payload: { proposalId, goalId: goal.id },
    });
    await this.activity(owner, {
      roomId: proposal.roomId,
      kind: "goal",
      actor: "user",
      title: `제안 반영: ${proposal.title}`,
    });
    return linked;
  }
  async goals(owner: string, roomId: string): Promise<TeamGoal[]> {
    return (await this.db.listByField<TeamGoal>(owner, "team-goals", "roomId", roomId)).sort(
      (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt),
    );
  }
  /** 목표 화면(`GET /goals`)용 — 반려는 감사 로그에서 센다 (검수 `review.reject` + 사용자 `approval.reject:*`). */
  async goalViews(owner: string, roomId: string): Promise<GoalView[]> {
    const [goals, logs] = await Promise.all([this.goals(owner, roomId), this.auditLogs(owner)]);
    const isReject = (action: string) =>
      action === "review.reject" || action.startsWith("approval.reject");
    return goals.map((goal) => {
      // auditLogs 는 최신순 — 첫 번째가 가장 최근 반려다
      const rejected = logs.filter((log) => log.goalId === goal.id && isReject(log.action));
      const view: GoalView = { ...goal, dueAt: goal.dueAt ?? null };
      if (rejected.length === 0) return view;
      const byKind: Partial<Record<RejectReasonKind, number>> = {};
      for (const log of rejected)
        if (log.reasonKind) byKind[log.reasonKind] = (byKind[log.reasonKind] ?? 0) + 1;
      const latest = rejected.find((log) => log.reasonKind)?.reasonKind;
      return {
        ...view,
        ...(latest ? { reasonKind: latest } : {}),
        rejects: { total: rejected.length, byKind },
      };
    });
  }
  async updateGoal(
    owner: string,
    goalId: string,
    patch: Partial<
      Pick<
        TeamGoal,
        "progress" | "status" | "stage" | "metrics" | "nextActions" | "order" | "title" | "dueAt"
      >
    >,
    actor = "system",
  ): Promise<TeamGoal> {
    const goal = await this.db.get<TeamGoal>(owner, "team-goals", goalId);
    if (!goal) throw new AppError("목표를 찾을 수 없습니다", 404);
    // 안 보낸 필드(undefined)가 기존 값을 지우지 않게 한다 — 지워지면 status 가 사라져 tick 이 그 목표를 다시 집지 못한다
    const sent = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const next: TeamGoal = { ...goal, ...sent, updatedAt: now() };
    if (next.progress >= 100) next.status = "completed";
    await this.db.put(owner, "team-goals", next);
    // 상위 목표 진척 = 하위 평균 (서버 한 곳에서만 재계산)
    if (goal.parentId) await this.rollUp(owner, goal.parentId);
    await this.audit(owner, {
      packageId: null,
      goalId,
      actor,
      action: "goal.progress",
      result: "ok",
    });
    this.bus.publish(owner, { type: "goal", roomId: goal.roomId, goalId });
    this.bus.publish(owner, { type: "board", roomId: goal.roomId });
    return next;
  }
  private async rollUp(owner: string, goalId: string) {
    const goal = await this.db.get<TeamGoal>(owner, "team-goals", goalId);
    if (!goal) return;
    const children = (await this.goals(owner, goal.roomId)).filter((g) => g.parentId === goalId);
    if (children.length === 0) return;
    const progress = Math.round(children.reduce((sum, g) => sum + g.progress, 0) / children.length);
    if (progress !== goal.progress) {
      await this.db.put(owner, "team-goals", { ...goal, progress, updatedAt: now() });
      if (goal.parentId) await this.rollUp(owner, goal.parentId);
    }
  }

  // --- 활동·감사 로그 ---
  async activity(owner: string, input: Omit<Activity, "id" | "createdAt">): Promise<Activity> {
    const entry: Activity = { id: randomUUID(), createdAt: now(), ...input };
    await this.db.put(owner, "activity", entry);
    if (input.roomId) {
      const room = await this.db.get<Room>(owner, "rooms", input.roomId);
      if (room) await this.db.put(owner, "rooms", { ...room, lastActivityAt: entry.createdAt });
      this.bus.publish(owner, { type: "board", roomId: input.roomId });
    }
    this.bus.publish(owner, { type: "inbox" });
    return entry;
  }
  async activities(owner: string, limit = 100): Promise<Activity[]> {
    return (await this.db.list<Activity>(owner, "activity"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  async audit(owner: string, input: Omit<AuditLog, "id" | "ts" | "userId">): Promise<AuditLog> {
    const entry: AuditLog = { id: randomUUID(), ts: now(), userId: owner, ...input };
    await this.db.put(owner, "audit", entry);
    return entry;
  }
  async auditLogs(owner: string): Promise<AuditLog[]> {
    return (await this.db.list<AuditLog>(owner, "audit")).sort((a, b) => b.ts.localeCompare(a.ts));
  }

  // --- 현황판 집계 (§4.3, §10 — 모든 화면이 이 값을 공유) ---
  async board(owner: string, roomId: string): Promise<RoomBoard> {
    const [room, goals, approvals, activities, skills] = await Promise.all([
      this.get(owner, roomId),
      this.goals(owner, roomId),
      this.db.listByField<{ status: string; expiresAt?: string }>(
        owner,
        "approvals",
        "roomId",
        roomId,
      ),
      this.db.list<Activity>(owner, "activity"),
      // 이 방의 개인 스킬 — 초안(draft)은 사용자의 결정을 기다린다
      this.db.listByField<{ status: string }>(owner, "skills", "roomId", roomId),
    ]);
    const flow = Object.fromEntries(BOARD_STAGES.map((s) => [s, 0])) as Record<TaskStage, number>;
    for (const goal of goals)
      if (goal.level === "task" && goal.stage && goal.status !== "completed") flow[goal.stage]++;
    // 만료 시각이 지난 승인은 아직 정리(Approvals.pending)되지 않았어도 대기로 세지 않는다
    const nowMs = Date.now();
    // 배지 수 = 승인 대기 + 결정을 기다리는 개인 스킬 초안 (결재함 `/inbox` 의 pending 과 같은 묶음)
    const pendingApprovals =
      approvals.filter(
        (a) => a.status === "pending" && !(a.expiresAt && Date.parse(a.expiresAt) <= nowMs),
      ).length + skills.filter((s) => s.status === "draft").length;
    const metrics = { published: 0, indexed: 0, ai_citations: 0 };
    for (const goal of goals) {
      metrics.published += goal.metrics?.published ?? 0;
      metrics.indexed += goal.metrics?.indexed ?? 0;
      metrics.ai_citations += goal.metrics?.ai_citations ?? 0;
    }
    const agents = new Map<string, { done: number; errors: number }>();
    for (const a of activities)
      if (a.roomId === roomId && a.actor !== "system" && a.actor !== "user") {
        const entry = agents.get(a.actor) ?? { done: 0, errors: 0 };
        if (a.kind === "error") entry.errors++;
        else entry.done++;
        agents.set(a.actor, entry);
      }
    const byLevel = GOAL_TREE_LEVELS.map((level) => {
      const items = goals.filter((g) => g.level === level);
      return {
        level,
        count: items.length,
        progress: items.length
          ? Math.round(items.reduce((sum, g) => sum + g.progress, 0) / items.length)
          : 0,
      };
    });
    const shortTerm = byLevel.find((b) => b.level === "short");
    const progress = shortTerm?.count
      ? shortTerm.progress
      : (byLevel.find((b) => b.count)?.progress ?? 0);
    const presence = pendingApprovals > 0 ? "waiting" : this.bus.getPresence(owner, roomId);
    const state = CHARACTER_STATE_OF[presence];
    const summary =
      state === "awaiting_approval"
        ? `승인 ${pendingApprovals}건을 기다리고 있습니다`
        : state === "working"
          ? (this.bus.getPresenceLabel(owner, roomId) ?? PRESENCE_LABELS.working)
          : (room.lastReport ?? PRESENCE_LABELS[presence]);
    // 다음 보고 예정 = 마지막 보고(없으면 방 생성) + 약속한 주기. 개인 방은 보고를 약속하지 않는다
    const lastReportAt = activities
      .filter((a) => a.roomId === roomId && a.kind === "report")
      .reduce((latest, a) => (a.createdAt > latest ? a.createdAt : latest), room.createdAt);
    const nextReportAt =
      room.packageId === null || room.archived
        ? undefined
        : new Date(Date.parse(lastReportAt) + REPORT_CADENCE_DAYS.weekly * DAY_MS).toISOString();
    const roles = await this.rolesOf(room);
    const openWork = goals.filter(
      (g) => (g.level === "task" || g.level === "short") && g.status === "active",
    );
    return {
      roomId,
      flow,
      pendingApprovals,
      agents: [...agents].map(([actor, v]) => {
        const role = roles?.find((r) => r.name === actor);
        const current = openWork.find((g) => g.assignee === actor)?.title;
        return {
          actor,
          ...v,
          ...(role ? { role: role.summary || role.title } : {}),
          ...(current ? { current } : {}),
        };
      }),
      character: { assetId: room.character, state, summary },
      recentDone: goals
        .filter((g) => (g.level === "task" || g.level === "short") && g.status === "completed")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 3)
        .map((g) => g.title),
      stalled: nextReportAt !== undefined && Date.parse(nextReportAt) <= nowMs,
      goals: byLevel,
      progress,
      metrics,
      presence,
      ...(nextReportAt ? { nextReportAt } : {}),
    };
  }
  /** 팀 방의 역할표. 출처가 없거나(개인 방·미연결) 읽지 못하면 null — 읽지 못한 것은 이유를 남긴다. */
  private async rolesOf(room: Room) {
    if (room.packageId === null || !this.roleSource) return null;
    try {
      return await this.roleSource(room.packageId);
    } catch (error) {
      console.error(
        `[osiri] 역할표를 읽지 못해 현황판에 역할 설명을 싣지 않습니다 room=${room.id} package=${room.packageId}: ${errorText(error)}`,
      );
      return null;
    }
  }
}
