// 가입: 전화번호 초대 · 가입 신청(관리자가 상위 회원을 붙여 승인) · 아래로만 보이는 가입 네트워크
// 전화번호는 전부 자리표시자다 (010-1234-5678 꼴) — 실제 번호를 쓰지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  privateAccountRoutes,
  publicAccountRoutes,
} from "../apps/server/src/osiri/account-routes.ts";
import {
  Accounts,
  type Invite,
  type InviteView,
  maskPhone,
  type NetworkNode,
  type User,
  verifyPassword,
  type WaitlistEntry,
  type WaitlistView,
} from "../apps/server/src/osiri/accounts.ts";
import {
  INVITE_ALREADY_MEMBER_MESSAGE,
  INVITE_PHONE_MISMATCH_MESSAGE,
  INVITE_TAKEN_MESSAGE,
  WAITLIST_ALREADY_PENDING_MESSAGE,
  WAITLIST_PENDING_LOGIN_MESSAGE,
  WAITLIST_PURPOSE_MESSAGE,
  WAITLIST_PURPOSE_MIN,
  waitlistRejectedMessage,
} from "../packages/domain/src/osiri.ts";

type Session = { token: string; user: { id: string; phone: string; invitedBy: string | null } };
type Network = { root: NetworkNode; counts: { direct: number; total: number } };
type Audit = { owner: string; actor: string; action: string; result: string };

let db: Store, directory: string, accounts: Accounts;
let app: Hono<{ Variables: { owner: string } }>;
const audits: Audit[] = [];
const PASSWORD = "pass1234";
const PURPOSE = "사무소 상담 기록을 정리하고, 매주 블로그 초안을 받아 검토한 뒤 발행하려고 합니다";

const call = (path: string, body?: unknown, token?: string, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const read = async <T>(response: Response | Promise<Response>, status = 200): Promise<T> => {
  const settled = await response;
  const text = await settled.text();
  assert.equal(settled.status, status, text);
  return JSON.parse(text) as T;
};
const errorOf = async (response: Response | Promise<Response>, status: number) =>
  (await read<{ error: string }>(response, status)).error;
const login = (phone: string, password = PASSWORD) =>
  read<Session>(call("/api/auth/login", { phone, password }));
/** 초대 → 수락까지 한 번에. 초대받은 사람의 세션을 돌려준다 */
const inviteAndJoin = async (inviterToken: string, phone: string): Promise<Session> => {
  const { link } = await read<{ link: string }>(call("/api/invites", { phone }, inviterToken), 201);
  return read<Session>(
    call("/api/auth/invite/accept", { token: tokenOf(link), phone, password: PASSWORD }),
  );
};
const tokenOf = (link: string) => link.slice(link.lastIndexOf("/") + 1);
const network = (token: string, query = "") =>
  read<Network>(call(`/api/network${query}`, undefined, token));

let admin: Session;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-network-"));
  db = await createStore({ dataDir: join(directory, "db") });
  accounts = new Accounts(db);
  const config = { mode: "live", dataDir: directory, publicUrl: "http://t" } as Config;
  const auth = await createAuth(db, config);
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    error instanceof z.ZodError
      ? c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422)
      : c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api/auth", publicAccountRoutes(accounts));
  app.use("/api/*", async (c, next) => {
    c.set("owner", await auth.owner(c.req.header("authorization")));
    await next();
  });
  app.route(
    "/api",
    privateAccountRoutes(accounts, "http://t", async (owner, input) => {
      audits.push({ owner, actor: input.actor, action: input.action, result: input.result });
    }),
  );
  await accounts.ensureAdmin("010-0000-0001", PASSWORD);
  admin = await login("010-0000-0001");
  await call("/api/me/profile", { displayName: "관리자" }, admin.token, "PATCH");
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("번호 가리기 — 가운데 자리만 가린다", () => {
  assert.equal(maskPhone("01012345678"), "010-****-5678");
  assert.equal(maskPhone("0111234567"), "011-***-4567");
});

