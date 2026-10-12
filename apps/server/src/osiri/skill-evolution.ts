// 개체군 기반 스킬 진화 (0SIRI-SPEC §17.5 — DGM 개방형 탐색 + Sakana MASS 짝 비교 판정, 마스터 2026-10-12).
// 한 세대: 아카이브에서 부모 선택 → 자식 후보 변이 → §17.3 금지 영역 차단 → 섀도우 replay(과거 요청에 다시 돌림)
//          → 지금 챔피언(장착본)과 짝 비교(순서 무작위) → 챔피언을 직접 이긴 자식만 초안으로 → 장착은 범위별 규칙(Skills.draft).
// MASS 코드는 라이선스가 없어 복사하지 않았다 — 아이디어만 여기서 새로 썼다.
import { Hono } from "hono";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Approval } from "./approvals.ts";
import type { RoomMessage, Rooms } from "./rooms.ts";
import type { Skill, Skills, StoredSkill } from "./skills.ts";
import type { Llm } from "./team-runtime.ts";

export type Verdict = { a: string; b: string; winner: "A" | "B" | "tie"; rationale: string };

/** 짝 비교 결과 → 개체별 강도(로그 스케일). MM 반복, 각 개체에 평균 상대와의 가상 승·패 `prior` 를 준다(한 번도 안 붙은 개체가 무한대로 가지 않게). 비김은 0.5승씩 */
export function bradleyTerry(ids: string[], verdicts: Verdict[], prior = 0.5, iters = 200) {
  const at = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const wins = ids.map(() => new Array<number>(n).fill(0));
  for (const v of verdicts) {
    const i = at.get(v.a);
    const j = at.get(v.b);
    if (i === undefined || j === undefined) continue;
    const row = (k: number) => wins[k] as number[];
    if (v.winner === "A") row(i)[j] = (row(i)[j] ?? 0) + 1;
    else if (v.winner === "B") row(j)[i] = (row(j)[i] ?? 0) + 1;
    else {
      row(i)[j] = (row(i)[j] ?? 0) + 0.5;
      row(j)[i] = (row(j)[i] ?? 0) + 0.5;
    }
  }
  let p = new Array<number>(n).fill(1);
  for (let it = 0; it < iters; it++) {
    const next = p.map((pi, i) => {
      const w = (wins[i] as number[]).reduce((s, x) => s + x, 0) + prior;
      let denom = prior / (pi + 1);
      for (let j = 0; j < n; j++) {
        const games = ((wins[i] as number[])[j] ?? 0) + ((wins[j] as number[])[i] ?? 0);
        if (j !== i && games) denom += games / (pi + (p[j] as number));
      }
      return denom > 0 ? w / denom : pi;
    });
    const mean = next.reduce((s, x) => s + x, 0) / n;
    p = next.map((x) => x / mean);
  }
  return Object.fromEntries(ids.map((id, i) => [id, Math.log(p[i] as number)]));
}

/** 부모 선택 가중치 — 점수가 높고 덜 탐색된(자식이 적은) 개체일수록 잘 뽑힌다. 점수 없는 개체는 0.5 */
export function pickParent<T extends { fitness?: number; children: number }>(
  archive: T[],
  rand = Math.random,
): T {
  if (!archive.length) throw new AppError("진화할 스킬 계보가 없습니다", 404);
  const weights = archive.map((s) => Math.max(0.05, s.fitness ?? 0.5) / (1 + s.children));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (const [i, w] of weights.entries()) {
    r -= w;
    if (r <= 0) return archive[i] as T;
  }
  return archive.at(-1) as T;
}

/** §17.3 — 검수·컴플라이언스 기준 완화, 승인 지점 제거, 근거 접지 해제를 담은 변이는 평가 전에 버린다.
 * ponytail: 낱말 규칙(대상어 + 완화어)이라 돌려 말하면 샌다 — 레드팀 세대 검사(M6)가 그 뒤를 받친다 */
