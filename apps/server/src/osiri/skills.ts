// 0Siri 스킬 생명주기 (0SIRI-SPEC §17 · 계약 «스킬 (화면 9)»).
//  - 개인 스킬은 owner=userId 의 `skills`, 패키지 공통 스킬은 owner="system" 의 `package-skills`(packageId 로 격리).
//  - 승인 없이는 장착되지 않는다. 개인 스킬은 그 사용자가, 패키지 공통 스킬은 그 패키지 운영자만 결정한다.
//  - 검수·컴플라이언스 기준을 완화하는 초안은 서버가 만들지 않는다 (§17.3).
//  - 모든 결정은 감사 로그(Rooms.audit)에 남는다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  SKILL_DECISIONS,
  SKILL_MEASURE_NOTE,
  SKILL_REPEAT_MIN,
  SKILL_REPEAT_PREFIX,
  SKILL_SCAN_LIMIT,
  SKILL_SCOPES,
  SKILL_SIMILARITY_MIN,
  SKILL_STATUSES,
  type SkillDecision,
  type SkillScope,
  type SkillStatus,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { asDocument, embed } from "./embeddings.ts";
import type { RoomMessage, Rooms } from "./rooms.ts";

/** 계약의 Skill. `packageId`·`enabled` 는 화면이 소속·켜짐을 알 수 있게 덧붙인 필드다. */
export interface Skill {
  id: string;
  roomId: string | null; // 패키지 공통 스킬은 null
  packageId: string | null; // 개인 방(영시리)의 개인 스킬은 null
  scope: SkillScope;
  name: string;
  version: string; // 같은 이름의 스킬 안에서 1부터 올라가는 정수 문자열
  status: SkillStatus;
  evidence: string;
  appliesTo: string;
  proposedBy: string;
  measuring: boolean;
  /** `measuring` 일 때만 — 측정이 어떻게 끝나는지(자동 수집이 아니라 팀 보고) */
  measureNote?: string;
  effect: string | null;
  enabled: boolean;
  createdAt: string;
}
/** 저장 전용 필드 — 응답에는 내보내지 않는다 (결정자 id 는 다른 구독자에게 보일 이유가 없다). */
interface StoredSkill extends Skill {
  supersedes?: string; // 이 버전이 장착되며 물러난 이전 버전 id (롤백 대상)
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}
type RoomRef = { id: string; packageId: string | null; archived?: boolean };
type Lineage = Pick<Skill, "scope" | "name" | "roomId" | "packageId">;

const PERSONAL_KIND = "skills";
const PACKAGE_KIND = "package-skills";
const PLATFORM = "system";
const now = () => new Date().toISOString();
const newestFirst = (a: Skill, b: Skill) =>
  b.createdAt.localeCompare(a.createdAt) || Number(b.version) - Number(a.version);

export const publicSkill = ({
  supersedes: _supersedes,
  decidedBy: _decidedBy,
  decidedAt: _decidedAt,
  reason: _reason,
  ...skill
}: StoredSkill): Skill => ({
  ...skill,
  // «효과 측정 중» 이 언제 끝나는지 숨기지 않는다 — 측정은 팀 보고가 와야 끝난다
  ...(skill.measuring ? { measureNote: SKILL_MEASURE_NOTE } : {}),
});

/** 결정별 허용 출발 상태와 도착 상태. 여기 없는 조합은 409. */
const TRANSITIONS: Record<SkillDecision, { from: SkillStatus[]; to: SkillStatus }> = {
  approve: { from: ["draft"], to: "active" },
  reject: { from: ["draft"], to: "rejected" },
  retire: { from: ["active", "retire_proposed"], to: "retired" },
  keep: { from: ["retire_proposed"], to: "active" },
};