test("초대: 회원이 전화번호만으로 초대 → 링크 확인 → 다른 번호는 거절 → 맞는 번호로 가입 → 로그인", async () => {
  assert.equal(admin.user.invitedBy, null); // 뿌리(관리자 시드)
  // 로그인 없이는 초대할 수 없다
  assert.equal((await call("/api/invites", { phone: "010-1234-5678" })).status, 401);
  assert.equal((await call("/api/invites", { phone: "12345" }, admin.token)).status, 422);

  const created = await read<{ link: string; invite: InviteView }>(
    call("/api/invites", { phone: "010-1234-5678" }, admin.token),
    201,
  );
  assert.ok(created.link.startsWith("http://t/invite/"));
  assert.equal(created.invite.phone, "01012345678");
  assert.equal(created.invite.status, "pending");
  assert.ok(Date.parse(created.invite.expiresAt) > Date.parse(created.invite.createdAt));
  const token = tokenOf(created.link);

  // 링크를 열면: 가린 번호 + 초대한 사람 이름 (로그인 없이)
  assert.deepEqual(await read(call(`/api/auth/invite/${token}`)), {
    phoneHint: "010-****-5678",
    inviterName: "관리자",
  });
  assert.equal((await call("/api/auth/invite/nope")).status, 404);

  // 다른 번호로는 가입할 수 없다
  assert.equal(
    await errorOf(
      call("/api/auth/invite/accept", { token, phone: "010-1234-0000", password: PASSWORD }),
      400,
    ),
    INVITE_PHONE_MISMATCH_MESSAGE,
  );
  const joined = await read<Session>(
    call("/api/auth/invite/accept", { token, phone: "010-1234-5678", password: PASSWORD }),
  );
  assert.equal(joined.user.invitedBy, admin.user.id);
  assert.ok(!("passwordHash" in joined.user));

  // 그 뒤로는 전화번호 + 비밀번호로 로그인한다
  const session = await login("010-1234-5678");
  const me = await read<{ user: { invitedBy: string | null } }>(
    call("/api/me", undefined, session.token),
  );
  assert.equal(me.user.invitedBy, admin.user.id);

  // 쓰인 링크는 410, 내 초대 목록에는 «joined»
  assert.equal((await call(`/api/auth/invite/${token}`)).status, 410);
  const mine = await read<InviteView[]>(call("/api/invites", undefined, admin.token));
  const sent = mine.find((i) => i.id === created.invite.id);
  assert.equal(sent?.status, "joined");
  assert.equal(sent?.joinedUserId, joined.user.id);
  // 이미 가입한 번호는 다시 초대할 수 없고, 가입한 초대는 취소할 수 없다
  assert.equal(
    await errorOf(call("/api/invites", { phone: "01012345678" }, admin.token), 409),
    INVITE_ALREADY_MEMBER_MESSAGE,
  );
  assert.equal(
    (await call(`/api/invites/${created.invite.id}`, undefined, admin.token, "DELETE")).status,
    409,
  );
});

test("초대: 남이 초대 중인 번호는 409 · 내 번호 재초대는 옛 링크 무효 · 취소는 내 것만 · 만료는 410", async () => {
  const member = await login("010-1234-5678");
  const first = await read<{ link: string; invite: InviteView }>(
    call("/api/invites", { phone: "010-1234-0002" }, member.token),
    201,
  );
  // 다른 회원(관리자)이 같은 번호를 초대하려 하면 거절
  assert.equal(
    await errorOf(call("/api/invites", { phone: "010-1234-0002" }, admin.token), 409),
    INVITE_TAKEN_MESSAGE,
  );
  // 본인이 다시 초대하면 새 링크가 나오고 옛 링크는 죽는다
  const second = await read<{ link: string; invite: InviteView }>(
    call("/api/invites", { phone: "010-1234-0002" }, member.token),
    201,
  );
  assert.notEqual(second.link, first.link);
  assert.equal((await call(`/api/auth/invite/${tokenOf(first.link)}`)).status, 404);
  assert.equal((await call(`/api/auth/invite/${tokenOf(second.link)}`)).status, 200);
  const mine = await read<InviteView[]>(call("/api/invites", undefined, member.token));
  assert.deepEqual(
    mine.map((i) => [i.phone, i.status]),
    [["01012340002", "pending"]],
  );
  // 남의 초대는 내 목록에 없고, 취소도 404
  const adminList = await read<InviteView[]>(call("/api/invites", undefined, admin.token));
  assert.ok(adminList.every((i) => i.id !== second.invite.id));
  assert.equal(
    (await call(`/api/invites/${second.invite.id}`, undefined, admin.token, "DELETE")).status,
    404,
  );

  // 만료: 링크는 410, 목록은 «expired», 다른 회원이 그 번호를 초대할 수 있게 된다
  const stored = (await db.get<Invite>("system", "invites", second.invite.id)) as Invite;
  await db.put("system", "invites", { ...stored, expiresAt: Date.now() - 1000 });
  assert.equal((await call(`/api/auth/invite/${tokenOf(second.link)}`)).status, 410);
  assert.equal(
    (await read<InviteView[]>(call("/api/invites", undefined, member.token)))[0]?.status,
    "expired",
  );
  const taken = await read<{ invite: InviteView }>(
    call("/api/invites", { phone: "010-1234-0002" }, admin.token),
    201,
  );
  // 내 초대 취소 → 링크가 사라진다
  assert.equal(
    (await call(`/api/invites/${taken.invite.id}`, undefined, admin.token, "DELETE")).status,
    200,
  );
  assert.ok(
    (await read<InviteView[]>(call("/api/invites", undefined, admin.token))).every(
      (i) => i.id !== taken.invite.id,
    ),
  );
});

