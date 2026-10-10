// 0SIRI-SPEC §4·§7: 채팅 threadId = 방 id → 개인 방은 영시리, 팀 방은 팀장 페르소나, 그 외 스레드는 기본 프롬프트.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { roomPersona } from "../apps/server/src/osiri/persona.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Catalog } from "../apps/server/src/osiri/store.ts";

let db: Store, directory: string, rooms: Rooms, catalog: Catalog;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-persona-"));
  db = await createStore({ dataDir: join(directory, "db") });
  rooms = new Rooms(db, new EventBus());
  catalog = new Catalog(db, rooms);
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("개인 방 → 영시리, 팀 방 → 팀장 + 승인 지점, 낯선 스레드 → undefined", async () => {
  const persona = roomPersona(rooms, catalog);
  const personal = await rooms.ensurePersonalRoom("u1");
  assert.match((await persona("u1", personal.id)) ?? "", /영시리/);
  const pkg = await catalog.upsertPackage({
    slug: "legal-marketing",
    name: "법률 마케팅팀",
    character: "counsel",
    category: "legal",
    summary: "판례 감지부터 발행까지",
    roles: [
      { name: "root", title: "팀장", summary: "" },
      { name: "drafter", title: "초안", summary: "" },
      { name: "monitor", title: "감지", summary: "감지" },
      { name: "geo", title: "GEO", summary: "GEO" },
      { name: "reviewer", title: "검수", summary: "" },
      { name: "publisher", title: "발행", summary: "" },
      { name: "analyst", title: "보고", summary: "" },
    ],
    approvalPoints: ["발행 전 변호사 승인"],
    reportCadence: "weekly",
    verified: true,
    metrics: { published: 0, indexed: 0, ai_citations: 0 },
    runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
  });
  const team = await rooms.create("u1", {
    packageId: pkg.id,
    title: pkg.name,
    character: pkg.character,
  });
  const text = (await persona("u1", team.id)) ?? "";
  assert.match(text, /법률 마케팅팀/);
  assert.match(text, /발행 전 변호사 승인/);
  assert.equal(await persona("u1", "not-a-room"), undefined);
  assert.equal(await persona("u2", personal.id), undefined, "남의 방은 보이지 않는다");
});