export function loosensGuard(text: string) {
  const target =
    /(검수|컴플라이언스|규정|승인|결재|확인|근거|출처|인용|review|approv|complian|citation|source)/i;
  const loosen =
    /(생략|건너뛰|없이|빼고|제거|완화|무시|하지\s*않아도|안\s*해도|skip|omit|without|bypass|ignore|relax)/i;
  // «근거 없이 단정하지 않는다» «Do not skip citations» 는 조이는 문장이다 — 금지형이면 통과(실모델 출력에서 오탐)
  const forbids = /(않는다|않고|말고|말\s*것|하지\s*마|never|do not|don't|must not)/i;
  const permits = /(않아도|안\s*해도|생략해도|없어도)/;
  return text
    .split(/[.\n。!?]/)
    .some((s) => target.test(s) && loosen.test(s) && (!forbids.test(s) || permits.test(s)));
}

/** 승인율이 이만큼(비율) 떨어지면 하한 위반 — 자동 장착본을 롤백한다 */
export const PROXY_FLOOR = 0.15;
const PROXY_MIN_DECISIONS = 3;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** [from, to) 에 결정된 승인 요청의 승인율. 결정이 PROXY_MIN_DECISIONS 건 미만이면 모름(null) */
export function approvalRate(
  approvals: Pick<Approval, "status" | "decidedAt">[],
  from: string,
  to: string,
) {
  const inWindow = approvals.filter(
    (a) => a.decidedAt && a.decidedAt >= from && a.decidedAt < to && a.status !== "pending",
  );
  if (inWindow.length < PROXY_MIN_DECISIONS) return null;
  return inWindow.filter((a) => a.status === "approved").length / inWindow.length;
}

/** 판정 이유에서 고칠 거리(실패·누락·불일치…) 문장만 — 다음 변이의 입력 */
export function actionItems(rationale: string, max = 6) {
  const cue =
    /(실패|누락|빠졌|빠진|불일치|어긋|부족|약하|틀렸|틀린|오류|없다|않았|fail|missing|inconsistent|mismatch|lack|weak|error)/i;
  return [
    ...new Set(
      rationale
        .split(/(?<=[.!?。])\s+|\n/)
        .map((s) => s.trim())
        .filter((s) => s && cue.test(s)),
    ),
  ].slice(0, max);
}

function json<T>(text: string, what: string): T {
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body) as T;
  } catch {
    // 조용히 «비김» 으로 만들지 않는다 — 판정·변이가 깨졌으면 그 세대를 실패로 남긴다
    throw new Error(`${what} 응답이 JSON 이 아닙니다: ${text.slice(0, 160)}`);
  }
}

const JUDGE_SYSTEM = `너는 같은 요청에 대한 두 답(A, B)을 비교하는 엄격한 검토자다.
요청이 바란 것을 기준으로, 근거를 들어 어느 답이 더 나은지 고른다. 정말 비슷할 때만 tie.
사실을 지어낸 답, 확인 없이 단정한 답, 요청을 벗어난 답은 감점한다.
JSON 만 답한다: {"winner":"A"|"B"|"tie","rationale":"두 답에서 구체적 근거를 인용"}`;

/** 짝 비교 한 번. 자리 편향을 없애려고 순서를 무작위로 바꾸고, 결과를 원래 이름으로 되돌린다 */
export async function judgePair(
  llm: Llm,
  input: { request: string; a: { id: string; text: string }; b: { id: string; text: string } },
  rand = Math.random,
): Promise<Verdict> {
  const swapped = rand() < 0.5;
  const [left, right] = swapped ? [input.b, input.a] : [input.a, input.b];
  const raw = await llm(
    "skill-judge",
    3,
    JUDGE_SYSTEM,
    `# 요청\n${input.request}\n\n# 답 A\n${left.text}\n\n# 답 B\n${right.text}`,
  );
  const out = json<{ winner?: string; rationale?: string }>(raw, "판정");
  if (out.winner !== "A" && out.winner !== "B" && out.winner !== "tie")
    throw new Error(`판정 winner 가 A·B·tie 가 아닙니다: ${String(out.winner)}`);
  const winner = out.winner === "tie" ? "tie" : (out.winner === "A") !== swapped ? "A" : "B";
  return { a: input.a.id, b: input.b.id, winner, rationale: String(out.rationale ?? "") };
}

export type Mutation = {
  changes: string[];
  why: string[];
  evidence: string[];
  expectedImpact: string[];
  verify: string[];
};

