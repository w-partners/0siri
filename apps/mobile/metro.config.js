const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
const path = require("node:path");
config.watchFolders = [path.resolve(__dirname, "../..")];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // 0Siri: transformers.js 는 웹 빌드(dist/transformers.web.js)만 쓴다 — node 진입점은 sharp·fs 를 끌어온다
  if (moduleName === "@huggingface/transformers") {
    if (platform !== "web") return { type: "empty" };
    return {
      type: "sourceFile",
      filePath: require.resolve("@huggingface/transformers/dist/transformers.web.js"),
    };
  }
  if (moduleName === "jose" || moduleName.startsWith("jose/")) {
    return context.resolveRequest(
      { ...context, unstable_conditionNames: ["browser", "require", "import"] },
      moduleName,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
