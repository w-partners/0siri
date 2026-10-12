// 대화 안 브라우저 카드의 화면 — 서버 콘솔(서명 주소)을 그대로 끼운다 (앱: WebView · 웹: browser-frame.web.tsx 의 iframe).
// 콘솔은 스크린샷만 그린다(원격 페이지 코드는 여기서 돌지 않는다). 콘솔 밖으로 나가는 이동은 막는다.
import { WebView } from "react-native-webview";

export function BrowserFrame({ url }: { url: string }) {
  return (
    <WebView
      source={{ uri: url }}
      style={{ flex: 1, backgroundColor: "transparent" }}
      onShouldStartLoadWithRequest={(req) => req.url.split("?")[0] === url.split("?")[0]}
    />
  );
}
