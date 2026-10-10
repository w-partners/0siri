// 영시리가 만든 HTML 아티팩트를 앱 안에서 보여 준다 (앱: WebView · 웹: html-frame.web.tsx 의 iframe).
// 내용은 모델이 만든 것이라 믿지 않는다 — 페이지 안 링크는 앱 밖 브라우저로 열고, 앱과 주고받는 통로(onMessage)는 두지 않는다.
import { Linking } from "react-native";
import { WebView } from "react-native-webview";

export function HtmlFrame({ html }: { html: string }) {
  return (
    <WebView
      originWhitelist={["about:*"]}
      source={{ html }}
      style={{ flex: 1, backgroundColor: "transparent" }}
      onShouldStartLoadWithRequest={(req) => {
        if (req.url.startsWith("about:")) return true;
        void Linking.openURL(req.url);
        return false;
      }}
    />
  );
}
