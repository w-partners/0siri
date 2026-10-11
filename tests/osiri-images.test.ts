// 대화 사진: 형식은 머리 바이트로 정하고, 본인 사진만 열리며, 메시지의 표시만 이미지로 바뀐다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Images, imageRoutes, imageType } from "../apps/server/src/osiri/images.ts";

let db: Store, directory: string, images: Images;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const appAs = (owner: string) => {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", owner);
    await next();
  });
  app.onError((error, c) =>
    c.json({ error: error.message }, (error as { status?: 400 }).status ?? 500),
  );
  return app.route("/api", imageRoutes(images));
};
const upload = (owner: string, bytes: Uint8Array, name = "a.png") => {
  const form = new FormData();
  form.append("file", new File([Buffer.from(bytes)], name));
  return appAs(owner).request("/api/images", { method: "POST", body: form });
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-images-"));
  db = await createStore({ dataDir: join(directory, "db") });
  images = new Images(db, directory);
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("형식은 머리 바이트로 — 이름이 .png 여도 PDF 는 거절", async () => {
  assert.equal(imageType(PNG), "image/png");
  assert.equal(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageType(new TextEncoder().encode("%PDF-1.7")), undefined);
  const response = await upload("alice", new TextEncoder().encode("%PDF-1.7"), "fake.png");
  assert.equal(response.status, 422);
});

test("올린 사진은 본인만 열고, 메시지 표시는 이미지 파트로 바뀐다", async () => {
  const response = await upload("alice", PNG);
  assert.equal(response.status, 201);
  const { id, mimeType } = (await response.json()) as { id: string; mimeType: string };
  assert.equal(mimeType, "image/png");
  assert.equal((await appAs("alice").request(`/api/images/${id}`)).status, 200);
  assert.equal((await appAs("bob").request(`/api/images/${id}`)).status, 404);

  assert.equal(await images.expand("alice", "그냥 글"), "그냥 글");
  const parts = await images.expand("alice", `[사진 ${id}] 이게 뭐야?`);
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: "text", text: "이게 뭐야?" });
  assert.deepEqual(parts[1], {
    type: "image",
    source: { type: "data", value: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
  });
  // 남의 사진 id 는 열지 않고, 못 열었다고 글로 남긴다
  const other = await images.expand("bob", `[사진 ${id}] 이게 뭐야?`);
  assert.ok(Array.isArray(other));
  assert.equal(other.length, 1);
  assert.match((other[0] as { text: string }).text, /열지 못했습니다/);
});
