// 0Siri 방·타임라인·목표·활동·감사 로그 (0SIRI-SPEC §4.2~4.5, §8, §10, §15.4, §20).
// 전부 owner=userId 의 records 에 저장한다. 집계(배지·진척·현황판)는 board() 한 곳에서만 계산한다 (§8, §10 "집계는 서버 한 곳").
import { randomUUID } from "node:crypto";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { EventBus } from "./events.ts";

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
}
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
export type GoalLevel = "long" | "mid" | "short" | "task";
export type TaskStage = "detect" | "draft" | "geo" | "review" | "approval" | "publish" | "done";
export interface TeamGoal {
  id: string;
  roomId: string;
  parentId: string | null;
  level: GoalLevel;
  title: string;
  progress: number; // 0~100
  status: "active" | "paused" | "completed" | "blocked";
  order: number;
  stage?: TaskStage; // level=task 일 때 흐름 단계
  assignee?: string; // 에이전트 역할명
  metrics?: { published?: number; indexed?: number; ai_citations?: number };
  nextActions?: string[];
  createdAt: string;
  updatedAt: string;
}
export interface Activity {
  id: string;
  roomId?: string;
  kind: "approval" | "publish" | "report" | "error" | "goal" | "system" | "skill" | "subscription";
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
}
export interface RoomBoard {
  roomId: string;
  flow: Record<TaskStage, number>;
  pendingApprovals: number;
  agents: { actor: string; done: number; errors: number }[];
  goals: { level: GoalLevel; count: number; progress: number }[];
  progress: number; // 방 전체 진척(단기 목표 평균)
  presence: string;
  nextReportAt?: string;
}

const STAGES: TaskStage[] = ["detect", "draft", "geo", "review", "approval", "publish", "done"];
const now = () => new Date().toISOString();

export class Rooms {
  constructor(
    private readonly db: Store,
    private readonly bus: EventBus,
  ) {}

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
    return personal ?? this.create(owner, { packageId: null, title: "영시리", character: "yeongsil" });
  }
  async patch(owner: string, roomId: string, patch: Partial<Pick<Room, "pinned" | "title" | "lastSeenAt" | "archived" | "lastReport">>) {
    const room = await this.get(owner, roomId);
    const next = { ...room, ...patch };
    await this.db.put(owner, "rooms", next);
    return next;
  }
  /** 방 목록 + 배지 집계. 정렬: 고정 > 승인 대기 > 최근 활동 (§4.2). */
  async list(owner: string) {
    const rooms = await this.db.list<Room>(owner, "rooms");
    const boards = await Promise.all(rooms.map((room) => this.board(owner, room.id)));
    const cards = rooms.map((room, i) => ({
      ...room,
      pendingApprovals: boards[i].pendingApprovals,
      progress: boards[i].progress,
      presence: boards[i].presence,
    }));
    cards.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.pendingApprovals - a.pendingApprovals ||
        b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
    return cards;
  }

  // --- 타임라인 ---
  async post(
    owner: string,
    roomId: string,
    input: Omit<RoomMessage, "id" | "roomId" | "seq" | "createdAt">,
  ): Promise<RoomMessage> {
    const room = await this.get(owner, roomId);
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
    const room = await this.get(owner, roomId);
    if (!room.lastSeenAt) return null;
    const since = room.lastSeenAt;
    const activities = (await this.db.list<Activity>(owner, "activity")).filter(
      (a) => a.roomId === roomId && a.createdAt > since,
    );
    if (activities.length === 0) return null;
    const counts = new Map<string, number>();
    for (const a of activities) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    const labels: Record<string, string> = {
      approval: "승인 요청",
      publish: "발행",
      report: "보고",
      error: "오류",
      goal: "목표 갱신",
      system: "알림",
      skill: "스킬",
      subscription: "구독",
    };
    return `부재 중 ${activities.length}건: ${[...counts].map(([k, n]) => `${labels[k] ?? k} ${n}`).join(" · ")}`;
  }

  // --- 목표 (§8 트리) ---
  async createGoal(
    owner: string,
    input: Pick<TeamGoal, "roomId" | "title" | "level"> &
      Partial<Pick<TeamGoal, "parentId" | "stage" | "assignee" | "order" | "nextActions">>,
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
      status: "active",
      order: input.order ?? siblings.filter((g) => g.parentId === (input.parentId ?? null)).length,
      stage: input.stage ?? (input.level === "task" ? "detect" : undefined),
      assignee: input.assignee,
      nextActions: input.nextActions,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.db.put(owner, "team-goals", goal);
    await this.audit(owner, {
      packageId: null,
      goalId: goal.id,
      actor: "system",
      action: "goal.create",
      result: "ok",
    });
    this.bus.publish(owner, { type: "goal", roomId: goal.roomId, goalId: goal.id });
    this.bus.publish(owner, { type: "board", roomId: goal.roomId });
    return goal;
  }
  async goals(owner: string, roomId: string): Promise<TeamGoal[]> {
    return (await this.db.listByField<TeamGoal>(owner, "team-goals", "roomId", roomId)).sort(
      (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt),
    );
  }
  async updateGoal(
    owner: string,
    goalId: string,
    patch: Partial<Pick<TeamGoal, "progress" | "status" | "stage" | "metrics" | "nextActions" | "order" | "title">>,
    actor = "system",
  ): Promise<TeamGoal> {
    const goal = await this.db.get<TeamGoal>(owner, "team-goals", goalId);
    if (!goal) throw new AppError("목표를 찾을 수 없습니다", 404);
    const next: TeamGoal = { ...goal, ...patch, updatedAt: now() };
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
    const [goals, approvals, activities] = await Promise.all([
      this.goals(owner, roomId),
      this.db.listByField<{ status: string }>(owner, "approvals", "roomId", roomId),
      this.db.list<Activity>(owner, "activity"),
    ]);
    const flow = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<TaskStage, number>;
    for (const goal of goals)
      if (goal.level === "task" && goal.stage && goal.status !== "completed") flow[goal.stage]++;
    const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
    const agents = new Map<string, { done: number; errors: number }>();
    for (const a of activities)
      if (a.roomId === roomId && a.actor !== "system" && a.actor !== "user") {
        const entry = agents.get(a.actor) ?? { done: 0, errors: 0 };
        if (a.kind === "error") entry.errors++;
        else entry.done++;
        agents.set(a.actor, entry);
      }
    const byLevel = (["long", "mid", "short"] as GoalLevel[]).map((level) => {
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
    const progress = shortTerm?.count ? shortTerm.progress : (byLevel.find((b) => b.count)?.progress ?? 0);
    return {
      roomId,
      flow,
      pendingApprovals,
      agents: [...agents].map(([actor, v]) => ({ actor, ...v })),
      goals: byLevel,
      progress,
      presence: pendingApprovals > 0 ? "waiting" : this.bus.getPresence(owner, roomId),
    };
  }
}
