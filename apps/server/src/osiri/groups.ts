// 단체 톡 (마스터 2026-10-11 «사용자를 전화번호로 초대해서(닉네임 설정) 단체 톡, 그 톡에 봇 초대»).
//  - 방·메시지는 여러 사람이 같이 보므로 "system" 아래에 둔다. 내가 든 방은 내 owner 아래 group-memberships 로 찾는다.
//  - 초대: 회원 번호면 바로 들어오고, 아니면 번호에 묶인 대기 초대 + 가입 초대 링크. 가입하고 방 목록을 열면 대기 초대가 풀린다.
//  - 방장(ownerId)만 초대·내보내기. 닉네임은 방마다 따로(초대할 때 방장이 정하고, 본인이 바꿀 수 있다).
// ponytail: 새 메시지는 화면이 3초마다 after=seq 로 묻는다. 사람이 많아지면 사용자 스트림(EventBus)로 밀어 준다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  GROUP_NICKNAME_MAX,
  GROUP_TEXT_MAX,
  GROUP_TITLE_MAX,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { type Accounts, maskPhone, normalizePhone } from "./accounts.ts";

export interface GroupMember {
  userId: string;
  nickname: string;
}
export interface Group {
  id: string;
  title: string;
  ownerId: string;
  members: GroupMember[];
  createdAt: string;
  /** 마지막 메시지 순번 — 새 메시지는 이 다음 번호를 받는다 */
  seq: number;
  /** «운영자와 대화» 방: 구독자(방장) + 그 팀 운영자. 초대는 막는다 */
  kind?: "operator";
  packageId?: string;
}
export interface GroupInvite {
  id: string;
  groupId: string;
  phone: string;
  nickname: string;
  invitedBy: string;
  createdAt: string;
}
export interface GroupMessage {
  id: string;
  groupId: string;
  seq: number;
  /** 사람이면 userId, 봇이면 "bot:<id>", 안내면 "system" */
  authorId: string;
  nickname: string;
  text: string;
  createdAt: string;
}
/** 받은 메시지를 보고 답할 것이 있으면 답하는 쪽(봇). 단체 톡은 봇을 몰라도 된다 */
export type GroupListener = (group: Group, message: GroupMessage) => Promise<void>;

export class Groups {
  private readonly listeners: GroupListener[] = [];
  constructor(
    private readonly db: Store,
    private readonly accounts: Accounts,
  ) {}
  onMessage(listener: GroupListener) {
    this.listeners.push(listener);
  }

  async get(groupId: string): Promise<Group> {
    const group = await this.db.get<Group>("system", "groups", groupId);
    if (!group) throw new AppError("단체 톡을 찾을 수 없습니다", 404);
    return group;
  }
  /** 멤버만 본다. 아니면 있는지도 알려 주지 않는다(404). */
  async forMember(userId: string, groupId: string): Promise<Group> {
    const group = await this.get(groupId);
    if (!group.members.some((m) => m.userId === userId))
      throw new AppError("단체 톡을 찾을 수 없습니다", 404);
    return group;
  }
  private async defaultNickname(userId: string) {
    return (
      (await this.accounts.profile(userId)).displayName.trim().slice(0, GROUP_NICKNAME_MAX) || "나"
    );
  }
  private async join(group: Group, member: GroupMember) {
    group.members.push(member);
    await this.db.put("system", "groups", group);
    await this.db.put(member.userId, "group-memberships", { id: group.id });
    await this.post(group, "system", "안내", `${member.nickname} 님이 들어왔습니다`);
  }

  async create(userId: string, title: string): Promise<Group> {
    const group: Group = {
      id: randomUUID(),
      title,
      ownerId: userId,
      members: [],
      createdAt: new Date().toISOString(),
      seq: 0,
    };
    await this.join(group, { userId, nickname: await this.defaultNickname(userId) });
    return group;
  }
  /** 내 방 목록. 내 번호로 와 있던 대기 초대를 먼저 푼다(가입 뒤 처음 열 때 들어온다). */
  async mine(userId: string) {
    const user = await this.accounts.userById(userId);
    if (user?.phone)
      for (const invite of await this.db.listByField<GroupInvite>(
        "system",
        "group-invites",
        "phone",
        user.phone,
      )) {
        await this.db.remove("system", "group-invites", invite.id);
        const group = await this.db.get<Group>("system", "groups", invite.groupId);
        if (group && !group.members.some((m) => m.userId === userId))
          await this.join(group, { userId, nickname: invite.nickname });
      }
    const ids = (await this.db.list<{ id: string }>(userId, "group-memberships")).map((m) => m.id);
    const groups = (
      await Promise.all(ids.map((id) => this.db.get<Group>("system", "groups", id)))
    ).filter((g): g is Group => !!g && g.members.some((m) => m.userId === userId));
    return groups.map((g) => this.view(g, userId));
  }
  view(group: Group, userId: string) {
    return { ...group, mine: group.ownerId === userId };
  }