test("네트워크: 아래로만 보인다 — 위·옆은 없고, 손자의 번호는 가려진다", async () => {
  // root ─┬─ childA ── grandchild
  //       └─ childB
  await accounts.ensureAdmin("010-0000-0002", PASSWORD);
  const root = await login("010-0000-0002");
  const childA = await inviteAndJoin(root.token, "010-1111-0001");
  const childB = await inviteAndJoin(root.token, "010-1111-0002");
  const grandchild = await inviteAndJoin(childA.token, "010-1111-0003");
  await call("/api/me/profile", { displayName: "첫째" }, childA.token, "PATCH");
  // root 가 아직 가입 전인 한 명을 초대해 둔다
  await read(call("/api/invites", { phone: "010-1111-0009" }, root.token), 201);

  const top = await network(root.token);
  assert.equal(top.root.id, root.user.id);
  assert.equal(top.root.phone, "01000000002");
  assert.deepEqual(top.counts, { direct: 2, total: 3 }); // 가입한 회원만 센다
  assert.deepEqual(
    top.root.children.map((n) => [n.phone, n.status, n.name]),
    [
      ["01011110001", "joined", "첫째"],
      ["01011110002", "joined", null],
      ["01011110009", "invited", null], // 내 초대는 가입 전 잎으로
    ],
  );
  assert.equal(top.root.children[2]?.joinedAt, null);
  const viaA = top.root.children[0]?.children ?? [];
  assert.deepEqual(
    viaA.map((n) => [n.id, n.phone]),
    [[grandchild.user.id, "010-****-0003"]], // 두 단계 아래는 가린다
  );
  assert.ok(!JSON.stringify(top).includes("01011110003"));

  // 자식 A: 손자만 보인다 (자기 바로 아래라 번호 그대로). 부모·형제·부모의 초대는 어디에도 없다
  const mid = await network(childA.token);
  assert.equal(mid.root.id, childA.user.id);
  assert.deepEqual(mid.counts, { direct: 1, total: 1 });
  assert.deepEqual(
    mid.root.children.map((n) => [n.id, n.phone]),
    [[grandchild.user.id, "01011110003"]],
  );
  const midText = JSON.stringify(mid);
  for (const hidden of [root.user.id, "0000-0002", "00000002", childB.user.id, "1111-0002"])
    assert.ok(!midText.includes(hidden), `자식의 응답에 ${hidden} 가 있으면 안 된다`);
  assert.ok(!midText.includes("11110002") && !midText.includes("11110009"));

  // 형제 B·손자: 아래가 없다
  for (const leaf of [childB, grandchild]) {
    const bottom = await network(leaf.token);
    assert.equal(bottom.root.id, leaf.user.id);
    assert.deepEqual(bottom.root.children, []);
    assert.deepEqual(bottom.counts, { direct: 0, total: 0 });
  }

  // 다른 가지를 고르는 인자는 없다 — 무엇을 붙여도 내 트리다
  for (const query of [`?userId=${root.user.id}`, `?root=${root.user.id}`, `?id=${childB.user.id}`])
    assert.deepEqual(await network(grandchild.token, query), await network(grandchild.token));
  assert.equal((await call("/api/network")).status, 401);

  // 순환 방지: 기록이 꼬여 root 의 상위가 손자가 돼도 끝나고, 같은 사람이 두 번 나오지 않는다
  const rootRow = (await db.get<User>("system", "users", root.user.id)) as User;
  await db.put<User>("system", "users", { ...rootRow, invitedBy: grandchild.user.id });
  const looped = await network(root.token);
  assert.deepEqual(looped.counts, { direct: 2, total: 3 });
  const fromGrandchild = await network(grandchild.token);
  assert.deepEqual(fromGrandchild.counts, { direct: 1, total: 3 }); // root → A·B, 자기 자신으로는 돌아오지 않는다
  await db.put<User>("system", "users", rootRow);
});

