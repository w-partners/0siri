#!/bin/sh
# Docker 기본 seccomp 은 user namespace 를 막아 비root 여도 Chrome 샌드박스가 못 뜬다(실측 «No usable sandbox!»).
# 엔진 코드는 손대지 않고 여기서 --no-sandbox 를 붙인다 — 격리는 컨테이너(cap-drop ALL · no-new-privileges · 사람별 볼륨)가 맡는다.
# 모든 바깥 연결은 워커의 egress 프록시(공개 IP 만, DNS 는 프록시가 한 번만 푼다)를 거친다 — 워커 launch 모드와 같은 플래그.
exec /ms-playwright/chromium-1234/chrome-linux64/chrome --no-sandbox \
  --proxy-server="http://127.0.0.1:${WORKER_PROXY_PORT}" --proxy-bypass-list="<-loopback>" \
  --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" \
  --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  "$@"