  /** 구독자 ↔ 팀 운영자 방. 구독자·팀마다 하나(id 고정). 새로 지정된 운영자는 열 때 들어온다. */
  async operatorChat(
    userId: string,
    pkg: { id: string; name: string },
    operators: { ids: string[]; fallback: boolean },
  ) {
    const id = `operator-${pkg.id}-${userId}`;
    let group = await this.db.get<Group>("system", "groups", id);
    if (!group) {
      group = {
        id,
        title: `${pkg.name} · 운영자`,
        ownerId: userId,
        members: [],
        createdAt: new Date().toISOString(),
        seq: 0,
        kind: "operator",
        packageId: pkg.id,
      };
      await this.join(group, { userId, nickname: await this.defaultNickname(userId) });
      if (operators.fallback)
        await this.post(
          group,
          "system",
          "안내",
          "이 팀에 지정된 운영자가 아직 없어 관리자가 받습니다",
        );
    }
    for (const op of operators.ids)
      if (op !== userId && !group.members.some((m) => m.userId === op))
        await this.join(group, { userId: op, nickname: operators.fallback ? "관리자" : "운영자" });
    return this.view(group, userId);
  }
  /** 방장이 번호로 초대. 회원이면 바로 들어오고, 아니면 대기 + 가입 초대(이미 남이 초대한 번호면 대기만). */
  async invite(
    userId: string,
    groupId: string,
    input: { phone: string; nickname: string },
  ): Promise<{ joined: boolean; phoneHint: string; inviteToken?: string }> {
    const group = await this.forMember(userId, groupId);
    if (group.ownerId !== userId) throw new AppError("방장만 초대할 수 있습니다", 403);
    if (group.kind === "operator")
      throw new AppError("운영자와의 대화에는 다른 사람을 초대할 수 없습니다", 403);
    const phone = normalizePhone(input.phone);
    const target = await this.accounts.userByPhone(phone);
    if (target) {
      if (group.members.some((m) => m.userId === target.id))
        throw new AppError("이미 이 단체 톡에 있습니다", 409);
      await this.join(group, { userId: target.id, nickname: input.nickname });
      return { joined: true, phoneHint: maskPhone(phone) };
    }
    for (const old of await this.db.listByField<GroupInvite>(
      "system",
      "group-invites",
      "phone",
      phone,
    ))
      if (old.groupId === groupId) await this.db.remove("system", "group-invites", old.id);
    await this.db.put("system", "group-invites", {
      id: randomUUID(),
      groupId,
      phone,
      nickname: input.nickname,
      invitedBy: userId,
      createdAt: new Date().toISOString(),
    } satisfies GroupInvite);
    let inviteToken: string | undefined;
    try {
      inviteToken = (await this.accounts.inviteByPhone(userId, phone)).token;
    } catch (error) {
      // 다른 회원이 이미 가입 초대를 보낸 번호 — 그 링크로 가입해도 이 방 대기 초대는 풀린다
      if (!(error instanceof AppError && error.status === 409)) throw error;
    }
    return { joined: false, phoneHint: maskPhone(phone), inviteToken };
  }
  async rename(userId: string, groupId: string, nickname: string) {
    const group = await this.forMember(userId, groupId);
    group.members = group.members.map((m) => (m.userId === userId ? { ...m, nickname } : m));
    await this.db.put("system", "groups", group);
    return this.view(group, userId);
  }
  /** 방장은 남을 내보내고, 누구나 스스로 나간다. 방장은 나갈 수 없다(방이 주인을 잃는다). */
  async remove(userId: string, groupId: string, memberId: string) {
    const group = await this.forMember(userId, groupId);
    if (memberId !== userId && group.ownerId !== userId)
      throw new AppError("방장만 내보낼 수 있습니다", 403);
    if (memberId === group.ownerId) throw new AppError("방장은 나갈 수 없습니다", 409);
    const member = group.members.find((m) => m.userId === memberId);
    if (!member) throw new AppError("멤버가 아닙니다", 404);
    group.members = group.members.filter((m) => m.userId !== memberId);
    await this.db.put("system", "groups", group);
    await this.db.remove(memberId, "group-memberships", groupId);
    await this.post(group, "system", "안내", `${member.nickname} 님이 나갔습니다`);
  }

