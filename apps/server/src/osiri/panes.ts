// 내 PC 의 tmux 창을 영시리 대화방에 붙인다 — ACP (마스터 2026-10-11 «ACP처럼 작동하게…파일 전송도 되어야 하고»).
// 그 창에서 도는 CLI(Claude Code·Codex·Gemini·Grok·Qwen Code)의 ACP 모드를 PC 러너가 같은 폴더에서 띄우고,
// 그 창이 쓰던 세션을 session/load 로 잇는다. 세션 파일이 같으므로 맥락이 같다(창의 TUI 와 기록을 공유, 프로세스는 따로).
// 매 턴 다시 load 한다 — 다시 보내 주는 기록(replay)으로 tmux 에서 직접 오간 말까지 방에 보여 주고 이어서 답한다.
// 파일: 영시리 → PC 는 러너가 <창 폴더>/.0siri/inbox 에 쓴다. PC → 영시리 는 답의 [[0siri-file: 경로]] 를 받아 방에 링크로.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Hono } from "hono";
import { z } from "zod";
import {
  PANE_CLIS,
  type PaneCli,
  type PaneLink,
  type TmuxPane,
} from "../../../../packages/domain/src/osiri.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { PermissionAsk, Runner } from "./subscription.ts";

const LINKS = "paneLinks";
/** 방에 한 번에 보여 줄 세션 기록 수 — ponytail: 그 이전은 «앞 N개 생략» 한 줄, 다 보려면 tmux 에서 */
const BACKLOG = 30;
const FILE_MARK = /\[\[0siri-file:\s*([^\]\n]+?)\s*\]\]/g;
const FIRST_NOTE =
  "\n\n[영시리] 이 대화는 영시리 대화방에서 이어집니다. 사용자에게 파일을 보내려면 답에 [[0siri-file: 작업 폴더 기준 경로]] 를 한 줄로 쓰세요. 사용자가 보낸 파일은 .0siri/inbox/ 에 있습니다.";

type HistoryEntry = { role: "user" | "agent"; text: string };
type Deps = {
  runner: (owner: string) => Runner;
  gate?: (owner: string, ask: PermissionAsk) => Promise<boolean>;
  mcpServers?: (owner: string, threadId: string) => Promise<acp.McpServer[]>;
  /** PC 에서 받은 파일을 둘 곳(<DATA_DIR>/pane-files)과 그 주소 */
  filesDir: string;
  publicUrl: string;
};

export class Panes {
  constructor(
    private readonly db: Store,
    private readonly deps: Deps,
  ) {}

  async list(owner: string) {
    return this.deps.runner(owner).call<TmuxPane[]>("panes");
  }
  linked(owner: string, threadId: string) {
    return this.db.get<PaneLink>(owner, LINKS, threadId);
  }
  detach(owner: string, threadId: string) {
    return this.db.remove(owner, LINKS, threadId);
  }

  /** 그 창 폴더에서 그 CLI 가 가장 최근에 쓴 세션을 찾아 붙인다. 없으면 붙이지 않고 알린다 */
  async attach(owner: string, threadId: string, pane: TmuxPane) {
    const listed = await this.list(owner);
    if (!listed.some((p) => p.target === pane.target && p.cli === pane.cli && p.cwd === pane.cwd))
      throw new AppError("그 tmux 창을 찾지 못했습니다 — 목록을 새로 불러 고르세요", 404);
    const { sessionId, history } = await this.open(owner, pane.cli, pane.cwd, async (conn) => {
      const { sessions } = await conn.listSessions({ cwd: pane.cwd });
      const latest = sessions
        .filter((s) => s.cwd === pane.cwd)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      if (!latest)
        throw new AppError(
          `그 창(${pane.cwd})에서 ${pane.cli} 가 쓴 세션이 없습니다 — 그 창에서 한 번 말을 건 뒤 다시 붙이세요`,
          404,
        );
      // 지금 이어지는지 확인하며 기록 수를 센다(replay) — 못 이으면 붙이지 않는다
      await conn.loadSession({ sessionId: latest.sessionId, cwd: pane.cwd, mcpServers: [] });
      return latest.sessionId;
    });
    const link: PaneLink = {
      id: threadId,
      ...pane,
      sessionId,
      seen: 0,
      attachedAt: new Date().toISOString(),
    };
    await this.db.put(owner, LINKS, link);
    return { link, history: history.length };
  }

