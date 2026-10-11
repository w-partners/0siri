// app.json 위에 푸시(FCM) 설정만 얹는다. google-services.json 은 git 밖(.gitignore) — 마스터의 Firebase 콘솔에서 받는다.
// 파일이 없으면 `expo prebuild` 를 멈춘다: 빠진 채로 APK 가 나가면 빌드는 되고 푸시만 조용히 죽는다(tplanner 회신 PUSH-20261012-01 함정 1).
// 푸시 없이 일부러 만들 때만 OSIRI_PUSH_OFF=1 — 그때도 경고를 남긴다. 웹 export 는 이 파일과 무관하게 지나간다.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

module.exports = ({ config }) => {
  if (existsSync(join(__dirname, "google-services.json")))
    return {
      ...config,
      android: { ...config.android, googleServicesFile: "./google-services.json" },
    };
  if (process.argv.includes("prebuild")) {
    if (process.env.OSIRI_PUSH_OFF !== "1")
      throw new Error(
        "apps/mobile/google-services.json 이 없습니다 — 이대로면 푸시가 안 되는 APK 가 나갑니다. Firebase 콘솔에서 받아 넣거나, 푸시 없이 만들 거면 OSIRI_PUSH_OFF=1",
      );
    console.warn("[0Siri] OSIRI_PUSH_OFF=1 — 푸시 없는 APK 를 만듭니다(알림이 오지 않습니다)");
  }
  return config;
};
