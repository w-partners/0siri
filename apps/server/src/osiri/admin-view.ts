import { Hono } from "hono";
import { AppError } from "../errors.ts";
import type { Accounts } from "./accounts.ts";
import type { Rooms } from "./rooms.ts";
import type { Routing } from "./routing.ts";
import type { Catalog } from "./store.ts";

/** 설정 키: true 일 때만 관리자가 남의 대화 본문을 연다 — 약관·개인정보 열람 고지(마스터 확인) 뒤에 켠다 (wgolf RPT-02 D) */
export const CONVERSATION_VIEW_SETTING = "adminConversationView";

/**
 * 관리자 감독 열람 (wgolf RPT-02 D·F) — 사용자별 사용량·감사 기록·대화방·대화 본문.
 * 팀 쪽(YAML·버전·승인)은 운영자 라우트가 관리자를 이미 통과시킨다(operator.requirePackage).
 * 열람마다 관리자 본인의 감사 기록에 «누가·언제·누구의 무엇을» 남긴다(F). 기록이 실패하면 열람도 실패한다.
 */
export function adminViewRoutes(
  accounts: Accounts,
  rooms: Rooms,
  routing: Routing,
  catalog: Catalog,
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const viewed = async (adminId: string, userId: string, what: string) => {
    await accounts.requireRole(adminId, "admin");
    if (!(await accounts.userById(userId))) throw new AppError("사용자를 찾을 수 없습니다", 404);
    await rooms.audit(adminId, {
      packageId: null,
      actor: `user:${adminId}`,
      action: `admin.view ${what} user=${userId}`,
      result: "ok",
    });
  };
  app.get("/admin/users/:id/usage", async (c) => {
    const userId = c.req.param("id");
    await viewed(c.get("owner"), userId, "usage");
    return c.json(await routing.month(userId, c.req.query("month")));
  });
  app.get("/admin/users/:id/audit", async (c) => {
    const userId = c.req.param("id");
    await viewed(c.get("owner"), userId, "audit");
    return c.json(await rooms.auditLogs(userId));
  });
  app.get("/admin/users/:id/rooms", async (c) => {
    const userId = c.req.param("id");
    await viewed(c.get("owner"), userId, "rooms");
    return c.json(await rooms.list(userId));
  });
  app.get("/admin/users/:id/rooms/:roomId/timeline", async (c) => {
    const owner = c.get("owner");
    await accounts.requireRole(owner, "admin");
    if ((await catalog.setting(CONVERSATION_VIEW_SETTING)) !== true)
      throw new AppError(
        `대화 본문 열람은 꺼져 있습니다 — 약관·개인정보 열람 고지를 마스터가 확인한 뒤 설정 ${CONVERSATION_VIEW_SETTING}=true 로 켭니다`,
        403,
      );
    const userId = c.req.param("id");
    const roomId = c.req.param("roomId");
    await viewed(owner, userId, `timeline room=${roomId}`);
    // 열람은 읽기만 — 사용자 쪽 «마지막으로 본 시각»(lastSeenAt)은 건드리지 않는다
    return c.json({
      room: await rooms.get(userId, roomId),
      messages: await rooms.timeline(userId, roomId),
    });
  });
  return app;
}
