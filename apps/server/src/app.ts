import { readFile } from "node:fs/promises";
import "./config.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MessageSchema } from "@ag-ui/core";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  calendarRangeSchema,
  emailDraftSchema,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import { BROWSER_PROFILE_NAME_MAX } from "../../../packages/domain/src/osiri.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, makeRuntime } from "./agent.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { ComputerService, type DockerRunner } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import { browserConfigured, type Config } from "./config.ts";
import type { Store } from "./db.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import {
  accountDeletionRoutes,
  privateAccountRoutes,
  publicAccountRoutes,
} from "./osiri/account-routes.ts";
import { Accounts, requireNotSuspended } from "./osiri/accounts.ts";
import { adminViewRoutes } from "./osiri/admin-view.ts";
import { Approvals } from "./osiri/approvals.ts";
import { Bots, botRoutes } from "./osiri/bots.ts";
import { bugReportRoutes, noteServerError } from "./osiri/bug-report.ts";
import { EventBus } from "./osiri/events.ts";
import { Feed, feedRoutes } from "./osiri/feed.ts";
import { Groups, groupRoutes } from "./osiri/groups.ts";
import { History, historyRoutes } from "./osiri/history.ts";
import { Images, imageRoutes } from "./osiri/images.ts";
import { UsageLimits } from "./osiri/limits.ts";
import { locationRoutes } from "./osiri/location.ts";
import { Mcp, mcpRoutes } from "./osiri/mcp.ts";
import { escapeHtml, OAUTH_CALLBACK_PATH } from "./osiri/mcp-oauth.ts";
import { Memories, memoryRoutes } from "./osiri/memories.ts";
import { recoverTimes } from "./osiri/message-times.ts";
import { Operator, operatorRoutes } from "./osiri/operator.ts";
import {
  OsiriMcp,
  osiriMcpKeyRoutes,
  osiriMcpRoutes,
  roomForThread,
  waitForApproval,
} from "./osiri/osiri-mcp.ts";
import { otpGateway } from "./osiri/otp.ts";
import { Panes, paneFileRoutes, paneRoutes } from "./osiri/panes.ts";
import { roomPersona } from "./osiri/persona.ts";
import { Push, pushRoutes } from "./osiri/push.ts";
import { roomRoutes, type TeamLlmFor, teamRuntime, workerRoutes } from "./osiri/room-routes.ts";
import { Rooms } from "./osiri/rooms.ts";
import { Routing, routingRoutes, settingsRoutes } from "./osiri/routing.ts";
import { evolutionRoutes, SkillEvolution } from "./osiri/skill-evolution.ts";
import { Skills, skillRoutes, skillWorkerRoutes } from "./osiri/skills.ts";
import { Catalog, type Subscription, storeRoutes, subscriptionControls } from "./osiri/store.ts";
import { type PermissionAsk, Subscriptions, subscriptionRoutes } from "./osiri/subscription.ts";
import { gatewayLlm, loadTeam } from "./osiri/team-runtime.ts";
import { Tmux, tmuxReplyRoutes, tmuxRoutes } from "./osiri/tmux.ts";
import { rateLimit } from "./rate-limit.ts";
import { SearchService } from "./search.ts";
import { WorkspaceService } from "./workspace.ts";

