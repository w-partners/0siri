// 0SIRI-SPEC §22-8: 법률팀 YAML 로드 → 목표 분해 → 감지·초안·GEO·검수 → 발행 전 승인 정지 → 승인 후 1회 발행 → 주간 보고 3지표.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { Approvals } from "../apps/server/src/osiri/approvals.ts";
import { EventBus } from "../apps/server/src/osiri/events.ts";
import { Mcp, mcpRoutes } from "../apps/server/src/osiri/mcp.ts";
import { roomRoutes, workerRoutes } from "../apps/server/src/osiri/room-routes.ts";
import { Rooms } from "../apps/server/src/osiri/rooms.ts";
import {
  everyMs,
  loadTeam,
  rolePrompt,
  TeamRuntime,
  type TeamSpec,
} from "../apps/server/src/osiri/team-runtime.ts";

let db: Store, directory: string;
let app: Hono<{ Variables: { owner: string } }>;
const OWNER = "lawyer";
const published: string[] = [];
const llmCalls: string[] = [];
let reviewPass = true;
const REVISED = "유류분 반환청구 기한 (짧게)";
const user = (path: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** 가짜 LLM — 역할별 정해진 JSON. 실제 모델 없이 흐름·게이트만 검증한다. */
const fakeLlm = async (role: string, tier: number, _system?: string, prompt = "") => {
  llmCalls.push(`${role}:${tier}`);
  if (prompt.startsWith("수정 요청:"))
    return JSON.stringify({
      title: REVISED,
      body: "핵심 답변: 1년/10년.",
      sources: ["민법 제1117조"],
    });
  switch (role) {
    case "root":
      return JSON.stringify({
        long: "상속 분야 AI 검색 선점",
        mid: ["10월 상속 콘텐츠 4건"],
        short: [{ title: "유류분 반환청구 기한 글", tasks: ["판례 조사", "초안"] }],
      });
    case "monitor":
      return "2026-09 대법원 유류분 판결 1건 — 기산점 해석 변경";
    case "drafter":
      return JSON.stringify({
        title: "유류분 반환청구, 언제까지 해야 하나",
        body: "민법 제1117조에 따르면…",
        sources: ["민법 제1117조", "대법원 2026다1234"],
      });
    case "geo":
      return JSON.stringify({
        title: "유류분 반환청구 기한은 언제까지인가요?",
        body: "핵심 답변: 1년/10년. 근거: 민법 제1117조…",
        sources: ["민법 제1117조", "대법원 2026다1234"],
      });
    case "reviewer":
      return JSON.stringify(
        reviewPass
          ? { pass: true, reasons: [] }
          : { pass: false, reasons: ["출처 없는 단정 표현"] },
      );
    case "analyst":
      return JSON.stringify({
        summary: "이번 주 1건 발행 완료",
        next_week_plan: ["기여분 글 초안"],
      });
    default:
      return "{}";
  }
};

async function publishMcp() {
  const server = new McpServer({ name: "site", version: "0.0.1" });
  server.registerTool(
    "site_publish_post",
    {
      description: "홈페이지 발행",
      inputSchema: { title: z.string(), body: z.string(), sources: z.array(z.string()) },
      _meta: { "x-osiri-risk": "external" },
    },
    async ({ title }) => {
      published.push(title);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return client;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "osiri-team-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const bus = new EventBus();
  const rooms = new Rooms(db, bus);
  const approvals = new Approvals(db, rooms, bus);
  const mcp = new Mcp(db, rooms, approvals, publishMcp);
  const deps = { db, rooms, approvals, bus, mcp };
  app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) =>
    c.json({ error: error.message }, error instanceof AppError ? error.status : 500),
  );
  app.route("/api/worker", workerRoutes(deps));
  app.use("/api/*", async (c, next) => {
    c.set("owner", (c.req.header("authorization") ?? "").slice(7));
    await next();
  });
  app.route("/api", roomRoutes(deps));
  app.route("/api", mcpRoutes(mcp));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("법률팀 YAML — 8역할·팀장·검수·발행·승인 지점", async () => {
  const team = await loadTeam("teams/legal-marketing.yaml");
  assert.equal(Object.keys(team.agents).length, 8);
  assert.deepEqual(team.agents.root?.sub_agents, [
    "monitor",
    "drafter",
    "geo",
    "reviewer",
    "publisher",
    "support",
    "analyst",
  ]);
  assert.equal(team.agents.reviewer?.["x-osiri-tier"], 4);
  assert.ok(team.package.approval_points.includes("홈페이지·SNS 발행"));
});

test("목표 분해 → 파이프라인 → 승인 전 정지 → 승인 후 1회 발행 → 주간 보고", async () => {
  const team = await loadTeam("teams/legal-marketing.yaml");
  const roomId = ((await (await user("/api/rooms")).json()) as { id: string }[])[0]?.id as string;
  const { token } = (await (await user(`/api/rooms/${roomId}/worker-token`, {})).json()) as {
    token: string;
  };
  const site = (await (
    await user("/api/connections/mcp", { name: "site", url: "http://site.test/mcp" })
  ).json()) as { id: string };
  const runtime = new TeamRuntime({
    apiUrl: "http://osiri.test/api/worker",
    workerToken: token,
    team,
    llm: fakeLlm,
    fetchFn: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
    maxPolls: 1,
    log: () => undefined,
  });
  const publishTool = { serverId: site.id, tool: "site_publish_post" };

  // 분해: 장기 1 · 중기 1 · 단기 1 · 작업 2
  const goals = await runtime.decompose("상속 분야 GEO 선점");
  const tree = (await (await user(`/api/goals?room_id=${roomId}`)).json()) as {
    level: string;
    title: string;
    status: string;
    stage?: string;
  }[];
  assert.deepEqual(tree.map((g) => g.level).sort(), ["long", "mid", "short", "task", "task"]);
  assert.equal(llmCalls[0], "root:4", "팀장은 최고 모델");
  const short = goals.find((g) => g.level === "short") as {
    id: string;
    title: string;
    level: string;
    parentId: string | null;
    status: string;
    progress: number;
  };

  // 검수 실패 → 승인 요청 없음, 발행 없음
  reviewPass = false;
  assert.equal(await runtime.runShortGoal(short, publishTool), "review_failed");
  assert.equal(
    ((await (await user("/api/inbox")).json()) as { pending: unknown[] }).pending.length,
    0,
  );
  assert.deepEqual(published, []);

  // 검수 통과 → 승인 카드에서 멈춘다 (발행 안 됨)
  reviewPass = true;
  assert.equal(await runtime.runShortGoal(short, publishTool), "pending");
  assert.deepEqual(published, [], "승인 전 발행 금지");
  const inbox = (await (await user("/api/inbox")).json()) as {
    pending: { id: string; title: string; inputHash: string }[];
  };
  assert.equal(inbox.pending.length, 1);
  assert.match(inbox.pending[0]?.title ?? "", /발행 승인/);
  assert.match(llmCalls.join(","), /monitor:2,drafter:3,geo:3,reviewer:4/);
  const stageNow = (
    (await (await user(`/api/goals?room_id=${roomId}`)).json()) as {
      level: string;
      stage?: string;
      progress: number;
    }[]
  ).find((g) => g.level === "short");
  assert.equal(stageNow?.stage, "approval");
  assert.equal(stageNow?.progress, 90);

  // 수정 요청 — 무엇을 고칠지 없으면 400, 있으면 팀이 같은 원고를 고쳐 새 승인을 올린다 (처음부터 다시 쓰지 않음)
  const first = inbox.pending[0] as { id: string; inputHash: string };
  const blank = await user(`/api/approvals/${first.id}/decide`, {
    decision: "revise",
    frozenHash: first.inputHash,
  });
  assert.equal(blank.status, 400);
  const revised = await user(`/api/approvals/${first.id}/decide`, {
    decision: "revise",
    reason: "더 짧게",
    frozenHash: first.inputHash,
  });
  assert.equal(((await revised.json()) as { status: string }).status, "revise");
  const callsBefore = llmCalls.length;
  assert.equal(await runtime.tick(publishTool), "pending");
  assert.deepEqual(
    llmCalls.slice(callsBefore),
    ["geo:3", "reviewer:4"],
    "감지부터 다시 하지 않는다 — 결과물을 내는 마지막 흐름 단계(geo)가 고친다",
  );
  assert.deepEqual(published, [], "수정 요청은 발행이 아니다");
  const again = (await (await user("/api/inbox")).json()) as {
    pending: { id: string; title: string; inputHash: string }[];
  };
  assert.equal(again.pending.length, 1);
  assert.equal(again.pending[0]?.title, `발행 승인: ${REVISED}`);
  assert.notEqual(again.pending[0]?.inputHash, first.inputHash, "고친 원고는 해시가 다르다");

  // 변호사 승인 → 다음 사이클에서 토큰 받아 1회 발행
  const approvalId = again.pending[0]?.id as string;
  const decided = await user(`/api/approvals/${approvalId}/decide`, {
    decision: "approve",
    frozenHash: again.pending[0]?.inputHash,
  });
  assert.equal(decided.status, 200);
  // tick: 승인 단계에 멈춘 목표의 승인 상태를 확인해 이어 간다 → 토큰을 받아 1회 발행
  assert.equal(await runtime.tick(publishTool), "published");
  assert.deepEqual(published, [REVISED]);
  const doneGoal = (
    (await (await user(`/api/goals?room_id=${roomId}`)).json()) as {
      level: string;
      stage?: string;
      status: string;
      progress: number;
    }[]
  ).find((g) => g.level === "short");
  assert.equal(doneGoal?.status, "completed");
  assert.equal(doneGoal?.progress, 100);
  // 토큰은 이미 쓰였다 — 다시 폴링해도 토큰이 없고, 같은 승인으로 재발행은 403
  const polled = (await (
    await app.request(`http://osiri.test/api/worker/approvals/${approvalId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { status: string; token?: string };
  assert.equal(polled.status, "consumed");
  assert.equal(polled.token, undefined);
  const reuse = await app.request("http://osiri.test/api/worker/tools/call", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      serverId: site.id,
      tool: "site_publish_post",
      args: {},
      approval: { id: approvalId, token: "not-the-token" },
    }),
  });
  assert.equal(reuse.status, 403);
  assert.equal(published.length, 1);
  // 이미 결재된 승인을 다시 결재하면 옛 상태를 200 으로 주지 않고 409
  const redecide = await user(`/api/approvals/${approvalId}/decide`, { decision: "reject" });
  assert.equal(redecide.status, 409);
  assert.match(((await redecide.json()) as { error: string }).error, /이미 처리된/);
  assert.equal(await runtime.tick(publishTool), "idle");

  // 주간 보고 — 3지표
  await runtime.weeklyReport();
  const timeline = (await (await user(`/api/rooms/${roomId}/timeline`)).json()) as {
    messages: { kind: string; payload?: { card?: string; metrics?: Record<string, unknown> } }[];
  };
  const report = timeline.messages.find((m) => m.kind === "report");
  assert.equal(report?.payload?.card, "weekly-report");
  // 승인 대기 수·성과 지표는 워커 값이 아니라 서버 현황판(board) 값이다
  assert.deepEqual(Object.keys(report?.payload?.metrics ?? {}).sort(), [
    "ai_citations",
    "completed_tasks",
    "indexed",
    "next_week_plan",
    "pending_approvals",
    "published",
  ]);
  assert.equal(report?.payload?.metrics?.pending_approvals, 0);
  assert.equal(report?.payload?.metrics?.published, 1);
  // 감사 로그: external 행위에 approval_id 가 붙어 있다
  const audit = (await (await user("/api/audit")).json()) as {
    action: string;
    approvalId?: string;
    result: string;
  }[];
  assert.ok(audit.some((a) => a.action === "approval.request" && a.approvalId === approvalId));
  assert.ok(
    audit.some((a) => a.action === "tool.external:site:site_publish_post" && a.result === "ok"),
  );
});

test("x-osiri-flow·x-osiri-principal — 선언한 역할을 순서대로, 앞 단계 출력을 넘기고, 마지막 출력이 승인 카드", async () => {
  const legal = await loadTeam("teams/legal-marketing.yaml");
  const plan = {
    title: "홀딩 3건 입금 확인 처리안",
    body: "A·B 입금 확인, C 미입금",
    sources: ["예약 #1"],
  };
  const team = {
    ...legal,
    package: {
      ...legal.package,
      "x-osiri-principal": "운영자",
      "x-osiri-flow": [{ role: "lookup" }, { role: "plan" }],
    },
    agents: {
      ...legal.agents,
      lookup: { title: "조회", description: "", instruction: "" },
      plan: { title: "처리안", description: "", instruction: "" },
    },
  };
  const prompts: string[] = [];
  const llm = async (role: string, tier: number, system: string, prompt: string) => {
    prompts.push(`${role}| ${prompt}`);
    if (role === "lookup") return "홀딩 3건, 입금 2건";
    if (role === "plan") return JSON.stringify(plan);
    return fakeLlm(role, tier, system, prompt);
  };
  const roomId = ((await (await user("/api/rooms")).json()) as { id: string }[])[0]?.id as string;
  const { token } = (await (await user(`/api/rooms/${roomId}/worker-token`, {})).json()) as {
    token: string;
  };
  const runtime = new TeamRuntime({
    apiUrl: "http://osiri.test/api/worker",
    workerToken: token,
    team,
    llm,
    fetchFn: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
    maxPolls: 1,
    log: () => undefined,
  });
  reviewPass = true;
  const goals = await runtime.decompose("이번 주 홀딩 정리");
  assert.match(prompts[0] ?? "", /^root\| 운영자의 목표: /, "주체 문구는 package 에서");
  const short = goals.find((g) => g.level === "short") as Parameters<
    TeamRuntime["runShortGoal"]
  >[0];
  assert.equal(await runtime.runShortGoal(short), "pending");
  assert.deepEqual(
    prompts.slice(1).map((p) => p.split("|")[0]),
    ["lookup", "plan", "reviewer"],
    "monitor·drafter·geo 를 부르지 않는다",
  );
  assert.match(prompts[2] ?? "", /앞 단계\(lookup\) 결과: 홀딩 3건, 입금 2건/);
  const inbox = (await (await user("/api/inbox")).json()) as { pending: { title: string }[] };
  assert.ok(inbox.pending.some((p) => p.title === `발행 승인: ${plan.title}`));
  const tasks = (
    (await (await user(`/api/goals?room_id=${roomId}`)).json()) as {
      level: string;
      parentId: string | null;
      assignee?: string;
    }[]
  ).filter((g) => g.level === "task" && g.parentId === short.id);
  assert.ok(
    tasks.length && tasks.every((t) => t.assignee === "plan"),
    "작업은 결과물을 내는 역할이 맡는다",
  );
});

test("역할 프롬프트: 도구 사용 지침·출력 템플릿 칸이 지시 뒤에 붙는다(없으면 빠진다)", () => {
  const base = { title: "처리안", description: "설명", instruction: "지시" };
  assert.equal(rolePrompt(base), "설명\n\n지시");
  const full = rolePrompt(
    { ...base, "x-osiri-tool-guide": "조회 먼저", "x-osiri-template": "| 날짜 | 시간 |" },
    "\n\n[장착된 스킬]\n- a: b",
  );
  assert.ok(full.indexOf("[도구 사용 지침]\n조회 먼저") > full.indexOf("지시"));
  assert.ok(full.indexOf("[출력 템플릿") > full.indexOf("[도구 사용 지침]"));
  assert.ok(full.endsWith("- a: b"));
});

test("감시(x-osiri-watch): read 도구를 주기마다 불러, 바뀌었을 때만 역할 템플릿으로 알린다", async () => {
  let rows = ["07:40 4명"];
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const messages: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = url.replace("http://w/api/worker", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const reply = (data: unknown) => new Response(JSON.stringify(data));
    if (path === "/tools")
      return reply([
        {
          id: "srv-1",
          name: "wgolf",
          tools: [
            { name: "search_teetimes", risk: "read" },
            { name: "book", risk: "external" },
          ],
        },
      ]);
    if (path === "/tools/call") return reply({ status: "done", result: { content: rows } });
    if (path === "/skills/active") return reply([]);
    if (path === "/messages") {
      messages.push(body.text);
      return reply({ ok: true });
    }
    throw new Error(`예상 밖 호출 ${path}`);
  }) as unknown as typeof fetch;
  const team = {
    version: 1,
    package: {
      slug: "t",
      name: "t",
      character: "c",
      approval_points: [],
      "x-osiri-watch": [
        {
          id: "tee",
          tool: "wgolf:search_teetimes",
          args: { date: "+1d" },
          every: "5m",
          role: "plan",
        },
        { id: "bad", tool: "book", every: "5m", role: "plan" },
      ],
    },
    agents: {
      plan: {
        title: "p",
        description: "d",
        instruction: "i",
        "x-osiri-template": "| 시간 | 인원 |",
      },
    },
  } as unknown as TeamSpec;
  const prompts: string[] = [];
  const runtime = new TeamRuntime({
    apiUrl: "http://w/api/worker",
    workerToken: "t",
    team,
    fetchFn,
    llm: async (_role, _tier, system, user) => {
      prompts.push(system);
      return `알림: ${user.includes("08:10") ? "08:10 추가" : "?"}`;
    },
  });
  const t0 = Date.parse("2026-10-11T03:00:00Z");
  assert.deepEqual(await runtime.watch(t0), [], "첫 회는 기준만 잡는다");
  const firstArgs = calls.find((c) => c.path === "/tools/call")?.body?.args as
    | { date?: string }
    | undefined;
  assert.equal(firstArgs?.date, "2026-10-12", "+1d → 서울 기준 내일");
  assert.ok(
    messages.some((m) => m.includes("read 도구만")),
    "external 도구는 감시하지 않고 실패를 알린다",
  );
  assert.deepEqual(await runtime.watch(t0 + 60_000), [], "주기가 안 됐으면 부르지 않는다");
  assert.deepEqual(await runtime.watch(t0 + 5 * 60_000), [], "같은 결과면 조용히");
  rows = ["07:40 4명", "08:10 2명"];
  assert.deepEqual(await runtime.watch(t0 + 10 * 60_000), ["tee"]);
  assert.ok(messages.includes("알림: 08:10 추가"));
  assert.ok(prompts.at(-1)?.includes("| 시간 | 인원 |"), "역할의 출력 템플릿이 프롬프트에 실린다");
  assert.equal(everyMs("1h"), 3_600_000);
  assert.throws(() => everyMs("5 minutes"));
});

test("역할 read 도구 루프(x-osiri-tools): CALL 한 줄이면 부르고 결과를 붙여 다시 묻는다, read 아닌 도구는 거부", async () => {
  const toolCalls: unknown[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = url.replace("http://w/api/worker", "");
    const reply = (data: unknown) => new Response(JSON.stringify(data));
    if (path === "/tools")
      return reply([
        {
          id: "srv-1",
          name: "wgolf",
          tools: [
            { name: "search_teetimes", risk: "read" },
            { name: "book", risk: "external" },
          ],
        },
      ]);
    if (path === "/tools/call") {
      toolCalls.push(JSON.parse(String(init?.body)));
      return reply({ status: "done", result: { content: ["07:40 4명"] } });
    }
    if (path === "/skills/active") return reply([]);
    throw new Error(`예상 밖 호출 ${path}`);
  }) as unknown as typeof fetch;
  const agent = (tools: string[]) => ({
    title: "p",
    description: "d",
    instruction: "i",
    "x-osiri-tools": tools,
  });
  const team = (tools: string[]) =>
    ({
      version: 1,
      package: { slug: "t", name: "t", character: "c", approval_points: [] },
      agents: { lookup: agent(tools) },
    }) as unknown as TeamSpec;
  const users: string[] = [];
  const llm = async (_r: string, _t: number, _s: string, user: string) => {
    users.push(user);
    if (!user.includes("결과]")) return 'CALL search_teetimes {"date":"2026-10-12"}';
    if (!user.includes("[book 결과]")) return "CALL book {}";
    return "내일 07:40 4명";
  };
  type Ask = { ask(role: string, user: string): Promise<string> };
  const runtime = new TeamRuntime({
    apiUrl: "http://w/api/worker",
    workerToken: "t",
    team: team(["search_teetimes"]),
    fetchFn,
    llm,
  }) as unknown as Ask;
  assert.equal(await runtime.ask("lookup", "내일 티타임"), "내일 07:40 4명");
  assert.deepEqual(toolCalls, [
    { serverId: "srv-1", tool: "search_teetimes", args: { date: "2026-10-12" }, actor: "lookup" },
  ]);
  assert.ok(users.at(-1)?.includes("[book 결과]\n이 역할이 쓸 수 없는 도구입니다"));
  const external = new TeamRuntime({
    apiUrl: "http://w/api/worker",
    workerToken: "t",
    team: team(["book"]),
    fetchFn,
    llm,
  }) as unknown as Ask;
  await assert.rejects(external.ask("lookup", "q"), /read 도구만/);
});
