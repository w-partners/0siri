import { createWorkerServer } from "./server.ts";

const token = process.env.WORKER_TOKEN ?? "";
const worker = await createWorkerServer({
  token,
  dataDir: process.env.WORKER_DATA_DIR ?? ".openmuse/browser-profiles",
  maxSessions: 3,
  idleTimeoutMs: 30 * 60_000,
});
// 0Siri: seoul 은 8790 을 tailnet 주소에서 다른 것이 쓰고 있어 포트를 env 로 받는다
const port = Number(process.env.WORKER_PORT ?? 8790);
worker.server.listen(port, process.env.WORKER_HOST ?? "127.0.0.1", () => {
  console.log(`OpenMuse browser worker listening on port ${port}`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
