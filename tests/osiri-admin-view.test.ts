// wgolf RPT-02 D·F: 관리자는 남의 사용량·감사·대화방을 보고, 대화 본문은 설정을 켠 뒤에만 본다. 열람은 관리자 감사에 남는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { adminViewRoutes, CONVERSATION_VIEW_SETTING } from "../apps/server/src/osiri/admin-view.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Routing } from "../apps/server/src/osiri/routing.ts";
import { Catalog } from "../apps/server/src/osiri/store.ts";

test("관리자 열람: 사용량·감사·방은 열고 본문은 설정 뒤에만, 열람마다 감사, 관리자가 아니면 403", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osiri-admin-view-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const accounts = new Accounts(db);
    const rooms = new Rooms(db, new EventBus());
    const catalog = new Catalog(db, rooms, async () => undefined);
    const app = new Hono<{ Variables: { owner: string } }>();
    app.onError((error, c) =>
      c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
    );
    app.use("/api/*", async (c, next) => {
      c.set("owner", (c.req.header("authorization") ?? "").slice(7));
      await next();
    });
    app.route("/api", adminViewRoutes(accounts, rooms, new Routing(db, rooms), catalog));
    const get = (path: string, owner: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${owner}` } });

    const admin = (
      await accounts.createUser({ phone: "01012345670", password: "1234", role: "admin" })
    ).id;
    const user = (await accounts.createUser({ phone: "01012345671", password: "1234" })).id;
    const room = await rooms.ensurePersonalRoom(user);
    await rooms.post(user, room.id, { role: "user", kind: "text", text: "비밀 이야기" });

    assert.equal((await get(`/api/admin/users/${user}/usage`, user)).status, 403, "관리자만");
    assert.equal((await get(`/api/admin/users/${user}/usage`, admin)).status, 200);
    assert.equal((await get(`/api/admin/users/${user}/audit`, admin)).status, 200);
    const list = (await (await get(`/api/admin/users/${user}/rooms`, admin)).json()) as {
      id: string;
    }[];
    assert.ok(list.some((r) => r.id === room.id));
    assert.equal((await get("/api/admin/users/nobody/usage", admin)).status, 404);

    const timeline = `/api/admin/users/${user}/rooms/${room.id}/timeline`;
    assert.equal((await get(timeline, admin)).status, 403, "본문 열람은 기본 꺼짐");
    await catalog.setSetting(CONVERSATION_VIEW_SETTING, true);
    const body = (await (await get(timeline, admin)).json()) as { messages: { text: string }[] };
    assert.ok(body.messages.some((m) => m.text === "비밀 이야기"));

    const actions = (await rooms.auditLogs(admin)).map((a) => a.action);
    for (const what of ["usage", "audit", "rooms", `timeline room=${room.id}`])
      assert.ok(actions.includes(`admin.view ${what} user=${user}`), `감사: ${what}`);
    assert.equal(
      (await rooms.auditLogs(user)).filter((a) => a.action.startsWith("admin.view")).length,
      0,
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