const MUTATE_SYSTEM = `너는 개인 AI 비서의 «스킬»(그 사람에게 일하는 방식 지침)을 고치는 프롬프트 엔지니어다.
부모 스킬과 그 스킬이 진 이유·사용자 반려 사유를 보고, 더 나은 지침 후보를 낸다.
우선순위: ① 결과물에 무엇이 꼭 들어가고 무엇을 확인해야 하는지(계약)를 구체적으로 ② 답을 낸 뒤 스스로 계약과 대조해 고치는 순서.
🔴 지침은 «같은 답 안에서» 결과물을 내게 해야 한다 — 먼저 질문만 하고 멈추는 지침은 쓰지 마라. 모르는 사실은 지어내지 말고 결과물 안에 [확인 필요]로 남기고, 물을 것은 결과물 뒤에 짧게 붙인다.
절대 하지 말 것: 검수·규정 확인·승인 단계·출처 근거를 생략하거나 완화하는 지침(조이는 쪽만 허용). 횟수 상한을 박지 말고 통과 기준으로 끝내라.
JSON 만 답한다: {"candidates":[{"appliesTo":"새 지침 전문(한국어, 600자 이내)","changes":[],"why":[],"evidence":[],"expectedImpact":[],"verify":[]}]}`;

/** 부모에서 자식 후보 n 개 */
export async function mutate(
  llm: Llm,
  parent: Pick<Skill, "name" | "appliesTo" | "evidence">,
  feedback: string[],
  n: number,
) {
  const raw = await llm(
    "skill-mutator",
    3,
    MUTATE_SYSTEM,
    `# 스킬 «${parent.name}»\n## 지금 지침\n${parent.appliesTo}\n## 근거\n${parent.evidence}\n## 고칠 거리(판정·반려에서)\n${
      feedback.length
        ? feedback.map((f) => `- ${f}`).join("\n")
        : "- (아직 없음 — 계약을 더 구체적으로)"
    }\n\n후보 ${n}개를 서로 다른 방향으로 내라.`,
  );
  const out = json<{ candidates?: (Mutation & { appliesTo?: string })[] }>(raw, "변이");
  const list = (out.candidates ?? []).filter(
    (c) => typeof c.appliesTo === "string" && c.appliesTo.trim(),
  );
  if (!list.length) throw new Error("변이기가 후보를 하나도 내지 않았습니다");
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).slice(0, 8) : []);
  return list.slice(0, n).map((c) => ({
    appliesTo: (c.appliesTo as string).trim().slice(0, 1200),
    mutation: {
      changes: arr(c.changes),
      why: arr(c.why),
      evidence: arr(c.evidence),
      expectedImpact: arr(c.expectedImpact),
      verify: arr(c.verify),
    } satisfies Mutation,
  }));
}

const RUN_SYSTEM = (instruction: string) =>
  `너는 사용자의 개인 AI 비서 영시리다. 아래 스킬 지침을 따라 요청에 답한다. 모르는 사실은 지어내지 말고 [확인 필요]로 표시한다.\n# 스킬 지침\n${instruction}`;

export const EVOLVE_CHILDREN = 2;
export const EVOLVE_CASES = 3;
/** 사람마다 7일에 만들 수 있는 자식 수 — 넘으면 다음 주기로 미룬다(조용히 버리지 않고 사유를 돌려준다) */
export const EVOLVE_WEEKLY = 6;

export class SkillEvolution {
  constructor(
    private readonly db: Store,
    private readonly skills: Skills,
    /** ponytail: 지금은 공용키(gatewayLlm) — 주간 한도가 비용 상한. 구독 세션으로 돌리려면 owner 로 구독을 고른다 */
    private readonly llm: (owner: string) => Llm,
    private readonly rand = Math.random,
  ) {}

