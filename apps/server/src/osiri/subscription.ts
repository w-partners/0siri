/**
 * 구독 사용 — 사용자 본인의 ChatGPT·Claude 구독으로 영시리가 답한다 (마스터 2026-10-10).
 *
 * 기획 §08 의 경계 그대로 나눈다:
 *  - 도커 내부: 사용자 한 명 = 컨테이너 하나(Dockerfile.subscription). CLI·ACP 어댑터·로그인 tmux 만. 로그인 정보는 그 사람 볼륨에만.
 *  - 중개(이 파일): 컨테이너·PC 와 말하는 유일한 통로. 에이전트의 권한 요청은 전부 거절한다(승인 게이트는 컨테이너 밖, fail-closed).
 *  - 도커 외부: 대화 기록·사용량은 서버 DB 에만 남는다.
 *  - 본인 PC: 러너(apps/runner/osiri-runner.mjs)가 바깥으로 접속해 «도커 내부» 역할을 대신한다. 중개는 같은 ACP 로 말한다.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Hono } from "hono";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  type PcSession,
  SUBSCRIPTION_PLACES,
  SUBSCRIPTION_PROVIDERS,
  type SubscriptionPlace,
  type SubscriptionProvider,
  type SubscriptionView,
} from "../../../../packages/domain/src/osiri.ts";
import { runDocker } from "../computer.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Llm } from "./team-runtime.ts";

export interface SubscriptionPrefs {
  id: "subscription";
  /** 켜져 있으면 영시리 대화가 공용키·BYOK 대신 이 구독으로 간다 */
  active: boolean;
  provider: SubscriptionProvider;
  place: SubscriptionPlace;
  /** 본인 PC 러너 열쇠의 해시. 원문은 발급 때 한 번만 보여 준다 */
  runnerKeyHash?: string;
}
const DEFAULT_PREFS: SubscriptionPrefs = {
  id: "subscription",
  active: false,
  provider: "codex",
  place: "server",
};

const ADAPTER: Record<SubscriptionProvider, string> = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
};
// 서버 컨테이너는 브라우저를 못 띄운다 → 화면에 코드·링크를 띄우는 로그인만 쓴다
const LOGIN: Record<SubscriptionProvider, string> = {
  claude: "claude auth login",
  codex: "codex login --device-auth",
};
const STATUS: Record<SubscriptionProvider, string[]> = {
  claude: ["claude", "auth", "status"],
  codex: ["codex", "login", "status"],
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** ACP 연결 하나에 쓰는 양방향 통로 — 컨테이너 docker exec 든 PC 러너든 모양이 같다 */
interface AcpPipe {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  /** 에이전트가 세션을 열 작업 폴더(에이전트 쪽 절대경로) */
  cwd: string;
  /** cwd 아래 하위 폴더를 만든다(팀 폴더) */
  mkdir(relative: string): Promise<void>;
  close(): void;
}

/** 본인 PC 러너 하나. 러너가 바깥으로 접속해 오므로 PC 쪽에 열린 포트가 없다 */
export class Runner {
  private readonly pipes = new Map<
    string,
    { push: (text: string) => void; end: () => void; fail: (e: Error) => void }
  >();
  private readonly calls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  constructor(
    readonly socket: WebSocket,
    readonly cwd: string,
  ) {
    socket.on("message", (raw) => {
      let msg: { t?: string; id?: string; d?: string; error?: string; value?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const call = msg.t === "result" && msg.id ? this.calls.get(msg.id) : undefined;
      if (call) {
        this.calls.delete(msg.id as string);
        if (msg.error) call.reject(new AppError(`내 PC: ${msg.error}`, 422));
        else call.resolve(msg.value);
        return;
      }
      const pipe = msg.id ? this.pipes.get(msg.id) : undefined;
      if (!pipe) return;
      if (msg.t === "data" && typeof msg.d === "string") pipe.push(msg.d);
      else if (msg.t === "exit") {
        if (msg.error) pipe.fail(new Error(`PC 러너: ${msg.error}`));
        else pipe.end();
        this.pipes.delete(msg.id as string);
      }
    });
    socket.on("close", () => {
      for (const pipe of this.pipes.values()) pipe.fail(new Error("PC 러너 연결이 끊겼습니다"));
      this.pipes.clear();
      for (const call of this.calls.values())
        call.reject(new AppError("PC 러너 연결이 끊겼습니다", 409));
      this.calls.clear();
    });
  }
  /** 러너에게 묻는다(tmux 창 목록·파일). 옛 러너는 답하지 않는다 — 시간 안에 없으면 새 러너를 받으라고 알린다 */
  call<T>(op: string, args: object = {}, timeoutMs = 20_000): Promise<T> {
    const id = randomBytes(8).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(
          new AppError(
            "내 PC 러너가 답하지 않습니다 — 러너를 새로 받아(«설정 › 연결 › 내 PC») 다시 실행하세요",
            503,
          ),
        );
      }, timeoutMs);
      this.calls.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.send(JSON.stringify({ t: "call", id, op, args }));
    });
  }
  /** `cwd` 를 주면 PC 에서 그 폴더(tmux 창 폴더)에서 띄운다. provider 는 구독 둘 + tmux CLI 들 */
  open(provider: string, cwd?: string): AcpPipe {
    const id = randomBytes(8).toString("hex");
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const output = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    this.pipes.set(id, {
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      fail: (e) => controller.error(e),
    });
    const send = (msg: object) => this.socket.send(JSON.stringify(msg));
    send({ t: "open", id, provider, ...(cwd ? { cwd } : {}) });
    return {
      cwd: cwd ?? this.cwd,
      // 러너가 메시지를 순서대로 처리하므로 이어지는 session/new 보다 먼저 만들어진다
      mkdir: async (path) => send({ t: "mkdir", path }),
      output,
      input: new WritableStream<Uint8Array>({
        write: (chunk) => send({ t: "data", id, d: decoder.decode(chunk, { stream: true }) }),
      }),
      close: () => {
        if (!this.pipes.delete(id)) return;
        send({ t: "close", id });
        try {
          controller.close();
        } catch {}
      },
    };
  }
}