export class Skills {
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
  ) {}

  private place(skill: Pick<Skill, "scope">, owner: string): [string, string] {
    return skill.scope === "personal" ? [owner, PERSONAL_KIND] : [PLATFORM, PACKAGE_KIND];
  }
  private packageSkillsStored(packageId: string) {
    return this.db.listByField<StoredSkill>(PLATFORM, PACKAGE_KIND, "packageId", packageId);
  }
  /** 같은 이름의 스킬 묶음(버전 계보). 개인은 그 사용자의 그 방, 패키지는 그 패키지 안에서만 본다. */
  private async lineage(owner: string, skill: Lineage): Promise<StoredSkill[]> {
    let all: StoredSkill[];
    if (skill.scope === "personal")
      all = (await this.db.list<StoredSkill>(owner, PERSONAL_KIND)).filter(
        (s) => s.roomId === skill.roomId,
      );
    else {
      if (!skill.packageId) throw new AppError("패키지 공통 스킬에 패키지 정보가 없습니다", 500);
      all = await this.packageSkillsStored(skill.packageId);
    }
    return all.filter((s) => s.name === skill.name);
  }

  // ---- 초안 (워커) ----
  /** 워커가 낸 초안. `loosens` 면 만들지 않고 감사 로그에 blocked 로 남긴 뒤 422 (§17.3). */
  async draft(
    owner: string,
    room: { roomId: string; packageId: string | null },
    input: {
      scope: SkillScope;
      name: string;
      evidence: string;
      appliesTo: string;
      proposedBy: string;
      loosens?: boolean;
    },
  ): Promise<Skill> {
    if (input.loosens) {
      await this.rooms.audit(owner, {
        packageId: room.packageId,
        roomId: room.roomId,
        actor: input.proposedBy,
        action: `skill.draft:${input.name}`,
        result: "blocked",
      });
      throw new AppError(
        "검수·컴플라이언스 기준을 완화하는 스킬 초안은 만들 수 없습니다. 품질 하한은 사람이 직접 바꿉니다",
        422,
      );
    }
    if (input.scope === "package" && !room.packageId)
      throw new AppError("개인 방에서는 패키지 공통 스킬을 제안할 수 없습니다", 422);
    const target: Lineage = {
      scope: input.scope,
      name: input.name,
      roomId: input.scope === "personal" ? room.roomId : null,
      packageId: room.packageId,
    };
    const versions = (await this.lineage(owner, target)).map((s) => Number(s.version));
    const skill: StoredSkill = {
      id: randomUUID(),
      ...target,
      version: String(Math.max(0, ...versions) + 1),
      status: "draft",
      evidence: input.evidence,
      appliesTo: input.appliesTo,
      proposedBy: input.proposedBy,
      measuring: false,
      effect: null,
      enabled: true,
      createdAt: now(),
    };
    const [scopeOwner, kind] = this.place(skill, owner);
    await this.db.put(scopeOwner, kind, skill);
    await this.rooms.audit(owner, {
      packageId: room.packageId,
      roomId: room.roomId,
      actor: input.proposedBy,
      action: `skill.draft:${skill.name}@v${skill.version}`,
      sourceRefs: [skill.id],
      result: "ok",
    });
    // 개인 스킬 초안은 사용자가 결정할 일이다 — 활동에 남겨 결재함·배지가 바로 갱신되게 한다(inbox 이벤트).
    // 패키지 공통 초안은 운영자 콘솔(pendingSkills)로 간다
    if (skill.scope === "personal")
      await this.rooms.activity(owner, {
        roomId: room.roomId,
        kind: "skill",
        actor: input.proposedBy,
        title: `스킬 초안: ${skill.name}`,
        detail: skill.evidence,
      });
    return publicSkill(skill);
  }

  // ---- 스킬 후보 찾기 ----
  /**
   * 내가 여러 번 비슷하게 요청한 것을 찾아 개인 스킬 초안으로 낸다(결정은 사용자가 스킬 탭에서).
   * 최근 요청을 임베딩해 탐욕적으로 묶고(첫 요청이 기준), `SKILL_REPEAT_MIN` 번 이상 반복된 묶음만 초안이 된다.
   * 같은 이름의 스킬이 이미 있으면(어떤 상태든) 다시 내지 않는다.
   * 임베딩이 실패하면 그대로 실패한다 — 후보가 «없다» 로 보이게 삼키지 않는다.
   * ponytail: 요청 n개에 묶음 k개 → O(n·k) 내적. SKILL_SCAN_LIMIT(200) 안에서는 충분하다.
   */
  async findCandidates(
    owner: string,
    embedTexts: (texts: string[]) => Promise<number[][]> = (texts) =>
      embed(texts.map((t) => asDocument(t))),
  ): Promise<{ scanned: number; created: Skill[] }> {
    const asks = (await this.db.list<RoomMessage>(owner, "messages"))
      .filter((m) => m.role === "user" && (m.text ?? "").trim().length >= 6)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, SKILL_SCAN_LIMIT);
    if (asks.length < SKILL_REPEAT_MIN) return { scanned: asks.length, created: [] };
    const vectors = await embedTexts(asks.map((m) => (m.text ?? "").trim()));
    const groups: { seed: number[]; items: RoomMessage[] }[] = [];
    asks.forEach((ask, i) => {
      const v = vectors[i] as number[];
      const group = groups.find(
        (g) => g.seed.reduce((sum, x, k) => sum + x * (v[k] ?? 0), 0) >= SKILL_SIMILARITY_MIN,
      );
      if (group) group.items.push(ask);
      else groups.push({ seed: v, items: [ask] });
    });
    const taken = new Set(
      (await this.db.list<StoredSkill>(owner, PERSONAL_KIND)).map((s) => s.name),
    );
    const created: Skill[] = [];
    for (const { items } of groups.filter((g) => g.items.length >= SKILL_REPEAT_MIN)) {
      const oldest = items[items.length - 1] as RoomMessage;
      const name = `${SKILL_REPEAT_PREFIX}${(oldest.text ?? "").trim().slice(0, 40)}`;
      if (taken.has(name)) continue;
      const room = await this.rooms.get(owner, oldest.roomId);
      const examples = items.slice(0, 3).map((m) => `«${(m.text ?? "").trim().slice(0, 80)}»`);
      created.push(
        await this.draft(
          owner,
          { roomId: room.id, packageId: room.packageId },
          {
            scope: "personal",
            name,
            evidence: `최근 ${items.length}번 비슷하게 요청했습니다 — ${examples.join(" · ")}`,
            appliesTo: `${room.title} 대화에서 같은 종류의 요청을 받으면, 매번 처음부터 묻지 않고 이 방식으로 바로 처리합니다`,
            proposedBy: "영시리",
          },
        ),
      );
      taken.add(name);
    }
    return { scanned: asks.length, created };
  }

  // ---- 조회 ----
  /** 결재를 기다리는 내 개인 스킬 초안(오래된 순) — 결재함(`/inbox`)이 승인 대기와 함께 낸다. */
  async pendingDrafts(owner: string, roomId?: string): Promise<Skill[]> {
    return (await this.db.list<StoredSkill>(owner, PERSONAL_KIND))
      .filter((s) => s.status === "draft" && (!roomId || s.roomId === roomId))
      .map(publicSkill)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** 내 개인 스킬 + 내가 구독한 패키지의 공통 스킬(보이기만 한다). 최신순. */
  async listForUser(
    owner: string,
    filter: { roomId?: string; status?: SkillStatus; scope?: SkillScope } = {},
  ): Promise<Skill[]> {
    // room_id 가 내 방이 아니면 Rooms.get 이 404 — 남의 방 id 로 패키지 스킬을 엿볼 수 없다
    const mine: RoomRef[] = filter.roomId
      ? [await this.rooms.get(owner, filter.roomId)]
      : (await this.db.list<RoomRef>(owner, "rooms")).filter((room) => !room.archived);
    const packageIds = [
      ...new Set(mine.flatMap((room) => (room.packageId ? [room.packageId] : []))),
    ];
    const [personal, ...shared] = await Promise.all([
      this.db.list<StoredSkill>(owner, PERSONAL_KIND),
      ...packageIds.map((id) => this.packageSkillsStored(id)),
    ]);
    return [
      ...personal.filter((s) => !filter.roomId || s.roomId === filter.roomId),
      ...shared.flat(),
    ]
      .filter(
        (s) =>
          (!filter.status || s.status === filter.status) &&
          (!filter.scope || s.scope === filter.scope),
      )
      .map(publicSkill)
      .sort(newestFirst);
  }
  /**
   * 워커가 읽는 그 방의 개인 스킬(최신순) — 반려 사유(`reason`)를 함께 준다.
   * 초안을 낸 팀이 왜 반려됐는지 알고 다음 초안을 고치는 길이다 (§17 «사유와 함께 회신»).
   */
  async forWorker(owner: string, roomId: string): Promise<(Skill & { reason?: string })[]> {
    return (await this.db.list<StoredSkill>(owner, PERSONAL_KIND))
      .filter((s) => s.roomId === roomId)
      .map((s) => ({ ...publicSkill(s), ...(s.reason ? { reason: s.reason } : {}) }))
      .sort(newestFirst);
  }
  /** 그 방 팀이 지금 장착한 스킬 — 켜져 있는 활성 스킬만 (팀 런타임이 역할 지시에 붙인다) */
  async equipped(owner: string, roomId: string): Promise<Skill[]> {
    return (await this.listForUser(owner, { roomId })).filter(
      (s) => (s.status === "active" || s.status === "retire_proposed") && s.enabled,
    );
  }
  /** 한 패키지의 공통 스킬 (운영자 콘솔). 소유 확인은 호출자(Operator)가 먼저 한다. */
  async packageSkills(packageId: string): Promise<Skill[]> {
    return (await this.packageSkillsStored(packageId)).map(publicSkill).sort(newestFirst);
  }
  async packageSkill(id: string): Promise<Skill> {
    const skill = await this.db.get<StoredSkill>(PLATFORM, PACKAGE_KIND, id);
    if (!skill) throw new AppError("스킬을 찾을 수 없습니다", 404);
    return publicSkill(skill);
  }
  /** 사용자가 볼 수 있는 스킬만 찾는다 — 내 개인 스킬이거나, 내가 구독한 패키지의 공통 스킬. 그 밖은 404. */
  private async visible(owner: string, id: string): Promise<StoredSkill> {
    const personal = await this.db.get<StoredSkill>(owner, PERSONAL_KIND, id);
    if (personal) return personal;
    const shared = await this.db.get<StoredSkill>(PLATFORM, PACKAGE_KIND, id);
    if (shared) {
      const rooms = await this.db.list<RoomRef>(owner, "rooms");
      if (rooms.some((room) => room.packageId === shared.packageId)) return shared;
    }
    throw new AppError("스킬을 찾을 수 없습니다", 404);
  }
  /** 사용자 화면의 쓰기는 개인 스킬에만 — 패키지 공통 스킬이면 403. */
  private async personal(owner: string, id: string, what: string): Promise<StoredSkill> {
    const skill = await this.visible(owner, id);
    if (skill.scope !== "personal")
      throw new AppError(`패키지 공통 스킬은 운영자만 ${what}할 수 있습니다`, 403);
    return skill;
  }

  // ---- 결정 ----
  async decideAsUser(owner: string, id: string, decision: SkillDecision, reason?: string) {
    const skill = await this.personal(owner, id, "결정");
    return this.apply(owner, owner, skill, decision, reason);
  }
  /** 운영자 결정. 호출자(Operator)가 이 스킬의 packageId 소유를 확인한 뒤에만 부른다. */
  async decideAsOperator(operatorId: string, id: string, decision: SkillDecision, reason?: string) {
    const skill = await this.db.get<StoredSkill>(PLATFORM, PACKAGE_KIND, id);
    if (!skill) throw new AppError("스킬을 찾을 수 없습니다", 404);
    return this.apply(PLATFORM, operatorId, skill, decision, reason);
  }
  /** 상태를 원자적으로 옮긴다(동시 결정 방지). 못 옮기면 저장된 현재 상태를 문장으로 알린다. */
  private async swap(
    scopeOwner: string,
    kind: string,
    skill: StoredSkill,
    patch: Partial<StoredSkill>,
  ): Promise<StoredSkill> {
    const updated = await this.db.compareAndSwap<StoredSkill>(
      scopeOwner,
      kind,
      skill.id,
      { status: skill.status },
      patch,
    );
    if (!updated) {
      const current = await this.db.get<StoredSkill>(scopeOwner, kind, skill.id);
      throw new AppError(
        `다른 결정이 먼저 반영되었습니다 (현재 상태: ${current?.status ?? "삭제됨"})`,
        409,
      );
    }
    return updated;
  }
  private async apply(
    scopeOwner: string,
    actor: string,
    skill: StoredSkill,
    decision: SkillDecision,
    reason?: string,
  ): Promise<Skill> {
    const rule = TRANSITIONS[decision];
    if (!rule.from.includes(skill.status))
      throw new AppError(
        `지금 상태(${skill.status})에서는 이 결정(${decision})을 내릴 수 없습니다`,
        409,
      );
    const kind = skill.scope === "personal" ? PERSONAL_KIND : PACKAGE_KIND;
    // 새 버전이 장착되면 같은 이름의 기존 장착본은 물러난다 — 롤백이 되돌릴 대상으로 기억한다
    const previous =
      decision === "approve"
        ? (await this.lineage(scopeOwner, skill)).find(
            (s) => s.id !== skill.id && (s.status === "active" || s.status === "retire_proposed"),
          )
        : undefined;
    const updated = await this.swap(scopeOwner, kind, skill, {
      status: rule.to,
      decidedBy: actor,
      decidedAt: now(),
      ...(reason ? { reason } : {}),
      // 장착 직후에는 효과를 아직 모른다 — 측정 중. 폐기·반려되면 측정도 끝난다
      ...(decision === "approve" ? { measuring: true, effect: null } : {}),
      ...(rule.to === "retired" || rule.to === "rejected" ? { measuring: false } : {}),
      ...(previous ? { supersedes: previous.id } : {}),
    });
    if (previous)
      await this.swap(scopeOwner, kind, previous, { status: "retired", measuring: false });
    await this.rooms.audit(actor, {
      packageId: skill.packageId,
      ...(skill.roomId ? { roomId: skill.roomId } : {}),
      actor,
      action: `skill.${decision}:${skill.name}@v${skill.version}`,
      sourceRefs: [skill.id],
      result: "ok",
    });
    return publicSkill(updated);
  }
  /** 이전 버전으로 롤백: 지금 장착본은 폐기되고, 그것이 밀어냈던 버전이 다시 장착된다. */
  async rollback(owner: string, id: string): Promise<Skill> {
    const skill = await this.personal(owner, id, "롤백");
    if (skill.status !== "active" && skill.status !== "retire_proposed")
      throw new AppError("장착된 스킬만 이전 버전으로 되돌릴 수 있습니다", 409);
    const previous = skill.supersedes
      ? await this.db.get<StoredSkill>(owner, PERSONAL_KIND, skill.supersedes)
      : null;
    if (!previous) throw new AppError("되돌릴 이전 버전이 없습니다", 409);
    await this.swap(owner, PERSONAL_KIND, skill, { status: "retired", measuring: false });
    const restored = await this.swap(owner, PERSONAL_KIND, previous, {
      status: "active",
      measuring: true,
      effect: null,
    });
    await this.rooms.audit(owner, {
      packageId: skill.packageId,
      ...(skill.roomId ? { roomId: skill.roomId } : {}),
      actor: owner,
      action: `skill.rollback:${skill.name}@v${skill.version}->v${previous.version}`,
      sourceRefs: [skill.id, previous.id],
      result: "ok",
    });
    return publicSkill(restored);
  }
  /** 개인 스킬 끄기·켜기. 장착 상태는 그대로 두고 적용만 멈춘다. */
  async setEnabled(owner: string, id: string, enabled: boolean): Promise<Skill> {
    const skill = await this.personal(owner, id, "설정");
    const next: StoredSkill = { ...skill, enabled };
    await this.db.put(owner, PERSONAL_KIND, next);
    await this.rooms.audit(owner, {
      packageId: skill.packageId,
      ...(skill.roomId ? { roomId: skill.roomId } : {}),
      actor: owner,
      action: `skill.${enabled ? "enable" : "disable"}:${skill.name}@v${skill.version}`,
      sourceRefs: [skill.id],
      result: "ok",
    });
    return publicSkill(next);
  }
  /**
   * 효과 측정 결과 보고 (워커 `POST /worker/skills/:id/effect`). 측정이 끝난다:
   * 나빠졌으면 폐기 제안(`proposeRetire`), 아니면 효과 문장만 남기고 계속 장착.
   * ponytail: 지표를 자동으로 모으는 파이프라인은 없다 — 팀이 보고할 때만 측정이 끝난다. 그 사실은 응답의 measureNote 가 밝힌다.
   */
  async reportEffect(
    owner: string,
    roomId: string,
    id: string,
    input: { effect: string; worse: boolean },
  ): Promise<Skill> {
    // 한 구독자의 워커가 패키지 공통 스킬(모든 구독자 몫)을 움직이지 못한다 — 개인 스킬, 그것도 그 방 것만
    const skill = await this.personal(owner, id, "효과 보고");
    if (skill.roomId !== roomId) throw new AppError("다른 방의 스킬입니다", 403);
    if (input.worse) return this.proposeRetire(owner, id, input.effect);
    if (skill.status !== "active")
      throw new AppError("장착된 스킬에만 효과를 보고할 수 있습니다", 409);
    const [scopeOwner, kind] = this.place(skill, owner);
    const updated = await this.swap(scopeOwner, kind, skill, {
      measuring: false,
      effect: input.effect,
    });
    await this.rooms.audit(owner, {
      packageId: skill.packageId,
      ...(skill.roomId ? { roomId: skill.roomId } : {}),
      actor: "system",
      action: `skill.effect:${skill.name}@v${skill.version}`,
      sourceRefs: [skill.id],
      result: "ok",
    });
    return publicSkill(updated);
  }
  /** 측정 결과 악화 → 폐기 제안 (§17.2-5). 결정은 여전히 사람이 한다(retire|keep). `reportEffect` 가 부른다. */
  async proposeRetire(owner: string, id: string, effect: string): Promise<Skill> {
    const skill = await this.visible(owner, id);
    if (skill.status !== "active")
      throw new AppError("장착된 스킬에만 폐기를 제안할 수 있습니다", 409);
    const [scopeOwner, kind] = this.place(skill, owner);
    const updated = await this.swap(scopeOwner, kind, skill, {
      status: "retire_proposed",
      measuring: false,
      effect,
    });
    await this.rooms.audit(owner, {
      packageId: skill.packageId,
      ...(skill.roomId ? { roomId: skill.roomId } : {}),
      actor: "system",
      action: `skill.retire_proposed:${skill.name}@v${skill.version}`,
      sourceRefs: [skill.id],
      result: "ok",
    });
    // 폐기 제안은 사용자가 결정해야 한다 — 개인 스킬이면 그 방 활동에 남겨 알린다
    if (skill.scope === "personal" && skill.roomId)
      await this.rooms.activity(owner, {
        roomId: skill.roomId,
        kind: "skill",
        actor: "system",
        title: `스킬 폐기 제안: ${skill.name}`,
        detail: effect,
      });
    return publicSkill(updated);
  }
}

