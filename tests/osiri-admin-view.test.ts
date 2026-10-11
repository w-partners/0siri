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

test("관리자 정지(E): 사유 필수·자기 정지 불가, 정지하면 세션이 끊기고 로그인 403, 해제하면 다시 로그인", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osiri-suspend-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const accounts = new Accounts(db);
    const audits: string[] = [];
    const audit = async (_owner: string, input: { action: string }) => audits.push(input.action);
    const admin = (
      await accounts.createUser({ phone: "01012345672", password: "1234", role: "admin" })
    ).id;
    const user = (await accounts.createUser({ phone: "01012345673", password: "1234" })).id;
    await accounts.login("01012345673", "1234");
    await assert.rejects(accounts.suspend(admin, user, true, " ", audit), /사유/);
    await assert.rejects(accounts.suspend(admin, admin, true, "x", audit), /자기 계정/);
    await assert.rejects(accounts.suspend(user, admin, true, "x", audit), /권한/);
    const view = await accounts.suspend(admin, user, true, "불법 이용", audit);
    assert.equal(view.suspended?.reason, "불법 이용");
    assert.equal(
      (await db.listByField("system", "sessions", "owner", user)).length,
      0,
      "세션 끊김",
    );
    await assert.rejects(accounts.login("01012345673", "1234"), /정지한 계정입니다: 불법 이용/);
    await accounts.suspend(admin, user, false, "", audit);
    assert.ok((await accounts.login("01012345673", "1234")).token);
    assert.deepEqual(
      [...new Set(audits)],
      [`user.suspend user=${user} reason=불법 이용`, `user.unsuspend user=${user}`],
    );

    // 팀 실행 중지는 YAML 다시 올리기(upsert)로 풀리지 않는다
    const rooms = new Rooms(db, new EventBus());
    const catalog = new Catalog(db, rooms, async () => undefined);
    const role = (name: string) => ({ name, title: name, description: name });
    const pkg = await catalog.upsertPackage({
      slug: "t",
      name: "t",
      character: "c",
      category: "office",
      summary: "s",
      roles: ["root", "reviewer", "publisher", "analyst", "monitor", "drafter", "geo"].map(role),
      approvalPoints: ["발송"],
      reportCadence: "weekly",
      verified: false,
      metrics: { published: 0, indexed: 0, ai_citations: 0 },
      runtime: { teamYaml: "t.yaml", image: "i" },
    } as unknown as Parameters<Catalog["upsertPackage"]>[0]);
    await catalog.setHalted(pkg.id, true, admin, "점검");
    const { halted: _h, ...again } = await catalog.packageById(pkg.id);
    await catalog.upsertPackage(again);
    assert.equal((await catalog.packageById(pkg.id)).halted?.reason, "점검");
    await catalog.setHalted(pkg.id, false, admin, "");
    assert.equal((await catalog.packageById(pkg.id)).halted, undefined);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
