// 0Siri 계정 — 전화번호+비밀번호 자체 로그인, 초대 링크, 프로필, 역할 (0SIRI-SPEC §4.1, §20, §24-4 · DECISIONS 2026-10-09 전화번호)
// 저장은 openmuse 문서 저장소(records)를 그대로 쓴다: owner="system" 아래 users / phone-index / invites / sessions,
// 사용자 소유 데이터(profiles)는 owner=userId.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { PASSWORD_MIN, type UserRole } from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export type Role = UserRole;
export type Tier = "free" | "package";

export interface User {
  id: string;
  phone: string;
  passwordHash: string;
  role: Role;
  tier: Tier;
  createdAt: string;
}
export interface Profile {
  id: "me";
  displayName: string;
  credentialText?: string;
  onboardedAt?: string;
}
export interface Invite {
  id: string; // sha256(token)
  createdBy: string;
  phone?: string;
  role: Role;
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

const digestHex = (value: string) => createHash("sha256").update(value).digest("hex");

/** 01012345678 형태로 정규화. 하이픈·공백·+82 허용. */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;
  if (!/^01[016789]\d{7,8}$/.test(digits))
    throw new AppError("전화번호 형식이 올바르지 않습니다 (예: 010-1234-5678)", 422);
  return digits;
}

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
  }): Promise<User> {
    const phone = normalizePhone(input.phone);
    assertPassword(input.password);
    const user: User = {
      id: randomUUID(),
      phone,
      passwordHash: hashPassword(input.password),
      role: input.role ?? "user",
      tier: input.tier ?? "free",
      createdAt: new Date().toISOString(),
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
    if (!phone || !password) return null;
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
    // 존재 여부를 구분해 알려주지 않는다 (계정 열거 방지)
    if (!user || !verifyPassword(password, user.passwordHash))
      throw new AppError("전화번호 또는 비밀번호가 맞지 않습니다", 401);
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
      expiresAt: Date.now() + INVITE_TTL_MS,
    };
    await this.db.put("system", "invites", invite);
    return { token, invite };
  }
  async acceptInvite(input: { token: string; phone: string; password: string }) {
    const invite = await this.db.get<Invite>("system", "invites", digestHex(input.token));
    if (!invite) throw new AppError("초대 링크가 올바르지 않습니다", 400);
    if (invite.usedBy) throw new AppError("이미 사용된 초대 링크입니다", 400);
    if (invite.expiresAt < Date.now()) throw new AppError("초대 링크가 만료되었습니다", 400);
    const phone = normalizePhone(input.phone);
    if (invite.phone && invite.phone !== phone)
      throw new AppError("이 초대는 다른 전화번호로 발급되었습니다", 400);
    const user = await this.createUser({ phone, password: input.password, role: invite.role });
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
  async listUsers(): Promise<PublicUser[]> {
    return (await this.db.list<User>("system", "users")).map(publicUser);
  }
}

export type PublicUser = Omit<User, "passwordHash">;
export function publicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}