/** 화면 9 스킬 라우트 — /api 아래, 사용자 인증 뒤. */
export function skillRoutes(skills: Skills) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/skills", async (c) =>
    c.json(
      await skills.listForUser(c.get("owner"), {
        roomId: c.req.query("room_id") || undefined,
        status: z
          .enum(SKILL_STATUSES)
          .optional()
          .parse(c.req.query("status") || undefined),
        scope: z
          .enum(SKILL_SCOPES)
          .optional()
          .parse(c.req.query("scope") || undefined),
      }),
    ),
  );
  app.post("/skills/scan", async (c) => c.json(await skills.findCandidates(c.get("owner"))));
  app.post("/skills/:id/decide", async (c) => {
    const body = z
      .object({ decision: z.enum(SKILL_DECISIONS), reason: z.string().max(1000).optional() })
      .parse(await c.req.json());
    return c.json(
      await skills.decideAsUser(c.get("owner"), c.req.param("id"), body.decision, body.reason),
    );
  });
  app.post("/skills/:id/rollback", async (c) =>
    c.json(await skills.rollback(c.get("owner"), c.req.param("id"))),
  );
  app.patch("/skills/:id", async (c) => {
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    return c.json(await skills.setEnabled(c.get("owner"), c.req.param("id"), body.enabled));
  });
  return app;
}

