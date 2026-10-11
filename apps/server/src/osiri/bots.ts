// 단체 톡 봇 (마스터 2026-10-11 «방장이 자신이 구독하는 에이전트팀의 도구를 봇으로 만들어서 작동 — 트리거: 크론, 특정 단어, 특정 명령어(/명령어). 봇은 에이전트팀에 포함되는거야»).
//  - 봇 = 방장의 구독 팀(팀 방) + 그 팀 YAML 의 도구(x-osiri-tools) 하나 + 트리거. 팀이 없으면 봇도 없다.
//  - 도구는 방장 이름으로 Mcp.call 을 거친다 — 위험도·승인·관리자 차단·구독자 조정이 팀 워커와 똑같이 걸린다(external 은 방장 결재함으로).
//  - 사람 말(Groups.say)에만 반응한다. 봇·안내 줄에는 반응하지 않으므로 봇끼리 핑퐁하지 않는다.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  GROUP_BOT_REPLY_MAX,
  GROUP_BOT_TRIGGERS,
  GROUP_NICKNAME_MAX,
  type GroupBotTrigger,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Group, GroupMessage, Groups } from "./groups.ts";
import type { ToolResult } from "./mcp.ts";

export interface GroupBot {
  id: string;
  groupId: string;
  /** 만든 방장 — 도구는 이 사람의 연결·권한으로 돈다 */
  ownerId: string;
  /** 봇이 속한 팀: 방장의 팀 방과 그 패키지 */
  roomId: string;
  packageId: string;
  teamName: string;
  name: string;
  /** 팀 YAML x-osiri-tools 의 항목("<서버>:<도구>" 또는 도구 이름) */
  tool: string;
  /** 도구 인자. 문자열 값의 {text} 는 트리거 뒤 글(명령어 뒤·단어가 든 말 전체)로 바뀐다 */
  args: Record<string, unknown>;
  trigger: { kind: GroupBotTrigger; value: string };
  /** 크론이 마지막으로 돈 분(YYYY-MM-DDTHH:mm, 서울) — 같은 분에 두 번 돌지 않게 */
  lastCron?: string;
  createdAt: string;
}
export interface TeamTools {
  roomId: string;
  packageId: string;
  team: string;
  tools: string[];
}
export interface BotDeps {
  /** 이 사람이 구독하는 팀(팀 방)과 각 팀 YAML 의 도구 */
  teamTools(owner: string): Promise<TeamTools[]>;
  /** 방장 이름으로 그 팀 방에서 도구를 부른다 (app.ts 가 Mcp.call 로 채운다) */
  runTool(bot: GroupBot, args: Record<string, unknown>): Promise<ToolResult>;
}

const BOTS = "group-bots";
const KST_MS = 9 * 3600_000;

/** 5칸 크론(분 시 일 월 요일) — `*`·`*\/n`·`a-b`·`a,b`·숫자. 서울 시각으로 맞춘다. 틀린 식은 throw. */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new Error("크론은 «분 시 일 월 요일» 다섯 칸입니다 (예: 0 9 * * 1)");
  const kst = new Date(date.getTime() + KST_MS);
  const now = [
    kst.getUTCMinutes(),
    kst.getUTCHours(),
    kst.getUTCDate(),
    kst.getUTCMonth() + 1,
    kst.getUTCDay(),
  ];
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return fields.every((field, i) => {
    const [lo, hi] = ranges[i] as [number, number];
    const value = now[i] as number;
    return field.split(",").some((part) => {
      const [range, stepText] = part.split("/");
      const step = stepText === undefined ? 1 : Number(stepText);
      const [from, to] =
        range === "*"
          ? [lo, hi]
          : range?.includes("-")
            ? range.split("-").map(Number)
            : [Number(range), stepText === undefined ? Number(range) : hi];
      if (
        ![from, to, step].every(Number.isInteger) ||
        step < 1 ||
        from < lo ||
        to > hi ||
        from > to
      )
        throw new Error(`크론 칸을 읽지 못했습니다: ${part}`);
      // 요일 7 = 일요일(0)
      const v = i === 4 && value === 0 && to === 7 ? [0, 7] : [value];
      return v.some((x) => x >= from && x <= to && (x - from) % step === 0);
    });
  });
}

