import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runDocker } from "./computer.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { warmUp } from "./osiri/embeddings.ts";
import { modelEnvFrom, Provisioner } from "./osiri/provisioner.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent, osiri } = await createApp(db, config);
// 작업 워커와 함께 피드 관심 프롬프트도 주기적으로 돈다 (자동화 화면의 크론)
if (config.taskWorkerEnabled) {
  agent.start();
  osiri.feed.start();
}
const provisioner = new Provisioner(db, osiri.rooms, osiri.catalog, {
  docker: runDocker,
  apiUrl: config.publicUrl,
  registryUrl: config.registryUrl,
  modelEnv: modelEnvFrom(process.env),
});
if (config.teamProvisionerEnabled) provisioner.start();
else
  console.log(
    "[osiri] 팀 프로비저너 꺼짐 (TEAM_PROVISIONER_ENABLED=false) — 구독해도 팀 워커 컨테이너가 뜨지 않고 큐에만 쌓입니다",
  );
// 탈퇴 요청 후 보존 기간이 지난 계정을 지운다 (기동 직후 한 번 + 주기적으로). 지운 내용은 로그와 system 감사 로그에 남는다
osiri.accounts.startPurgeSweep({
  memories: osiri.memories,
  audit: (owner, input) => osiri.rooms.audit(owner, input),
});
// 임베딩 모델을 미리 올리고(첫 검색 지연 방지), 옛 기억 저장소(records)를 pgvector 로 옮긴다. 기동은 막지 않는다
void warmUp()
  .then(() => osiri.memories.migrateLegacy())
  .then(({ found, migrated, skipped }) =>
    console.log(
      `[osiri] 임베딩 준비 완료 · 옛 기억 이관: 발견 ${found} · 이번에 옮김 ${migrated} · 건너뜀 ${skipped}`,
    ),
  )
  .catch((error) =>
    console.error(
      `[osiri] 임베딩 준비/옛 기억 이관 실패 — 기억 검색이 동작하지 않을 수 있습니다: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(
    `OpenMuse ${config.mode} API ready at ${config.publicUrl}` +
      (config.webDist ? ` · web UI from ${config.webDist}` : " · web UI 없음 (WEB_DIST 미설정)"),
  ),
);
// 본인 PC 구독 러너가 바깥에서 접속하는 웹소켓 (/api/subscription/runner)
osiri.subscriptions.attach(server as import("node:http").Server);
const shutdown = () => {
  server.close(() => {
    provisioner.stop();
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
  // 열린 SSE(/api/stream)가 있으면 close 콜백이 영영 안 불려 systemd 가 SIGKILL 까지 기다린다.
  if ("closeAllConnections" in server) server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
