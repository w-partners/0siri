// 0Siri 팀 런타임 (0SIRI-SPEC §7, §8, §15.3, §15.4, §22-8).
// 사용자별 워커 컨테이너 안에서 돈다. DB 직접 접근 금지 — 0Siri 워커 API 로만 말한다 (§15.4-6).
// 흐름: 목표 분해(팀장) → 감지 → 초안 → GEO → 검수 → [승인 대기] → 발행 → 주간 보고. 유일한 정지점은 발행 전 승인.
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  missingTeamRoles,
  type WorkerPresenceState,
} from "../../../../packages/domain/src/osiri.ts";
import { tierModels } from "./routing.ts";

export interface TeamAgent {
  title: string;
  description: string;
  instruction: string;
  "x-osiri-tier"?: 2 | 3 | 4;
  sub_agents?: string[];
}
export interface TeamSpec {
  version: number;
  package: { slug: string; name: string; character: string; approval_points: string[] };
  agents: Record<string, TeamAgent>;
}
export type Llm = (role: string, tier: 2 | 3 | 4, system: string, user: string) => Promise<string>;
export interface RuntimeOptions {
  apiUrl: string; // http://server/api/worker
  workerToken: string;
  team: TeamSpec;
  llm: Llm;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  log?: (line: string) => void;
}
type Goal = {
  id: string;
  title: string;
  level: string;
  parentId: string | null;
  status: string;
  stage?: string;
  progress: number;
};
type Draft = { title: string; body: string; sources: string[] };
/** 승인 요청 본문 — 처음 요청할 때와 (토큰 유실 뒤) 다시 요청할 때 같은 값을 쓴다. */
type ApprovalRequest = {
  toolName: string;
  input: unknown;
  title: string;
  summary: string;
  evidence?: string;
  actor: string;
  goal_id: string;
};
type ApprovalRef = Omit<ApprovalRequest, "actor" | "goal_id"> & { id: string; status: string };
export type ShortGoalOutcome =
  | "published"
  | "pending"
  | "rejected"
  | "review_failed"
  | "no_channel"
  | "publish_failed"
  | "requeued";
type PublishTool = { serverId: string; tool: string };

