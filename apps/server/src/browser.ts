import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import { BrowserContainers } from "./browser-containers.ts";
import { type DockerRunner, runDocker } from "./computer.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
/** 브라우저 프로필 — 대화가 아니라 사람에게 붙는다(로그인이 대화를 넘어 남는다). id 가 곧 워커 세션 id (마스터 2026-10-12 «프로필도 저장») */
export interface BrowserProfile {
  id: string;
  name: string;
  createdAt: string;
}
type ProfilePref = { id: string; profileId: string };
/** 누가 화면을 조작하나 — 영시리(agent)가 넘기면 사람(user)만 클릭·입력하고, 돌려줄 때까지 영시리는 기다린다 */
export type BrowserHolder = "agent" | "user";
const PROFILES_MAX = 5;
const DEFAULT_PROFILE_NAME = "기본";

const BROWSER_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSessionId(id: string): void {
  if (!BROWSER_SESSION_ID.test(id)) throw new AppError("Browser session not found", 404);
}

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  // ponytail: 제어권은 서버 메모리 — 재시작하면 영시리에게 돌아간다(기다리던 턴도 함께 끝나므로 맞다)
  private readonly holders = new Map<
    string,
    { holder: BrowserHolder; reason: string; returned?: () => void }
  >();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
    docker: DockerRunner = runDocker,
  ) {
    // 사람마다 자기 브라우저 컨테이너(마스터 2026-10-12). 이미지가 없으면 BROWSER_WORKER_URL 공용 워커(개발용)
    if (config.browserImage && config.workerToken)
      this.containers = new BrowserContainers({
        image: config.browserImage,
        dir: `${config.dataDir}/browsers`,
        secret: config.workerToken,
        docker,
      });
    this.docker = docker;
  }
  readonly containers?: BrowserContainers;
  private readonly docker: DockerRunner;
  /** 그 사람의 워커 주소·토큰 — 사람별 컨테이너면 띄워서, 아니면 공용 워커 */
  private async endpoint(owner: string) {
    if (this.containers)
      return this.containers.endpoint(owner).catch((error: Error) => {
        console.error(`[osiri] 브라우저 컨테이너 실패 owner=${owner}: ${error.message}`);
        throw new AppError(`브라우저를 띄우지 못했습니다: ${error.message}`, 503);
      });
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    return { url: this.config.workerUrl, token: this.config.workerToken };
  }
  /** 브라우저가 준비됐나 — 사람별이면 이미지가 있는지, 공용이면 워커 health. 짧게 캐시 */
  reachable(): Promise<boolean> {
    if (!this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = this.config.browserImage
      ? this.docker(["image", "inspect", "-f", "{{.Id}}", this.config.browserImage], {
          timeoutMs: 5000,
          maxOutputBytes: 1000,
        }).then(
          (r) => r.exitCode === 0,
          () => false,
        )
      : this.config.workerUrl
        ? fetch(`${this.config.workerUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(
            (response) => response.ok,
            () => false,
          )
        : Promise.resolve(false);
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(owner: string, path: string, body?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const worker = await this.endpoint(owner);
    let response: Response;
    try {
      response = await fetch(`${worker.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${worker.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new AppError(
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        502,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    assertSessionId(id);
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    await this.db.put(owner, "browsers", session);
    return this.decorate(owner, session);
  }
  async create(owner: string, url: string, signal?: AbortSignal) {
    const id = randomUUID();
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.put(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url, signal);
  }
  private async openOwned(owner: string, id: string, url?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      const response = await this.request(owner, "/sessions", { id, url: target }, signal);
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      signal?.throwIfAborted();
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string, signal?: AbortSignal) {
    return this.serial(id, () => this.openOwned(owner, id, url, signal));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (
        await this.request(owner, `/sessions/${encodeURIComponent(id)}/read`, undefined, signal)
      ).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async observe(owner: string, url: string, existingId?: string, signal?: AbortSignal) {
    const id = existingId ?? (await this.create(owner, url, signal)).id;
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      if (existingId) await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      return { sessionId: id, ...(await this.readOwned(owner, id, signal)) };
    });
  }
  async observeForThread(owner: string, _threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // 대화마다가 아니라 사람의 «쓰는 중» 프로필 — 로그인·쿠키가 모든 대화에서 이어진다
    const id = (await this.activeProfile(owner)).id;
    this.assertAgentTurn(id);
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      const page = await this.readOwned(owner, id, signal);
      signal?.throwIfAborted();
      return {
        sessionId: id,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
      };
    });
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.request(owner, `/sessions/${encodeURIComponent(id)}/close`, {})).json(),
        id,
      );
    });
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.request(owner, `/sessions/${encodeURIComponent(id)}/screenshot`);
  }
  async input(owner: string, id: string, value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError("A JSON object is required for browser input", 422);
    if (this.holder(id).holder !== "user")
      throw new AppError(
        "영시리가 조작 중입니다 — «직접 조작» 을 눌러 넘겨받은 뒤 조작하세요",
        409,
      );
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (
          await this.request(owner, `/sessions/${encodeURIComponent(id)}/input`, value)
        ).json(),
        id,
      );
    });
  }
  async imports(owner: string, id: string) {
    return this.serial(id, () => this.importsOwned(owner, id));
  }
  private async importsOwned(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(
        await (await this.request(owner, `/sessions/${encodeURIComponent(id)}/downloads`)).json(),
      );
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.request(
        owner,
        `/sessions/${encodeURIComponent(id)}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }

  holder(id: string) {
    const current = this.holders.get(id);
    return { holder: current?.holder ?? ("agent" as BrowserHolder), reason: current?.reason ?? "" };
  }
  private assertAgentTurn(id: string) {
    if (this.holder(id).holder === "user")
      throw new AppError("사용자가 브라우저를 조작 중입니다 — 돌려받은 뒤에 다시 하세요", 409);
  }
  /** 사람이 «직접 조작»(user) 또는 «영시리에게 돌려주기»(agent) */
  async setHolder(owner: string, id: string, holder: BrowserHolder) {
    await this.get(owner, id);
    const current = this.holders.get(id);
    if (holder === "agent") {
      if (current?.returned) current.returned();
      else this.holders.delete(id);
    } else
      this.holders.set(id, {
        holder: "user",
        reason: current?.reason ?? "",
        returned: current?.returned,
      });
    return this.holder(id);
  }
  /**
   * 영시리가 사람에게 넘기고(로그인·결제·본인 확인처럼 사람이 해야 하는 일) 돌려받을 때까지 기다린다.
   * 돌려받으면 그때 화면을 읽어 돌려준다. 시간이 다 되면 "timeout" — 넘긴 채로 조용히 멈춰 있지 않는다.
   */
  async handoff(owner: string, reason: string, signal?: AbortSignal, timeoutMs = 10 * 60_000) {
    const { id } = await this.activeProfile(owner);
    await this.get(owner, id).catch(() => {
      throw new AppError(
        "넘길 브라우저가 아직 없습니다 — 먼저 browse_web 으로 페이지를 여세요",
        409,
      );
    });
    const outcome = await new Promise<"returned" | "timeout">((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.holders.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        resolve("timeout");
      }, timeoutMs);
      const onAbort = () => {
        finish();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.holders.set(id, {
        holder: "user",
        reason,
        returned: () => {
          finish();
          resolve("returned");
        },
      });
    });
    const page = await this.read(owner, id);
    return { outcome, sessionId: id, ...page, text: page.text.slice(0, 30_000) };
  }
  async activeProfile(owner: string): Promise<BrowserProfile> {
    const pref =
      (await this.db.get<ProfilePref>(owner, "browser-prefs", "active")) ??
      (await this.db.insertIfAbsent(owner, "browser-prefs", {
        id: "active",
        profileId: randomUUID(),
      })) ??
      (await this.db.get<ProfilePref>(owner, "browser-prefs", "active"));
    if (!pref) throw new AppError("브라우저 프로필을 정하지 못했습니다", 500);
    const fresh = {
      id: pref.profileId,
      name: DEFAULT_PROFILE_NAME,
      createdAt: new Date().toISOString(),
    };
    const profile =
      (await this.db.get<BrowserProfile>(owner, "browser-profiles", pref.profileId)) ??
      (await this.db.insertIfAbsent(owner, "browser-profiles", fresh)) ??
      (await this.db.get<BrowserProfile>(owner, "browser-profiles", pref.profileId));
    if (!profile) throw new AppError("브라우저 프로필을 정하지 못했습니다", 500);
    return profile;
  }
  async profiles(owner: string) {
    const active = await this.activeProfile(owner);
    const profiles = (await this.db.list<BrowserProfile>(owner, "browser-profiles")).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const session = await this.db.get<BrowserSession>(owner, "browsers", active.id);
    return {
      profiles,
      active: active.id,
      session: session ? { ...this.decorate(owner, session), ...this.holder(active.id) } : null,
    };
  }
  async createProfile(owner: string, name: string) {
    const list = await this.db.list<BrowserProfile>(owner, "browser-profiles");
    if (list.length >= PROFILES_MAX)
      throw new AppError(`브라우저 프로필은 ${PROFILES_MAX}개까지입니다`, 409);
    const profile = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    await this.db.put(owner, "browser-profiles", profile);
    return profile;
  }
  async useProfile(owner: string, id: string) {
    assertSessionId(id);
    if (!(await this.db.get(owner, "browser-profiles", id)))
      throw new AppError("브라우저 프로필이 없습니다", 404);
    await this.db.put(owner, "browser-prefs", { id: "active", profileId: id });
    return this.profiles(owner);
  }
}
