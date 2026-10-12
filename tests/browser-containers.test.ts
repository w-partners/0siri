// 사람마다 브라우저 컨테이너 하나 (마스터 2026-10-12) — 이름·볼륨·토큰이 사람마다 다르고, 오래 안 쓰면 지운다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserContainers } from "../apps/server/src/browser-containers.ts";
import type { DockerRunner } from "../apps/server/src/computer.ts";

test("사람별 컨테이너 — 이름·볼륨·토큰이 다르고, 떠 있으면 다시 띄우지 않고, 유휴면 지운다", async (t) => {
  const health = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", r));
  const port = (health.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "osiri-browsers-"));
  t.after(async () => {
    health.close();
    await rm(dir, { recursive: true, force: true });
  });
  const running = new Set<string>();
  const runs: string[][] = [];
  const removed: string[] = [];
  const base = { timedOut: false, interrupted: false, truncated: false };
  const ok = (stdout = "") => ({ ...base, exitCode: 0, stdout, stderr: "" });
  const docker: DockerRunner = async (args) => {
    const [cmd] = args;
    const name = args.at(-1) as string;
    if (cmd === "inspect")
      return running.has(name) ? ok("true") : { ...base, exitCode: 1, stdout: "", stderr: "no" };
    if (cmd === "run") {
      runs.push(args);
      running.add(args[args.indexOf("--name") + 1] as string);
      return ok("id");
    }
    if (cmd === "port") return ok(`127.0.0.1:${port}`);
    if (cmd === "ps") return ok([...running].join("\n"));
    if (cmd === "rm") {
      removed.push(name);
      running.delete(name);
      return ok();
    }
    return ok();
  };
  const c = new BrowserContainers({
    image: "osiri/browser",
    dir,
    secret: "s".repeat(40),
    docker,
    reapEveryMs: 0,
  });

  const a = await c.endpoint("alice");
  const b = await c.endpoint("bob");
  assert.equal(a.url, `http://127.0.0.1:${port}`);
  assert.notEqual(a.token, b.token, "토큰이 사람마다 다르다");
  assert.equal(runs.length, 2);
  const [ra, rb] = runs as [string[], string[]];
  const vol = (r: string[]) => r[r.indexOf("-v") + 1];
  assert.notEqual(vol(ra), vol(rb), "볼륨이 사람마다 다르다");
  assert.notEqual(c.name("alice"), c.name("bob"));
  assert.ok(ra.includes("--cap-drop") && ra.includes("no-new-privileges"));
  assert.ok(ra.includes("127.0.0.1::8790"), "호스트 루프백에만 연다");
  assert.ok(!ra.some((x) => x.includes("docker.sock")), "docker 소켓을 넣지 않는다");

  await c.endpoint("alice");
  assert.equal(runs.length, 2, "떠 있으면 다시 띄우지 않는다");

  assert.equal(await c.reap(Date.now() + 2 * 3600_000), 2);
  assert.deepEqual(removed.sort(), [c.name("alice"), c.name("bob")].sort());
});
