// 0Siri 계정 — 전화번호+비밀번호 자체 로그인, 초대 링크, 프로필, 역할 (0SIRI-SPEC §4.1, §20, §24-4 · DECISIONS 2026-10-09 전화번호)
// 저장은 openmuse 문서 저장소(records)를 그대로 쓴다: owner="system" 아래 users / phone-index / invites / sessions,
// 사용자 소유 데이터(profiles)는 owner=userId.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type AccountTier,
  INVITE_ALREADY_MEMBER_MESSAGE,
  INVITE_PHONE_MISMATCH_MESSAGE,
  INVITE_TAKEN_MESSAGE,
  type InviteStatus,
  type NetworkNodeStatus,
  PASSWORD_MIN,
  RETENTION_DAYS,
  type UserRole,
  WAITLIST_ALREADY_PENDING_MESSAGE,
  WAITLIST_PENDING_LOGIN_MESSAGE,
  WAITLIST_PURPOSE_MAX,
  WAITLIST_PURPOSE_MESSAGE,
  WAITLIST_PURPOSE_MIN,
  type WaitlistStatus,
  waitlistRejectedMessage,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export type Role = UserRole;
export type Tier = AccountTier;

/** 종류가 붙는 실패 — 라우트가 `{ error, kind }` 본문으로 낸다 (계약: 등급 미달 "tier", 모델 키 "format"|"auth"|"network"). */
export class KindError<K extends string = string> extends AppError {
  constructor(
    message: string,
    status: AppError["status"],
    readonly kind: K,
  ) {
    super(message, status);
    this.name = "KindError";
  }
}

