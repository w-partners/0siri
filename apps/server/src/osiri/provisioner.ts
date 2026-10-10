// 팀 런타임 프로비저너 (0SIRI-SPEC §15.3 · §22-8). `system/worker-provisioning` 큐를 비우며
// 팀 구독 1건 = 서버 안 팀 루프 1개를 띄운다. 팀마다 컨테이너를 만들지 않는다 — 한 사람 = 컨테이너 1개
// (그 사람 구독 컨테이너·PC 안에서 역할마다 ACP 세션, 공용키면 게이트웨이). 팀 정의는 서버를 떠나지 않는다.
import { RETENTION_DAYS } from "../../../../packages/domain/src/osiri.ts";
import type { DockerRunner } from "../computer.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Room, Rooms } from "./rooms.ts";
import type { Catalog, Provisioning } from "./store.ts";
import { tickInterval } from "./team-runtime.ts";

export interface Worker {
  id: string; // = roomId (방 하나에 워커 하나)
  userId: string;
  packageId: string;
  startedAt: string;
  /** 옛 방식(팀마다 컨테이너)의 컨테이너 — 해지 때 지운다 */
  containerId?: string;
}
/** 방 하나의 팀 루프가 부르는 것 */
export interface TeamLoop {
  tick(): Promise<string>;
  weeklyReport(): Promise<unknown>;
  close(): Promise<void>;
}

export interface ProvisionerOptions {
  /** 방 하나의 팀 런타임(워커 토큰·모델 선택 포함)을 만든다 — app 이 room-routes `teamRuntime` 으로 준다 */
  runtime: (owner: string, roomId: string, packageId: string) => Promise<TeamLoop>;
  /** 옛 팀 컨테이너 정리용. 없으면 컨테이너 기록은 건드리지 않는다 */
  docker?: DockerRunner;
  intervalMs?: number;
  /** 팀 tick 간격. 없으면 TEAM_INTERVAL_MS(기본 10분) */
  tickMs?: number;
  log?: (line: string) => void;
}

export class Provisioner {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private readonly loops = new Map<string, { timer: NodeJS.Timeout; close: () => Promise<void> }>();
  constructor(
    private readonly db: Store,
    private readonly rooms: Rooms,
    private readonly catalog: Catalog,
    private readonly options: ProvisionerOptions,
  ) {}

  start() {
    const tick = () => void this.drainOnce().catch((e) => this.log(`drain failed: ${e.message}`));
    // 서버가 다시 떴다 — 기록된 팀 루프를 다시 띄운다(구독 세션은 저장된 세션 ID 로 이어진다)
    void this.resume();
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const id of [...this.loops.keys()]) void this.halt(id);
  }
  async resume() {
    for (const { value: worker } of await this.db.scan<Worker>("workers"))
      await this.run(worker).catch((e: Error) =>
        this.log(`resume failed room=${worker.id}: ${e.message}`),
      );
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
    const worker: Worker = {
      id: job.roomId,
      userId: job.userId,
      packageId: job.packageId,
      startedAt: new Date().toISOString(),
    };
    await this.run(worker);
    await this.db.put("system", "workers", worker);
    await this.rooms.activity(job.userId, {
      roomId: job.roomId,
      kind: "system",
      actor: "provisioner",
      title: "팀이 일을 시작했습니다",
      detail: `${pkg.name} · 내 구독을 켜 두었으면 내 구독으로, 아니면 공용키로 일합니다`,
    });
    this.log(`started room=${job.roomId}`);
  }

  /** 방 하나의 팀 루프를 띄운다(이미 돌고 있으면 그대로). 서버가 다시 뜨면 start() 가 기록된 워커를 전부 다시 띄운다 */
  private async run(worker: Worker) {
    if (this.loops.has(worker.id)) return;
    const runtime = await this.options.runtime(worker.userId, worker.id, worker.packageId);
    const every = this.options.tickMs ?? tickInterval();
    const weeklyEvery = Math.max(1, Math.round((7 * 24 * 3600 * 1000) / every));
    let ticks = 0;
    let busy = false;
    const tick = async () => {
      if (busy) return; // ponytail: 방마다 한 번에 tick 하나
      busy = true;
      try {
        const result = await runtime.tick();
        this.log(`tick room=${worker.id}: ${result}`);
        if (++ticks % weeklyEvery === 0) await runtime.weeklyReport();
      } catch (error) {
        this.log(`tick failed room=${worker.id}: ${(error as Error).message}`);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), every);
    timer.unref?.();
    this.loops.set(worker.id, { timer, close: runtime.close });
    void tick();
  }
  private async halt(roomId: string) {
    const loop = this.loops.get(roomId);
    if (!loop) return;
    clearInterval(loop.timer);
    this.loops.delete(roomId);
    await loop.close().catch((e: Error) => this.log(`close failed room=${roomId}: ${e.message}`));
  }

  /** 해지(archived)된 방의 워커를 내린다. 컨테이너는 지우고 기록은 남긴다. */
  private async reapArchived() {
    let stopped = 0;
    for (const { value: worker } of await this.db.scan<Worker>("workers")) {
      let room: Pick<Room, "archived">;
      try {
        // 해지 예약의 기간 말이 지났으면 여기서 구독을 닫고 방을 잠근다 — 사용자가 앱을 열지 않아도 워커가 내려가게
        await this.catalog.mine(worker.userId);
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
      await this.halt(worker.id);
      // 옛 방식(팀마다 컨테이너)으로 띄운 워커가 남아 있으면 그 컨테이너도 지운다
      if (worker.containerId && this.options.docker) {
        const rm = await this.options.docker(["rm", "-f", worker.containerId], {
          timeoutMs: 60_000,
        });
        if (rm.exitCode !== 0 && !/No such container/i.test(rm.stderr)) {
          this.log(`rm failed ${worker.containerId.slice(0, 12)}: ${rm.stderr.trim()}`);
          continue;
        }
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
