// §17.1 → §17.2: 여러 구독자의 반려 신호(사유 종류)가 반복되면 팀 공통 스킬 초안이 운영자 콘솔로 간다.
// 한 사람만의 반려는 팀 공통이 되지 않는다(§17.4). 사용자가 쓴 반려 문장은 운영자에게 가지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { Accounts } from "../apps/server/src/osiri/accounts.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Operator } from "../apps/server/src/osiri/operator.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import { Skills } from "../apps/server/src/osiri/skills.ts";
import { Catalog } from "../apps/server/src/osiri/store.ts";
import { grantOnSubscribe } from "./grant-on-subscribe.ts";

let db: Store, directory: string, rooms: Rooms, catalog: Catalog, approvals: Approvals;
let operator: Operator, skills: Skills, packageId: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-discover-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const bus = new EventBus();
  rooms = new Rooms(db, bus);
  catalog = new Catalog(db, rooms);
  approvals = new Approvals(db, rooms, bus);
  skills = new Skills(db, rooms);
  operator = new Operator(db, rooms, catalog, {} as Accounts, skills);
  grantOnSubscribe(catalog);
  packageId = (
    await catalog.upsertPackage({
      slug: "legal-marketing",
      name: "법률 마케팅팀",
      character: "counsel",
      category: "legal",
      summary: "",
      roles: [
        { name: "root", title: "팀장", summary: "" },
        { name: "drafter", title: "초안", summary: "" },
        { name: "reviewer", title: "검수", summary: "" },
        { name: "publisher", title: "발행", summary: "" },
        { name: "analyst", title: "보고", summary: "" },
      ],
      approvalPoints: ["발행"],
      reportCadence: "weekly",
      verified: true,
      metrics: { published: 0, indexed: 0, ai_citations: 0 },
      runtime: { teamYaml: "teams/legal-marketing.yaml", image: "osiri/team-runtime" },
    })
  ).id;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function reject(owner: string, roomId: string, n: number, reasonKind: "fact" | "tone") {
  const approval = await approvals.request(owner, {
    roomId,
    toolName: "site:publish",
    input: { n, owner },
    title: `글 ${n}`,
    summary: "",
    requestedBy: "publisher",
  });
  await approvals.decide(owner, approval.id, "reject", {
    reasonKind,
    reason: `비밀 사건번호 ${owner}-${n}`,
    decidedBy: owner,
  });
}

test("repeated rejections across subscribers → one package skill draft for the operator; one person's taste does not", async () => {
  const a = await catalog.subscribe("lawyer-a", packageId);
  const b = await catalog.subscribe("lawyer-b", packageId);
  // 사실 반려: 두 사람에게서 3건 → 팀 공통 초안
  await reject("lawyer-a", a.roomId, 1, "fact");
  await reject("lawyer-a", a.roomId, 2, "fact");
  assert.deepEqual(await operator.discoverSkills(packageId), { drafted: [] }, "한 사람뿐이면 아직");
  await reject("lawyer-b", b.roomId, 3, "fact");
  // 톤 반려: 한 사람이 3건 → 개인 취향, 팀 공통이 아니다
  for (const n of [4, 5, 6]) await reject("lawyer-a", a.roomId, n, "tone");

  assert.deepEqual(await operator.discoverSkills(packageId), { drafted: ["검수 보강: 사실"] });
  const [draft] = await skills.packageSkills(packageId);
  assert.equal(draft?.status, "draft", "승인 없이는 장착되지 않는다");
  assert.equal(draft?.scope, "package");
  assert.match(draft?.evidence ?? "", /반려 3건 · 구독자 2명/);
  assert.doesNotMatch(
    JSON.stringify(draft),
    /비밀 사건번호/,
    "사용자가 쓴 반려 문장은 운영자에게 가지 않는다",
  );
  assert.match(draft?.appliesTo ?? "", /출처/);

  // 다시 돌려도 같은 초안을 또 내지 않는다
  assert.deepEqual(await operator.discoverSkills(packageId), { drafted: [] });
  // 30일 밖의 신호는 세지 않는다
  assert.deepEqual(await operator.discoverSkills(packageId, Date.now() + 31 * 86_400_000), {
    drafted: [],
  });
});
