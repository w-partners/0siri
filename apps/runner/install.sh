#!/usr/bin/env bash
# 0Siri 러너 설치 — macOS · Ubuntu(Debian 계열). 앱 설정 › 연결 › 모델 계정 › 내 PC 에서 이 줄을 복사해 터미널에 붙인다:
#   curl -fsSL <서버>/install-runner.sh | bash -s -- <서버> <열쇠> <codex|claude>
# 하는 일: Node 22 → 구독 CLI(codex·claude) → 로그인 → ~/.0siri 에 러너·실행 파일 → 이 창에서 시작.
# 열쇠는 ~/.0siri/0siri-runner(본인만 읽기)에만 남는다. 다시 설치하면 덮어쓴다.
# macOS 기본 bash 3.2 에서도 돌게 쓴다(연관 배열·${x,,} 없음).
# 전부 main() 안에 둔다 — curl|bash 는 스크립트를 표준입력으로 읽는데, apt·sudo 가 그 나머지를 삼키면
# bash 가 «끝» 으로 보고 0 으로 조용히 끝난다(ubuntu:24.04 실측). 함수로 감싸면 다 읽은 뒤에 실행한다.
set -euo pipefail
main() {

SERVER="${1:-}"
KEY="${2:-}"
PROVIDER="${3:-codex}"
WORKDIR="${4:-$HOME/0Siri}"
say() { printf '[0Siri] %s\n' "$*"; }
die() { printf '[0Siri] 멈춤: %s\n' "$*" >&2; exit 1; }

[ -n "$SERVER" ] && [ -n "$KEY" ] || die "사용법: curl -fsSL <서버>/install-runner.sh | bash -s -- <서버> <열쇠> <codex|claude> — 앱에서 줄째로 복사하세요"
case "$PROVIDER" in
  codex) PKG="@openai/codex"; CLI="codex"; LOGIN="codex login --device-auth"; STATUS="codex login status" ;;
  claude) PKG="@anthropic-ai/claude-code"; CLI="claude"; LOGIN="claude auth login"; STATUS="claude auth status" ;;
  *) die "모르는 구독: $PROVIDER (codex 또는 claude)" ;;
esac
OS="$(uname -s)"
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# ---- 1. Node 22 이상 ----
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  say "Node 22 를 설치합니다"
  if [ "$OS" = "Darwin" ]; then
    command -v brew >/dev/null 2>&1 || die "Homebrew 가 없습니다. https://nodejs.org 에서 Node 22 를 설치한 뒤 이 줄을 다시 실행하세요"
    brew install node@22
    brew link --overwrite --force node@22
  elif command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq </dev/null
    $SUDO apt-get install -y -qq ca-certificates curl </dev/null >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null
    $SUDO apt-get install -y -qq nodejs </dev/null >/dev/null
  else
    die "이 리눅스는 자동 설치를 지원하지 않습니다. https://nodejs.org 에서 Node 22 를 설치한 뒤 다시 실행하세요"
  fi
  [ "$(node_major)" -ge 22 ] || die "Node 22 설치를 확인하지 못했습니다 (지금: $(node -v 2>/dev/null || echo 없음))"
fi
say "Node $(node -v)"

# ---- 2. 구독 CLI ----
if ! command -v "$CLI" >/dev/null 2>&1; then
  say "$PKG 를 설치합니다"
  if [ -w "$(npm prefix -g)/lib" ] || [ -w "$(npm prefix -g)" ]; then npm i -g "$PKG" >/dev/null; else $SUDO npm i -g "$PKG" >/dev/null; fi
fi
command -v "$CLI" >/dev/null 2>&1 || die "$CLI 명령을 찾지 못했습니다 — npm i -g $PKG 를 확인하세요"

# ---- 3. 로그인 (curl | bash 라 표준입력이 파이프 — 터미널(/dev/tty)로 받는다) ----
LOGGED_IN=1
if ! $STATUS >/dev/null 2>&1; then
  if (exec </dev/tty) 2>/dev/null; then
    say "$CLI 로그인 — 안내대로 진행하세요"
    $LOGIN </dev/tty || die "로그인하지 못했습니다 — '$LOGIN' 을 직접 실행한 뒤 다시 설치하세요"
  else
    LOGGED_IN=0
    say "터미널이 아니라 로그인을 건너뜁니다 — 시작 전에 '$LOGIN' 을 한 번 실행하세요"
  fi
fi

# ---- 4. 러너와 실행 파일 ----
HOME_DIR="$HOME/.0siri"
mkdir -p "$HOME_DIR" "$WORKDIR"
chmod 700 "$HOME_DIR"
curl -fsSL "${SERVER%/}/osiri-runner.mjs" -o "$HOME_DIR/osiri-runner.mjs"
NODE_BIN="$(command -v node)"
umask 077
cat >"$HOME_DIR/0siri-runner" <<EOF
#!/usr/bin/env bash
# 0Siri 러너 실행 — 작업 폴더 $WORKDIR. 이 파일에 열쇠가 있으니 남에게 보내지 마세요
cd "$WORKDIR" && exec "$NODE_BIN" "$HOME_DIR/osiri-runner.mjs" "$SERVER" "$KEY"
EOF
chmod 700 "$HOME_DIR/0siri-runner"
say "설치 끝: $HOME_DIR/0siri-runner (작업 폴더 $WORKDIR)"

# ---- 5. 시작 ----
[ "$LOGGED_IN" = 1 ] || { say "로그인 뒤 실행: $HOME_DIR/0siri-runner"; exit 0; }
# 마스터(2026-10-11): 기본으로 tmux 에 붙이지 않는다 — 이 창에서 켠다. tmux 를 쓰고 싶으면 사용자가 그 안에서 실행한다
say "이 창에서 시작합니다(창을 닫으면 멈춤). 다음부터는: $HOME_DIR/0siri-runner"
exec "$HOME_DIR/0siri-runner"
}
main "$@"
