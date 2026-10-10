// onnxruntime-react-native 의 android/build.gradle 은 네이티브 런타임을 `latest.integration` 으로 끌어온다 —
// 빌드하는 날마다 다른 판이 들어올 수 있다. JS 패키지(package.json 에 고정)와 같은 판으로 묶는다.
const { withProjectBuildGradle } = require("expo/config-plugins");
const { version } = require("onnxruntime-react-native/package.json");

const TAG = "osiri-onnxruntime-version";
module.exports = (config) =>
  withProjectBuildGradle(config, (gradle) => {
    if (gradle.modResults.language !== "groovy")
      throw new Error(
        "onnxruntime 판을 고정하지 못했습니다 — android/build.gradle 이 groovy 가 아닙니다",
      );
    const block = `
// ${TAG}
allprojects {
  configurations.all {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == "com.microsoft.onnxruntime") details.useVersion("${version}")
    }
  }
}
// /${TAG}
`;
    const existing = new RegExp(`\\n// ${TAG}[\\s\\S]*// /${TAG}\\n`);
    gradle.modResults.contents = existing.test(gradle.modResults.contents)
      ? gradle.modResults.contents.replace(existing, block)
      : gradle.modResults.contents + block;
    return gradle;
  });
