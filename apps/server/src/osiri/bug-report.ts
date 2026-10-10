// 사용자 오류 보고 → page-picker 관리자(마스터 2026-10-10 «https://page-picker.starian.us/admin 여기로 오류보고가 들어갈 수 있도록»).
// 앱이 모은 것(폰·로그·활동·화면)에 서버가 아는 것(사용자·서버 버전·최근 서버 오류)을 붙여 page-picker `POST /widget/reports` 로 넘긴다.
// 사이트 API 키는 서버 파일에만 둔다(PAGE_PICKER_KEY_FILE) — 앱 번들에 넣으면 누구나 꺼내 쓴다.
// 설정이 없으면 조용히 버리지 않는다 — 503 으로 실패해 사용자가 «보내지 못했다»를 본다.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Hono } from "hono";
import { z } from "zod";
import rootPkg from "../../../../package.json" with { type: "json" };
import { REPORT_KIND_LABELS, REPORT_KINDS } from "../../../../packages/domain/src/osiri.ts";
import { AppError } from "../errors.ts";
import type { Accounts } from "./accounts.ts";

type Env = { Variables: { owner: string } };

// 서버 쪽 최근 예기치 못한 오류 — 이름·경로·상태만(메시지에는 남의 데이터가 섞일 수 있다)
type ServerError = { at: string; status: number; name: string; path: string };
const recent: ServerError[] = [];
export function noteServerError(e: Omit<ServerError, "at">) {
  recent.push({ at: new Date().toISOString(), ...e });
  if (recent.length > 30) recent.shift(); // ponytail: 프로세스 메모리 30개, 재시작하면 비어도 된다
}

/** 010-****-1234 — 보고서는 다른 시스템에 남으므로 번호는 뒤 4자리만 */
export const maskPhone = (phone: string) => phone.replace(/^(\d{3})\d+(\d{4})$/, "$1-****-$2");

const Body = z.object({
  // 마스터 2026-10-10 «제안도 할 수 있게» — 같은 창구, 제목 머리로 갈린다
  kind: z.enum(REPORT_KINDS).default("bug"),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  // 앱이 모은 맥락(기기·로그·활동·화면) — 모양은 앱이 정한다, 크기만 막는다
  client: z.record(z.string(), z.unknown()),
});

export function bugReportRoutes(accounts: Accounts, base?: string, keyFile?: string) {
  const missing = [!base && "PAGE_PICKER_BASE", !keyFile && "PAGE_PICKER_KEY_FILE"]
    .filter(Boolean)
    .join("·");
  if (missing)
    console.warn(`[osiri] 오류 보고 미설정(${missing}) — 오류 보고가 503 으로 실패합니다`);
  const app = new Hono<Env>();
  app.post("/error-report", async (c) => {
    const body = Body.parse(await c.req.json());
    if (JSON.stringify(body.client).length > 200_000)
      throw new AppError("보고 내용이 너무 큽니다", 413);
    if (missing) throw new AppError(`오류 보고가 설정되지 않았습니다 (${missing})`, 503);
    const user = await accounts.userById(c.get("owner"));
    const profile = user ? await accounts.profile(user.id) : undefined;
    const who = user
      ? {
          id: user.id,
          name: profile?.displayName || "",
          phone: maskPhone(user.phone),
          role: user.role,
          tier: user.tier,
          joinedAt: user.createdAt,
        }
      : { id: c.get("owner") };
    const server = {
      version: rootPkg.version,
      at: new Date().toISOString(),
      userAgent: c.req.header("user-agent") ?? "",
      recentErrors: recent.slice(-15),
    };
    const snapshot = {
      app: "0Siri",
      kind: body.kind,
      narration: narrate(
        `${REPORT_KIND_LABELS[body.kind]} · ${body.title}`,
        body.description,
        who,
        body.client,
        server,
      ),
      user: who,
      server,
      ...body.client,
    };
    let key: string;
    try {
      key = readFileSync((keyFile as string).replace(/^~/, homedir()), "utf8").trim();
    } catch {
      console.error(`[osiri] 오류 보고 키 파일을 읽지 못했습니다: ${keyFile}`);
      throw new AppError("오류 보고 창구가 아직 준비되지 않았어요(키 없음)", 503);
    }
    const r = await fetch(`${base}/widget/reports`, {
      method: "POST",
      headers: { "X-PP-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `[0Siri ${REPORT_KIND_LABELS[body.kind]}] ${body.title}`,
        description: body.description || null,
        snapshot,
        reporterName: who.name || (user ? maskPhone(user.phone) : who.id),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await r.json().catch(() => ({}))) as { id?: number; error?: string };
    if (!r.ok || !json.id) {
      console.error(`[osiri] 오류 보고 전달 실패 ${r.status}: ${json.error ?? ""}`);
      throw new AppError("오류 보고를 보내지 못했어요. 잠시 뒤 다시 시도하세요", 502);
    }
    return c.json({ id: json.id });
  });
  return app;
}

// 관리자 화면 «narration» 칸에 그대로 보이는 사람용 요약
function narrate(
  title: string,
  description: string,
  who: { id: string; name?: string; phone?: string; role?: string },
  client: Record<string, unknown>,
  server: { version: string; recentErrors: ServerError[] },
) {
  const d = (client.device ?? {}) as Record<string, unknown>;
  const ctx = (client.context ?? {}) as Record<string, unknown>;
  const logs = Array.isArray(client.logs) ? client.logs : [];
  const acts = Array.isArray(client.activity) ? client.activity : [];
  const line = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
  return [
    `제목: ${title}`,
    description && `설명: ${description}`,
    `사용자: ${who.name || "(이름 없음)"} · ${who.phone ?? ""} · ${who.role ?? ""} · id ${who.id}`,
    `기기: ${[d.os, d.osVersion, d.brand, d.model].filter(Boolean).join(" ")} · 앱 v${d.appVersion ?? "?"} · 서버 v${server.version}`,
    `화면: ${line(ctx.screen ?? "?")}`,
    `최근 활동 ${acts.length}건 (마지막 10):`,
    ...acts.slice(-10).map((a) => `  ${line(a)}`),
    `로그 ${logs.length}건 (오류·경고 마지막 10):`,
    ...logs
      .filter((l) => /"level":"(error|warn)"/.test(line(l)))
      .slice(-10)
      .map((l) => `  ${line(l)}`),
    server.recentErrors.length > 0 && `서버 최근 오류 ${server.recentErrors.length}건`,
  ]
    .filter(Boolean)
    .join("\n");
}