  async messages(userId: string, groupId: string, after = 0) {
    await this.forMember(userId, groupId);
    return (await this.db.listByField<GroupMessage>("system", "group-messages", "groupId", groupId))
      .filter((m) => m.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(-200);
  }
  /** 사람이 쓴 말 — 멤버만. 저장 뒤 봇에게 알린다(봇 실패는 대화를 막지 않고 로그에 남긴다). */
  async say(userId: string, groupId: string, text: string): Promise<GroupMessage> {
    const group = await this.forMember(userId, groupId);
    const nickname = group.members.find((m) => m.userId === userId)?.nickname ?? "?";
    const message = await this.post(group, userId, nickname, text);
    for (const listener of this.listeners)
      void listener(group, message).catch((error) =>
        console.error(`[osiri] 단체 톡 ${groupId} 봇 처리 실패: ${(error as Error).message}`),
      );
    return message;
  }
  /** 메시지 한 줄을 붙인다. 봇·안내도 이 길을 쓴다. ponytail: seq 는 방 행의 카운터 — 동시에 두 줄이 오면 같은 번호가 날 수 있다(id 는 다르다). */
  async post(group: Group, authorId: string, nickname: string, text: string) {
    const fresh = (await this.db.get<Group>("system", "groups", group.id)) ?? group;
    const seq = (fresh.seq ?? 0) + 1;
    await this.db.put("system", "groups", { ...fresh, seq });
    group.seq = seq;
    const message: GroupMessage = {
      id: randomUUID(),
      groupId: group.id,
      seq,
      authorId,
      nickname,
      text,
      createdAt: new Date().toISOString(),
    };
    await this.db.put("system", "group-messages", message);
    return message;
  }
}

export function groupRoutes(
  groups: Groups,
  publicUrl: string,
  /** 내 팀 방 → 그 팀과 맡은 운영자 (app.ts 가 rooms·catalog·operator 로 채운다) */
  operatorsFor: (
    owner: string,
    roomId: string,
  ) => Promise<{
    pkg: { id: string; name: string };
    operators: { ids: string[]; fallback: boolean };
  }>,
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const nickname = z.string().trim().min(1).max(GROUP_NICKNAME_MAX);
  app.get("/groups", async (c) => c.json(await groups.mine(c.get("owner"))));
  app.post("/groups", async (c) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(GROUP_TITLE_MAX) })
      .parse(await c.req.json());
    const group = await groups.create(c.get("owner"), body.title);
    return c.json(groups.view(group, c.get("owner")), 201);
  });
  app.post("/rooms/:roomId/operator-chat", async (c) => {
    const { pkg, operators } = await operatorsFor(c.get("owner"), c.req.param("roomId"));
    return c.json(await groups.operatorChat(c.get("owner"), pkg, operators));
  });
  app.get("/groups/:id", async (c) =>
    c.json(groups.view(await groups.forMember(c.get("owner"), c.req.param("id")), c.get("owner"))),
  );
  app.post("/groups/:id/invite", async (c) => {
    const body = z.object({ phone: z.string().min(1).max(40), nickname }).parse(await c.req.json());
    const { inviteToken, ...result } = await groups.invite(c.get("owner"), c.req.param("id"), body);
    return c.json({ ...result, link: inviteToken ? `${publicUrl}/invite/${inviteToken}` : null });
  });
  app.patch("/groups/:id/nickname", async (c) => {
    const body = z.object({ nickname }).parse(await c.req.json());
    return c.json(await groups.rename(c.get("owner"), c.req.param("id"), body.nickname));
  });
  app.delete("/groups/:id/members/:userId", async (c) => {
    await groups.remove(c.get("owner"), c.req.param("id"), c.req.param("userId"));
    return c.json({ ok: true });
  });
  app.get("/groups/:id/messages", async (c) =>
    c.json(
      await groups.messages(
        c.get("owner"),
        c.req.param("id"),
        Number(c.req.query("after") ?? 0) || 0,
      ),
    ),
  );
  app.post("/groups/:id/messages", async (c) => {
    const body = z
      .object({ text: z.string().trim().min(1).max(GROUP_TEXT_MAX) })
      .parse(await c.req.json());
    return c.json(await groups.say(c.get("owner"), c.req.param("id"), body.text), 201);
  });
  return app;
}
