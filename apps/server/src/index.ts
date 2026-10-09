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
if (config.taskWorkerEnabled) agent.start();
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
const shutdown = () => {
  server.close(() => {
    provisioner.stop();
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
