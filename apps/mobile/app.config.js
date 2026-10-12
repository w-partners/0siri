// app.json 위에 푸시(FCM) 설정과 배포 갈래(play/직접 배포)를 얹는다. google-services.json 은 git 밖(.gitignore) — 마스터의 Firebase 콘솔에서 받는다.
// 파일이 없으면 `expo prebuild` 를 멈춘다: 빠진 채로 APK 가 나가면 빌드는 되고 푸시만 조용히 죽는다(tplanner 회신 PUSH-20261012-01 함정 1).
// 푸시 없이 일부러 만들 때만 OSIRI_PUSH_OFF=1 — 그때도 경고를 남긴다. 웹 export 는 이 파일과 무관하게 지나간다.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Play 판(EXPO_PUBLIC_OSIRI_CHANNEL=play): Play 밖 자기 업데이트 금지 정책 → 설치 권한을 빼고(앱의 업데이트 배너도 같은 값으로 꺼진다),
// 평문 통신도 끈다(평문은 도메인이 없던 때 tailnet IP 로 붙으려고 켠 것 — DECISIONS 2026-10-09).
const play = process.env.EXPO_PUBLIC_OSIRI_CHANNEL === "play";
const INSTALL = "android.permission.REQUEST_INSTALL_PACKAGES";

// 버전마다 오르는 versionCode — 0.63.1 → 6301 (minor·patch 는 99 까지)
const versionCode = (version) => {
  const [major, minor, patch] = version.split(".").map(Number);
  if (minor > 99 || patch > 99) throw new Error(`versionCode 규칙(minor·patch ≤ 99)을 넘었습니다: ${version}`);
  return major * 10000 + minor * 100 + patch;
};

const channel = (config) => ({
  ...config,
  android: {
    ...config.android,
    versionCode: versionCode(config.version),
    ...(play && {
      permissions: (config.android.permissions ?? []).filter((p) => p !== INSTALL),
      blockedPermissions: [INSTALL],
    }),
  },
  plugins: play
    ? config.plugins.map((p) =>
        Array.isArray(p) && p[0] === "expo-build-properties"
          ? [p[0], { ...p[1], android: { ...p[1].android, usesCleartextTraffic: false } }]
          : p,
      )
    : config.plugins,
});

module.exports = ({ config }) => {
  if (existsSync(join(__dirname, "google-services.json")))
    return channel({
      ...config,
      android: { ...config.android, googleServicesFile: "./google-services.json" },
    });
  if (process.argv.includes("prebuild")) {
    if (process.env.OSIRI_PUSH_OFF !== "1")
      throw new Error(
        "apps/mobile/google-services.json 이 없습니다 — 이대로면 푸시가 안 되는 APK 가 나갑니다. Firebase 콘솔에서 받아 넣거나, 푸시 없이 만들 거면 OSIRI_PUSH_OFF=1",
      );
    console.warn("[0Siri] OSIRI_PUSH_OFF=1 — 푸시 없는 APK 를 만듭니다(알림이 오지 않습니다)");
  }
  return channel(config);
};
