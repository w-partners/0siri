// 팀 런타임 컨테이너 진입점 (0SIRI-SPEC §15.3). 환경변수는 서버가 주입한다 — 이미지·로그에 시크릿을 남기지 않는다.
//   OSIRI_API_URL=http://host:8787  OSIRI_WORKER_TOKEN=…  TEAM_YAML=teams/legal-marketing.yaml
//   OPENAI_BASE_URL / OPENAI_API_KEY / MODEL_TIER2|3|4   TEAM_INTERVAL_MS=600000   OSIRI_PUBLISH=<serverId>:<tool>
import { required } from "../config.ts";
import { gatewayLlm, loadTeam, TeamRuntime } from "./team-runtime.ts";

const apiUrl = `${required("OSIRI_API_URL", "OSIRI_API_URL 이 필요합니다")}/api/worker`;
const runtime = new TeamRuntime({
  apiUrl,
  workerToken: required("OSIRI_WORKER_TOKEN", "OSIRI_WORKER_TOKEN 이 필요합니다"),
  team: await loadTeam(required("TEAM_YAML", "TEAM_YAML 이 필요합니다")),
  llm: gatewayLlm(),
  maxPolls: 20,
  pollIntervalMs: 30_000,
});
const publish = process.env.OSIRI_PUBLISH?.split(":");
const publishTool =
  publish?.length === 2
    ? { serverId: publish[0] as string, tool: publish[1] as string }
    : undefined;
const interval = Number(process.env.TEAM_INTERVAL_MS ?? 600_000);
let ticks = 0;
for (;;) {
  try {
    const result = await runtime.tick(publishTool);
    console.log(`[team] tick ${++ticks}: ${result}`);
    if (ticks % Math.max(1, Math.round((7 * 24 * 3600 * 1000) / interval)) === 0)
      await runtime.weeklyReport(0);
  } catch (error) {
    console.error(`[team] tick failed: ${(error as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, interval));
}