export async function loadTeam(path: string): Promise<TeamSpec> {
  const spec = parseYaml(await readFile(path, "utf8")) as TeamSpec;
  // 패키지 등록(Catalog.upsertPackage)과 같은 필수 역할 목록
  const missing = missingTeamRoles(Object.keys(spec.agents ?? {}));
  if (missing.length) throw new Error(`팀 정의에 ${missing.join(", ")} 역할이 없습니다: ${path}`);
  if (!spec.package?.approval_points?.length) throw new Error("승인 지점이 선언되지 않았습니다");
  return spec;
}
const json = <T>(text: string): T => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`모델 출력이 JSON 이 아닙니다: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
};

export class TeamRuntime {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  constructor(private readonly options: RuntimeOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = options.log ?? ((line) => console.log(`[team] ${line}`));
  }

  // ---- 워커 API ----
  private async api<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const response = await this.fetchFn(`${this.options.apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.workerToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${data.error ?? ""}`);
    return data;
  }
  private audit(
    actor: string,
    action: string,
    result: "ok" | "error" | "blocked",
    extra: Record<string, unknown> = {},
  ) {
    return this.api("/audit", { actor, action, result, ...extra }).catch((error) =>
      this.log(`감사 로그 전송 실패: ${error}`),
    );
  }
  private presence(state: WorkerPresenceState, label?: string) {
    // 캐릭터 상태는 작업을 막지 않지만, 실패는 남긴다
    return this.api("/presence", { state, label }).catch((error) =>
      this.log(`상태 전송 실패(${state}): ${error}`),
    );
  }
  private say(text: string, actor: string) {
    return this.api("/messages", { kind: "text", text, actor });
  }
  private async ask(role: string, user: string): Promise<string> {
    const agent = this.options.team.agents[role];
    if (!agent) throw new Error(`역할 없음: ${role}`);
    const tier = agent["x-osiri-tier"] ?? 3;
    return this.options.llm(role, tier, `${agent.description}\n\n${agent.instruction}`, user);
  }

  /**
   * 팀장: 목표 분해 → 목표 트리 등록 (§8).
   * `existingLong` 을 주면(사용자가 만들어 시작을 누른 장기 목표) 장기 목표를 새로 만들지 않고 그 아래에 붙인다.
   */
  async decompose(goalText: string, existingLong?: Pick<Goal, "id">): Promise<Goal[]> {
    await this.presence("working", "목표 분해 중");
    const plan = json<{ long: string; mid: string[]; short: { title: string; tasks: string[] }[] }>(
      await this.ask("root", `변호사의 목표: ${goalText}`),
    );
    if (!Array.isArray(plan.mid) || !Array.isArray(plan.short) || plan.short.length === 0)
      throw new Error("팀장이 낸 분해 결과에 단기 목표가 없습니다 — 실행할 작업이 생기지 않습니다");
    const long = existingLong
      ? (await this.api<Goal[]>("/goals")).find((g) => g.id === existingLong.id)
      : await this.api<Goal>("/goals", { title: plan.long, level: "long" });
    if (!long)
      throw new Error(`분해할 장기 목표 ${existingLong?.id} 을(를) 이 방에서 찾을 수 없습니다`);
    const mids = await Promise.all(
      plan.mid.map((title) => this.api<Goal>("/goals", { title, level: "mid", parentId: long.id })),
    );
    const parentMid = mids[0]?.id ?? long.id;
    const shorts: Goal[] = [];
    for (const s of plan.short) {
      const short = await this.api<Goal>("/goals", {
        title: s.title,
        level: "short",
        parentId: parentMid,
        stage: "detect",
      });
      shorts.push(short);
      for (const t of s.tasks)
        await this.api("/goals", {
          title: t,
          level: "task",
          parentId: short.id,
          assignee: "drafter",
        });
    }
    await this.audit("root", "goal.decompose", "ok", { goal_id: long.id });
    await this.say(
      `목표를 ${mids.length}개 중기·${shorts.length}개 단기 목표로 나눴습니다. 첫 작업부터 시작합니다.`,
      "root",
    );
    return [long, ...mids, ...shorts];
  }

  /** 단기 목표 1건: 감지 → 초안 → GEO → 검수 → 승인 요청. 발행은 승인 토큰이 있을 때만. */
  async runShortGoal(goal: Goal, publishTool?: PublishTool): Promise<ShortGoalOutcome> {
    const progress = this.progressOf(goal);
    await this.presence("working", `${goal.title} 작업 중`);
    const signal = await this.ask("monitor", `단기 목표: ${goal.title}`);
    await progress(20, "detect");
    const draft = json<Draft>(
      await this.ask("drafter", `단기 목표: ${goal.title}\n감지 결과: ${signal}`),
    );
    await progress(40, "draft");
    const geo = json<Draft>(await this.ask("geo", JSON.stringify(draft)));
    await progress(60, "geo");
    const review = json<{ pass: boolean; reasons: string[] }>(
      await this.ask("reviewer", JSON.stringify(geo)),
    );
    if (!review.pass) {
      await progress(40, "draft", { status: "active" });
      await this.audit("reviewer", "review.reject", "error", { goal_id: goal.id });
      await this.say(
        `검수 반려: ${review.reasons.join(", ")} — 초안 단계로 되돌립니다.`,
        "reviewer",
      );
      return "review_failed";
    }
    await progress(80, "review");
    const input = { title: geo.title, body: geo.body, sources: geo.sources };
    // 승인 토큰은 "<MCP 서버 이름>:<도구>" + 입력 해시에 묶인다 (Mcp.call 과 같은 이름 규칙) — 서버 이름을 /tools 로 푼다
    let toolName = "publish";
    if (publishTool) {
      const servers = await this.api<{ id: string; name: string }[]>("/tools");
      const server = servers.find((s) => s.id === publishTool.serverId);
      if (!server)
        throw new Error(`발행 채널 ${publishTool.serverId} 이(가) 연결되어 있지 않습니다`);
      toolName = `${server.name}:${publishTool.tool}`;
    }
    // 승인 요청 — 여기서 멈춘다. 플랫폼이 카드를 띄우고 변호사만 결재한다.
    const request: ApprovalRequest = {
      toolName,
      input,
      title: `발행 승인: ${geo.title}`,
      summary: geo.body.slice(0, 300),
      evidence: `출처:\n${geo.sources.join("\n")}`,
      actor: "publisher",
      goal_id: goal.id,
    };
    const approvalId = await this.requestApproval(goal, request);
    return this.awaitApproval(goal, approvalId, request, publishTool);
  }

  private progressOf(goal: Goal) {
    return (p: number, stage: string, extra: Record<string, unknown> = {}) =>
      this.api(`/goals/${goal.id}/progress`, { progress: p, stage, actor: "root", ...extra });
  }
  private async requestApproval(goal: Goal, request: ApprovalRequest): Promise<string> {
    const approval = await this.api<{ id: string; status: string }>("/approvals/request", request);
    await this.progressOf(goal)(90, "approval");
    await this.audit("publisher", "approval.request", "ok", {
      goal_id: goal.id,
      approval_id: approval.id,
      external: true,
    });
    await this.presence("idle", "승인 대기 중");
    return approval.id;
  }

  /** 승인 결과를 기다렸다가 발행한다. 폴링이 끝나도 결정이 없으면 "pending" — 다음 tick 이 `resumeApproval` 로 이어 간다. */
  private async awaitApproval(
    goal: Goal,
    approvalId: string,
    request: ApprovalRequest,
    publishTool?: PublishTool,
  ): Promise<ShortGoalOutcome> {
    const progress = this.progressOf(goal);
    const approval = { id: approvalId };
    const input = request.input;
    const subject = (input as { title?: unknown } | null)?.title ?? request.title;
    const polls = this.options.maxPolls ?? 1;
    for (let i = 0; i < polls; i++) {
      const state = await this.api<{
        status: string;
        token?: string;
        tokenLost?: boolean;
        reason?: string;
      }>(`/approvals/${approval.id}`);
      if (state.status === "expired") {
        await progress(60, "geo");
        await this.say(
          "승인 요청이 기한 안에 결재되지 않아 만료되었습니다. 다시 준비합니다.",
          "publisher",
        );
        return "requeued";
      }
      if (state.status === "consumed")
        return this.publishFailed(
          goal,
          approval.id,
          "승인 토큰이 이미 쓰였는데 발행 결과가 확인되지 않습니다",
        );
      if (state.status === "rejected") {
        await progress(60, "geo");
        await this.say(
          `반려되었습니다${state.reason ? `: ${state.reason}` : ""}. 반영해 다시 다듬겠습니다.`,
          "publisher",
        );
        return "rejected";
      }
      if (state.status === "approved" && state.token) {
        if (!publishTool) {
          await this.say(
            "승인되었지만 발행 채널(MCP)이 연결되어 있지 않습니다. 연결 화면에서 발행 도구를 붙여 주세요.",
            "publisher",
          );
          await this.audit("publisher", "publish", "blocked", {
            goal_id: goal.id,
            approval_id: approval.id,
            external: true,
          });
          return "no_channel";
        }
        await this.presence("working", "발행 중");
        const result = await this.api<{ status: string; error?: string }>("/tools/call", {
          serverId: publishTool.serverId,
          tool: publishTool.tool,
          args: input,
          approval: { id: approval.id, token: state.token },
          actor: "publisher",
        });
        // 도구가 오류를 돌려주면(status "failed") 발행된 것이 아니다 — 완료 처리하지 않는다
        if (result.status !== "done")
          return this.publishFailed(goal, approval.id, result.error ?? `status=${result.status}`);
        await progress(100, "done", { status: "completed", metrics: { published: 1 } });
        await this.audit("publisher", "publish", "ok", {
          goal_id: goal.id,
          approval_id: approval.id,
          external: true,
        });
        await this.say(`발행 완료: ${subject}`, "publisher");
        await this.presence("done", "발행 완료");
        return "published";
      }
      if (state.status === "approved") {
        // 토큰이 없다: 서버 재시작으로 사라졌거나(tokenLost) 이미 한 번 넘겨받고 워커가 죽었다 — 같은 내용으로 새 승인을 받는다. 토큰 없이 발행하지 않는다.
        await this.audit("publisher", "publish", "blocked", {
          goal_id: goal.id,
          approval_id: approval.id,
          external: true,
        });
        await this.requestApproval(goal, request);
        await this.say(
          "서버가 다시 시작되어 승인 토큰이 사라졌습니다. 같은 내용으로 승인을 다시 요청드립니다.",
          "publisher",
        );
        return "pending";
      }
      if (i < polls - 1) await this.sleep(this.options.pollIntervalMs ?? 30_000);
    }
    return "pending";
  }

  /** 발행이 실패했거나 결과를 알 수 없다: 완료로 올리지 않고 목표를 막아(blocked) 사람에게 알린다. 자동 재발행은 하지 않는다 (§24-11 비멱등 재시도 금지). */
  private async publishFailed(
    goal: Goal,
    approvalId: string,
    reason: string,
  ): Promise<ShortGoalOutcome> {
    await this.progressOf(goal)(90, "approval", { status: "blocked" });
    await this.audit("publisher", "publish", "error", {
      goal_id: goal.id,
      approval_id: approvalId,
      external: true,
    });
    await this.say(
      `발행에 실패했습니다: ${reason}. 확인이 필요해 이 목표를 멈춰 둡니다.`,
      "publisher",
    );
    this.log(`발행 실패 goal=${goal.id}: ${reason}`);
    return "publish_failed";
  }

  /** 승인 단계에 멈춘 목표를 이어 간다 — 폴링 시간 초과·토큰 유실·워커 재시작 뒤에도 승인 결과를 놓치지 않는다. */
  private async resumeApproval(goal: Goal, publishTool?: PublishTool): Promise<ShortGoalOutcome> {
    const linked = await this.api<ApprovalRef[]>(
      `/approvals?goal_id=${encodeURIComponent(goal.id)}`,
    );
    const latest = linked.at(-1);
    if (!latest) {
      // 연결된 승인이 없다(이 기능 이전에 만든 목표) — 상태를 확인할 길이 없으니 검수 뒤 단계부터 다시 간다
      this.log(`승인 단계 목표 ${goal.id} 에 연결된 승인이 없어 다시 준비합니다`);
      await this.progressOf(goal)(60, "geo");
      return "requeued";
    }
    const { id, status: _status, ...rest } = latest;
    return this.awaitApproval(
      goal,
      id,
      { ...rest, actor: "publisher", goal_id: goal.id },
      publishTool,
    );
  }

  /** 주간 보고 (§15.4-3): 완료 작업 수·대기 승인 수·다음 주 계획 필수. 승인 대기 수는 서버 현황판(board) 값만 쓴다. */
  async weeklyReport() {
    const goals = await this.api<Goal[]>("/goals");
    const { pendingApprovals } = await this.api<{ pendingApprovals: number }>("/board");
    const completed = goals.filter((g) => g.level === "short" && g.status === "completed").length;
    const open = goals
      .filter((g) => g.level === "short" && g.status !== "completed")
      .map((g) => g.title);
    const report = json<{ summary: string; next_week_plan: string[] }>(
      await this.ask("analyst", JSON.stringify({ completed, pendingApprovals, open }, null, 0)),
    );
    await this.api("/reports/weekly", {
      summary: report.summary,
      metrics: {
        completed_tasks: completed,
        next_week_plan: report.next_week_plan.length ? report.next_week_plan : open.slice(0, 3),
      },
      actor: "analyst",
    });
    return { completed, pendingApprovals };
  }

  /** 한 사이클: 승인 단계에 멈춘 목표의 승인 상태를 먼저 확인해 이어 가고, 없으면 열린 단기 목표를 하나 진행. */
  async tick(publishTool?: PublishTool): Promise<ShortGoalOutcome | "idle"> {
    const goals = await this.api<Goal[]>("/goals");
    const open = goals.filter((g) => g.level === "short" && g.status === "active");
    let waiting = false;
    for (const goal of open.filter((g) => g.stage === "approval")) {
      const outcome = await this.resumeApproval(goal, publishTool);
      if (outcome !== "pending") return outcome;
      waiting = true;
    }
    const next = open.find((g) => (g.stage ?? "detect") !== "approval");
    if (!next) return waiting ? "pending" : "idle";
    return this.runShortGoal(next, publishTool);
  }
}

/** tick 간격(ms). TEAM_INTERVAL_MS 가 숫자가 아니면 NaN 으로 쉬지 않고 도는 대신 기동을 막는다. */
export function tickInterval(raw = process.env.TEAM_INTERVAL_MS): number {
  if (raw === undefined || raw === "") return 600_000;
  const interval = Number(raw);
  if (!Number.isFinite(interval) || interval <= 0)
    throw new Error(`TEAM_INTERVAL_MS 는 0 보다 큰 숫자(ms)여야 합니다: "${raw}"`);
  return interval;
}

/** OpenAI 호환 게이트웨이 호출 (new-api 등). 모델은 티어별 환경변수. */
export function gatewayLlm(env = process.env): Llm {
  const base = env.OPENAI_BASE_URL;
  const key = env.OPENAI_API_KEY;
  if (!base || !key)
    throw new Error("OPENAI_BASE_URL / OPENAI_API_KEY 가 없어 팀 런타임을 시작할 수 없습니다");
  const models = tierModels(env);
  return async (_role, tier, system, user) => {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": "0siri-team-runtime",
      },
      body: JSON.stringify({
        model: models[tier],
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    // 빈 답을 "" 로 넘기면 뒤에서 "JSON 이 아닙니다" 로만 보인다 — 여기서 원인을 밝힌다
    if (!content?.trim())
      throw new Error(`gateway 가 빈 응답을 돌려주었습니다 (model=${models[tier]})`);
    return content;
  };
}