  /** 한 세대를 돌린다(개인 스킬). 결과는 감사·활동에 남고, 이긴 자식은 Skills.draft 로 들어가 자기 개선 설정대로 장착된다 */
  /** 시작 전 검사(남의 스킬·한도·평가셋) — 202 를 돌려주기 전에 실패하게 */
  async seed(owner: string, skillId: string) {
    const seed = await this.skills.getPersonal(owner, skillId);
    const since = Date.now() - 7 * 86_400_000;
    const recent = (await this.skills.listForUser(owner, { scope: "personal" })).filter(
      (s) => s.parentId && Date.parse(s.createdAt) >= since,
    ).length;
    if (recent >= EVOLVE_WEEKLY)
      throw new AppError(
        `이번 주 진화 한도(${EVOLVE_WEEKLY}개)를 다 썼습니다 — 다음 주에 다시 돌립니다`,
        429,
      );
    if ((await this.cases(owner, seed.roomId)).length < 2)
      throw new AppError("이 방의 요청이 2개 이상 쌓여야 새 버전을 시험할 수 있습니다", 409);
    return seed;
  }
  /** 섀도우 평가셋: 그 방의 최근 사용자 요청 */
  private async cases(owner: string, roomId: string | null) {
    return (await this.db.list<RoomMessage>(owner, "messages"))
      .filter((m) => m.roomId === roomId && m.role === "user" && (m.text ?? "").trim().length >= 6)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, EVOLVE_CASES)
      .map((m) => (m.text ?? "").trim());
  }

  async evolve(owner: string, skillId: string) {
    const seed = await this.seed(owner, skillId);
    const lineage = await this.skills.lineageOf(owner, seed);
    // M2 proxy: 버전마다 장착 기간의 승인율(반려 대비). 결정 3건 미만이면 모름(null)
    const approvals = (await this.db.list<Approval>(owner, "approvals")).filter(
      (a) =>
        a.roomId === seed.roomId &&
        a.decidedAt &&
        (a.status === "approved" || a.status === "rejected"),
    );
    const proxy = (s: StoredSkill) => {
      if (!s.decidedAt) return null;
      const end = lineage.find((n) => n.supersedes === s.id)?.decidedAt ?? "9999";
      return approvalRate(approvals, s.decidedAt, end);
    };
    const live = lineage.find((s) => s.status === "active" || s.status === "retire_proposed");
    // 하한(Goodhart 방지): 자기 개선이 장착한 지금 버전의 승인율이 이전 버전보다 확실히 떨어졌으면 진화보다 롤백이 먼저
    const prev = live?.supersedes ? lineage.find((s) => s.id === live.supersedes) : undefined;
    const [now, before] = [live && proxy(live), prev && proxy(prev)];
    if (
      live &&
      typeof now === "number" &&
      typeof before === "number" &&
      now < before - PROXY_FLOOR
    ) {
      const restored = await this.skills.reportEffect(owner, live.roomId as string, live.id, {
        effect: `승인율 ${pct(before)} → ${pct(now)} 로 떨어졌습니다`,
        worse: true,
      });
      return {
        rolledBack: restored.id === live.id ? null : restored,
        parent: null,
        champion: live.id,
        cases: 0,
        results: [],
        created: null,
      };
    }
    // 아카이브 = 반려된 것 빼고 전부(폐기된 것도 디딤돌로 남는다). 점수 = 섀도우 승률과 승인율의 평균(있는 것만)
    const archive = lineage
      .filter((s) => s.status !== "rejected" && s.status !== "draft")
      .map((s) => {
        const known = [s.fitness, proxy(s)].filter((x): x is number => typeof x === "number");
        return {
          ...s,
          fitness: known.length ? known.reduce((a, b) => a + b, 0) / known.length : undefined,
          children: lineage.filter((c) => c.parentId === s.id).length,
        };
      });
    const parent = pickParent(archive, this.rand);
    const champion = live ?? parent;
    const cases = await this.cases(owner, seed.roomId);
    const feedback = [
      ...lineage.flatMap((s) => s.evalNotes ?? []),
      ...(await this.skills.rejectReasons(owner, seed.roomId)),
    ].slice(0, 6);

    const llm = this.llm(owner);
    const children = await mutate(llm, parent, feedback, EVOLVE_CHILDREN);
    const run = (instruction: string, request: string) =>
      llm("skill-run", 2, RUN_SYSTEM(instruction), request);
    const championOut = await Promise.all(cases.map((c) => run(champion.appliesTo, c)));

    const verdicts: Verdict[] = [];
    const results: {
      id: string;
      appliesTo: string;
      mutation: Mutation;
      blocked: boolean;
      wins: number;
      losses: number;
      notes: string[];
    }[] = [];
    for (const [k, child] of children.entries()) {
      const id = `child-${k}`;
      if (loosensGuard(child.appliesTo)) {
        results.push({ id, ...child, blocked: true, wins: 0, losses: 0, notes: [] });
        continue;
      }
      let wins = 0;
      let losses = 0;
      const notes: string[] = [];
      for (const [i, request] of cases.entries()) {
        const text = await run(child.appliesTo, request);
        const v = await judgePair(
          llm,
          { request, a: { id, text }, b: { id: "champion", text: championOut[i] as string } },
          this.rand,
        );
        verdicts.push(v);
        if (v.winner === "A") wins++;
        else if (v.winner === "B") {
          losses++;
          notes.push(...actionItems(v.rationale, 2));
        }
      }
      results.push({ id, ...child, blocked: false, wins, losses, notes });
    }
    const strength = bradleyTerry(["champion", ...results.map((r) => r.id)], verdicts);
    // 챔피언을 «직접» 이긴 자식만(이긴 판이 진 판보다 많아야), 그중 BT 강도가 가장 높은 하나
    const winner = results
      .filter((r) => !r.blocked && r.wins > r.losses)
      .sort((x, y) => (strength[y.id] ?? 0) - (strength[x.id] ?? 0))[0];
    const evaluated = results.map((r) => ({
      blocked: r.blocked,
      wins: r.wins,
      losses: r.losses,
      ties: r.blocked ? 0 : cases.length - r.wins - r.losses,
      // 막힌 후보는 붙은 판이 없다 — prior 만으로 나온 강도를 점수처럼 보이지 않게
      strength: r.blocked ? null : (strength[r.id] ?? null),
    }));
    if (!winner)
      return {
        rolledBack: null,
        parent: parent.id,
        champion: champion.id,
        cases: cases.length,
        results: evaluated,
        created: null,
      };
    const created = await this.skills.draft(
      owner,
      { roomId: seed.roomId as string, packageId: seed.packageId },
      {
        scope: "personal",
        name: seed.name,
        evidence: `진화 ${cases.length}건 섀도우 비교에서 장착본에 ${winner.wins}승 ${winner.losses}패 — ${winner.mutation.changes.slice(0, 2).join(" · ") || "지침 개선"}`,
        appliesTo: winner.appliesTo,
        proposedBy: "진화",
        lineage: {
          parentId: parent.id,
          mutation: winner.mutation,
          fitness: winner.wins / cases.length,
          evalNotes: results.flatMap((r) => r.notes).slice(0, 6),
        },
      },
    );
    return {
      rolledBack: null,
      parent: parent.id,
      champion: champion.id,
      cases: cases.length,
      results: evaluated,
      created,
    };
  }
}

