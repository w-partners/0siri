# 사람마다 하나씩 뜨는 W브라우저 컨테이너 (마스터 2026-10-12 «W브라우저는 사용자만의 도커 안에서»)
# 엔진은 공개 저장소(w-partners/Wbrowser, MIT)를 태그로 고정해 받는다 — 코드는 손대지 않는다(wbrowser-primary 담당).
# 로그인은 /data(사람별 볼륨)에만 남는다. 엔진·CDP 는 컨테이너 안 127.0.0.1 그대로.
FROM mcr.microsoft.com/playwright:v1.62.1-noble
ARG WBROWSER_REF=v0.32.1
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk x11vnc novnc websockify git \
 && rm -rf /var/lib/apt/lists/* \
 && git clone -q --depth 1 --branch "$WBROWSER_REF" https://github.com/w-partners/Wbrowser /opt/wbrowser \
 && cd /opt/wbrowser && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir /data && chown pwuser:pwuser /data
COPY start.sh chrome.sh /opt/
# 🔴 비root — 창 모드 Chrome 은 root 면 샌드박스 거부로 죽는다(wbrowser-primary 2차 회신 ①)
USER pwuser
ENV DISPLAY=:99 \
    WBROWSER_CHROME=/opt/chrome.sh \
    WBROWSER_PROFILE_DIR=/data/profile \
    WBROWSER_STATE_DIR=/data/state \
    WBROWSER_NO_PROFILE_SEED=1 \
    WBROWSER_HEADLESS=0
CMD ["/opt/start.sh"]
