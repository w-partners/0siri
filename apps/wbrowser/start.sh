#!/bin/sh
# Xvfb 가상 화면 → 0Siri 워커(egress 프록시 먼저) → Chrome(launch.js) → W브라우저 엔진. 워커가 죽으면 컨테이너도 끝난다.
set -e
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
# ponytail: VNC 비밀번호 없음 — 컨테이너 안 localhost 만 듣고 noVNC 포트는 publish 하지 않는다. 사람 조작은 0Siri 콘솔(스크린샷+입력)로 한다
x11vnc -display :99 -localhost -nopw -forever -shared -quiet &
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
mkdir -p "$WBROWSER_PROFILE_DIR" "$WBROWSER_STATE_DIR"
cd /app
node --experimental-strip-types src/index.ts &
WORKER=$!
for _ in $(seq 1 50); do curl -sf -o /dev/null 127.0.0.1:8790/health && break; sleep 0.2; done
cd /opt/wbrowser
node launch.js
node engine.js &
wait $WORKER
