#!/bin/sh
# Docker 기본 seccomp 은 user namespace 를 막아 비root 여도 Chrome 샌드박스가 못 뜬다(실측 «No usable sandbox!»).
# 엔진 코드는 손대지 않고 여기서 --no-sandbox 를 붙인다 — 격리는 컨테이너(cap-drop ALL · no-new-privileges · 사람별 볼륨)가 맡는다.
exec /ms-playwright/chromium-1234/chrome-linux64/chrome --no-sandbox "$@"
