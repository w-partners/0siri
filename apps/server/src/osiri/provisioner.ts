// 팀 런타임 프로비저너 (0SIRI-SPEC §15.3 · §22-8). `system/worker-provisioning` 큐를 비우며
// 구독 1건 = 컨테이너 1개를 `docker run` 한다. 시크릿(워커 토큰·모델 키)은 인자가 아니라
// 0600 임시 env-file 로 넘기고 즉시 지운다 — `ps` 에 남지 않는다.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETENTION_DAYS } from "../../../../packages/domain/src/osiri.ts";
import type { DockerRunner } from "../computer.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { issueWorkerToken } from "./room-routes.ts";
import type { Room, Rooms } from "./rooms.ts";
import type { Catalog, Provisioning } from "./store.ts";

export interface Worker {
  id: string; // = roomId (방 하나에 워커 하나)
  containerId: string;
  userId: string;
  packageId: string;
  image: string;
  startedAt: string;
}

export interface ProvisionerOptions {
  docker: DockerRunner;
  /** 컨테이너가 서버를 부를 주소. host 네트워크라 publicUrl 그대로 */
  apiUrl: string;
  /** REGISTRY_URL — 있으면 `<registry>/<image>` */
  registryUrl?: string;
  /** 컨테이너로 그대로 넘기는 모델 환경변수(OPENAI_BASE_URL·키·MODEL_TIER*) */
  modelEnv: Record<string, string>;
  intervalMs?: number;
  log?: (line: string) => void;
}

export class Provisioner {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly catalog: Catalog,
    private readonly options: ProvisionerOptions,
  ) {}

  start() {
    const tick = () => void this.drainOnce().catch((e) => this.log(`drain failed: ${e.message}`));
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 큐 처리 + 해지된 방의 컨테이너 정리. 처리한 건수를 돌려준다. */
  async drainOnce(): Promise<{ started: number; failed: number; stopped: number }> {
    if (this.draining) return { started: 0, failed: 0, stopped: 0 }; // ponytail: 단일 프로세스 재진입 방지
    this.draining = true;
    const result = { started: 0, failed: 0, stopped: 0 };
    try {
      for (const { value: job } of await this.db.scan<Provisioning>("worker-provisioning")) {
        if (job.status !== "queued") continue;
        const claimed = await this.db.compareAndSwap<Provisioning>(
          "system",
          "worker-provisioning",
          job.id,
          { status: "queued" },
          { status: "running" },
        );
        if (!claimed) continue;
        try {
          await this.launch(claimed);
          await this.db.take("system", "worker-provisioning", job.id);
          result.started++;
        } catch (error) {
          const message = (error as Error).message;
          await this.db.put("system", "worker-provisioning", {
            ...claimed,
            status: "failed",
            error: message,
            failedAt: new Date().toISOString(),
          });
          await this.rooms.activity(job.userId, {
            roomId: job.roomId,
            kind: "error",
            actor: "provisioner",
            title: "팀 준비에 실패했습니다",
            detail: message,
          });
          this.log(`launch failed room=${job.roomId}: ${message}`);
          result.failed++;
        }
      }
      result.stopped = await this.reapArchived();
    } finally {
      this.draining = false;
    }
    return result;
  }

  private async launch(job: Provisioning) {
    const pkg = await this.catalog.packageById(job.packageId);
    const image = this.options.registryUrl
      ? `${this.options.registryUrl.replace(/\/$/, "")}/${pkg.runtime.image}`
      : pkg.runtime.image;
    const token = await issueWorkerToken(this.db, job.userId, job.roomId, job.packageId);
    const env = {
      ...this.options.modelEnv,
      OSIRI_API_URL: this.options.apiUrl,
      OSIRI_WORKER_TOKEN: token,
      OSIRI_USER_ID: job.userId,
      OSIRI_PACKAGE_ID: job.packageId,
      OSIRI_ROOM_ID: job.roomId,
      TEAM_YAML: pkg.runtime.teamYaml,
    };
    const dir = await mkdtemp(join(tmpdir(), "osiri-env-"));
    const envFile = join(dir, "env");
    try {
      await writeFile(
        envFile,
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
        { mode: 0o600 },
      );
      const name = `osiri-team-${job.roomId.slice(0, 8)}-${randomUUID().slice(0, 4)}`;
      // ponytail: host 네트워크 — 파일럿은 게이트웨이·서버가 같은 호스트다. 격리하려면 bridge + host.docker.internal
      const run = await this.options.docker(
        [
          "run",
          "-d",
          "--name",
          name,
          "--restart",
          "unless-stopped",
          "--network",
          "host",
          "--label",
          `osiri.room=${job.roomId}`,
          "--label",
          `osiri.user=${job.userId}`,
          "--env-file",
          envFile,
          image,
        ],
        { timeoutMs: 120_000 },
      );
      if (run.exitCode !== 0)
        throw new Error(
          `docker run 실패(${run.exitCode}): ${run.stderr.trim() || run.stdout.trim()}`,
        );
      const worker: Worker = {
        id: job.roomId,
        containerId: run.stdout.trim(),
        userId: job.userId,
        packageId: job.packageId,
        image,
        startedAt: new Date().toISOString(),
      };
      await this.db.put("system", "workers", worker);
      await this.rooms.activity(job.userId, {
        roomId: job.roomId,
        kind: "system",
        actor: "provisioner",
        title: "팀이 일을 시작했습니다",
        detail: `${pkg.name} · ${image}`,
      });
      this.log(`started ${name} (${worker.containerId.slice(0, 12)}) room=${job.roomId}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 해지(archived)된 방의 워커를 내린다. 컨테이너는 지우고 기록은 남긴다. */
  private async reapArchived() {
    let stopped = 0;
    for (const { value: worker } of await this.db.scan<Worker>("workers")) {
      let room: Pick<Room, "archived">;
      try {
        room = await this.rooms.get(worker.userId, worker.id);
      } catch (error) {
        // 방이 정말 없을 때(404)만 워커를 내린다. DB 오류 같은 다른 실패로 컨테이너를 지우지 않는다
        if (!(error instanceof AppError && error.status === 404)) {
          this.log(`room lookup failed room=${worker.id}: ${(error as Error).message} — 워커 유지`);
          continue;
        }
        room = { archived: true };
      }
      if (!room.archived) continue;
      const rm = await this.options.docker(["rm", "-f", worker.containerId], {
        timeoutMs: 60_000,
      });
      if (rm.exitCode !== 0 && !/No such container/i.test(rm.stderr)) {
        this.log(`rm failed ${worker.containerId.slice(0, 12)}: ${rm.stderr.trim()}`);
        continue;
      }
      await this.db.take("system", "workers", worker.id);
      await this.rooms.activity(worker.userId, {
        roomId: worker.id,
        kind: "system",
        actor: "provisioner",
        title: "팀 워커를 종료했습니다",
        detail: `구독 해지 — 방은 읽기 전용으로 ${RETENTION_DAYS}일 보존`,
      });
      stopped++;
    }
    return stopped;
  }

  private log(line: string) {
    (this.options.log ?? ((l) => console.log(`[provisioner] ${l}`)))(line);
  }
}

/** 컨테이너로 넘길 모델 환경변수만 고른다 — 서버 전체 env 를 흘리지 않는다 */
export function modelEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_CHAT_COMPLETIONS",
    "MODEL",
    "MODEL_TIER2",
    "MODEL_TIER3",
    "MODEL_TIER4",
    "TEAM_INTERVAL_MS",
  ])
    if (env[key]) out[key] = env[key];
  return out;
}
