#!/bin/sh
# Xvfb 가상 화면 → (사람이 볼 화면) x11vnc+noVNC → Chrome(launch.js) → W브라우저 엔진(포그라운드)
set -e
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
# ponytail: VNC 비밀번호 없음 — 컨테이너 안 localhost 만 듣고, noVNC 포트는 호스트 127.0.0.1 에만 묶는다(0Siri 서버가 인증 후 중계)
x11vnc -display :99 -localhost -nopw -forever -shared -quiet &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 &
mkdir -p "$WBROWSER_PROFILE_DIR" "$WBROWSER_STATE_DIR"
cd /opt/wbrowser
node launch.js
exec node engine.js
