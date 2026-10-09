// 0Siri 계정 라우트 (0SIRI-SPEC §21 S1). openmuse 패턴대로 /api 아래에 둔다.
//  공개:  POST /api/auth/login · POST /api/auth/invite/accept · POST /api/auth/logout · POST /api/auth/waitlist
//  인증:  GET /api/me · PATCH /api/me/profile · POST /api/account/delete · 관리자 /api/admin/*
import { Hono } from "hono";
import { z } from "zod";
import { USER_ROLES } from "../../../../packages/domain/src/osiri.ts";
import { AppError } from "../errors.ts";
import type { Accounts, AuditWriter, Profile, User } from "./accounts.ts";

type Env = { Variables: { owner: string } };

export function publicAccountRoutes(accounts: Accounts) {
  const app = new Hono<Env>();
  app.post("/login", async (c) => {
    const body = z
      .object({ phone: z.string().min(1), password: z.string().min(1) })
      .parse(await c.req.json());
    return c.json(await accounts.login(body.phone, body.password));
  });
  app.post("/invite/accept", async (c) => {
    const body = z
      .object({ token: z.string().min(1), phone: z.string().min(1), password: z.string().min(1) })
      .parse(await c.req.json());
    return c.json(await accounts.acceptInvite(body));
  });
  app.post("/logout", async (c) => {
    await accounts.logout(c.req.header("authorization"));
    return c.json({ ok: true });
  });
  // 초대 코드가 없을 때 "초대 대기 신청". 같은 번호는 한 줄만 남는다 (멱등)
  app.post("/waitlist", async (c) => {
    const body = z.object({ phone: z.string().min(1).max(40) }).parse(await c.req.json());
    await accounts.joinWaitlist(body.phone);
    return c.json({ ok: true });
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

/** `GET /me` 응답 모양 — 비밀번호 해시는 싣지 않는다 */
export type MeResponse = { user: Omit<User, "passwordHash">; profile: Profile };

export function privateAccountRoutes(accounts: Accounts, publicUrl: string) {
  const app = new Hono<Env>();
  app.get("/me", async (c) => {
    const user = await accounts.userById(c.get("owner"));
    if (!user) return c.json({ error: "세션의 사용자를 찾을 수 없습니다" }, 401);
    const { passwordHash: _omit, ...safe } = user;
    return c.json({ user: safe, profile: await accounts.profile(user.id) } satisfies MeResponse);
  });
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
  app.get("/admin/users", async (c) => {
    await accounts.requireRole(c.get("owner"), "admin");
    return c.json(await accounts.listUsers());
  });
  return app;
}
