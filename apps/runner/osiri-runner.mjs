#!/usr/bin/env node
// 0Siri 구독 러너 — 내 PC 의 ChatGPT·Claude 구독으로 영시리가 답하게 한다.
// 이 PC 가 0Siri 서버로 «바깥으로» 접속한다(열리는 포트 없음). 서버가 대화 한 턴을 보내면
// 이 PC 에서 ACP 어댑터를 띄워 그대로 이어 준다(대화방·팀 역할마다 세션이 이어진다). 로그인 정보는 이 PC 밖으로 나가지 않는다.
//
// 설치는 보통 설치 스크립트가 다 한다(Node·CLI·로그인·실행 파일): 앱 설정 › 연결 › 모델 계정 › 내 PC 에서 OS 별 한 줄 복사
//   macOS·Ubuntu → install-runner.sh   Windows → install-runner.ps1
// 직접 실행: node osiri-runner.mjs <서버주소> <열쇠>   (Node 22 이상, codex·claude CLI 로그인 필요)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const [server, key] = process.argv.slice(2);
if (!server || !key) {
  console.error(
    "사용법: node osiri-runner.mjs <서버주소> <열쇠>  — 앱 설정 › 모델 사용 › 내 PC 에서 복사하세요",
  );
  process.exit(2);
}
if (typeof WebSocket !== "function") {
  console.error(`Node 22 이상이 필요합니다 (지금 ${process.version})`);
  process.exit(2);
}
const ADAPTER = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
};
const url = server.replace(/^http/, "ws").replace(/\/$/, "") + "/api/subscription/runner";
const win = process.platform === "win32";
let wait = 1000;

function connect() {
  const ws = new WebSocket(url);
  const children = new Map();
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  ws.onopen = () => send({ t: "hello", key, cwd: process.cwd() });
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.t === "ready") {
      wait = 1000;
      console.log(
        `[0Siri] 연결됨 — 이 창을 열어 두면 영시리가 이 PC 의 구독으로 답합니다 (작업 폴더 ${process.cwd()})`,
      );
    } else if (msg.t === "open") {
      const pkg = ADAPTER[msg.provider];
      if (!pkg) return send({ t: "exit", id: msg.id, error: `모르는 구독: ${msg.provider}` });
      // npx 가 어댑터를 처음 한 번 내려받는다. 로그인은 이 PC 의 CLI 로그인을 그대로 쓴다
      const child = spawn(win ? "npx.cmd" : "npx", ["-y", pkg], {
        stdio: ["pipe", "pipe", "inherit"],
        shell: win,
      });
      children.set(msg.id, child);
      child.stdout.on("data", (d) => send({ t: "data", id: msg.id, d: String(d) }));
      child.on("error", (e) => send({ t: "exit", id: msg.id, error: e.message }));
      child.on("exit", (code) => {
        children.delete(msg.id);
        send({
          t: "exit",
          id: msg.id,
          ...(code ? { error: `어댑터가 코드 ${code} 로 끝났습니다` } : {}),
        });
      });
      console.log(`[0Siri] 대화 한 턴 시작 (${msg.provider})`);
    } else if (msg.t === "mkdir") {
      // 팀 작업 폴더(teams/<팀>) — 이 폴더 밖은 만들지 않는다
      const rel = relative(process.cwd(), resolve(process.cwd(), String(msg.path)));
      // 윈도우는 다른 드라이브(D:\…)면 relative 가 절대 경로를 돌려준다 — 그것도 밖이다
      if (rel && !rel.startsWith("..") && !isAbsolute(rel))
        mkdirSync(resolve(process.cwd(), rel), { recursive: true });
    } else if (msg.t === "data") {
      children.get(msg.id)?.stdin.write(msg.d);
    } else if (msg.t === "close") {
      children.get(msg.id)?.kill();
    }
  };
  let retried = false;
  const retry = (why) => {
    if (retried) return;
    retried = true;
    for (const child of children.values()) child.kill();
    console.error(`[0Siri] 연결이 끊겼습니다 (${why}) — ${wait / 1000}초 뒤 다시 붙습니다`);
    setTimeout(connect, wait);
    wait = Math.min(wait * 2, 60_000);
  };
  ws.onclose = (event) => {
    if (event.code === 4003 || event.code === 4001) {
      // 서버 사유에는 안내 문장까지 들어 있다 — 사유가 없을 때만 붙인다
      console.error(
        `[0Siri] ${event.reason || "열쇠가 맞지 않습니다 — 앱에서 새 명령을 받아 다시 실행하세요"}`,
      );
      process.exit(1);
    }
    retry(event.code);
  };
  // Node 22 WebSocket 은 접속 자체가 실패하면 close 없이 error 만 낸다 — 거기서도 다시 붙는다
  ws.onerror = () => retry("접속 실패");
}
connect();