test("가입 신청: 목적이 구체적이어야 하고, 비밀번호는 해시로만 남고, 검토 중 로그인은 403", async () => {
  const apply = (body: Record<string, unknown>) => call("/api/auth/waitlist", body);
  const phone = "010-2222-0001";
  // 목적 없음·짧음 → 400 + 구체적으로 적으라는 안내
  for (const purpose of [undefined, "", "써 보고 싶어요", " ".repeat(WAITLIST_PURPOSE_MIN + 5)])
    assert.equal(
      await errorOf(apply({ phone, password: PASSWORD, purpose }), 400),
      WAITLIST_PURPOSE_MESSAGE,
    );
  // 비밀번호 규칙은 가입과 같다
  assert.equal((await apply({ phone, password: "1", purpose: PURPOSE })).status, 422);
  assert.equal((await apply({ phone: "12345", password: PASSWORD, purpose: PURPOSE })).status, 422);
  assert.deepEqual(await read(call("/api/admin/waitlist", undefined, admin.token)), []);

  assert.deepEqual(
    await read(apply({ phone, password: PASSWORD, purpose: `  ${PURPOSE}  ` }), 201),
    {
      status: "pending",
    },
  );
  // 저장된 기록 어디에도 평문 비밀번호가 없다 — 해시만
  const stored = (await db.get<WaitlistEntry>(
    "system",
    "waitlist",
    "01022220001",
  )) as WaitlistEntry;
  assert.ok(!JSON.stringify(stored).includes(PASSWORD));
  assert.ok(!("password" in stored));
  assert.ok(stored.passwordHash && verifyPassword(PASSWORD, stored.passwordHash));
  assert.equal(stored.purpose, PURPOSE);
  const everything = await db.sql<{ data: unknown }>("SELECT data FROM records");
  assert.ok(everything.rows.every((row) => !JSON.stringify(row.data).includes(PASSWORD)));

  // 이미 검토 중 · 이미 회원
  assert.equal(
    await errorOf(apply({ phone: "01022220001", password: PASSWORD, purpose: PURPOSE }), 409),
    WAITLIST_ALREADY_PENDING_MESSAGE,
  );
  assert.equal(
    await errorOf(apply({ phone: "010-0000-0001", password: PASSWORD, purpose: PURPOSE }), 409),
    INVITE_ALREADY_MEMBER_MESSAGE,
  );

  // 검토 중 로그인: 비밀번호가 맞으면 403 안내, 틀리면 여느 실패와 같은 401
  assert.equal(
    await errorOf(call("/api/auth/login", { phone, password: PASSWORD }), 403),
    WAITLIST_PENDING_LOGIN_MESSAGE,
  );
  assert.equal((await call("/api/auth/login", { phone, password: "wrong-one" })).status, 401);

  // 관리자 목록에는 해시가 없다
  const list = await read<(WaitlistView & { passwordHash?: string })[]>(
    call("/api/admin/waitlist", undefined, admin.token),
  );
  assert.equal(list.length, 1);
  assert.deepEqual(
    [list[0]?.phone, list[0]?.purpose, list[0]?.status],
    ["01022220001", PURPOSE, "pending"],
  );
  assert.ok(!("passwordHash" in (list[0] as object)));
  assert.ok(!list[0]?.id.includes("22220001")); // 식별자는 전화번호가 아니다
});