export class Subscriptions {
  private readonly runners = new Map<string, Runner>();
  /** 그 사람 PC 러너(tmux 창 붙이기가 쓴다). 없으면 알리고 끝낸다 */
  runner(owner: string): Runner {
    const runner = this.runners.get(owner);
    if (!runner)
      throw new AppError("내 PC 러너가 연결되어 있지 않습니다 — PC 에서 러너를 실행하세요", 409);
    return runner;
  }
  constructor(
    private readonly db: Store,
    private readonly options: {
      /** 사용자 볼륨을 둘 폴더 (<DATA_DIR>/subscriptions) */
      dir: string;
      /** SUBSCRIPTION_IMAGE — 없으면 서버 구독은 꺼져 있다(PC 러너만 가능) */
      image?: string;
      /**
       * 에이전트의 쓰기·명령 요청을 앱 승인 카드로 묻는다(승인 게이트는 컨테이너 밖). 없으면 전부 거절(fail-closed).
       * true = 사용자가 승인
       */
      gate?: (owner: string, request: PermissionAsk) => Promise<boolean>;
      /** 세션에 붙일 MCP 서버(0Siri MCP — 기억·우리 도구). 세션을 열거나 다시 붙일 때마다 부른다 */
      mcpServers?: (owner: string, threadId: string) => Promise<acp.McpServer[]>;
      /** 이만큼 쓰지 않은 어댑터 프로세스를 닫는다(세션은 디스크에 남아 다음 턴에 resume) */
      idleAdapterMs?: number;
      /** 이만큼 쓰지 않은 서버 구독 컨테이너를 멈춘다(볼륨·로그인은 남는다 — 다음 사용 때 다시 뜬다) */
      idleContainerMs?: number;
    },
  ) {}
  /** 컨테이너 이름 → 마지막 사용 시각 (유휴 정리용) */
  private readonly used = new Map<string, number>();

