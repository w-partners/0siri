import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createAuth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  privateAccountRoutes,
  publicAccountRoutes,
} from "../apps/server/src/osiri/account-routes.ts";
import { Accounts, normalizePhone } from "../apps/server/src/osiri/accounts.ts";

let db: Store, directory: string, accounts: Accounts;
let app: Hono<{ Variables: { owner: string } }>;
const json = (path: string, body?: unknown, token?: string, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-accounts-"));
  db = await createStore({ dataDir: join(directory, "db") });
  accounts = new Accounts(db);
  const config = { mode: "live", dataDir: directory, publicUrl: "http://t" } as Config;
  const auth = await createAuth(db, config);
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api/auth", publicAccountRoutes(accounts));
  app.use("/api/*", async (c, next) => {
    c.set("owner", await auth.owner(c.req.header("authorization")));
    await next();
  });
  app.route("/api", privateAccountRoutes(accounts, "http://t"));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("전화번호 정규화 — 하이픈·+82 허용, 형식 오류 거절", () => {
  assert.equal(normalizePhone("010-3442-4668"), "01034424668");
  assert.equal(normalizePhone("+82 10 3442 4668"), "01034424668");
  assert.throws(() => normalizePhone("12345"), /형식/);
});

test("관리자 시드 → 로그인 → /me → 프로필 저장, 잘못된 비밀번호 거절", async () => {
  const admin = await accounts.ensureAdmin("010-0000-0001", "1234");
  assert.equal(admin?.role, "admin");
  // 두 번 불러도 중복 생성 없음
  assert.equal((await accounts.ensureAdmin("01000000001", "1234"))?.id, admin?.id);

  const bad = await json("/api/auth/login", { phone: "01000000001", password: "wrong" });
  assert.equal(bad.status, 401);
  const ok = await json("/api/auth/login", { phone: "010-0000-0001", password: "1234" });
  assert.equal(ok.status, 200);
  const { token, user } = (await ok.json()) as { token: string; user: { role: string } };
  assert.equal(user.role, "admin");
  assert.ok(!("passwordHash" in user));

  const me = await json("/api/me", undefined, token);
  assert.equal(me.status, 200);
  const saved = await json(
    "/api/me/profile",
    { displayName: "영실", credentialText: "변호사" },
    token,
    "PATCH",
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { id: "me", displayName: "영실", credentialText: "변호사" });
  // 인증 없이 /me 는 401
  assert.equal((await json("/api/me")).status, 401);
});

test("초대 수락 e2e — 관리자만 발급, 잘못된·재사용 토큰 거절, 소유자 격리", async () => {
  const adminLogin = await (
    await json("/api/auth/login", { phone: "01000000001", password: "1234" })
  ).json();
  const adminToken = (adminLogin as { token: string }).token;

  const created = await json("/api/admin/invites", { phone: "010-1111-2222" }, adminToken);
  assert.equal(created.status, 200);
  const { token: inviteToken, url } = (await created.json()) as { token: string; url: string };
  assert.ok(url.endsWith(inviteToken));

  const wrongToken = await json("/api/auth/invite/accept", {
    token: "nope",
    phone: "01011112222",
    password: "pass1234",
  });
  assert.equal(wrongToken.status, 400);
  const wrongPhone = await json("/api/auth/invite/accept", {
    token: inviteToken,
    phone: "01099999999",
    password: "pass1234",
  });
  assert.equal(wrongPhone.status, 400);

  const accepted = await json("/api/auth/invite/accept", {
    token: inviteToken,
    phone: "010-1111-2222",
    password: "pass1234",
  });
  assert.equal(accepted.status, 200);
  const member = (await accepted.json()) as { token: string; user: { id: string; role: string } };
  assert.equal(member.user.role, "user");

  const reused = await json("/api/auth/invite/accept", {
    token: inviteToken,
    phone: "01011112222",
    password: "pass1234",
  });
  assert.equal(reused.status, 400);

  // 일반 사용자는 관리자 API 거절
  assert.equal((await json("/api/admin/users", undefined, member.token)).status, 403);
  // 프로필은 소유자별로 분리된다
  await json("/api/me/profile", { displayName: "회원" }, member.token, "PATCH");
  const adminMe = (await (await json("/api/me", undefined, adminToken)).json()) as {
    profile: { displayName: string };
  };
  assert.equal(adminMe.profile.displayName, "영실");
  // 로그아웃 후 세션 무효
  await json("/api/auth/logout", {}, member.token);
  assert.equal((await json("/api/me", undefined, member.token)).status, 401);
});
