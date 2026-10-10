// 문자 인증(마스터 2026-10-10): 가입·비밀번호 찾기는 그 번호로 온 인증번호를 맞혀야 하고, 설정이 없으면 조용히 통과하지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { publicAccountRoutes } from "../apps/server/src/osiri/account-routes.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { otpGateway } from "../apps/server/src/osiri/otp.ts";
import { fakeOtp, sentOtps, WRONG_OTP_CODE } from "./helpers/otp.ts";

const directory = await mkdtemp(join(tmpdir(), "osiri-otp-"));
after(() => rm(directory, { recursive: true, force: true }));
const db = await createStore({ dataDir: join(directory, "db") });
const accounts = new Accounts(db);
const app = new Hono();
app.onError((e, c) =>
  c.json({ error: e.message }, (e instanceof AppError ? e.status : 500) as 400),
);
app.route("/api/auth", publicAccountRoutes(accounts, fakeOtp));
const post = async (path: string, body: object) => {
  const r = await app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test("인증번호 받기: 가입은 회원 아닌 번호만, 비밀번호 찾기는 회원 번호만 보낸다", async () => {
  await accounts.createUser({ phone: "010-1234-5678", password: "password-1", role: "user" });
  assert.equal((await post("/otp", { phone: "010-1234-5678", purpose: "signup" })).status, 409);
  assert.equal((await post("/otp", { phone: "010-1234-0000", purpose: "reset" })).status, 404);
  assert.equal((await post("/otp", { phone: "010-1234-0000", purpose: "signup" })).status, 200);
  assert.equal((await post("/otp", { phone: "010-1234-5678", purpose: "reset" })).status, 200);
  assert.deepEqual(sentOtps.slice(-2), [
    { phone: "01012340000", purpose: "signup" },
    { phone: "01012345678", purpose: "reset" },
  ]);
});

test("비밀번호 찾기: 틀린 인증번호는 거절, 맞으면 새 비밀번호로 로그인되고 옛 비밀번호는 안 된다", async () => {
  const phone = "010-1234-5678";
  const wrong = await post("/password/reset", {
    phone,
    code: WRONG_OTP_CODE,
    password: "new-pass-1",
  });
  assert.equal(wrong.status, 400);
  const ok = await post("/password/reset", { phone, code: "123456", password: "new-pass-1" });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await post("/login", { phone, password: "password-1" })).status, 401);
  assert.equal((await post("/login", { phone, password: "new-pass-1" })).status, 200);
});

test("가입 신청도 틀린 인증번호면 남지 않는다", async () => {
  const r = await post("/waitlist", {
    phone: "010-1234-1111",
    password: "password-1",
    purpose: "상속 상담 기록을 정리하고 고객별 진행 상황을 추적하려고 합니다",
    code: WRONG_OTP_CODE,
  });
  assert.equal(r.status, 400);
});

test("설정이 없으면 503 으로 실패한다 — 인증 없이 통과하지 않는다", async () => {
  const otp = otpGateway(undefined, undefined);
  await assert.rejects(otp.request("01012345678", "signup"), (e: AppError) => e.status === 503);
  await assert.rejects(
    otp.verify("01012345678", "123456", "signup"),
    (e: AppError) => e.status === 503,
  );
});