  async prefs(owner: string): Promise<SubscriptionPrefs> {
    return (
      (await this.db.get<SubscriptionPrefs>(owner, "settings", "subscription")) ?? DEFAULT_PREFS
    );
  }
  async update(owner: string, patch: Partial<Omit<SubscriptionPrefs, "id">>) {
    const next = { ...(await this.prefs(owner)), ...patch, id: "subscription" as const };
    if (next.active && next.place === "server" && !this.options.image)
      throw new Error(
        "서버 구독 실행이 설정되어 있지 않습니다 (SUBSCRIPTION_IMAGE) — «내 PC» 로 쓰세요",
      );
    await this.db.put(owner, "settings", next);
    return next;
  }
  async view(owner: string): Promise<SubscriptionView> {
    const { runnerKeyHash, ...prefs } = await this.prefs(owner);
    const runner = this.runners.get(owner);
    return {
      ...prefs,
      serverAvailable: Boolean(this.options.image),
      runnerKeyIssued: Boolean(runnerKeyHash),
      runner: runner
        ? { connected: true as const, cwd: runner.cwd }
        : { connected: false as const },
    };
  }
  /** 대화가 구독으로 가야 하면 그 설정, 아니면 undefined */
  async activeFor(owner: string) {
    const prefs = await this.prefs(owner);
    return prefs.active ? prefs : undefined;
  }

