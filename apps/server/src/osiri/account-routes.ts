// 0Siri 계정 라우트 (0SIRI-SPEC §21 S1). openmuse 패턴대로 /api 아래에 둔다.
//  공개:  POST /api/auth/login · POST /api/auth/otp · GET /api/auth/invite/:token · POST /api/auth/invite/accept · POST /api/auth/password/reset · POST /api/auth/logout · POST /api/auth/waitlist
//  인증:  GET /api/me · PATCH /api/me/profile · /api/invites · GET /api/network · POST /api/account/delete · 관리자 /api/admin/*
import { Hono } from "hono";
import { z } from "zod";
import {
  OTP_PURPOSES,
  USER_ROLES,
  type WaitlistStatus,
} from "../../../../packages/domain/src/osiri.ts";
import { AppError } from "../errors.ts";
import {
  type Accounts,
  type AuditWriter,
  normalizePhone,
  type Profile,
  type PublicUser,
  publicUser,
} from "./accounts.ts";
import type { Otp } from "./otp.ts";
import { modelsView } from "./routing.ts";

type Env = { Variables: { owner: string } };

export function publicAccountRoutes(accounts: Accounts, otp: Otp) {
  const app = new Hono<Env>();
  app.post("/login", async (c) => {
    const body = z
      .object({ phone: z.string().min(1), password: z.string().min(1) })
      .parse(await c.req.json());
    return c.json(await accounts.login(body.phone, body.password));
  });
  // 문자 인증번호 받기 — 가입(signup)은 아직 회원이 아닌 번호만, 비밀번호 찾기(reset)는 회원 번호만 보낸다(헛문자 방지)
  app.post("/otp", async (c) => {
    const body = z
      .object({ phone: z.string().min(1).max(40), purpose: z.enum(OTP_PURPOSES) })
      .parse(await c.req.json());
    const phone = normalizePhone(body.phone);
    const member = await accounts.isMember(phone);
    if (body.purpose === "signup" && member)
      throw new AppError("이미 가입된 번호입니다 — 로그인하거나 비밀번호 찾기를 쓰세요", 409);
    if (body.purpose === "reset" && !member) throw new AppError("가입된 번호가 아닙니다", 404);
    return c.json(await otp.request(phone, body.purpose));
  });
  // 가입은 그 번호로 온 인증번호를 맞혀야 한다 (본인 번호 확인)
  const signupCode = z.string().max(12).default("");
  app.post("/invite/accept", async (c) => {
    const body = z
      .object({
        token: z.string().min(1),
        phone: z.string().min(1),
        password: z.string().min(1),
        code: signupCode,
      })
      .parse(await c.req.json());
    await otp.verify(normalizePhone(body.phone), body.code, "signup");
    return c.json(await accounts.acceptInvite(body));
  });
  app.post("/password/reset", async (c) => {
    const body = z
      .object({ phone: z.string().min(1), password: z.string().min(1), code: signupCode })
      .parse(await c.req.json());
    await otp.verify(normalizePhone(body.phone), body.code, "reset");
    return c.json(await accounts.resetPassword(body.phone, body.password));
  });
  app.post("/logout", async (c) => {
    await accounts.logout(c.req.header("authorization"));
    return c.json({ ok: true });
  });
  // 초대 링크를 열었을 때: 누가 어느 번호로 초대했는지(번호는 가운데를 가린다). 모르는 링크 404 · 쓰였거나 만료 410
  app.get("/invite/:token", async (c) =>
    c.json(await accounts.previewInvite(c.req.param("token"))),
  );
  // 초대가 없을 때 가입 신청: 전화번호 + 비밀번호 + 구체적인 사용 목적. 관리자가 상위 회원을 붙여 승인하면 로그인된다
  app.post("/waitlist", async (c) => {
    const body = z
      .object({
        phone: z.string().min(1).max(40),
        password: z.string().min(1).max(200),
        // 빠졌거나 짧으면 applyWaitlist 가 «구체적으로 적어 달라»는 400 을 낸다
        purpose: z.string().max(5000).default(""),
        code: signupCode,
      })
      .parse(await c.req.json());
    await otp.verify(normalizePhone(body.phone), body.code, "signup");
    await accounts.applyWaitlist(body);
    return c.json({ status: "pending" satisfies WaitlistStatus }, 201);
  });
  return app;
}

