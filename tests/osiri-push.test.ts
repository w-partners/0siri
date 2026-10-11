// 푸시: FCM v1 — 서비스 계정 JWT(RS256)로 토큰 받고, 멤버 기기로 보내고, 죽은 토큰은 지운다. 자격증명 없으면 꺼짐을 알리고 건너뛴다.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { Groups } from "../apps/server/src/osiri/groups.ts";
import { Push } from "../apps/server/src/osiri/push.ts";

let db: Store, directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-push-"));
  db = await createStore({ dataDir: join(directory, "db") });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  FIREBASE_PROJECT_ID: "osiri-test",
  FIREBASE_CLIENT_EMAIL: "push@osiri-test.iam.gserviceaccount.com",
  // env 한 줄 저장 모양(\n 글자)
  FIREBASE_PRIVATE_KEY: (privateKey.export({ type: "pkcs8", format: "pem" }) as string).replace(
    /\n/g,
    "\\n",
  ),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

test("FCM v1 로 멤버 기기에 보내고, 죽은 토큰은 지우고, 토큰은 암호문으로만", async () => {
  const sends: { token: string; body: string; data: Record<string, string>; auth: string }[] = [];
  let tokenRequests = 0;
  const http = (async (url: string, init: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenRequests++;
      const assertion = new URLSearchParams(init.body as URLSearchParams).get("assertion") ?? "";
      const [h, p, sig] = assertion.split(".");
      const ok = createVerify("RSA-SHA256")
        .update(`${h}.${p}`)
        .verify(publicKey, Buffer.from(sig as string, "base64url"));
      const claims = JSON.parse(Buffer.from(p as string, "base64url").toString());
      assert.ok(ok, "서명이 서비스 계정 키로 검증된다");
      assert.equal(claims.iss, env.FIREBASE_CLIENT_EMAIL);
      assert.match(claims.scope, /firebase\.messaging/);
      return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    }
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/osiri-test/messages:send");
    const { message } = JSON.parse(init.body as string);
    sends.push({
      token: message.token,
      body: message.notification.body,
      data: message.data,
      auth: (init.headers as Record<string, string>).authorization,
    });
    assert.equal(message.android.notification.channel_id, "messages");
    if (message.token === "dead-token-0000")
      return Response.json(
        { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
        { status: 404 },
      );
    return Response.json({ name: "projects/osiri-test/messages/1" });
  }) as typeof fetch;

  const accounts = new Accounts(db);
  const groups = new Groups(db, accounts);
  const push = new Push(db, env, http);
  groups.onPosted(async (group, message) => {
    await push.notify(
      group.members.filter((m) => m.userId !== message.authorId).map((m) => m.userId),
      {
        title: group.title,
        body: `${message.nickname}: ${message.text}`,
        data: { groupId: group.id },
      },
    );
  });
  const owner = await accounts.createUser({ phone: "01012345690", password: "pass1234" });
  const friend = await accounts.createUser({ phone: "01012345691", password: "pass1234" });
  await push.register(friend.id, "live-token-1111");
  await push.register(friend.id, "dead-token-0000");
  await push.register(owner.id, "owner-token-2222");
  const group = await groups.create(owner.id, "골프 모임");
  await groups.invite(owner.id, group.id, { phone: "01012345691", nickname: "김프로" });

  await groups.say(owner.id, group.id, "토요일 7시?");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    sends.map((s) => s.token).sort(),
    ["dead-token-0000", "live-token-1111"],
    "쓴 사람에게는 안 보낸다",
  );
  assert.ok(sends.every((s) => s.body.includes("토요일 7시?") && s.data.groupId === group.id));
  assert.ok(sends.every((s) => s.auth === "Bearer ya29.test"));
  assert.equal((await push.status(friend.id)).devices, 1, "UNREGISTERED 토큰은 지웠다");

  await groups.say(friend.id, group.id, "좋아요");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sends.at(-1)?.token, "owner-token-2222");
  assert.equal(tokenRequests, 1, "access token 은 재사용");

  // 안내 줄(들어왔습니다 등)은 알리지 않는다
  const before = sends.length;
  await groups.rename(friend.id, group.id, "프로");
  await groups.post(group, "system", "안내", "안내 문구");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sends.length, before);

  // 저장소 어디에도 기기 토큰 평문이 없다
  const files = await readdir(join(directory, "db"), { recursive: true });
  let all = "";
  for (const f of files) all += await readFile(join(directory, "db", f as string)).catch(() => "");
  assert.ok(all.length > 0);
  assert.ok(!all.includes("live-token-1111"));
});

test("자격증명이 없으면 보내지 않고 status 가 빠진 env 를 알린다", async () => {
  let called = 0;
  const push = new Push(db, {}, (async () => {
    called++;
    return Response.json({});
  }) as typeof fetch);
  assert.deepEqual(await push.notify(["u1"], { title: "t", body: "b" }), {
    sent: 0,
    skipped: "not_configured",
  });
  assert.equal(called, 0);
  const status = await push.status("u1");
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
  ]);
});
