// 오류 보고·제안(마스터 2026-10-10): 앱 맥락 + 서버의 사용자 정보가 page-picker 로 가고, 번호는 가리고, 설정이 없으면 503.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { bugReportRoutes, maskPhone } from "../apps/server/src/osiri/bug-report.ts";

const directory = await mkdtemp(join(tmpdir(), "osiri-report-"));
after(() => rm(directory, { recursive: true, force: true }));
const keyFile = join(directory, "pp.key");
await writeFile(keyFile, "test-site-key\n");
const accounts = new Accounts(await createStore({ dataDir: join(directory, "db") }));
const user = await accounts.createUser({
  phone: "010-1234-5678",
  password: "password-1",
  role: "user",
});

const appWith = (base?: string, key?: string) => {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.onError((e, c) =>
    c.json({ error: e.message }, (e instanceof AppError ? e.status : 500) as 400),
  );
  app.use(async (c, next) => {
    c.set("owner", user.id);
    await next();
  });
  app.route("/api", bugReportRoutes(accounts, base, key));
  return app;
};
const send = (app: Hono<{ Variables: { owner: string } }>, body: object) =>
  app.request("/api/error-report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("제안이 page-picker 로 간다 — 키 헤더, 제목 머리, 가린 번호, 앱 맥락, 사람용 요약", async () => {
  const real = globalThis.fetch;
  let seen: { url: string; headers: Record<string, string>; body: Record<string, any> } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    return new Response(JSON.stringify({ id: 42 }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await send(appWith("http://pp.test", keyFile), {
      kind: "idea",
      title: "피드 주제별 보기",
      description: "주제로 묶어 주세요",
      client: {
        device: { os: "android", model: "SM-F711N", appVersion: "0.14.0" },
        activity: [{ type: "screen", name: "tab:feed" }],
        logs: [],
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: 42 });
    assert.equal(seen?.url, "http://pp.test/widget/reports");
    assert.equal(seen?.headers["X-PP-Api-Key"], "test-site-key");
    assert.equal(seen?.body.title, "[0Siri 제안] 피드 주제별 보기");
    const snap = seen?.body.snapshot;
    assert.equal(snap.user.phone, "010-****-5678");
    assert.ok(!JSON.stringify(seen?.body).includes("01012345678"), "전체 번호가 나가면 안 된다");
    assert.equal(snap.device.model, "SM-F711N");
    assert.match(snap.narration, /제안 · 피드 주제별 보기/);
    assert.match(snap.narration, /tab:feed/);
  } finally {
    globalThis.fetch = real;
  }
});

test("설정이 없으면 조용히 버리지 않고 503", async () => {
  const r = await send(appWith(undefined, undefined), { title: "x", client: {} });
  assert.equal(r.status, 503);
});

test("번호 가리기", () => assert.equal(maskPhone("01012345678"), "010-****-5678"));