/**
 * 워커 스킬 초안 라우트 — /api/worker 에, **workerRoutes 바로 뒤에** 마운트한다.
 * 워커 토큰 인증은 workerRoutes 의 미들웨어 하나가 /api/worker/* 전체에 건다(인증 조립부를 둘로 만들지 않는다).
 * 그 미들웨어가 앞에 없으면 owner·roomId 가 비어 있으므로 여기서 401 로 막는다 (fail-closed).
 */
export function skillWorkerRoutes(skills: Skills) {
  type WorkerEnv = { Variables: { owner?: string; roomId?: string; packageId?: string | null } };
  const app = new Hono<WorkerEnv>();
  app.post("/skills", async (c) => {
    const owner = c.get("owner");
    const roomId = c.get("roomId");
    if (!owner || !roomId) throw new AppError("워커 토큰이 필요합니다", 401);
    const body = z
      .object({
        scope: z.enum(SKILL_SCOPES),
        name: z.string().min(1).max(120),
        evidence: z.string().min(1).max(4000),
        appliesTo: z.string().min(1).max(1000),
        actor: z.string().min(1).max(60),
        loosens: z.boolean().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await skills.draft(
        owner,
        { roomId, packageId: c.get("packageId") ?? null },
        {
          scope: body.scope,
          name: body.name,
          evidence: body.evidence,
          appliesTo: body.appliesTo,
          proposedBy: body.actor,
          loosens: body.loosens,
        },
      ),
    );
  });
  app.get("/skills", async (c) => {
    const owner = c.get("owner");
    const roomId = c.get("roomId");
    if (!owner || !roomId) throw new AppError("워커 토큰이 필요합니다", 401);
    return c.json(await skills.forWorker(owner, roomId));
  });
  // 효과 측정 결과 — 나빠졌으면(worse) 폐기 제안으로 넘어가고, 아니면 측정을 끝내고 효과 문장을 남긴다
  app.post("/skills/:id/effect", async (c) => {
    const owner = c.get("owner");
    const roomId = c.get("roomId");
    if (!owner || !roomId) throw new AppError("워커 토큰이 필요합니다", 401);
    const body = z
      .object({ effect: z.string().min(1).max(1000), worse: z.boolean() })
      .parse(await c.req.json());
    return c.json(await skills.reportEffect(owner, roomId, c.req.param("id"), body));
  });
  return app;
}
