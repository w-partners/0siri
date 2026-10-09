// 0Siri 팀 런타임 (0SIRI-SPEC §7, §8, §15.3, §15.4, §22-8).
// 사용자별 워커 컨테이너 안에서 돈다. DB 직접 접근 금지 — 0Siri 워커 API 로만 말한다 (§15.4-6).
// 흐름: 목표 분해(팀장) → 감지 → 초안 → GEO → 검수 → [승인 대기] → 발행 → 주간 보고. 유일한 정지점은 발행 전 승인.
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
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

export async function loadTeam(path: string): Promise<TeamSpec> {
  const spec = parseYaml(await readFile(path, "utf8")) as TeamSpec;
  for (const key of ["root", "reviewer", "publisher", "analyst"])
    if (!spec.agents[key]) throw new Error(`팀 정의에 ${key} 역할이 없습니다: ${path}`);
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
  private presence(state: "working" | "done" | "idle", label?: string) {
    return this.api("/presence", { state, label }).catch(() => undefined);
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

  /** 팀장: 목표 분해 → 목표 트리 등록 (§8). */
  async decompose(goalText: string): Promise<Goal[]> {
    await this.presence("working", "목표 분해 중");
    const plan = json<{ long: string; mid: string[]; short: { title: string; tasks: string[] }[] }>(
      await this.ask("root", `변호사의 목표: ${goalText}`),
    );
    const long = await this.api<Goal>("/goals", { title: plan.long, level: "long" });
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
  async runShortGoal(
    goal: Goal,
    publishTool?: { serverId: string; tool: string },
  ): Promise<"published" | "pending" | "rejected" | "review_failed" | "no_channel"> {
    const progress = (p: number, stage: string, extra: Record<string, unknown> = {}) =>
      this.api(`/goals/${goal.id}/progress`, { progress: p, stage, actor: "root", ...extra });
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
    const approval = await this.api<{ id: string; status: string }>("/approvals/request", {
      toolName,
      input,
      title: `발행 승인: ${geo.title}`,
      summary: geo.body.slice(0, 300),
      evidence: `출처:\n${geo.sources.join("\n")}`,
      actor: "publisher",
    });
    await progress(90, "approval");
    await this.audit("publisher", "approval.request", "ok", {
      goal_id: goal.id,
      approval_id: approval.id,
      external: true,
    });
    await this.presence("idle", "승인 대기 중");
    const polls = this.options.maxPolls ?? 1;
    for (let i = 0; i < polls; i++) {
      const state = await this.api<{
        status: string;
        token?: string;
        tokenLost?: boolean;
        reason?: string;
      }>(`/approvals/${approval.id}`);
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
        const result = await this.api<{ status: string }>("/tools/call", {
          serverId: publishTool.serverId,
          tool: publishTool.tool,
          args: input,
          approval: { id: approval.id, token: state.token },
          actor: "publisher",
        });
        if (result.status !== "done") throw new Error(`발행 실패: ${JSON.stringify(result)}`);
        await progress(100, "done", { status: "completed", metrics: { published: 1 } });
        await this.audit("publisher", "publish", "ok", {
          goal_id: goal.id,
          approval_id: approval.id,
          external: true,
        });
        await this.say(`발행 완료: ${geo.title}`, "publisher");
        await this.presence("done", "발행 완료");
        return "published";
      }
      if (state.status === "approved" && state.tokenLost) {
        // 서버 재시작으로 토큰이 사라짐 — 새 승인을 받는다. 토큰 없이 발행하지 않는다.
        await this.audit("publisher", "publish", "blocked", {
          goal_id: goal.id,
          approval_id: approval.id,
          external: true,
        });
        return "pending";
      }
      if (i < polls - 1) await this.sleep(this.options.pollIntervalMs ?? 30_000);
    }
    return "pending";
  }

  /** 주간 보고 (§15.4-3): 완료 작업 수·대기 승인 수·다음 주 계획 필수. */
  async weeklyReport(pendingApprovals: number) {
    const goals = await this.api<Goal[]>("/goals");
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
        pending_approvals: pendingApprovals,
        next_week_plan: report.next_week_plan.length ? report.next_week_plan : open.slice(0, 3),
      },
      actor: "analyst",
    });
    return { completed, pendingApprovals };
  }

  /** 한 사이클: 분해 안 된 목표가 있으면 분해, 열린 단기 목표를 하나 진행. */
  async tick(publishTool?: { serverId: string; tool: string }) {
    const goals = await this.api<Goal[]>("/goals");
    const next = goals.find(
      (g) => g.level === "short" && g.status === "active" && (g.stage ?? "detect") !== "approval",
    );
    if (!next) return "idle" as const;
    return this.runShortGoal(next, publishTool);
  }
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
    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message.content ?? "";
  };
}
