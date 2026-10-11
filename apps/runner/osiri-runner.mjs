#!/usr/bin/env node
// 0Siri 구독 러너 — 내 PC 의 ChatGPT·Claude 구독으로 영시리가 답하게 한다.
// 이 PC 가 0Siri 서버로 «바깥으로» 접속한다(열리는 포트 없음). 서버가 대화 한 턴을 보내면
// 이 PC 에서 ACP 어댑터를 띄워 그대로 이어 준다(대화방·팀 역할마다 세션이 이어진다). 로그인 정보는 이 PC 밖으로 나가지 않는다.
// tmux 창 붙이기(v0.23): 방 설정에서 고른 tmux 창의 CLI(claude·codex·gemini·grok·qwen)를 그 창 폴더에서 ACP 로 띄워 같은 세션을 잇고, 파일을 그 폴더의 .0siri/inbox 로 받는다.
//
// 설치는 보통 설치 스크립트가 다 한다(Node·CLI·로그인·실행 파일): 앱 설정 › 연결 › 모델 계정 › 내 PC 에서 OS 별 한 줄 복사
//   macOS·Ubuntu → install-runner.sh   Windows → install-runner.ps1
// 직접 실행: node osiri-runner.mjs <서버주소> <열쇠>   (Node 22 이상, codex·claude CLI 로그인 필요)
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

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
const win = process.platform === "win32";
// ACP 로 띄우는 명령. claude·codex 는 어댑터(npx), 나머지는 CLI 자체의 ACP 모드.
// qwen 은 그 PC 의 qwen 설정(OPENAI_BASE_URL 등 — Ollama·vLLM)을 그대로 쓴다
const ACP = {
  claude: [win ? "npx.cmd" : "npx", "-y", "@agentclientprotocol/claude-agent-acp"],
  codex: [win ? "npx.cmd" : "npx", "-y", "@agentclientprotocol/codex-acp"],
  gemini: ["gemini", "--acp"],
  grok: ["grok", "agent", "stdio"],
  qwen: ["qwen", "--acp"],
};
// tmux 창에서 도는 CLI 알아보기(창의 자식 프로세스 명령줄). 우리 ACP 어댑터는 빼고
const CLI = {
  claude: /claude(-code)?([\s/.@]|$)/,
  codex: /(^|[\s/])codex([\s/.]|$)/,
  gemini: /gemini(-cli)?([\s/.]|$)/,
  grok: /(^|[\s/])grok([\s/.]|$)/,
  qwen: /qwen(-code)?([\s/.]|$)/,
};
const MAX_FILE = 10 * 1024 * 1024;

/** 내 tmux 에서 CLI 가 도는 창들 — tmux 가 없으면 빈 목록 */
function panes() {
  let rows;
  try {
    rows = execFileSync(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_path}",
      ],
      { encoding: "utf8" },
    );
  } catch {
    return [];
  }
  const procs = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid, ppid, args }));
  const found = [];
  for (const row of rows.trim().split("\n").filter(Boolean)) {
    const [target, pid, cwd] = row.split("\t");
    // 창의 셸 아래 자손을 훑는다
    const tree = [pid];
    for (let i = 0; i < tree.length; i++)
      for (const p of procs) if (p.ppid === tree[i]) tree.push(p.pid);
    const args = procs
      .filter((p) => tree.includes(p.pid) && !/-acp\b/.test(p.args))
      .map((p) => p.args);
    const cli = Object.keys(CLI).find((name) => args.some((a) => CLI[name].test(a)));
    if (cli) found.push({ target, cli, cwd });
  }
  return found;
}

/** 서버가 고른 폴더는 지금 tmux 창의 폴더여야 한다 — 서버가 아무 폴더나 읽고 쓰지 못하게 */
function paneDir(cwd) {
  if (!panes().some((p) => p.cwd === cwd)) throw new Error("지금 tmux 창의 폴더가 아닙니다");
  return cwd;
}
/** 그 폴더 안의 경로만 */
function inside(dir, path) {
  const full = resolve(dir, String(path));
  const rel = relative(dir, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("작업 폴더 밖의 파일입니다");
  return full;
}
const OPS = {
  panes: () => panes(),
  // 영시리 → PC: <창 폴더>/.0siri/inbox/<이름>
  put: ({ cwd, name, b64 }) => {
    const bytes = Buffer.from(String(b64), "base64");
    if (bytes.length > MAX_FILE) throw new Error("10MB 를 넘는 파일입니다");
    const dir = join(paneDir(cwd), ".0siri", "inbox");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, basename(String(name)) || "file");
    writeFileSync(path, bytes);
    return { path };
  },
  // PC → 영시리: 창 폴더 안의 파일
  get: ({ cwd, path }) => {
    const full = inside(paneDir(cwd), path);
    if (statSync(full).size > MAX_FILE) throw new Error("10MB 를 넘는 파일입니다");
    return { name: basename(full), b64: readFileSync(full).toString("base64") };
  },
};
const url = server.replace(/^http/, "ws").replace(/\/$/, "") + "/api/subscription/runner";
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
      const command = ACP[msg.provider];
      if (!command) return send({ t: "exit", id: msg.id, error: `모르는 CLI: ${msg.provider}` });
      let cwd;
      try {
        // tmux 창에 붙일 때는 그 창의 폴더에서 띄운다(같은 폴더라야 그 CLI 의 세션이 보인다)
        cwd = msg.cwd ? paneDir(msg.cwd) : undefined;
      } catch (e) {
        return send({ t: "exit", id: msg.id, error: e.message });
      }
      // npx 가 어댑터를 처음 한 번 내려받는다. 로그인은 이 PC 의 CLI 로그인을 그대로 쓴다
      const child = spawn(command[0], command.slice(1), {
        stdio: ["pipe", "pipe", "inherit"],
        shell: win,
        ...(cwd ? { cwd } : {}),
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
    } else if (msg.t === "call") {
      // 묻고 답하기(tmux 창 목록·파일 주고받기)
      try {
        send({ t: "result", id: msg.id, value: OPS[msg.op](msg.args ?? {}) });
      } catch (e) {
        send({
          t: "result",
          id: msg.id,
          error: OPS[msg.op] ? e.message : `모르는 요청: ${msg.op}`,
        });
      }
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