/** POST /api/skills/:id/evolve — 내 개인 스킬 한 세대 진화 (사용자 인증 뒤) */
export function evolutionRoutes(evolution: SkillEvolution, rooms: Rooms) {
  const app = new Hono<{ Variables: { owner: string } }>();
  // 한 세대는 2~4분 — 터널(100초)이 끊으므로 시작만 하고 202, 결과·실패는 그 방 활동에 남긴다(조용히 사라지지 않게)
  const running = new Set<string>();
  app.post("/skills/:id/evolve", async (c) => {
    const owner = c.get("owner");
    const seed = await evolution.seed(owner, c.req.param("id"));
    const key = `${owner}:${seed.name}:${seed.roomId}`;
    if (running.has(key)) throw new AppError("이 스킬은 이미 진화 중입니다", 409);
    running.add(key);
    const log = (title: string, detail: string) =>
      rooms.activity(owner, {
        roomId: seed.roomId ?? undefined,
        kind: "skill",
        actor: "진화",
        title,
        detail,
      });
    void evolution
      .evolve(owner, seed.id)
      .then(
        (out) => {
          // 하한 위반이면 진화 대신 롤백(또는 폐기 제안) — 그 기록은 Skills 가 이미 활동에 남겼다
          if (out.parent === null) return;
          const best = out.results.filter((r) => !r.blocked).sort((a, b) => b.wins - a.wins)[0];
          return out.created
            ? log(
                `스킬 진화: ${seed.name} v${out.created.version} 장착`,
                `${out.cases}건 비교에서 지금 버전을 ${best?.wins ?? 0}승 ${best?.losses ?? 0}패로 이겼습니다 — 마음에 안 들면 롤백하세요`,
              )
            : log(
                `스킬 진화: ${seed.name} 그대로`,
                `새 후보가 지금 버전을 이기지 못해 바꾸지 않았습니다 (가장 나은 후보 ${best?.wins ?? 0}승 ${best?.losses ?? 0}패)`,
              );
        },
        (error: Error) => log(`스킬 진화 실패: ${seed.name}`, error.message),
      )
      .catch((error: Error) => console.error(`[osiri] 진화 결과 기록 실패: ${error.message}`))
      .finally(() => running.delete(key));
    return c.json({ started: true }, 202);
  });
  return app;
}
