# 사람마다 하나씩 뜨는 W브라우저 컨테이너 (마스터 2026-10-12 «W브라우저는 사용자만의 도커 안에서»)
# 엔진은 공개 저장소(w-partners/Wbrowser, MIT)를 태그로 고정해 받는다 — 코드는 손대지 않는다(wbrowser-primary 담당).
# 로그인은 /data(사람별 볼륨)에만 남는다. 엔진·CDP 는 컨테이너 안 127.0.0.1 그대로.
# 0Siri 워커(apps/worker)가 같은 Chrome 에 CDP 로 붙어 워커 계약(/sessions …)을 그대로 말한다 → 서버 BrowserContainers 는 이미지만 바꾸면 된다.
# 빌드: docker build -f apps/wbrowser/Dockerfile -t osiri/wbrowser:latest apps
FROM mcr.microsoft.com/playwright:v1.62.1-noble
ARG WBROWSER_REF=v0.32.1
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk x11vnc novnc websockify git \
 && rm -rf /var/lib/apt/lists/* \
 && git clone -q --depth 1 --branch "$WBROWSER_REF" https://github.com/w-partners/Wbrowser /opt/wbrowser \
 && cd /opt/wbrowser && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir /data && chown pwuser:pwuser /data && mkdir -m 1777 -p /tmp/.X11-unix
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY worker/src ./src
COPY wbrowser/start.sh wbrowser/chrome.sh /opt/
# 🔴 비root — 서버는 --user 로 자기 uid 를 넘긴다. 창 모드 Chrome 은 root 면 죽는다(wbrowser-primary 2차 회신 ①)
USER pwuser
ENV NODE_ENV=production \
    DISPLAY=:99 \
    WBROWSER_CHROME=/opt/chrome.sh \
    WBROWSER_PROFILE_DIR=/data/profile \
    WBROWSER_STATE_DIR=/data/state \
    WBROWSER_NO_PROFILE_SEED=1 \
    WBROWSER_HEADLESS=0 \
    WORKER_DATA_DIR=/data/worker \
    WORKER_HOST=0.0.0.0 \
    WORKER_CDP_URL=http://127.0.0.1:9222 \
    WORKER_PROXY_PORT=8791
EXPOSE 8790
CMD ["/opt/start.sh"]