test("가입 신청 승인: 상위 회원을 붙이면 그 번호·비밀번호로 로그인되고 상위 회원 아래에 나타난다", async () => {
  const parent = await login("010-1234-5678"); // 앞에서 초대로 가입한 일반 회원
  const [entry] = await read<WaitlistView[]>(call("/api/admin/waitlist", undefined, admin.token));
  assert.ok(entry);
  const approve = (parentId: unknown, token = admin.token) =>
    call(`/api/admin/waitlist/${entry.id}/approve`, { parentId }, token);

  // 관리자만, 상위 회원은 실제 회원이어야 한다
  assert.equal((await approve(parent.user.id, parent.token)).status, 403);
  assert.equal((await approve(undefined)).status, 422);
  assert.equal((await approve("no-such-user")).status, 404);
  assert.equal(
    (await call("/api/admin/waitlist/nope/approve", { parentId: parent.user.id }, admin.token))
      .status,
    404,
  );
  assert.equal(await accounts.userByPhone("01022220001"), null);

  // 상위 회원 찾기: 이름·전화번호 검색
  type Found = { id: string; phone: string; name: string | null; invitedBy: string | null };
  const byPhone = await read<Found[]>(call("/api/admin/users?q=1234-5678", undefined, admin.token));
  assert.deepEqual(
    byPhone.map((u) => [u.id, u.phone, u.invitedBy]),
    [[parent.user.id, "01012345678", admin.user.id]],
  );
  const byName = await read<Found[]>(call("/api/admin/users?q=관리", undefined, admin.token));
  assert.deepEqual(
    byName.map((u) => [u.id, u.name, u.invitedBy]),
    [[admin.user.id, "관리자", null]],
  );
  assert.ok((await read<Found[]>(call("/api/admin/users", undefined, admin.token))).length > 2);
  assert.ok(byPhone.every((u) => !("passwordHash" in u)));

  const before = audits.length;
  const approved = await read<WaitlistView>(approve(parent.user.id));
  assert.equal(approved.status, "approved");
  assert.equal(approved.parentId, parent.user.id);
  assert.ok(approved.decidedAt);
  // 감사 로그: 관리자 본인 것 + system 것
  const written = audits.slice(before);
  assert.deepEqual(
    written.map((a) => [a.owner, a.actor, a.result]),
    [
      [admin.user.id, `user:${admin.user.id}`, "ok"],
      ["system", `user:${admin.user.id}`, "ok"],
    ],
  );
  assert.ok(written.every((a) => a.action.startsWith(`waitlist.approve ${entry.id} `)));
  assert.ok(written.every((a) => !a.action.includes("22220001"))); // 로그에 전화번호를 싣지 않는다

  // 신청 때의 번호·비밀번호로 바로 로그인된다
  const session = await login("010-2222-0001");
  assert.equal(session.user.invitedBy, parent.user.id);
  // 승인 뒤에는 신청 기록에 해시를 남기지 않는다
  const stored = (await db.get<WaitlistEntry>(
    "system",
    "waitlist",
    "01022220001",
  )) as WaitlistEntry;
  assert.equal(stored.passwordHash, undefined);
  // 상위 회원의 네트워크에 나타난다
  const tree = await network(parent.token);
  assert.deepEqual(
    tree.root.children.filter((n) => n.status === "joined").map((n) => [n.id, n.phone]),
    [[session.user.id, "01022220001"]],
  );
  // 두 번 승인·승인 뒤 반려는 409
  assert.equal((await approve(parent.user.id)).status, 409);
  assert.equal(
    (await call(`/api/admin/waitlist/${entry.id}/reject`, { reason: "중복" }, admin.token)).status,
    409,
  );
});

test("가입 신청 반려: 사유가 필요하고, 신청자가 로그인하면 사유를 본다 · 다시 신청할 수 있다", async () => {
  const phone = "010-2222-0002";
  await read(call("/api/auth/waitlist", { phone, password: PASSWORD, purpose: PURPOSE }), 201);
  const entry = (
    await read<WaitlistView[]>(call("/api/admin/waitlist", undefined, admin.token))
  ).find((w) => w.phone === "01022220002") as WaitlistView;
  const reject = (reason: unknown, token = admin.token) =>
    call(`/api/admin/waitlist/${entry.id}/reject`, { reason }, token);
  const member = await login("010-1234-5678");
  assert.equal((await reject("사유", member.token)).status, 403);
  assert.equal((await reject("  ")).status, 422);

  const before = audits.length;
  const rejected = await read<WaitlistView>(reject("사용 목적이 서비스와 맞지 않습니다"));
  assert.deepEqual(
    [rejected.status, rejected.rejectReason],
    ["rejected", "사용 목적이 서비스와 맞지 않습니다"],
  );
  assert.deepEqual(
    audits.slice(before).map((a) => [a.owner, a.action]),
    [
      [admin.user.id, `waitlist.reject ${entry.id}`],
      ["system", `waitlist.reject ${entry.id}`],
    ],
  );
  assert.equal(
    await errorOf(call("/api/auth/login", { phone, password: PASSWORD }), 403),
    waitlistRejectedMessage("사용 목적이 서비스와 맞지 않습니다"),
  );
  assert.equal(await accounts.userByPhone("01022220002"), null);
  // 반려된 번호는 다시 신청할 수 있고, 다시 검토 중이 된다
  await read(call("/api/auth/waitlist", { phone, password: PASSWORD, purpose: PURPOSE }), 201);
  assert.equal(
    await errorOf(call("/api/auth/login", { phone, password: PASSWORD }), 403),
    WAITLIST_PENDING_LOGIN_MESSAGE,
  );
});