/** 탈퇴 요청 — `POST /api/account/delete`. 인증 뒤에 둔다. 증적은 `audit`(Rooms.audit)으로 남긴다. */
export function accountDeletionRoutes(accounts: Accounts, audit: AuditWriter) {
  const app = new Hono<Env>();
  app.post("/account/delete", async (c) =>
    c.json(await accounts.requestDeletion(c.get("owner"), audit)),
  );
  return app;
}

/** `GET /me` 응답 모양 — 비밀번호 해시는 싣지 않는다. `user.invitedBy` 는 나를 들인 회원 id (없으면 null) */
export type MeResponse = { user: PublicUser; profile: Profile };

export function privateAccountRoutes(accounts: Accounts, publicUrl: string, audit: AuditWriter) {
  const app = new Hono<Env>();
  app.get("/me", async (c) => {
    const user = await accounts.userById(c.get("owner"));
    if (!user) return c.json({ error: "세션의 사용자를 찾을 수 없습니다" }, 401);
    return c.json({
      user: publicUser(user),
      profile: await accounts.profile(user.id),
    } satisfies MeResponse);
  });
  // 초대 — 로그인한 회원 누구나, 상대 전화번호만으로. 따로 입력하는 초대 코드는 없다
  app.post("/invites", async (c) => {
    const body = z.object({ phone: z.string().min(1).max(40) }).parse(await c.req.json());
    const { token, invite } = await accounts.inviteByPhone(c.get("owner"), body.phone);
    return c.json({ link: `${publicUrl}/invite/${token}`, invite }, 201);
  });
  app.get("/invites", async (c) => c.json(await accounts.myInvites(c.get("owner"))));
  app.delete("/invites/:id", async (c) => {
    await accounts.cancelInvite(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  // 가입 네트워크 — 항상 부르는 사람이 뿌리다. 다른 가지를 고르는 인자를 받지 않는다
  app.get("/network", async (c) => c.json(await accounts.network(c.get("owner"))));
  app.patch("/me/profile", async (c) => {
    const body = z
      .object({
        displayName: z.string().max(40).optional(),
        credentialText: z.string().max(120).optional(),
        onboardedAt: z.string().optional(),
        specialty: z.string().max(80).optional(),
        region: z.string().max(80).optional(),
      })
      .parse(await c.req.json());
    return c.json(await accounts.updateProfile(c.get("owner"), body));
  });
  app.post("/admin/invites", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    // 본문 없이 부르는 것은 허용(기본 초대). 본문이 있는데 JSON 이 아니면 조용히 기본 초대를 만들지 않고 400
    const raw = (await c.req.text()).trim();
    let parsed: unknown = {};
    if (raw)
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AppError("요청 본문이 올바른 JSON 이 아닙니다", 400);
      }
    const body = z
      .object({
        phone: z.string().optional(),
        role: z.enum(USER_ROLES).optional(),
      })
      .parse(parsed);
    const { token, invite } = await accounts.createInvite(c.get("owner"), body);
    return c.json({ token, url: `${publicUrl}/invite/${token}`, expiresAt: invite.expiresAt });
  });
  app.get("/admin/invites", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    return c.json(await accounts.listInvites());
  });
  app.get("/admin/waitlist", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    return c.json(await accounts.listWaitlist());
  });
  app.post("/admin/waitlist/:id/approve", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    const body = z.object({ parentId: z.string().min(1) }).parse(await c.req.json());
    return c.json(
      await accounts.approveWaitlist(c.get("owner"), c.req.param("id"), body.parentId, audit),
    );
  });
  app.post("/admin/waitlist/:id/reject", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    const body = z.object({ reason: z.string().trim().min(1).max(500) }).parse(await c.req.json());
    return c.json(
      await accounts.rejectWaitlist(c.get("owner"), c.req.param("id"), body.reason, audit),
    );
  });
  // 회원 찾기(승인할 때 상위 회원 고르기) — `?q=` 로 이름·전화번호 검색
  app.patch("/admin/users/:id/role", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    const body = z.object({ role: z.enum(USER_ROLES) }).parse(await c.req.json());
    return c.json(await accounts.setRole(c.get("owner"), c.req.param("id"), body.role, audit));
  });
  app.get("/admin/users", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    return c.json(await accounts.listUsers(c.req.query("q")));
  });
  // 영시리가 지금 실제로 쓰는 서버 모델(등급별) — 라우팅이 읽는 바로 그 값(tierModels). 관리자만
  app.get("/admin/models", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    return c.json(modelsView());
  });
  return app;
}