/** 사람 말 → 봇이 받을 글. 안 맞으면 null */
export function triggerText(trigger: GroupBot["trigger"], text: string): string | null {
  const t = text.trim();
  if (trigger.kind === "command") {
    const command = `/${trigger.value.replace(/^\//, "")}`;
    if (t === command) return "";
    return t.startsWith(`${command} `) ? t.slice(command.length + 1).trim() : null;
  }
  if (trigger.kind === "keyword") return t.includes(trigger.value) ? t : null;
  return null;
}

const fill = (value: unknown, text: string): unknown =>
  typeof value === "string"
    ? value.replaceAll("{text}", text)
    : Array.isArray(value)
      ? value.map((v) => fill(v, text))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, text)]))
        : value;

const replyText = (content: unknown): string => {
  const text = Array.isArray(content)
    ? content
        .map((c: { type?: string; text?: string }) =>
          c.type === "text" ? c.text : JSON.stringify(c),
        )
        .join("\n")
    : JSON.stringify(content ?? "");
  return text.length > GROUP_BOT_REPLY_MAX ? `${text.slice(0, GROUP_BOT_REPLY_MAX)}…` : text;
};
const minuteKey = (date: Date) => new Date(date.getTime() + KST_MS).toISOString().slice(0, 16);

export class Bots {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly db: Store,
    private readonly groups: Groups,
    private readonly deps: BotDeps,
  ) {
    groups.onMessage((group, message) => this.heard(group, message));
  }

  async list(userId: string, groupId: string) {
    await this.groups.forMember(userId, groupId);
    return this.db.listByField<GroupBot>("system", BOTS, "groupId", groupId);
  }
  /** 방장이 볼 «봇으로 만들 수 있는 것»: 내 구독 팀과 그 도구 */
  async options(userId: string, groupId: string) {
    await this.owned(userId, groupId);
    return this.deps.teamTools(userId);
  }
  private async owned(userId: string, groupId: string) {
    const group = await this.groups.forMember(userId, groupId);
    if (group.ownerId !== userId) throw new AppError("방장만 봇을 만들고 뺄 수 있습니다", 403);
    if (group.kind === "operator")
      throw new AppError("운영자와의 대화에는 봇을 넣을 수 없습니다", 403);
    return group;
  }
  async create(
    userId: string,
    groupId: string,
    input: Pick<GroupBot, "name" | "tool" | "args" | "trigger" | "roomId">,
  ) {
    const group = await this.owned(userId, groupId);
    const team = (await this.deps.teamTools(userId)).find((t) => t.roomId === input.roomId);
    if (!team) throw new AppError("구독 중인 팀이 아닙니다", 404);
    if (!team.tools.includes(input.tool))
      throw new AppError(`${team.team} 팀에 없는 도구입니다: ${input.tool}`, 422);
    if (input.trigger.kind === "cron")
      try {
        cronMatches(input.trigger.value, new Date());
      } catch (error) {
        throw new AppError((error as Error).message, 422);
      }
    const bot: GroupBot = {
      ...input,
      trigger: {
        kind: input.trigger.kind,
        value:
          input.trigger.kind === "command"
            ? input.trigger.value.replace(/^\//, "")
            : input.trigger.value,
      },
      id: randomUUID(),
      groupId,
      ownerId: userId,
      packageId: team.packageId,
      teamName: team.team,
      createdAt: new Date().toISOString(),
    };
    await this.db.put("system", BOTS, bot);
    await this.groups.post(
      group,
      "system",
      "안내",
      `봇 ${bot.name}(${team.team}) 이 들어왔습니다 — ${describe(bot.trigger)}`,
    );
    return bot;
  }
  async remove(userId: string, groupId: string, botId: string) {
    const group = await this.owned(userId, groupId);
    const bot = await this.db.get<GroupBot>("system", BOTS, botId);
    if (!bot || bot.groupId !== groupId) throw new AppError("봇을 찾을 수 없습니다", 404);
    await this.db.remove("system", BOTS, botId);
    await this.groups.post(group, "system", "안내", `봇 ${bot.name} 이 나갔습니다`);
  }

  private async heard(group: Group, message: GroupMessage) {
    for (const bot of await this.db.listByField<GroupBot>("system", BOTS, "groupId", group.id)) {
      const text = triggerText(bot.trigger, message.text);
      if (text !== null) await this.fire(group, bot, text);
    }
  }
  /** 도구를 부르고 결과(또는 실패·결재 대기)를 방에 한 줄로. 실패도 방에 보인다 — 조용히 삼키지 않는다 */
  async fire(group: Group, bot: GroupBot, text: string) {
    let reply: string;
    try {
      const called = await this.deps.runTool(bot, fill(bot.args, text) as Record<string, unknown>);
      reply =
        called.status === "done"
          ? replyText((called.result as { content?: unknown } | undefined)?.content)
          : called.status === "pending_approval"
            ? "승인이 필요한 도구라 방장 결재함에 올렸습니다"
            : `실패: ${called.error}`;
    } catch (error) {
      reply = `실패: ${(error as Error).message}`;
    }
    await this.groups.post(group, `bot:${bot.id}`, bot.name, reply);
  }
  /** 이 분에 맞는 크론 봇을 돌린다. ponytail: 전체 스캔·순차 — 봇이 수백 개가 되면 다음 실행 시각 색인으로 */
  async tick(now = new Date()) {
    const minute = minuteKey(now);
    for (const { value: bot } of await this.db.scan<GroupBot>(BOTS)) {
      if (bot.trigger.kind !== "cron" || bot.lastCron === minute) continue;
      try {
        if (!cronMatches(bot.trigger.value, now)) continue;
        await this.db.put("system", BOTS, { ...bot, lastCron: minute });
        await this.fire(await this.groups.get(bot.groupId), bot, "");
      } catch (error) {
        console.error(`[osiri] 크론 봇 ${bot.id} 실패: ${(error as Error).message}`);
      }
    }
  }
  start(intervalMs = 60_000) {
    this.timer ??= setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    clearInterval(this.timer);
  }
}