test("가입 신청: 번호만 있는 옛 항목은 승인할 수 없다고 분명히 알린다 (조용히 넘기지 않는다)", async () => {
  await db.put<WaitlistEntry>("system", "waitlist", {
    id: "01022220003",
    requestedAt: new Date().toISOString(),
  });
  const legacy = (
    await read<WaitlistView[]>(call("/api/admin/waitlist", undefined, admin.token))
  ).find((w) => w.phone === "01022220003") as WaitlistView;
  assert.deepEqual([legacy.status, legacy.purpose], ["pending", ""]);
  assert.match(
    await errorOf(
      call(`/api/admin/waitlist/${legacy.id}/approve`, { parentId: admin.user.id }, admin.token),
      409,
    ),
    /옛 신청/,
  );
  assert.equal(await accounts.userByPhone("01022220003"), null);
});

test("탈퇴 정리: 지워지는 회원의 아래 사람은 한 단계 위로 붙고, 안 쓰인 초대는 사라진다", async () => {
  await accounts.ensureAdmin("010-0000-0003", PASSWORD);
  const top = await login("010-0000-0003");
  const middle = await inviteAndJoin(top.token, "010-3333-0001");
  const bottom = await inviteAndJoin(middle.token, "010-3333-0002");
  const pending = await read<{ link: string }>(
    call("/api/invites", { phone: "010-3333-0009" }, middle.token),
    201,
  );
  await accounts.requestDeletion(middle.user.id, async () => undefined);
  const reports = await accounts.purgeDeleted({
    memories: { removeAll: async () => 0 },
    audit: async () => undefined,
    now: Date.now() + 365 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(
    reports.map((r) => [r.userId, r.error]),
    [[middle.user.id, undefined]],
  );
  const tree = await network(top.token);
  assert.deepEqual(
    tree.root.children.map((n) => n.id),
    [bottom.user.id],
  );
  assert.equal((await call(`/api/auth/invite/${tokenOf(pending.link)}`)).status, 404);
});

test("권한 부여: 관리자만 역할을 바꾸고, 자기 역할은 못 바꾼다", async () => {
  const member = await inviteAndJoin(admin.token, "010-1234-7001");
  const role = (id: string, value: string, token: string) =>
    call(`/api/admin/users/${id}/role`, { role: value }, token, "PATCH");
  assert.equal((await role(member.user.id, "operator", member.token)).status, 403);
  assert.equal((await role(admin.user.id, "user", admin.token)).status, 409, "자기 역할");
  assert.equal((await role("no-such-user", "operator", admin.token)).status, 404);
  assert.equal((await role(member.user.id, "owner", admin.token)).status, 422, "없는 역할");
  const promoted = await read<{ role: string }>(role(member.user.id, "admin", admin.token));
  assert.equal(promoted.role, "admin");
  // 새 관리자는 관리자 화면을 쓸 수 있고, 다른 관리자의 역할도 바꿀 수 있다
  assert.equal((await call("/api/admin/users", undefined, member.token)).status, 200);
  assert.equal((await role(admin.user.id, "operator", member.token)).status, 200);
  assert.equal((await call("/api/admin/users", undefined, admin.token)).status, 403);
  // 되돌려 둔다 — 뒤 테스트가 admin 을 관리자로 쓴다
  assert.equal((await role(admin.user.id, "admin", member.token)).status, 200);
});