  // ---- 도커 내부: 사용자별 컨테이너 ----
  private container(owner: string) {
    return `osiri-sub-${sha(owner).slice(0, 12)}`;
  }
  private async docker(args: string[], timeoutMs = 60_000) {
    const result = await runDocker(args, { timeoutMs, maxOutputBytes: 200_000 });
    return { ok: result.exitCode === 0, out: result.stdout, err: result.stderr.trim() };
  }
  /** 그 사람 컨테이너를 띄운다(이미 떠 있으면 그대로). 볼륨은 그 사람 폴더 하나뿐 */
  private async ensure(owner: string) {
    const image = this.options.image;
    if (!image) throw new Error("서버 구독 실행이 설정되어 있지 않습니다 (SUBSCRIPTION_IMAGE)");
    const name = this.container(owner);
    this.used.set(name, Date.now());
    const state = await this.docker(["inspect", "-f", "{{.State.Running}}", name]);
    if (state.ok && state.out.trim() === "true") return name;
    if (state.ok) await this.docker(["rm", "-f", name]);
    const home = resolve(this.options.dir, sha(owner).slice(0, 24));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    // 격리: 권한 전부 버림·권한 상승 금지·자원 상한. 들어오는 포트 없음, docker 소켓·서버 폴더 마운트 없음
    const run = await this.docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--restart",
        "unless-stopped",
        "--label",
        `osiri.user=${owner}`,
        "--label",
        "osiri.role=subscription",
        "--user",
        `${uid}:${gid}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "768m",
        "--pids-limit",
        "256",
        "-v",
        `${home}:/home/agent`,
        image,
      ],
      120_000,
    );
    if (!run.ok) throw new Error(`구독 컨테이너를 띄우지 못했습니다: ${run.err || run.out}`);
    return name;
  }

  /** 로그인 터미널(tmux «login» 세션)을 새로 연다 */
  async login(owner: string, provider: SubscriptionProvider) {
    const name = await this.ensure(owner);
    await this.docker(["exec", name, "tmux", "kill-session", "-t", "login"]);
    // 명령이 끝나도 화면을 남겨 둔다 — 결과(성공·실패 문구)를 사용자가 읽어야 한다
    const script = `${LOGIN[provider]}; echo; echo '[로그인 명령이 끝났습니다]'; sleep 1800`;
    const r = await this.docker([
      "exec",
      name,
      "tmux",
      "new-session",
      "-d",
      "-s",
      "login",
      "-x",
      "80",
      "-y",
      "30",
      "sh",
      "-c",
      script,
    ]);
    if (!r.ok) throw new Error(`로그인 터미널을 열지 못했습니다: ${r.err}`);
    return this.screen(owner);
  }
  /** 로그인 터미널 화면 글자. 터미널이 없으면 null */
  async screen(owner: string): Promise<string | null> {
    const r = await this.docker([
      "exec",
      this.container(owner),
      "tmux",
      "capture-pane",
      "-p",
      "-J",
      "-t",
      "login",
    ]);
    return r.ok ? r.out.replace(/\s+$/, "") : null;
  }
  async type(owner: string, text: string, enter: boolean) {
    const name = this.container(owner);
    if (text) {
      const r = await this.docker(["exec", name, "tmux", "send-keys", "-t", "login", "-l", text]);
      if (!r.ok) throw new Error("로그인 터미널이 열려 있지 않습니다");
    }
    if (enter) await this.docker(["exec", name, "tmux", "send-keys", "-t", "login", "Enter"]);
    return this.screen(owner);
  }
  /** CLI 가 말하는 로그인 상태 — 판정은 CLI 종료 코드만 본다 */
  async status(owner: string, provider: SubscriptionProvider) {
    const name = await this.ensure(owner);
    const r = await this.docker(["exec", name, ...STATUS[provider]]);
    return { loggedIn: r.ok, detail: (r.out.trim() || r.err).split("\n").slice(0, 3).join("\n") };
  }

  // ---- 본인 PC 러너 ----
  async issueRunnerKey(owner: string) {
    const key = `${Buffer.from(owner).toString("base64url")}.${randomBytes(24).toString("base64url")}`;
    const prefs = await this.prefs(owner);
    await this.db.put(owner, "settings", { ...prefs, runnerKeyHash: sha(key) });
    // 새 열쇠를 내면 옛 열쇠로 붙어 있던 러너는 끊는다
    this.runners.get(owner)?.socket.close(4001, "새 열쇠가 발급되었습니다");
    return key;
  }
  private async verifyRunnerKey(key: string) {
    const owner = Buffer.from(key.split(".")[0] ?? "", "base64url").toString();
    if (!owner) return undefined;
    const stored = (await this.prefs(owner)).runnerKeyHash;
    if (!stored) return undefined;
    const a = Buffer.from(stored);
    const b = Buffer.from(sha(key));
    return a.length === b.length && timingSafeEqual(a, b) ? owner : undefined;
  }
  /** HTTP 서버에 러너 웹소켓(/api/subscription/runner)을 붙인다. 첫 메시지 hello 의 열쇠로 소유자를 가린다 */
  attach(server: Pick<Server, "on">) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/api/subscription/runner") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const timer = setTimeout(() => ws.close(4000, "hello 가 없습니다"), 10_000);
        ws.once("message", async (raw) => {
          clearTimeout(timer);
          let hello: { t?: string; key?: string; cwd?: string };
          try {
            hello = JSON.parse(String(raw));
          } catch {
            ws.close(4000, "hello 가 JSON 이 아닙니다");
            return;
          }
          const owner =
            hello.t === "hello" && hello.key ? await this.verifyRunnerKey(hello.key) : undefined;
          if (!owner || typeof hello.cwd !== "string" || !hello.cwd) {
            ws.close(4003, "열쇠가 맞지 않습니다 — 앱에서 새 명령을 받아 다시 실행하세요");
            return;
          }
          this.runners.get(owner)?.socket.close(4002, "다른 러너가 접속했습니다");
          const runner = new Runner(ws, hello.cwd);
          this.runners.set(owner, runner);
          ws.on("close", () => {
            if (this.runners.get(owner) === runner) this.runners.delete(owner);
          });
          ws.send(JSON.stringify({ t: "ready" }));
          console.log(`[osiri] 구독 PC 러너 접속 owner=${owner.slice(0, 8)}…`);
        });
      });
    });
  }

  // ---- 중개: ACP 연결 ----
  private async pipe(owner: string, prefs: SubscriptionPrefs): Promise<AcpPipe> {
    if (prefs.place === "pc") {
      const runner = this.runners.get(owner);
      if (!runner)
        throw new AppError("내 PC 러너가 연결되어 있지 않습니다 — PC 에서 러너를 실행하세요", 409);
      return runner.open(prefs.provider);
    }
    const name = await this.ensure(owner);
    const child: ChildProcess = spawn("docker", ["exec", "-i", name, ADAPTER[prefs.provider]], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-2000);
    });
    child.on("exit", (code) => {
      if (code)
        console.error(`[osiri] 구독 어댑터 종료 code=${code}: ${stderr.trim().slice(-300)}`);
    });
    return {
      cwd: "/home/agent",
      mkdir: async (relative) => {
        const r = await this.docker(["exec", name, "mkdir", "-p", `/home/agent/${relative}`]);
        if (!r.ok) throw new Error(`작업 폴더를 만들지 못했습니다: ${r.err}`);
      },
      input: Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
      output: Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
      close: () => child.kill(),
    };
  }

  /** 사람마다 살아 있는 ACP 연결 하나(wgolf-acp-test 의 aoe acp-runner 와 같은 모양). 대화방·팀 역할마다 세션 하나 */
  private readonly live = new Map<string, Promise<Live>>();

  private async connect(owner: string, prefs: SubscriptionPrefs): Promise<Live> {
    const key = `${prefs.provider}:${prefs.place}`;
    const existing = this.live.get(owner);
    if (existing) {
      const live = await existing.catch(() => undefined);
      if (live && live.key === key && !live.conn.signal.aborted) return live;
      live?.pipe.close();
      this.live.delete(owner);
    }
    const opening = (async () => {
      const pipe = await this.pipe(owner, prefs);
      const listeners = new Map<string, (text: string) => void>();
      const contexts = new Map<string, { threadId: string; actor: string }>();
      const conn = new acp.ClientSideConnection(
        () => ({
          // 승인 게이트는 컨테이너 밖이다 — 쓰기·명령 요청은 앱 승인 카드로 묻고, 물을 수 없으면 거절(fail-closed)
          requestPermission: async ({ sessionId, toolCall, options }) => {
            const context = contexts.get(sessionId);
            const allow = options.find((o) => o.kind === "allow_once");
            const reject = options.find((o) => o.kind === "reject_once");
            const refuse = reject
              ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
              : { outcome: { outcome: "cancelled" as const } };
            if (!context || !allow || !this.options.gate) return refuse;
            const approved = await this.options
              .gate(owner, {
                ...context,
                title: toolCall.title ?? "에이전트 작업",
                kind: toolCall.kind ?? "other",
                input: toolCall.rawInput ?? null,
              })
              .catch((error: unknown) => {
                console.error(`[osiri] 구독 승인 게이트 실패: ${(error as Error).message}`);
                return false;
              });
            return approved
              ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
              : refuse;
          },
          // 지금 답을 기다리는 세션의 글자만 흘린다(세션을 다시 붙일 때 되풀이되는 옛 기록은 버린다)
          sessionUpdate: async ({ sessionId, update }) => {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
              listeners.get(sessionId)?.(update.content.text);
          },
        }),
        acp.ndJsonStream(pipe.input, pipe.output),
      );
      await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const live: Live = {
        key,
        pipe,
        conn,
        listeners,
        contexts,
        sessions: new Map(),
        busy: 0,
        lastUsed: Date.now(),
      };
      void conn.closed.finally(() => {
        if (this.live.get(owner) === opening) this.live.delete(owner);
      });
      return live;
    })();
    this.live.set(owner, opening);
    opening.catch(() => {
      if (this.live.get(owner) === opening) this.live.delete(owner);
    });
    return opening;
  }

  /**
   * 한 턴. 대화방(threadId)마다 ACP 세션 하나를 끝까지 이어 쓴다 — 처음 열 때만 `opening`(지시 + 이전 대화),
   * 그 뒤로는 새 말(`latest`)만 보낸다. 지시(`brief`)가 바뀌었으면 그 턴에 새 지시를 앞에 붙인다.
   * 프로세스가 내려갔다 오면 저장해 둔 세션 ID 로 resume 한다. `folder` 는 작업 폴더(cwd 아래, 예: teams/legal).
   */
  async ask(
    owner: string,
    prefs: SubscriptionPrefs,
    turn: {
      threadId: string;
      brief: string;
      opening: string;
      latest: string;
      folder?: string;
      actor?: string;
    },
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ session: SessionState; resumeError?: string }> {
    const live = await this.connect(owner, prefs);
    live.busy++;
    live.lastUsed = Date.now();
    try {
      return await this.turn(owner, live, turn, onText, signal);
    } finally {
      live.busy--;
      live.lastUsed = Date.now();
      if (prefs.place === "server") this.used.set(this.container(owner), Date.now());
    }
  }

  private async turn(
    owner: string,
    live: Live,
    turn: Parameters<Subscriptions["ask"]>[2],
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ session: SessionState; resumeError?: string }> {
    const cwd = turn.folder ? `${live.pipe.cwd}/${turn.folder}` : live.pipe.cwd;
    const briefHash = sha(turn.brief);
    let stored = await this.db.get<StoredSession>(owner, SESSIONS, turn.threadId);
    // 사용자 PC(tmux)에서 이어 쓴 세션은 매 턴 디스크에서 다시 잇는다 — tmux 에서 친 말까지 알고 답하게
    if (stored?.external) live.sessions.delete(turn.threadId);
    let sessionId = live.sessions.get(turn.threadId);
    let session: SessionState = "live";
    let resumeError: string | undefined;
    if (!sessionId) {
      const mcpServers = (await this.options.mcpServers?.(owner, turn.threadId)) ?? [];
      if (stored && stored.key === live.key) {
        try {
          await live.conn.resumeSession({
            sessionId: stored.sessionId,
            cwd: stored.cwd,
            mcpServers,
          });
          sessionId = stored.sessionId;
          session = "resumed";
        } catch (error) {
          // 사용자가 골라 붙인 PC 세션은 새 세션으로 바꿔치지 않는다 — 못 이으면 실패로 알린다
          if (stored.external)
            throw new AppError(
              `내 PC 의 그 세션을 잇지 못했습니다(${error instanceof Error ? error.message : String(error)}). 러너가 켜져 있는지, 같은 구독·실행 위치인지 확인하세요`,
              409,
            );
          // 잇지 못한 것은 숨기지 않는다 — 새 세션으로 시작했다고 답 아래에 남긴다
          resumeError = error instanceof Error ? error.message : String(error);
          session = "rebuilt";
        }
      } else if (stored?.external)
        throw new AppError("이 대화방은 다른 구독·실행 위치의 PC 세션에 붙어 있습니다", 409);
      else session = "new";
      if (!sessionId) {
        if (turn.folder) await live.pipe.mkdir(turn.folder);
        sessionId = (await live.conn.newSession({ cwd, mcpServers })).sessionId;
        stored = { id: turn.threadId, key: live.key, sessionId, cwd, briefHash };
        await this.db.put(owner, SESSIONS, stored);
      }
      live.sessions.set(turn.threadId, sessionId);
    }
    const fresh = session === "new" || session === "rebuilt";
    let text = fresh ? turn.opening : turn.latest;
    if (!fresh && stored?.briefHash !== briefHash) {
      // 지시가 바뀌었다(페르소나 수정·스킬 장착) — 세션은 잇고 새 지시를 알린다
      text = `[지시가 바뀌었습니다 — 지금부터 아래 지시를 따른다]\n${turn.brief}\n\n${turn.latest}`;
      if (stored) await this.db.put(owner, SESSIONS, { ...stored, briefHash });
    }
    const id = sessionId;
    live.listeners.set(id, onText);
    live.contexts.set(id, { threadId: turn.threadId, actor: turn.actor ?? "영시리" });
    const cancel = () => void live.conn.cancel({ sessionId: id }).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await live.conn.prompt({ sessionId: id, prompt: [{ type: "text", text }] });
    } finally {
      signal.removeEventListener("abort", cancel);
      live.listeners.delete(id);
    }
    return { session, ...(resumeError ? { resumeError } : {}) };
  }

  /** 지금 구독·실행 위치에 있는 세션들(내 PC 라면 tmux 에서 쓰던 claude·codex 대화) — 최근 것부터 */
  async pcSessions(owner: string): Promise<PcSession[]> {
    const live = await this.connect(owner, await this.prefs(owner));
    const { sessions } = await live.conn.listSessions({});
    return sessions
      .map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? null,
        updatedAt: s.updatedAt ?? null,
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 50);
  }
  /** 대화방을 그 세션에 붙인다 — 다음 턴부터 그 세션을 이어 쓴다(새 세션으로 바꿔치지 않음) */
  async attachSession(owner: string, threadId: string, pick: { sessionId: string; cwd: string }) {
    const live = await this.connect(owner, await this.prefs(owner));
    const listed = (await this.pcSessions(owner)).some((s) => s.sessionId === pick.sessionId);
    if (!listed) throw new AppError("그 세션을 찾지 못했습니다 — 목록을 새로 불러 고르세요", 404);
    live.sessions.delete(threadId);
    await this.db.put(owner, SESSIONS, {
      id: threadId,
      key: live.key,
      sessionId: pick.sessionId,
      cwd: pick.cwd,
      external: true,
    } satisfies StoredSession);
  }
  /** 대화방의 PC 세션 연결을 끊는다 — 다음 턴은 새 세션 */
  async detachSession(owner: string, threadId: string) {
    for (const live of await Promise.all([...this.live.values()].map((p) => p.catch(() => null))))
      live?.sessions.delete(threadId);
    await this.db.remove(owner, SESSIONS, threadId);
  }
  async attachedSession(owner: string, threadId: string) {
    const stored = await this.db.get<StoredSession>(owner, SESSIONS, threadId);
    return stored?.external ? { sessionId: stored.sessionId, cwd: stored.cwd } : null;
  }

  /**
   * 팀 역할을 그 사람 구독으로 돌리는 모델 함수 — 역할마다 세션 하나(`team:<방>:<역할>`), 작업 폴더 `teams/<팀>`.
   * 팀 지시문(system)은 서버에서 세션으로 보내는 프롬프트일 뿐, 그 사람 쪽에 파일로 깔리지 않는다.
   */
  teamLlm(owner: string, prefs: SubscriptionPrefs, team: { roomId: string; slug: string }): Llm {
    return async (role, _tier, system, user) => {
      let out = "";
      await this.ask(
        owner,
        prefs,
        {
          threadId: `team:${team.roomId}:${role}`,
          brief: system,
          opening: `${system}\n\n${user}`,
          latest: user,
          folder: `teams/${team.slug.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
          actor: role,
        },
        (t) => {
          out += t;
        },
        AbortSignal.timeout(20 * 60_000),
      );
      if (!out.trim())
        throw new Error(`내 구독(${prefs.provider})이 빈 답을 돌려주었습니다 (역할 ${role})`);
      return out;
    };
  }

  /** 유휴 정리: 쓰지 않는 어댑터 프로세스를 닫고, 오래 쓰지 않은 서버 구독 컨테이너를 멈춘다 */
  async reap(now = Date.now()) {
    const adapterMs = this.options.idleAdapterMs ?? 30 * 60_000;
    const containerMs = this.options.idleContainerMs ?? 6 * 3600_000;
    let adapters = 0;
    let containers = 0;
    for (const [owner, opening] of this.live) {
      const live = await opening.catch(() => undefined);
      if (live && live.busy === 0 && now - live.lastUsed > adapterMs) {
        this.live.delete(owner);
        live.pipe.close();
        adapters++;
      }
    }
    if (!this.options.image) return { adapters, containers };
    const ps = await this.docker([
      "ps",
      "--filter",
      "label=osiri.role=subscription",
      "--format",
      "{{.Names}}",
    ]);
    if (!ps.ok) {
      console.error(`[osiri] 구독 컨테이너 목록을 읽지 못했습니다: ${ps.err}`);
      return { adapters, containers };
    }
    for (const name of ps.out.split("\n").filter(Boolean)) {
      // 서버가 다시 떴으면 기록이 없다 — 지금부터 센다
      const last = this.used.get(name) ?? (this.used.set(name, now), now);
      if (now - last <= containerMs) continue;
      if (await this.inUse(name)) continue;
      const stop = await this.docker(["stop", "-t", "10", name]);
      if (stop.ok) {
        this.used.delete(name);
        containers++;
      } else console.error(`[osiri] 구독 컨테이너를 멈추지 못했습니다 ${name}: ${stop.err}`);
    }
    return { adapters, containers };
  }
  private async inUse(name: string) {
    for (const [owner, opening] of this.live) {
      if (this.container(owner) !== name) continue;
      const live = await opening.catch(() => undefined);
      if (live?.key.endsWith(":server")) return true;
    }
    return false;
  }
  startReaper(intervalMs = 5 * 60_000) {
    const timer = setInterval(
      () =>
        void this.reap().then(
          (r) =>
            (r.adapters || r.containers) &&
            console.log(`[osiri] 구독 유휴 정리: 어댑터 ${r.adapters} · 컨테이너 ${r.containers}`),
          (error: Error) => console.error(`[osiri] 구독 유휴 정리 실패: ${error.message}`),
        ),
      intervalMs,
    );
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

type SessionState = "live" | "resumed" | "new" | "rebuilt";
/** 에이전트가 앱 승인을 구하는 작업 하나 */
export interface PermissionAsk {
  threadId: string;
  actor: string;
  title: string;
  kind: string;
  input: unknown;
}
const SESSIONS = "subscriptionSessions";
/** 대화방 → ACP 세션. 세션 기록 자체는 CLI 가 그 사람 홈(컨테이너 볼륨·본인 PC)에 남긴다 */
interface StoredSession {
  id: string;
  key: string;
  sessionId: string;
  cwd: string;
  /** 세션에 마지막으로 알린 지시(페르소나·역할 지시)의 해시 — 바뀌면 다음 턴에 새 지시를 붙인다 */
  briefHash?: string;
  /** 사용자가 자기 PC 에서 쓰던 세션(tmux 의 claude·codex)을 골라 붙였다 */
  external?: true;
}
interface Live {
  key: string;
  pipe: AcpPipe;
  conn: acp.ClientSideConnection;
  listeners: Map<string, (text: string) => void>;
  contexts: Map<string, { threadId: string; actor: string }>;
  sessions: Map<string, string>;
  busy: number;
  lastUsed: number;
}

export function subscriptionRoutes(subs: Subscriptions) {
  const app = new Hono<{ Variables: { owner: string } }>();
  const provider = z.enum(SUBSCRIPTION_PROVIDERS);
  app.get("/subscription", async (c) => c.json(await subs.view(c.get("owner"))));
  app.put("/subscription", async (c) => {
    const body = z
      .object({
        active: z.boolean().optional(),
        provider: provider.optional(),
        place: z.enum(SUBSCRIPTION_PLACES).optional(),
      })
      .parse(await c.req.json());
    await subs.update(c.get("owner"), body);
    return c.json(await subs.view(c.get("owner")));
  });
  app.post("/subscription/login", async (c) => {
    const body = z.object({ provider }).parse(await c.req.json());
    return c.json({ screen: await subs.login(c.get("owner"), body.provider) });
  });
  app.get("/subscription/terminal", async (c) =>
    c.json({ screen: await subs.screen(c.get("owner")) }),
  );
  app.post("/subscription/terminal", async (c) => {
    const body = z
      .object({ text: z.string().max(2000), enter: z.boolean().default(true) })
      .parse(await c.req.json());
    return c.json({ screen: await subs.type(c.get("owner"), body.text, body.enter) });
  });
  app.get("/subscription/status", async (c) =>
    c.json(await subs.status(c.get("owner"), provider.parse(c.req.query("provider")))),
  );
  app.get("/subscription/sessions", async (c) => c.json(await subs.pcSessions(c.get("owner"))));
  app.get("/subscription/attach/:threadId", async (c) =>
    c.json({ attached: await subs.attachedSession(c.get("owner"), c.req.param("threadId")) }),
  );
  app.put("/subscription/attach/:threadId", async (c) => {
    const body = z
      .object({ sessionId: z.string().min(1).max(200), cwd: z.string().min(1).max(1000) })
      .parse(await c.req.json());
    await subs.attachSession(c.get("owner"), c.req.param("threadId"), body);
    return c.json({ attached: body });
  });
  app.delete("/subscription/attach/:threadId", async (c) => {
    await subs.detachSession(c.get("owner"), c.req.param("threadId"));
    return c.json({ attached: null });
  });
  app.post("/subscription/runner-key", async (c) =>
    c.json({ key: await subs.issueRunnerKey(c.get("owner")) }),
  );
  return app;
}