export async function createApp(
  db: Store,
  config: Config,
  options: { docker?: DockerRunner } = {},
) {
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google);
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) => workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
  });
  const browser = new BrowserService(db, config, auth, files);
  const computer = new ComputerService(db, config, options.docker);
  const agent = new AgentService(db, config, workspace, files, actions, browser, computer);
  const intelligence = config.intelligenceApiKey
    ? new CopilotKitIntelligence({ apiKey: config.intelligenceApiKey })
    : undefined;
  // 0Siri 서비스 (0SIRI-SPEC §21). 전부 records 저장소 위, 기억만 pgvector.
  const accounts = new Accounts(db);
  const bus = new EventBus();
  const groups = new Groups(db, accounts);
  // 단체 톡 새 줄 → 쓴 사람 말고 멤버들의 폰으로 (FCM v1, 자격증명 없으면 꺼짐을 알리고 건너뜀)
  const push = new Push(db);
  groups.onPosted(async (group, message) => {
    await push.notify(
      group.members.filter((m) => m.userId !== message.authorId).map((m) => m.userId),
      {
        title: group.title,
        body: `${message.nickname}: ${message.text}`.slice(0, 200),
        data: { groupId: group.id },
      },
    );
  });
  const rooms = new Rooms(db, bus);
  const approvals = new Approvals(db, rooms, bus);
  const mcp = new Mcp(db, rooms, approvals);
  const memories = new Memories(db);
  // 대화 기록 검색(EmbeddingGemma 2) — 이 기능 이전 대화를 시작할 때 한 번 색인한다. 막지 않고, 결과·실패를 로그로 남긴다
  const history = new History(db);
  history
    .backfill()
    .then((n) => console.log(`[osiri/history] 이전 대화 ${n}줄 색인`))
    .catch((error) =>
      console.error(`[osiri/history] 이전 대화 색인 실패: ${(error as Error).message}`),
    );
  const catalog = new Catalog(db, rooms);
  const limits = new UsageLimits(
    db,
    rooms,
    (key) => catalog.setting(key),
    async (owner) => (await accounts.userById(owner))?.tier ?? "free",
    async (packageId) => (await catalog.packageById(packageId)).slug,
  );
  approvals.limits = limits;
  const routing = new Routing(db, rooms);
  const skills = new Skills(db, rooms);
  // ponytail: 진화는 공용키(gatewayLlm) — 주간 한도가 비용 상한. 구독 세션으로 돌리려면 owner 로 구독을 고른다
  const evolution = new SkillEvolution(db, skills, () => gatewayLlm());
  const operator = new Operator(db, rooms, catalog, accounts, skills);
  const feed = new Feed(db, new SearchService(db));
  // 단체 톡 봇 — 방장의 구독 팀 도구를 방장 이름으로 부른다. 워커와 같은 게이트(정지·팀 중지·일시정지·끈 도구는 Mcp.call)
  const bots = new Bots(db, groups, {
    teamTools: async (owner) =>
      Promise.all(
        (await db.list<Subscription>(owner, "subscriptions"))
          .filter((s) => s.status !== "ended")
          .map(async (s) => {
            const pkg = await catalog.packageById(s.packageId);
            const team = await loadTeam(pkg.runtime.teamYaml);
            const tools = Object.values(team.agents).flatMap((a) => a["x-osiri-tools"] ?? []);
            return {
              roomId: s.roomId,
              packageId: pkg.id,
              team: pkg.name,
              tools: [...new Set(tools)],
            };
          }),
      ),
    runTool: async (bot, args) => {
      await requireNotSuspended(db, bot.ownerId);
      const pkg = await catalog.packageById(bot.packageId);
      if (pkg.halted)
        throw new AppError(`관리자가 이 팀의 실행을 중지했습니다: ${pkg.halted.reason}`, 403);
      const controls = await subscriptionControls(db, bot.ownerId, bot.roomId);
      if (controls.paused) throw new AppError("구독자가 이 팀을 일시정지했습니다", 403);
      const [serverName, toolName] = bot.tool.includes(":")
        ? (bot.tool.split(":", 2) as [string, string])
        : [undefined, bot.tool];
      for (const server of await mcp.list(bot.ownerId)) {
        if (serverName && server.name !== serverName) continue;
        if ((await mcp.toolsFor(bot.ownerId, server.id)).some((t) => t.name === toolName))
          return mcp.call(bot.ownerId, {
            roomId: bot.roomId,
            serverId: server.id,
            tool: toolName,
            args,
            actor: `bot:${bot.name}`,
            controls,
          });
      }
      throw new AppError(
        `도구 ${bot.tool} 이(가) 방장의 연결에 없습니다 — 설정 › 연결에서 붙이세요`,
        404,
      );
    },
  });
  // 0Siri MCP — 구독 세션(그 사람 컨테이너·PC)에 밖에서 붙는 기억·도구. 승인은 앱 카드로
  const osiriMcp = new OsiriMcp(db, { memories, mcp, approvals, rooms, history });
  // 구독 세션·붙인 tmux 창이 함께 쓰는 승인 게이트와 0Siri MCP
  const agentGate = async (owner: string, ask: PermissionAsk) => {
    const approval = await approvals.request(owner, {
      roomId: await roomForThread(rooms, owner, ask.threadId),
      toolName: `agent:${ask.kind}`,
      input: ask.input,
      title: ask.title,
      summary: `${ask.actor} 이(가) 내 구독 작업 공간에서 하려는 일입니다 — 승인해야 진행됩니다`,
      evidence: JSON.stringify(ask.input, null, 2)?.slice(0, 4000),
      requestedBy: ask.actor,
    });
    return Boolean(await waitForApproval(approvals, owner, approval.id));
  };
  const agentMcp = async (owner: string, threadId: string) => [
    {
      type: "http" as const,
      name: "0siri",
      url: `${config.publicUrl.replace(/\/$/, "")}/api/mcp?thread=${encodeURIComponent(threadId)}`,
      headers: [{ name: "Authorization", value: `Bearer ${await osiriMcp.tokenFor(owner)}` }],
    },
  ];
  const subscriptions = new Subscriptions(db, {
    dir: `${config.dataDir}/subscriptions`,
    ...(config.subscriptionImage ? { image: config.subscriptionImage } : {}),
    gate: agentGate,
    mcpServers: agentMcp,
  });
  const paneFilesDir = `${config.dataDir}/pane-files`;
  const panes = new Panes(db, {
    runner: (owner) => subscriptions.runner(owner),
    gate: agentGate,
    mcpServers: agentMcp,
    filesDir: paneFilesDir,
    publicUrl: config.publicUrl,
  });
  // 팀 역할 모델: 구독을 켜 둔 사람은 그 구독 세션(역할마다 세션), 아니면 공용키
  const teamLlm: TeamLlmFor = async (owner, team) => {
    const sub = await subscriptions.activeFor(owner);
    return sub ? subscriptions.teamLlm(owner, sub, team) : gatewayLlm();
  };
  const publish = process.env.OSIRI_PUBLISH?.split(":");
  const publishTool =
    publish?.length === 2
      ? { serverId: publish[0] as string, tool: publish[1] as string }
      : undefined;
  const osiri = {
    db,
    rooms,
    approvals,
    bus,
    mcp,
    accounts,
    memories,
    catalog,
    routing,
    skills,
    feed,
    bots,
    subscriptions,
    osiriMcp,
    operator,
    evolution,
    teamLlm,
    /** 방 하나의 팀 루프 (Provisioner 가 부른다) */
    teamRuntime: (owner: string, roomId: string, packageId: string) =>
      teamRuntime(
        { db, rooms, approvals, bus, mcp, skills, catalog },
        owner,
        roomId,
        packageId,
        teamLlm,
        {
          ...(publishTool ? { publishTool } : {}),
          beforeRole: (role) => limits.beforeRole(owner, roomId, packageId, role),
        },
      ),
  };
  // 채팅·작업 엔진이 같은 기억 저장소와 라우팅을 쓴다 (remember_fact → Memories, 모델 선택 → Routing)
  const tmux = new Tmux(db, config.publicUrl);
  const images = new Images(db, config.dataDir);
  agent.osiri = { memories, routing, subscriptions, tmux, panes, history, images };
  await accounts.ensureAdmin(config.adminPhone, config.adminPassword);
  // 채팅 threadId = 방 id → 방·팀 페르소나를 프롬프트 앞에 붙인다.
  const runtime = makeRuntime(config, agent, auth, intelligence, roomPersona(rooms, catalog));
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "허용되지 않은 출처입니다." }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: "요청이 너무 큽니다. PDF는 10 MB 이하여야 합니다." }, 413),
    }),
  );
  app.use("/api/*", rateLimit(Boolean(config.trustProxy)));
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError)
      return c.json({ error: "요청 데이터가 올바르지 않습니다." }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    noteServerError({ status: 502, name: error.name, path: c.req.path });
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "요청에 실패했습니다. 서버 설정을 확인한 뒤 다시 시도하세요.",
      },
      502,
    );
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: browserConfigured(config),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  app.post("/api/session", async (c) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("로그인 시도가 너무 많습니다. 1분 뒤 다시 시도하세요.", 429);
    const body = z.object({ accessKey: z.string().optional() }).parse(await c.req.json());
    const session = await auth.session(body.accessKey);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google 연결이 취소되었습니다</h1><p>0Siri로 돌아가셔도 됩니다.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google 콜백 정보가 불완전합니다.");
    await google.callback(state, code);
    return c.html(
      "<h1>Google이 연결되었습니다</h1><p>0Siri로 돌아가 워크스페이스를 새로고침하세요.</p>",
    );
  });
  // 공개: MCP OAuth 로그인 콜백 — 누구의 연결인지는 state 가 안다(시작할 때 서버가 만든 일회용 값)
  app.get(OAUTH_CALLBACK_PATH, async (c) => {
    const page = (title: string, detail: string, status: 200 | 400 = 200) =>
      c.html(
        `<meta name="viewport" content="width=device-width"><h2>${title}</h2><p>${detail}</p>`,
        status,
      );
    const error = c.req.query("error");
    if (error) return page("로그인이 취소되었습니다", "0Siri 로 돌아가셔도 됩니다.", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code)
      return page("로그인 정보가 불완전합니다", "0Siri 에서 다시 시작해 주세요.", 400);
    try {
      const server = await mcp.finishOAuth(state, code, config.publicUrl);
      return page(
        `${escapeHtml(server.name)} 이(가) 연결되었습니다`,
        "이 창을 닫고 0Siri 로 돌아가세요.",
      );
    } catch (e) {
      console.error(`[osiri] MCP OAuth 콜백 실패: ${(e as Error).message}`);
      return page("연결하지 못했습니다", escapeHtml((e as Error).message), 400);
    }
  });
  // 공개: 전화번호 로그인·초대 수락 (S1). 워커: 워커 토큰으로 인증 — 사용자 인증 미들웨어 앞에 둔다.
  app.route(
    "/api/auth",
    publicAccountRoutes(accounts, otpGateway(config.otpBase, config.otpKeyFile)),
  );
  // 공개: 본인 PC 구독 러너 내려받기 (파일 하나, 비밀 없음 — 열쇠는 실행할 때 따로 넣는다)
  app.get("/osiri-runner.mjs", async (c) =>
    c.body(await readFile(new URL("../../runner/osiri-runner.mjs", import.meta.url), "utf8"), 200, {
      "content-type": "text/javascript; charset=utf-8",
      "content-disposition": 'attachment; filename="osiri-runner.mjs"',
    }),
  );
  // 공개: OS 별 러너 설치 스크립트(비밀 없음 — 서버·열쇠는 실행할 때 인자로). curl|bash · irm 으로 받는다
  for (const file of ["install-runner.sh", "install-runner.ps1"])
    app.get(`/${file}`, async (c) =>
      c.body(
        await readFile(
          new URL(`../../runner/${file.replace("install-runner", "install")}`, import.meta.url),
          "utf8",
        ),
        200,
        { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
      ),
    );
  // 0Siri MCP 는 자기 열쇠로 인증한다(사용자 로그인 토큰이 아니다) — 인증 미들웨어보다 앞에
  app.route("/api", osiriMcpRoutes(osiriMcp));
  // 붙인 tmux 의 회신도 턴 열쇠로 인증한다
  app.route("/api", tmuxReplyRoutes(tmux));
  // 붙인 창에서 받은 파일 — 주소가 열쇠
  app.route("/api", paneFileRoutes(paneFilesDir));
  app.route("/api/worker", workerRoutes(osiri));
  // 워커 토큰 인증은 바로 위 workerRoutes 의 미들웨어가 건다 — 순서를 바꾸지 않는다
  app.route("/api/worker", skillWorkerRoutes(skills));
  app.use("/api/*", async (c, next) => {
    const signedRoute =
      /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/.test(
        c.req.path,
      );
    const owner =
      signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    await next();
  });
  app.get("/api/workspace", async (c) => {
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q")),
      browser.reachable(),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.route("/api/computer", computerRoutes(computer, files));
  // 0Siri 사용자 라우트 (S2~S11)
  app.route(
    "/api",
    privateAccountRoutes(accounts, config.publicUrl, (owner, input) => rooms.audit(owner, input)),
  );
  app.route("/api", bugReportRoutes(accounts, config.pagePickerBase, config.pagePickerKeyFile));
  app.route("/api", roomRoutes(osiri));
  app.route("/api", memoryRoutes(memories));
  app.route("/api", historyRoutes(history));
  app.route("/api", locationRoutes(db));
  app.route("/api", imageRoutes(images));
  app.route("/api", mcpRoutes(mcp, config.publicUrl));
  app.route(
    "/api",
    groupRoutes(groups, config.publicUrl, async (owner, roomId) => {
      const room = await rooms.get(owner, roomId);
      if (!room.packageId) throw new AppError("팀 방에서만 운영자와 대화할 수 있습니다", 409);
      const pkg = await catalog.packageById(room.packageId);
      return { pkg: { id: pkg.id, name: pkg.name }, operators: await operator.operatorsOf(pkg.id) };
    }),
  );
  app.route("/api", botRoutes(bots));
  app.route("/api", pushRoutes(push));
  app.route("/api", subscriptionRoutes(subscriptions));
  app.route("/api", paneRoutes(panes));
  app.route(
    "/api",
    tmuxRoutes(tmux, (owner) => accounts.requireRole(owner, "admin")),
  );
  app.route("/api", osiriMcpKeyRoutes(osiriMcp, config.publicUrl));
  app.route(
    "/api",
    storeRoutes(
      catalog,
      accounts,
      (owner, input) => rooms.audit(owner, input),
      join(config.dataDir, "teams"),
      (owner, packageId) => operator.requirePackage(owner, packageId),
    ),
  );
  app.route("/api", routingRoutes(routing));
  app.route("/api", adminViewRoutes(accounts, rooms, routing, catalog));
  app.route("/api", settingsRoutes(routing, catalog));
  app.route(
    "/api",
    accountDeletionRoutes(accounts, (owner, input) => rooms.audit(owner, input)),
  );
  app.route("/api", skillRoutes(skills));
  app.route("/api", evolutionRoutes(evolution, rooms));
  app.route("/api", feedRoutes(feed, accounts));
  app.route("/api", operatorRoutes(operator));
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (query.timeMin && query.timeMax) calendarRangeSchema.parse(query);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema
      .extend({ id: z.string().uuid().optional() })
      .parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("초안을 찾을 수 없습니다.", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    if (!intelligence) throw new AppError("Rich Threads가 설정되지 않았습니다.", 404);
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("메인 대화를 불러올 수 없습니다.", 503);
    try {
      await intelligence.getOrCreateThread({
        threadId: main.threadId,
        userId: owner,
        agentId: "default",
      });
    } catch {
      throw new AppError(
        "메인 대화를 사용할 수 없습니다. Rich Threads 연결을 확인한 뒤 다시 시도하세요.",
        502,
      );
    }
    return c.json({ threadId: main.threadId, existing: true });
  });
  // 0Siri: 방마다 대화가 따로 있다 → `?threadId=<방 id>`. 없으면 openmuse 기본 대화.
  const conversationId = (c: { req: { query(name: string): string | undefined } }) =>
    c.req.query("threadId") || "default";
  // 시각이 없는 옛 메시지는 recoverTimes 가 id·색인 흔적에서 되찾고, 못 찾으면 approx(근사)로 따로 준다 — 저장은 하지 않는다
  app.get("/api/conversation", async (c) => {
    const owner = c.get("owner");
    const saved = await db.get<{ messages?: { id: string }[]; times?: Record<string, string> }>(
      owner,
      "conversations",
      conversationId(c),
    );
    if (!saved) return c.json({ messages: [] });
    const messages = saved.messages ?? [];
    if (messages.every((m) => saved.times?.[m.id])) return c.json(saved);
    const indexed = await history.indexedAt(owner, conversationId(c)).catch((error) => {
      console.error(
        `[osiri/times] 색인 시각 읽기 실패 — id 흔적만 씁니다: ${(error as Error).message}`,
      );
      return new Map<string, Date>();
    });
    return c.json({ ...saved, ...recoverTimes(messages, saved.times ?? {}, indexed) });
  });
  // times: 메시지 id → 처음 저장된 시각. 말풍선 아래 «언제 말했고 언제 답했는지» (마스터 2026-10-11).
  // 화면은 메시지를 처음 본 시각(times)을 같이 보낸다 — 저장은 답이 끝난 뒤라 서버 시각만 쓰면 내 말이 답 시각으로 찍힌다.
  // 새 id 에만 받아들이고, 미래 시각은 지금으로 깎는다. 분기도 이 길로 원래 시각을 옮긴다
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    const given = z
      .record(z.string(), z.iso.datetime())
      .catch({})
      .parse(body.times ?? {});
    const owner = c.get("owner");
    const previous = await db.get<{ messages?: { id: string }[]; times?: Record<string, string> }>(
      owner,
      "conversations",
      conversationId(c),
    );
    // 시각을 찍기 전부터 있던 메시지는 비워 둔다 — 지금 시각을 찍으면 틀린 시각이 보인다
    const before = new Set((previous?.messages ?? []).map((m) => m.id));
    const now = new Date().toISOString();
    const times: Record<string, string> = {};
    for (const message of messages as { id: string }[]) {
      const kept = previous?.times?.[message.id];
      const seeded = given[message.id];
      if (kept) times[message.id] = kept;
      else if (before.has(message.id)) continue;
      else times[message.id] = seeded && seeded < now ? seeded : now;
    }
    await db.put(owner, "conversations", { id: conversationId(c), messages, times });
    history.indexLater(owner, conversationId(c), messages);
    return c.json({ ok: true, times });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("PDF 파일을 선택하세요.");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url), 201);
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    const control = browser.holder(c.req.param("id"));
    // 0Siri 워커는 JPEG(폰으로 나가는 양을 줄인다) — 워커가 준 형식을 그대로 넘긴다
    c.header("Content-Type", response.headers.get("content-type") ?? "image/png");
    // 콘솔 화면이 2초마다 제어권도 같이 받는다 (머리글은 ASCII 만 — 사유는 인코딩)
    c.header("X-Browser-Holder", control.holder);
    c.header("X-Browser-Reason", encodeURIComponent(control.reason));
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    const body = await c.req.json();
    // 콘솔 화면의 «직접 조작 / 영시리에게 돌려주기» 도 같은 서명 주소로 온다
    if (body && typeof body === "object" && "control" in body) {
      const holder = z.enum(["agent", "user"]).parse(body.control);
      return c.json(await browser.setHolder(c.get("owner"), c.req.param("id"), holder));
    }
    await browser.input(c.get("owner"), c.req.param("id"), body);
    return c.json({ ok: true });
  });
  app.get("/api/browsers/:id/control", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    return c.json(browser.holder(c.req.param("id")));
  });
  app.post("/api/browsers/:id/control", async (c) => {
    const body = z.object({ holder: z.enum(["agent", "user"]) }).parse(await c.req.json());
    return c.json(await browser.setHolder(c.get("owner"), c.req.param("id"), body.holder));
  });
  // 브라우저 프로필 — 사람마다 여러 개, 하나를 «쓰는 중» 으로. 로그인은 프로필에 남는다
  app.get("/api/browser-profiles", async (c) => c.json(await browser.profiles(c.get("owner"))));
  app.post("/api/browser-profiles", async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(BROWSER_PROFILE_NAME_MAX) })
      .parse(await c.req.json());
    return c.json(await browser.createProfile(c.get("owner"), body.name), 201);
  });
  app.post("/api/browser-profiles/:id/use", async (c) =>
    c.json(await browser.useProfile(c.get("owner"), c.req.param("id"))),
  );
  app.all("/api/copilotkit/*", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "채팅을 시작하려면 모델과 제공자 API 키, 또는 유효한 AG-UI 엔드포인트를 설정하세요.",
        503,
      );
    const response = await runtime.fetch(c.req.raw);
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  // 0Siri 자동 업데이트: RELEASES_DIR 의 latest.json·APK 를 /releases/ 로 낸다 (build-android.sh 가 채운다)
  if (config.releasesDir)
    app.use(
      "/releases/*",
      serveStatic({
        root: config.releasesDir,
        rewriteRequestPath: (path) => path.replace(/^\/releases/, ""),
      }),
    );
  else
    console.log(
      "[osiri] RELEASES_DIR 미설정 — /releases/* 는 404 (앱 자동 업데이트 파일을 내지 않습니다)",
    );
  // 없는 릴리스 파일·미설정일 때 SPA index.html 이 대신 나가면 앱이 HTML 을 latest.json 으로 읽는다
  app.all("/releases/*", (c) => c.json({ error: "릴리스 파일을 찾을 수 없습니다" }, 404));
  // 0Siri: 웹 빌드(expo export --platform web)를 같은 포트에서 낸다. SPA 라 모르는 경로는 index.html.
  if (config.webDist) {
    app.use("/*", serveStatic({ root: config.webDist }));
    app.get("/*", serveStatic({ root: config.webDist, path: "index.html" }));
  } else {
    app.get("/", (c) =>
      c.json({ name: "OpenMuse", app: "http://localhost:8081", health: "/api/health" }),
    );
  }
  return { app, auth, files, actions, workspace, agent, computer, osiri };
}
