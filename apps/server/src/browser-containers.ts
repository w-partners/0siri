// 사람마다 브라우저 컨테이너 하나 (마스터 2026-10-12 «사용자마다 도커를 만들어서 작동해야»).
// 그 사람의 Chromium·프로필(로그인·쿠키)은 그 사람 볼륨에만 있다 — 다른 사람 브라우저와 프로세스·디스크를 나누지 않는다.
// 컨테이너는 호스트 루프백의 임의 포트 하나만 연다(127.0.0.1:<임의>→8790). 토큰은 사람마다 다르다(HMAC).
import { createHash, createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { DockerRunner } from "./computer.ts";

export const BROWSER_CONTAINER_PORT = 8790;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export class BrowserContainers {
  /** 컨테이너 이름 → 마지막 사용 시각 (유휴 정리용) */
  private readonly used = new Map<string, number>();
  private readonly starting = new Map<string, Promise<{ url: string; token: string }>>();
  constructor(
    private readonly options: {
      image: string;
      /** 사람별 볼륨을 둘 폴더 (<DATA_DIR>/browsers) */
      dir: string;
      /** 사람별 토큰을 만드는 비밀 — WORKER_TOKEN */
      secret: string;
      docker: DockerRunner;
      idleMs?: number;
      /** 유휴 정리 주기 — 0 이면 돌지 않는다(시험용) */
      reapEveryMs?: number;
    },
  ) {
    const every = options.reapEveryMs ?? 5 * 60_000;
    if (every > 0)
      setInterval(
        () =>
          void this.reap().then(
            (n) => n && console.log(`[osiri] 브라우저 컨테이너 유휴 정리: ${n}개`),
            (error: Error) => console.error(`[osiri] 브라우저 유휴 정리 실패: ${error.message}`),
          ),
        every,
      ).unref();
  }
  name(owner: string) {
    return `osiri-br-${sha(owner).slice(0, 12)}`;
  }
  private token(owner: string) {
    return createHmac("sha256", this.options.secret).update(`browser:${owner}`).digest("hex");
  }
  private async docker(args: string[], timeoutMs = 60_000) {
    const r = await this.options.docker(args, { timeoutMs, maxOutputBytes: 200_000 });
    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() };
  }
  /** 그 사람의 워커 주소·토큰. 컨테이너가 없거나 멈췄으면 띄운다 */
  endpoint(owner: string) {
    const name = this.name(owner);
    this.used.set(name, Date.now());
    let pending = this.starting.get(name);
    if (!pending) {
      pending = this.ensure(owner, name).finally(() => this.starting.delete(name));
      this.starting.set(name, pending);
    }
    return pending;
  }
  private async port(name: string) {
    const r = await this.docker(["port", name, `${BROWSER_CONTAINER_PORT}/tcp`]);
    const port = r.ok ? r.out.match(/127\.0\.0\.1:(\d+)/)?.[1] : undefined;
    return port ? `http://127.0.0.1:${port}` : undefined;
  }
  private async ensure(owner: string, name: string) {
    const token = this.token(owner);
    const state = await this.docker(["inspect", "-f", "{{.State.Running}}", name]);
    if (state.ok && state.out === "true") {
      const url = await this.port(name);
      if (url) return { url, token };
    }
    if (state.ok) await this.docker(["rm", "-f", name]);
    const home = resolve(this.options.dir, sha(owner).slice(0, 24));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    // 격리: 권한 전부 버림·권한 상승 금지·자원 상한. docker 소켓·서버 폴더·다른 사람 볼륨 마운트 없음.
    // 사설·메타데이터 주소로의 이동은 워커가 막는다(network.ts isPublicIp)
    const run = await this.docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `osiri.user=${owner}`,
        "--label",
        "osiri.role=browser",
        "--user",
        `${uid}:${gid}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        // W브라우저 이미지(창 모드 Chrome + 엔진 + 워커)는 1g 에서 실측 897MiB 라 여유를 둔다. shm 은 Chrome 탭이 죽지 않게 1g
        "--memory",
        "1536m",
        "--shm-size",
        "1g",
        "--pids-limit",
        "512",
        "-e",
        `WORKER_TOKEN=${token}`,
        "-e",
        "HOME=/data",
        "-v",
        `${home}:/data`,
        "-p",
        `127.0.0.1::${BROWSER_CONTAINER_PORT}`,
        this.options.image,
      ],
      120_000,
    );
    if (!run.ok) throw new Error(`브라우저 컨테이너를 띄우지 못했습니다: ${run.err || run.out}`);
    const url = await this.port(name);
    if (!url) throw new Error(`브라우저 컨테이너 포트를 읽지 못했습니다: ${name}`);
    // 워커가 듣기 시작할 때까지 (Chromium 은 첫 세션 때 뜬다)
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) return { url, token };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`브라우저 컨테이너가 30초 안에 응답하지 않았습니다: ${name}`);
  }
  /** 오래 쓰지 않은 브라우저 컨테이너를 지운다(볼륨의 프로필·로그인은 남아 다음에 다시 뜬다) */
  async reap(now = Date.now()) {
    const idleMs = this.options.idleMs ?? 60 * 60_000;
    const ps = await this.docker([
      "ps",
      "--filter",
      "label=osiri.role=browser",
      "--format",
      "{{.Names}}",
    ]);
    if (!ps.ok) {
      console.error(`[osiri] 브라우저 컨테이너 목록을 읽지 못했습니다: ${ps.err}`);
      return 0;
    }
    let removed = 0;
    for (const name of ps.out.split("\n").filter(Boolean)) {
      // 서버가 다시 떴으면 기록이 없다 — 지금부터 센다
      const last = this.used.get(name);
      if (last === undefined) this.used.set(name, now);
      if (last === undefined || now - last <= idleMs) continue;
      const rm = await this.docker(["rm", "-f", name]);
      if (rm.ok) {
        this.used.delete(name);
        removed++;
      } else console.error(`[osiri] 브라우저 컨테이너를 지우지 못했습니다 ${name}: ${rm.err}`);
    }
    return removed;
  }
}