  /**
   * 한 턴: 세션을 load(기록 replay) → 방에 아직 안 보여 준 기록을 먼저 흘림 → 프롬프트 → 답·도구를 흘림 → 파일 표시를 링크로.
   * ponytail: 턴마다 ACP 어댑터를 새로 띄운다(npx 캐시로 수 초). 느리면 방마다 연결을 살려 두는 쪽으로.
   */
  async ask(
    owner: string,
    link: PaneLink,
    text: string,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ) {
    let answer = "";
    const { history } = await this.open(
      owner,
      link.cli,
      link.cwd,
      async (conn, live) => {
        const backlog = live.history.slice(link.seen);
        if (backlog.length) onText(formatBacklog(backlog, link.seen === 0));
        live.stream = (delta) => {
          answer += delta;
          onText(delta);
        };
        const cancel = () => void conn.cancel({ sessionId: link.sessionId }).catch(() => {});
        signal.addEventListener("abort", cancel, { once: true });
        try {
          await conn.prompt({
            sessionId: link.sessionId,
            prompt: [{ type: "text", text: link.seen === 0 ? text + FIRST_NOTE : text }],
          });
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
      link,
    );
    const files = await this.collect(owner, link, answer);
    if (files) onText(files);
    // 이번 턴의 내 말·답 2개를 더해 둔다 — 다음 턴엔 그 뒤(tmux 에서 오간 말)만 보인다
    await this.db.put(owner, LINKS, { ...link, seen: history.length + 2 });
  }

  /** 영시리 → PC: 창 폴더의 .0siri/inbox 에 쓴다. 돌려준 경로를 다음 말에 넣으면 CLI 가 읽는다 */
  async send(owner: string, threadId: string, name: string, bytes: Uint8Array) {
    const link = await this.linked(owner, threadId);
    if (!link) throw new AppError("이 방에 붙은 tmux 창이 없습니다", 404);
    return this.deps.runner(owner).call<{ path: string }>("put", {
      cwd: link.cwd,
      name,
      b64: Buffer.from(bytes).toString("base64"),
    });
  }

  /** PC → 영시리: 답의 [[0siri-file: 경로]] 를 러너에서 받아 와 링크로. 못 받은 것도 숨기지 않는다 */
  private async collect(owner: string, link: PaneLink, answer: string) {
    const paths = [...new Set([...answer.matchAll(FILE_MARK)].map((m) => m[1] as string))];
    if (!paths.length) return "";
    const lines: string[] = [];
    for (const path of paths) {
      try {
        const file = await this.deps
          .runner(owner)
          .call<{ name: string; b64: string }>("get", { cwd: link.cwd, path }, 60_000);
        const id = randomBytes(16).toString("hex");
        await mkdir(join(this.deps.filesDir, id), { recursive: true, mode: 0o700 });
        await writeFile(join(this.deps.filesDir, id, file.name), Buffer.from(file.b64, "base64"));
        const url = `${this.deps.publicUrl.replace(/\/$/, "")}/api/pane-files/${id}/${encodeURIComponent(file.name)}`;
        lines.push(`📎 [${file.name}](${url})`);
      } catch (error) {
        lines.push(
          `⚠ ${path} 를 받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return `\n\n${lines.join("\n")}`;
  }

  /** 그 창의 CLI 를 ACP 로 띄워 한 번 쓰고 닫는다. `link` 가 있으면 그 세션을 load(기록을 모은다) */
  private async open<T>(
    owner: string,
    cli: PaneCli,
    cwd: string,
    use: (
      conn: acp.ClientSideConnection,
      live: { history: HistoryEntry[]; stream?: (delta: string) => void },
    ) => Promise<T>,
    link?: PaneLink,
  ): Promise<{ history: HistoryEntry[]; sessionId: T }> {
    const pipe = this.deps.runner(owner).open(cli, cwd);
    const live: { history: HistoryEntry[]; stream?: (delta: string) => void } = { history: [] };
    const threadId = link?.id ?? "";
    const conn = new acp.ClientSideConnection(
      () => ({
        // 쓰기·명령은 앱 승인 카드로. 물을 수 없으면 거절(fail-closed)
        requestPermission: async ({ toolCall, options }) => {
          const allow = options.find((o) => o.kind === "allow_once");
          const reject = options.find((o) => o.kind === "reject_once");
          const refuse = reject
            ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
            : { outcome: { outcome: "cancelled" as const } };
          if (!allow || !this.deps.gate) return refuse;
          const approved = await this.deps
            .gate(owner, {
              threadId,
              actor: `tmux ${link?.target ?? ""} (${cli})`,
              title: toolCall.title ?? "에이전트 작업",
              kind: toolCall.kind ?? "other",
              input: toolCall.rawInput ?? null,
            })
            .catch(() => false);
          return approved
            ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
            : refuse;
        },
        sessionUpdate: async ({ update }) => {
          if (live.stream) {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
              live.stream(update.content.text);
            else if (update.sessionUpdate === "tool_call")
              live.stream(`\n\n🔧 ${update.title}\n\n`);
            return;
          }
          // load 중 replay: 같은 쪽 조각은 한 덩어리로
          if (
            (update.sessionUpdate !== "user_message_chunk" &&
              update.sessionUpdate !== "agent_message_chunk") ||
            update.content.type !== "text"
          )
            return;
          const role = update.sessionUpdate === "user_message_chunk" ? "user" : "agent";
          const last = live.history.at(-1);
          if (last?.role === role) last.text += update.content.text;
          else live.history.push({ role, text: update.content.text });
        },
      }),
      acp.ndJsonStream(pipe.input, pipe.output),
    );
    try {
      await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      if (link) {
        await conn
          .loadSession({
            sessionId: link.sessionId,
            cwd,
            mcpServers: (await this.deps.mcpServers?.(owner, link.id)) ?? [],
          })
          .catch((error: unknown) => {
            throw new AppError(
              `그 창의 세션을 잇지 못했습니다(${error instanceof Error ? error.message : String(error)}) — 창에서 새 세션을 열었으면 방 설정에서 다시 붙이세요`,
              409,
            );
          });
      }
      const value = await use(conn, live);
      return { history: live.history, sessionId: value };
    } finally {
      pipe.close();
    }
  }
}

/** 방에 보여 줄 세션 기록. 처음 붙였을 때는 «이전 기록», 그 뒤는 «tmux 에서 오간 말» */
export function formatBacklog(entries: HistoryEntry[], first: boolean) {
  const shown = entries.slice(-BACKLOG);
  const skipped = entries.length - shown.length;
  const head = first ? "이 세션의 이전 기록" : "tmux 에서 오간 말";
  const body = shown
    .map((e) =>
      e.role === "user" ? `> **나:** ${e.text.trim().replace(/\n/g, "\n> ")}` : e.text.trim(),
    )
    .join("\n\n");
  return `— ${head}${skipped ? ` (앞 ${skipped}개 생략)` : ""} —\n\n${body}\n\n— 여기부터 지금 —\n\n`;
}

/** 받은 파일 — 주소(추측 불가 id)가 곧 열쇠라 로그인 없이 연다(대화방 링크·이미지가 바로 열리게). 인증 미들웨어 앞에 */
export function paneFileRoutes(filesDir: string) {
  const app = new Hono();
  app.get("/pane-files/:id/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    if (!/^[0-9a-f]{32}$/.test(id) || name.includes("/") || name.startsWith("."))
      throw new AppError("없는 파일입니다", 404);
    const bytes = await readFile(join(filesDir, id, name)).catch(() => {
      throw new AppError("없는 파일입니다", 404);
    });
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    c.header("X-Content-Type-Options", "nosniff");
    // ponytail: 형식은 이미지·PDF 만 알아본다. HTML 등은 내려받기로(같은 출처 스크립트 실행 방지)
    const type = /\.png$/i.test(name)
      ? "image/png"
      : /\.jpe?g$/i.test(name)
        ? "image/jpeg"
        : /\.pdf$/i.test(name)
          ? "application/pdf"
          : "application/octet-stream";
    c.header("Content-Type", type);
    return c.body(bytes);
  });
  return app;
}

export function paneRoutes(panes: Panes) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const pane = z.object({
    target: z.string().min(1).max(200),
    cli: z.enum(PANE_CLIS),
    cwd: z.string().min(1).max(1000),
  });
  app.get("/panes", async (c) => c.json({ panes: await panes.list(c.get("owner")) }));
  app.get("/panes/:threadId", async (c) =>
    c.json({ link: (await panes.linked(c.get("owner"), c.req.param("threadId"))) ?? null }),
  );
  app.put("/panes/:threadId", async (c) =>
    c.json(
      await panes.attach(c.get("owner"), c.req.param("threadId"), pane.parse(await c.req.json())),
    ),
  );
  app.delete("/panes/:threadId", async (c) => {
    await panes.detach(c.get("owner"), c.req.param("threadId"));
    return c.json({ link: null });
  });
  app.post("/panes/:threadId/files", async (c) => {
    const file = (await c.req.parseBody()).file;
    if (!(file instanceof File)) throw new AppError("보낼 파일을 고르세요");
    if (file.size > 10 * 1024 * 1024) throw new AppError("10MB 를 넘는 파일입니다", 413);
    return c.json(
      await panes.send(
        c.get("owner"),
        c.req.param("threadId"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
      ),
    );
  });
  return app;
}