export interface User {
  id: string;
  phone: string;
  passwordHash: string;
  role: Role;
  tier: Tier;
  createdAt: string;
  /** 나를 들인 회원(초대한 사람 · 가입 신청을 승인하며 관리자가 붙인 상위 회원)의 id. 뿌리·옛 계정은 없다 */
  invitedBy?: string | null;
  /** 탈퇴 요청 시각. 있으면 로그인이 막힌다 */
  deleteRequestedAt?: string;
  /** 이 시각이 지나면 정리(sweep)가 계정과 데이터를 지운다 */
  deleteAfter?: string;
}
export interface Profile {
  id: "me";
  displayName: string;
  credentialText?: string;
  onboardedAt?: string;
  /** 사무소 프로필 — 전문 분야·지역 (온보딩 2단계) */
  specialty?: string;
  region?: string;
}
/** 가입 신청. 번호당 한 줄(id = 정규화한 전화번호). 옛 항목은 번호만 있다(비밀번호·목적 없음 → 승인 불가). */
export interface WaitlistEntry {
  id: string; // 정규화한 전화번호
  /** 관리자 API·감사 로그가 쓰는 식별자 — 전화번호를 주소·로그에 싣지 않으려고 따로 둔다 */
  ref?: string;
  requestedAt: string;
  status?: WaitlistStatus; // 없으면 pending (옛 항목)
  purpose?: string;
  /** 비밀번호는 해시로만 둔다. 승인하면 사용자 행으로 옮기고 여기서는 지운다 */
  passwordHash?: string;
  decidedAt?: string;
  parentId?: string;
  rejectReason?: string;
  userId?: string;
}
/** `GET /admin/waitlist` 항목 — 해시는 싣지 않는다 */
export interface WaitlistView {
  id: string;
  phone: string;
  purpose: string;
  status: WaitlistStatus;
  requestedAt: string;
  decidedAt?: string;
  parentId?: string;
  rejectReason?: string;
}
/** `GET /invites` 항목 */
export interface InviteView {
  id: string;
  phone: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  joinedUserId?: string;
}
/** `GET /network` 의 마디 — 부르는 사람 아래로만 내려간다 */
export interface NetworkNode {
  id: string;
  name: string | null;
  phone: string;
  status: NetworkNodeStatus;
  joinedAt: string | null;
  children: NetworkNode[];
}
/** 감사 로그 기록 함수 — `Rooms.audit` 과 같은 모양 (계정 모듈이 방 모듈을 직접 물지 않게 주입한다) */
export type AuditWriter = (
  owner: string,
  input: { packageId: null; actor: string; action: string; result: "ok" | "error" | "blocked" },
) => Promise<unknown>;
export interface PurgeReport {
  userId: string;
  deleteAfter: string;
  /** 지운 records 수 (kind 별) */
  records: Record<string, number>;
  memories: number;
  sessions: number;
  error?: string;
}
export interface Invite {
  id: string; // sha256(token)
  createdBy: string;
  phone?: string;
  role: Role;
  createdAt?: string; // 옛 초대에는 없다 — 보일 때 만료 시각에서 거꾸로 센다
  expiresAt: number;
  usedBy?: string;
  usedAt?: string;
}
export interface Session {
  id: string;
  owner: string;
  expiresAt: number;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ponytail: 모바일 앱 재로그인 부담을 줄이려 30일. 짧게 바꾸려면 여기만
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 탈퇴 정리(sweep) 주기. 기동 직후 한 번 돌고 이 간격으로 다시 돈다 */
export const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const digestHex = (value: string) => createHash("sha256").update(value).digest("hex");

/** 01012345678 형태로 정규화. 하이픈·공백·+82 허용. */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;
  if (!/^01[016789]\d{7,8}$/.test(digits))
    throw new AppError("전화번호 형식이 올바르지 않습니다 (예: 010-1234-5678)", 422);
  return digits;
}
/** 가운데 자리를 가린 표시용 번호: 01012345678 → 010-****-5678 */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}-${"*".repeat(Math.max(phone.length - 7, 0))}-${phone.slice(-4)}`;
}
const inviteStatus = (invite: Invite, now: number): InviteStatus =>
  invite.usedBy ? "joined" : invite.expiresAt < now ? "expired" : "pending";
const inviteView = (invite: Invite & { phone: string }, now: number): InviteView => ({
  id: invite.id,
  phone: invite.phone,
  status: inviteStatus(invite, now),
  createdAt: invite.createdAt ?? new Date(invite.expiresAt - INVITE_TTL_MS).toISOString(),
  expiresAt: new Date(invite.expiresAt).toISOString(),
  ...(invite.usedBy ? { joinedUserId: invite.usedBy } : {}),
});
const waitlistRef = (entry: WaitlistEntry) => entry.ref ?? digestHex(entry.id).slice(0, 32);
const waitlistView = (entry: WaitlistEntry): WaitlistView => ({
  id: waitlistRef(entry),
  phone: entry.id,
  purpose: entry.purpose ?? "",
  status: entry.status ?? "pending",
  requestedAt: entry.requestedAt,
  ...(entry.decidedAt ? { decidedAt: entry.decidedAt } : {}),
  ...(entry.parentId ? { parentId: entry.parentId } : {}),
  ...(entry.rejectReason ? { rejectReason: entry.rejectReason } : {}),
});

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function assertPassword(password: string) {
  if (password.length < PASSWORD_MIN)
    throw new AppError(`비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다`, 422);
}

export class Accounts {
  private attempts = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly db: Store) {}

  // --- 조회 ---
  async userById(id: string): Promise<User | null> {
    return this.db.get<User>("system", "users", id);
  }
  async userByPhone(phone: string): Promise<User | null> {
    const index = await this.db.get<{ id: string; userId: string }>("system", "phone-index", phone);
    return index ? this.userById(index.userId) : null;
  }
  async profile(userId: string): Promise<Profile> {
    return (await this.db.get<Profile>(userId, "profiles", "me")) ?? { id: "me", displayName: "" };
  }
  async requireRole(userId: string, ...roles: Role[]): Promise<User> {
    const user = await this.userById(userId);
    if (!user || !roles.includes(user.role)) throw new AppError("권한이 없습니다", 403);
    return user;
  }

  // --- 생성 ---
  async createUser(input: {
    phone: string;
    password: string;
    role?: Role;
    tier?: Tier;
    invitedBy?: string;
  }): Promise<User> {
    const phone = normalizePhone(input.phone);
    assertPassword(input.password);
    return this.insertUser({ ...input, phone, passwordHash: hashPassword(input.password) });
  }
  /** 이미 정규화한 번호와 이미 만든 해시로 사용자를 넣는다 (가입 신청 승인은 보관해 둔 해시를 그대로 쓴다). */
  private async insertUser(input: {
    phone: string;
    passwordHash: string;
    role?: Role;
    tier?: Tier;
    invitedBy?: string;
  }): Promise<User> {
    const { phone } = input;
    const user: User = {
      id: randomUUID(),
      phone,
      passwordHash: input.passwordHash,
      role: input.role ?? "user",
      tier: input.tier ?? "free",
      createdAt: new Date().toISOString(),
      invitedBy: input.invitedBy ?? null,
    };
    // 전화번호 유일성은 phone-index 의 insertIfAbsent 로 보장한다 (경쟁 시 한쪽만 성공)
    const claimed = await this.db.insertIfAbsent("system", "phone-index", {
      id: phone,
      userId: user.id,
    });
    if (!claimed) throw new AppError("이미 가입된 전화번호입니다", 409);
    await this.db.put("system", "users", user);
    await this.db.put(user.id, "profiles", { id: "me", displayName: "" } satisfies Profile);
    return user;
  }

  /** 서버 기동 시 관리자 보장. 전화·비밀번호는 환경변수에서만 온다 (코드에 박지 않음). */
  async ensureAdmin(phone?: string, password?: string): Promise<User | null> {
    // 하나만 있으면 설정 실수다 — 관리자 없이 조용히 뜨지 않는다
    if (Boolean(phone) !== Boolean(password))
      throw new Error(
        `ADMIN_PHONE 과 ADMIN_PASSWORD 는 둘 다 있어야 합니다 (${phone ? "ADMIN_PASSWORD" : "ADMIN_PHONE"} 없음)`,
      );
    if (!phone || !password) {
      console.log("[osiri] ADMIN_PHONE/ADMIN_PASSWORD 미설정 — 관리자 계정을 만들지 않습니다");
      return null;
    }
    const existing = await this.userByPhone(normalizePhone(phone));
    if (existing) {
      if (existing.role !== "admin")
        await this.db.put("system", "users", { ...existing, role: "admin" });
      return existing;
    }
    return this.createUser({ phone, password, role: "admin" });
  }

  // --- 세션 ---
  private async issueSession(userId: string) {
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digestHex(token),
      owner: userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    } satisfies Session);
    return token;
  }
  async login(phoneRaw: string, password: string) {
    const phone = normalizePhone(phoneRaw);
    this.throttle(phone);
    const user = await this.userByPhone(phone);
    // 아직 회원이 아닌 가입 신청자 — 신청 때 넣은 비밀번호가 맞을 때만 상태를 알려 준다 (번호 열거 방지)
    if (!user) {
      const entry = await this.db.get<WaitlistEntry>("system", "waitlist", phone);
      if (entry?.passwordHash && verifyPassword(password, entry.passwordHash)) {
        if (entry.status === "pending") throw new AppError(WAITLIST_PENDING_LOGIN_MESSAGE, 403);
        if (entry.status === "rejected")
          throw new AppError(waitlistRejectedMessage(entry.rejectReason ?? ""), 403);
      }
    }
    // 존재 여부를 구분해 알려주지 않는다 (계정 열거 방지)
    if (!user || !verifyPassword(password, user.passwordHash))
      throw new AppError("전화번호 또는 비밀번호가 맞지 않습니다", 401);
    // 비밀번호까지 맞은 본인에게만 알린다 — 탈퇴 요청된 계정은 다시 쓸 수 없다
    if (user.deleteAfter)
      throw new AppError(
        `탈퇴를 요청한 계정입니다. ${user.deleteAfter.slice(0, 10)} 이후 삭제되며 다시 로그인할 수 없습니다`,
        403,
      );
    this.attempts.delete(phone);
    return { token: await this.issueSession(user.id), user: publicUser(user) };
  }
  async logout(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) return;
    await this.db.remove("system", "sessions", digestHex(authorization.slice(7)));
  }
  private throttle(phone: string) {
    const now = Date.now();
    const entry = this.attempts.get(phone);
    if (!entry || now - entry.windowStart > 60_000) {
      this.attempts.set(phone, { count: 1, windowStart: now });
      return;
    }
    if (++entry.count > 10)
      throw new AppError("로그인 시도가 너무 많습니다. 1분 뒤 다시 시도하세요", 429);
  }

  // --- 초대 ---
  async createInvite(createdBy: string, input: { phone?: string; role?: Role } = {}) {
    const token = randomBytes(24).toString("base64url");
    const invite: Invite = {
      id: digestHex(token),
      createdBy,
      phone: input.phone ? normalizePhone(input.phone) : undefined,
      role: input.role ?? "user",
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + INVITE_TTL_MS,
    };
    await this.db.put("system", "invites", invite);
    return { token, invite };
  }
  /**
   * 회원이 전화번호로 보내는 초대 — 초대는 그 번호에 묶이고 역할은 일반 회원이다.
   * 내가 같은 번호로 보낸 안 쓰인 초대는 지우고 새로 낸다(옛 링크는 무효).
   * ponytail: 두 회원이 같은 번호를 동시에 초대하면 둘 다 통과할 수 있다 — 가입은 phone-index 가 한 번만 허용하므로 먼저 수락된 쪽이 상위가 된다.
   */
  async inviteByPhone(createdBy: string, phoneRaw: string) {
    const phone = normalizePhone(phoneRaw);
    if (await this.userByPhone(phone)) throw new AppError(INVITE_ALREADY_MEMBER_MESSAGE, 409);
    const now = Date.now();
    const unused = (await this.db.listByField<Invite>("system", "invites", "phone", phone)).filter(
      (i) => !i.usedBy,
    );
    if (unused.some((i) => i.createdBy !== createdBy && i.expiresAt >= now))
      throw new AppError(INVITE_TAKEN_MESSAGE, 409);
    for (const old of unused)
      if (old.createdBy === createdBy) await this.db.remove("system", "invites", old.id);
    const { token, invite } = await this.createInvite(createdBy, { phone });
    return { token, invite: inviteView({ ...invite, phone }, now) };
  }
  /** 내가 보낸 초대 (번호에 묶인 것만 — 관리자의 번호 없는 초대는 `/admin/invites` 에서 본다). 최신순. */
  async myInvites(userId: string): Promise<InviteView[]> {
    const now = Date.now();
    return (await this.db.listByField<Invite>("system", "invites", "createdBy", userId))
      .filter((i): i is Invite & { phone: string } => Boolean(i.phone))
      .map((i) => inviteView(i, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** 내 초대 취소. 남의 초대는 있는지조차 알려 주지 않는다(404). */
  async cancelInvite(userId: string, id: string): Promise<void> {
    const invite = await this.db.get<Invite>("system", "invites", id);
    if (!invite || invite.createdBy !== userId) throw new AppError("초대를 찾을 수 없습니다", 404);
    if (invite.usedBy) throw new AppError("이미 가입한 초대는 취소할 수 없습니다", 409);
    await this.db.remove("system", "invites", id);
  }
  /** 초대 링크를 열었을 때 보여 줄 것 — 번호는 가운데를 가린다. 번호 없는 (관리자) 초대는 phoneHint 가 null. */
  async previewInvite(
    token: string,
  ): Promise<{ phoneHint: string | null; inviterName: string | null }> {
    const invite = await this.db.get<Invite>("system", "invites", digestHex(token));
    if (!invite) throw new AppError("초대 링크가 올바르지 않습니다", 404);
    if (invite.usedBy) throw new AppError("이미 사용된 초대 링크입니다", 410);
    if (invite.expiresAt < Date.now()) throw new AppError("초대 링크가 만료되었습니다", 410);
    return {
      phoneHint: invite.phone ? maskPhone(invite.phone) : null,
      inviterName: (await this.profile(invite.createdBy)).displayName || null,
    };
  }
  async acceptInvite(input: { token: string; phone: string; password: string }) {
    const invite = await this.db.get<Invite>("system", "invites", digestHex(input.token));
    if (!invite) throw new AppError("초대 링크가 올바르지 않습니다", 400);
    if (invite.usedBy) throw new AppError("이미 사용된 초대 링크입니다", 400);
    if (invite.expiresAt < Date.now()) throw new AppError("초대 링크가 만료되었습니다", 400);
    const phone = normalizePhone(input.phone);
    if (invite.phone && invite.phone !== phone)
      throw new AppError(INVITE_PHONE_MISMATCH_MESSAGE, 400);
    const user = await this.createUser({
      phone,
      password: input.password,
      role: invite.role,
      invitedBy: invite.createdBy,
    });
    await this.db.put("system", "invites", {
      ...invite,
      usedBy: user.id,
      usedAt: new Date().toISOString(),
    });
    return { token: await this.issueSession(user.id), user: publicUser(user) };
  }
  async listInvites(): Promise<Invite[]> {
    return this.db.list<Invite>("system", "invites");
  }

  // --- 프로필 ---
  async updateProfile(userId: string, patch: Partial<Omit<Profile, "id">>): Promise<Profile> {
    const current = await this.profile(userId);
    const next: Profile = { ...current, ...patch, id: "me" };
    await this.db.put(userId, "profiles", next);
    return next;
  }
  /** 사용자 id → 표시 이름. ponytail: profiles 전체를 한 번 훑는다 — 회원 수천 명까지는 충분하다. */
  private async displayNames(): Promise<Map<string, string>> {
    const profiles = await this.db.scan<Profile>("profiles");
    return new Map(profiles.map((p) => [p.owner, p.value.displayName]));
  }
  /** 관리자용 회원 목록. `q` 는 이름(부분 일치)·전화번호(숫자 부분 일치)로 거른다. */
  async listUsers(q?: string): Promise<(PublicUser & { name: string | null })[]> {
    const names = await this.displayNames();
    const all = (await this.db.list<User>("system", "users")).map((user) => ({
      ...publicUser(user),
      name: names.get(user.id) || null,
    }));
    const text = q?.trim().toLowerCase();
    if (!text) return all;
    const digits = text.replace(/\D/g, "");
    return all.filter(
      (u) =>
        (u.name?.toLowerCase().includes(text) ?? false) ||
        (digits !== "" && u.phone.includes(digits)),
    );
  }

  // --- 가입 네트워크 ---
  /**
   * 나를 뿌리로 한 가입 트리 — 내가 들인 사람, 그 사람이 들인 사람… 아래로만.
   * 위(나를 들인 사람)·옆(같은 사람이 들인 다른 사람)은 싣지 않고, 다른 사람의 가지를 고르는 인자도 없다.
   * 전화번호는 바로 아래 단계만 그대로, 그보다 깊으면 가운데를 가린다. 아직 가입 전인 내 초대는 «invited» 잎으로 붙는다.
   * counts 는 가입한 회원만 센다(초대 중인 잎 제외).
   * ponytail: 사용자 전체를 한 번 읽어 부모→자식 표를 만든다 — 회원 수천 명(지인 대상 앱)까지는 충분하다.
   *           만 명을 넘기면 invitedBy 색인 조회(listByField)로 단계별로 내려가게 바꾼다.
   */
  async network(
    userId: string,
  ): Promise<{ root: NetworkNode; counts: { direct: number; total: number } }> {
    const users = await this.db.list<User>("system", "users");
    const me = users.find((u) => u.id === userId);
    if (!me) throw new AppError("사용자를 찾을 수 없습니다", 404);
    const names = await this.displayNames();
    const childrenOf = new Map<string, User[]>();
    for (const user of users)
      if (user.invitedBy)
        childrenOf.set(user.invitedBy, [...(childrenOf.get(user.invitedBy) ?? []), user]);
    // 순환 방지: 한 번 붙인 사람은 다시 붙이지 않는다 (기록이 꼬여 A→B→A 가 돼도 끝난다)
    const seen = new Set<string>([userId]);
    let total = 0;
    const build = (user: User, depth: number): NetworkNode => {
      const children = (childrenOf.get(user.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const child of children) seen.add(child.id);
      total += children.length;
      return {
        id: user.id,
        name: names.get(user.id) || null,
        phone: depth <= 1 ? user.phone : maskPhone(user.phone),
        status: "joined",
        joinedAt: user.createdAt,
        children: children.map((child) => build(child, depth + 1)),
      };
    };
    const root = build(me, 0);
    const direct = root.children.length;
    for (const invite of await this.myInvites(userId))
      if (invite.status === "pending")
        root.children.push({
          id: invite.id,
          name: null,
          phone: invite.phone,
          status: "invited",
          joinedAt: null,
          children: [],
        });
    return { root, counts: { direct, total } };
  }

  // --- 가입 신청 ---
  /**
   * 가입 신청: 전화번호 + 비밀번호 + 구체적인 사용 목적. 비밀번호는 해시로만 남긴다.
   * 번호당 한 줄 — 검토 중이면 409. 반려됐거나 옛(번호만 있는) 항목은 새 신청으로 덮는다.
   */
  async applyWaitlist(input: { phone: string; password: string; purpose: string }): Promise<void> {
    const phone = normalizePhone(input.phone);
    assertPassword(input.password);
    const purpose = input.purpose.trim();
    if (purpose.length < WAITLIST_PURPOSE_MIN || purpose.length > WAITLIST_PURPOSE_MAX)
      throw new AppError(WAITLIST_PURPOSE_MESSAGE, 400);
    if (await this.userByPhone(phone)) throw new AppError(INVITE_ALREADY_MEMBER_MESSAGE, 409);
    const entry: WaitlistEntry = {
      id: phone,
      ref: randomUUID(),
      requestedAt: new Date().toISOString(),
      status: "pending",
      purpose,
      passwordHash: hashPassword(input.password),
    };
    if (await this.db.insertIfAbsent<WaitlistEntry>("system", "waitlist", entry)) return;
    const existing = await this.db.get<WaitlistEntry>("system", "waitlist", phone);
    if (existing?.passwordHash && (existing.status ?? "pending") === "pending")
      throw new AppError(WAITLIST_ALREADY_PENDING_MESSAGE, 409);
    await this.db.put<WaitlistEntry>("system", "waitlist", entry);
  }
  async listWaitlist(): Promise<WaitlistView[]> {
    return (await this.db.list<WaitlistEntry>("system", "waitlist"))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .map(waitlistView);
  }
  private async pendingWaitlist(ref: string): Promise<WaitlistEntry> {
    const entry = (await this.db.list<WaitlistEntry>("system", "waitlist")).find(
      (e) => waitlistRef(e) === ref,
    );
    if (!entry) throw new AppError("가입 신청을 찾을 수 없습니다", 404);
    if ((entry.status ?? "pending") !== "pending")
      throw new AppError("이미 처리된 가입 신청입니다", 409);
    return entry;
  }
  /** 관리자 결정의 증적 — 관리자 본인 것과 system 것 두 곳. 못 남기면 조용히 넘기지 않는다. */
  private async auditDecision(adminId: string, action: string, audit: AuditWriter) {
    const entry = { packageId: null, actor: `user:${adminId}`, action, result: "ok" } as const;
    try {
      await audit(adminId, entry);
      await audit("system", entry);
    } catch (error) {
      throw new AppError(
        `결정은 반영됐지만 감사 로그를 남기지 못했습니다 (${action}): ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
  }
  /** 승인: 상위 회원을 붙여 사용자로 만든다. 신청 때의 해시를 그대로 옮기므로 그 번호·비밀번호로 바로 로그인된다. */
  async approveWaitlist(
    adminId: string,
    ref: string,
    parentId: string,
    audit: AuditWriter,
  ): Promise<WaitlistView> {
    const entry = await this.pendingWaitlist(ref);
    if (!entry.passwordHash)
      throw new AppError(
        "비밀번호 없이 접수된 옛 신청이라 승인할 수 없습니다 — 다시 신청받거나 초대로 진행하세요",
        409,
      );
    if (!(await this.userById(parentId))) throw new AppError("상위 회원을 찾을 수 없습니다", 404);
    const user = await this.insertUser({
      phone: entry.id,
      passwordHash: entry.passwordHash,
      invitedBy: parentId,
    });
    const { passwordHash: _moved, ...rest } = entry;
    const decided: WaitlistEntry = {
      ...rest,
      status: "approved",
      decidedAt: new Date().toISOString(),
      parentId,
      userId: user.id,
    };
    await this.db.put<WaitlistEntry>("system", "waitlist", decided);
    await this.auditDecision(
      adminId,
      `waitlist.approve ${waitlistRef(entry)} user=${user.id} parent=${parentId}`,
      audit,
    );
    return waitlistView(decided);
  }
  /** 반려. 해시는 남겨 둔다 — 신청자가 그 번호·비밀번호로 로그인하면 반려 사유를 본다. */
  async rejectWaitlist(
    adminId: string,
    ref: string,
    reason: string,
    audit: AuditWriter,
  ): Promise<WaitlistView> {
    const entry = await this.pendingWaitlist(ref);
    const decided: WaitlistEntry = {
      ...entry,
      status: "rejected",
      decidedAt: new Date().toISOString(),
      rejectReason: reason,
    };
    await this.db.put<WaitlistEntry>("system", "waitlist", decided);
    await this.auditDecision(adminId, `waitlist.reject ${waitlistRef(entry)}`, audit);
    return waitlistView(decided);
  }

  // --- 탈퇴 ---
  /**
   * 탈퇴 요청: 계정을 막고(로그인 거절·세션 폐기) `deleteAfter` 뒤에 지우도록 표시한다.
   * 증적은 감사 로그 두 곳에 남긴다 — 본인 것(삭제 전까지 보임)과 system 것(삭제 뒤에도 남음).
   * 증적을 못 남기면 요청 자체를 되돌린다.
   */
  async requestDeletion(userId: string, audit: AuditWriter): Promise<{ deleteAfter: string }> {
    const user = await this.userById(userId);
    if (!user) throw new AppError("사용자를 찾을 수 없습니다", 404);
    if (user.deleteAfter) return { deleteAfter: user.deleteAfter };
    const now = Date.now();
    const deleteAfter = new Date(now + RETENTION_MS).toISOString();
    await this.db.put<User>("system", "users", {
      ...user,
      deleteRequestedAt: new Date(now).toISOString(),
      deleteAfter,
    });
    try {
      const entry = {
        packageId: null,
        actor: `user:${userId}`,
        action: "account.delete_requested",
        result: "ok",
      } as const;
      await audit(userId, entry);
      await audit("system", entry);
    } catch (error) {
      await this.db.put<User>("system", "users", user);
      throw new AppError(
        `탈퇴 요청을 기록하지 못해 되돌렸습니다: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    await this.revokeSessions(userId);
    return { deleteAfter };
  }
  private async revokeSessions(userId: string): Promise<number> {
    const sessions = await this.db.listByField<Session>("system", "sessions", "owner", userId);
    for (const session of sessions) await this.db.remove("system", "sessions", session.id);
    return sessions.length;
  }
  /**
   * 보존 기간이 지난 탈퇴 계정을 지운다: 그 소유자의 records 전부 · 기억 · 세션 · 전화번호 색인 · 사용자 행.
   * 사용자 행을 맨 끝에 지우므로 중간에 실패하면 다음 정리가 다시 잡는다. 한 계정의 실패가 나머지를 막지 않는다.
   * ponytail: 디스크의 PDF 바이트(files)·컴퓨터 컨테이너는 여기서 지우지 않는다 — 그 모듈이 소유한다.
   */
  async purgeDeleted(deps: {
    memories: { removeAll(owner: string): Promise<number> };
    audit: AuditWriter;
    now?: number;
  }): Promise<PurgeReport[]> {
    const now = deps.now ?? Date.now();
    const due = (await this.db.list<User>("system", "users")).filter(
      (u) => u.deleteAfter !== undefined && Date.parse(u.deleteAfter) <= now,
    );
    const reports: PurgeReport[] = [];
    for (const user of due) {
      const report: PurgeReport = {
        userId: user.id,
        deleteAfter: user.deleteAfter as string,
        records: {},
        memories: 0,
        sessions: 0,
      };
      try {
        const { rows } = await this.db.sql<{ kind: string }>(
          "DELETE FROM records WHERE owner=$1 RETURNING kind",
          [user.id],
        );
        for (const { kind } of rows) report.records[kind] = (report.records[kind] ?? 0) + 1;
        report.memories = await deps.memories.removeAll(user.id);
        report.sessions = await this.revokeSessions(user.id);
        await deps.audit("system", {
          packageId: null,
          actor: `user:${user.id}`,
          action: "account.purged",
          result: "ok",
        });
        // 가입 네트워크: 아래 사람들을 한 단계 위로 붙이고(끊긴 가지가 생기지 않게), 안 쓰인 초대는 지운다
        for (const child of await this.db.listByField<User>(
          "system",
          "users",
          "invitedBy",
          user.id,
        ))
          await this.db.put<User>("system", "users", {
            ...child,
            invitedBy: user.invitedBy ?? null,
          });
        for (const invite of await this.db.listByField<Invite>(
          "system",
          "invites",
          "createdBy",
          user.id,
        ))
          if (!invite.usedBy) await this.db.remove("system", "invites", invite.id);
        await this.db.remove("system", "phone-index", user.phone);
        await this.db.remove("system", "users", user.id);
        console.log(
          `[osiri] 탈퇴 계정 삭제 user=${user.id} (기한 ${report.deleteAfter}): records ${JSON.stringify(report.records)} · 기억 ${report.memories} · 세션 ${report.sessions}`,
        );
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
        console.error(
          `[osiri] 탈퇴 계정 삭제 실패 user=${user.id} — 다음 정리 때 다시 시도합니다: ${report.error} (여기까지 지운 것: records ${JSON.stringify(report.records)} · 기억 ${report.memories} · 세션 ${report.sessions})`,
        );
      }
      reports.push(report);
    }
    return reports;
  }
  /** 기동 직후 한 번 + 주기적으로 `purgeDeleted` 를 돌린다. 프로세스 종료를 붙잡지 않는다(unref). */
  startPurgeSweep(
    deps: Parameters<Accounts["purgeDeleted"]>[0],
    intervalMs = PURGE_INTERVAL_MS,
  ): () => void {
    const run = () =>
      void this.purgeDeleted(deps).catch((error) =>
        console.error(
          `[osiri] 탈퇴 계정 정리를 돌리지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

export type PublicUser = Omit<User, "passwordHash" | "invitedBy"> & { invitedBy: string | null };
export function publicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return { ...rest, invitedBy: user.invitedBy ?? null };
}
