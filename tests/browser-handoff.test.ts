// 대화 안 브라우저: 프로필은 사람에게 붙고(대화를 넘어 같은 세션), 영시리가 넘기면 사람만 조작하고 돌려받을 때까지 기다린다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserFixture } from "./helpers/browser.ts";

const page = {
  url: "https://example.com/login",
  title: "Login",
  text: "Signed in",
  truncated: false,
};

test("브라우저 프로필 — 대화가 달라도 같은 프로필, 프로필을 바꾸면 다른 세션", async (t) => {
  const { service } = await browserFixture(t, (path, body) =>
    path.endsWith("/read")
      ? { data: page }
      : {
          data: {
            id: body.id,
            url: body.url,
            title: "t",
            status: "active",
            updatedAt: "2026-10-12T00:00:00.000Z",
          },
        },
  );
  const a = await service.observeForThread("owner", "thread-a", page.url);
  const b = await service.observeForThread("owner", "thread-b", page.url);
  assert.equal(a.sessionId, b.sessionId);
  const first = await service.profiles("owner");
  assert.deepEqual(
    first.profiles.map((p) => p.name),
    ["기본"],
  );
  const work = await service.createProfile("owner", "회사");
  await service.useProfile("owner", work.id);
  const c = await service.observeForThread("owner", "thread-a", page.url);
  assert.equal(c.sessionId, work.id);
  assert.notEqual(c.sessionId, a.sessionId);
  await assert.rejects(service.useProfile("stranger", work.id), { status: 404 });
});

test("넘기기 — 사람만 조작하고, 돌려주면 영시리가 그 화면을 읽고 이어 간다", async (t) => {
  const inputs: unknown[] = [];
  const { service } = await browserFixture(t, (path, body) => {
    if (path.endsWith("/read")) return { data: page };
    if (path.endsWith("/input")) inputs.push(body);
    return {
      data: {
        id: path.split("/")[2] ?? body.id,
        url: page.url,
        title: "t",
        status: "active",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    };
  });
  const opened = await service.observeForThread("owner", "thread", page.url);
  const id = opened.sessionId;
  // 넘기기 전: 사람은 조작할 수 없다
  await assert.rejects(service.input("owner", id, { type: "click", x: 1, y: 1 }), { status: 409 });
  const waiting = service.handoff("owner", "로그인해 주세요");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(service.holder(id), { holder: "user", reason: "로그인해 주세요" });
  // 넘긴 동안: 사람은 조작하고, 영시리의 이동은 거절된다
  await service.input("owner", id, { type: "text", text: "hello" });
  assert.equal(inputs.length, 1);
  await assert.rejects(service.observeForThread("owner", "thread", page.url), { status: 409 });
  await assert.rejects(service.setHolder("stranger", id, "agent"), { status: 404 });
  await service.setHolder("owner", id, "agent");
  const done = await waiting;
  assert.equal(done.outcome, "returned");
  assert.equal(done.text, "Signed in");
  assert.equal(service.holder(id).holder, "agent");
});

test("넘기기 — 돌려주지 않으면 시간이 다 돼 timeout 으로 돌아온다", async (t) => {
  const { service } = await browserFixture(t, (path, body) =>
    path.endsWith("/read")
      ? { data: page }
      : {
          data: {
            id: body.id,
            url: page.url,
            title: "t",
            status: "active",
            updatedAt: "2026-10-12T00:00:00.000Z",
          },
        },
  );
  const { sessionId } = await service.observeForThread("owner", "thread", page.url);
  const done = await service.handoff("owner", "본인 확인", undefined, 20);
  assert.equal(done.outcome, "timeout");
  assert.equal(service.holder(sessionId).holder, "agent");
});
