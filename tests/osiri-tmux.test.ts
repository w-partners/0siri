// tmux 붙이기: 보낸 글에 턴 회신 주소·열쇠가 붙고, 그 열쇠로 답하면 그 턴의 답이 된다 · 틀린 열쇠 403 · 끝난 턴 410 ·
// 웹훅 실패 502 · 답 없음 503 (조용히 넘어가지 않는다)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Tmux } from "../apps/server/src/osiri/tmux.ts";

let db: Store, directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-tmux-"));
  db = await createStore({ dataDir: join(directory, "db") });
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
const status = (e: unknown) => (e as { status?: number }).status;

test("tmux: send to the webhook, the terminal replies with the turn key, failures are loud", async () => {
  const sent: { url: string; command: string }[] = [];
  let ok = true;
  const fakeFetch = (async (url: string, init: { body: string }) => {
    sent.push({ url, command: JSON.parse(init.body).command });
    return { ok, status: ok ? 200 : 500 } as Response;
  }) as unknown as typeof fetch;
  const tmux = new Tmux(db, "https://osiri.test/", fakeFetch, 200);

  const link = await tmux.attach("me", "room-1", "http://portal.test/api/webhook/yeongsil-primary");
  assert.deepEqual((await tmux.linked("me", "room-1"))?.webhook, link.webhook);

  const answer = tmux.ask("me", link, "안녕");
  await new Promise((r) => setImmediate(r));
  const { url, command } = sent[0] as { url: string; command: string };
  assert.equal(url, link.webhook);
  assert.match(command, /^\[영시리\] 안녕/);
  const turn = command.match(/\/api\/tmux\/reply\/([\w-]+)"/)?.[1] as string;
  const key = command.match(/Bearer ([\w-]+)"/)?.[1] as string;
  assert.ok(turn && key);
  assert.throws(
    () => tmux.reply(turn, "Bearer nope", "x"),
    (e) => status(e) === 403,
  );
  tmux.reply(turn, `Bearer ${key}`, "반가워요");
  assert.equal(await answer, "반가워요");
  assert.throws(
    () => tmux.reply(turn, `Bearer ${key}`, "또"),
    (e) => status(e) === 410,
  );

  // 답이 없으면 503
  await assert.rejects(tmux.ask("me", link, "거기 있어?"), (e) => status(e) === 503);
  // 웹훅이 실패하면 502
  ok = false;
  await assert.rejects(tmux.ask("me", link, "또"), (e) => status(e) === 502);

  await tmux.detach("me", "room-1");
  assert.ok(!(await tmux.linked("me", "room-1")));
});
