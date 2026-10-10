// onnxruntime-react-native 는 옛 unimodule.json 을 싣고 있어 Expo 자동 연결이 «Expo 모듈과 충돌»로 보고 건너뛴다(연결 안 됨 → NativeModules.Onnxruntime 없음).
// 빈 설정이라도 명시하면 React Native 모듈로 연결된다. 확인: pnpm exec expo-modules-autolinking react-native-config --json --platform android
module.exports = {
  dependencies: {
    "onnxruntime-react-native": { platforms: { android: {} } },
  },
};
