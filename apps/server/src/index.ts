import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runDocker } from "./computer.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
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