const describe = (t: GroupBot["trigger"]) =>
  t.kind === "command"
    ? `/${t.value} 로 부릅니다`
    : t.kind === "keyword"
      ? `«${t.value}» 가 든 말에 답합니다`
      : `크론 ${t.value} (서울 시각)에 돕니다`;

export function botRoutes(bots: Bots) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/groups/:id/bots", async (c) =>
    c.json(await bots.list(c.get("owner"), c.req.param("id"))),
  );
  app.get("/groups/:id/bot-options", async (c) =>
    c.json(await bots.options(c.get("owner"), c.req.param("id"))),
  );
  app.post("/groups/:id/bots", async (c) => {
    const body = z
      .object({
        roomId: z.string().min(1),
        name: z.string().trim().min(1).max(GROUP_NICKNAME_MAX),
        tool: z.string().min(1).max(200),
        args: z.record(z.string(), z.unknown()).default({}),
        trigger: z.object({
          kind: z.enum(GROUP_BOT_TRIGGERS),
          value: z.string().trim().min(1).max(100),
        }),
      })
      .parse(await c.req.json());
    return c.json(await bots.create(c.get("owner"), c.req.param("id"), body), 201);
  });
  app.delete("/groups/:id/bots/:botId", async (c) => {
    await bots.remove(c.get("owner"), c.req.param("id"), c.req.param("botId"));
    return c.json({ ok: true });
  });
  return app;
}
