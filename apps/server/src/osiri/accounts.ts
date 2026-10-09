// 0Siri 계정 — 전화번호+비밀번호 자체 로그인, 초대 링크, 프로필, 역할 (0SIRI-SPEC §4.1, §20, §24-4 · DECISIONS 2026-10-09 전화번호)
// 저장은 openmuse 문서 저장소(records)를 그대로 쓴다: owner="system" 아래 users / phone-index / invites / sessions,
// 사용자 소유 데이터(profiles)는 owner=userId.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type AccountTier,
  PASSWORD_MIN,
  RETENTION_DAYS,
  type UserRole,
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
export interface WaitlistEntry {
  id: string; // 정규화한 전화번호
  requestedAt: string;
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

  // --- 초대 대기 ---
  /** 같은 번호로 여러 번 신청해도 한 줄만 남는다. 가입 여부는 응답으로 구분해 주지 않는다 (계정 열거 방지). */
  async joinWaitlist(phoneRaw: string): Promise<void> {
    const phone = normalizePhone(phoneRaw);
    await this.db.insertIfAbsent<WaitlistEntry>("system", "waitlist", {
      id: phone,
      requestedAt: new Date().toISOString(),
    });
  }
  async listWaitlist(): Promise<WaitlistEntry[]> {
    return (await this.db.list<WaitlistEntry>("system", "waitlist")).sort((a, b) =>
      a.requestedAt.localeCompare(b.requestedAt),
    );
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

export type PublicUser = Omit<User, "passwordHash">;
export function publicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}
